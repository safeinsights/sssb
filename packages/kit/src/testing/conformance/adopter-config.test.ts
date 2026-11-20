import { spawn } from 'node:child_process'
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { makeTestTmpDir } from '../tmp-dir'

/**
 * THE SUITE UNDER AN ADOPTER'S VITEST, which this repo's own config cannot show: each case writes a scratch project
 * (a Vitest config, a test file that registers the suite, a working directory and a TMPDIR of its own) and runs a
 * real `vitest run` on it in a child process, then reads what the run left behind.
 *
 * - The skip guard must not cost the file its cleanup. Vitest runs a file's `afterAll` hooks one after another and
 *   stops at the first that throws, so a guard that is one of them, when it fires, can leave the contract server
 *   running and the scratch directories on disk (`sssb check-tmpdir-leak` then fails the run for the wrong reason).
 * - Its message must name the real cause: a filter, or a hook that failed.
 * - Options that undo stubs between tests (`unstubEnvs`, `restoreMocks`, ...) must not point the demo-presets replay
 *   at the working directory's `.data`, the developer's own dev world.
 */

const KIT_SRC = path.resolve(import.meta.dirname, '../..')
const FIXTURE_SEAM = path.resolve(KIT_SRC, '../test-fixture/app-config')
const VITEST = path.join(path.dirname(createRequire(import.meta.url).resolve('vitest/package.json')), 'vitest.mjs')

/** A module specifier for a kit source file, by absolute path: the scratch project has no alias for `@sssb/kit`. */
const kit = (rel: string) => JSON.stringify(path.join(KIT_SRC, rel))

interface Project {
    dir: string
    /** The child's TMPDIR, where the suite's own scratch directories land. */
    tmp: string
    /** The child's working directory's `.data`, holding one sentinel file. */
    data: string
}

/**
 * A scratch project under a Vitest config with the given `test` options: `probe.test.ts` (the given source), or the
 * given test files by name.
 */
function project(files: string | Record<string, string>, testOptions: Record<string, unknown> = {}): Project {
    const sources = typeof files === 'string' ? { 'probe.test.ts': files } : files
    const dir = makeTestTmpDir('conformance-adopter-')
    const tmp = path.join(dir, 'tmp')
    const data = path.join(dir, '.data')
    mkdirSync(tmp)
    mkdirSync(data)
    writeFileSync(path.join(data, 'sentinel'), 'the developer world')
    const config = {
        resolve: { alias: { '@sssb/app-config': FIXTURE_SEAM } },
        test: { include: Object.keys(sources), environment: 'node', testTimeout: 60_000, ...testOptions },
    }
    writeFileSync(path.join(dir, 'vitest.config.mjs'), `export default ${JSON.stringify(config)}\n`)
    for (const [name, source] of Object.entries(sources)) writeFileSync(path.join(dir, name), source)
    return { dir, tmp, data }
}

/** Runs `vitest run` in the project, as an adopter would, with no `APP_DATA_DIR` and none of this run's Vitest state. */
function run(
    { dir, tmp }: Project,
    args: string[] = [],
    env: Record<string, string> = {},
): Promise<{ status: number | null; output: string }> {
    const childEnv: NodeJS.ProcessEnv = { ...process.env, TMPDIR: tmp, NO_COLOR: '1', ...env }
    for (const key of Object.keys(childEnv)) {
        if (key.startsWith('VITEST') || key === 'APP_DATA_DIR') delete childEnv[key]
    }
    return new Promise((resolve, reject) => {
        const child = spawn(process.execPath, [VITEST, 'run', '--config', 'vitest.config.mjs', ...args], {
            cwd: dir,
            env: childEnv,
        })
        let output = ''
        child.stdout.on('data', (chunk: Buffer) => (output += chunk.toString()))
        child.stderr.on('data', (chunk: Buffer) => (output += chunk.toString()))
        child.on('error', reject)
        child.on('close', (status) => resolve({ status, output }))
    })
}

/** The scratch directories (and their markers) the suite's own tmp-dir helper left in the child's TMPDIR. */
const leftovers = ({ tmp }: Project) => readdirSync(tmp).filter((name) => name.startsWith('app-demo-presets-seam-'))

