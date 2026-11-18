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

/** A scratch project: `probe.test.ts` (the given source) under a Vitest config with the given `test` options. */
function project(source: string, testOptions: Record<string, unknown> = {}): Project {
    const dir = makeTestTmpDir('conformance-adopter-')
    const tmp = path.join(dir, 'tmp')
    const data = path.join(dir, '.data')
    mkdirSync(tmp)
    mkdirSync(data)
    writeFileSync(path.join(data, 'sentinel'), 'the developer world')
    const config = {
        resolve: { alias: { '@sssb/app-config': FIXTURE_SEAM } },
        test: { include: ['probe.test.ts'], environment: 'node', testTimeout: 60_000, ...testOptions },
    }
    writeFileSync(path.join(dir, 'vitest.config.mjs'), `export default ${JSON.stringify(config)}\n`)
    writeFileSync(path.join(dir, 'probe.test.ts'), source)
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
conformanceSuite({ appDir: ${JSON.stringify(path.resolve(FIXTURE_SEAM, '..'))}, optOut })
`

/**
 * The contract runner's shape without Postgres: a "server" started in a file-level beforeAll and stopped in a
 * file-level afterAll registered before the checks, as `contractSuite` does, around the contract checks with no-op
 * bodies. PROBE_FAIL makes the beforeAll throw after the server started.
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
const implementations = Object.fromEntries(
    registry.checks
        .filter((check) => check.runner === 'contract')
        .map((check) => [check.id, { tests: Object.fromEntries(check.tests.map((test) => [test, () => {}])) }]),
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
})
