import { spawn } from 'node:child_process'
import { mkdirSync, readdirSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { makeTestTmpDir } from '../support/tmp-dir'

/**
 * @sssb/tools' scratch-directory helper under an ADOPTER'S Vitest, which this repository's own config (isolated files)
 * cannot show: each case writes a scratch project with its own Vitest config and TMPDIR, runs a real `vitest run` in a
 * child process, and reads what the run left in that TMPDIR. Every directory the helper made, and its marker, must be
 * gone, and every test in the child must pass (each checks that its own directory still exists when it runs).
 *
 * Without isolation the helper's module loads once per worker, in its first file, so a hook it registers at load is
 * the first file's alone. The setup module (`@sssb/tools/testing/tmp-dir-setup`) registers one per file; without it,
 * the helper registers one per suite on that suite's first call.
 */
const TESTING = path.resolve(import.meta.dirname, '../../packages/tools/src/testing')
const HELPER = JSON.stringify(path.join(TESTING, 'tmp-dir.js'))
const SETUP = path.join(TESTING, 'tmp-dir-setup.js')
const VITEST = path.join(path.dirname(createRequire(import.meta.url).resolve('vitest/package.json')), 'vitest.mjs')
const CHILD_TIMEOUT = 120_000

const NO_ISOLATION = { isolate: false, maxWorkers: 1, fileParallelism: false }
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

/** Where a test file makes its directory. Each test asserts the directory still exists when it runs. */
type Call =
    | 'top'
    | 'top-async'
    | 'describe'
    | 'describe-async-then'
    | 'two-describes'
    | 'beforeAll'
    | 'in-test'
    | 'afterAll-before-call'

const BODIES: Record<Call, (make: string, makeAsync: string) => string> = {
    top: (make) => `const dir = ${make}\nit('made', () => expect(existsSync(dir)).toBe(true))\n`,
    'top-async': (_, makeAsync) =>
        `const dir = await ${makeAsync}\nit('made', () => expect(existsSync(dir)).toBe(true))\n`,
    describe: (make) =>
        `describe('d', () => {\n    const dir = ${make}\n    it('made', () => expect(existsSync(dir)).toBe(true))\n})\n`,
    // The call's continuation runs after the describe body has returned: the hook must belong to the suite current AT
    // the call.
    'describe-async-then': (_, makeAsync) =>
        `describe('d', () => {\n    let dir = ''\n    const made = ${makeAsync}.then((d) => (dir = d))\n` +
        `    it('made', async () => { await made; expect(existsSync(dir)).toBe(true) })\n})\n`,
    // The second describe's tests run after the first describe has finished: its directory must still be there.
    'two-describes': (make) =>
        `describe('first', () => {\n    const dir = ${make}\n    it('made', () => expect(existsSync(dir)).toBe(true))\n})\n` +
        `describe('second', () => {\n    const dir = ${make}\n    it('still there', () => expect(existsSync(dir)).toBe(true))\n})\n`,
    beforeAll: (make) =>
        `let dir = ''\nbeforeAll(() => { dir = ${make} })\nit('made', () => expect(existsSync(dir)).toBe(true))\n`,
    'in-test': (make) => `it('made', () => {\n    const dir = ${make}\n    expect(existsSync(dir)).toBe(true)\n})\n`,
    // The file's own afterAll, registered BEFORE its first call, still finds the directory: the cleanup runs after it.
    'afterAll-before-call': (make) =>
        `let dir = ''\nafterAll(() => writeFileSync(path.join(dir, 'flushed'), 'closed before the directory went'))\n` +
        `dir = ${make}\nit('made', () => expect(existsSync(dir)).toBe(true))\n`,
}

/**
 * A test file named `name` that makes its directory as `call` says. Vitest runs larger files first in one worker, so
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

/** Two files that make a directory at top level, then the case's file last. */
const afterTwo = (last: Call) => ({
    'a.test.ts': file('a', 'top', 3000),
    'b.test.ts': file('b', 'top', 2000),
    'c.test.ts': file('c', last, 1000),
})

async function expectCleanRun(probe: { dir: string; tmp: string }) {
    const { status, output } = await run(probe)
    expect(status, output).toBe(0)
    expect(output).toMatch(/✓ c\.test\.ts/)
    expect(readdirSync(probe.tmp), output).toEqual([])
}

describe("@sssb/tools' scratch directories, in a real run", () => {
    // A later file's hook removes every earlier file's directories, so a missing registration in an earlier file is
    // swept up by the next one: each case puts what it pins in the LAST file, where nothing comes after.
    describe('without isolation, and without the setup module', () => {
        it.each<[string, Call]>([
            ['a call in a describe body', 'describe'],
            ['makeTestTmpDirAsync at top level', 'top-async'],
            [
                'makeTestTmpDirAsync in a describe body, its directory used after the body returned',
                'describe-async-then',
            ],
            ["two describes: the first one's cleanup leaves the second's directory alone", 'two-describes'],
        ])(
            "every file's directories are removed, not only the first file's: %s",
            async (_, last) => {
                await expectCleanRun(project(afterTwo(last), NO_ISOLATION))
            },
            CHILD_TIMEOUT,
        )

        it(
            "a file whose first call is in a test gets no hook (Vitest drops it), and the next file's top level still gets one, which removes both",
            async () => {
                // Every file's top level is the same suite object in one worker, so the hook registry is keyed by file too.
                const files = {
                    'a.test.ts': file('a', 'top', 3000),
                    'b.test.ts': file('b', 'in-test', 2000),
                    'c.test.ts': file('c', 'top', 1000),
                }
                await expectCleanRun(project(files, NO_ISOLATION))
            },
            CHILD_TIMEOUT,
        )
    })

    describe('without isolation, with the setup module', () => {
        it.each<[string, Call]>([
            ['a first call from a beforeAll', 'beforeAll'],
            [
                "the file's own afterAll, registered before the first call, runs before the cleanup",
                'afterAll-before-call',
            ],
            ["two describes: the first one's cleanup leaves the second's directory alone", 'two-describes'],
        ])(
            "every file's directories are removed: %s",
            async (_, last) => {
                await expectCleanRun(project(afterTwo(last), { ...NO_ISOLATION, ...WITH_SETUP }))
            },
            CHILD_TIMEOUT,
        )
    })

    it(
        'with isolation (the default): a directory made in a beforeAll is removed too, which is why the hook is registered at load',
        async () => {
            await expectCleanRun(
                project({ 'b.test.ts': file('b', 'top', 2000), 'c.test.ts': file('c', 'beforeAll', 1000) }, {}),
            )
        },
        CHILD_TIMEOUT,
    )

    it(
        'removeTestTmpDir removes a directory and its marker at once, and leaves a path it did not make alone',
        async () => {
            const probe = project(
                {
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
                        `})\n`,
                },
                {},
            )
            await expectCleanRun(probe)
        },
        CHILD_TIMEOUT,
    )
})
