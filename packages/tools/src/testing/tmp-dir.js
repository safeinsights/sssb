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
// THE FILE'S CLEANUP HOOK is one `afterAll` at the file's top level, which removes every directory still queued: a
// worker runs its files one after another, so anything queued is this file's or an earlier one's. It must exist before
// the functions are called, because Vitest silently drops a hook registered at run time from inside another hook, so
// a helper that registered its own `afterAll` on first call would leak exactly when called from a `beforeAll`. Two
// things register it:
//
//   * loading this module, which with isolation (Vitest's default) happens in every file;
//   * the setup module `@sssb/tools/testing/tmp-dir-setup` (./tmp-dir-setup.js), which Vitest runs before every file
//     even WITHOUT isolation (`isolate: false`), where this module loads once per worker and its load-time hook is the
//     first file's alone. SSSB's Vitest preset (`@sssb/tools/vitest`) adds it to every app project.
//
// ORDERING: `afterAll` hooks run in reverse registration order, so a hook registered first runs last. The setup module
// runs before the test file, and an import of this module is hoisted above the file's own code, so the cleanup runs
// AFTER a file's own `afterAll`: a file that closes a database handle living in the directory closes it before the
// directory is deleted.
//
// WITHOUT ISOLATION AND WITHOUT THE SETUP MODULE, a later file has no file-level hook, and no hook registered later
// can be both last in the order and wide enough in scope: one registered from a `describe` belongs to that
// `describe`, which may finish while another part of the file still uses a directory. So such a file never removes
// its own directories. Its first call registers a hook that removes those of EARLIER files, which have finished (a
// worker runs its files one after another): each file's directories go when the next file with a hook finishes, and the
// worker's last file's are left, for `sssb check-tmpdir-leak` to report. The first such call says so once per worker, naming the
// setup module. `removeTestTmpDir` removes one now. tests/tooling/tmp-dir-isolation.test.ts runs each case in a real
// Vitest.
//
// LIMITS, both Vitest's: a file whose tests are all skipped (`it.skip`, a `-t` filter) runs no `afterAll`, so its
// directories are left until the next file in the worker registers, and with isolation, where nothing carries to the
// next file, for good. And the order above holds for `sequence.hooks: 'stack'`, Vitest's default; under `'list'` or
// `'parallel'` the cleanup can run before the file's own `afterAll`.
//
// The kit keeps its own copy (packages/kit/src/testing/tmp-dir.ts), because the framework depends on no other SSSB
// package; both write the same marker, which tests/tooling/tmp-dir.test.ts holds equal.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, expect } from 'vitest'
import { TMP_DIR_MARKER_SUFFIX } from './tmp-dir-marker.js'

/** Every directory made and not yet removed, with the test file it was made in. @type {{ dir: string, file: string }[]} */
const created = []

/** Test files with a file-level hook, by path ('' when Vitest names none). @type {Set<string>} */
const hookedFiles = new Set()

/** Test files without one that have a hook removing EARLIER files' directories. @type {Set<string>} */
const sweepingFiles = new Set()

let warned = false

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

/** @param {(entry: (typeof created)[number]) => boolean} which */
function removeQueued(which) {
    for (let i = created.length - 1; i >= 0; i--) {
        const entry = created[i]
        if (entry && which(entry)) {
            created.splice(i, 1)
            remove(entry.dir)
        }
    }
}

/**
 * A file's first registration: whatever is still queued or registered for another file is an earlier file's, which has
 * finished (a worker runs its files one after another). Its directories go now, which also covers a file whose tests
 * were all skipped, since Vitest runs no `afterAll` for a skipped suite; and its registry entries go, so a watch-mode
 * rerun of that file registers again.
 *
 * @param {string} file
 */
function startFile(file) {
    removeQueued((entry) => entry.file !== file)
    for (const other of [...hookedFiles, ...sweepingFiles]) {
        if (other !== file) {
            hookedFiles.delete(other)
            sweepingFiles.delete(other)
        }
    }
}

/** @type {import('./tmp-dir.d.ts').registerTestTmpDirCleanup} */
export function registerTestTmpDirCleanup() {
    const file = currentFile()
    if (hookedFiles.has(file)) return
    startFile(file)
    hookedFiles.add(file)
    afterAll(() => {
        // A watch-mode rerun of this file, in this worker, registers again.
        hookedFiles.delete(file)
        removeQueued(() => true)
    })
}

registerTestTmpDirCleanup()

/**
 * The file the next directory belongs to. In a file without a file-level hook, also registers that file's hook for
 * earlier files' directories, on its first call. Synchronous, so the async variant calls it before its first `await`,
 * while the file may still be collected.
 */
function claim() {
    const file = currentFile()
    if (hookedFiles.has(file)) return file
    if (!warned) {
        warned = true
        console.error(
            `tmp-dir: ${file || 'a test file'} has no cleanup hook of its own: with Vitest's isolate: false, add ` +
                "'@sssb/tools/testing/tmp-dir-setup' to test.setupFiles (SSSB's appTestProject does). Without it each " +
                "file's scratch directories are removed only after the next file, and the last file's are left behind.",
        )
    }
    if (!sweepingFiles.has(file)) {
        startFile(file)
        sweepingFiles.add(file)
        afterAll(() => {
            // A watch-mode rerun of this file, in this worker, registers again.
            sweepingFiles.delete(file)
            removeQueued((entry) => entry.file !== file)
        })
    }
    return file
}

/** @type {import('./tmp-dir.d.ts').makeTestTmpDir} */
export function makeTestTmpDir(prefix) {
    const file = claim()
    const dir = mkdtempSync(path.join(tmpdir(), prefix))
    created.push({ dir, file })
    writeFileSync(dir + TMP_DIR_MARKER_SUFFIX, '')
    return dir
}

/** @type {import('./tmp-dir.d.ts').makeTestTmpDirAsync} */
export async function makeTestTmpDirAsync(prefix) {
    // Before the `await`: a hook can be registered only while the file is collected.
    const file = claim()
    const dir = await mkdtemp(path.join(tmpdir(), prefix))
    created.push({ dir, file })
    await writeFile(dir + TMP_DIR_MARKER_SUFFIX, '')
    return dir
}

/** @type {import('./tmp-dir.d.ts').removeTestTmpDir} */
export function removeTestTmpDir(dir) {
    const index = created.findIndex((entry) => entry.dir === dir)
    // Only a directory this module made and has not removed yet: anything else is not a scratch directory.
    if (index < 0) return
    created.splice(index, 1)
    remove(dir)
}
