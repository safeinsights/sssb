import * as engine from '@sssb/tools/doc-paths'
import type { Citation } from '@sssb/tools/doc-paths'

/**
 * WHICH MARKDOWN THIS REPO HOLDS TO ITS PATH CITATIONS.
 *
 * The one list is `sssb.docPaths` in the root `package.json` (roots, include, exempt, referenceApps),
 * read by the engine in `@sssb/tools/doc-paths`, which is also what `sssb check-doc-paths` runs, so an
 * adopter keeps the gate the day `packages/kit` leaves the tree. This file is only the adapter that
 * gives `doc-paths.test.ts` and `doc-set.test.ts` cwd-relative signatures.
 *
 * Why each prefix in `exempt` is there — each is an append-only record whose entries were true on the
 * date they were written. Rewriting them to match today's tree would be revisionist, so they are
 * corrected opportunistically but never gated:
 *
 *   - `docs/adr/`: dated decisions; amended by appending a dated addendum, never by editing the body.
 *   - `docs/build-notes.md`: running log of dated lessons.
 *   - `docs/decision-log.md`: running log of dated decisions.
 *   - `docs/releases/`: one file per release, written by the release workflow from that release's changesets; it
 *     cites paths in an adopter's tree.
 *   - `.claude/future-tasks/resolved/`: finished tasks; the work that resolved one routinely moved
 *     what it cites.
 *   - `.claude/worktrees/`: linked worktrees from agent sessions, not this checkout's content.
 *
 * The rules that used to be commented here (line-reference stripping, glob truncation, command-span
 * tokens, the file-vs-directory parent fallback, the reference-app rule, one span many citations)
 * live beside the code that implements them, in `packages/tools/src/doc-paths.js`.
 */

export type { Citation }

/** Read on every call, so a test that rewrites package.json sees it; the file is small. */
const root = () => process.cwd()
const config = () => engine.readDocPathsConfig(root())

/** Every gated markdown file, as repo-relative paths. Call with the repo root as the cwd. */
export function doctrineDocs(): string[] {
    return engine.docFiles(root(), config())
}

export function citedPaths(file: string): Citation[] {
    return engine.citedPaths(file, config(), root())
}

/** Whether a cited path resolves under `root` (default: the working directory). */
export function resolves(path: string, root = '.'): boolean {
    return engine.resolves(path, root, config())
}

/** The `sssb.docPaths.include` entries that name nothing in the tree. Call with the repo root as the cwd. */
export function missingIncludes(): string[] {
    return engine.missingIncludes(root(), config())
}
