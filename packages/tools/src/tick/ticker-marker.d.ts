/** Where a running dev ticker records itself: `<APP_DATA_DIR or ./.data>/dev-ticker.json`. */
export declare function tickerMarkerPath(env?: Record<string, string | undefined>, cwd?: string): string

/** Records a live ticker (this process's pid and its interval). */
export declare function writeTickerMarker(file: string, seconds: number): void

/** Removes the record, if this process wrote it: another ticker's marker is not ours to delete. */
export declare function removeTickerMarker(file: string): void

/**
 * The live ticker a marker records, or null when there is none, its process is gone, or the process now at its pid started
 * after the marker was written (a reused pid): a marker found stale is cleared. `startOf` says when the process at a pid
 * started (default `processStartedAt`).
 */
export declare function liveTickerMarker(
    file: string,
    startOf?: (pid: number) => number | null,
): { pid: number; seconds: number; startedAt: string } | null

/** When the process at `pid` started, in ms since the epoch, or null when that cannot be told (no `ps`, a gone pid). */
export declare function processStartedAt(pid: number): number | null

/**
 * Throws while a dev ticker is live in this app's data directory: a Playwright config calls it so a ticking dev
 * server is never adopted by an e2e run, whose scheduler must do nothing until a test asks.
 */
export declare function assertNoLiveDevTicker(env?: Record<string, string | undefined>, cwd?: string): void
