---
'@sssb/tools': patch
---

### `@sssb/tools/testing/tmp-dir` cleans up every file under `isolate: false`

**Kind.** seam

**Action.** optional

**What changed.** With Vitest's `isolate: false`, `makeTestTmpDir` and `makeTestTmpDirAsync` removed only the first
test file's scratch directories in each worker, so `sssb check-tmpdir-leak` failed for every later file that made
one. A new setup module, `@sssb/tools/testing/tmp-dir-setup`, registers each file's cleanup before the file's code,
so every file's directories are removed after the file's own `afterAll` hooks. `appTestProject` from
`@sssb/tools/vitest` adds it to the app's `setupFiles`. Without it, the helper still removes every file's directories
made at a file's top level or in a `describe` body. A new `removeTestTmpDir(dir)` removes one directory the helper
made, and its marker, at once.

**To adopt.** Nothing, for an app project built with `appTestProject`. Any other Vitest project that sets
`isolate: false` adds `'@sssb/tools/testing/tmp-dir-setup'` to its `test.setupFiles`.
