---
description: Scaffold a new SSSB (framework) port in packages/kit + fake/real adapters, following the house pattern
argument-hint: <port name, and the vendor>
---

Create a new framework port named $ARGUMENTS following the established pattern.

**First decide whose port it is, and ask me if it is not obvious.** It is SSSB's when SSSB's own code calls it, or
when the vendor passes the universality or new-class test (`docs/development-approach.md`, "What SSSB
ships"). It is the APP's when only the app calls it and the vendor fails both tests, as with a CDN key-value store,
an e-sign provider, or a domain-specific API: that is the plugin's `/sssb:new-port`, which scaffolds it in the app
(`docs/recipes/app-owned-adapter.md`), not this command.

1. Read `packages/kit/src/ports/email.ts` and `packages/kit/src/adapters/fake/email.ts` as the reference shape.
2. Write `packages/kit/src/ports/<name>.ts`: a narrow interface sized to what the app needs (ask me what operations
   the app actually requires before writing it; never mirror a vendor API).
3. Write `packages/kit/src/adapters/fake/<name>.ts`: an honest fake persisting under `.data/` via `dataDir()` or in
   memory; fully offline.
4. Write `packages/kit/src/adapters/real/<name>.ts`: mark `AUTHORED — CUTOVER (<row>)` in the header, register any
   required env vars in `packages/kit/src/adapters/real/index.ts` REQUIRED_ENV, and add the cutover-checklist row.
5. Wire both into `packages/kit/src/adapters/index.ts`, add the `exports` lines the port and its adapters need to
   `packages/kit/package.json` (deliberately: `sssb/public-surface` reads that map), add the vendor's package
   pattern to `vendorSdkPattern` in `packages/eslint-plugin/src/patterns.js`, add unit tests for the fake, add a
   changeset (it ships), and run `pnpm verify`.
