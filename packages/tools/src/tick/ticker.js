// @ts-check
// The dev ticker: one object that owns start, stop, the interval and whether it is running.
//
// It has two users, each with its own policy: `sssb dev-tick` (dev-tick.js) (`DEV_TICK_SECONDS=30 pnpm dev`, `resolveDevTick`)
// and the showcase Simulator's control (`apps/showcase/src/app/api/simulator/ticker/dev-ticker.ts`), which runs it inside
// the dev server. It is a module of its own, with no reading of the environment and no process wiring, so that both can;
// each caller owns the policy that keeps the ticker off by default and out of e2e and the static demo.
//
// A tick is `tickOnce` (tick.js): an HTTP client of the route `pnpm tick` calls, with the same dev secret.
import { removeTickerMarker, writeTickerMarker } from './ticker-marker.js'
import { summarizeTick, tickDidWork, tickOnce } from './tick.js'

/** A tick is a few queries; under a second is a typo for a unit. Over a day is a typo for another unit, and far below the ~24.8 days (2^31 ms) where `setTimeout` overflows and the loop would spin. */
export const MIN_INTERVAL_SECONDS = 1
export const MAX_INTERVAL_SECONDS = 86_400

/**
 * @param {unknown} seconds
 * @returns {string | null} what is wrong with it, or null
 */
export function intervalProblem(seconds) {
    if (
        typeof seconds !== 'number' ||
        !Number.isInteger(seconds) ||
        seconds < MIN_INTERVAL_SECONDS ||
        seconds > MAX_INTERVAL_SECONDS
    ) {
        return `a whole number of seconds from ${MIN_INTERVAL_SECONDS} to ${MAX_INTERVAL_SECONDS}`
    }
    return null
}

/**
 * @param {number} ms
 * @param {AbortSignal} signal
 */
export function abortableSleep(ms, signal) {
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
 * @typedef {{ running: boolean, seconds: number | null, ticks: number, lastTickAt: string | null, lastError: string | null }} TickerStatus
 */

/**
 * @param {{
 *   origin: string,
 *   markerFile?: string,
 *   tick?: typeof tickOnce,
 *   log?: (line: string) => void,
 *   sleep?: (ms: number, signal: AbortSignal) => Promise<void>,
 *   now?: () => Date,
 * }} options `markerFile`: where a live ticker is recorded (ticker-marker.js); none, none written.
 */
export function createTicker({
    origin,
    markerFile,
    tick = tickOnce,
    log = console.log,
    sleep = abortableSleep,
    now = () => new Date(),
}) {
    /** @type {AbortController | null} */
    let controller = null
    /** @type {Promise<void>} */
    let loop = Promise.resolve()
    /** @type {TickerStatus} */
    let state = { running: false, seconds: null, ticks: 0, lastTickAt: null, lastError: null }

    /**
     * Ticks every `seconds` until `signal` aborts. One tick at a time (the next is timed from the end of the last, so a
     * slow tick never overlaps itself), speaking only when something ran or when the state changed: a dev server that is
     * still compiling is "not up yet", said once, not an error every interval.
     *
     * @param {number} seconds
     * @param {AbortSignal} signal
     */
    async function run(seconds, signal) {
        /** @type {string | null} */
        let previousError = null
        while (!signal.aborted) {
            await sleep(seconds * 1000, signal)
            if (signal.aborted) return
            try {
                const body = await tick({ origin, timeoutMs: Math.max(seconds * 1000, 30_000), signal })
                state = { ...state, ticks: state.ticks + 1, lastTickAt: now().toISOString(), lastError: null }
                if (previousError !== null) log('[tick] ok again')
                previousError = null
                if (tickDidWork(body)) log(`[tick] ${summarizeTick(body)}`)
            } catch (error) {
                if (signal.aborted) return
                const message = error instanceof Error ? error.message : String(error)
                state = { ...state, lastError: message }
                if (message !== previousError) log(`[tick] ${message} (will keep trying every ${seconds}s)`)
                previousError = message
            }
        }
    }

    return {
        /**
         * Starts ticking, or does nothing if it already is (an interval change is a `stop()` then a `start()`).
         *
         * @param {number} seconds
         * @returns {TickerStatus}
         */
        start(seconds) {
            const problem = intervalProblem(seconds)
            if (problem) throw new RangeError(`the ticker interval must be ${problem}, got ${String(seconds)}`)
            if (controller) return { ...state }
            controller = new AbortController()
            state = { running: true, seconds, ticks: 0, lastTickAt: null, lastError: null }
            if (markerFile) writeTickerMarker(markerFile, seconds)
            loop = run(seconds, controller.signal)
            return { ...state }
        },

        /**
         * Stops it, cancels a tick in flight, and resolves to the status once the loop has ended. Safe to call when not
         * running.
         *
         * @returns {Promise<TickerStatus>}
         */
        async stop() {
            const stopping = controller
            controller = null
            if (!stopping) return { ...state }
            stopping.abort()
            if (markerFile) removeTickerMarker(markerFile)
            state = { ...state, running: false }
            await loop
            return { ...state }
        },

        /** @returns {TickerStatus} */
        status() {
            return { ...state }
        },
    }
}
