// What `pnpm dev` runs: the app's `next dev`, plus, only when asked, `pnpm tick` on a timer.
//
//     DEV_TICK_SECONDS=30 pnpm dev        # also tick the scheduler every 30 seconds
//     pnpm dev                            # as before: nothing ticks it
//
// OFF BY DEFAULT, and not by oversight (docs/decision-log.md, "`pnpm tick`, and a dev ticker that is opt-in"). The showcase's
// Simulator controls the world clock in a demo and says when a digest fires; the e2e suites expect a scheduler
// that does nothing until a test asks; and hermetic dev does not do work nobody asked for. So the ticker is a
// variable you set, never a default, and the places that must stay quiet say so themselves:
//
//   * Playwright starts the server with `pnpm dev` and blanks `DEV_TICK_SECONDS` for it (both apps' playwright
//     configs), so a value in your shell never reaches an e2e run;
//   * `E2E_BUILD` and `DEMO_MODE` are the build-time switches of the e2e build and the demo build. Those servers
//     start from `serve-standalone.mjs`, not from here, but a ticker asked for with either set is refused and
//     said so, rather than trusted to be unreachable;
//   * the file:// static demo has no server at all, so there is nothing to tick.
//
// This wraps `next dev`, it does not live inside the app: the app's source stays free of any reading of
// `process.env`, and nothing in the server changes. The ticker is an HTTP client of the same route `pnpm tick`
// calls, with the same dev secret; see scripts/tick.mjs.
import { spawn } from 'node:child_process'
import path from 'node:path'
import { portFor } from './ports.mjs'
import { summarizeTick, TICK_APPS, tickDidWork, tickOnce } from './tick.mjs'

export const DEV_TICK_VARIABLE = 'DEV_TICK_SECONDS'

/** A tick is a few queries; an interval under a second is a typo for a unit, not a wish. */
export const MIN_INTERVAL_SECONDS = 1

/**
 * What the environment asks of the ticker.
 *
 * @param {Record<string, string | undefined>} env
 * @returns {{ mode: 'off' } | { mode: 'refused', reason: string } | { mode: 'on', seconds: number } | { mode: 'invalid', reason: string }}
 */
export function resolveDevTick(env) {
    const raw = env[DEV_TICK_VARIABLE]
    if (raw === undefined || raw.trim() === '') return { mode: 'off' }
    const seconds = Number(raw)
    if (!Number.isInteger(seconds) || seconds < MIN_INTERVAL_SECONDS) {
        return {
            mode: 'invalid',
            reason: `${DEV_TICK_VARIABLE} must be a whole number of seconds, ${MIN_INTERVAL_SECONDS} or more (or unset, for no ticker), got "${raw}"`,
        }
    }
    const blocker = ['E2E_BUILD', 'DEMO_MODE'].find((name) => env[name])
    if (blocker) {
        return {
            mode: 'refused',
            reason: `${DEV_TICK_VARIABLE} is ignored while ${blocker} is set: the ticker never runs under e2e or the demo`,
        }
    }
    return { mode: 'on', seconds }
}

/**
 * Ticks every `seconds` until `signal` aborts. One tick at a time (the next is timed from the end of the last, so a
 * slow tick never overlaps itself), speaking only when something ran or when the state changed: a dev server that is
 * still compiling is "not up yet", said once, not an error every interval.
 *
 * @param {{
 *   origin: string,
 *   seconds: number,
 *   signal: AbortSignal,
 *   tick?: typeof tickOnce,
 *   log?: (line: string) => void,
 *   sleep?: (ms: number, signal: AbortSignal) => Promise<void>,
 * }} options
 */
export async function runTicker({
    origin,
    seconds,
    signal,
    tick = tickOnce,
    log = console.log,
    sleep = abortableSleep,
}) {
    /** @type {string | null} */
    let lastError = null
    while (!signal.aborted) {
        await sleep(seconds * 1000, signal)
        if (signal.aborted) return
        try {
            const body = await tick({ origin, timeoutMs: Math.max(seconds * 1000, 30_000) })
            if (lastError !== null) log(`[tick] ok again`)
            lastError = null
            if (tickDidWork(body)) log(`[tick] ${summarizeTick(body)}`)
        } catch (error) {
            if (signal.aborted) return
            const message = error instanceof Error ? error.message : String(error)
            if (message !== lastError) log(`[tick] ${message} (will keep trying every ${seconds}s)`)
            lastError = message
        }
    }
}

/**
 * @param {number} ms
 * @param {AbortSignal} signal
 */
function abortableSleep(ms, signal) {
    return new Promise((resolve) => {
        const timer = setTimeout(done, ms)
        signal.addEventListener('abort', done, { once: true })
        function done() {
            clearTimeout(timer)
            signal.removeEventListener('abort', done)
            resolve(undefined)
        }
    })
}

/**
 * `dev-tick.mjs <app> -- <command...>`
 *
 * @param {string[]} argv
 * @returns {{ app: string, command: string[] } | { error: string }}
 */
export function parseDevArgs(argv) {
    const dash = argv.indexOf('--')
    const app = argv[0]
    if (dash !== 1 || argv.length < 3 || !TICK_APPS.includes(app)) {
        return { error: `usage: node scripts/dev-tick.mjs <${TICK_APPS.join('|')}> -- <the dev server's command...>` }
    }
    return { app, command: argv.slice(dash + 1) }
}

/** @param {string[]} argv */
async function main(argv) {
    const parsed = parseDevArgs(argv)
    if ('error' in parsed) {
        console.error(parsed.error)
        return 2
    }
    const wanted = resolveDevTick(process.env)
    if (wanted.mode === 'invalid') {
        // Before the server starts: a typo'd variable is a mistake to fix, not a ticker to quietly not have.
        console.error(`dev: ${wanted.reason}`)
        return 2
    }
    if (wanted.mode === 'refused') console.warn(`[tick] ${wanted.reason}`)

    const child = spawn(parsed.command[0], parsed.command.slice(1), {
        stdio: 'inherit',
        shell: process.platform === 'win32',
    })
    const stop = new AbortController()

    // The terminal sends Ctrl-C (SIGINT) to the whole foreground group, the server included, so it is not forwarded
    // a second time. A SIGTERM or SIGHUP (a test runner, a closed terminal) goes to this process alone: pass it on.
    for (const name of /** @type {const} */ (['SIGTERM', 'SIGHUP'])) process.on(name, () => child.kill(name))
    process.on('SIGINT', () => {})

    if (wanted.mode === 'on') {
        const origin = `http://localhost:${portFor(/** @type {'showcase' | 'starter'} */ (parsed.app))}`
        console.log(
            `[tick] ${DEV_TICK_VARIABLE}=${wanted.seconds}: ticking ${origin} every ${wanted.seconds}s (pnpm tick does it once)`,
        )
        void runTicker({ origin, seconds: wanted.seconds, signal: stop.signal })
    }

    return await new Promise((resolve) => {
        child.on('error', (error) => {
            console.error(`dev: could not start ${parsed.command[0]}: ${error.message}`)
            stop.abort()
            resolve(1)
        })
        child.on('exit', (code, signal) => {
            stop.abort()
            resolve(code ?? (signal ? 128 + (signal === 'SIGINT' ? 2 : signal === 'SIGTERM' ? 15 : 1) : 1))
        })
    })
}

if (process.argv[1] && path.resolve(process.argv[1]) === import.meta.filename) {
    process.exitCode = await main(process.argv.slice(2))
}
