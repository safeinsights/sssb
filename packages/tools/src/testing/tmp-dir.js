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
// WITHOUT ISOLATION AND WITHOUT THE SETUP MODULE, a later file has no file-level hook. Its first call in each suite
// (the file's top level, or a `describe` body, while the file is collected) registers a hook in that suite, which
// removes that suite's directories and any an earlier file left, and never another suite's of the same file, which may
// still be in use. Two things are lost that the setup module keeps: a hook registered after the file's own `afterAll`
// runs before it, and a later file whose first call comes from a hook or a test cannot register one (Vitest drops it),
// so its directories wait for the next file's hook, and the last file's for none. `removeTestTmpDir` removes one now.
// tests/tooling/tmp-dir-isolation.test.ts runs each case in a real Vitest.
//
// The kit keeps its own copy (packages/kit/src/testing/tmp-dir.ts), because the framework depends on no other SSSB
// package; both write the same marker, which tests/tooling/tmp-dir.test.ts holds equal.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, expect } from 'vitest'
import { getCurrentSuite } from 'vitest/suite'
import { TMP_DIR_MARKER_SUFFIX } from './tmp-dir-marker.js'

/**
 * Every directory made and not yet removed: the test file it was made in, and the suite whose hook owns it (null when
 * the file has a file-level hook, which removes it with everything else).
 *
 * @type {{ dir: string, file: string, suite: unknown }[]}
 */
const created = []

/** Test files with a file-level hook, by path ('' when Vitest names none). @type {Set<string>} */
const hookedFiles = new Set()

/**
 * Suites given a hook of their own (no file-level hook in their file), with the files they were given one in: Vitest
 * reuses one top-level collector for every file a worker runs, so a suite alone does not name a file's top level.
 *
 * @type {WeakMap<object, Set<string>>}
 */
const hookedSuites = new WeakMap()

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

/** @type {import('./tmp-dir.d.ts').registerTestTmpDirCleanup} */
export function registerTestTmpDirCleanup() {
    const file = currentFile()
    if (hookedFiles.has(file)) return
    hookedFiles.add(file)
    afterAll(() => {
        // A watch-mode rerun of this file, in this worker, registers again.
        hookedFiles.delete(file)
        removeQueued(() => true)
    })
}

registerTestTmpDirCleanup()

/**
 * Whose hook will remove the next directory: its file's, or, in a file without one, its suite's, registering that hook
 * on the suite's first call. Synchronous, so the async variant calls it before its first `await`, while the suite that
 * made the call is still the current one.
 *
 * @returns {{ file: string, suite: unknown }}
 */
function owner() {
    const file = currentFile()
    if (hookedFiles.has(file)) return { file, suite: null }
    const suite = getCurrentSuite()
    if (!suite) return { file, suite }
    const files = hookedSuites.get(suite) ?? new Set()
    hookedSuites.set(suite, files)
    if (!files.has(file)) {
        files.add(file)
        afterAll(() => {
            // A watch-mode rerun of this file, in this worker, registers again.
            files.delete(file)
            removeQueued((entry) => entry.file !== file || entry.suite === suite)
        })
    }
    return { file, suite }
}

/** @type {import('./tmp-dir.d.ts').makeTestTmpDir} */
export function makeTestTmpDir(prefix) {
    const by = owner()
    const dir = mkdtempSync(path.join(tmpdir(), prefix))
    created.push({ dir, ...by })
    writeFileSync(dir + TMP_DIR_MARKER_SUFFIX, '')
    return dir
}

/** @type {import('./tmp-dir.d.ts').makeTestTmpDirAsync} */
export async function makeTestTmpDirAsync(prefix) {
    // The suite current at the call, not after the `await`: by then collection may have moved on.
    const by = owner()
    const dir = await mkdtemp(path.join(tmpdir(), prefix))
    created.push({ dir, ...by })
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
