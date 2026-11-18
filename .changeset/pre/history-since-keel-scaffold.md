---
'@sssb/kit': minor
---

### Since keel 24b0589: scaffold changes to apply by hand

**Kind.** scaffold

**Action.** required

**What changed.** What changed since keel's `24b0589` in files an adopter keeps and edits: the fork's copy of the
framework gives way to the packages, the starter gained a cron route, and some write-once files (the gitleaks rules,
the `LICENSE` line) moved on. `@sssb/tools`, `@sssb/eslint-plugin`, the conformance suite and the per-app infra each
have their own entry in these notes; this one is the rest.

**To adopt.**

#### Replace the fork's `packages/keel` with the packages (safeinsights/sssb#6, #16)

- Delete `packages/keel`, and every path that reaches it: tsconfig `paths` and `include` entries, Vite and Vitest
  aliases for `keel` and `@app-config`, `next.config.ts`'s next-intl request path and `transpilePackages: ['keel']`
  (the `withSssb` preset sets both), and the entries for it in `panda.config.ts`, `.ladle`, `knip.json`,
  `.jscpd.json` and CODEOWNERS.
- Drop `"keel": "workspace:*"` from every `package.json`, and install the packages as these notes' install lines say.
- In `pnpm-workspace.yaml`, set `dedupePeerDependents: false`, so each importer of `@sssb/kit` gets an instance that
  links its own seam, then install once from scratch (no lockfile, no `node_modules`): pnpm re-resolves under that
  setting only from scratch. `sssb doctor` advises when it is missing.

#### The starter's scheduled-tick route (jpslav/keel#55, safeinsights/sssb#17)

An app with no `src/app/api/webhooks/cron/route.ts` copies the starter's (`apps/starter/src/app/api/webhooks/cron/`,
with its `route.test.ts`): `export const POST = withWebhookSecret(async () => Response.json({ ok: true, ...(await runScheduledTick()) }))`.
A cron route of the app's own stays, wrapped by `withWebhookSecret` as the authorization scan requires. In
development `sssb tick <slot>` POSTs it with the per-checkout dev secret, and `DEV_TICK_SECONDS=<seconds> pnpm dev`
ticks it on a timer (opt-in); the app's `playwright.config.ts` starts its web server with
`env: { DEV_TICK_SECONDS: '' }` so a value in the shell never reaches an e2e run.

#### `.gitleaks.toml` (jpslav/keel#60)

Remove the allowlist entry for `packages/keel/src/service-auth/webhook\.test\.ts` with the directory. Give any entry
of the app's own that pairs `paths` with `regexes` `condition = "AND"`: without it, gitleaks combines them with OR
and exempts every finding in those paths.

#### The `LICENSE` line (safeinsights/sssb#14)

SSSB's copyright is now Rice University's, and the licence stays MIT. Where the app's repository keeps SSSB's notice
for the files that came from it, the line reads `Copyright (c) 2026 Rice University`.

#### Smaller starter changes, if the app kept a copy

- The sign-in picker (`src/app/[locale]/signin/page.tsx`) leaves out a person with no membership instead of reading
  the role of `memberships[0]` (safeinsights/sssb#7).
- An app that kept the showcase's Panda pipeline moves to `@pandacss/dev` 2 and runs `panda codegen --clean` once:
  Panda 2 writes `.js` instead of `.mjs` and leaves Panda 1's files behind. Panda 2 no longer implies its base
  presets, so an app that uses Panda's tokens, patterns or conditions lists `@pandacss/preset-base` and
  `@pandacss/preset-panda` in `panda.config.ts`'s `presets`
  (safeinsights/sssb#9).
- A Simulator control for the dev ticker is the showcase's `src/app/api/simulator/ticker/` route, which answers 404
  unless `isSimulatedDevServer`, and the Jobs tab's `ticker` prop (safeinsights/sssb#19).

#### SSSB's release machinery is SSSB's

`.changeset/`, `.github/workflows/release.yml`, `scripts/release*.mjs` and CI's `changeset-required` and
`release-plan` jobs release SSSB (safeinsights/sssb#10, #21); an app does not copy them. Each later release's notes are
assembled from its changesets, and an entry marked `required` breaks an app that does nothing.

**Now deletable.** `packages/keel`, keel's `spikes/kysely-pglite` (its `spikes/*` workspace entry and CI step), keel's
own gates in `tests/` (`tests/lint`, `tests/tooling`, `tests/docs`, `tests/support`) and `tests/vitest.setup.ts`,
which the conformance suite and the Vitest preset replace.
