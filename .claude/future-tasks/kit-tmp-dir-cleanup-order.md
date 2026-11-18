# The kit's scratch-directory helper removes too early under `isolate: false`

**Priority:** P2 · **Status:** open
**Found by:** the Opus reviews of `fix/tools-tmp-dir-isolation`, 2026-11-18, each reproduced in a real Vitest 4.1.12 run.

## What happens

`packages/kit/src/testing/tmp-dir.ts` registers a cleanup hook for each later file under `isolate: false`, at the
file's first call (ADR-0014 P5), and the hook removes every directory queued. Two failures follow, both reproduced
against `@sssb/tools`' copy when it had the same code:

- **A first call in a `describe` body registers the hook in that `describe`.** When that `describe` finishes, the hook
  removes directories the rest of the file still uses: a second `describe`'s, or an outer test's.
- **The hook runs before an `afterAll` the file registered before its first call** (`afterAll` hooks run in reverse
  order). A file that closes a database handle living in the directory then finds the directory gone.

Also, `removeTestTmpDir` removes any path it is given, recursively. With isolation (this repository's config) neither
failure happens: the hook is registered when the module loads.

## Design

Port `@sssb/tools`' fix (`packages/tools/src/testing/tmp-dir.js`; why it is shaped so, in
`.claude/future-tasks/resolved/tools-tmp-dir-without-isolation.md`):

- a setup module that registers each file's hook before the file's code, which is the supported path under
  `isolate: false`;
- without it, a later file's hook removes only EARLIER files' directories, never its own, and the helper says once that
  the setup module is missing;
- `removeTestTmpDir` ignores a path it did not make.

The kit cannot use `@sssb/tools`' setup module (ADR-0014 rule 4), so it ships its own, and how an adopter's
conformance file (`apps/<app>/src/sssb.conformance.test.ts`, written by `@sssb/create`) gets it is the open question:
the tools preset may not import `@sssb/kit`, but it could add `@sssb/kit/testing/tmp-dir-setup` resolved from the app's
directory, through the shared resolver rule 4 already requires. Pin it with
`packages/kit/src/testing/conformance/adopter-config.test.ts`'s shape and the cases in
`tests/tooling/tmp-dir-isolation.test.ts`.
