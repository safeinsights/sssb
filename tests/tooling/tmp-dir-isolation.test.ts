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
 * gone.
 *
 * Without isolation the helper's module loads once per worker, in its first file. It registered one cleanup hook then,
 * so only the first file's directories were removed (`sssb check-tmpdir-leak` then fails every later file); it now
 * registers a hook for each later file whose first call comes while the file is collected.
 */
const HELPER = JSON.stringify(path.resolve(import.meta.dirname, '../../packages/tools/src/testing/tmp-dir.js'))
const VITEST = path.join(path.dirname(createRequire(import.meta.url).resolve('vitest/package.json')), 'vitest.mjs')
const CHILD_TIMEOUT = 120_000

const NO_ISOLATION = { isolate: false, maxWorkers: 1, fileParallelism: false }

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

/**
 * A test file that makes its directory where `call` says, and checks it exists from a test. Vitest runs larger files
 * first in one worker, so the padding sets the order.
 */
function file(name: string, call: 'top' | 'top-async' | 'describe' | 'beforeAll', padding: number): string {
    const make = `makeTestTmpDir('probe-${name}-')`
    const body = {
        top: `const dir = ${make}\nit('${name}', () => expect(existsSync(dir)).toBe(true))\n`,
        'top-async': `const dir = await makeTestTmpDirAsync('probe-${name}-')\nit('${name}', () => expect(existsSync(dir)).toBe(true))\n`,
        describe: `describe('${name}', () => {\n    const dir = ${make}\n    it('made', () => expect(existsSync(dir)).toBe(true))\n})\n`,
        beforeAll: `let dir = ''\nbeforeAll(() => { dir = ${make} })\nit('${name}', () => expect(existsSync(dir)).toBe(true))\n`,
    }[call]
    return (
        `import { existsSync } from 'node:fs'\nimport { beforeAll, describe, expect, it } from 'vitest'\n` +
        `import { makeTestTmpDir, makeTestTmpDirAsync } from ${HELPER}\n${body}//${'x'.repeat(padding)}\n`
    )
}

describe("@sssb/tools' scratch directories, in a real run", () => {
    // Each case ends on the kind of call it pins: a later file's hook removes everything still queued, so a missing
    // registration in an earlier file is swept up by the next one and only the LAST file's shows.
    it.each([
        ['makeTestTmpDir, at top level and in a describe body', 'describe'],
        ['makeTestTmpDirAsync, at top level', 'top-async'],
    ] as const)(
        "without isolation: every file's directories are removed, not only the first file's (%s)",
        async (_, last) => {
            const probe = project(
                {
                    'a.test.ts': file('a', 'top', 3000),
                    'b.test.ts': file('b', 'top', 2000),
                    'c.test.ts': file('c', last, 1000),
                },
                NO_ISOLATION,
            )
            const { status, output } = await run(probe)
            expect(status, output).toBe(0)
            expect(output).toMatch(/✓ c\.test\.ts > c/)
            expect(readdirSync(probe.tmp), output).toEqual([])
        },
        CHILD_TIMEOUT,
    )

    it(
        'with isolation (the default): a directory made in a beforeAll is removed too, which is why the hook is registered at load',
        async () => {
            const probe = project(
                { 'a.test.ts': file('a', 'beforeAll', 2000), 'b.test.ts': file('b', 'top', 1000) },
                {},
            )
            const { status, output } = await run(probe)
            expect(status, output).toBe(0)
            expect(readdirSync(probe.tmp), output).toEqual([])
        },
        CHILD_TIMEOUT,
    )

    it(
        'removeTestTmpDir removes a directory and its marker at once, and the file-end cleanup does not trip on it',
        async () => {
            const probe = project(
                {
                    'a.test.ts':
                        `import { existsSync } from 'node:fs'\nimport { expect, it } from 'vitest'\n` +
                        `import { makeTestTmpDir, removeTestTmpDir } from ${HELPER}\n` +
                        `it('removes it now', () => {\n` +
                        `    const dir = makeTestTmpDir('probe-now-')\n` +
                        `    removeTestTmpDir(dir)\n` +
                        `    expect(existsSync(dir)).toBe(false)\n` +
                        `    expect(existsSync(dir + '.sssb-test-tmp')).toBe(false)\n` +
                        `})\n`,
                },
                {},
            )
            const { status, output } = await run(probe)
            expect(status, output).toBe(0)
            expect(readdirSync(probe.tmp), output).toEqual([])
        },
        CHILD_TIMEOUT,
    )
})
