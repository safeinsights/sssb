import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest'
import { makeTestTmpDir } from '../testing/tmp-dir'
import type { SimulatorMail, SimulatorSchedules, SimulatorSummary } from './simulator-api'

// The Simulator's server host against SSSB's OWN seam (the fixture's seed world). Same throwaway data directory and
// mocked cookie jar as ./demo-presets.test.ts, and the `server-only` registry replaced by the simulated-mode one it
// would build, with a switch for the run mode so the real-mode 404 is tested on the same module.
const tmp = makeTestTmpDir('app-simulator-api-')
beforeAll(() => {
    process.env['APP_DATA_DIR'] = tmp
})
afterAll(() => {
    delete process.env['APP_DATA_DIR']
})

const mode = vi.hoisted(() => ({ simulated: true }))
const cookieStore = new Map<string, { value: string }>()
vi.mock('next/headers', () => ({
    cookies: async () => ({
        get: (name: string) => cookieStore.get(name),
        set: (name: string, value: string) => cookieStore.set(name, { value }),
        delete: (name: string) => cookieStore.delete(name),
    }),
}))
vi.mock('../adapters/index', async () => ({
    get isSimulated() {
        return mode.simulated
    },
    auth: (await import('../adapters/fake/auth')).fakeAuth,
    db: (await import('../adapters/fake/db')).fakeDb,
    jobs: (await import('../adapters/fake/jobs')).fakeJobs,
}))

const ORIGIN = 'http://localhost:3000/api/simulator'

async function call(path: string, init: RequestInit & { json?: unknown } = {}): Promise<Response> {
    const { simulatorApi } = await import('./simulator-api')
    const { json, ...rest } = init
    const request = new Request(`${ORIGIN}/${path}`, {
        ...rest,
        ...(json === undefined
            ? {}
            : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(json) }),
    })
    const segments = path.split('?')[0]!.split('/')
    return simulatorApi(request, { params: Promise.resolve({ path: segments }) })
}

beforeEach(() => {
    mode.simulated = true
    cookieStore.clear()
})

describe('dispatch', () => {
    test('a real build answers 404 on every path, the known ones included', async () => {
        mode.simulated = false
        expect((await call('summary')).status).toBe(404)
        expect((await call('mail/clear', { json: {} })).status).toBe(404)
    })

    test('a path it does not serve is 404, a prototype key included', async () => {
        expect((await call('hooks')).status).toBe(404)
        expect((await call('constructor')).status).toBe(404)
        expect((await call('mail/clear/extra', { json: {} })).status).toBe(404)
    })

    test('a known path with the wrong method is 405 and names the one it takes', async () => {
        const response = await call('summary', { method: 'POST', headers: { 'content-type': 'application/json' } })
        expect(response.status).toBe(405)
        expect(response.headers.get('allow')).toBe('GET')
        expect((await call('mail/clear')).status).toBe(405)
    })

    test('a POST that is not JSON is refused before it runs', async () => {
        const response = await call('viewpoint', {
            method: 'POST',
            headers: { 'content-type': 'text/plain' },
            body: JSON.stringify({ person: 'person:fixture-lead', locale: 'en' }),
        })
        expect(response.status).toBe(415)
        expect(cookieStore.size).toBe(0)
    })
})

describe('people', () => {
    test('the summary lists every seeded person, signed out', async () => {
        const body = (await (await call('summary')).json()) as SimulatorSummary
        expect(body.signedIn).toBe(false)
        expect(body.viewpoint).toBeNull()
        expect(body.people.map((person) => person.key)).toContain('person:fixture-lead')
        // The seeded accounts: an invite another test made is a row too, so it is not counted here.
        const seeded = body.people.filter((person) => person.key.startsWith('person:'))
        expect(seeded.length).toBeGreaterThan(0)
        expect(seeded.every((person) => person.status === 'active' && person.hasAccount)).toBe(true)
    })

    test('becoming a person signs this browser in as them', async () => {
        const response = await call('viewpoint', { json: { person: 'person:fixture-hand', locale: 'es' } })
        expect(response.status).toBe(200)
        expect(await response.json()).toEqual({ redirectTo: '/es/dashboard' })
        const body = (await (await call('summary')).json()) as SimulatorSummary
        expect(body).toMatchObject({ signedIn: true, viewpoint: 'person:fixture-hand' })
    })

    test.each([
        ['/es/dockets?open=1', '/es/dockets?open=1'],
        ['https://elsewhere.example/', '/en/dashboard'],
        ['//elsewhere.example/', '/en/dashboard'],
        ['/\\elsewhere.example/', '/en/dashboard'],
        ['/\t/elsewhere.example/', '/en/dashboard'],
        ['javascript:alert(1)', '/en/dashboard'],
    ])('a remembered path %j lands on %j: only a path on this origin is answered', async (lastPath, redirectTo) => {
        const { updatePersonState } = await import('../adapters/fake/simulator')
        updatePersonState('person:fixture-crew', { lastPath })
        const response = await call('viewpoint', { json: { person: 'person:fixture-crew', locale: 'en' } })
        expect(await response.json()).toEqual({ redirectTo })
    })

    test.each([
        [{ person: 'person:fixture-lead', locale: 'xx' }, 'unknown locale'],
        [{ person: 'person:nobody', locale: 'en' }, 'unknown person'],
        [{ person: 'invited:nobody', locale: 'en' }, 'unknown invite'],
        [{ person: 'admin', locale: 'en' }, 'unsupported person key'],
        [{ locale: 'en' }, 'unsupported person key'],
    ])('an invalid viewpoint %j is 400 %s', async (json, error) => {
        const response = await call('viewpoint', { json })
        expect(response.status).toBe(400)
        expect(await response.json()).toEqual({ error })
    })
})

