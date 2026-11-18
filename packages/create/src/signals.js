// @ts-check
// SIGNALS while the generator writes. Its work is synchronous (a template built into a temporary directory, a workspace
// written), so a signal's default action would end the process part-way and leave that work behind. While work is under
// way a listener defers the signal instead: Node runs it on a later turn of the event loop, where it undoes everything
// still under way and raises the signal again, for the process to end as it was asked.
import { setImmediate } from 'node:timers'

/** What ends the process part-way: Ctrl-C, a kill, the terminal closing. */
const SIGNALS = /** @type {const} */ (['SIGINT', 'SIGTERM', 'SIGHUP'])

/** How to undo each piece of work under way. @type {Set<() => void>} */
const underWay = new Set()

/** @param {boolean} on */
function listen(on) {
    for (const signal of SIGNALS) {
        if (on) process.on(signal, onSignal)
        else process.off(signal, onSignal)
    }
}

/** @param {NodeJS.Signals} signal */
function onSignal(signal) {
    // Every undo runs, one failing or not (what it could not remove stays), and the signal is raised again regardless.
    for (const undo of underWay) {
        try {
            undo()
        } catch {
            // nothing more to do for it
        }
    }
    underWay.clear()
    listen(false)
    process.kill(process.pid, signal)
}

/**
 * Defers SIGINT, SIGTERM and SIGHUP until `undo`'s work is released; a signal that comes meanwhile runs `undo` (and
 * every other undo still held). Call it before the work makes anything.
 * @param {() => void} undo
 */
export function holdSignals(undo) {
    if (underWay.size === 0) listen(true)
    underWay.add(undo)
}

/**
 * Resolves two turns of the event loop from now. A signal that arrived before the call is dispatched by then: libuv
 * reads a pending signal only in the event loop's poll phase, and the first turn's check phase can come straight after
 * the poll phase the caller is running in (`main()` resumes from the confirmation prompt's stdin callback, a poll
 * callback), so only the second turn is sure to pass through a poll phase first.
 * @returns {Promise<void>}
 */
export function signalsSettled() {
    return new Promise((resolve) => setImmediate(() => setImmediate(resolve)))
}

/**
 * Lets the signals go again for `undo`'s work, two turns from now (signalsSettled): a signal that arrived while the
 * work ran is dispatched before then and still finds `undo` to run, even when the work finished. One that arrives
 * after the work returned is not promised either way: it may undo the work, or (in the last turn, as the listener
 * goes) be dropped, or end the process by its default action; the work it finds then is finished.
 * @param {() => void} undo
 */
export function releaseSignals(undo) {
    setImmediate(() =>
        setImmediate(() => {
            underWay.delete(undo)
            if (underWay.size === 0) listen(false)
        }),
    )
}
