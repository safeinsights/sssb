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

it('finds the simulated-only POST routes (a walk that found none would pass vacuously)', () => {
    expect(ROUTES.length).toBeGreaterThanOrEqual(21)
    expect(ROUTES).toContain('simulator/reset/route.ts')
    expect(ROUTES).toContain('auth/dev-signin/route.ts')
})

describe('simulated-mode-only POSTs answer 415 to a cross-origin simple request', () => {
    test.each(ROUTES)('%s', async (rel) => {
        const { POST } = (await import(/* @vite-ignore */ path.join(API, rel))) as { POST: unknown }
        for (const contentType of [
            'text/plain',
            'application/x-www-form-urlencoded',
            'multipart/form-data; boundary=x',
        ]) {
            const request = new Request(`http://localhost/api/${rel}`, {
                method: 'POST',
                headers: { 'content-type': contentType, origin: 'https://evil.example' },
                body: '{"personId":"person-admin"}',
            })
            const response = await (POST as (request: Request) => Promise<Response>)(request)
            expect(response.status, `${rel} with ${contentType}`).toBe(415)
            expect(await response.json()).toEqual({ error: 'json-only' })
        }
    })
})
