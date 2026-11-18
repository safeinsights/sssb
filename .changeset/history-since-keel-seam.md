---
'@sssb/kit': minor
---

### Since keel 24b0589: seam changes

**Kind.** seam

**Action.** required

**What changed.** Everything since keel's `24b0589` that changes what an app must say or satisfy to build, from
before changesets existed: the rename to SSSB, new peer floors, four new exports in the abilities seam, an
authorization scan that reads each handler, lint fences that reach further, and two ports that grew. The changes
that came with changesets of their own (`@sssb/tools`, `@sssb/eslint-plugin`, the conformance suite,
`sssb check-fences`, an app's vendors in `package.json`) are their own entries in these notes.

**To adopt.**

#### The framework is `@sssb/kit`, and the seam is `@sssb/app-config` (safeinsights/sssb#6)

- Rewrite every `keel/…` import to `@sssb/kit/…` and every `@app-config/…` to `@sssb/app-config/…`, in source,
  tests, `vi.mock` and `import()` specifiers. The seam's directory stays `apps/<app>/src/app-config`.
- Link the seam as a package: `"@sssb/app-config": "link:./src/app-config"` in the app's `dependencies`, and
  `src/app-config/package.json` holding
  `{ "name": "@sssb/app-config", "private": true, "exports": { "./db/migrations": "./db/migrations/index.ts", "./*": "./*.ts" } }`,
  plus the app's own `"type"` if its `package.json` sets one. A seam module that is a directory or a `.tsx` file
  needs an entry of its own; the conformance suite's `seam-map` check names one that is missing.
- Lint rule ids `keel/<rule>` are `sssb/<rule>`: rename them in `eslint-disable` comments and in the keys of
  `lint-exceptions.mjs` (a `keel/no-raw-db-handle` key stops the lint config loading, naming the file).
- The guided tour's cursor ids are `sssb-tour-cursor` and `sssb-tour-cursor-ring`, for CSS or a test that targets
  them.

#### Peer floors (safeinsights/sssb#8, #11, #16; jpslav/keel#36, #37, #41)

- The app provides `@sssb/kit`'s peers: `react` `~19.3.1` (keep the app's own `react-dom` at the same version), `@types/react`
  `~19.3.0`, `next` `^16.4.6`, `next-intl` `^4.14.9`, `@mantine/core` `^9.7.3`, `kysely` `^0.29.7` (no longer a
  dependency of the kit), `typescript` `~6.0.3` and `@types/node` `^26.6.5`. `vitest` `^4.1.12` and
  `embedded-postgres` are optional peers, for the conformance and contract suites. `sssb doctor` fails while any
  singleton has two copies.
- React 19.3 adds about 29 KB to a static demo. If `sssb check-demo-size` now fails, re-measure and raise the
  app's own number.
- The kit depends on `@sentry/nextjs` 11. An app that wraps its Next config imports `withSentryConfig` from
  `@sentry/nextjs/config` (11 no longer exports it from the package root), and moves its own `@sentry/nextjs` to 11.
  The kit's Sentry init holds data collection at or below v10's (`SENTRY_V10_BASELINE`).

#### The abilities seam has four new exports (jpslav/keel#34)

`src/app-config/abilities.ts` must export these, with `NonSessionAdministration` from `@sssb/kit/core/abilities`:

```ts
export type AppPersonCredentialKind = never
export type AppMachineCredentialKind = never
export function appMachineAbilityRules(): boolean {
    return false
}
export const nonSessionAdministration: NonSessionAdministration = {}
```

The same change also asks:

- An `AbilityActor` literal whose `manageAll` may be true states its session,
  `credential: { kind: 'session', id: null }`, or it no longer compiles: only a stated session wields `manageAll`.
- Non-read actions on Membership, Org, WebhookEndpoint and AgreementAcceptance are refused to a person who states
  no session credential (a token, an email), unless `nonSessionAdministration` widens that subject. It can never
  widen it to `inbound-email`.
