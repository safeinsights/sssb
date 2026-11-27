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
    writeFileSync(
        file,
        JSON.stringify({
            pid: process.pid,
            seconds,
            startedAt: new Date().toISOString(),
            startToken: processStartToken(process.pid),
        }),
    )
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
 * A token for WHEN the process at `pid` began, to compare for equality, never to read as a date: two reads of one process
 * give the same token, and a process that took the pid later gives another. Taken from the kernel's own record, which
 * the wall clock cannot move: on Linux the boot id and the process's start in ticks since boot (`/proc/<pid>/stat`,
 * field 22), elsewhere `ps -o lstart=` (macOS keeps it fixed per process), printed in UTC so that two processes with
 * different `TZ`s read one string. A date computed from either would move with a clock stepped after the process began (a
 * paused guest resuming), and judge a live marker's process newer than its marker. null when it cannot be told: no
 * `/proc` and no `ps` (Windows), a pid that is gone.
 *
 * @param {number} pid
 * @returns {string | null}
 */
export function processStartToken(pid) {
    try {
        const stat = readFileSync(`/proc/${pid}/stat`, 'utf8')
        // After the command's `)`: state (field 3), then 19 more to the start time (field 22).
        const ticks = stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19]
        const boot = readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim()
        if (ticks && /^\d+$/.test(ticks) && boot) return `linux:${boot}:${ticks}`
    } catch {
        // not Linux, or the process is gone
    }
    try {
        const out = execFileSync('ps', ['-o', 'lstart=', '-p', String(pid)], {
            encoding: 'utf8',
            env: { ...process.env, LC_ALL: 'C', TZ: 'UTC0' },
            stdio: ['ignore', 'pipe', 'ignore'],
            timeout: 2000,
        }).trim()
        return out ? `ps:${out}` : null
    } catch {
        return null
    }
}

/**
 * The live ticker's marker, or null. A marker whose process is gone (a wrapper that was SIGKILLed cannot clean up) is
 * stale and ignored. So is one whose pid the OS has since given to another process (`safeinsights/sssb#146`): the marker
 * carries the start token of the process that wrote it (`startToken`), and a process now at that pid with another token
 * is not it, so the marker is cleared as well. A marker with no token, a token that cannot be read now, or tokens of
 * different kinds (another machine's, through a shared directory), cannot be judged, and is live, as before. A process
 * never judges its own marker.
 *
 * @param {string} file
 * @param {(pid: number) => string | null} [tokenOf] the start token of the process at a pid; `processStartToken` unless a test says
 * @returns {{ pid: number, seconds: number, startedAt: string, startToken?: string | null } | null}
 */
export function liveTickerMarker(file, tokenOf = processStartToken) {
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
    if (marker.pid === process.pid || typeof marker.startToken !== 'string') return marker
    const now = tokenOf(marker.pid)
    // `linux:` or `ps:`: tokens of one kind are comparable, and only they.
    if (now !== null && now.split(':', 1)[0] === marker.startToken.split(':', 1)[0] && now !== marker.startToken) {
        clearStaleMarker(file, marker)
        return null
    }
    return marker
}

/**
 * Removes a marker found stale, unless the file has changed since it was read: another wrapper may have written its own
 * in the meantime, and that one is not stale. (A wrapper that writes between the re-read and the removal still loses its
 * marker: microseconds wide, and a ticker that finds it gone writes it again on its next start.)
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
