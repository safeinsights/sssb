import { spawn } from 'node:child_process'
import { mkdirSync, readdirSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { appTestProject } from '@sssb/tools/vitest'
import { makeTestTmpDir } from '../support/tmp-dir'

/**
 * @sssb/tools' scratch-directory helper under an ADOPTER'S Vitest, which this repository's own config (isolated files)
 * cannot show: each case writes a scratch project with its own Vitest config and TMPDIR, runs a real `vitest run` in a
 * child process, and reads what the run left in that TMPDIR. Every test in the child must pass: each checks that its
 * own directory still exists when it runs, so a cleanup that runs too early fails it.
 *
 * Without isolation the helper's module loads once per worker, in its first file, so a hook it registers at load is
 * the first file's alone. The setup module (`@sssb/tools/testing/tmp-dir-setup`) registers one per file, and the run
 * ends clean. Without it a later file never removes its own directories, only earlier files', so every file's are
 * removed but each worker's last file's, and the helper says so.
 */
const TESTING = path.resolve(import.meta.dirname, '../../packages/tools/src/testing')
const HELPER = JSON.stringify(path.join(TESTING, 'tmp-dir.js'))
const SETUP = path.join(TESTING, 'tmp-dir-setup.js')
const VITEST = path.join(path.dirname(createRequire(import.meta.url).resolve('vitest/package.json')), 'vitest.mjs')
const CHILD_TIMEOUT = 120_000

/** One worker, one file at a time, so the files run in the order their sizes set (largest first). */
const ONE_WORKER = { maxWorkers: 1, fileParallelism: false }
const NO_ISOLATION = { ...ONE_WORKER, isolate: false }
const WITH_SETUP = { setupFiles: [SETUP] }

/** A scratch project holding the given test files under a Vitest config with the given `test` options. */
function project(files: Record<string, string>, testOptions: Record<string, unknown>): { dir: string; tmp: string } {
    const dir = makeTestTmpDir('tools-tmp-dir-isolation-')
    const tmp = path.join(dir, 'tmp')
    mkdirSync(tmp)
    const config = { test: { include: Object.keys(files), environment: 'node', ...testOptions } }
    writeFileSync(path.join(dir, 'vitest.config.mjs'), `export default ${JSON.stringify(config)}\n`)
    for (const [name, source] of Object.entries(files)) writeFileSync(path.join(dir, name), source)
    return { dir, tmp }
}

/** `vitest run` in the project, with its own TMPDIR and none of this run's Vitest state. */
function run({ dir, tmp }: { dir: string; tmp: string }): Promise<{ status: number | null; output: string }> {
    const env: NodeJS.ProcessEnv = { ...process.env, TMPDIR: tmp, NO_COLOR: '1' }
    for (const key of Object.keys(env)) if (key.startsWith('VITEST')) delete env[key]
    return new Promise((resolve, reject) => {
        const child = spawn(
            process.execPath,
            [VITEST, 'run', '--config', 'vitest.config.mjs', '--reporter=verbose', '--sequence.shuffle=false'],
            { cwd: dir, env },
        )
        let output = ''
        child.stdout.on('data', (chunk: Buffer) => (output += chunk.toString()))
        child.stderr.on('data', (chunk: Buffer) => (output += chunk.toString()))
        child.on('error', reject)
        child.on('close', (status) => resolve({ status, output }))
    })
}

/** Where a test file makes its directory. Each test asserts its directory still exists when it runs. */
type Call =
    | 'top'
    | 'top-async'
    | 'describe'
    | 'describe-async-then'
    | 'two-describes'
    | 'nested'
    | 'beforeAll'
    | 'all-skipped'
    | 'in-test'
    | 'afterAll-before-call'

const BODIES: Record<Call, (make: string, makeAsync: string) => string> = {
    top: (make) => `const dir = ${make}\nit('made', () => expect(existsSync(dir)).toBe(true))\n`,
    'top-async': (_, makeAsync) =>
        `const dir = await ${makeAsync}\nit('made', () => expect(existsSync(dir)).toBe(true))\n`,
    describe: (make) =>
        `describe('d', () => {\n    const dir = ${make}\n    it('made', () => expect(existsSync(dir)).toBe(true))\n})\n`,
    // The call's continuation runs after the describe body has returned.
    'describe-async-then': (_, makeAsync) =>
        `describe('d', () => {\n    let dir = ''\n    const made = ${makeAsync}.then((d) => (dir = d))\n` +
        `    it('made', async () => { await made; expect(existsSync(dir)).toBe(true) })\n})\n`,
    // The second describe's tests run after the first describe has finished: its directory must still be there.
    'two-describes': (make) =>
        `describe('first', () => {\n    const dir = ${make}\n    it('made', () => expect(existsSync(dir)).toBe(true))\n})\n` +
        `describe('second', () => {\n    const dir = ${make}\n    it('still there', () => expect(existsSync(dir)).toBe(true))\n})\n`,
    // A directory made in an inner describe, used by an outer test that runs after the inner describe has finished.
    nested: (make) =>
        `let shared = ''\ndescribe('outer', () => {\n    describe('inner', () => {\n        shared = ${make}\n` +
        `        it('inner', () => expect(existsSync(shared)).toBe(true))\n    })\n` +
        `    it('outer, after inner', () => expect(existsSync(shared)).toBe(true))\n` +
        `    it('made at run time', () => expect(existsSync(${make})).toBe(true))\n})\n`,
    beforeAll: (make) =>
        `let dir = ''\nbeforeAll(() => { dir = ${make} })\nit('made', () => expect(existsSync(dir)).toBe(true))\n`,
    // Vitest runs no afterAll for a file whose tests are all skipped.
    'all-skipped': (make) => `const dir = ${make}\nit.skip('skipped', () => expect(existsSync(dir)).toBe(true))\n`,
    'in-test': (make) => `it('made', () => {\n    const dir = ${make}\n    expect(existsSync(dir)).toBe(true)\n})\n`,
    // The file's own afterAll, registered BEFORE its first call, still finds the directory: the cleanup runs after it.
    'afterAll-before-call': (make) =>
        `let dir = ''\nafterAll(() => writeFileSync(path.join(dir, 'flushed'), 'closed before the directory went'))\n` +
        `dir = ${make}\nit('made', () => expect(existsSync(dir)).toBe(true))\n`,
}

/**
 * A test file named `name` that makes its directories as `call` says. Vitest runs larger files first in one worker, so
 * the padding sets the order.
 */
function file(name: string, call: Call, padding: number): string {
    return (
        `import { existsSync, writeFileSync } from 'node:fs'\nimport path from 'node:path'\n` +
        `import { afterAll, beforeAll, describe, expect, it } from 'vitest'\n` +
        `import { makeTestTmpDir, makeTestTmpDirAsync } from ${HELPER}\n` +
        BODIES[call](`makeTestTmpDir('probe-${name}-')`, `makeTestTmpDirAsync('probe-${name}-')`) +
        `//${'x'.repeat(padding)}\n`
    )
}

/** a and b make a directory at top level (b's as `middle` says), then c, the case's file, runs last. */
const three = (last: Call, middle: Call = 'top') => ({
    'a.test.ts': file('a', 'top', 3000),
    'b.test.ts': file('b', middle, 2000),
    'c.test.ts': file('c', last, 1000),
})

/** Runs the project and returns what is left in its TMPDIR, having checked every test passed and c ran last. */
async function runAll(probe: { dir: string; tmp: string }): Promise<{ left: string[]; output: string }> {
    const { status, output } = await run(probe)
    expect(status, output).toBe(0)
    const at = (name: string) => output.search(new RegExp(`[✓↓] ${name}\\.test\\.ts`))
    const ranLast = at('c')
    expect(ranLast, output).toBeGreaterThan(-1)
    for (const earlier of ['a', 'b']) {
        expect(at(earlier), output).toBeGreaterThan(-1)
        expect(at(earlier), output).toBeLessThan(ranLast)
    }
    return { left: readdirSync(probe.tmp), output }
}

describe("@sssb/tools' scratch directories, in a real run", () => {
    describe('without isolation, with the setup module: the run ends clean', () => {
        it.each<[string, Call, Call?]>([
            ['a first call from a beforeAll', 'beforeAll'],
            [
                "the file's own afterAll, registered before the first call, runs before the cleanup",
                'afterAll-before-call',
            ],
            ["two describes: the first one's end leaves the second's directory alone", 'two-describes'],
            ['a nested describe, its directory used by an outer test, and a call made at run time', 'nested'],
            [
                'makeTestTmpDirAsync in a describe body, its directory used after the body returned',
                'describe-async-then',
            ],
            ['a file before the last whose tests are all skipped, which runs no afterAll', 'top', 'all-skipped'],
        ])(
            '%s',
            async (_, last, middle) => {
                const { left, output } = await runAll(project(three(last, middle), { ...NO_ISOLATION, ...WITH_SETUP }))
                expect(left, output).toEqual([])
                expect(output).not.toMatch(/has no cleanup hook of its own/)
            },
            CHILD_TIMEOUT,
        )
    })

    it(
        'without isolation, with the setup module: a skipped file runs no afterAll, so the next file removes its directories when it starts, even when that file is skipped too and only its own are left',
        async () => {
            const { left, output } = await runAll(
                project(three('all-skipped', 'all-skipped'), { ...NO_ISOLATION, ...WITH_SETUP }),
            )
            expect(left.length, output).toBeGreaterThan(0)
            expect(
                left.filter((entry) => !entry.startsWith('probe-c-')),
                output,
            ).toEqual([])
        },
        CHILD_TIMEOUT,
    )

    // A later file never removes its own directories here, only earlier files'. Each case ends on the kind of call it
    // pins, in the LAST file: a missing hook there leaves b's directories behind, and one that removed too much would
    // fail a test that still uses its directory.
    describe('without isolation, without the setup module: nothing in use is removed, and only the last file is left', () => {
        it.each<[string, Call, Call?]>([
            ['a call in a describe body', 'describe'],
            ['makeTestTmpDirAsync at top level', 'top-async'],
            [
                'makeTestTmpDirAsync in a describe body, its directory used after the body returned',
                'describe-async-then',
            ],
            ["two describes: the first one's end leaves the second's directory alone", 'two-describes'],
            ['a nested describe, its directory used by an outer test', 'nested'],
            ['a file whose first call is in a test: the next file removes its directories', 'top', 'in-test'],
        ])(
            '%s',
            async (_, last, middle) => {
                const { left, output } = await runAll(project(three(last, middle), NO_ISOLATION))
                expect(left.length, output).toBeGreaterThan(0)
                expect(
                    left.filter((entry) => !entry.startsWith('probe-c-')),
                    output,
                ).toEqual([])
                // Once per worker, though b and c both lack a hook.
                expect(
                    output.match(/has no cleanup hook of its own: .*'@sssb\/tools\/testing\/tmp-dir-setup'/g),
                    output,
                ).toHaveLength(1)
            },
            CHILD_TIMEOUT,
        )
    })

    it(
        'with isolation (the default): a directory made in a beforeAll is removed too, which is why the hook is registered at load',
        async () => {
            const files = {
                'a.test.ts': file('a', 'top', 3000),
                'b.test.ts': file('b', 'top', 2000),
                'c.test.ts': file('c', 'beforeAll', 1000),
            }
            const { left, output } = await runAll(project(files, ONE_WORKER))
            expect(left, output).toEqual([])
            expect(output).not.toMatch(/has no cleanup hook of its own/)
        },
        CHILD_TIMEOUT,
    )

    it(
        'removeTestTmpDir removes a directory and its marker at once, and leaves a path it did not make alone',
        async () => {
            const probe = project(
                {
                    'a.test.ts': file('a', 'top', 3000),
                    'b.test.ts': file('b', 'top', 2000),
                    'c.test.ts':
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
                        `})\n//${'x'.repeat(1000)}\n`,
                },
                ONE_WORKER,
            )
            const { left, output } = await runAll(probe)
            expect(left, output).toEqual([])
        },
        CHILD_TIMEOUT,
    )
})

describe("SSSB's Vitest preset", () => {
    it('adds the setup module to every app project, before the app’s own setup files', async () => {
        const config = await appTestProject({
            appDir: path.resolve(import.meta.dirname, '../../apps/starter'),
            setupFiles: ['./own-setup.ts'],
        })
        expect(config.test?.setupFiles).toEqual([
            '@testing-library/jest-dom/vitest',
            '@sssb/tools/testing/tmp-dir-setup',
            './own-setup.ts',
        ])
    })
})
