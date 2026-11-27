import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it, test, vi } from 'vitest'

// Simulated mode, so each handler gets past its opening 404 to the json-only guard. Nothing past the guard runs.
vi.mock('@sssb/kit/adapters/index', () => ({ isSimulated: true, isSimulatedDevServer: true }))

/**
 * Every simulated-mode-only POST refuses a request that is not `application/json` with 415, before it reads a body or
 * touches the world: a page on another origin can send a simple POST (text/plain, a form, or no body at all) with no
 * preflight. The list is not written by hand: it is every route file under this directory whose POST opens with the
 * simulated-mode 404, so a new one is covered the day it is added. The one exception is named with its reason.
 */
const NOT_JSON: Record<string, string> = {
    'storage-upload/route.ts':
        "the fake storage's presigned upload target: a browser POSTs the file there as multipart, as to S3",
}

const API = path.dirname(fileURLToPath(import.meta.url))
/** How many there are today: a walk that lost some would still find a few. */
const ROUTE_FLOOR = 6
/**
 * The Simulator's catch-all reads its path from Next's context, so it is handed one of SSSB's host's POST paths; the
 * host's own tests hold every one of its POSTs to the same rule (`@sssb/kit/server-lib/simulator-api`). Every other
 * route ignores the argument.
 */
const CONTEXT = { params: Promise.resolve({ path: ['reset'] }) }
function routeFiles(dir: string): string[] {
    return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
        const full = path.join(dir, entry.name)
        if (entry.isDirectory()) return routeFiles(full)
        return entry.name === 'route.ts' ? [full] : []
    })
}
const SIMULATED_POST = /export async function POST\([^)]*\): Promise<Response> \{\s*if \(!isSimulated\) return/
const ROUTES = routeFiles(API)
    .filter((file) => SIMULATED_POST.test(readFileSync(file, 'utf8')))
    .map((file) => path.relative(API, file).split(path.sep).join('/'))
    .filter((rel) => NOT_JSON[rel] === undefined)
    .sort()

it('misses no simulated-only POST: every route file that reads isSimulated and exports POST is listed or named', () => {
    const exportsPost = /export\s+(?:async\s+function\s+POST\b|const\s+POST\b|\{[^}]*\bPOST\b[^}]*\})/
    const candidates = readdirSync(API, { recursive: true, withFileTypes: true })
        .filter((entry) => entry.isFile() && /^route\.(?:mjs|[jt]sx?)$/.test(entry.name))
        .map((entry) => path.join(entry.parentPath, entry.name))
        .filter((file) => {
            const text = readFileSync(file, 'utf8')
            return text.includes('isSimulated') && exportsPost.test(text)
        })
        .map((file) => path.relative(API, file).split(path.sep).join('/'))
    const unlisted = candidates.filter((rel) => !ROUTES.includes(rel) && NOT_JSON[rel] === undefined)
    expect(
        unlisted,
        'a simulated-only POST this test does not reach: open its POST with the simulated-mode 404 as the others do, ' +
            'or name it in NOT_JSON with a reason',
    ).toEqual([])
})

it('finds the simulated-only POST routes (a walk that found none would pass vacuously)', () => {
    expect(ROUTES.length).toBeGreaterThanOrEqual(ROUTE_FLOOR)
    expect(ROUTES).toContain('simulator/[...path]/route.ts')
    expect(ROUTES).toContain('simulator/ticker/route.ts')
    expect(ROUTES).toContain('auth/dev-signin/route.ts')
})

describe('simulated-mode-only POSTs answer 415 to a cross-origin simple request', () => {
    test.each(ROUTES)('%s', async (rel) => {
        const { POST } = (await import(/* @vite-ignore */ path.join(API, rel))) as { POST: unknown }
        const requests = [
            ...['text/plain', 'application/x-www-form-urlencoded', 'multipart/form-data; boundary=x'].map(
                (contentType) =>
                    new Request(`http://localhost/api/${rel}`, {
                        method: 'POST',
                        headers: { 'content-type': contentType, origin: 'https://evil.example' },
                        body: '{"personId":"person-admin"}',
                    }),
            ),
            // No headers and no body at all: what a cross-origin `fetch(url, { method: 'POST', mode: 'no-cors' })` sends.
            new Request(`http://localhost/api/${rel}`, { method: 'POST' }),
        ]
        for (const request of requests) {
            const contentType = request.headers.get('content-type') ?? 'no content-type'
            const response = await (POST as (request: Request, context: typeof CONTEXT) => Promise<Response>)(
                request,
                CONTEXT,
            )
            expect(response.status, `${rel} with ${contentType}`).toBe(415)
            expect(await response.json()).toEqual({ error: 'json-only' })
        }
    })
})
