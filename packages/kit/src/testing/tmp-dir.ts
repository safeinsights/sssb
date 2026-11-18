import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, expect } from 'vitest'
import { TMP_DIR_MARKER_SUFFIX } from './tmp-dir-marker.mjs'

/**
 * THE FRAMEWORK'S OWN COPY of the scratch-directory helper, for @sssb/kit's tests (the shipped conformance and contract
 * suites among them). Everyone else imports @sssb/tools' (`@sssb/tools/testing/tmp-dir`); the framework keeps a copy
 * because the framework depends on no other SSSB package (ADR-0014, rule 4). Both write the same marker, which
 * tests/tooling/tmp-dir.test.ts holds equal, so `sssb check-tmpdir-leak` sees either one's leaks. This one is not in
 * the package's `exports`: an adopter reaches it only through `conformanceSuite` and `contractSuite`.
 *
 * THE ONLY WAY A TEST MAKES A SCRATCH DIRECTORY. A raw `mkdtemp` in a test file leaves the directory
 * behind on every run; left in place long enough that has filled a developer's temp filesystem past
 * 100GB. `sssb/no-direct-mkdtemp` (@sssb/eslint-plugin) bans the raw call in test files, and
 * `sssb check-tmpdir-leak` fails the run if a directory made here was not removed.
 *
 * Each call creates `<tmpdir>/<prefix>XXXXXX`, writes an EMPTY MARKER FILE beside it
 * (`<dir>` + TMP_DIR_MARKER_SUFFIX) and queues both for removal when the test file finishes. The
 * marker is a SIBLING, never inside the directory: some tests assert the exact contents of their
 * directory (atomic-write.test.ts lists it), and a marker inside would be a fixture they have to know
 * about. The marker is deleted only after its directory is, so a directory that cannot be removed
 * keeps its marker and the leak guard still sees it.
 *
 * THE FILE'S CLEANUP HOOK is one `afterAll` at the file's top level, which removes every directory still queued: a
 * worker runs its files one after another, so anything queued is this file's or an earlier one's. It must exist before
 * the functions are called, because Vitest silently drops a hook registered at run time from inside another hook (the
 * suites make their directories in `beforeAll`). Two things register it:
 *
 *   * loading this module, which with isolation (Vitest's default, and this repository's) happens in every file;
 *   * `conformanceSuite` and `contractSuite`, which call `registerTestTmpDirCleanup()` first, from the top level of the
 *     app's file, where an app must call them. Without isolation (`isolate: false`, as an adopter's config may run
 *     them) this module loads once per worker and its load-time hook is the first file's alone, so this is what gives
 *     every later file its own.
 *
 * ORDERING: `afterAll` hooks run in reverse registration order, so a hook registered first runs last. Registered at
 * load or at the start of a suite, before the suite's own `afterAll` (the contract server's stop, the demo-presets
 * teardown), the cleanup runs after them: a database living in the directory is closed before the directory is
 * deleted.
 *
 * A LATER FILE WITH NO HOOK (without isolation, a file that uses this helper but registers no hook, which a suite
 * called at a file's top level never is) never removes its own directories: no hook registered at a call can be both
 * last in the order and wide enough in scope. Its first call registers a hook that removes EARLIER files' directories,
 * which have finished, so each worker's last such file's are left for `sssb check-tmpdir-leak` to report, and the
 * first such call says so once per worker. `@sssb/tools`' copy works the same way
 * (`.claude/future-tasks/resolved/tools-tmp-dir-without-isolation.md` says why).
 *
 * LIMITS, both Vitest's: a file whose tests are all skipped runs no `afterAll`, so its directories are left until the
 * next file in the worker registers, and with isolation for good. And the order above holds for
 * `sequence.hooks: 'stack'`, Vitest's default.
 *
 * packages/kit/src/testing/conformance/adopter-config.test.ts runs each case in a real Vitest.
 */

/** Every directory made and not yet removed, with the test file it was made in. */
const created: { dir: string; file: string }[] = []

/** Test files with a file-level hook, by path ('' when Vitest names none). */
const hookedFiles = new Set<string>()

/** Test files without one that have a hook removing EARLIER files' directories. */
const sweepingFiles = new Set<string>()

let warned = false

const currentFile = (): string => expect.getState().testPath ?? ''

function remove(dir: string): void {
    try {
        rmSync(dir, { recursive: true, force: true })
        rmSync(dir + TMP_DIR_MARKER_SUFFIX, { force: true })
    } catch (error) {
        console.error(`tmp-dir: could not remove ${dir}`, error)
    }
}

function removeQueued(which: (entry: { dir: string; file: string }) => boolean): void {
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
 */
function startFile(file: string): void {
    removeQueued((entry) => entry.file !== file)
    for (const other of [...hookedFiles, ...sweepingFiles]) {
        if (other !== file) {
            hookedFiles.delete(other)
            sweepingFiles.delete(other)
        }
    }
}

/**
 * Register the current test file's cleanup hook, if it has none. `conformanceSuite` and `contractSuite` call it first,
 * at the top level of the app's file; never from a hook or a test, where Vitest drops it.
 */
export function registerTestTmpDirCleanup(): void {
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
 * earlier files' directories, on its first call, and says once per worker that the file has none.
 */
function claim(): string {
    const file = currentFile()
    if (hookedFiles.has(file)) return file
    if (!warned) {
        warned = true
        console.error(
            `tmp-dir: ${file || 'a test file'} has no cleanup hook of its own: with Vitest's isolate: false, call ` +
                "conformanceSuite or contractSuite at the file's top level, which registers one. Without it each " +
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

/** Make a scratch directory that is removed when the test file finishes. Synchronous variant. */
export function makeTestTmpDir(prefix: string): string {
    const file = claim()
    const dir = mkdtempSync(path.join(tmpdir(), prefix))
    created.push({ dir, file })
    writeFileSync(dir + TMP_DIR_MARKER_SUFFIX, '')
    return dir
}

/**
 * Remove a directory `makeTestTmpDir` made, and its marker, now rather than when the file finishes. Does nothing for a
 * path it did not make, or has already removed: anything else is not a scratch directory.
 */
export function removeTestTmpDir(dir: string): void {
    const index = created.findIndex((entry) => entry.dir === dir)
    if (index < 0) return
    created.splice(index, 1)
    remove(dir)
}
