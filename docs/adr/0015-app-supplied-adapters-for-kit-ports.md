# ADR-0015 — Swappable kit ports: protocol choices first, then app-supplied adapters

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

- **Yes for most ports, in two tiers.**
    - **A protocol choice in the kit, where one protocol covers a class of vendors.** Storage's `s3` choice would take an
      endpoint and credentials, so any S3-compatible store (Cloudflare R2, MinIO, Backblaze B2) is configuration. The
      adapter is already published and already takes them. Email would gain an `smtp` choice, which every transactional
      provider speaks. Neither needs new machinery or puts a contract in third parties' hands.
    - **An adapter the app writes, where no protocol does.** That is the LLM, analytics, the job runner and auth. The
      app selects it with a new switch value, `app`, registers it through the seam, and a **port contract suite** that
      `@sssb/kit` ships holds it to SSSB's behaviour. SSSB's fake stays the fake: the simulated world, the Simulator,
      the static demo and e2e run on SSSB's fakes whatever the app plugs in for real mode.
- **Error tracking needs nothing.** Sentry is instrumentation the app wires, not a port (ADR-0010). The starter wires
  none, and an app can wire any tracker in its own instrumentation files today.
- **R2 needs one port change whichever route it takes.** R2 has no presigned POST, which is what the storage port's
  browser upload target is.
- **Auth, yes, but it is the expensive one.** The framework relies on Clerk beyond the port: the request proxy, the
  sign-in and invite forms, the client provider, the boot check and the in-process job runner all name it. For Auth0,
  sign-in and sign-out also become redirects, which changes the port and ADR-0003's one-custom-UI rule.
- **The database engine, no.** `DbPort` is not narrow: it hands out `Kysely<DB>` in the Postgres dialect, and every
  framework module, every framework migration and the whole tenancy guarantee (ADR-0004: row-level security, the
  `app_user` role, `set_config`) is written against Postgres. libsql has no row-level security, no roles and no session
  settings, so "an adapter for Turso" would be a second data layer and a different isolation guarantee, not an adapter.
  **A different Postgres host is open, but it is not free:** genuine PostgreSQL 16 or later, an owner that may create
  roles, an application role without `BYPASSRLS`, and a way to run the migrations off AWS, which SSSB does not ship
  yet. None of it is proven on a host other than Aurora's engine.
- **Order:** the two protocol choices (storage endpoint, SMTP), each when an adopter asks; then the `app` mechanism,
  with its full shape settled at once and proven on the LLM; then analytics and jobs; then auth, only when an adopter
  needs it. The database engine stays fixed.
- **When to build it:** on an adopter's first real need, not ahead of it. Nothing below is needed by pages, SSSB's
  first adopter, today.

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
each fake on its own (`packages/kit/src/adapters/fake/fake-adapters.test.ts`), and nothing runs one set of assertions
against both. SSSB's own real adapters are `AUTHORED — CUTOVER`: typechecked, never run against the vendor. So the
conformance suite and the contract runner (`@sssb/kit/testing`, `@sssb/kit/testing/contract`) prove the app's seam and
its tenancy; nothing proves an adapter.

### The doctrine this has to respect

- **What SSSB ships** (`docs/development-approach.md`, "What SSSB ships"): vendor code in the kit must pass the
  universality or the new-class test. R2, Auth0, Turso, Postmark or OpenAI adapters pass neither. A protocol that a
  whole class of vendors speaks (the S3 API, SMTP) is a different case: it is one adapter for every member of the
  class, which is what universality asks.
- **Hermetic dev** (`docs/development-approach.md`, "Fakes over emulators"): `pnpm dev` loads no vendor code, needs no
  credentials, reaches no network.
- **Explicit switches** (`optional-ports.ts`): a deployment's choice is a switch, never inferred from which settings
  happen to be set.

## Decision (proposed)

### 1. Prefer a protocol choice in the kit; an app adapter only where there is none

When a port's vendors share a wire protocol, the kit's adapter speaks the protocol and the vendor is configuration.
That costs one adapter SSSB already proves, and it keeps third parties out of the port's contract. Two ports qualify:

- **Storage: the `s3` choice takes an endpoint.** `createS3Storage` (`@sssb/kit/adapters/real/s3-storage`, published)
  already takes `endpoint`, `credentials` and `forcePathStyle` for "an S3-compatible endpoint other than AWS's". Only
  `createRealStorage` (`packages/kit/src/adapters/real/storage.ts`) drops them, passing the bucket and region alone.
  The `s3` choice would read settings of its own, all optional: `STORAGE_ENDPOINT`, `STORAGE_REGION`,
  `STORAGE_FORCE_PATH_STYLE`, `STORAGE_ACCESS_KEY_ID` and `STORAGE_SECRET_ACCESS_KEY`, handed to `createS3Storage`
  explicitly. Not `AWS_REGION` and the AWS key pair, which a Lambda reserves for its own role and region; today the
  region comes from `AWS_REGION`. The app's `params.ports.storage` would say so as well, so that `SssbApp` builds no S3
  bucket nobody uses. What a given store does not implement of the S3 API is that store's gap against the port, as R2's
  upload target is (section 6).
