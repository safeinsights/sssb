// @vitest-environment node
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { orgIdForSlug } from '../db/org-lookup'
import type { AuthPort, Membership } from '../ports/auth'
import { tenantIdForSlug } from '../db/tenant-lookup'
import { makeTestTmpDir } from '../testing/tmp-dir'

/**
 * The digest handler's sending branch, run for real. `db/schedules.test.ts` proves a due schedule
 * SPAWNS a `digest-email` job, but it stubs the jobs port, so `digestEmailHandler` itself never runs
 * there; this file calls it directly against the fake db and the fake email catch-store.
 */

/**
 * `getTranslations` from `next-intl/server` refuses to run outside a React Server Component render, and
 * plain vitest is not one. This stand-in resolves the SAME merged catalog (framework + the fixture's own)
 * that the real call would, descending into the requested namespace first because the handler asks for
 * `namespace: 'email'` and then looks keys up unqualified — so the copy asserted below is the real copy.
 */
vi.mock('next-intl/server', () => ({
    getTranslations: async ({ namespace }: { locale?: string; namespace?: string } = {}) => {
        const { mergeMessages } = await import('../i18n/messages')
        const { loadAppMessages } = await import('@sssb/app-config/messages')
        const framework = (await import('../i18n/messages/en.json')).default
        const merged = mergeMessages(framework, await loadAppMessages('en'))
        const lookup = (tree: unknown, dotted: string): unknown =>
            dotted
                .split('.')
                .reduce<unknown>((node, part) => (node as Record<string, unknown> | undefined)?.[part], tree)
        const scope = namespace ? lookup(merged, namespace) : merged
        return (key: string, values?: Record<string, string | number>) => {
            const message = lookup(scope, key)
            if (typeof message !== 'string') throw new Error(`missing message "${namespace ?? ''}.${key}"`)
            return message.replace(/\{(\w+)\}/g, (_match, name: string) => String(values?.[name] ?? `{${name}}`))
        }
    },
}))

/**
 * The fixture registers an empty digest source (`test-fixture/app-config/digest.ts`), which only reaches
 * the empty-state branch. Replacing the registration here lets one test drive the populated branch —
 * counting past the recent-items cap, snipping a long body — without giving the fixture a table to read.
 * Every test here therefore runs against this replacement, never the fixture's own registration.
 *
 * Not covered: the recipient's locale choosing the copy. The translation stand-in above ignores `locale` and always
 * reads the English catalog, and every recipient these tests reach is English.
 */
const digest = vi.hoisted(() => ({ bodies: [] as string[] }))
vi.mock('@sssb/app-config/digest', () => ({ digestBodies: async () => digest.bodies }))

/**
 * The run mode, switchable per test, and a guard on the seed: while `seedForbidden` is set, reading anything from
 * `@sssb/app-config/seed` throws. The simulated world still seeds itself from it before a test starts; a deployment
 * has no seed, so a real-mode digest must never read it.
 */
const mode = vi.hoisted(() => ({ simulated: true, seedForbidden: false }))
vi.mock('../adapters/run-mode', () => ({
    get isSimulated() {
        return mode.simulated
    },
    get appMode() {
        return mode.simulated ? 'simulated' : 'real'
    },
}))
vi.mock('@sssb/app-config/seed', async (importOriginal) => {
    // Every export behind a getter that throws while forbidden. The seeder's optional `appSeedRows` (which the
    // fixture does not define) is listed too, since a mocked module refuses a name it does not hold.
    const real = await importOriginal<Record<string, unknown>>()
    const guarded: Record<string, unknown> = {}
    for (const key of [...Object.keys(real), 'appSeedRows']) {
        Object.defineProperty(guarded, key, {
            enumerable: true,
            get() {
                if (mode.seedForbidden) throw new Error(`a real-mode digest read seed.${key}`)
                return real[key]
            },
        })
    }
    return guarded
})

// Fake-adapter state goes to a throwaway dir before anything opens pglite or the email catch-store.
const tmp = makeTestTmpDir('digest-email-')
beforeAll(() => {
    process.env['APP_DATA_DIR'] = tmp
})
afterAll(() => {
    delete process.env['APP_DATA_DIR']
})

beforeEach(async () => {
    digest.bodies = []
    mode.simulated = true
    mode.seedForbidden = false
    const { clearCaughtEmails } = await import('../adapters/fake/email')
    clearCaughtEmails()
})

async function depotIds(): Promise<{ tenantId: string; orgId: string }> {
    const { fakeDb } = await import('../adapters/fake/db')
    await fakeDb.ready()
    const tenantId = (await tenantIdForSlug(fakeDb, 'harbor'))!
    const orgId = (await orgIdForSlug(fakeDb, tenantId, 'depot'))!
    return { tenantId, orgId }
}

async function runHandler(
    tenantId: string,
    orgId: string,
    auth?: AuthPort,
    resolveLocale?: (userId: string) => 'en' | 'es' | undefined,
) {
    const { fakeDb } = await import('../adapters/fake/db')
    const { fakeStorage } = await import('../adapters/fake/storage')
    const { fakeEmail } = await import('../adapters/fake/email')
    const { fakeLlm } = await import('../adapters/fake/llm')
    const { fakeAuth } = await import('../adapters/fake/auth')
    const { digestEmailHandler } = await import('./digest-email')
    const ctx = {
        db: fakeDb,
        storage: fakeStorage,
        email: fakeEmail,
        llm: fakeLlm,
        auth: auth ?? fakeAuth,
        resolveLocale,
    }
    return digestEmailHandler({}, { ...ctx, tenantId, orgId, jobId: 'digest-test' })
}