- In real mode, a member whose org role is `restricted` is now restricted in their session too.
- `OrgIdentity` is branded: only `orgIdentityForSlug` (`@sssb/kit/db/org-lookup`) makes one, so a hand-paired
  `{ id, slug }` no longer compiles. `InboundContext` gains `org`, and `InboundHandlerResult` an optional
  `credential` (`auditActorOf(actor)` from `@sssb/kit/db/audit` gives it).
- An app with an auth adapter of its own implements `AuthPort.getMember`; a test that builds a `ServiceIdentity` by
  hand adds `keyId`.

#### The authorization scan judges each handler (jpslav/keel#34, #59)

The conformance suite's `authz-mutations` check reads every route with the TypeScript compiler:

- Each exported `POST`, `PUT`, `PATCH` and `DELETE` must reach `authorize(...)` on its own path. A call in a
  string, a comment, another verb, a dead branch or a function never called no longer counts.
- An `api/webhooks/` route is exempt only when the verb's export is itself a call to an imported
  `withWebhookSecret` (`@sssb/kit/service-auth/webhook`) or `withMailgunSignature`:
  `export const POST = withWebhookSecret(async () => …)`.
- `api/service/` routes are no longer exempt. The handler is a call to the app's `withServiceCaller` (as in the
  showcase's `src/app/api/service/respond.ts`) and calls `authorize(...)` with the machine actor it is given.

#### Lint fences reach further (jpslav/keel#38, #47, #51)

Every fence covers every extension ESLint lints (`.js`, `.jsx`, `.mjs`, `.cjs`, `.mts` and `.cts` too).
`sssb/no-raw-db-handle` covers every module under the app's `src/` (tests apart, except a route's or a screen's)
and catches `getDb` named as a string (`Reflect.get(db, 'getDb')`). The vendor ban also holds in a type-position
`import('…')`. Run `pnpm lint`. A module that truly needs the raw client is listed in `apps/<app>/lint-exceptions.mjs`
with a reason, `{ 'sssb/no-raw-db-handle': [{ file: 'src/…', reason: '…' }] }`, never by editing the fences.

#### Two ports grew (jpslav/keel#40, #52, #55)

- `StoragePort` gains `copy(from, to, options?)` and `head(key)`; an app's own storage adapter or test double
  implements both. `NotFoundError` and the new `PreconditionFailedError` are in `@sssb/kit/ports/errors`.
- `DbPort` gains an optional `now()`, the simulated world's clock, which audit rows take their time from. A wrapper
  around the framework's `DbPort` passes it through (a spread does).

#### Four framework controls have new accessible names (safeinsights/sssb#18)

The team switcher, the account menu, the Simulator pill and its Hide button are named from their visible text:
"{team}, switch team", "{name}, account menu" (the user's name, or their email when it is blank), "Simulator, open the panel" (or "Simulator, 3 unread emails,
open the panel") and "Hide the Simulator panel". An e2e spec that finds them by their old names needs the new ones.

#### New, and nothing to change

`runScheduledTick` (`@sssb/kit/server-lib/scheduled-tick`) and `withWebhookSecret`; `machineActor` and
`abilityActorFromCredential` (`@sssb/kit/authz/authorize`) for routes called by a token or a machine;
`recordAuditEvent`'s optional `detail`, which takes codes and counts only and throws, after the mutation has
committed, on anything shaped like a secret or an email address; `isSimulatedDevServer` (`@sssb/kit/adapters/index`);
`JobsApp`'s optional `ticker`; and `appDb` beside `db` in an `RlsProofSuite`'s context, which an app's
`src/app-config/db/rls-proofs.ts` should switch roles with, so the contract suite's owner pass proves its proofs as
a non-superuser.

**Now deletable.** Path mappings and aliases for `keel` and `@app-config` in tsconfig, Vite and Vitest configs; a
hand-paired `{ id, slug }` org literal; and a `getDb` exception written into a root `eslint.config.mjs`.