/** Every unit check but demo-presets opted out: the one that makes a scratch directory and replays into it. */
const ONLY_DEMO_PRESETS = `
import { conformanceSuite } from ${kit('testing/index.ts')}
import registry from ${kit('testing/checks.json')}
const optOut = Object.fromEntries(
    registry.checks
        .filter((check) => check.runner === 'unit' && check.id !== 'demo-presets')
        .map((check) => [check.id, 'not under test here']),
)
conformanceSuite({
    appDir: ${JSON.stringify(path.resolve(FIXTURE_SEAM, '..'))},
    appDirOutsideCaller: 'a scratch project replaying the kit fixture',
    optOut,
})
`

/** Every scratch directory and marker any tmp-dir helper left in the child's TMPDIR. */
const anyLeftovers = ({ tmp }: Project) => readdirSync(tmp)

/**
 * The contract runner's shape without Postgres: a "server" started in a file-level beforeAll and stopped in a
 * file-level afterAll registered before the checks, as `contractSuite` does, around the contract checks with no-op
 * bodies. PROBE_FAIL makes the beforeAll throw after the server started; PROBE_TESTFAIL makes the first test of every
 * check fail.
 */
const CONTRACT_SHAPE = `
import { writeFileSync } from 'node:fs'
import { afterAll, beforeAll } from 'vitest'
import registry from ${kit('testing/checks.json')}
import { registerChecks } from ${kit('testing/conformance/register.ts')}
const state = process.env.PROBE_STATE
beforeAll(() => {
    writeFileSync(state, 'started')
    if (process.env.PROBE_FAIL) throw new Error('probe: creating the database failed')
})
afterAll(() => writeFileSync(state, 'stopped'))
const fails = (index) => () => {
    if (process.env.PROBE_TESTFAIL && index === 0) throw new Error('probe: a check failed')
}
const implementations = Object.fromEntries(
    registry.checks
        .filter((check) => check.runner === 'contract')
        .map((check) => [check.id, { tests: Object.fromEntries(check.tests.map((test, i) => [test, fails(i)])) }]),
)
registerChecks({ caller: 'contractSuite', runner: 'contract', implementations, optOut: {}, context: {} })
`

const CHILD_TIMEOUT = 120_000

describe('the skip guard, in a real run', () => {
    it(
        'fails a test-name filter that drops part of the unit suite, AFTER the file has removed its scratch dirs',
        async () => {
            const probe = project(ONLY_DEMO_PRESETS)
            const { status, output } = await run(probe, ['-t', 'describe only worlds'])
            expect(status, output).not.toBe(0)
            expect(output).toMatch(/did not run 4 of its checks/)
            expect(output).toMatch(/test-name filter/)
            expect(leftovers(probe), output).toEqual([])
        },
        CHILD_TIMEOUT,
    )

    it(
        'fails a filter on the contract suite after its server is stopped',
        async () => {
            const probe = project(CONTRACT_SHAPE)
            const state = path.join(probe.dir, 'server-state')
            const { status, output } = await run(probe, ['-t', 'the full RLS proof suite passes'], {
                PROBE_STATE: state,
            })
            expect(status, output).not.toBe(0)
            expect(output).toMatch(/did not run 3 of its checks/)
            expect(readFileSync(state, 'utf8'), output).toBe('stopped')
        },
        CHILD_TIMEOUT,
    )

    it(
        'when a beforeAll fails after the server started: still stops it, and blames the hook, not a filter',
        async () => {
            const probe = project(CONTRACT_SHAPE)
            const state = path.join(probe.dir, 'server-state')
            const { status, output } = await run(probe, [], { PROBE_STATE: state, PROBE_FAIL: '1' })
            expect(status, output).not.toBe(0)
            expect(output).toMatch(/probe: creating the database failed/)
            expect(output).toMatch(/because a hook failed/)
            expect(output).not.toMatch(/test-name filter/)
            expect(readFileSync(state, 'utf8'), output).toBe('stopped')
        },
        CHILD_TIMEOUT,
    )

    it(
        'when --bail stops the run after a failing check: says the run was cancelled, not that a filter dropped them',
        async () => {
            const probe = project(CONTRACT_SHAPE)
            const state = path.join(probe.dir, 'server-state')
            const { status, output } = await run(probe, ['--bail=1'], { PROBE_STATE: state, PROBE_TESTFAIL: '1' })
            expect(status, output).not.toBe(0)
            expect(output).toMatch(/probe: a check failed/)
            expect(output).toMatch(/did not run 4 of its checks because the run was cancelled .*--bail/)
            expect(output).not.toMatch(/test-name filter/)
            expect(output).not.toMatch(/because a hook failed/)
            expect(readFileSync(state, 'utf8'), output).toBe('stopped')
        },
        CHILD_TIMEOUT,
    )

    it(
        'when a file-level afterAll fails after a filter dropped checks: blames the filter, not the hook',
        async () => {
            const probe = project(
                `${CONTRACT_SHAPE}\nafterAll(() => { throw new Error('probe: an afterAll of the app failed') })\n`,
            )
            const state = path.join(probe.dir, 'server-state')
            const { status, output } = await run(probe, ['-t', 'the full RLS proof suite passes'], {
                PROBE_STATE: state,
            })
            expect(status, output).not.toBe(0)
            expect(output).toMatch(/probe: an afterAll of the app failed/)
            expect(output).toMatch(/did not run 3 of its checks, and none of them is opted out/)
            expect(output).not.toMatch(/because a hook failed/)
        },
        CHILD_TIMEOUT,
    )
})

