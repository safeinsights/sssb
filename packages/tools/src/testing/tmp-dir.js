// @ts-check
// THE ONLY WAY A TEST MAKES A SCRATCH DIRECTORY. A raw `mkdtemp` in a test file leaves the directory behind on every
// run; left long enough that has filled a developer's temp filesystem past 100GB. SSSB's lint rule
// `sssb/no-direct-mkdtemp` bans the raw call in test files, and `sssb check-tmpdir-leak` fails the run if a
// directory made here was not removed. Any workspace package may import this: it touches no framework code, so a
// package that does not use @sssb/kit (a CLI, a CloudFront function) uses it too (ADR-0014 part 3).
//
// Each call creates `<tmpdir>/<prefix>XXXXXX`, writes an EMPTY MARKER FILE beside it (`<dir>` + TMP_DIR_MARKER_SUFFIX)
// and queues both for removal when the test file finishes. The marker is a SIBLING, never inside the directory: some
// tests assert the exact contents of their directory, and a marker inside would be a fixture they have to know about.
// The marker is deleted only after its directory is, so a directory that cannot be removed keeps its marker and the
// leak wrapper still sees it.
//
// WHY THE HOOK IS REGISTERED AT MODULE TOP LEVEL, not lazily from the functions: Vitest silently drops a hook
// registered at run time from inside another hook, so a helper that registered its own `afterAll` on first call
// would leak exactly when called from a `beforeAll`, with no error and no cleanup. Registering nothing in the
// functions makes them callable from module scope, `beforeAll`, `beforeEach` or a test body alike. Vitest isolates
// each test file by default, so this module, and the one hook, exists once per file.
//
// ORDERING: `afterAll` hooks run in reverse registration order. Import this module before anything else that
// registers hooks and its cleanup runs AFTER a file's own `afterAll`, so a file that closes a database handle living
// in the directory closes it before the directory is deleted.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll } from 'vitest'
import { TMP_DIR_MARKER_SUFFIX } from './tmp-dir-marker.js'

/** @type {string[]} */
const created = []

afterAll(() => {
    for (const dir of created.splice(0)) {
        try {
            rmSync(dir, { recursive: true, force: true })
            rmSync(dir + TMP_DIR_MARKER_SUFFIX, { force: true })
        } catch (error) {
            console.error(`tmp-dir: could not remove ${dir}`, error)
        }
    }
})

/** @type {import('./tmp-dir.d.ts').makeTestTmpDir} */
export function makeTestTmpDir(prefix) {
    const dir = mkdtempSync(path.join(tmpdir(), prefix))
    created.push(dir)
    writeFileSync(dir + TMP_DIR_MARKER_SUFFIX, '')
    return dir
}

/** @type {import('./tmp-dir.d.ts').makeTestTmpDirAsync} */
export async function makeTestTmpDirAsync(prefix) {
    const dir = await mkdtemp(path.join(tmpdir(), prefix))
    created.push(dir)
    await writeFile(dir + TMP_DIR_MARKER_SUFFIX, '')
    return dir
}
