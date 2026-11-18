import { afterAll, beforeAll, expect, vi } from 'vitest'
import type { MessageTree } from '../../i18n/messages'
import { makeTestTmpDir } from '../tmp-dir'
import type { CheckImpl } from './types'

/**
 * `demo-presets`: SEAM CONFORMANCE for demo presets (@sssb/kit/core/presets.ts). A preset replays on two hosts that
 * share no code path, so a preset naming a person, team, handler or flag the world does not have would fail
 * differently on each — or, worse, quietly do nothing on one. This holds every registered preset to the seed and
 * the registries it will replay against, and its copy to both catalogs, at build time.
 *
 * The world is DERIVED (seed people, seed orgs, the composed inbound registry, KNOWN_FLAGS, the registered actors),
 * never listed here, so the check cannot drift from what the replays actually consult. So is the operation registry:
 * SSSB's kinds composed with the app's (`composePresetOperations(appPresetOperations)`), and held both ways to the
 * server halves the replay dispatches to — a kind with a definition and no server half would pass the static check
 * and then throw on the first replay. (The STATIC halves are supplied by each app's static composition root at
 * runtime, where no unit test can see them; the static demo's e2e loads every registered preset instead.)
 *
 * The static check is not the whole proof: the last test REPLAYS every registered preset through the server path
 * (@sssb/kit/server-lib/demo-presets.ts) against this app's real seed, migrations and handlers, so a preset that
 * only an e2e would have caught throwing fails here. Same harness as demo-presets.test.ts: a throwaway data dir, a
 * cookie jar, a stub translator, and the fake adapters standing in for the `server-only` registry.
 *
 * THE MOCKS. A test file's `vi.mock` is hoisted above its imports; a library's is not, so `setup` registers them
 * with `vi.doMock` while the suite is collected, before any test runs, and every module that reaches them (the
 * adapter registry, `next/headers`, `next-intl/server`) is imported only afterwards, inside a test. Nothing the
 * suite imports statically loads `../../adapters/index`. A mock that silently failed to apply would leave the replay
 * on the REAL registry, so the tests that rely on it first prove it applied (`mockedRegistry`).
 */

const cookieStore = new Map<string, { value: string }>()

/** Set on the mocked adapter registry, so a test can tell the mock from the real module. */
const MOCK_MARK = '__sssbConformanceMock'

function mockServerOnlyWorld(): void {
    vi.doMock('next/headers', () => ({
        cookies: async () => ({
            get: (name: string) => cookieStore.get(name),
            set: (name: string, value: string) => cookieStore.set(name, { value }),
            delete: (name: string) => cookieStore.delete(name),
        }),
    }))
    vi.doMock('../../adapters/index', async () => ({
        [MOCK_MARK]: true,
        isSimulated: true,
        auth: (await import('../../adapters/fake/auth')).fakeAuth,
        db: (await import('../../adapters/fake/db')).fakeDb,
        email: (await import('../../adapters/fake/email')).fakeEmail,
        analytics: (await import('../../adapters/fake/analytics')).fakeAnalytics,
    }))
    vi.doMock('next-intl/server', () => ({
        getTranslations: async () => (key: string) => key,
    }))
}

/** Fails loudly when the adapter registry the replay will reach is not the mock `setup` registered. */
async function mockedRegistry(): Promise<void> {
    const notMocked = (detail: string) =>
        new Error(
            "demo-presets: the adapter registry is not the conformance suite's mock (vi.doMock did not take effect), so " +
                'the replay would run on the real adapters. Something loaded @sssb/kit/adapters/index before the suite ' +
                `was collected, or the test file runs without isolation. ${detail}`,
        )
    let registry: Record<string, unknown>
    try {
        registry = await import('../../adapters/index')
    } catch (error) {
        // The real registry refuses to load outside a server (`server-only`), which is how this usually shows.
        throw notMocked(`Loading the real one failed: ${error instanceof Error ? error.message : String(error)}`)
    }
    if (registry[MOCK_MARK] !== true) throw notMocked('The real one loaded.')
}

function resolve(tree: MessageTree, key: string): unknown {
    return key.split('.').reduce<unknown>((node, part) => (node as MessageTree | undefined)?.[part], tree)
}

async function registries() {
    const { appPresetOperations, presets } = await import('@sssb/app-config/presets')
    const { composePresetOperations } = await import('../../core/presets')
    return { presets, definitions: composePresetOperations(appPresetOperations) }
}

