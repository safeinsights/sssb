import { fileURLToPath } from 'node:url'
import * as engine from '@sssb/tools/doc-paths'
import type { Citation } from '@sssb/tools/doc-paths'

/**
 * WHICH MARKDOWN THIS REPO HOLDS TO ITS PATH CITATIONS.
 *
 * Two callers need the same answer and must never drift apart: `doc-paths.test.ts`, which fails the
 * build when a doctrine doc cites a path that does not exist, and `scripts/init-app.ts`, which
 * repoints those citations when an adopter renames an app or ejects the showcase. A second list
 * would mean the rewriter could miss a file the gate checks — a broken gate on the adopter's first
 * command, which is the exact failure this whole seam exists to remove.
 *
 * The one list is now `sssb.docPaths` in the root `package.json` (roots, include, exempt,
 * referenceApps), read by the engine in `@sssb/tools/doc-paths`, which is also what `sssb
 * check-doc-paths` runs — so an adopter keeps the gate the day `packages/kit` leaves the tree. This
 * file is only the adapter that gives the tests and the rewriter their old, cwd-relative signatures.
 *
 * Why each prefix in `exempt` is there — each is an append-only record whose entries were true on the
 * date they were written. Rewriting them to match today's tree would be revisionist, so they are
 * corrected opportunistically but never gated (and never rewritten by `init-app`):
 *
 *   - `docs/adr/`: dated decisions; amended by appending a dated addendum, never by editing the body.
 *   - `docs/build-notes.md`: running log of dated lessons.
 *   - `docs/decision-log.md`: running log of dated decisions.
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

/**
 * Exempt prefixes, for `init-app`, which must not rewrite what the gate does not read. Read when this module loads,
 * from the checkout this file sits in, never from the working directory: `init-app` imports this before it changes
 * into the repository root, so a run started from a subdirectory would otherwise read the wrong package.json.
 */
export const EXEMPT: string[] = engine.readDocPathsConfig(fileURLToPath(new URL('../..', import.meta.url))).exempt

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

/** See the engine: rewrites citations of an app path `isMissing` reports gone into `apps/<app>/…`. */
export function generalizeAppCitations(text: string, isMissing: (path: string) => boolean): string {
    return engine.generalizeAppCitations(text, isMissing, config())
}
