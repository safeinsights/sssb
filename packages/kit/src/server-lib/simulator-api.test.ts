import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest'
import { makeTestTmpDir } from '../testing/tmp-dir'
import type {
    SimulatorAgreements,
    SimulatorFlags,
    SimulatorMail,
    SimulatorSchedules,
    SimulatorSnapshots,
    SimulatorSummary,
} from './simulator-api'

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
    email: (await import('../adapters/fake/email')).fakeEmail,
    analytics: (await import('../adapters/fake/analytics')).fakeAnalytics,
}))
// A preset's invite email is rendered with the server translator; its copy is not what is under test here.
vi.mock('next-intl/server', () => ({
    getTranslations: async () => (key: string) => key,
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

// The module and everything it imports load once, here, not inside the first test's own timeout.
beforeAll(async () => {
    await import('./simulator-api')
}, 120_000)

beforeEach(() => {
    mode.simulated = true
    cookieStore.clear()
})

describe('dispatch', () => {
    test('a real build answers 404 on every path, the known ones included', async () => {
        mode.simulated = false
        expect((await call('summary')).status).toBe(404)
        expect((await call('mail/clear', { json: {} })).status).toBe(404)
        expect((await call('snapshots')).status).toBe(404)
        expect((await call('reset', { json: {} })).status).toBe(404)
        expect((await call('presets', { json: { name: 'busy-harbor', locale: 'en' } })).status).toBe(404)
        expect(cookieStore.size).toBe(0)
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

    test.each(['reset', 'snapshots', 'snapshots/restore', 'snapshots/delete', 'flags', 'agreements/bump', 'presets'])(
        'a %s POST that is not JSON is refused before it runs',
        async (path) => {
            const response = await call(path, {
                method: 'POST',
                headers: { 'content-type': 'text/plain' },
                body: JSON.stringify({ name: 'busy-harbor', locale: 'en', flag: 'jobs-held', enabled: true }),
            })
            expect(response.status).toBe(415)
        },
    )
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
        const { id } = await fakeAuth.createInvite({
            email: 'new.hand@example.test',
            role: 'member',
            orgSlug: 'wharf',
            acceptPageUrl: 'http://localhost:3000/en/accept-invite',
        })
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

// Last, because a reset, a restore and a preset each rewrite the whole world under the tests above.
describe('snapshots, flags, agreements and presets', () => {
    beforeAll(async () => {
        const { fakeDb } = await import('../adapters/fake/db')
        await fakeDb.ready()
    }, 120_000)

    async function flagOn(flag: string): Promise<boolean | undefined> {
        const body = (await (await call('flags')).json()) as SimulatorFlags
        return body.flags.find((candidate) => candidate.flag === flag)?.enabled
    }

    test('flags lists every known flag and sets one, and refuses one it does not know', async () => {
        const { KNOWN_FLAGS } = await import('../adapters/fake/analytics')
        const body = (await (await call('flags')).json()) as SimulatorFlags
        expect(body.flags.map((flag) => flag.flag)).toEqual(KNOWN_FLAGS)
        expect(await flagOn('jobs-held')).toBe(false)

        expect(await (await call('flags', { json: { flag: 'jobs-held', enabled: true } })).json()).toEqual({ ok: true })
        expect(await flagOn('jobs-held')).toBe(true)

        expect((await call('flags', { json: { flag: 'no-such-flag', enabled: true } })).status).toBe(400)
        expect((await call('flags', { json: { flag: 'jobs-held', enabled: 'yes' } })).status).toBe(400)
        expect((await call('flags', { json: [] })).status).toBe(400)
    })

    test('a refused POST changes nothing', async () => {
        const refused = await call('flags', {
            method: 'POST',
            headers: { 'content-type': 'text/plain' },
            body: JSON.stringify({ flag: 'jobs-held', enabled: false }),
        })
        expect(refused.status).toBe(415)
        expect(await flagOn('jobs-held')).toBe(true)
    })

    test('a reset puts the world back to the seed', async () => {
        await call('flags', { json: { flag: 'jobs-held', enabled: true } })
        expect((await call('reset', { json: {} })).status).toBe(204)
        expect(await flagOn('jobs-held')).toBe(false)
    })

    test('a snapshot saves the world, restores it, and is deleted', async () => {
        await call('flags', { json: { flag: 'demo-banner', enabled: true } })
        expect((await call('snapshots', { json: { name: 'harbor-noon' } })).status).toBe(204)
        const listed = (await (await call('snapshots')).json()) as SimulatorSnapshots
        expect(listed.snapshots).toEqual([{ name: 'harbor-noon', at: expect.any(String) }])

        await call('flags', { json: { flag: 'demo-banner', enabled: false } })
        expect((await call('snapshots/restore', { json: { name: 'harbor-noon' } })).status).toBe(204)
        expect(await flagOn('demo-banner')).toBe(true)

        expect((await call('snapshots/delete', { json: { name: 'harbor-noon' } })).status).toBe(204)
        expect(((await (await call('snapshots')).json()) as SimulatorSnapshots).snapshots).toEqual([])
        expect((await call('snapshots/restore', { json: { name: 'harbor-noon' } })).status).toBe(404)
        expect((await call('snapshots/delete', { json: { name: 'harbor-noon' } })).status).toBe(404)
    })

    test.each([
        [{}, 400],
        [{ name: 7 }, 400],
        // A name outside the world-start pattern, and one a tour reads as another start: the reset, or a preset.
        [{ name: 'Harbor Noon' }, 403],
        [{ name: '../escape' }, 403],
        [{ name: 'reset' }, 403],
        [{ name: 'busy-harbor' }, 403],
    ])('saving a snapshot as %j is refused with %i', async (json, status) => {
        expect((await call('snapshots', { json })).status).toBe(status)
        expect(((await (await call('snapshots')).json()) as SimulatorSnapshots).snapshots).toEqual([])
    })

    test("agreements lists every tenant's, and a bump moves one to its next version", async () => {
        const { fakeDb } = await import('../adapters/fake/db')
        // A reset above closed the world's database; it opens again on first use.
        await fakeDb.ready()
        const raw = fakeDb.getDb()
        const tenant = await raw
            .selectFrom('tenants')
            .select('id')
            .where('slug', '=', 'harbor')
            .executeTakeFirstOrThrow()
        const { id } = await raw
            .insertInto('agreements')
            .values({
                tenant_id: tenant.id,
                kind: 'tos',
                title: 'Harbor rules',
                body_md: 'Mind the lines.',
                gating: 'block-all',
            })
            .returning('id')
            .executeTakeFirstOrThrow()

        const before = (await (await call('agreements')).json()) as SimulatorAgreements
        expect(before.agreements).toEqual([
            expect.objectContaining({
                id,
                tenantSlug: 'harbor',
                version: 1,
                currentAcceptances: 0,
                totalAcceptances: 0,
            }),
        ])
        expect(await (await call('agreements/bump', { json: { agreementId: id } })).json()).toEqual({ version: 2 })
        const after = (await (await call('agreements')).json()) as SimulatorAgreements
        expect(after.agreements[0]?.version).toBe(2)

        expect((await call('agreements/bump', { json: {} })).status).toBe(400)
        expect((await call('agreements/bump', { json: { agreementId: 'a1' } })).status).toBe(400)
        const unknown = await call('agreements/bump', { json: { agreementId: '00000000-0000-4000-8000-000000000000' } })
        expect(unknown.status).toBe(404)
    })

    test('a preset replays its script and signs this browser in as its viewpoint', async () => {
        const response = await call('presets', { json: { name: 'busy-harbor', locale: 'es' } })
        expect(response.status).toBe(200)
        expect(await response.json()).toEqual({ redirectTo: '/es/dashboard' })
        const summary = (await (await call('summary')).json()) as SimulatorSummary
        expect(summary).toMatchObject({ signedIn: true, viewpoint: 'person:fixture-hand' })
        // Its `flag` step, through the fixture's own half of that kind.
        expect(await flagOn('jobs-held')).toBe(true)
    })

    test.each([
        [{ name: 'no-such-preset', locale: 'en' }, 404],
        [{ name: 'Busy Harbor', locale: 'en' }, 400],
        [{ locale: 'en' }, 400],
        [{ name: 'busy-harbor', locale: 'xx' }, 400],
    ])('a preset load of %j is refused with %i', async (json, status) => {
        expect((await call('presets', { json })).status).toBe(status)
    })
})
