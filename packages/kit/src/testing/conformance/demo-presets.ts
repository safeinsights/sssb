import { afterAll, beforeAll, expect, vi } from 'vitest'
import { dataRoot, setDataRoot } from '../../adapters/fake/data-dir'
import type { MessageTree } from '../../i18n/messages'
import { makeTestTmpDir, removeTestTmpDir } from '../tmp-dir'
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
 * THE DATA DIR. The fake adapters keep their world under APP_DATA_DIR, else the working directory's `.data`, which is
 * the developer's own dev world: a replay there would reset and reseed it. So `setup` ASSIGNS APP_DATA_DIR for the
 * check's tests (`setDataRoot`), never `vi.stubEnv`, which an adopter's `unstubEnvs: true` undoes before every test,
 * and every test that reaches the adapters first proves the scratch dir is still in effect (`inScratchWorld`),
 * failing rather than replaying anywhere else. Its teardown closes the fake database the replay opened there before
 * deleting the dir, so a file run after it without isolation opens its own, and before any of that waits for a replay
 * that outlived its test's timeout to stop (see `demoPresets`), so it never runs on into the developer's world.
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
            "demo-presets: the adapter registry is not the conformance suite's mock (registered with vi.doMock while " +
                'the file was collected), so the replay would run on the real adapters. Vitest hands the REAL module to ' +
                "an import made while a mock's factory is still running, so another test of this file importing " +
                '@sssb/kit/adapters/index (or a module that does) at the same moment does this (`it.concurrent`, ' +
                '`describe.concurrent`: the suite runs its own tests one at a time); so does a `vi.doUnmock` or ' +
                `\`vi.unmock\` of it. ${detail}`,
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

/** One file's scratch world: the dir, the APP_DATA_DIR it replaced, and the replay running in it, if one is. */
interface ScratchWorld {
    dir: string
    previous: string | undefined
    /** Set when the file's teardown begins: a replay still running stops before its next preset. */
    stopping: boolean
    /** The replay test's body, settled or not, which runs on past a timeout of its test (Vitest cannot stop it). */
    replay?: Promise<void>
}

/** The check's scratch world while its tests run; undefined outside them. */
let world: ScratchWorld | undefined

/** The scratch world; fails loudly, before any adapter is touched, when the fake adapters would not write into it. */
function inScratchWorld(): ScratchWorld {
    const root = dataRoot()
    if (world === undefined || root !== world.dir) {
        throw new Error(
            `demo-presets: the fake adapters' data dir is ${root}, not the check's scratch dir (${world?.dir ?? 'not made'}), ` +
                'so a replay would reset and reseed that world. Something reassigned APP_DATA_DIR after the check set it.',
        )
    }
    return world
}

const REPLAY_TEST =
    'replay on the server host: every operation performed, every invite pending, every hold set, the viewpoint signed in'

/** Whether `promise` settles within `ms`. */
async function settlesWithin(promise: Promise<void>, ms: number): Promise<boolean> {
    let timer: ReturnType<typeof setTimeout> | undefined
    const timedOut = new Promise<false>((resolve) => (timer = setTimeout(() => resolve(false), ms)))
    try {
        return await Promise.race([promise.then(() => true), timedOut])
    } finally {
        clearTimeout(timer)
    }
}

/**
 * Leaves `own`: closes the database the replay opened there, points the adapters back, then deletes the dir. In this
 * order, in one function: without isolation the next file shares this one's globals, and a client left cached on
 * `globalThis` would serve it this world; and tmp-dir's own cleanup belongs to the first file that loaded it, so the
 * check removes its directory itself. `onlyIfStillOurs` (a teardown deferred past the file) closes the database only
 * while the adapters still point here: by then a later file may have opened its own.
 */
async function leaveWorld(own: ScratchWorld, onlyIfStillOurs: boolean): Promise<void> {
    try {
        if (!onlyIfStillOurs || dataRoot() === own.dir) await (await import('../../adapters/fake/db')).closeFakeDb()
    } finally {
        if (dataRoot() === own.dir) setDataRoot(own.previous)
        removeTestTmpDir(own.dir)
        if (world === own) world = undefined
    }
}

/**
 * THE REPLAY OUTLIVING ITS TEST. A test that times out fails, but its body runs on: Vitest cannot stop a promise. A
 * replay still running when the file tears down would, once APP_DATA_DIR is restored, reopen the database and write
 * its files under the working directory's `.data`, the developer's world. So the teardown first marks the world as
 * stopping (the replay goes no further than the preset it is in) and waits for the replay to settle, up to
 * `replayStopWaitMs`. If it still has not, the teardown fails, saying so, and leaves APP_DATA_DIR on the scratch dir
 * for the replay to finish in; the dir is closed and removed once it settles. Tests of the check set the wait (and
 * the replay's timeout, in `timeouts`) before registering the suite; nothing an adopter configures reaches either.
 */
export const demoPresets: CheckImpl & { replayStopWaitMs: number } = {
    replayStopWaitMs: 30_000,
    setup: () => {
        mockServerOnlyWorld()
        const stopWaitMs = demoPresets.replayStopWaitMs
        beforeAll(() => {
            const dir = makeTestTmpDir('app-demo-presets-seam-')
            world = { dir, previous: setDataRoot(dir), stopping: false }
        })
        // ONE hook, so the order holds whatever `sequence.hooks` says (see `leaveWorld`).
        afterAll(async () => {
            const own = world
            if (own === undefined) return
            own.stopping = true
            if (own.replay !== undefined && !(await settlesWithin(own.replay, stopWaitMs))) {
                // Its failure has nowhere to be reported by then; the error below has already said what is left behind.
                void own.replay.then(() => leaveWorld(own, true)).catch(() => undefined)
                throw new Error(
                    `demo-presets: the replay was still running ${stopWaitMs / 1000} s after its test ended (it ` +
                        `times out at ${(demoPresets.timeouts?.[REPLAY_TEST] ?? 0) / 1000} s), so APP_DATA_DIR ` +
                        `stays on the check's scratch dir (${own.dir}) until it stops, and the dir is removed ` +
                        'then: pointing the adapters back now would let it write into the developer world.',
                )
            }
            await leaveWorld(own, false)
        }, stopWaitMs + 30_000)
    },
    timeouts: { [REPLAY_TEST]: 60_000 },
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
            inScratchWorld()
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
        [REPLAY_TEST]: async () => {
            const own = inScratchWorld()
            const replay = replayEveryPreset(own)
            own.replay = replay.then(
                () => undefined,
                () => undefined,
            )
            await replay
        },
    },
}

/** The replay test's body: every registered preset, replayed in `own` and held to its expanded script. */
async function replayEveryPreset(own: ScratchWorld): Promise<void> {
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
        if (own.stopping)
            throw new Error(`demo-presets: the file is tearing down, so the replay stops before ${preset.id}`)
        inScratchWorld()
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
}