/** An auth port whose only answer is `listMembers`, as an identity provider's would be for `orgSlug`. */
function providerWith(members: Membership[]): { auth: AuthPort; asked: string[] } {
    const asked: string[] = []
    const auth = {
        listMembers: async (orgSlug: string) => {
            asked.push(orgSlug)
            return members
        },
    } as unknown as AuthPort
    return { auth, asked }
}

/** Runs the handler as a deployment would: real mode, and any read of the seed throws. */
async function runReal(tenantId: string, orgId: string, auth: AuthPort) {
    await depotIds() // the simulated world seeds itself first, as a test's setup
    mode.simulated = false
    mode.seedForbidden = true
    try {
        return await runHandler(tenantId, orgId, auth)
    } finally {
        mode.seedForbidden = false
        mode.simulated = true
    }
}

async function sentEmails() {
    const { listCaughtEmails } = await import('../adapters/fake/email')
    return listCaughtEmails()
}

describe('digestEmailHandler', () => {
    it("sends the empty-state digest to the org's admin, named for the org", async () => {
        const { tenantId, orgId } = await depotIds()

        await runHandler(tenantId, orgId)

        // `depot`'s seeded admin is Ada Keeper; the org is 'Harbor Depot'.
        const caught = await sentEmails()
        expect(caught).toHaveLength(1)
        expect(caught[0]?.to).toBe('ada.keeper@example.test')
        expect(caught[0]?.subject).toBe('Your Harbor Depot digest')
        expect(caught[0]?.text).toContain('Nothing to report.')
        expect(caught[0]?.text).toContain('Your team has 0 open items.')
    })

    it('counts every body but lists only the recent-items cap, snipping a long one', async () => {
        const { tenantId, orgId } = await depotIds()
        digest.bodies = ['A'.repeat(80), 'Second item', 'Third item', 'Fourth item', 'Fifth item', 'Sixth item']

        await runHandler(tenantId, orgId)

        const [sent] = await sentEmails()
        expect(sent?.text).toContain('Your team has 6 open items.')
        expect(sent?.text).not.toContain('Nothing to report.')
        expect(sent?.text).toContain(`${'A'.repeat(59)}…`)
        expect(sent?.text).not.toContain('A'.repeat(60))
        expect(sent?.text).toContain('Fifth item')
        expect(sent?.text).not.toContain('Sixth item')
    })

    it('falls back to a synthetic per-org address when the org has no seeded person', async () => {
        const { fakeDb } = await import('../adapters/fake/db')
        const { tenantId } = await depotIds()
        const slug = 'fixture-unstaffed'
        const org = await fakeDb
            .getDb()
            .insertInto('organizations')
            .values({ tenant_id: tenantId, slug, name: 'Unstaffed Berth' })
            .returning('id')
            .executeTakeFirstOrThrow()

        await runHandler(tenantId, org.id)

        const [sent] = await sentEmails()
        expect(sent?.to).toBe(`${slug}@digest.example`)
        expect(sent?.subject).toBe('Your Unstaffed Berth digest')
    })

    it("in a deployment, addresses the provider's first active admin, in the default locale, and never reads the seed", async () => {
        const { tenantId, orgId } = await depotIds()
        const { auth, asked } = providerWith([
            { id: 'u-invited', name: null, email: 'pending@org.test', role: 'admin', status: 'invited' },
            { id: 'u-member', name: 'Mo', email: 'member@org.test', role: 'member', status: 'active' },
            { id: 'u-admin', name: 'Ann', email: 'admin@org.test', role: 'admin', status: 'active' },
        ])

        await runReal(tenantId, orgId, auth)

        expect(asked).toEqual(['depot'])
        const caught = await sentEmails()
        expect(caught.map((sent) => sent.to)).toEqual(['admin@org.test'])
        expect(caught[0]?.subject).toBe('Your Harbor Depot digest')
    })

    it('in a deployment, falls back to the first active member when the team has no admin', async () => {
        const { tenantId, orgId } = await depotIds()
        const { auth } = providerWith([
            { id: 'u-member', name: 'Mo', email: 'member@org.test', role: 'member', status: 'active' },
        ])
        await runReal(tenantId, orgId, auth)
        expect((await sentEmails()).map((sent) => sent.to)).toEqual(['member@org.test'])
    })

    it('in a deployment, sends nothing to a team with no active member: never a synthetic address', async () => {
        const { tenantId, orgId } = await depotIds()
        const { auth } = providerWith([
            { id: 'u-invited', name: null, email: 'pending@org.test', role: 'admin', status: 'invited' },
        ])
        await expect(runReal(tenantId, orgId, auth)).resolves.toEqual({})
        expect(await sentEmails()).toEqual([])
    })

    it('in a deployment, skips a member whose identifier is not an address (a phone number, a username)', async () => {
        const { tenantId, orgId } = await depotIds()
        const { auth } = providerWith([
            { id: 'u-phone', name: 'Pat', email: '+15550100', role: 'admin', status: 'active' },
            { id: 'u-member', name: 'Mo', email: 'member@org.test', role: 'member', status: 'active' },
        ])
        await runReal(tenantId, orgId, auth)
        expect((await sentEmails()).map((sent) => sent.to)).toEqual(['member@org.test'])
    })

    it("asks the runner for the chosen person's locale, where it can say it", async () => {
        const { tenantId, orgId } = await depotIds()
        const { auth } = providerWith([
            { id: 'u-admin', name: 'Ann', email: 'admin@org.test', role: 'admin', status: 'active' },
        ])
        const asked: string[] = []
        await runHandler(tenantId, orgId, auth, (userId) => (asked.push(userId), 'es'))
        expect(asked).toEqual(['u-admin'])
    })
})
