/** The dev ticker's bounds: a tick is a few queries, so under a second or over a day is a typo for another unit. */
export declare const MIN_INTERVAL_SECONDS: number
export declare const MAX_INTERVAL_SECONDS: number

/** What is wrong with an interval, or null: it must be a whole number of seconds within the bounds. */
export declare function intervalProblem(seconds: unknown): string | null

export interface TickerStatus {
    running: boolean
    seconds: number | null
    ticks: number
    lastTickAt: string | null
    lastError: string | null
}

export interface Ticker {
    /** Starts ticking every `seconds`, or does nothing if it already is (an interval change is a stop then a start). */
    start(seconds: number): TickerStatus
    /** Stops ticking and waits for a tick in flight to end. */
    stop(): Promise<TickerStatus>
    status(): TickerStatus
}

export interface TickerOptions {
    /** The dev server's origin, loopback only. */
    origin: string
    /** Where a live ticker is recorded (see `@sssb/tools/ticker-marker`); none, none written. */
    markerFile?: string
    tick?: (options: { origin: string; timeoutMs: number; signal?: AbortSignal }) => Promise<Record<string, unknown>>
    log?: (line: string) => void
    sleep?: (ms: number, signal: AbortSignal) => Promise<void>
    now?: () => Date
}

/** The dev ticker: one object that owns start, stop, the interval and whether it is running. */
export declare function createTicker(options: TickerOptions): Ticker
