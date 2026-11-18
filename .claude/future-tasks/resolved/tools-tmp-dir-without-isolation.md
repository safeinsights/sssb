# `@sssb/tools/testing/tmp-dir` leaks every file's directories but the first under `isolate: false`

**Priority:** P2 · **Status:** resolved 2026-11-18 (`fix/tools-tmp-dir-isolation`)

## Resolution

Ported as designed below. `packages/tools/src/testing/tmp-dir.js` keeps its load-time hook and registers one for each
later file whose first call comes while the file is collected, in `makeTestTmpDir` and, before its first `await`, in
`makeTestTmpDirAsync`, which the kit's copy no longer has. It exports `removeTestTmpDir(dir)`, in the `.d.ts` too.
`tests/tooling/tmp-dir-isolation.test.ts` runs a real Vitest with `isolate: false` over three files, once ending on a
synchronous call and once on the async one, and with isolation over a file that makes its directory in a
`beforeAll`, and finds nothing left in the child's TMPDIR. Each case was seen red with the registration it pins
removed: the sync one, the async one, the load-time hook, and `removeTestTmpDir` leaving the marker.
**Found by:** review round 2 of ADR-0014 P5 (`feat/conformance-suite`), 2026-11-18, while fixing the kit's copy.

## What happens

`packages/tools/src/testing/tmp-dir.js` registers its one cleanup `afterAll` when the module loads. Vitest isolates
each test file by default, so that is once per file. Under an adopter's `isolate: false` the module loads once per
worker, in its first file: only that file's directories are removed, and `sssb check-tmpdir-leak` fails for every
later file that makes one. The kit's own copy (`packages/kit/src/testing/tmp-dir.ts`) had the same flaw and was fixed
in P5; this one is the adopter-facing helper, so it matters more.

## Design

Port the kit's fix: keep the load-time hook; on a call from a file that has no hook yet (the file is
`expect.getState().testPath`), register that file's own `afterAll`, which works while the file is collected (its top
level or a `describe` body). Each hook removes everything still queued, safe because a worker runs its files one after
another. Export `removeTestTmpDir(dir)` for a helper that must clean up after itself, and add it to the `.d.ts`. Pin:
a Vitest run with `isolate: false` over two files that each make a directory at top level leaves nothing behind
(the kit's `adopter-config.test.ts` shows the shape).
