# The kit's scratch-directory helper misorders or over-removes under `isolate: false`

**Priority:** P2 · **Status:** open
**Found by:** the Opus review of `fix/tools-tmp-dir-isolation`, 2026-11-18, reproduced in a real Vitest 4.1.12 run.

## What happens

`packages/kit/src/testing/tmp-dir.ts` registers a cleanup hook for each later file under `isolate: false`, at the
file's first call (ADR-0014 P5). Two flaws, both reproduced:

- **A first call in a `describe` body registers the hook in that `describe`,** and the hook removes everything queued.
  A file with two `describe` blocks that each make a directory loses the second block's directory when the first block
  finishes, so the second block's tests fail.
- **The hook runs before an `afterAll` the file registered before its first call** (`afterAll` hooks run in reverse
  order). A file that closes a database handle living in the directory then finds the directory gone.

With isolation (this repository's config) neither happens: the hook is registered when the module loads.

## Design

`@sssb/tools/testing/tmp-dir` fixed both (`packages/tools/src/testing/tmp-dir.js`, its resolution in
`.claude/future-tasks/resolved/tools-tmp-dir-without-isolation.md`). Port it:

- a hook keyed by suite and file, removing only its suite's directories and those of earlier files;
- a setup module the kit ships for its own suites (the kit cannot use `@sssb/tools`', ADR-0014 rule 4). How an adopter's
  conformance file gets it is the open question: `apps/<app>/src/sssb.conformance.test.ts` is written by `@sssb/create`, and the
  tools preset may not import `@sssb/kit`. One answer: the preset adds `@sssb/kit/testing/tmp-dir-setup` resolved from
  the app's directory, through the shared resolver rule 4 already requires.

Pin it with `packages/kit/src/testing/conformance/adopter-config.test.ts`'s shape, with the two cases above.
