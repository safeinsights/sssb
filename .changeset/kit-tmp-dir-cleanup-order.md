---
'@sssb/kit': patch
---

### The conformance and contract suites clean up their scratch directories under `isolate: false`

**Kind.** none

**Action.** none

**What changed.** With Vitest's `isolate: false`, a later test file that ran `conformanceSuite` or `contractSuite` could
leave behind the contract server's scratch directory, made in a `beforeAll`, so `sssb check-tmpdir-leak` failed the
run. Each suite now registers its file's cleanup itself, after its own teardown, so its directories are removed in
every file. A demo-presets replay that outlives its test no longer has its directory deleted under it. Nothing changes in the app: both suites are already called at a test file's top level.
