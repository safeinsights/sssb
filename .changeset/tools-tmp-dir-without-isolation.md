---
'@sssb/tools': patch
---

### `@sssb/tools/testing/tmp-dir` cleans up every file under `isolate: false`

**Kind.** none

**Action.** none

**What changed.** With Vitest's `isolate: false`, `makeTestTmpDir` and `makeTestTmpDirAsync` removed only the first
test file's scratch directories in each worker, so `sssb check-tmpdir-leak` failed for every later file that made one.
Each file whose first call comes at its top level or in a `describe` body now has its directories removed when it
finishes. A new `removeTestTmpDir(dir)` removes one directory and its marker at once, for a helper that runs from a
hook or a test in such a file and must clean up after itself.
