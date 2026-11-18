// @ts-check
// A marker file that says "a dev ticker is running against this app's data directory".
//
// Why it exists: Playwright's `reuseExistingServer` (everywhere but CI) ADOPTS a dev server already listening on the
// app's port. A developer who ran `DEV_TICK_SECONDS=30 pnpm dev` and then `pnpm test:e2e` in the same checkout would
// therefore run the suite against a server that spawns jobs and drains deliveries every 30 seconds, which is exactly
// what the suite expects not to happen. Blanking the variable for the server Playwright starts cannot reach a server it
// did not start, so the ticker leaves this marker, and both playwright configs refuse to run while one is live.
//
// Imported by playwright.config.ts, which Playwright compiles to CommonJS: no `import.meta`, no top-level await, nothing
// but `node:` imports here (the constraint @sssb/tools' ports module documents).
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'

/**
 * @param {Record<string, string | undefined>} [env]
 * @param {string} [cwd]
 */
export function tickerMarkerPath(env = process.env, cwd = process.cwd()) {
    return path.join(env.APP_DATA_DIR ?? path.join(cwd, '.data'), 'dev-ticker.json')
}

/**
 * @param {string} file
 * @param {number} seconds
 */
export function writeTickerMarker(file, seconds) {
    mkdirSync(path.dirname(file), { recursive: true })
    writeFileSync(file, JSON.stringify({ pid: process.pid, seconds, startedAt: new Date().toISOString() }))
}

/** @param {string} file */
export function removeTickerMarker(file) {
    try {
        const current = JSON.parse(readFileSync(file, 'utf8'))
        // Only our own: a second wrapper's marker is not ours to delete.
        if (current && current.pid === process.pid) rmSync(file, { force: true })
    } catch {
        // already gone, or never written
    }
}

/**
 * The live ticker's marker, or null. A marker whose process is gone (a wrapper that was SIGKILLed cannot clean up) is
 * stale and ignored.
 *
 * @param {string} file
 * @returns {{ pid: number, seconds: number, startedAt: string } | null}
 */
export function liveTickerMarker(file) {
    let marker
    try {
        marker = JSON.parse(readFileSync(file, 'utf8'))
    } catch {
        return null
    }
    if (!marker || !Number.isInteger(marker.pid)) return null
    try {
        process.kill(marker.pid, 0)
    } catch (error) {
        // ESRCH: no such process. EPERM means it exists and is someone else's: live.
        if (!(error && typeof error === 'object' && 'code' in error && error.code === 'EPERM')) return null
    }
    return marker
}

/**
 * For a playwright config: throw, at config load, while a dev ticker is running against this app's data directory.
 *
 * @param {Record<string, string | undefined>} [env]
 * @param {string} [cwd]
 */
export function assertNoLiveDevTicker(env = process.env, cwd = process.cwd()) {
    const file = tickerMarkerPath(env, cwd)
    const marker = liveTickerMarker(file)
    if (marker) {
        throw new Error(
            `a dev ticker is running (pid ${marker.pid}, every ${marker.seconds}s; ${file}). The e2e suite expects a ` +
                `scheduler that does nothing until a test asks, and Playwright would adopt that dev server. Stop it ` +
                `(the \`DEV_TICK_SECONDS=… pnpm dev\` you left running) and run the suite again.`,
        )
    }
}
