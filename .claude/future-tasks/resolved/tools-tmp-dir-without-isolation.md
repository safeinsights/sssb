# `@sssb/tools/testing/tmp-dir` leaks every file's directories but the first under `isolate: false`

**Priority:** P2 · **Status:** resolved 2026-11-18 (`fix/tools-tmp-dir-isolation`)

## Resolution

Built differently from the design below, because review found two flaws in that design, which is also the kit's
(`.claude/future-tasks/kit-tmp-dir-per-suite-cleanup.md`):

- **A hook registered from a `describe` body belongs to that `describe`,** not the file, and removed everything
  queued, so a file with two `describe` blocks lost the second one's directory when the first finished.
- **A hook registered at a later file's first call runs before an `afterAll` the file registered earlier,** so the
  cleanup could delete a directory before the file closed what lives in it.

What `packages/tools/src/testing/tmp-dir.js` does instead:

- **A setup module, `@sssb/tools/testing/tmp-dir-setup`,** registers the file's hook at its top, before the file's
  code. Vitest runs a setup file before every file even with `isolate: false` (checked with Vitest 4.1.12: the setup
  ran once per file and its `afterAll` after the file's own). SSSB's Vitest preset (`@sssb/tools/vitest`) adds it to
  every app project.
- **Without the setup module,** a later file's first call in each suite registers a hook in that suite, which removes
  that suite's directories and those an earlier file left, never another suite's. Vitest reuses one top-level collector
  for every file in a worker, so the registry is keyed by suite and file. The ordering guarantee needs the setup module.
- `makeTestTmpDirAsync` claims its suite before its first `await`.
- `removeTestTmpDir(dir)` is exported, in the `.d.ts` too, and does nothing for a path it did not make.
- `registerTestTmpDirCleanup()` is what the setup module calls.

`tests/tooling/tmp-dir-isolation.test.ts` runs a real Vitest per case and finds nothing left in the child's TMPDIR,
every test in the child passing. It covers `isolate: false` with and without the setup module, isolation, and
`removeTestTmpDir`. Eight probes, each red in its own case, are listed in the PR.

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
