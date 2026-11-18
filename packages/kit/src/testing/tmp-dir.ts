import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll } from 'vitest'
import { TMP_DIR_MARKER_SUFFIX } from './tmp-dir-marker.mjs'

/**
 * THE FRAMEWORK'S OWN COPY of the scratch-directory helper, for @sssb/kit's tests (the shipped conformance suites
 * among them). Everyone else imports @sssb/tools' (`@sssb/tools/testing/tmp-dir`); the framework keeps a copy
 * because no SSSB package depends on another (ADR-0014, rule 4). Both write the same marker, which
 * tests/tooling/tmp-dir.test.ts holds equal, so `sssb check-tmpdir-leak` sees either one's leaks.
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
 * WHY THE HOOK IS REGISTERED AT MODULE TOP LEVEL, not lazily from the functions: vitest silently
 * drops a hook registered at run time from inside another hook, so a helper that registered its own
 * `afterAll` on first call would leak exactly when called from a `beforeAll` — no error, no cleanup.
 * Registering nothing in the functions makes them callable from module scope, `beforeAll`,
 * `beforeEach` or a test body alike. Vitest isolates each test file (`isolate` defaults to true and
 * vitest.config.ts does not change it), so this module — and the one hook — exists once per file.
 *
 * ORDERING: `afterAll` hooks run in reverse registration order. Import this module before anything
 * else that registers hooks and its cleanup runs AFTER a file's own `afterAll` — so a file that closes
 * a database handle living in the directory closes it before the directory is deleted.
 */
const created: string[] = []

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

/** Make a scratch directory that is removed when the test file finishes. Synchronous variant. */
export function makeTestTmpDir(prefix: string): string {
    const dir = mkdtempSync(path.join(tmpdir(), prefix))
    created.push(dir)
    writeFileSync(dir + TMP_DIR_MARKER_SUFFIX, '')
    return dir
}
