import { describe, expect, test, vi } from 'vitest'

// Simulated mode, so each handler gets past its opening 404 to the json-only guard. Nothing past the guard runs.
vi.mock('@sssb/kit/adapters/index', () => ({ isSimulated: true, isSimulatedDevServer: true }))

/**
 * Every simulated-mode-only POST that takes a body refuses a request that is not `application/json` with 415, before
 * it reads the body or touches the world: a page on another origin can send a simple POST (text/plain or a form) with
 * no preflight. The body-less ones (reset, mail/clear, jobs/run-pending, schedules/run-due, webhooks/run-due) are
 * called without a content-type by the Simulator panel and the e2e specs, and are not in this list yet.
 */
const ROUTES = {
    'auth/accept-invite': () => import('./auth/accept-invite/route'),
    'auth/dev-signin': () => import('./auth/dev-signin/route'),
    'simulator/actors/artifact': () => import('./simulator/actors/artifact/route'),
    'simulator/agreements/bump': () => import('./simulator/agreements/bump/route'),
    'simulator/clock': () => import('./simulator/clock/route'),
    'simulator/flags': () => import('./simulator/flags/route'),
    'simulator/inbound/compose': () => import('./simulator/inbound/compose/route'),
    'simulator/mail/seen': () => import('./simulator/mail/seen/route'),
    'simulator/presets': () => import('./simulator/presets/route'),
    'simulator/service-token': () => import('./simulator/service-token/route'),
    'simulator/snapshots': () => import('./simulator/snapshots/route'),
    'simulator/snapshots/delete': () => import('./simulator/snapshots/delete/route'),
    'simulator/snapshots/restore': () => import('./simulator/snapshots/restore/route'),
    'simulator/ticker': () => import('./simulator/ticker/route'),
    'simulator/viewpoint': () => import('./simulator/viewpoint/route'),
    'simulator/webhooks/fail': () => import('./simulator/webhooks/fail/route'),
}

describe('simulated-mode-only POSTs answer 415 to a cross-origin simple request', () => {
    test.each(Object.entries(ROUTES))('%s', async (rel, load) => {
        const { POST } = await load()
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
