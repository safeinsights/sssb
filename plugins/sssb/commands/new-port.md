---
description: Scaffold a port the APP owns (port + registry + fake + real adapter) for a vendor SSSB has no port for
argument-hint: <port name, and the vendor>
---

Create a port the app owns, named $ARGUMENTS.

**The app** is the directory the workspace root `package.json` lists in `sssb.apps` (with more than one, the one
the request names, or ask). Paths below are relative to that directory; run `pnpm` scripts from the workspace root.
The full recipe, with the sketches this command summarizes, is SSSB's
`https://github.com/safeinsights/sssb/blob/<ref>/docs/recipes/app-owned-adapter.md`, where `<ref>` is the commit your
project's Claude Code settings pin the `sssb` marketplace to.

**First decide whose port it is, and ask me if it is not obvious.** It is the APP's when only the app calls it and
the vendor fails both of SSSB's tests for vendor code (every app needs it, or it teaches an integration mechanic SSSB
lacks), as with a CDN key-value store, an e-sign provider or a domain-specific API. A vendor that passes one is a
port SSSB should own: propose it to SSSB rather than building it here, because the app does not carry changes to
SSSB's packages. A vendor that plugs into a swap point SSSB already owns (an SMS channel, say) follows that swap
point's recipe instead.

1. Create `src/ports/<name>.ts`: types only, a narrow interface sized to what the app needs (ask me what operations
   the app actually requires before writing it; never mirror a vendor API). `@sssb/kit/ports/email` is a good shape
   to copy.
2. Create `src/adapters/fake/<name>.ts`: offline and honest, behaving like the real thing at the port surface,
   including the errors the app must handle. State in memory (pinned on `globalThis`, so a dev-server reload keeps
   it) or in the app's own tables through `db.withTenant`, never under `.data/`; say which in the file header. No
   vendor SDK, no `process.env` and no import of `src/adapters/real/`: the lint refuses all three here. Colocate
   its unit test (create `src/adapters/fake/<name>.test.ts`).
3. Create `src/adapters/real/<name>.ts`, the only file that imports the vendor SDK, marked
   `AUTHORED — CUTOVER (<row>)` until someone has watched it talk to the real service. Install the SDK in the app's
   own `package.json` (`pnpm --filter <app> add <sdk>`), then run `pnpm sssb:doctor` (if it reports the kit has no
   seam linked, `/sssb:new-preset-operation` step 2 has the fix). Read configuration from `process.env` only in
   `src/adapters/real/` (create `src/adapters/real/index.ts`, with a REQUIRED_ENV map from each variable to its
   cutover row that throws `CutoverPendingError` (`@sssb/kit/ports/errors`) naming every missing variable at once);
   never read `APP_MODE`, `DEMO_MODE` or `E2E_BUILD` there. Record non-secret params and secret NAMES (never values)
   in `config/params.ts` with a `// cutover: <row>` comment, and add the row to the workspace root's
   `docs/cutover-checklist.md`, naming the proof rather than the task.
4. Create `src/adapters/index.ts`, the registry: import `isSimulated` from `@sssb/kit/adapters/index`,
   `await import('./real/index')` only when it is false, and export each port as `real?.x ?? fakeX`. Nothing imports
   `src/adapters/real/` statically, and the registry has no `process.env` of its own.
5. Callers import the registry (`@/adapters`), never `@/adapters/real/*`. Make sure the vendor's package is matched
   by SSSB's vendor list (the app guide names it) or by the app's own `"sssb": { "vendors": ["<sdk>", "<sdk>/*"] }` in
   its `package.json`, which the lint preset reads: otherwise the rest of the app could import it with a green lint.
   Then run `pnpm verify`.
