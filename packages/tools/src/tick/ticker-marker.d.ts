/** Where a running dev ticker records itself: `<APP_DATA_DIR or ./.data>/dev-ticker.json`. */
export declare function tickerMarkerPath(env?: Record<string, string | undefined>, cwd?: string): string

/** Records a live ticker (this process's pid and its interval). */
export declare function writeTickerMarker(file: string, seconds: number): void

/** Removes the record, if this process wrote it: another ticker's marker is not ours to delete. */
export declare function removeTickerMarker(file: string): void

/**
 * The live ticker a marker records, or null when there is none, its process is gone, or the process now at its pid is not
 * the one that wrote the marker (the OS reused the pid): a marker found so is cleared. A marker whose process cannot be
 * told apart from the one at its pid is live. `tokenOf` gives the start token of the process at a pid
 * (default `processStartToken`).
 */
export declare function liveTickerMarker(
    file: string,
    tokenOf?: (pid: number) => string | null,
): { pid: number; seconds: number; startedAt: string; startToken?: string | null } | null

/**
 * A token for when the process at `pid` began, to compare for equality: the same for one process, another for a process
 * that took the pid later, and not moved by a wall clock that is stepped. null when it cannot be told.
 */
export declare function processStartToken(pid: number): string | null

/**
 * Throws while a dev ticker is live in this app's data directory: a Playwright config calls it so a ticking dev
 * server is never adopted by an e2e run, whose scheduler must do nothing until a test asks.
 */
export declare function assertNoLiveDevTicker(env?: Record<string, string | undefined>, cwd?: string): void