export const demoPresets: CheckImpl = {
    setup: () => {
        mockServerOnlyWorld()
        // The replay's world lives in a throwaway data dir (the fake adapters read APP_DATA_DIR), never the app's .data.
        beforeAll(() => {
            vi.stubEnv('APP_DATA_DIR', makeTestTmpDir('app-demo-presets-seam-'))
        })
        afterAll(() => {
            vi.unstubAllEnvs()
        })
    },
    timeouts: {
        'replay on the server host: every operation performed, every invite pending, every hold set, the viewpoint signed in': 60_000,
    },
    tests: {
        'describe only worlds the product could reach': async () => {
            const { presets, definitions } = await registries()
            const { presetProblems } = await import('../../core/presets')
            const { actors } = await import('@sssb/app-config/actors')
            const { organizations, people } = await import('@sssb/app-config/seed')
            const { KNOWN_FLAGS } = await import('../../adapters/fake/analytics')
            const { inboundHandlers } = await import('../../inbound-email/handlers')
            const problems = presetProblems(
                presets,
                {
                    people: people.map((person) => ({
                        id: person.id,
                        email: person.email,
                        memberships: person.memberships,
                        restricted: person.restricted,
                    })),
                    orgSlugs: organizations.map((org) => org.slug),
                    handlers: Object.keys(inboundHandlers),
                    flags: KNOWN_FLAGS,
                    actors: actors.map((actor) => actor.id),
                },
                definitions,
            )
            expect(problems).toEqual([])
        },
        'use only operation kinds the registry defines': async () => {
            const { presets, definitions } = await registries()
            const used = new Set(
                presets.flatMap((preset) => (preset.operations ?? []).map((operation) => operation.op)),
            )
            expect([...used].filter((kind) => !Object.hasOwn(definitions, kind))).toEqual([])
        },
        'have a server half for every defined operation kind, and no server half without a definition': async () => {
            await mockedRegistry()
            const { definitions } = await registries()
            const { presetOperationHandlers } = await import('../../server-lib/demo-presets')
            expect(Object.keys(presetOperationHandlers).sort()).toEqual(Object.keys(definitions).sort())
        },
        'resolve their title and summary in BOTH catalogs': async () => {
            const { presets } = await registries()
            const { loadAppMessages } = await import('@sssb/app-config/messages')
            const missing: string[] = []
            for (const locale of ['en', 'es']) {
                const catalog = await loadAppMessages(locale)
                for (const preset of presets) {
                    for (const key of [preset.titleKey, preset.summaryKey]) {
                        if (typeof resolve(catalog, key) !== 'string') missing.push(`${locale} is missing ${key}`)
                    }
                }
            }
            expect(missing).toEqual([])
        },
        'replay on the server host: every operation performed, every invite pending, every hold set, the viewpoint signed in':
            async () => {
                await mockedRegistry()
                const { presets } = await registries()
                const { expandPreset } = await import('../../core/presets')
                const { applyDemoPreset } = await import('../../server-lib/demo-presets')
                const { fakeAuth } = await import('../../adapters/fake/auth')
                const { readActorHolds } = await import('../../adapters/fake/simulator')
                for (const preset of presets) {
                    // What replays is the EXPANDED preset (`extends` chain flattened): a child's inherited invites
                    // and viewpoint are as much its world as its own.
                    const expanded = expandPreset(preset.id, presets)
                    if (!expanded) throw new Error(`${preset.id} does not expand (unknown base or a cycle)`)
                    const result = await applyDemoPreset(preset.id, { baseUrl: 'http://localhost:3000/' })
                    expect(result, preset.id).toEqual({ signedIn: expanded.viewpoint !== undefined })
                    // The replay reset the world first, so the hold file is exactly the script's last word per actor.
                    const expectedHolds: Record<string, boolean> = {}
                    for (const operation of expanded.operations) {
                        if (operation.op === 'actor.hold') expectedHolds[operation.actor] = operation.held
                    }
                    expect(readActorHolds(), `${preset.id}: actor holds`).toEqual(expectedHolds)
                    for (const operation of expanded.operations) {
                        if (operation.op !== 'invite') continue
                        const members = await fakeAuth.listMembers(operation.org)
                        expect(
                            members.some((member) => member.status === 'invited' && member.email === operation.email),
                            `${preset.id}: invite to ${operation.email}`,
                        ).toBe(true)
                    }
                    if (expanded.viewpoint !== undefined) {
                        expect((await fakeAuth.getCurrentUser())?.id, preset.id).toBe(expanded.viewpoint)
                    }
                }
            },
    },
}
