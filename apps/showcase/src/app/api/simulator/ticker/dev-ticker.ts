// The dev ticker, owned by the dev server: what the Simulator's ticker control starts, stops and reads.
//
// `scripts/ticker.mjs` is the ticker (start, stop, status, the interval bounds and the marker); this is the policy for
// starting it from the UI, as `scripts/dev-tick.mjs` is the policy for starting it from `DEV_TICK_SECONDS`
// (.claude/future-tasks/resolved/simulator-ticker-control.md has the design, docs/decision-log.md the decisions):
//
//   * one ticker per server process, kept on `globalThis` so a hot reload of this module does not orphan a running
//     loop and start a second beside it;
//   * it ticks this server's own `/api/webhooks/cron` over HTTP with the per-checkout dev secret, exactly as
//     `pnpm tick` does, so `withWebhookSecret` stays the only way into `runScheduledTick`;
//   * it leaves the same marker the wrapper does, with this server's pid, so `pnpm test:e2e` refuses to adopt a server
//     whose ticker was started from the UI;
//   * a live marker that is not this process's (the `DEV_TICK_SECONDS` wrapper, or another server on the same data
//     directory) means a ticker is already running against this world: start is refused, never a second ticker.
//
// Nothing here decides WHETHER the control exists: the route answers 404 unless `isSimulatedDevServer`, and imports
// this module only after that, so a production build (deployed, demo, e2e) never evaluates it.
import { portFor } from '../../../../../../../scripts/ports.mjs'
import {
    createTicker,
    intervalProblem,
    MAX_INTERVAL_SECONDS,
    MIN_INTERVAL_SECONDS,
} from '../../../../../../../scripts/ticker.mjs'
import { liveTickerMarker, tickerMarkerPath } from '../../../../../../../scripts/ticker-marker.mjs'

/** What the Start field offers first: often enough to see a digest fire in a demo, rare enough to stay quiet. */
export const DEFAULT_INTERVAL_SECONDS = 30

type Ticker = ReturnType<typeof createTicker>

export interface DevTickerStatus {
    running: boolean
    seconds: number | null
    ticks: number
    lastTickAt: string | null
    lastError: string | null
    /** A ticker this server does not own is live on this world (pid and interval from its marker), or null. */
    elsewhere: { pid: number; seconds: number } | null
    minSeconds: number
    maxSeconds: number
    defaultSeconds: number
}

export type StartResult =
    | { ok: true; status: DevTickerStatus }
    | { ok: false; error: 'invalid-interval' | 'running-elsewhere'; status: DevTickerStatus }

export interface DevTickerControl {
    status(): DevTickerStatus
    start(seconds: unknown): StartResult
    stop(): Promise<DevTickerStatus>
}

/**
 * @param ticker the server's one ticker
 * @param markerFile where tickers record themselves (scripts/ticker-marker.mjs)
 * @param pid this process; a live marker with any other pid is someone else's ticker
 * @param readMarker the marker reader, injectable for tests (it probes the pid with `process.kill(pid, 0)`)
 */
export function createDevTickerControl({
    ticker,
    markerFile,
    pid,
    readMarker = liveTickerMarker,
}: {
    ticker: Ticker
    markerFile: string
    pid: number
    readMarker?: (file: string) => { pid: number; seconds: number } | null
}): DevTickerControl {
    function elsewhere(): DevTickerStatus['elsewhere'] {
        const marker = readMarker(markerFile)
        return marker && marker.pid !== pid ? { pid: marker.pid, seconds: marker.seconds } : null
    }

    function status(): DevTickerStatus {
        return {
            ...ticker.status(),
            elsewhere: elsewhere(),
            minSeconds: MIN_INTERVAL_SECONDS,
            maxSeconds: MAX_INTERVAL_SECONDS,
            defaultSeconds: DEFAULT_INTERVAL_SECONDS,
        }
    }

    return {
        status,
        start(seconds) {
            if (intervalProblem(seconds) !== null) {
                return { ok: false, error: 'invalid-interval', status: status() }
            }
            // Ours already running: start() is a no-op that returns its status, interval unchanged.
            if (!ticker.status().running && elsewhere()) {
                return { ok: false, error: 'running-elsewhere', status: status() }
            }
            // intervalProblem accepted it, so it is a whole number in range.
            ticker.start(seconds as number)
            return { ok: true, status: status() }
        },
        async stop() {
            await ticker.stop()
            return status()
        },
    }
}

const GLOBAL_KEY = Symbol.for('sssb.showcase.devTickerControl')

/** The dev server's one control, made on first use. */
export function devTickerControl(): DevTickerControl {
    const holder = globalThis as typeof globalThis & { [GLOBAL_KEY]?: DevTickerControl }
    if (!holder[GLOBAL_KEY]) {
        const markerFile = tickerMarkerPath()
        // The port the dev server was started on (`pnpm dev` passes `--port` from the same function), never one taken
        // from the request: the dev secret goes to this origin as a bearer.
        const origin = `http://localhost:${portFor('showcase')}`
        holder[GLOBAL_KEY] = createDevTickerControl({
            ticker: createTicker({ origin, markerFile }),
            markerFile,
            pid: process.pid,
        })
    }
    return holder[GLOBAL_KEY]
}
