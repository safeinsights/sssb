import { beforeEach, describe, expect, test, vi } from 'vitest'

const h = vi.hoisted(() => ({ lastPath: undefined as unknown }))
vi.mock('@sssb/kit/adapters/index', () => ({ isSimulated: true, auth: {} }))
vi.mock('@sssb/kit/adapters/fake/auth', () => ({ devSignIn: vi.fn(), findInvite: vi.fn() }))
vi.mock('@sssb/kit/adapters/fake/simulator', () => ({
    readSimulatorState: () => ({ people: { 'person:person-admin': { lastPath: h.lastPath } } }),
    writeViewpointCookie: vi.fn(),
}))

async function redirectTo(): Promise<unknown> {
    const { POST } = await import('./route')
    const response = await POST(
        new Request('http://localhost/api/simulator/viewpoint', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ person: 'person:person-admin', locale: 'en' }),
        }),
    )
    return ((await response.json()) as { redirectTo?: unknown }).redirectTo
}

beforeEach(() => {
    h.lastPath = undefined
})

describe("POST /api/simulator/viewpoint hands back the person's last page only when it is a same-origin path", () => {
    test('a same-origin path is kept', async () => {
        h.lastPath = '/en/tickets?page=2'
        expect(await redirectTo()).toBe('/en/tickets?page=2')
    })

    test.each(['https://evil.example/x', '//evil.example/x', 'javascript:alert(1)', '/\\evil.example'])(
        'a recorded %j falls back to the dashboard',
        async (lastPath) => {
            h.lastPath = lastPath
            expect(await redirectTo()).toBe('/en/dashboard')
        },
    )

    test('no recorded page is the dashboard', async () => {
        expect(await redirectTo()).toBe('/en/dashboard')
    })
})
