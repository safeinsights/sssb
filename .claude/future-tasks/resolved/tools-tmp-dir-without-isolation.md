# `@sssb/tools/testing/tmp-dir` leaks every file's directories but the first under `isolate: false`

**Priority:** P2 · **Status:** resolved 2026-11-18 (`fix/tools-tmp-dir-isolation`)

## Resolution

Built differently from the design below. Review found that design, which is also the kit's, removes too early
(`.claude/future-tasks/kit-tmp-dir-cleanup-order.md`):

- **A hook registered at a later file's first call, from a `describe` body, belongs to that `describe`.** It removed
  everything queued, so a directory the rest of the file still used was gone when that `describe` finished.
- **That hook runs before an `afterAll` the file registered earlier,** so the cleanup could precede the file closing
  what lives in the directory.

A second attempt registered a hook per suite; it still removed a nested `describe`'s directory before an outer test
used it. No hook registered at a call can be both last in order and wide enough in scope, so
`packages/tools/src/testing/tmp-dir.js` does this instead:

- **A setup module, `@sssb/tools/testing/tmp-dir-setup`,** registers the file's hook at its top, before the file's
  code. Vitest runs a setup file before every file even with `isolate: false` (checked with Vitest 4.1.12: the setup ran
  once per file and its `afterAll` after the file's own). `appTestProject` (`@sssb/tools/vitest`) adds it to every app
  project. It is the supported path under `isolate: false`.
- **Without it,** a later file never removes its own directories. Its first call registers a hook that removes earlier
  files', which have finished, so every file's directories are removed except the last file's, which
  `sssb check-tmpdir-leak` reports. The helper says so once per worker, naming the setup module.
- `removeTestTmpDir(dir)` is exported (and in the `.d.ts`) and ignores a path it did not make.
- `registerTestTmpDirCleanup()` is exported for the setup module.

`tests/tooling/tmp-dir-isolation.test.ts` runs a real Vitest per case, and every test in the child checks that its
own directory still exists when it runs. With the setup module, and with isolation, nothing is left. Without it,
everything is gone except the last file's directories, and the warning is printed. A last case pins the preset's
`setupFiles`. Nine probes, each red in the cases it should be, are listed in the PR.

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
