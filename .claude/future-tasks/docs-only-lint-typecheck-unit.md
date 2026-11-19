# A docs-only mode for `lint-typecheck-unit`

**Priority:** P3. Saves wall-clock time on a docs-only pull request; nothing is wrong without it.

## Why

The docs-only fast path (docs/decision-log.md, "A fast path for docs-only pull requests";
`.github/scripts/docs-only.sh`) skips the expensive jobs' work, but leaves `sssb / lint-typecheck-unit` in full,
because that job is where the docs are read: Prettier, the doc-path gate (`tests/docs/doc-paths.test.ts`), and the
plugin, generator and release-notes tests. On safeinsights/sssb#78's full run (2026-11-19) it took 5m22s of a 5m36s
run. That job is now the whole wall clock of a docs-only pull request, which the fast path barely shortens.

## Sketch

- A docs-only mode of `sssb ci lint-typecheck-unit` (in `@sssb/tools`, `packages/tools/src/commands/ci.js`), passed the
  reusable workflow's `docs-only` input: Prettier over the changed files, and the unit tests that read docs, named by
  a list the tests themselves keep (so a new doc-reading test cannot be left out by a stale list in the workflow).
  Typecheck, ESLint and the rest of the unit suite read no doc and would be skipped.
- The hard part is that list. A test that reads a doc and is not on it passes the fast path while the doc breaks it.
  One way: a Vitest tag or a file-name convention, checked by a test that fails when a test file reads under `docs/`
  (or any markdown) without carrying it.
- `@sssb/tools` ships, so it takes a changeset, and the adopter default stays the full run.
