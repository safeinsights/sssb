import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { E2E_BUILD } from './budgets'

/**
 * A WORLD PER PLAYWRIGHT WORKER (safeinsights/sssb#99): its own server, its own `.data`, so specs in different workers
 * cannot touch each other's state, and `workers` can be raised past 1 without trading a loud failure for a silent one.
 *
 * How, in one place that playwright.config.ts and the specs both read:
 *
 * - **Worker 0 is the suite as it always was**: the config's first web server (on the app's port, `originFor`) and the
 *   app's own `.data`. With one worker, nothing here changes anything.
 * - **Worker `k` (1 and up) gets a server of its own**, another `sssb serve-standalone` of the SAME production build
 *   (`start:e2e`, so the build is paid once), on a port of its own and with `APP_DATA_DIR` pointed at a world of its
 *   own, emptied when its server starts. The config lists those servers after the first, and Playwright starts them
 *   in order, each once the one before it answers: so every server has copied its static assets before any test runs.
 * - **A worker finds its own** by `TEST_PARALLEL_INDEX`, which Playwright sets in each worker process (0 up to
 *   `workers - 1`, kept by a worker that replaces one that failed) before that process loads this config: `baseURL`
 *   in the config, and `worldPath(...)` for a spec that reads or writes its world on disk.
 *
 * Only on a production build (`E2E_BUILD=1`): `next dev` refuses a second server for the same app directory whatever
 * the port ("Another next dev server is already running", safeinsights/sssb#113), so under it there is one worker.
 */

/** The app's directory, whatever the working directory: this file is `<app>/tests/e2e/support/worlds.ts`. */
const APP_DIR = path.resolve(__dirname, '../../..')

/** At most this many workers: each checkout's band of worker ports is this wide. */
const MAX_WORKERS = 8

/**
 * How many workers, and so how many worlds: `E2E_WORKERS` (1 when unset) on a production build, and always 1 on
 * `next dev`, where asking for more is an error rather than a silent one.
 */
export const E2E_WORKERS = workerCount(process.env['E2E_WORKERS'])

function workerCount(raw: string | undefined): number {
    if (raw === undefined || raw === '') return 1
    const n = Number(raw)
    if (!Number.isInteger(n) || n < 1 || n > MAX_WORKERS) {
        throw new Error(`E2E_WORKERS must be a whole number from 1 to ${MAX_WORKERS}, not "${raw}"`)
    }
    if (n > 1 && !E2E_BUILD) {
        throw new Error(
            `E2E_WORKERS=${n} needs E2E_BUILD=1: each worker gets a server of its own, and next dev allows one per app ` +
                'directory (tests/e2e/support/worlds.ts)',
        )
    }
    return n
}

/** This process's world: Playwright's parallel index in a worker, 0 in the runner itself. */
export function worldIndex(): number {
    return Number(process.env['TEST_PARALLEL_INDEX'] ?? 0)
}

/**
 * Where world `index` keeps its state: the app's `.data` for world 0, as every server and every helper has always
 * assumed, and a directory under the system's temp directory for the others, named for this checkout so two checkouts'
 * runs never share one. Outside `.data`, so nothing that clears `.data` (a spec, a person) reaches another world.
 */
export function worldRoot(index = worldIndex()): string {
    if (index === 0) return path.join(APP_DIR, '.data')
    const checkout = createHash('sha256').update(APP_DIR).digest('hex').slice(0, 12)
    return path.join(tmpdir(), `sssb-e2e-${checkout}`, `world-${index}`)
}

/** A path in this worker's world, for a spec or helper that reads or writes it on disk: `worldPath('simulator', 'state.json')`. */
export function worldPath(...segments: string[]): string {
    return path.join(worldRoot(), ...segments)
}

/**
 * The origin of world `index`'s server: `base` itself for world 0, and for the others a port in a band of
 * MAX_WORKERS ports derived from `base`'s port, so each checkout (whose app port `@sssb/tools/ports` already derives)
 * has a band of its own: 30000 to 48406, clear of the app ports (3000-3599), the custom slots (20000-29999), contract
 * Postgres (5439 and up), Ladle (61000 and up) and the ports the OS hands out on its own (49152 and up).
 */
export function worldOrigin(base: string, index = worldIndex()): string {
    if (index === 0) return base
    const url = new URL(base)
    url.port = String(30_000 + (Number(url.port) % 2300) * MAX_WORKERS + index)
    return url.origin
}

/**
 * The web servers of worlds 1 and up, for the config to list after its first: each serves the build the first one
 * made, from an emptied world. None is reused: a server left on the port by an earlier run would serve an older build.
 */
export function workerServers(base: string, count = E2E_WORKERS) {
    return Array.from({ length: count - 1 }, (_, i) => {
        const index = i + 1
        const origin = worldOrigin(base, index)
        return {
            command: `rm -rf '${worldRoot(index)}' && pnpm run start:e2e`,
            url: origin,
            reuseExistingServer: false,
            env: { DEV_TICK_SECONDS: '', PORT: new URL(origin).port, APP_DATA_DIR: worldRoot(index) },
            // A start, not a build: the first server's command built it.
            timeout: 60_000,
        }
    })
}
