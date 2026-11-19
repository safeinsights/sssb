# ADR-0015 — An app may supply the real adapter for a kit port

- Status: Proposed
- Approver: JP Slavinsky (to accept or reject)
- Date: 2026-11-19
- Amends, if accepted (each by a dated addendum): [ADR-0002](0002-data-layer-kysely-pglite.md),
  [ADR-0003](0003-auth-clerk-headless-custom-ui.md), [ADR-0004](0004-tenancy-rls.md),
  [ADR-0009](0009-llm-anthropic.md), [ADR-0010](0010-observability-sentry-posthog.md),
  [ADR-0011](0011-email-mailgun.md), [ADR-0012](0012-framework-app-line-and-registration.md),
  [ADR-0014](0014-distribution-as-versioned-packages.md)

This is a design study. It proposes no code to merge with it; what it would build is in "Decision" and "Order".

## The answer, first

JP asked (2026-11-19) whether an adopter could use a different database (libsql or Turso), a different bucket
(Cloudflare R2), a different identity provider (Auth0) or different optional providers, and whether the "spine" could
stay required but become swappable.

- **Most ports, yes, at modest cost.** Storage, outbound and inbound email, the LLM, analytics and the job runner can
  each take a real adapter the app writes, chosen by a new value of the port's switch, `app`, and held to SSSB's
  behaviour by a **port contract suite** that `@sssb/kit` would ship. SSSB's fake stays the fake: the simulated
  world, the Simulator, the static demo and e2e run on SSSB's fakes whatever the app plugs in for real mode.
- **Error tracking needs nothing.** Sentry is instrumentation the app wires, not a port (ADR-0010). The starter wires
  none, and an app can wire any tracker in its own instrumentation files today.
- **Auth, yes, but it is the expensive one.** The port's shape survives, but the framework relies on Clerk beyond
  it: `withAuthProxy` runs Clerk's middleware, and the sign-in form, the invite-acceptance form and the client
  provider are Clerk's. Auth0 also cannot do ADR-0003's one custom sign-in form for an app that uses its
  Organizations, so ADR-0003 would gain an exception.
- **The database engine, no.** `DbPort` is not narrow: it hands out `Kysely<DB>` in the Postgres dialect, and every
  framework module, every framework migration and the whole tenancy guarantee (ADR-0004: row-level security, the
  `app_user` role, `set_config`) is written against Postgres. libsql has no row-level security, no roles and no
  session settings, so "an adapter for Turso" would be a second data layer and a weaker or different isolation
  guarantee, not an adapter. What is open, and was open all along: **any Postgres 16 or later** that the `pg`
  transport can reach. A new way of reaching Postgres is a transport, and transports ship in the kit (ADR-0002's
  addendum of 2026-11-16 says why).
- **Order:** nothing to build for errors or inbound email; the mechanism plus the contract suite, proven on outbound
  email; then the LLM, analytics and storage (R2 included, which needs one change to the storage port); then jobs;
  then auth, only when an adopter needs it. The database engine stays fixed.
- **When to build it:** on an adopter's first real need, not ahead of it. Nothing below is needed by pages, SSSB's
  first adopter, today. If JP wants the mechanism in place before that, its smallest proof is step 1 of "Order".

## Context

### What an app can and cannot do today

- **Add a port of its own** for a vendor SSSB has no port for (ADR-0012's addendum of 2026-11-16,
  `docs/recipes/app-owned-adapter.md`): its port, registry, fake and real adapter, under its `src/`.
