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
import { execFileSync } from 'node:child_process'
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
 * When the process at `pid` started, in ms since the epoch, or null when that cannot be told (no `ps`, as on Windows, a
 * pid that is gone, an output that is not a date). `ps -o lstart=` answers on macOS and Linux alike, to the second.
 *
 * @param {number} pid
 * @returns {number | null}
 */
export function processStartedAt(pid) {
    try {
        const out = execFileSync('ps', ['-o', 'lstart=', '-p', String(pid)], {
            encoding: 'utf8',
            env: { ...process.env, LC_ALL: 'C' },
            stdio: ['ignore', 'pipe', 'ignore'],
            timeout: 2000,
        })
        const started = Date.parse(out.trim())
        return Number.isFinite(started) ? started : null
    } catch {
        return null
    }
}

// `ps` answers to the second and a process's start time is reckoned from the boot time, which drifts by up to a second
// on Linux, so a process counts as started AFTER the marker only when it is more than this later.
const REUSED_PID_TOLERANCE_MS = 2000

/**
 * The live ticker's marker, or null. A marker is stale, ignored and cleared, when its process is gone (a wrapper that was
 * SIGKILLed cannot clean up) or when the process now at its pid started after the marker was written: the pid was reused
 * by an unrelated process, which the marker's `startedAt` (written by its own process, after that process began) shows,
 * since a process that started later than the marker cannot be the one that wrote it. When the start time cannot be told
 * (`startedAt` is not a date, `ps` is missing), the marker is live, as before.
 *
 * @param {string} file
 * @param {(pid: number) => number | null} [startOf] when the process at a pid started; `processStartedAt` unless a test says
 * @returns {{ pid: number, seconds: number, startedAt: string } | null}
 */
export function liveTickerMarker(file, startOf = processStartedAt) {
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
        if (!(error && typeof error === 'object' && 'code' in error && error.code === 'EPERM')) {
            clearStaleMarker(file, marker)
            return null
        }
    }
    const wrote = Date.parse(marker.startedAt)
    const started = Number.isFinite(wrote) ? startOf(marker.pid) : null
    if (started !== null && started > wrote + REUSED_PID_TOLERANCE_MS) {
        clearStaleMarker(file, marker)
        return null
    }
    return marker
}

/**
 * Removes a marker found stale, unless the file has changed since it was read: another wrapper may have written its own
 * in the meantime, and that one is not stale.
 *
 * @param {string} file
 * @param {{ pid: number, startedAt: string }} stale
 */
function clearStaleMarker(file, stale) {
    try {
        const current = JSON.parse(readFileSync(file, 'utf8'))
        if (current && current.pid === stale.pid && current.startedAt === stale.startedAt) rmSync(file, { force: true })
    } catch {
        // already gone, or not ours to judge
    }
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