describe('an invited person', () => {
    test('is a People row without an account, and becoming them signs this browser out onto the welcome page', async () => {
        const { fakeAuth } = await import('../adapters/fake/auth')
        const { id } = await fakeAuth.createInvite({ email: 'new.hand@example.test', role: 'member', orgSlug: 'wharf' })
        await call('viewpoint', { json: { person: 'person:fixture-lead', locale: 'en' } })

        const summary = (await (await call('summary')).json()) as SimulatorSummary
        expect(summary.people.find((person) => person.key === `invited:${id}`)).toMatchObject({
            name: null,
            status: 'invited',
            hasAccount: false,
            tenantSlug: 'lakeside',
        })

        const response = await call('viewpoint', { json: { person: `invited:${id}`, locale: 'es' } })
        expect(await response.json()).toEqual({ redirectTo: '/es' })
        const after = (await (await call('summary')).json()) as SimulatorSummary
        expect(after).toMatchObject({ signedIn: false, viewpoint: `invited:${id}` })
    })
})

describe('mail', () => {
    test('scopes to one inbox, counts every inbox, and clears', async () => {
        const { fakeEmail } = await import('../adapters/fake/email')
        await fakeEmail.send({ to: 'ada.keeper@example.test', subject: 'For Ada', html: '<p>a</p>', text: 'a' })
        await fakeEmail.send({ to: 'bo.deckhand@example.test', subject: 'For Bo', html: '<p>b</p>', text: 'b' })

        const ada = (await (await call('mail?person=person:fixture-lead')).json()) as SimulatorMail
        expect(ada.emails.map((email) => email.subject)).toEqual(['For Ada'])
        expect(ada.allCount).toBe(2)
        const all = (await (await call('mail?all=1')).json()) as SimulatorMail
        expect(all.emails).toHaveLength(2)

        // Unread until seen.
        const unread = (await (await call('summary')).json()) as SimulatorSummary
        expect(unread.people.find((person) => person.key === 'person:fixture-lead')?.unreadMail).toBe(1)
        expect((await call('mail/seen', { json: { person: 'person:fixture-lead' } })).status).toBe(200)
        const seen = (await (await call('summary')).json()) as SimulatorSummary
        expect(seen.people.find((person) => person.key === 'person:fixture-lead')?.unreadMail).toBe(0)
        const adaSeen = (await (await call('mail?person=person:fixture-lead')).json()) as SimulatorMail
        expect(adaSeen.mailSeenAt).toEqual(expect.any(String))

        expect((await call('mail/clear', { json: {} })).status).toBe(204)
        expect(((await (await call('mail?all=1')).json()) as SimulatorMail).emails).toEqual([])
    })

    test('mail/seen refuses a key that names no one in the world, and writes nothing for it', async () => {
        expect((await call('mail/seen', { json: { person: 'everyone' } })).status).toBe(400)
        expect((await call('mail/seen', { json: { person: 'person:nobody' } })).status).toBe(400)
        expect((await call('mail/seen', { json: { person: 'invited:nobody' } })).status).toBe(400)
        const { readSimulatorState } = await import('../adapters/fake/simulator')
        expect(Object.keys(readSimulatorState().people)).not.toContain('person:nobody')
    })
})

describe('jobs and the clock', () => {
    // The world's database boots (pglite, migrations, seed) on first use: here, not inside the test's own timeout.
    beforeAll(async () => {
        const { fakeDb } = await import('../adapters/fake/db')
        await fakeDb.ready()
    }, 120_000)

    test('lists the world, moves the clock within its bound, and resets it', async () => {
        const jobs = await call('jobs')
        expect(await jobs.json()).toMatchObject({ held: false })
        const { setFlag } = await import('../adapters/fake/analytics')
        const { JOBS_HELD_FLAG } = await import('../adapters/fake/jobs')
        setFlag(JOBS_HELD_FLAG, true)
        expect(await (await call('jobs')).json()).toMatchObject({ held: true })
        setFlag(JOBS_HELD_FLAG, false)
        expect((await call('jobs/run-pending', { json: {} })).status).toBe(200)

        expect((await call('clock', { json: { action: 'advance', deltaMs: 367 * 86_400_000 } })).status).toBe(400)
        expect((await call('clock', { json: { action: 'advance', deltaMs: -1 } })).status).toBe(400)
        expect((await call('clock', { json: { action: 'rewind' } })).status).toBe(400)
        expect((await call('clock', { json: [] })).status).toBe(400)

        const advanced = await call('clock', { json: { action: 'advance', deltaMs: 3_600_000 } })
        expect(advanced.status).toBe(200)
        // Due webhook deliveries run with due schedules, at the world's new "now".
        expect(await advanced.json()).toMatchObject({
            ok: true,
            clockOffsetMs: 3_600_000,
            spawned: expect.any(Number),
            deliveries: expect.any(Object),
        })
        const schedules = (await (await call('schedules')).json()) as SimulatorSchedules
        expect(schedules.clockOffsetMs).toBe(3_600_000)

        expect(await (await call('clock', { json: { action: 'reset' } })).json()).toMatchObject({ clockOffsetMs: 0 })

        // A year at a time, but never past a century ahead in all.
        const YEAR = 366 * 86_400_000
        for (let year = 0; year < 100; year++) {
            expect((await call('clock', { json: { action: 'advance', deltaMs: YEAR } })).status).toBe(200)
        }
        expect((await call('clock', { json: { action: 'advance', deltaMs: 1 } })).status).toBe(400)
        expect(await (await call('clock', { json: { action: 'reset' } })).json()).toMatchObject({ clockOffsetMs: 0 })
        expect(await (await call('schedules/run-due', { json: {} })).json()).toMatchObject({ ok: true, spawned: 0 })
    })
})