- **Email: an `smtp` choice.** Postmark, Amazon SES, Resend, Mailgun itself and nearly every other transactional
  provider accept SMTP. One SMTP adapter would cover them, behind `EMAIL_PROVIDER=smtp` with a host, port and
  credentials. It needs an SMTP client as a new dependency, and a Lambda opens a connection per cold start, which the
  cutover row would measure. ADR-0011's case against SMTP was a local catcher in place of the port, not SMTP as a
  production transport, so it does not stand in the way.

### 2. Otherwise the app supplies the real adapter, and SSSB keeps the fake

For the LLM, analytics, the job runner and auth, the vendors share no protocol. A swap replaces what `createRealPorts`
builds for one port in real mode, and nothing else. In simulated mode the registry never asks for it: the fake is
SSSB's, because the Simulator reads the fakes' own state (the Mail tab reads the fake email store, the Events tab the
fake analytics adapter's events), and because "hermetic" stays SSSB's promise only while SSSB writes the code that
keeps it. The contract suite (section 4) is what makes an app's real adapter and SSSB's fake two implementations of one
behaviour.

The port's interface does not bend to the app's vendor. Where a vendor cannot meet the port, either the port changes
in SSSB, for every app, with a changeset, or the vendor is not eligible for that port. Two cases are found below: the
storage upload target (R2) and auth's sign-in and sign-out (Auth0).

### 3. The switch gains `app`; the adapter is registered in three seam modules

**The switch.** The ports with no protocol choice gain the value `app`:

| Port           | Switch (server variable)  | Choices if accepted                                  |
| -------------- | ------------------------- | ---------------------------------------------------- |
| `llm`          | `LLM_PROVIDER`            | `anthropic` (default), `none`, `app`                 |
| `analytics`    | `ANALYTICS_PROVIDER`, new | `posthog` (default), `none`, `app`                   |
| `jobs`         | `JOBS_RUNNER`             | `codebuild` (default), `in-process`, `none`, `app`   |
| `auth`         | `AUTH_PROVIDER`, new      | `clerk` (default), `app`; never `none`               |
| `email`        | `EMAIL_PROVIDER`          | `mailgun` (default), `smtp`, `none`                  |
| `storage`      | `STORAGE_PROVIDER`        | `s3`, `none` (the sibling's); `s3` gains an endpoint |
| `inboundEmail` | `INBOUND_EMAIL_PROVIDER`  | unchanged: `mailgun`, `none` (section 5 says why)    |
| `db` transport | `DATABASE_TRANSPORT`      | unchanged: `pg`, `data-api`; no `app` (section 6)    |

- **Analytics needs a fix now and a switch later.** Today real mode picks PostHog when `POSTHOG_KEY` is set and
  otherwise serves the _fake_ (`packages/kit/src/adapters/real/index.ts`). The fake's `capture` and `isFlagEnabled`
  both create and write a directory under `.data/` in the working directory, unless `APP_DATA_DIR` says otherwise
  (`packages/kit/src/adapters/fake/analytics.ts`, `packages/kit/src/adapters/fake/data-dir.ts`), and `SssbApp` sets
  neither `POSTHOG_KEY` nor `APP_DATA_DIR`. On Lambda the server's directory is read-only, so in a keyless deployment
  both calls most likely throw: sending an invite awaits `capture` without a catch
  (`packages/kit/src/server-lib/invite.ts`). Not yet observed on a deployment. So, in two parts:
    - **now, a patch, independent of this ADR:** real mode without a key gets a no-op adapter, never the fake;
    - **later, with the `app` mechanism:** the explicit switch. `none` is that no-op (not `AbsentPortError`: a
      `capture` must never fail a request), and the default is `posthog`, which requires the key. A deployment without
      a key then fails at boot until it says `none`: a `minor` change with a "To adopt" line, as every new required
      setting is (ADR-0014 part 10).
- **Auth is required, so it has no `none`**: a real deployment without an identity provider cannot sign anyone in.
- **Inbound email gets no `app`**: it would do nothing `none` does not (section 5).
- **`SssbApp` passes `app` through** as the variable's value. The app's adapter's own settings reach the server the way
  any app setting does, `server.addEnvironment` on the construct's function.

**The registration is split in two, because the registry is fragile at boot.** `createRealPorts` is awaited while the
registry (`packages/kit/src/adapters/index.ts`) is still being evaluated, so anything it loads then must not import
the registry, or boot deadlocks; and `sssb check-real-env` bundles `createRealPorts` as CommonJS, so everything that
module reaches, including through a literal `import()`, is in the bundle, and a top-level await anywhere in it fails
the bundle. That is why the in-process job runner is handed in as a hook today rather than imported
(`packages/kit/src/adapters/real/index.ts`, `RealPortsHooks`). The app's adapters follow the same rule:

- **`@sssb/app-config/adapter-env`: data only.** Which ports the app supplies, and the settings each one needs, each
  mapped to its cutover row:

    ```ts
    export const appAdapterEnv = {
        llm: { OPENAI_API_KEY: 'llm-openai' },
    } as const
    ```

    `assertRealEnv` and `sssb check-real-env` read it, so a missing setting of the app's adapter fails at boot with its
    row, as SSSB's own do. It imports nothing, so the bundle stays as it is.

- **`@sssb/app-config/adapters`: the factories.** The registry, not `createRealPorts`, imports it, by `import()`, only
  in real mode and only when some switch says `app`, and hands the factories to `createRealPorts` as hooks, as it hands
  in the in-process runner. Each factory receives what it may depend on, already built:

    ```ts
    import type { AppAdapters } from '@sssb/kit/ports/app-adapters'

    export const appAdapters: AppAdapters = {
        llm: { create: async () => (await import('@/adapters/real/openai')).createOpenAiLlm() },
    }
    ```

**The factory's full signature is settled in the first step, for every port, built or not.** Changing it later would
break every app adapter (see Consequences), so the first step fixes all of it:

- `create(ports)` receives the ports already built, so a job runner can build each handler's `JobContext` and an auth
  adapter can keep a cache in the database without importing the registry;
- the job runner's factory also receives the terminal-status notifier, and is loaded on first use, as the in-process
  runner is (`packages/kit/src/adapters/lazy-jobs.ts`);
- the auth provider's request middleware is a third seam module, `@sssb/app-config/auth-proxy`, which `withAuthProxy`
  loads in place of Clerk's (section 6). It cannot be an entry of `appAdapters`: the request proxy would then be
  compiled with every literal `import()` in that module, every app adapter and its SDK. The vendor ban covers
  `src/app-config`, so this module, like the factories, reaches its SDK only by `import()` from `src/adapters/real/`.

**What must be true of an app adapter, and how it is checked:**

- **Its module graph never reaches `@sssb/kit/adapters/index`.** A lint rule cannot see that: ESLint reads one file at
  a time, and the graph can reach the registry through a kit module or through the app's own registry, which the
  app-owned adapter recipe has import SSSB's. And a blanket ban over `adapters/real/` would wrongly forbid the app's
  own ports' adapters, which run after the registry has finished and may import it. So it is a graph check: esbuild
  follows the literal `import()`s of `adapters.ts` and `auth-proxy.ts`, as `sssb check-real-env` already bundles with a
  metafile, and fails when the registry is in either graph. A boot test that would deadlock without the check backs
  it. The recipe (`docs/recipes/app-owned-adapter.md`) says where each rule applies.
- **A switch set to `app` with no factory, or no `adapter-env` entry, fails at boot** naming the port.
- **A factory whose switch is not `app` is a boot-time warning** from the registry: only the deployment's environment
  knows the switch, and a deployment may flip it per environment.

An app that swaps nothing exports empty objects from all three, the "unused capability = empty registration" rule
(ADR-0012). The conformance suite's seam-map check imports every seam module the kit names, so each must exist in
every app: three new files on upgrade, said in the release note's "To adopt". A module-load test like the database
transports' in `packages/kit/src/adapters/real/index.test.ts` would prove that simulated mode and a deployment without
`app` load none of it.

### 4. The port contract suite: `@sssb/kit/testing/ports`

One Vitest suite per port that an app may supply, published as source like the conformance suite, taking a factory and
an opt-out map: `llmPortContract({ make, optOut })`, and so on. Its tests are named in a checks file, registered, opted
out by name with a reason and guarded against skipping, as the conformance suite's are
(`packages/kit/src/testing/conformance/register.ts`).

- **The main value is the fake-side run.** In SSSB the suite runs against every SSSB fake, in the `kit` Vitest project,
  on every CI run. That makes it the fakes' specification too, which nothing is today, and it is where a change to a
  port's behaviour shows. The protocol choices (section 1) get the same suite against their stand-ins.
- **The app's run is separate from the contract run.** The contract run (`tests/contract/`) is hermetic today: an
  embedded Postgres, no credentials. A suite against a live vendor needs its credentials, so it gets a runner and a
  directory of its own (`tests/ports/`), which an adopter's CI runs with a dev account's secrets, or a person runs at
  cutover. Without credentials it fails unless the app opts out with a reason naming the open cutover row; a suite that
  skips quietly when a secret is missing would be the vacuous gate this repository keeps refusing.
- **`sssb doctor`** fails when the app declares a port in `adapter-env` and no Vitest config runs that port's suite,
  less named opt-outs. Doctor evaluates none of an app's TypeScript today (it runs `vitest list` and reads text), so it
  would read `adapter-env` the way `sssb check-real-env` reads the real registry, bundled through esbuild. It keys on
  that module and not on `params.ports`: `packages/tools` has no reader for `config/params.ts`, and a deployment that
  does not use `SssbApp` may never read `params.ports`. The conformance
  register's runners are fixed at `unit` and `contract` today and register a runner's checks in one file, so the
  suites need a runner per port; that is part of the first step's cost.
- **What a suite can assert depends on the port, and what it cannot stays a cutover row**, as it does for SSSB's own
  adapters. Section 5 lists both for each port. Some assertions need a harness the suite must ship: the storage upload
  target needs an HTTP endpoint to post to (the fake's target is the app route `/api/storage-upload`, so the suite
  would call the kit's handler behind it directly), and a provider refusal cannot be induced on a fake without a
  fault-injection hook.

### 5. Port by port

| Port            | Required | Route                                  | Feasible                       | Cost              | Step |
| --------------- | -------- | -------------------------------------- | ------------------------------ | ----------------- | ---- |
| errors (Sentry) | no       | already the app's                      | already                        | none              | —    |
| storage         | optional | `s3` with an endpoint                  | yes; R2 needs a port change    | low               | 1    |
| email, outbound | optional | `smtp`                                 | yes                            | low               | 1    |
| email, inbound  | optional | the app's own route                    | yes, with an exemption         | very low          | docs |
| llm             | optional | `app`                                  | yes                            | medium            | 2    |
| analytics       | optional | `app`, after its switch                | yes                            | low, but breaking | 3    |
| jobs            | optional | `app`                                  | yes                            | medium            | 3    |
| auth            | required | `app`, after port changes              | yes                            | high              | 4    |
| db              | required | the `pg` transport to another Postgres | engine no; host yes, with work | medium            | —    |

**Errors (Sentry).** Not a port: instrumentation in the app's own files (ADR-0010). `scrubEvent` and
`SENTRY_V10_BASELINE` are Sentry-shaped, but only reached when the app wires Sentry. Another tracker is the app's
instrumentation, its SDK named in its `sssb.vendors`. Nothing to build.

**Storage.** The framework relies on: the upload target being an S3 presigned POST (`UploadTarget`: the fields, then
the file, as multipart) with the browser code written to it, and the fake serving the same shape locally; `list`,
`copy`, `head` and the `etag` having S3's semantics, all written into the port's comments; `SssbApp` building the bucket
and granting it. The suite asserts every behaviour those comments state: literal prefix listing sorted ascending,
idempotent batch delete, a copy that keeps the type and overwrites, `ifMatch` and `PreconditionFailedError`,
`NotFoundError` on a missing source, `head` null on a missing key, an upload target that refuses a wrong type or an
oversize body.

**Email, outbound.** Invitations, notifications and digests send through it; the framework's deferred mail catches and
logs any failure (`packages/kit/src/server-lib/defer.ts`). The suite asserts that `send` resolves for a well-formed
message and carries both the html and text. That a provider refuses rather than accepts and bounces later is not
something a suite can see; deliverability stays the cutover row it is for Mailgun.

**Email, inbound.** Not a port (ADR-0011): the route is the app's, and it calls `intakeInboundEmail`
(`@sssb/kit/inbound-email/intake`). Another provider is the app's own route with its own signature check. One thing is
in the way: the framework's `webhooks/` exemption from `authorize(...)` admits only a handler wrapped by
`withWebhookSecret` or `withMailgunSignature`, matched by name (`packages/kit/src/authz/route-policy.ts`), and an app's
exemption may not overlap a framework prefix. So a Postmark route under `src/app/api/webhooks/` fails the conformance
suite's `authz-mutations` check. The route lives outside `webhooks/` instead, under an exemption of the app's own in
`authz-exemptions.mjs`, gated `wrapped-by` the app's own verifier: the case `packages/kit/src/authz/app-exemptions.ts`
documents (a `withPartnerSignature` example) and its tests cover. The gate matches the wrapper by name only, so the
verifier's own test is what proves the signature check. No kit change is needed. The
switch stays `mailgun` or `none`: with another provider it is `none`, which already requires no Mailgun key.

**LLM.** The framework relies on: model ids being a closed union of Claude ids (`LlmModelId`,
`packages/kit/src/core/llm-models.ts`); fixtures and `pnpm llm:record` being Anthropic-shaped; the tool loop refusing a
tool name not among the definitions. The suite's live checks are structural, since a model's text is not
deterministic: `complete` returns text, `stream` concatenates to text, `runToolLoop` calls `execute` for a tool the
prompt demands, returns turns in the port's block shapes, ends in text and honours `maxTurns`. The unknown-tool refusal
is proven by the adapter's own unit test with its transport replaced, as SSSB's adapter's is.

**Analytics.** The Simulator's Events tab reads the fake. The switch comes first (section 3). The suite asserts that
`capture` never throws into a request and that `isFlagEnabled` returns the default for an unknown flag.

**Jobs.** The framework relies on: terminal transitions arriving through the jobs webhook route behind
`withWebhookSecret`, into `recordJobStatus`'s state machine; `sweep` failing lost jobs; the runner building each
handler's `JobContext` from the registry's ports; the in-process runner being loaded lazily so that boot does not
deadlock. The suite can assert, against a runner that calls back in-process, that a started job ends `completed` or
`failed` and that a handler's throw ends `failed`. That a vendor's runner reaches the webhook from outside needs an
endpoint the vendor can reach, so it is a cutover check, not a CI one.

**Auth.** The framework relies on Clerk in more places than the port:

- `realAuth` is imported statically by `createRealPorts`, so Clerk loads in every real deployment and in
  `sssb check-real-env`;
- the in-process job runner is handed `realAuth` directly, so with `auth: 'app'` its handlers would see a second auth
  adapter in the same process unless it is handed the registry's choice;
- `CLERK_SECRET_KEY` and `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` are required unconditionally (`REQUIRED_ENV`, and the
  required-environment snapshot);
- `withAuthProxy` (`@sssb/kit/adapters/proxy`) imports `./real/clerk-proxy` by name;
- the sign-in form, the invite-acceptance form and `RealAuthProviders` are Clerk's, mounted by the app's own route
  files (the starter's sign-in page loads the form; the showcase's layout and invite page mount the other two);
- one identity instance per tenant, the tenant in the user's metadata (ADR-0003).

The suite runs every method against a dev tenant: a member's standing and role per org, `restricted`, an invite
pending until accepted, `setActiveOrg` refusing a non-member, `getMember` null for a removed or banned user and kept
for a locked one. It cannot run in CI without a live tenant.

**Database.** Section 6's last example.

### 6. Worked examples

#### Cloudflare R2

- **The route: `s3` with an endpoint** (section 1). R2's endpoint, `STORAGE_REGION=auto` and an R2 access key; no app
  adapter, no `app` value, no third-party contract.
- **What R2 does implement.** Cloudflare's S3 compatibility page lists `CopyObject` with `x-amz-copy-source-if-match`,
  `HeadObject`, `ListObjectsV2` and `DeleteObjects` as implemented, so `copy`, `head`, `list` and `delete` keep their
  contract.
- **What it does not: the upload target.** R2's presigned URLs support GET, HEAD, PUT and DELETE, and its docs say
  "`POST` (multipart form uploads via HTML forms) is not currently supported". `createUploadTarget` is an S3 presigned
  POST, and its size ceiling is the policy's `content-length-range`, which a presigned PUT has no equivalent of. So on
  R2 the port's promise that "the storage backend must enforce" `maxBytes` cannot be kept as written.
- **What it would take**, decided when storage's step is built: the port's `UploadTarget` gains a PUT form (a URL and
  the headers to send), and the size is held another way. Two candidates, neither verified against R2 yet: the route
  takes the file's size first, refuses it above the limit and signs that exact `Content-Length` into the URL; or the
  upload lands under a staging key and is checked with `head` before the existing `copy` moves it into place, deleting
  an oversize one. The first enforces at upload if R2 honours a signed length; the second always works but stores the
  bytes first. The suite would hold the S3 adapter on both AWS and R2, and the fake, to whichever the port then says.
  Other S3-compatible stores need the same check of what they implement before an adopter relies on them.

#### Auth0

The port's methods map onto Auth0 with work, and four things do not map without a change.

- **Fits the port.** Auth0 Organizations are SSSB's orgs; an organization's `name`, its lowercase identifier, can be
  the slug. A role per membership is an organization member role. `createInvite` is the Management API's organization
  invitation with `send_invitation_email: false`, which returns the invitation URL instead of mailing it: the port
  already says sending the email is the caller's job, through the email port. `restricted`, the locale and the tenant go
  in the user's `app_metadata`. The active org can stay where the Clerk adapter keeps it, in the user's metadata, so
  `setActiveOrg` stays a server call.
- **The sign-in form.** Auth0 does not support the Resource Owner Password grant for applications that use
  Organizations, so a headless email-and-password form posting from SSSB's Mantine screen is not possible; sign-in is a
  redirect to Auth0's hosted Universal Login. The sign-in body is already a slot the app's own route file fills (the
  starter's `src/app/[locale]/signin/page.tsx` imports SSSB's Clerk form in real mode), so an Auth0 app can render a
  "continue" step there. But ADR-0003's "exactly one auth UI, used in every mode" stops being true for the credential
  step in real mode, and needs an addendum saying so. The invite-acceptance form is the same case: Auth0's invitation
  URL goes to Universal Login.
- **Sign-out.** The port's `signOut(): Promise<void>` ends the session server-side, and the app's glue then navigates
  home. Auth0 ends its session with a redirect to its logout endpoint. So the port changes, for every adapter: `signOut`
  returns where the browser goes next, which for Clerk is home.
- **The proxy.** Auth0's Next.js SDK (v4) also runs as middleware in the request proxy, where it mounts its `/auth/*`
  routes and keeps the session cookie. `withAuthProxy` would read `AUTH_PROVIDER` and, for `app`, load the `proxy`
  factory, without loading the registry, which the proxy must not (`packages/kit/src/adapters/run-mode.ts` exists for
  that reason). So the middleware comes from a seam module of its own, `@sssb/app-config/auth-proxy` (section 3), whose graph
  must not reach the registry either.
- **The rest of the Clerk wiring** (section 5): the static import, the in-process runner's `realAuth`, the
  unconditional `CLERK_*` settings. Each is a kit change.
- **Costs no suite measures.** `getMember` runs on every request that arrives without a session; on Clerk it is three
  API calls, and an Auth0 adapter would make its calls to the Management API, under that API's rate limits, so it will
  likely need a short cache, and the cutover row has to measure it.
- **Verdict:** feasible, after two port changes (sign-in as a slot that may redirect, sign-out returning a
  destination), the `auth-proxy` seam module, the Clerk wiring made conditional, and the ADR-0003 addendum. Build it when an
  adopter needs a provider other than Clerk, not before.

#### Another email or LLM provider

- **Email (Postmark, Resend, Amazon SES).** The `smtp` choice (section 1), with the provider's SMTP host and
  credentials. Inbound mail from another provider is the app's route plus `intakeInboundEmail`, outside `webhooks/`
  (section 5), with `INBOUND_EMAIL_PROVIDER` at `none`. Its replay guard is the app's to write; the Mailgun verifier's
  note that a multi-instance deployment needs a shared token store applies to any provider.
- **LLM (OpenAI, a self-hosted model).** An `app` adapter. It maps the port's two tiers, `LLM_MODELS.default` and
  `LLM_MODELS.fast`, to the provider's models; model ids stay out of the app's code as ADR-0009 requires, now pinned in
  the adapter's settings. The port's content blocks (`text`, `tool_use`, `tool_result`) map onto any tool-calling API,
  and the adapter must keep the trust rule: refuse a tool call whose name is not among the definitions. The fake still
  replays Anthropic-recorded fixtures, so the simulated world is deterministic whatever the real provider is; an app
  that wants fixtures recorded from its own provider writes its own recorder. Many providers and local servers speak an
  OpenAI-compatible API, which could one day be a protocol choice like `smtp`; it is not proposed here, because the
  tool-calling parts of that API vary between the servers that claim it.

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
      hold a credential that cannot reach another, or nothing enforces the separation. The framework's reads that come
      before a tenant is known (`tenants`, `organizations`, `service_keys`, the inbound mail's recipient lookup, the
      scheduled tick's walk over every tenant's schedules in `runDueSchedules`) need a control database beside the
      tenants', so `getDb()` changes meaning. Migrations fan out across every tenant's database with partial failure
      possible between them; Turso's schema-sharing feature for this is deprecated for new users, so the migrator would
      do the fan-out itself. The RLS proofs would be replaced by different proofs (a handle for one tenant cannot
      address another's database), and the guarantee would rest on credential scoping rather than on Postgres.
    - _One database, enforcement in the query layer_ (a Kysely plugin adding `tenant_id = ?` to every query). This is
      the query discipline ADR-0004 rejected ("query discipline is a promise and a policy is a mechanism"): raw `sql`
      escapes it, nothing equivalent to `WITH CHECK` refuses a cross-tenant write, and no negative control can show the
      proofs are not vacuous. SSSB should not offer it as its guarantee.
- **What else would have to fork.** The framework's migrations are Postgres DDL (`uuid`, `timestamptz`, `jsonb`,
  policies, grants, `DO` blocks); its domain modules write Postgres SQL; the fake database is pglite; `SssbApp` builds
  Aurora. A libsql SSSB is a second data layer maintained beside the first, with its own proofs, which is ADR-0002 and
  ADR-0004 decided twice.
- **What is open instead, and what it costs.** If the reason for Turso is cost, scale-to-zero or a database reachable
  without a VPC, another Postgres host reached by the `pg` transport's `DATABASE_URL` is the route, and the RDS Data
  API transport already serves an Aurora outside a VPC. Another host is not configuration alone:
    - it must be genuine PostgreSQL 16 or later, not an engine that speaks its wire protocol: the tenancy rests on
      `FORCE ROW LEVEL SECURITY`, roles and `set_config`;
    - the migrating owner must be allowed to create roles, because migration 0001 creates `app_user`, and to grant
      itself the switch to it (0015); some managed hosts restrict role creation;
    - the application's role must hold neither `SUPERUSER` nor `BYPASSRLS` (cutover row `db-role-not-superuser`); some
      hosts hand out a default role that bypasses row-level security;
    - the only migration entry point SSSB ships is a Lambda handler that reads its credentials from AWS Secrets
      Manager (`packages/kit/src/adapters/real/migrate-handler.ts`), so a host off AWS needs a migrate command SSSB
      does not have yet;
    - real mode requires `AWS_REGION` today (storage's region and the CodeBuild runner read it), and `STORAGE_BUCKET`
      until the sibling's storage switch lands;
    - `SssbApp` always builds Aurora, so a non-AWS Postgres is deployed by the adopter's own infrastructure, which
      `databaseNameFor` already allows for;
    - the `pg` adapter itself is `AUTHORED — CUTOVER`, never run against a deployed database, so none of this is proven
      on any host yet.

    If the reason is a database per tenant, that is a tenancy redesign, and it belongs in its own ADR against ADR-0004,
    Postgres or not.

### 7. What it does to the other ADRs, if accepted

- **ADR-0002:** Postgres is the engine for every app; "a different database" means a different Postgres host, under
  the conditions in section 6; a new transport is SSSB's to ship and prove.
- **ADR-0003:** Clerk becomes SSSB's default adapter, not the only one; in real mode an app's adapter may put the
  credential step on its provider's hosted page; `signOut` returns where the browser goes next; `withAuthProxy` runs
  the chosen provider's middleware.
- **ADR-0004:** no swap reaches it, because the database is not swappable, and why.
- **ADR-0009:** Anthropic is the default; model ids stay pinned in one place per adapter; fixtures stay
  Anthropic-recorded for the fake.
- **ADR-0010:** analytics gains an explicit switch with `none` as a no-op and `app`; Sentry is already the app's
  choice.
- **ADR-0011:** Mailgun is the default; `smtp` covers other outbound providers; another inbound provider is the app's
  route outside `webhooks/`.
- **ADR-0012:** the seam gains `@sssb/app-config/adapter-env`, `@sssb/app-config/adapters` and
  `@sssb/app-config/auth-proxy`. The line does not move:
  the app's adapter is app code, and the kit reaches it only through the seam.
- **ADR-0014:** the published surface gains `@sssb/kit/testing/ports` and the adapters type; the required-environment
  snapshot gains the new choices (a `minor` change each).

### 8. Order

0. **Now, without accepting this ADR:** the analytics patch (real mode without a key gets a no-op, never the fake),
   checked on a deployment first; and, in the adopter reference, that error tracking is already the app's and how an
   inbound route for another provider is exempted outside `webhooks/`.
1. **The protocol choices, each when an adopter asks:** `s3` with an endpoint (and, for R2, the upload target's PUT
   form), and `smtp`. Each with its suite run against the fake and the protocol's stand-in.
2. **The `app` mechanism, proven on the LLM**, whose suite has substance and whose adapter needs no other port: all
   three seam modules, the full factory signature for every port, the registry's hook, the graph check and the boot
   test that keep app adapters out of the registry's graph, the per-port runner, the doctor check, and the LLM suite. A scratch
   adapter in a pack-and-consume shape would show an app can register one, as that script already proves an app-owned
   adapter.
3. **Analytics** (its switch first, a breaking change) **and jobs**, whose suite has to model an asynchronous runner.
4. **Auth**, when an adopter needs it: the two port changes, the `auth-proxy` seam module, the Clerk wiring made conditional, and
   the ADR-0003 addendum.
5. **Never, under this ADR: the database engine.** A migrate command for Postgres hosts off AWS is its own step, when an
   adopter needs one.

## Rejected alternatives

- **Ship R2, Auth0, Turso, Postmark or OpenAI adapters in the kit.** Each fails both tests in "What SSSB ships": not
  universal, and no integration class SSSB does not already teach. The protocol choices are not this: one adapter per
  protocol, not per vendor.
- **An app adapter for every port, protocols included.** It would serve R2 and Postmark too, but at the price of a
  third-party contract on storage and email, which the protocol choices avoid.
- **The app supplies the fake as well.** The Simulator reads the fakes' state, and the hermetic promise would become
  each app's to keep. A swap that changes `pnpm dev` is a different product than the one SSSB tests.
- **One seam module holding both the settings and the factories, read by `createRealPorts`.** `sssb check-real-env`'s
  CommonJS bundle would take in every app adapter's module graph, and `createRealPorts` runs while the registry is still
  being evaluated, so an adapter that reached the registry would deadlock boot.
- **A factory that takes no arguments.** A job runner and a caching auth adapter need the other ports, and could only
  get them from the registry, which deadlocks; widening the signature later would break every app adapter.
- **An environment variable naming a module for the registry to import.** No bundler or tracer can see it (Next's
  standalone output, `sssb check-real-env`'s esbuild bundle), no lint rule can fence it, and the app's adapter would
  ship or not by accident.
- **The app wraps the registry** (its own `adapters/index.ts` re-exporting SSSB's with one port replaced). The
  framework's own modules import `@sssb/kit/adapters/index` directly, so they would keep SSSB's adapter while the app's
  code used the app's: two adapters for one port in one process.
- **A `DbPort` the app supplies.** The port's contract is `Kysely<DB>` speaking Postgres under row-level security; "a
  libsql `DbPort`" would satisfy the type and none of the behaviour the framework relies on.
- **Inferring `app` from the presence of a registered factory, or analytics from the presence of a key.** The switch
  rule: a deployment that half-configures a port must fail at boot, not quietly change adapter.
- **`app` for inbound email.** It would change nothing `none` does not, and widen two switch tables and the
  required-environment snapshot for it.
- **Running the vendor suites in the contract run.** It is hermetic today; credentials in it would make every
  adopter's contract run depend on a vendor account.
- **A suite that skips when the vendor's credentials are absent.** It would pass in every CI that never configured
  them, which is every CI at first.

## Consequences

- **Kit ports with `app` become a public contract with third-party implementations.** Today a port can gain a method
  in a `minor` release because SSSB writes every adapter. Once apps write adapters, adding a method or tightening a
  behaviour breaks them: a port change becomes a breaking change, the contract suite is where it shows, and the release
  note's "To adopt" says what each app adapter must add. This is the largest cost, and it is permanent, which is why the
  protocol choices come first and `app` is limited to the ports with no protocol.
- The fakes get a specification, which they lack today, and SSSB's own real adapters get a suite to run at cutover.
- Three new seam modules in every app, empty for most.
- The database answer is a firm no to a different engine, stated with its reason, and a conditional yes to another
  Postgres host, with its conditions named.
- Auth stays the hardest swap; the proposal does not pretend otherwise, and ADR-0003 is amended rather than worked
  around.

## Sources for the vendor facts

Checked on 2026-11-19; each would be re-checked when its port's step is built.

- Cloudflare R2, presigned URLs: `https://developers.cloudflare.com/r2/api/s3/presigned-urls/` (GET, HEAD, PUT,
  DELETE; POST "not currently supported").
- Cloudflare R2, S3 API compatibility: `https://developers.cloudflare.com/r2/api/s3/api/` (`CopyObject` with
  `x-amz-copy-source-if-match`, `HeadObject`, `ListObjectsV2`, `DeleteObjects`).
- Auth0, the Resource Owner Password grant with Organizations:
  `https://support.auth0.com/center/s/article/auth0-automated-tests-fail-with-ropg-flow-when-organizations-are-enabled`,
  and Auth0 staff on `https://community.auth0.com/t/password-grant-type-not-allowed-with-organizations/112761`, which
  cite the limitations Auth0 lists for Organizations.
- Auth0, organization invitations: `https://auth0.com/docs/organizations/send-membership-invitations`
  (`send_invitation_email: false` returns the URL for the app to deliver).
- Auth0 Next.js SDK v4, middleware in `proxy.ts` mounting `/auth/*`:
  `https://auth0.com/blog/handling-auth-nextjs16-with-server-actions-middleware/`.
- Turso, multi-DB schemas deprecated for new users: `https://docs.turso.tech/features/multi-db-schemas`.
