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
// functions makes them callable from module scope, `beforeAll`, `beforeEach` or a test body alike, in the file that
// loaded this module: with isolation (Vitest's default), every file.
//
// WITHOUT ISOLATION (`isolate: false`, which an adopter's Vitest config may set) this module loads once per worker, in
// its first file, so that load-time hook is the first file's alone. A call from a later file (Vitest's
// `expect.getState().testPath` names it) therefore registers that file's own hook, which works when the call comes
// while the file is collected (its top level or a `describe` body; tests/tooling/tmp-dir-isolation.test.ts pins it).
// Each hook removes every directory still queued: a worker runs its files one after another, so any left from an
// earlier file are that file's. A later file whose first call comes from a hook or a test cannot register one (Vitest
// drops it), so its directories wait for the next file's hook, and the last file's for none; a helper that must clean up
// after itself removes its own with `removeTestTmpDir`. The kit's copy (packages/kit/src/testing/tmp-dir.ts) does the
// same.
//
// ORDERING: `afterAll` hooks run in reverse registration order. Import this module before anything else that
// registers hooks and its cleanup runs AFTER a file's own `afterAll`, so a file that closes a database handle living
// in the directory closes it before the directory is deleted.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, expect } from 'vitest'
import { TMP_DIR_MARKER_SUFFIX } from './tmp-dir-marker.js'

/** @type {string[]} */
const created = []

/** The test files a cleanup hook is registered in, by path ('' when Vitest names none). @type {Set<string>} */
const hooked = new Set()

const currentFile = () => expect.getState().testPath ?? ''

/** @param {string} dir */
function remove(dir) {
    try {
        rmSync(dir, { recursive: true, force: true })
        rmSync(dir + TMP_DIR_MARKER_SUFFIX, { force: true })
    } catch (error) {
        console.error(`tmp-dir: could not remove ${dir}`, error)
    }
}

function registerCleanup() {
    hooked.add(currentFile())
    afterAll(() => {
        for (const dir of created.splice(0)) remove(dir)
    })
}

registerCleanup()

/** @type {import('./tmp-dir.d.ts').makeTestTmpDir} */
export function makeTestTmpDir(prefix) {
    if (!hooked.has(currentFile())) registerCleanup()
    const dir = mkdtempSync(path.join(tmpdir(), prefix))
    created.push(dir)
    writeFileSync(dir + TMP_DIR_MARKER_SUFFIX, '')
    return dir
}

/** @type {import('./tmp-dir.d.ts').makeTestTmpDirAsync} */
export async function makeTestTmpDirAsync(prefix) {
    // Before the first `await`: a hook can be registered only while the file is still being collected.
    if (!hooked.has(currentFile())) registerCleanup()
    const dir = await mkdtemp(path.join(tmpdir(), prefix))
    created.push(dir)
    await writeFile(dir + TMP_DIR_MARKER_SUFFIX, '')
    return dir
}

/** @type {import('./tmp-dir.d.ts').removeTestTmpDir} */
export function removeTestTmpDir(dir) {
    const index = created.indexOf(dir)
    if (index >= 0) created.splice(index, 1)
    remove(dir)
}