describe('the suite without isolation or with concurrent tests, in a real run', () => {
    it(
        'passes under sequence.concurrent: the checks run one at a time whatever the config says',
        async () => {
            const probe = project(ONLY_DEMO_PRESETS, { sequence: { concurrent: true } })
            const { status, output } = await run(probe, ['--reporter=verbose'])
            expect(status, output).toBe(0)
            expect(output).toMatch(/✓ .*replay on the server host/)
            expect(leftovers(probe), output).toEqual([])
        },
        CHILD_TIMEOUT,
    )

    /**
     * Two files that register the suite, then a third, in ONE worker without isolation (Vitest runs the larger files
     * first, so the padding sets the order): globals and the module cache carry from file to file.
     */
    const counted = (source: string, padding: number) =>
        `${source}\nconst g = globalThis\ng.__probeFiles = (g.__probeFiles ?? 0) + 1\n//${'x'.repeat(padding)}\n`
    const NO_ISOLATION = { isolate: false, maxWorkers: 1, fileParallelism: false }

    it(
        'without isolation: each replay closes its fake database, so the next file opens its own',
        async () => {
            const probe = project(
                {
                    'a.test.ts': counted(ONLY_DEMO_PRESETS, 4000),
                    'b.test.ts': counted(ONLY_DEMO_PRESETS, 3000),
                    'c.test.ts': `import { expect, it } from 'vitest'
it('finds no fake database left open by an earlier file', () => {
    const g = globalThis as { __probeFiles?: number; __appFakeDb?: unknown }
    expect(g.__probeFiles).toBe(2)
    expect(g.__appFakeDb).toBeUndefined()
})
`,
                },
                NO_ISOLATION,
            )
            const { status, output } = await run(probe, ['--reporter=verbose', '--sequence.shuffle=false'])
            expect(status, output).toBe(0)
            expect(output).toMatch(/✓ c\.test\.ts > finds no fake database/)
            expect(anyLeftovers(probe), output).toEqual([])
        },
        CHILD_TIMEOUT,
    )

    /**
     * The scratch-directory helper's cleanup, file by file. Each child test checks that its own directory still exists
     * when it runs, and a file's own afterAll writes into its directory, so a cleanup that runs too early fails the run;
     * a.test.ts, b.test.ts and c.test.ts run in that order (asserted), and what a case pins is in c, the last file,
     * which nothing comes after.
     */
    const HELPER = kit('testing/tmp-dir.ts')
    const NO_HOOK = /has no cleanup hook of its own/
    const withDir = (prefix: string) =>
        `import { existsSync, writeFileSync } from 'node:fs'\nimport path from 'node:path'\n` +
        `import { afterAll, beforeAll, describe, expect, it } from 'vitest'\n` +
        `import { makeTestTmpDir, removeTestTmpDir } from ${HELPER}\n` +
        `let dir = ''\nbeforeAll(() => { dir = makeTestTmpDir('${prefix}') })\n` +
        `afterAll(() => writeFileSync(path.join(dir, 'flushed'), 'closed before the directory went'))\n` +
        `it('${prefix} exists', () => expect(existsSync(dir)).toBe(true))\n`
    const CONTRACT_OPTED_OUT = `
import { contractSuite } from ${kit('testing/contract.ts')}
import registry from ${kit('testing/checks.json')}
contractSuite({
    optOut: Object.fromEntries(
        registry.checks.filter((check) => check.runner === 'contract').map((check) => [check.id, 'not under test here']),
    ),
})
`
    async function runInOrder(probe: Project): Promise<{ left: string[]; output: string }> {
        const { status, output } = await run(probe, ['--reporter=verbose', '--sequence.shuffle=false'])
        expect(status, output).toBe(0)
        const at = (name: string) => output.search(new RegExp(`[✓↓] ${name}\\.test\\.ts`))
        expect(at('a'), output).toBeGreaterThan(-1)
        expect(at('b'), output).toBeGreaterThan(at('a'))
        expect(at('c'), output).toBeGreaterThan(at('b'))
        return { left: anyLeftovers(probe), output }
    }

    it.each([
        ['conformanceSuite', ONLY_DEMO_PRESETS],
        ['contractSuite', CONTRACT_OPTED_OUT],
    ])(
        "without isolation: %s gives a later file its own cleanup, at its top level and after the file's own afterAll",
        async (_, suite) => {
            const probe = project(
                {
                    'a.test.ts': counted(`${suite}\n${withDir('probe-a-')}`, 6000),
                    'b.test.ts': counted(`${suite}\n${withDir('probe-b-')}`, 4000),
                    'c.test.ts': `${suite}\n${withDir('probe-c-')}`,
                },
                NO_ISOLATION,
            )
            const { left, output } = await runInOrder(probe)
            expect(left, output).toEqual([])
            expect(output).not.toMatch(NO_HOOK)
        },
        CHILD_TIMEOUT,
    )

    it(
        'without isolation and no suite to register a hook: nothing in use is removed, and only the last file is left, said once',
        async () => {
            const direct = (name: string) =>
                `import { existsSync } from 'node:fs'\nimport { describe, expect, it } from 'vitest'\n` +
                `import { makeTestTmpDir } from ${HELPER}\n` +
                `let shared = ''\ndescribe('outer', () => {\n` +
                `    describe('inner', () => {\n        shared = makeTestTmpDir('probe-${name}-')\n` +
                `        it('inner', () => expect(existsSync(shared)).toBe(true))\n    })\n` +
                `    it('outer, after inner', () => expect(existsSync(shared)).toBe(true))\n})\n`
            const probe = project(
                {
                    'a.test.ts': counted(direct('a'), 6000),
                    'b.test.ts': counted(direct('b'), 4000),
                    'c.test.ts': direct('c'),
                },
                NO_ISOLATION,
            )
            const { left, output } = await runInOrder(probe)
            expect(left.length, output).toBeGreaterThan(0)
            expect(
                left.filter((entry) => !entry.startsWith('probe-c-')),
                output,
            ).toEqual([])
            expect(output.match(new RegExp(NO_HOOK, 'g')), output).toHaveLength(1)
        },
        CHILD_TIMEOUT,
    )

    it(
        'without isolation: a skipped file runs no afterAll, so the next file removes its directories when it registers, even when that file is skipped too and only its own are left',
        async () => {
            const skipped = (name: string) =>
                `import { it } from 'vitest'\nimport { makeTestTmpDir, registerTestTmpDirCleanup } from ${HELPER}\n` +
                `registerTestTmpDirCleanup()\nmakeTestTmpDir('probe-${name}-')\nit.skip('${name}', () => {})\n`
            const probe = project(
                {
                    'a.test.ts': counted(withDir('probe-a-'), 6000),
                    'b.test.ts': counted(skipped('b'), 4000),
                    'c.test.ts': skipped('c'),
                },
                NO_ISOLATION,
            )
            const { left, output } = await runInOrder(probe)
            expect(left.length, output).toBeGreaterThan(0)
            expect(
                left.filter((entry) => !entry.startsWith('probe-c-')),
                output,
            ).toEqual([])
        },
        CHILD_TIMEOUT,
    )

    it(
        'with isolation: a directory made in a beforeAll is removed after the file’s own afterAll, with no warning',
        async () => {
            const probe = project(
                {
                    'a.test.ts': counted(withDir('probe-a-'), 6000),
                    'b.test.ts': counted(withDir('probe-b-'), 4000),
                    'c.test.ts': withDir('probe-c-'),
                },
                { maxWorkers: 1, fileParallelism: false },
            )
            const { left, output } = await runInOrder(probe)
            expect(left, output).toEqual([])
            expect(output).not.toMatch(NO_HOOK)
        },
        CHILD_TIMEOUT,
    )

    it(
        'removeTestTmpDir removes a directory and its marker at once, and leaves a path it did not make alone',
        async () => {
            const probe = project(
                `import { existsSync, mkdtempSync, rmSync } from 'node:fs'\nimport { tmpdir } from 'node:os'\n` +
                    `import path from 'node:path'\nimport { expect, it } from 'vitest'\n` +
                    `import { makeTestTmpDir, removeTestTmpDir } from ${HELPER}\n` +
                    `it('removes its own now', () => {\n` +
                    `    const dir = makeTestTmpDir('probe-now-')\n` +
                    `    removeTestTmpDir(dir)\n` +
                    `    expect(existsSync(dir)).toBe(false)\n` +
                    `    expect(existsSync(dir + '.sssb-test-tmp')).toBe(false)\n` +
                    `})\n` +
                    `it('leaves a directory it did not make', () => {\n` +
                    `    const other = mkdtempSync(path.join(tmpdir(), 'not-mine-'))\n` +
                    `    removeTestTmpDir(other)\n` +
                    `    expect(existsSync(other)).toBe(true)\n` +
                    `    rmSync(other, { recursive: true })\n` +
                    `})\n`,
            )
            const { status, output } = await run(probe)
            expect(status, output).toBe(0)
            expect(anyLeftovers(probe), output).toEqual([])
        },
        CHILD_TIMEOUT,
    )
})

