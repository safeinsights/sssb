/** Where a running dev ticker records itself: `<APP_DATA_DIR or ./.data>/dev-ticker.json`. */
export declare function tickerMarkerPath(env?: Record<string, string | undefined>, cwd?: string): string

/** Records a live ticker (this process's pid and its interval). */
export declare function writeTickerMarker(file: string, seconds: number): void

/** Removes the record, if this process wrote it: another ticker's marker is not ours to delete. */
export declare function removeTickerMarker(file: string): void

/** The live ticker a marker records, or null when there is none or its process is gone. */
export declare function liveTickerMarker(file: string): { pid: number; seconds: number; startedAt: string } | null

/**
 * Throws while a dev ticker is live in this app's data directory: a Playwright config calls it so a ticking dev
 * server is never adopted by an e2e run, whose scheduler must do nothing until a test asks.
 */
export declare function assertNoLiveDevTicker(env?: Record<string, string | undefined>, cwd?: string): void