- **Switch an optional kit port off**: `params.ports` in `config/params.ts` (safeinsights/sssb#67) sets
  `LLM_PROVIDER`, `EMAIL_PROVIDER`, `INBOUND_EMAIL_PROVIDER` and `JOBS_RUNNER`, and `none` makes the port absent
  (`packages/kit/src/adapters/real/optional-ports.ts`, `packages/kit/src/adapters/real/absent.ts`). A sibling change,
  `feat/storage-optional`, gives storage the same switch (`STORAGE_PROVIDER`, `s3` or `none`); this ADR assumes it
  lands and does not repeat it.
- **Not replace a kit port's real adapter.** `createRealPorts` (`packages/kit/src/adapters/real/index.ts`) builds
  exactly one adapter per port: Clerk, Postgres over `pg` or the RDS Data API, S3, Anthropic, Mailgun, CodeBuild or
  in-process, PostHog. The registry (`packages/kit/src/adapters/index.ts`) is what every framework module imports, and
  the app cannot reach into it except through the `@sssb/app-config/*` seam, which today names no adapter.

An adopter cannot patch `@sssb/kit` (it is an installed package, ADR-0014), so "write your own adapter" has no legal
place to go for a kit port. That is the gap.

### What holds a real adapter to the port today: nothing shared

The real auth adapter's header says to "Verify the full port contract suite against the dev instance at cutover"
(`packages/kit/src/adapters/real/auth.ts`). No such suite exists. Each real adapter is tested on its own with the
vendor's transport replaced (`packages/kit/src/adapters/real/storage.test.ts` spies on `S3Client.prototype.send`),
each fake on its own (`packages/kit/src/adapters/fake/fake-adapters.test.ts`), and nothing runs one set of
assertions against both. SSSB's own real adapters are `AUTHORED — CUTOVER`: typechecked, never run against the
vendor. So the conformance suite and the contract runner (`@sssb/kit/testing`, `@sssb/kit/testing/contract`) prove
the app's seam and its tenancy; nothing proves an adapter.

### The doctrine this has to respect

- **What SSSB ships** (`docs/development-approach.md`, "What SSSB ships"): vendor code in the kit must pass the
  universality or the new-class test. R2, Auth0, Turso, Postmark or OpenAI adapters pass neither, so shipping them in
  the kit is not the answer. The app writes them, as it writes an app-owned adapter now.
- **Hermetic dev** (`docs/development-approach.md`, "Fakes over emulators"): `pnpm dev` loads no vendor code, needs no
  credentials, reaches no network.
- **Explicit switches** (`optional-ports.ts`): a deployment's choice is a switch, never inferred from which settings
  happen to be set.

## Decision (proposed)

### 1. The app supplies the real adapter; SSSB keeps the fake

A swap replaces what `createRealPorts` builds for one port in real mode, and nothing else. In simulated mode the
registry never asks for it: the fake is SSSB's, because the Simulator reads the fakes' own state (the Mail tab reads
the fake email store, the Events tab the fake analytics adapter's events), and because "hermetic" stays SSSB's promise
only while SSSB writes the code that keeps it. The contract suite (3) is what makes an app's real
adapter and SSSB's fake two implementations of one behaviour.

The port's interface does not bend to the app's vendor. Where a vendor cannot meet the port, either the port changes
in SSSB, for every app, with a changeset, or the vendor is not eligible for that port. The storage port's upload
target is the one case found below (R2).

### 2. The switch gains `app`; the adapter is registered in one seam module

**The switch.** Each swappable port's `params.ports` entry gains the value `app`:

| Port           | Switch (server variable)  | Choices if accepted                                |
| -------------- | ------------------------- | -------------------------------------------------- |
| `llm`          | `LLM_PROVIDER`            | `anthropic` (default), `none`, `app`               |
| `email`        | `EMAIL_PROVIDER`          | `mailgun` (default), `none`, `app`                 |
| `inboundEmail` | `INBOUND_EMAIL_PROVIDER`  | `mailgun` (default), `none`, `app`                 |
| `jobs`         | `JOBS_RUNNER`             | `codebuild` (default), `in-process`, `none`, `app` |
| `storage`      | `STORAGE_PROVIDER`        | `s3`, `none` (the sibling's), `app`                |
| `analytics`    | `ANALYTICS_PROVIDER`, new | `posthog`, `none`, `app`                           |
| `auth`         | `AUTH_PROVIDER`, new      | `clerk` (default), `app`; never `none`             |
| `db` transport | `DATABASE_TRANSPORT`      | `pg` (default), `data-api`; no `app` (section 5)   |

Analytics today picks PostHog by whether `POSTHOG_KEY` is set, which is the inference the switch rule forbids; it
gets an explicit switch with the same default behaviour. Auth is required, so it has no `none`: a real deployment
without an identity provider has no way to sign anyone in. `SssbApp` (`packages/cdk`) passes `app` through as the
variable's value and builds none of SSSB's resources for that port (no bucket for `storage: 'app'`, no CodeBuild
project for `jobs: 'app'`), exactly as for `none`.

**The registration.** One new seam module, `@sssb/app-config/adapters` (`src/app-config/adapters.ts`):

```ts
import type { AppAdapters } from '@sssb/kit/ports/app-adapters'

export const appAdapters: AppAdapters = {
    storage: {
        // variable → cutover row, so `sssb check-real-env` and the boot check name what is missing
        env: { R2_ACCOUNT_ID: 'storage-r2', R2_ACCESS_KEY_ID: 'storage-r2', R2_SECRET_ACCESS_KEY: 'storage-r2' },
        create: async () => (await import('@/adapters/real/r2-storage')).createR2Storage(),
    },
}
```

- Each entry is a factory reached only by `import()`, which the fence already allows outside an app's adapters
  directory and requires inside it (ADR-0012's addendum of 2026-11-16). `createRealPorts` calls a factory only when
  that port's switch is `app`, so simulated mode, the static demo and a deployment that does not choose `app` load
  none of it. A module-load test like the one `packages/kit/src/adapters/real/index.test.ts` already has for the
  database transports would prove it.
- `env` joins the boot check (`assertRealEnv`) and `sssb check-real-env`, so a missing setting of the app's adapter
  fails at boot with its cutover row, as SSSB's own do. The module must import nothing else at evaluation:
  `sssb check-real-env` bundles the real registry as CommonJS, which refuses a top-level await, and the registry must
  not reach the app's job handlers while it is being evaluated (the reason `createRealPorts` takes the in-process
  runner as a hook today).
- A switch set to `app` with no entry fails at boot naming the port. An entry whose switch is not `app` is reported
  by `sssb doctor`, not failed: it is dead registration, and a deployment may flip the switch per environment.
- An app that swaps nothing exports `appAdapters = {}`. That is the "unused capability = empty registration" rule
  (ADR-0012), and it costs every existing app one new file on upgrade, which the release note's "To adopt" says.

### 3. The port contract suite: `@sssb/kit/testing/ports`

One Vitest suite per swappable port, published as source like the conformance suite, taking a factory:
`storagePortContract({ make, optOut })`, `emailPortContract(...)`, and so on. Its tests are named in a checks file,
registered, opted out by name with a reason and guarded against skipping exactly as the conformance suite's are
(`packages/kit/src/testing/conformance/register.ts`).

- **In SSSB** it runs against every SSSB fake, in the `kit` Vitest project, on every CI run. That makes it the fakes'
  specification too, which nothing is today, and it is how a change to a port's behaviour is seen to be one.
- **In the app** it runs against the app's adapter, from a file under `tests/contract/`, in the contract run. It needs
  the vendor's credentials, so it runs where they are present: an adopter's CI with a dev account's secrets, or a
  cutover run by hand. Without them it fails, unless the app opts out with a reason that names the open cutover row.
  A suite that skips quietly when a secret is missing would be the vacuous gate this repository keeps refusing.
- **`sssb doctor`** learns to read `params.ports`: for each port set to `app`, it fails unless some Vitest config runs
  that port's contract checks, less named opt-outs, as it already does for the conformance and contract checks.
- **Where a local stand-in exists** (an S3-compatible server for storage, a sink for email), SSSB may document it for
  an adopter's CI. It would be a contract-test instrument, as the RDS Data API emulator is, never a fake.

What each suite asserts is in the table below, port by port. What no suite can prove (deliverability, a vendor's rate
limits, a model's judgement) stays a cutover row, as it is for SSSB's own adapters.

### 4. Fences and tooling: what already holds, and what is new

Already holding, unchanged: the app's adapter lives in `src/adapters/real/` and is the only place its SDK is imported
(`sssb/no-vendor-import`, `sssb/no-dynamic-vendor-import`); the SDK is named in the app's `"sssb": { "vendors": [...] }`;
the adapter reads its own settings from `process.env` and never the run mode; its non-secret settings and secret
names go in `config/params.ts` with cutover rows. New: the seam module and its type, the `app` value in the kit's
switch table and in `@sssb/cdk`'s (`packages/cdk/src/optional-ports.js`, whose test already checks the two agree), the
boot and `check-real-env` handling of `env`, the doctor check, the contract suite, and a probe in
`packages/eslint-plugin/src/probes.js` if the seam module gets a fence of its own (a static import of
`adapters/real` there must fail, which the existing rules may already cover; the probe would show it).

The required-environment snapshot (`packages/kit/release-snapshots/required-env.json`) gains the `app` choices,
each requiring nothing of SSSB's, so the change files `minor` (ADR-0014 part 10).

### 5. Port by port

| Port                | Required?          | What the framework relies on beyond the interface                                                                                                                                                                                                                                                                                                                         | An app's adapter must prove (contract suite)                                                                                                                                                                                                                                                                    | Feasible                                           | Cost                                 |
| ------------------- | ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------- | ------------------------------------ |
| **errors** (Sentry) | No                 | Nothing: instrumentation in the app's own files (ADR-0010); `scrubEvent` and `SENTRY_V10_BASELINE` are Sentry-shaped but only reached if the app wires Sentry                                                                                                                                                                                                             | Nothing: not a port                                                                                                                                                                                                                                                                                             | Already                                            | None                                 |
| **email**, outbound | Optional           | Invitations, notifications and digests send through it; deferred mail catches `AbsentPortError` (`packages/kit/src/server-lib/defer.ts`)                                                                                                                                                                                                                                  | `send` resolves for a well-formed message, rejects (never resolves) on a provider refusal; html and text both delivered to the provider                                                                                                                                                                         | Yes                                                | Low                                  |
| **email**, inbound  | Optional           | Not a port (ADR-0011): the route is the app's, and it calls `intakeInboundEmail` (`@sssb/kit/inbound-email/intake`); the switch only decides whether `MAILGUN_WEBHOOK_SIGNING_KEY` is required                                                                                                                                                                            | No port suite: the app's route verifies its provider's signature itself; the authorization scan and the intake's own tests already apply                                                                                                                                                                        | Already, with `none`; `app` only names it honestly | Very low                             |
| **llm**             | Optional           | Model ids are a closed union of Claude ids (`LlmModelId`, `packages/kit/src/core/llm-models.ts`); fixtures and `pnpm llm:record` are Anthropic-shaped; the tool loop refuses a tool name not in the definitions                                                                                                                                                           | `complete` returns text; `stream` concatenates to text; `runToolLoop` calls `execute` for a demanded tool, returns turns in the port's block shapes, ends in text, honours `maxTurns`. Unknown-tool refusal: a unit test with the adapter's transport replaced, as SSSB's own adapter has                       | Yes                                                | Low to medium                        |
| **analytics**       | Optional           | The Simulator's flags read the fake; real PostHog is chosen by `POSTHOG_KEY` today                                                                                                                                                                                                                                                                                        | `capture` never throws into a request; `isFlagEnabled` returns the default when the flag is unknown                                                                                                                                                                                                             | Yes                                                | Low                                  |
| **storage**         | Optional (sibling) | The upload target is an S3 presigned POST (`UploadTarget`: fields, then the file, multipart) and the browser code is written to it; the fake serves the same shape locally; `list`, `copy`, `head` and `etag` have S3's semantics, all written into the port's comments; `SssbApp` builds the bucket and grants it                                                        | Every behaviour the port's comments state: prefix listing sorted and literal, idempotent batch delete, copy keeps type and overwrites, `ifMatch` and `PreconditionFailedError`, `NotFoundError` on a missing source, `head` null for a missing key, the upload target refusing a wrong type or an oversize body | Yes                                                | Low; R2 needs a port change (below)  |
| **jobs**            | Optional           | Terminal transitions arrive through the jobs webhook route behind `withWebhookSecret`, into `recordJobStatus`'s state machine; `sweep` fails lost jobs; the runner builds the handler's `JobContext` from the registry's ports                                                                                                                                            | `start` returns before or after the work but never loses it: a started job reaches `completed` or `failed` through the webhook, or `sweep` fails it; a handler's throw ends `failed`                                                                                                                            | Yes                                                | Medium: the contract is asynchronous |
| **auth**            | Required           | `withAuthProxy` (`@sssb/kit/adapters/proxy`) loads Clerk's middleware; the sign-in form, the invite-acceptance form and `RealAuthProviders` are Clerk's, mounted by the app's route files; one identity instance per tenant, the tenant in user metadata; `CLERK_*` in the required environment                                                                           | Every method of the port against a dev tenant: a member's standing, role per org, `restricted`, an invite pending until accepted, `setActiveOrg` refusing a non-member, `getMember` null for a removed or banned user and kept for a locked one                                                                 | Yes, with changes (below)                          | High                                 |
| **db**              | Required           | Postgres itself: the dialect in every framework query (jobs, schedules, audit, notifications, webhooks, inbound email, keyset paging), the framework's migrations, row-level security, `app_user`, `set_config`, migration `0015_app_user_grant` (Postgres 16 or later), the RLS proofs and the contract runner on real Postgres, pglite as the fake, Aurora in `SssbApp` | Not offered: section "libsql and Turso"                                                                                                                                                                                                                                                                         | Engine: no. Host: already. Transport: SSSB's       | n/a                                  |

### 6. Worked examples

#### Cloudflare R2

Two routes, and the simpler one is nearly there.

- **SSSB's S3 adapter, pointed at R2.** `createS3Storage` (`@sssb/kit/adapters/real/s3-storage`, published) already
  takes `endpoint`, `credentials` and `forcePathStyle` for "an S3-compatible endpoint other than AWS's". Only the
  registry ignores them: `createRealStorage` passes the bucket and region alone. So R2 is either a kit change (an
  `s3` choice that also reads an endpoint and credentials) or, under this ADR, an app adapter of a few lines that
  calls `createS3Storage` with R2's endpoint, `region: 'auto'` and R2's access key. The second needs no new vendor
  code anywhere, and `storage: 'app'` keeps `SssbApp` from building an S3 bucket nobody uses.
- **What R2 cannot do: the upload target.** Cloudflare's S3 compatibility page lists `CopyObject` with
  `x-amz-copy-source-if-match`, `HeadObject`, `ListObjectsV2` and `DeleteObjects` as implemented, so `copy`, `head`,
  `list` and `delete` keep their contract. But R2's presigned URLs support GET, HEAD, PUT and DELETE, and its docs say
  "`POST` (multipart form uploads via HTML forms) is not currently supported". `createUploadTarget` is an S3 presigned
  POST, and its size ceiling is the policy's `content-length-range`, which a presigned PUT has no equivalent of. So on
  R2 the port's promise that "the storage backend must enforce" `maxBytes` cannot be kept as written.
- **What it would take**, decided when storage's step is built: the port's `UploadTarget` gains a PUT form (a URL and
  the headers to send), and the size is held another way. Two candidates, neither verified against R2 yet: the route
  takes the file's size first, refuses it above the limit and signs that exact `Content-Length` into the URL; or the
  upload lands under a staging key and is checked with `head` before the existing `copy` moves it into place, deleting
  an oversize one. The first enforces at upload if R2 honours a signed length; the second always works but stores the
  bytes first. The contract suite would hold both adapters, and the fake, to whichever the port then says.

#### Auth0

The port's methods map onto Auth0 with work, and three things outside the port do not map at all.

- **Fits the port.** Auth0 Organizations are SSSB's orgs; an organization's `name`, its lowercase identifier, can
  be the slug. A role per membership
  is an organization member role. `createInvite` is the Management API's organization invitation with
  `send_invitation_email: false`, which returns the invitation URL instead of mailing it: the port already says
  sending the email is the caller's job, through the email port. `restricted`, the locale and the tenant go in the
  user's `app_metadata`. The active org can stay where the Clerk adapter keeps it, in the user's metadata, so
  `setActiveOrg` stays a server call.
- **The sign-in form does not fit.** Auth0 does not support the Resource Owner Password grant for applications that
  use Organizations (it is in the limitations Auth0 lists for Organizations), so a headless email-and-password form
  posting from SSSB's Mantine screen is not possible; sign-in is a redirect to Auth0's hosted Universal Login. The
  sign-in body is already a slot the app's own route file fills (the starter's `src/app/[locale]/signin/page.tsx`
  imports SSSB's Clerk form in real mode), so an Auth0 app can render a "continue" step there. But ADR-0003's "exactly
  one auth UI, used in every mode" stops being true for the credential step in real mode, and needs an addendum
  saying so. The invite-acceptance form is the same case: Auth0's invitation URL goes to Universal Login.
- **The proxy does not fit.** `withAuthProxy` imports `./real/clerk-proxy` by name. Auth0's Next.js SDK (v4) also
  runs as middleware in the request proxy, where it mounts its `/auth/*` routes and keeps the session cookie, so the
  proxy must run the provider's middleware, whichever it is. That means `withAuthProxy` reads `AUTH_PROVIDER` and,
  for `app`, takes the middleware from the app's adapter entry (a second factory, `proxy`, beside `create`), without
  loading the registry, which the proxy must not (`packages/kit/src/adapters/run-mode.ts` exists for that reason).
- **Costs no suite measures.** `getMember` runs on every request that arrives without a session; on Clerk it is three
  API calls, and an Auth0 adapter would make its calls to the Management API, under that API's rate limits, so it
  will likely need a short cache, and the cutover row has to measure it. Sign-out ends Auth0's session with a redirect to its
  logout endpoint, where Clerk's adapter revokes the session server-side.
- **Verdict:** feasible, after a provider hook in `withAuthProxy`, form slots that may hold a redirect step, and the
  ADR-0003 addendum. The auth contract suite can only run against a live dev tenant. Build it when an adopter needs a
  provider other than Clerk, not before.

#### Another email or LLM provider

- **Email (Postmark, Resend, Amazon SES).** `send` takes a rendered subject, html and text and a recipient; any
  transactional provider's API covers it in a few lines, in the app's `adapters/real/`. The suite can prove that a
  send resolves and that a refusal rejects; deliverability is the provider's and stays a cutover row. Inbound mail from
  another provider is already the app's route plus `intakeInboundEmail`, with `INBOUND_EMAIL_PROVIDER` at `none` today
  and `app` under this ADR. Its replay guard is the app's to write; the Mailgun verifier's note that a multi-instance
  deployment needs a shared token store applies to any provider.
- **LLM (OpenAI, a self-hosted model).** The adapter maps the port's two tiers, `LLM_MODELS.default` and
  `LLM_MODELS.fast`, to the provider's models; model ids stay out of the app's code as ADR-0009 requires, now pinned
  in the adapter's settings. The port's content blocks (`text`, `tool_use`, `tool_result`) map onto any tool-calling
  API, and the adapter must keep the trust rule: refuse a tool call whose name is not among the definitions. The fake
  still replays Anthropic-recorded fixtures, so the simulated world is deterministic whatever the real provider is; an
  app that wants its fixtures recorded from its own provider writes its own recorder. The suite's live checks are
  structural, since a model's text is not deterministic.

#### libsql and Turso

The honest answer is that this is not an adapter, and the reason is the tenancy guarantee.

- **What the framework would lose.** ADR-0004's isolation is a database mechanism: each tenant table's policy compares
  `tenant_id` with a transaction-local setting, under a role that cannot bypass it, proven by unfiltered reads both
  ways, a cross-tenant write refused by `WITH CHECK`, a superuser negative control and a fail-closed check, on pglite
  and on real Postgres. SQLite, and so libsql, has no row-level security, no roles and no session settings to key a
  policy on.
- **What tenancy would become: two strategies, each a different guarantee.**
    - _A database per tenant_, Turso's own recommendation. `withTenant(tenantId, fn)` would open that tenant's database
      and run `fn` in it. Isolation is physical, and arguably stronger than a policy against a forgotten predicate. But
      it moves the boundary from the database to whatever picks the connection: a handle opened for one tenant must
      hold a credential that cannot reach another, or nothing enforces the separation. The framework's tables that are
      read before a tenant is known (`tenants`, `organizations`, `service_keys`, the inbound mail's recipient lookup,
      the scheduled tick's sweep across every tenant's schedules) need a control database beside the tenants', so
      `getDb()` changes meaning. Migrations fan out across every tenant's database with partial failure possible
      between them; Turso's schema-sharing feature for this is deprecated for new users, so the migrator would do the
      fan-out itself. The RLS proofs would be replaced by different proofs (a handle for one tenant cannot address
      another's database), and the guarantee would rest on credential scoping rather than on Postgres.
    - _One database, enforcement in the query layer_ (a Kysely plugin adding `tenant_id = ?` to every query). This is
      the query discipline ADR-0004 rejected ("query discipline is a promise and a policy is a mechanism"): raw `sql`
      escapes it, nothing equivalent to `WITH CHECK` refuses a cross-tenant write, and no negative control can show
      the proofs are not vacuous. SSSB should not offer it as its guarantee.
- **What else would have to fork.** The framework's migrations are Postgres DDL (`uuid`, `timestamptz`, `jsonb`,
  policies, grants, a `DO` block); its domain modules write Postgres SQL; the fake database is pglite; `SssbApp` builds
  Aurora. A libsql SSSB is a second data layer maintained beside the first, with its own proofs, which is ADR-0002
  and ADR-0004 decided twice.
- **What is open instead.** If the reason for Turso is cost, scale-to-zero or a database reachable without a VPC:
  any Postgres 16 or later works through the `pg` transport today (a serverless or managed Postgres reached by
  `DATABASE_URL`, with a migrating owner that meets migration 0015), and the RDS Data API transport already serves an
  Aurora outside a VPC. Two limits: `SssbApp` always builds Aurora, so a non-AWS Postgres is deployed by the adopter's
  own infrastructure, which `databaseNameFor` already allows for; and a host's HTTP driver, if one is wanted, is a new
  transport SSSB writes and proves, as it did the Data API, not an app adapter. If the reason is a database per
  tenant, that is a tenancy redesign, and it belongs in its own ADR against ADR-0004, Postgres or not.

### 7. What it does to the other ADRs, if accepted

- **ADR-0002:** an addendum stating that Postgres is the engine for every app, that "a different database" means a
  different Postgres host, and that a new transport is SSSB's to ship and prove.
- **ADR-0003:** Clerk becomes SSSB's default adapter, not the only one; in real mode an app's adapter may put the
  credential step on its provider's hosted page; `withAuthProxy` runs the chosen provider's middleware.
- **ADR-0004:** an addendum recording that no swap reaches it, because the database is not swappable, and why.
- **ADR-0009:** Anthropic is the default; model ids stay pinned in one place per adapter; fixtures stay
  Anthropic-recorded for the fake.
- **ADR-0010:** analytics gains an explicit switch with `app`; Sentry is already the app's choice.
- **ADR-0011:** Mailgun is the default for both directions; another outbound provider is `email: 'app'`, another
  inbound one is the app's route.
- **ADR-0012:** the seam gains `@sssb/app-config/adapters`. The line does not move: the app's adapter is app code, and
  the kit reaches it only through the seam.
- **ADR-0014:** the published surface gains `@sssb/kit/testing/ports` and the adapters type; the required-environment
  snapshot gains the `app` choices (a `minor` change).

### 8. Order

0. **Nothing to build:** error tracking is already the app's, and another inbound email provider is the app's route
   with `INBOUND_EMAIL_PROVIDER` at `none`. Both can be said in the adopter reference now, without accepting this ADR.
1. **The mechanism, proven on outbound email**, the smallest port (one method): the seam module and its type, `app`
   in both switch tables, the boot and `check-real-env` handling, `SssbApp` passing it through, the doctor check, and
   the email contract suite run against SSSB's fake. A scratch adapter in a pack-and-consume shape would show an app
   can register one, the way that script already proves an app-owned adapter.
2. **LLM, analytics and storage**, each with its suite. Storage waits for `feat/storage-optional`; R2 is an app
   adapter over `createS3Storage` once the upload target has a PUT form.
3. **Jobs**, whose suite has to model an asynchronous runner.
4. **Auth**, when an adopter needs it, with the proxy hook and the ADR-0003 addendum.
5. **Never, under this ADR: the database engine.**

## Rejected alternatives

- **Ship R2, Auth0, Turso, Postmark or OpenAI adapters in the kit.** Each fails both tests in "What SSSB ships":
  not universal, and no integration class SSSB does not already teach. They would be dead code with a maintenance
  bill for every app that does not use them.
- **The app supplies the fake as well.** The Simulator reads the fakes' state, and the hermetic promise would become
  each app's to keep. A swap that changes `pnpm dev` is a different product than the one SSSB tests.
- **An environment variable naming a module for the registry to import.** No bundler or tracer can see it (Next's
  standalone output, `sssb check-real-env`'s esbuild bundle), no lint rule can fence it, and the app's adapter would
  ship or not by accident.
- **The app wraps the registry** (its own `adapters/index.ts` re-exporting SSSB's with one port replaced). The
  framework's own modules import `@sssb/kit/adapters/index` directly, so they would keep SSSB's adapter while the
  app's code used the app's: two adapters for one port in one process.
- **A `DbPort` the app supplies.** The port's contract is `Kysely<DB>` speaking Postgres under row-level security;
  "a libsql `DbPort`" would satisfy the type and none of the behaviour the framework relies on.
- **Inferring `app` from the presence of a registered factory.** The switch rule: a deployment that half-configures a
  port must fail at boot, not quietly change adapter.
- **A suite that skips when the vendor's credentials are absent.** It would pass in every CI that never configured
  them, which is every CI at first.

## Consequences

- **Kit ports become a public contract with third-party implementations.** Today a port can gain a method in a
  `minor` release because SSSB writes every adapter. Once apps write adapters, adding a method or tightening a
  behaviour breaks them: a port change becomes a breaking change, the contract suite is where it shows, and the
  release note's "To adopt" has to say what each app adapter must add. This is the largest cost, and it is permanent.
- The fakes get a specification, which they lack today, and SSSB's own real adapters get a suite to run at cutover.
- One new seam module in every app, empty for most.
- The database answer is a firm no to a different engine, stated with its reason, and a yes to any Postgres.
- Auth stays the hardest swap; the proposal does not pretend otherwise, and ADR-0003 is amended rather than worked
  around.

## Sources for the vendor facts

Checked on 2026-11-19; each would be re-checked when its port's step is built.

- Cloudflare R2, presigned URLs: `https://developers.cloudflare.com/r2/api/s3/presigned-urls/` (GET, HEAD, PUT,
  DELETE; POST "not currently supported").
- Cloudflare R2, S3 API compatibility: `https://developers.cloudflare.com/r2/api/s3/api/` (`CopyObject` with
  `x-amz-copy-source-if-match`, `HeadObject`, `ListObjectsV2`, `DeleteObjects`).
- Auth0, the Resource Owner Password grant with Organizations: Auth0's support article "Auth0 Automated Tests Fail
  With ROPG Flow When Organizations Are Enabled" and Auth0 staff replies on its community forum, which cite the
  Organizations limitations page.
- Auth0, organization invitations: `https://auth0.com/docs/organizations/send-membership-invitations`
  (`send_invitation_email: false` returns the URL for the app to deliver).
- Auth0 Next.js SDK v4, middleware in `proxy.ts` mounting `/auth/*`: Auth0's blog post on Next.js 16 and the SDK's
  README.
- Turso, multi-DB schemas deprecated for new users: `https://docs.turso.tech/features/multi-db-schemas`.