describe('the demo-presets replay, in a real run', () => {
    it(
        "stays in its scratch dir under every option that undoes stubs, and never touches the working directory's .data",
        async () => {
            const probe = project(ONLY_DEMO_PRESETS, {
                unstubEnvs: true,
                unstubGlobals: true,
                restoreMocks: true,
                mockReset: true,
                clearMocks: true,
            })
            const { status, output } = await run(probe, ['--reporter=verbose'])
            expect(status, output).toBe(0)
            expect(output).toMatch(/replay on the server host/)
            expect(readdirSync(probe.data)).toEqual(['sentinel'])
            expect(leftovers(probe), output).toEqual([])
        },
        CHILD_TIMEOUT,
    )

    /**
     * A test timing out does not stop its body: the replay runs on after its test has failed, through the file's
     * teardown, for as long as the worker lives. The probe shortens that one test's timeout (through the check's own
     * `timeouts`, which the suite reads when it registers the test) and parks the first preset's first operation
     * (an invite, which writes a file under the data root) for `parkMs`, so the timeout fires while the replay is
     * inside it, and a second file keeps the worker alive afterwards (one worker, no isolation, the probe file first:
     * Vitest runs the larger file first).
     */
    const timedOutReplay = (parkMs: number, stopWaitMs?: number) =>
        `import { demoPresets } from ${kit('testing/conformance/demo-presets.ts')}\n` +
        `import { fakeAuth } from ${kit('adapters/fake/auth.ts')}\n` +
        `const replay = Object.keys(demoPresets.timeouts)[0]\n` +
        `demoPresets.timeouts[replay] = 300\n` +
        (stopWaitMs === undefined ? '' : `demoPresets.replayStopWaitMs = ${stopWaitMs}\n`) +
        `const createInvite = fakeAuth.createInvite\n` +
        `fakeAuth.createInvite = async (...args) => {\n` +
        `    await new Promise((done) => setTimeout(done, ${parkMs}))\n` +
        `    return createInvite.apply(fakeAuth, args)\n` +
        `}\n${ONLY_DEMO_PRESETS}\n//${'x'.repeat(4000)}\n`
    const KEEP_WORKER_ALIVE = `import { it } from 'vitest'
it('keeps the worker alive while a replay could still be running', () => new Promise((done) => setTimeout(done, 6000)), 20000)
`
    const ONE_WORKER = { isolate: false, maxWorkers: 1, fileParallelism: false }

    it(
        "when its test times out mid-replay: tears down only after the replay stops, so the working directory's .data stays untouched",
        async () => {
            const probe = project({ 'a.test.ts': timedOutReplay(1500), 'b.test.ts': KEEP_WORKER_ALIVE }, ONE_WORKER)
            const { status, output } = await run(probe, ['--reporter=verbose', '--sequence.shuffle=false'])
            expect(status, output).not.toBe(0)
            expect(output).toMatch(/replay on the server host.*\n.*timed out in 300ms/)
            expect(output).toMatch(/✓ b\.test\.ts > keeps the worker alive/)
            expect(readdirSync(probe.data), output).toEqual(['sentinel'])
            expect(leftovers(probe), output).toEqual([])
        },
        CHILD_TIMEOUT,
    )

    it(
        'when the replay outlasts the wait too: fails the teardown, keeps the replay in its scratch dir, and removes it once the replay stops',
        async () => {
            const probe = project(
                { 'a.test.ts': timedOutReplay(2500, 500), 'b.test.ts': KEEP_WORKER_ALIVE },
                ONE_WORKER,
            )
            const { status, output } = await run(probe, ['--reporter=verbose', '--sequence.shuffle=false'])
            expect(status, output).not.toBe(0)
            expect(output).toMatch(/demo-presets: the replay was still running 0\.5 s after its test ended/)
            expect(output).toMatch(/✓ b\.test\.ts > keeps the worker alive/)
            expect(readdirSync(probe.data), output).toEqual(['sentinel'])
            expect(leftovers(probe), output).toEqual([])
        },
        CHILD_TIMEOUT,
    )

    it(
        'fails, touching nothing, when something else takes APP_DATA_DIR away from it between tests',
        async () => {
            const probe = project(
                `${ONLY_DEMO_PRESETS}\nimport { beforeEach } from 'vitest'\nbeforeEach(() => { delete process.env.APP_DATA_DIR })\n`,
            )
            const { status, output } = await run(probe)
            expect(status, output).not.toBe(0)
            expect(output).toMatch(/demo-presets: the fake adapters' data dir is .*\.data, not the check's scratch dir/)
            expect(readdirSync(probe.data)).toEqual(['sentinel'])
            expect(leftovers(probe), output).toEqual([])
        },
        CHILD_TIMEOUT,
    )

    it(
        'fails, naming the causes that can undo it, when its registry mock is undone between tests',
        async () => {
            const probe = project(
                `${ONLY_DEMO_PRESETS}\nimport { beforeEach, vi } from 'vitest'\n` +
                    `beforeEach(() => { vi.doUnmock(${kit('adapters/index.ts')}) })\n`,
            )
            const { status, output } = await run(probe)
            expect(status, output).not.toBe(0)
            expect(output).toMatch(/the adapter registry is not the conformance suite's mock/)
            expect(output).toMatch(/vi\.doUnmock/)
            expect(output).toMatch(/at the same moment/)
            expect(readdirSync(probe.data)).toEqual(['sentinel'])
            expect(leftovers(probe), output).toEqual([])
        },
        CHILD_TIMEOUT,
    )
})
