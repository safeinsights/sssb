# @sssb/kit

## 0.9.0

### Minor Changes

- 7fdb607: ### `publicOrigin` and `clientAddress`, and a lint rule against reading the raw request

    **Kind.** seam

    **Action.** required

    **What changed.** A new subpath, `@sssb/kit/adapters/edge-headers`, gives an app the visitor's origin
    (`publicOrigin(request)`) and address (`clientAddress(request)`). Behind `SssbApp`, `request.url` and `nextUrl` name the
    server's own bind address and port (3000), never the visitor's host, and the first `X-Forwarded-For` entry is whatever the visitor
    wrote. A new rule in the app preset, `sssb/no-raw-request-origin`, fails a module under `src/` (tests aside) that:

    - reads a forwarded header by name from a request's headers (`request.headers.get('x-forwarded-for')`, `X-Real-IP`,
      `CF-Connecting-IP`, `Forwarded`, `Host`, the other `X-Forwarded-*`);
    - takes the `origin`, `host`, `hostname` or `href` of `new URL(request.url)` or of `request.nextUrl`, by member or
      destructuring;
    - builds `new URL(path, request.url)` (or on `request.nextUrl`), a redirect included, except in the app's own
      `src/proxy.ts` (or `src/middleware.ts`), where Next relativizes a same-origin redirect or rewrite and nowhere else: a
      route handler's `NextResponse.redirect(new URL('/en/dashboard', request.url))` sends the visitor to the server's bind
      address;
    - passes `baseUrl: request.url`.

    "The request" is an object named `req`, `request` or `nextRequest` (with or without a leading `_`), or a `.req` or
    `.request` member (`ctx.request`): the `url` of a webhook, a row or a form field is someone else's, and reading its
    origin is correct code. The rule reads names, not types, so a request held under another name gets past it, as does
    the request's URL stored in a variable and used later, or a `request.nextUrl.clone()` handed to a redirect
    (safeinsights/sssb#242).

    **To adopt.** Run `pnpm lint` after upgrading. For each finding:

    ```ts
    import { clientAddress, publicOrigin } from '@sssb/kit/adapters/edge-headers'

    // A link a visitor follows: an email, a URL you store.
    const link = new URL(`/${locale}/accept-invite`, publicOrigin(request)).toString()

    // A rate limit, a lockout, an audit record's "from". undefined means unknown: never a free pass.
    const from = clientAddress(request)
    ```

    A redirect needs neither: `redirect('/path')` (from `next/navigation`) and a relative `Location` are right as they are; in
    a route handler, write `NextResponse.redirect(new URL('/en/dashboard', publicOrigin(request)))`. Reading `pathname` or
    `searchParams` from the request's URL is still allowed. Outside a request (a job), `publicOrigin()` needs the server's
    `PUBLIC_ORIGIN` (the operator entry of this release). In `pnpm dev`, `publicOrigin` is the dev server's own origin and
    `clientAddress` is `undefined`.

    **Now deletable.** A helper that builds the app's origin from `x-forwarded-host` and `x-forwarded-proto`, or from
    `request.url`; one that takes the client's address from `X-Forwarded-For`, `X-Real-IP` or `CF-Connecting-IP`; and a
    `baseUrl: request.url` passed to `sendOrgInvite` or `applyDemoPreset` (pass `publicOrigin(request)`).

- 266f4dd: ### A request can create, rename and delete teams in its own tenant

    **Kind.** migration

    **Action.** optional

    **What changed.** Framework migration `0018_organizations_write` grants `app_user` `INSERT` (of a team's tenant, slug
    and name), `UPDATE` (of its name) and `DELETE` on `organizations`, behind row-level security that confines each write
    to the request's tenant: reads stay open across tenants, as before, a new team may not take a slug another tenant's
    team holds, and `TRUNCATE` is not granted. It also adds a
    unique constraint over `(tenant_id, id)`, so an app table can pin its team to its own tenant with a composite foreign
    key. Before this, a route that wrote a team inside `withTenant` failed with `permission denied`.

    **To adopt.** Nothing to do for the migration: it runs with the others. A route that creates, renames or deletes a
    team writes it inside `db.withTenant(tenantId, ...)`, after `authorize(...)` on its own subject. A team's slug and id
    are not a request's to change: the slug names the team to the auth provider and in its inbound mail address. To keep a table's team
    in its own tenant, declare `FOREIGN KEY (tenant_id, org_id) REFERENCES organizations (tenant_id, id)` in a new
    migration of yours. If a database role other than the table owner writes `organizations` outside `withTenant` (a sync
    through a raw handle on a separate application role you granted writes yourself), that write is now held to the tenant
    policies: run it inside `withTenant` for the team's tenant, or as the owner.

    **Now deletable.** A raw-client exception (an entry in `lint-exceptions.mjs`) that exists only so a route can write
    `organizations` as the table owner.

- 7fdb607: ### `PUBLIC_ORIGIN`, and the visitor's address from `SssbApp`'s edge

    **Kind.** operator

    **Action.** required

    **What changed.** `SssbApp`'s viewer-request CloudFront Function now also writes `x-sssb-viewer-address`, the address
    CloudFront took from the visitor's connection, over any a visitor sent, and the construct sets `SSSB_EDGE=cloudfront` on
    the server, which tells `@sssb/kit`'s `publicOrigin` and `clientAddress` to believe that header and `x-forwarded-host`.
    Without `SSSB_EDGE` (in `pnpm dev`, or on a host of your own) neither reads a forwarded header, and the server refuses
    `SSSB_EDGE` off Lambda. A new optional server setting, `PUBLIC_ORIGIN`, is the origin `publicOrigin` returns wherever
    it is set, in a request and outside one. A malformed `PUBLIC_ORIGIN`, or an `SSSB_EDGE` other than `cloudfront` or off
    Lambda, fails `sssb check-real-env` and the server's boot, naming cutover row `domains-and-certs`. `cdk synth` now
    fails a behavior that reaches the server without `sssbApp.forwardedHost` on `viewer-request`, on any distribution in
    the construct's stack, an origin group's included.

    **To adopt.** Redeploy with this `@sssb/cdk`. Once the deployment has a custom domain, set the server's `PUBLIC_ORIGIN`
    to its origin, a bare origin with no trailing slash (`PUBLIC_ORIGIN=https://app.example.org`), so every link names it
    rather than the host a visitor came in on; set it too wherever a job, or the cron route the scheduled tick calls, builds
    a link. If synth now fails naming a behavior, give that behavior the function:
    `functionAssociations: [{ function: sssbApp.forwardedHost, eventType: FunctionEventType.VIEWER_REQUEST }]`. Without it,
    a visitor writes the host and address the server believes. Never set `SSSB_EDGE` yourself.

- 394e053: ### `STORAGE_UPLOAD_TARGET=put` for a store that takes a presigned PUT

    **Kind.** operator

    **Action.** optional

    **What changed.** `STORAGE_UPLOAD_TARGET` (read with `STORAGE_PROVIDER=s3-compatible`) accepts `put` beside `post` and
    `none`: `createUploadTarget` then mints a presigned PUT, which Cloudflare R2 accepts and a presigned POST it does not.
    It is not a new required variable, so the required-environment snapshot is unchanged. `createS3Storage` takes the same
    choice as `uploadTarget: 'put'`; the client it builds then defaults `requestChecksumCalculation` to `WHEN_REQUIRED`,
    and a client you pass in must already be set so (the SDK's default signs the checksum of an empty body into the URL,
    and `createUploadTarget` throws, naming the setting, when it sees one).

    **To adopt.** On R2, set `STORAGE_UPLOAD_TARGET=put`, pass `sizeBytes` when you mint (see the `UploadTarget` change),
    and give the bucket a CORS rule that lets your app's origin `PUT` with the `Content-Type` header. Check on a real
    bucket that an upload lands at the key, that a body of another length or type is refused, and whether R2 holds the
    signed length or your `head` check does; cutover row `storage-compatible-store` says how.

    **Now deletable.** A route that receives the file and calls `put` only because the store had no presigned POST.

- 394e053: ### `UploadTarget` has a PUT form, for stores without presigned POST

    **Kind.** seam

    **Action.** required

    **What changed.** `StoragePort.createUploadTarget` returns an `UploadTarget` that is now one of two shapes: a
    `PostUploadTarget` (`{ url, fields }`, with an optional `method: 'POST'`, unchanged for a store that has presigned
    POST) or a `PutUploadTarget` (`{ method: 'PUT', url, headers }`: the browser PUTs the file as the body). Code that
    reads `target.fields` no longer typechecks until it narrows. An app that stays on `s3` or a POST store gets the same
    value at run time, plus `method: 'POST'` (a test that compares the whole target must expect it). `UploadConstraints` gains an optional `sizeBytes`, the exact size of the file the browser
    will send. A PUT has no size policy, so its URL signs that size, and an adapter minting a PUT refuses a call without
    it. `createFakeStorage({ uploadTarget: 'put' })` (`@sssb/kit/adapters/fake/storage`) is the fake's PUT form, and its
    `/api/storage-upload` twin in the showcase serves it.

    **To adopt.** Where your server passes `createUploadTarget`'s result through as JSON, change nothing but its type
    (`UploadTarget`). Where it reads `.fields`, narrow first: `if (target.method === 'PUT') { … }` (a target whose
    `method` is absent is a POST). In the browser, switch the same way: a POST appends `fields` and then the file to a
    `FormData`; a PUT is `fetch(target.url, { method: 'PUT', headers: target.headers, body: file })`. If your mint route
    has the client's file size, pass it as `sizeBytes` beside `maxBytes` (and refuse one over `maxBytes` first); a POST
    store ignores it. A route that must hold the ceiling on a PUT store should `head` the object when the upload is
    confirmed and `delete` one over `maxBytes`: the store holds a signed length only if it honours one. Your own storage
    adapter (`@sssb/kit/ports/storage`) may keep returning the POST shape as it is.

### Patch Changes

- 2046326: ### The Simulator host takes an app's own tabs, and shows the dev ticker where the app serves it

    **Kind.** seam

    **Action.** optional

    **What changed.** `SimulatorHost` (`@sssb/kit/components/simulator/simulator-host`) takes `extraTabs`, the panel's own
    `SimulatorExtraTab[]`, and exports `useSimulatorWorld()`, which an app's tab content calls to read the world's jobs
    (polled while that tab is open). Both are provisional until safeinsights/sssb#152 decides how an app's tabs reach the
    host, and may change shape then. The Jobs tab's dev ticker control now shows on the host wherever the app's own
    `src/app/api/simulator/ticker/route.ts` answers; where it answers 404, as SSSB's catch-all does, there is no ticker,
    as before.

    **To adopt.** Nothing, unless your app registers its own Simulator tab (`@sssb/app-config/simulator` `tabs`) and kept
    a glue of its own to show it: you can now pass the tab to `SimulatorHost` as `extraTabs` from your locale layout
    instead, as SSSB's reference app does (in SSSB's repository at this release:
    `apps/showcase/src/app/[locale]/simulator-glue.tsx`).

    **Now deletable.** A Simulator glue that re-implements the panel's fetching, polling and notices only to add an app's
    own tab or the dev ticker control, with every `api/simulator/<path>/route.ts` it called that SSSB's catch-all now
    serves; keep the routes your own tab's pages call and the ticker route.

- 27d0a99: ### Corrections from the release review

    **Kind.** none

    **Action.** none

    **What changed.** SSSB's plugin commands `/sssb:new-actor` and `/sssb:a11y-review` now describe the `pnpm dev`
    Simulator panel as this release builds it: `SimulatorHost` takes an app's own tabs (`extraTabs`), and a generated
    app's panel has every framework tab but Actors, and Tours until the app registers one. The starter's Simulator route
    comment names Tours. A comment in `@sssb/cdk`'s viewer-request function no longer says `clientAddress` reads
    `X-Forwarded-For`. Two client races in the Simulator host that this release added, never released, are fixed: a poll
    of the dev ticker no longer overwrites a start or stop, and the Snapshots tab's refreshes no longer land out of order.

- 07e44c6: ### The Simulator's Snapshots tab, demo presets and tours on an app's own `pnpm dev`

    **Kind.** none

    **Action.** none

    **What changed.** `simulatorApi` (`@sssb/kit/server-lib/simulator-api`) now also serves the world's knobs: `reset`,
    `snapshots` (GET a list, POST `{ name }` to save), `snapshots/restore` and `snapshots/delete` (`{ name }`), `flags`
    (GET every known flag, POST `{ flag, enabled }`), `agreements` and `agreements/bump` (`{ agreementId }`), and `presets`
    (`{ name, locale }`, answering `{ redirectTo }`). Each keeps the host's rules: simulated mode only (404 in a real
    build), JSON-only POSTs (415 otherwise), no role gate. `SimulatorHost` wires them into a Snapshots tab (reset, save,
    restore and delete snapshots, flip a feature flag, bump an agreement, load a demo preset) and, when the app registers
    any tours, a Tours tab, whose tours start their world through the same reset, preset and restore calls. A reset, a
    restore or a preset load reloads the page and says what it did in the panel; a flag reloads it too. An app that mounts
    the catch-all route and `SimulatorHost` gets all of it with nothing to change.

- f4d90ee: ### The Simulator's Events, Messages, inbound mail, Hooks and Errors tabs on an app's own `pnpm dev`

    **Kind.** none

    **Action.** none

    **What changed.** `simulatorApi` (`@sssb/kit/server-lib/simulator-api`) now also serves `events` and `audit` (the
    Events tab, the audit trail beneath it), `messages` (every caught SMS), `inbound` and `inbound/compose` (inbound mail
    beside the Mail tab, taken in through the same intake as the real inbound webhook), `webhooks`, `webhooks/fail` and
    `webhooks/run-due` (the Hooks tab), and `error-scenario` (the Errors tab's server event, before and after scrubbing).
    Each keeps the host's rules: simulated mode only (404 in a real build), JSON-only POSTs (415 otherwise), no role gate.
    `SimulatorHost` wires the tabs, so an app that mounts the catch-all route and `SimulatorHost` has every framework tab
    but the Actors tab and the Jobs tab's dev ticker. The Mail tab's inbound section appears only when the app registers
    an inbound handler. `events` answers `{ events }` alone; the flags are on `flags`.

- bfe9fd6: ### A verifier for Standard Webhooks senders

    **Kind.** seam

    **Action.** optional

    **What changed.** A new subpath, `@sssb/kit/service-auth/standard-webhooks`, verifies a sender that signs Standard
    Webhooks (the scheme Svix signs with): the `webhook-id`, `webhook-timestamp` and `webhook-signature` headers, or Svix's
    `svix-*` names, over the exact body. `withStandardWebhookSignature(handler, { secretEnv })` refuses a timestamp more
    than five minutes from the server's clock either way, a signature that does not match one of the configured `whsec_…`
    secrets (keys of at least 16 bytes) in constant time, and the same signed message a second time, with the same opaque 401 the other webhook
    wrappers answer. Several secrets, in one variable or several, verify side by side for a rotation. The `webhooks/`
    exemption of the authorization scan accepts a handler that is this call, as it accepts `withWebhookSecret(…)`. It adds
    nothing to the required environment.

    **To adopt.** Put the sender's secret in a server variable of your choosing and wrap the route under
    `src/app/api/webhooks/`; the handler gets the verified message and should treat its id as the idempotency key, since a
    sender's retry is re-signed and reaches it again:

    ```ts
    import { withStandardWebhookSignature } from '@sssb/kit/service-auth/standard-webhooks'

    export const POST = withStandardWebhookSignature(
        async ({ webhook }) => {
            // webhook.id, webhook.timestamp, webhook.body (the raw text)
            return Response.json({ ok: true })
        },
        { secretEnv: 'PARTNER_WEBHOOK_SECRET' },
    )
    ```

    Make the handler idempotent on `webhook.id` even so: the guard against a replayed message is in memory, and a deployment
    runs on Lambda, where each concurrent execution environment keeps its own. Pass `replayStore` (`claim` and `release`
    over a shared table) to make the guard hold across them.

    **Now deletable.** A hand-rolled Standard Webhooks or Svix signature check (an HMAC over `id.timestamp.body`), and the
    `svix` package where it was only used to verify.

- bfe9fd6: ### A webhook route can read its shared secret from a variable of its own

    **Kind.** seam

    **Action.** optional

    **What changed.** `withWebhookSecret` and `verifyWebhookCaller` (`@sssb/kit/service-auth/webhook`) take an optional
    `{ secretEnv }`, the environment variable real mode reads the shared secret from. It defaults to `WEBHOOK_SECRET`, so
    every existing route behaves as before, and simulated mode still uses the per-checkout dev secret. A name that is not
    a server-only variable (lower case, a dash, or `NEXT_PUBLIC_*`) throws a `TypeError`: from `withWebhookSecret` when
    the route module loads, from `verifyWebhookCaller` on each call.

    **To adopt.** For a sender whose secret is already deployed under another name, pass that name and set it on the
    server; SSSB's real-environment checks know only `WEBHOOK_SECRET`, so add the variable to your own cutover checklist:

    ```ts
    export const POST = withWebhookSecret(handler, { secretEnv: 'PARTNER_HOOK_SECRET' })
    ```

    **Now deletable.** A copy of the constant-time shared-secret check kept only to read a differently named variable.

## 0.8.0

### Minor Changes

- f05a2d0: ### Name the origins whose Clerk session tokens a deployment accepts

    **Kind.** operator

    **Action.** optional

    **What changed.** A new optional server setting, `CLERK_AUTHORIZED_PARTIES`: the app's own origins, comma-separated,
    handed to Clerk's middleware as `authorizedParties`. With it set, a request whose session token was minted for another
    origin, or names none, is signed out. Unset, nothing changes. A malformed value (a path, a trailing slash, upper case, a
    wildcard, a duplicate, `http` other than for `localhost`, `127.0.0.1` or `[::1]`, an empty entry or an empty value)
    fails every request the server answers, naming the entry, and `sssb check-real-env` reports it on cutover row
    `auth-dev`.

    **To adopt.** If your app shares its Clerk instance with another product, or your policy requires the check, set
    `CLERK_AUTHORIZED_PARTIES` in each deployment's server environment to every origin that deployment is served from,
    custom domain, CloudFront host and preview hosts included, each written as a bare origin:
    `CLERK_AUTHORIZED_PARTIES=https://app.example.org,https://d1234abcd.cloudfront.net`. Then sign in and check a page
    and an API route still see you signed in: a wrong list signs everyone out. SSSB's adopting reference, "How sign-in
    places people", has the details.

- 4126c2d: ### Sign in with an enrolled second factor

    **Kind.** seam

    **Action.** required

    **What changed.** `RealSignInForm` (`@sssb/kit/adapters/real/sign-in-form`) now signs in a person whose account has a
    second factor: after the password it asks for a code from an authenticator app, a text message, an email or a set of
    backup codes, whichever the account offers, with a choice and a resend. It does the same for the provider's check of a
    new device. It used to stop there with a message that it was not built. A factor it takes no code for (a passkey, an
    emailed link), and any other status it does not know, gets a message that says so.
    `SignInLabels` loses `mfaNotImplemented`, and the framework catalog loses `auth.mfaNotImplemented`.

    **To adopt.** Delete this line from your sign-in page's `labels` (`src/app/[locale]/signin/page.tsx`); with it left in,
    a page that writes the labels inline no longer typechecks, and any other logs a missing message:

    ```ts
    mfaNotImplemented: t('mfaNotImplemented'),
    ```

    The form reads the rest of its copy from the framework's catalog, so it
    must render under `NextIntlClientProvider`, as `SignInScreen` must. Once you have tried it on your provider's development
    instance (the `auth-dev` row of SSSB's cutover checklist), an operator whose provider requires a second factor can use
    SSSB's form. It signs in with a factor a person already has: enrolling one still happens outside SSSB.

    **Now deletable.** A sign-in form of your own written to handle a second factor or a new-device check.

## 0.7.0

### Minor Changes

- 8909e3c: ### One wait for a paused Data API cluster, and a typed error after it

    **Kind.** operator

    **Action.** required

    **What changed.** On the `data-api` transport, a request that wakes a paused Aurora Serverless v2 cluster now makes one
    wait, shared by every call that waits and polled about every second, instead of a growing backoff in each call. A call
    waits 18 seconds by default. A `BeginTransaction` that is throttled joins the wait; a statement is still sent again
    only after `DatabaseResumingException`, and never once another statement has succeeded in its transaction. When the
    wait runs out, or the Data API throttles a statement, times it out, or says the writer or the service is not available,
    the error is now `DatabaseUnavailableError` (`@sssb/kit/ports/errors`), with AWS's error as its `cause`. A few answers
    that the database is resuming fail at once with it, without a wait: to a commit, whose outcome is then unknown, so
    never assume that it failed; to a statement after another has succeeded in its transaction; and to a statement as a
    `BadRequestException`. A `pg` deployment is unchanged.

    **To adopt.** On `pg`, nothing. On `data-api`, answer the error as you would a busy service; the starter's
    `withPortErrors` does it (the scaffold entry of this release). Code that matched the thrown error's `name` against
    `DatabaseResumingException`, `ThrottlingException`, `StatementTimeoutException`, `DatabaseUnavailableException` or
    `ServiceUnavailableError` must use the typed error instead, or it stops matching:

    ```ts
    import { DatabaseUnavailableError } from '@sssb/kit/ports/errors'

    if (error instanceof DatabaseUnavailableError) {
        // error.reason: 'resuming' | 'throttled' | 'timed-out' | 'unavailable'
    }
    ```

    Repeat a read by itself if you like, and a write only when the person asks: treat a throttled or timed-out statement or
    commit as if it may have run. The wait is set on the server, in milliseconds, and checked at boot; 0 fails at once.
    Leave room for the rest of the request under the server's 30-second timeout. In `infra/app.ts`, with the construct kept
    (`const sssbApp = new SssbApp(...)`), before `app.synth()`:

    ```ts
    sssbApp.server.addEnvironment('DATABASE_RESUME_BUDGET_MS', '10000')
    ```

    **Now deletable.** Code that searches an error and its causes for AWS names, or for "is resuming", to tell that the
    database is waking up.

### Patch Changes

- 77ddaf9: ### Avatar initials skip punctuation

    **Kind.** none

    **Action.** none

    **What changed.** The user menu's avatar and the identity rows (the menu's header, the team switcher) took the first
    character of each of the first two words of a name (the first two characters of a one-word name), punctuation
    included, so `Ana (Bea) Cruz` showed `A(`. They now show the first letters of the first and last words that start with
    a letter, uppercased: `AC`. A one-word name shows one letter, where it showed two. A person with no such word shows
    the first letter (or digit) of their email.

## 0.6.1

### Patch Changes

- 7990d2d: ### Under a fixed org source, grant your own people before denying on `restricted`

    **Kind.** seam

    **Action.** optional

    **What changed.** The guide and the adopter reference now say what a fixed org source means for an app's rules.
    Everyone it signs in has the role `none` (or `restricted`), and both are restricted, so `restricted` is `true` for
    everyone and cannot tell an app's own admins from anyone else. `none` stays restricted on purpose, so nothing opens
    silently.

    **To adopt.** If you use a fixed org source (`params.auth.orgSource: 'fixed'`), check every rule in `appAbilityRules`,
    and every route or screen that reads `user.restricted`. Each must grant your own people from your own data before it
    denies on `restricted`. A check that denies on `restricted` first locks everyone out, your own admins included.

    - Key the grant on `actor.userId`, never on an email.
    - If only the person at the keyboard should have it, also check `actor.credential?.kind === 'session'`: an API token or
      an inbound email reaches your rules with the same `userId`.
    - Your rules see `none` in no org (`sameOrg` is false), so a grant scoped to the home org needs
      `defaultRole: 'restricted'`.

- 7990d2d: ### A fixed org source names its home org by the org row

    **Kind.** none

    **Action.** none

    **What changed.** Under a fixed org source, the org switcher (`listMyOrgs`) showed the home org's slug. It now shows
    the org row's name, read per call, and still shows the slug when the row is missing.

- 7990d2d: ### A person the tenant guard refuses can see why

    **Kind.** seam

    **Action.** optional

    **What changed.** Under a single tenancy, a person whose identity-provider account names another tenant (or holds a
    tenant claim that is not a slug) is refused.
    Before, they saw the sign-in form again while still signed in to the provider, with nothing saying why.

    - The auth port gains an optional `refusal()`, which answers `{ reason: 'other-tenant' }` for such a person, and null
      otherwise.
    - A new framework screen, `AccountRefused` (`@sssb/kit/components/auth/account-refused`), says the account belongs
      to another site. It offers one sign-out button, and says first that signing out also signs the person out of other
      sites that share the sign-in. Nothing signs them out on its own.
    - Its real-mode form, `RealAccountRefused` (`@sssb/kit/adapters/real/account-refused-form`), signs out through Clerk's
      client. Without that, the browser's short-lived session token would bring the same screen back.

    **To adopt.** In your sign-in page, after the `getCurrentUser` redirect, check `await auth.refusal?.()`. When it
    answers, show the screen instead of the sign-in form:

    - in real mode, `RealAccountRefused`, loaded with `import()`;
    - in simulated mode, a small client glue that renders `AccountRefused` and posts JSON to your sign-out route.

    The starter's `src/app/[locale]/signin/page.tsx` and `refused-glue.tsx` show both.

- ba4c09d: ### The Migrator runs on the RDS Data API

    **Kind.** operator

    **Action.** optional

    **What changed.** On the Data API transport (`DATABASE_TRANSPORT=data-api`) the Migrator failed on its first
    statement with `UnsupportedResultException: The result contains the unsupported data type "CHAR"`. That statement is
    Kysely's introspection, which selects `pg_class.relkind`, a one-byte `"char"` the Data API cannot return. The Data API
    dialect now gives Kysely an introspector that reads the same thing with `relkind` cast to text. The Data API emulator
    that `pnpm test:contract` runs on now refuses a result with a `"char"` column, as the Data API does, and also a
    `char(n)` column and arrays of either, which the Data API very likely refuses too (the same JDBC type, unconfirmed). So a
    statement the contract run sends that returns one fails there instead of live. Nothing changes on the `pg` transport.

    **To adopt.** If your Migrator failed this way on the Data API, upgrade `@sssb/kit`, redeploy, and invoke the Migrator
    again; it migrates from where the database stands. On the Data API transport, cast a `"char"` or `char(n)` column you
    select to text (`code::text`). The contract run checks only the statements it sends (the migrations and the isolation
    proofs), not every query your app makes.

## 0.6.0

### Minor Changes

- 91ecfc0: ### A `none` role, and reads that authorize

    **Kind.** seam

    **Action.** required

    **What changed.**

    - **A new role, `none`**, the lowest, with no standing in the org its holder is placed in. SSSB's rules let it read or
      write nothing org-scoped, never let it wield the staff org's manage-all, and hand an app's `appAbilityRules` a
      `sameOrg` that is false for it and an active org that matches none. `Role` gains `'none'`, and `hasStanding(role)` is
      exported from `@sssb/kit/core/roles`. A fixed org source (the entry "Two auth settings: where the tenant comes from,
      and where orgs come from") gives it to everyone by default. A provider membership whose role is the string `'none'`
      is now read as `none`, where it used to fall back to `guest`; SSSB never writes it, and an invitation cannot grant it.
    - **`MemberStanding`**, what the auth port's `getMember` returns, gains optional `name` and `email`, which SSSB's
      adapters always fill, so a notification can reach one known person.

    **To adopt.**

    - Code that branches on `Role` must handle `'none'`.
    - In `appAbilityRules`, grant org-scoped access through the `sameOrg` you are handed, never because a role is not some
      other role, which would grant `none` too.
    - Authorize org-scoped reads, as the starter's items GET now does (`authorize(user, orgId, 'read', …)`): a route that
      lists an org's data by the session's org alone shows it to anyone placed there.

    An app on the default auth settings sees no `none` user unless an operator writes that role on a membership.

    **Now deletable.** An app-side override that forced every user's role down to deny-by-default.

- 91ecfc0: ### Two auth settings: where the tenant comes from, and where orgs come from

    **Kind.** operator

    **Action.** optional

    **What changed.** The auth adapters, the fake and Clerk, read two settings, each validated at boot. Left
    unset, both keep today's behaviour.

    - **`AUTH_TENANCY`**: `multi` (the default) reads each user's tenant from their public metadata under
      `AUTH_TENANT_METADATA_KEY` (`tenantSlug` when unset). `single`, with `AUTH_TENANT_SLUG`, fixes the tenant for the
      deployment and changes nothing else: orgs, roles, members, invitations and notifications are the org source's. A user
      whose metadata names a different tenant is refused.
    - **`AUTH_ORG_SOURCE`**: `provider` (the default) is the identity provider's organizations and per-membership roles.
      `fixed`, with `AUTH_HOME_ORG_SLUG`, is for an app that uses the provider without its organizations, and needs a
      single tenancy. Every user the
      provider signs in is placed in that org with `AUTH_DEFAULT_ROLE`: `none` (the default) or `restricted`, and no role
      that writes. In this mode:
        - the members list is empty;
        - invitations are refused;
        - the home org is the only org;
        - a home org that is the app's staff org, with the role `restricted`, is refused at boot.

        On a provider instance shared with another product, every user of that product is placed in the home org.

    The required-environment snapshot's `auth` section says what each choice requires: `single` needs `AUTH_TENANT_SLUG`,
    and `fixed` needs `AUTH_HOME_ORG_SLUG`. The simulated world runs the same settings when its environment sets them.

    **To adopt.** Nothing, to keep today's sign-in. For one tenant per deployment, set `params.auth.tenancy` to `'single'`
    with `tenantSlug`, and insert that tenant's row. For an identity provider used without organizations, also set
    `params.auth.orgSource` to `'fixed'` with `homeOrgSlug` (and `defaultRole` if not `none`), and insert that org's row.
    Before you do, authorize every org-scoped read (the entry "A `none` role, and reads that authorize"), and grant your
    people what they need through your own rules. With a fixed org source, pass `requestedBy` when you submit a job (the
    entry "A job records who started it").

    **Now deletable.**

    - A placeholder tenant claim written into every user's identity-provider metadata.
    - An identity-provider organization created only so sign-in would place people in an org.

- a92c52a: ### A job kind can opt out of completion notifications

    **Kind.** seam

    **Action.** optional

    **What changed.** Every app job kind notified its team's admins when a job ended, on every runner (the simulated one, the in-process one and its sweep, and the CodeBuild webhook), which for a kind a schedule runs every hour is a notification, a `listMembers` call and an email attempt a day for nothing. The seam's `jobs` module may now export `jobNotify`, saying per kind when its end is notified: `'always'` (today's behaviour, and the default), `'failure'` (only a failed job, a lost one the sweep fails included) or `'never'`. A run a kind refuses makes no `listMembers` call, no in-app notification and no email attempt, on every runner. The static demo's `useDemoWorld` takes the same map as its `jobNotify` option. `JobNotify` is a type of `@sssb/kit/core/jobs`. The app guide and `/sssb:new-job` say so.

    **To adopt.** Nothing, unless you want it: an app with no `jobNotify` export behaves as before. To silence a routine kind, export the map from `src/app-config/jobs.ts`:

    ```ts
    import type { JobNotify } from '@sssb/kit/core/jobs'

    export const jobNotify: Partial<Record<AppJobKind, JobNotify>> = {
        'sweep-items': 'failure',
    }
    ```

    If the static demo starts that kind, pass the same map to `useDemoWorld({ jobNotify })`, from a module both import (the seam's `jobs` module imports every server handler, which the demo's bundle cannot carry).

    **Now deletable.** A local patch or filter that keeps a routine job's end from notifying (an edited kind allowlist, a wrapper around `notifyJobTerminal`).

- 91ecfc0: ### A job records who started it, and its end reaches them when the team has no admin

    **Kind.** migration

    **Action.** optional

    **What changed.** Framework migration `0017_job_requester` adds a nullable `requested_by` column to `jobs`.
    `submitJob` (`@sssb/kit/db/jobs`) takes an optional `requestedBy`, the submitting person's user id. A job's end still
    notifies its team's active admins; when the team has none, it now notifies the person who submitted it, while the auth
    port still gives them standing in the org. A fixed org source (`AUTH_ORG_SOURCE=fixed`) lists no members, so there a
    job's end reaches only its requester. SSSB's rules let neither of that source's roles submit a `Job`, so such a job is
    one the app's own rules let the person start. A job submitted without `requestedBy`, a scheduled run among them, still
    reaches no one when the team has no admin.

    The app guide and `/sssb:new-job` say so.

    **To adopt.** Run your migrations, as every release asks. Pass `requestedBy: user.id` to `submitJob` wherever a person
    submits a job:

    ```ts
    await submitJob(db, jobs, { tenantId, orgId, kind, payload, requestedBy: user.id })
    ```

## 0.5.0

### Minor Changes

- 9d56c29: ### The authorization scan refuses denials that cannot stop the handler, and reads Server Actions

    **Kind.** seam

    **Action.** required

    **What changed.** The conformance suite's `authz-mutations` check passed handlers whose `authorize(...)` denial could
    never stop the mutation, and never read some code Next serves. It now fails:

    - `authorize` in an async callback to an iteration method (`await parse(req).ids.map(async ...)`,
      `items.forEach(async ...)`), in an async mapper to `Array.from`, and under `Promise.allSettled`, `any` or `race`;
    - `authorize` in a callback that never carries its failure, awaited or not: `setTimeout` and the other timers (also
      as `globalThis.` members or from `node:timers`), `queueMicrotask`, `process.nextTick`, `Promise.resolve`, `after()`
      from `next/server`, a `.catch`, `.finally` or listener callback, the second argument of `.then`;
    - `authorize` in a function handed to a wrapper that runs it in place, returned from inside a `try` whose `catch`
      does not rethrow (`try { return tracer.startActiveSpan('x', () => { authorize(...) }) } catch {}`);
    - an exemption whose gate call never runs (handed to a same-file function, in a lazy iterator, in a detached
      callback);
    - a Server Action that does not reach `authorize`: every export of a `'use server'` file and every function whose
      body opens with `'use server'`, anywhere under `src`, read-only ones included. No exemption applies to an action.
      A `'use server'` file exports only its actions, each declared in that file: a re-export or a non-function export
      fails, and a test or story file that carries the directive is judged too;
    - what Next serves and the scan cannot read: a `pages/api` or `src/pages/api` directory, a root-level `app/`
      directory, a file under `src/app` named `route.<ext>` other than `ts`, `tsx`, `js`, `jsx` or `mjs` (tests, stories,
      snapshots and declarations excepted), a `'use server'` file in the app outside `src`;
    - a simulated-mode opening (`if (!isSimulated) ...`) that throws anything but a global error (`Error`, `TypeError`,
      any global `...Error`) or an error imported from `@sssb/kit/ports/errors`, or that sits in a file assigning to
      `Response`, `NextResponse`, `JSON` or an `Error` global.

    It now accepts `await Promise.all(items.map(...))` (or returned) where the callback is async or returns the promise,
    `Promise.all(Object.entries(m).map(async ...))`, a `'use strict'` prologue before the simulated-mode opening, and a
    route directory reached through a symbolic link, which it reads at the path Next serves.

    **To adopt.** Run the conformance suite. For a handler it now fails, call `authorize(...)` before the mutation and
    before any `try`, on a path every request takes: after `auth.requireUser()` and the lookups that give it the org, never
    inside a condition or a loop. `await` whatever carries it:

    ```ts
    const user = await auth.requireUser()
    // ... resolve tenantId and orgId as the generated app's src/app/api/items/route.ts does ...
    authorize(user, orgId, 'update', { type: 'Item', orgId })
    await Promise.all(ids.map((id) => db.withTenant(tenantId, (trx) => archive(trx, id))))
    ```

    Give each Server Action the same call, and move a route served from `pages/api` or a root-level `app/` under
    `src/app`. Two correct shapes are still refused, with the ordinary "does not reach authorize(...)" message, which
    does not name them: `Promise.all(...).then(f)` (await the `Promise.all` and put the rest after it) and an un-awaited
    sync `forEach` on a value taken straight from an imported call (bind the array to a local first).

- 9d56c29: ### Conformance and contract checks that passed what they should have failed

    **Kind.** seam

    **Action.** required

    **What changed.**

    - The contract runner (`@sssb/kit/testing/contract`) connects through SSSB's real `pg` adapter. It built a bare
      driver pool, so a contract run saw a different driver configuration from the deployed app: a `date` column came
      back as a `Date`, where the app gets a string.
    - `conformanceSuite` refuses, while the suite file is collected, an `appDir` that is not the package the suite file
      is in. A suite pointed at another app used to run every file-reading check over that app's files and pass.
    - `i18n-parity` parses each message with the ICU parser. Text inside a plural or select branch is no longer read as
      a placeholder, so a translated branch passes, and each argument's name and type, inside branches too, and the
      rich-text tags must match between the two catalogs. A message that is valid ICU on one side only (`Press <Enter> to
send` against a valid translation) fails, naming the side. A value that is ICU on neither side, a raw string for
      `t.raw()` (markup, JSON, a template), is compared only by its `{name}` placeholders.
    - The RLS coverage proof reads each policy on its own. A table with a PERMISSIVE policy whose `USING` or
      `WITH CHECK` ignores `app.current_tenant` fails, even beside an isolating policy (permissive policies are OR-ed).
    - `real-auth-provider` follows `require('...')` and `import x = require('...')`.

    **To adopt.** Run `pnpm verify` and `pnpm test:contract`. A proof or test that compared a `date` column with a JS
    `Date` compares it with the string (`'2026-10-03'`). A catalog message the parity check now refuses is fixed in the catalog: close the tag, or quote the literal (`'<Enter>'`), on the side it names.

- 9d56c29: ### Ports refuse input they used to pass through

    **Kind.** seam

    **Action.** required

    **What changed.**

    - Email: a `to` is a bare address (`ada@example.test`) or a display name followed by one bracketed address at its
      end (`Ada Lovelace <ada@example.test>`). The real adapter and the fake both refuse anything else: blank, a comma, a
      semicolon, a control character such as a line break, `a<b@c.d>`, a trailing `(comment)`, and a quoted display name
      such as `"Ada" <ada@example.test>`. They also refuse a `subject` with a line break. The vendor reads a comma as a
      list, and the fake hid it.
      `sendTemplate` turns line breaks in a composed subject into spaces.
    - Auth: `updateProfile` refuses, in both adapters, a `name` that is not a non-blank string of at most 256
      characters (a `ForbiddenError`, a 403 through `withPortErrors`), and an unknown or empty locale before it writes
      anything. The fake stores only `name` and `locale`; it used to store the whole object it was handed. Accepting an
      invitation in the fake holds the name to the same rule.
    - Auth, real adapter: a membership or invitation with no role, or one the app does not know, is `guest` in the member list and the org switcher,
      as the session already treated it (it listed as `member`). Member, invitation and membership lists are read past
      the first hundred.
    - Jobs, in-process runner: the scheduled sweep fails a job still `queued` after five minutes ("lost: never
      started") and notifies its org. Such a job, whose `start()` failed or never ran, used to stay queued for ever.
    - Inbound email: `normalizeEmailAddress` (`@sssb/kit/core/inbound-email`) fails closed. It ignores a quoted display
      name, so a display name holding a member's address cannot supply it, and it answers `''` (no address) for a value
      it cannot read one way only: more than one `<...>`, text or a comment after the `>`, or an unbalanced bracket.
    - `ProfileScreen` requires a display name within that limit, and shows a translated error when `onSave` rejects.
      New framework keys: `profile.nameRequired`, `profile.nameTooLong`, `profile.saveError`.
    - `PeoplePicker`'s `onPick` may return `Promise<boolean | void>`; a resolved `false` or a rejection clears the
      spinner.

    **To adopt.** Send one message per recipient, and validate an address a person typed before the port sees it: the port's refusal is a plain `Error`, a 500 through `withPortErrors`. Validate a profile name in your route before the port sees it, and
    let your profile glue reject on a failed save. Before switching a deployment's `JOBS_RUNNER` from `codebuild` to
    `in-process`, let its builds finish: the sweep would fail their jobs after five minutes.

- 9d56c29: ### `sameOriginPath` is published, and the sign-in redirect uses it

    **Kind.** seam

    **Action.** optional

    **What changed.** `@sssb/kit/core/same-origin-path` is a published subpath: `sameOriginPath(value)` returns a
    same-origin path, normalised, or `null`. SSSB's real sign-in form now follows its `returnTo`, and its real accept-invite form its `redirectTo`, only through it. The
    check the starter's sign-in page shipped (`returnTo.startsWith('/') && !returnTo.startsWith('//')`) let `/\evil.example` and `/<tab>/evil.example` through, which a browser resolves to another origin: an open redirect straight after a real sign-in. `sameOriginPath` answers `null` for any whitespace, backslash or control character in the path, an unencoded space included, so a fallback replaces such a value.

    **To adopt.** In your `src/app/[locale]/signin/page.tsx`, and wherever your own code navigates to a value from the
    URL or the server, use the function's return value:

    ```ts
    import { sameOriginPath } from '@sssb/kit/core/same-origin-path'

    const target = sameOriginPath(returnTo) ?? `/${locale}/dashboard`
    ```

    **Now deletable.** A hand-written prefix test on a `returnTo`, `next` or `redirectTo` value.

### Patch Changes

- 9d56c29: ### Deployment and tooling fixes from the 0.4.0 baseline review

    **Kind.** operator

    **Action.** optional

    **What changed.**

    - The CodeBuild jobs runner passes the job's org to the build as `JOB_ORG_ID` (empty for none). Job payloads go to
      CodeBuild as plaintext, readable in its console and in CloudTrail: never put a secret or personal data in one.
    - The PostHog adapter's `capture` waits for the event to be sent, for at most two seconds, so an event is not lost
      when a Lambda freezes after its response. A slow or failed send is logged, never thrown.
    - Mailgun inbound: a token is remembered until its signature goes stale, which closes a replay window when the
      sender's clock runs ahead. The new `forgetMailgunToken` (`@sssb/kit/service-auth/mailgun`) lets a route forget a
      token whose handler failed, so the provider's retry is processed.
    - The migrator encodes the database name in its connection URL. Migration 0015's role error says SSSB.
    - Data API transport: a date before year 1 or after 9999 is accepted; an array of a type node-postgres has no
      parser for (an `enum[]`) comes back as Postgres text, as on `pg`; a string constant continued on the next line is
      read as one string.
    - `parseDbKeysetCursor` answers `invalid` for a cursor at year 0000, which the database cannot hold, so the route's 400 replaces a 500. A failed webhook enqueue after a job status commits
      is logged and no longer fails the caller. An outbound webhook's response body is cancelled once its status is read.
    - A relative `APP_DATA_DIR` works: fake storage refused every key under one. A fake analytics flag named like an `Object.prototype` member
      answers its default.
    - In a linked git worktree anywhere (a `.git` file that points into `worktrees/`), not only under
      `.claude/worktrees/`, an app's ports are derived per checkout; a checkout that is itself a worktree of a bare
      repository now gets derived ports too. `pnpm exec sssb port` prints them. Ladle's derived ports start at 61001.
    - `createTicker(...).stop()` resolves to the ticker's status, as its type said. `sssb serve-standalone` forwards
      SIGINT, SIGTERM and SIGHUP to the server and fails when the server dies on a signal.
    - The static demo: notification emails escape their copy; a held job's webhook goes to the job's own org; an actor
      completing a job emits what the server emits; Exit during a tour step stays exited; reset reseeds schedules from
      the world clock.

    **To adopt.** Nothing is required. A CodeBuild buildspec can read `JOB_ORG_ID`. An inbound-email route can call
    `forgetMailgunToken(token)` when its handler throws or answers a 5xx, as SSSB's reference app does.

## 0.4.0

### Minor Changes

- 179752d: ### The database port declares how it isolates tenants

    **Kind.** seam

    **Action.** required

    **What changed.** `DbPort` (`@sssb/kit/ports/db`) has a required, read-only `isolation`, of the new type
    `DbIsolation`. Every database adapter SSSB ships (pglite in simulated mode, node-postgres and the RDS Data API in real
    mode) declares `'rls'`: row-level security, proven by the isolation proof suite, as before. Nothing else changes for an
    app on Postgres: the same migrations, the same SQL, the same proofs and conformance checks (`rls-pglite` keeps its
    name). Inside the kit, what is specific to Postgres is now gathered as the Postgres database family, so a second
    database engine can be added beside it later.

    **To adopt.** An object you type as `DbPort` yourself, usually a test double, needs the member too, or the typecheck
    fails. Add it with the guarantee of the adapter it stands in for:

    ```ts
    const failing: DbPort = {
        isolation: 'rls',
        getDb: () => {
            throw new Error('not used')
        },
        ready: async () => {},
        migrateToLatest: async () => {},
        withTenant: async () => {
            throw new Error('refused')
        },
    }
    ```

    A double spread from SSSB's own port (`{ ...db }`) already has it, and one cast with `as unknown as DbPort` compiles
    without it, though adding it keeps the double honest.

- 7508a62: ### The invitation mail carries a link the real accept page can use

    **Kind.** seam

    **Action.** required

    **What changed.** SSSB mailed every invitee `/<locale>/accept-invite?invite=<id>`, the fake's link, in every mode. In
    real mode the accept page reads Clerk's `__clerk_ticket`, which that link never carries, so a real invitation could
    not be accepted from SSSB's mail. The link is now the auth adapter's to build: `AuthPort.createInvite` takes
    `acceptPageUrl` (the app's accept page, absolute, no query) and returns a `CreatedInvite`, a `Membership` with
    `acceptUrl`, the link to mail. The fake returns its page with `?invite=<id>`, as before; the Clerk adapter passes the
    page's path to Clerk as `redirectUrl` (a path, since a deployed request's URL names the server's own host) and returns
    Clerk's invitation URL. When the adapter returns no link, `sendOrgInvite` sends no mail of its own, and it never
    returns the link to its caller: it is the invitee's credential. `RealAcceptInviteForm` takes an optional `status`, the
    page's `__clerk_status`: `sign_in`, an invitee who already has an account, signs in by ticket rather than signing up,
    and `complete`, an invitation Clerk already accepted, only redirects. It also submits a ticket once, after Clerk has
    loaded: it used to submit it again as Clerk loaded, and twice under React's StrictMode.

    **To adopt.** If your app calls `sendOrgInvite`, its code changes nothing, but in real mode Clerk now sends invitees to
    your `/<locale>/accept-invite` page: an app that invites people needs that page, rendering `RealAcceptInviteForm` with
    `ticket` and `status` from `__clerk_ticket` and `__clerk_status`, as SSSB's showcase does. If it calls
    `auth.createInvite` itself, pass
    `acceptPageUrl` and mail the returned `acceptUrl` to the invitee only (never send it back to the inviter), sending
    nothing when it is `null`. An app-side fake or test double of the auth port returns `acceptUrl` too.

    **Now deletable.** Code that rebuilds an accept link from an invitation's id, or appends a ticket to one, after calling
    `createInvite`.

- 99fb466: ### The conformance suite checks that real-mode sign-in has its provider

    **Kind.** seam

    **Action.** required

    **What changed.** SSSB's real sign-in and invite forms (`@sssb/kit/adapters/real/sign-in-form`,
    `@sssb/kit/adapters/real/accept-invite-form`) call the auth provider's client hooks, which throw outside its
    provider, `RealAuthProviders` (`@sssb/kit/adapters/real/providers`). Only real mode loads either, so a missing
    provider showed nowhere but in a real sign-in page that failed to render. A new conformance check,
    `real-auth-provider`, follows the app's own imports from each page, layout and other rendering file under `src/app`,
    and fails one that reaches either form unless a layout or template wrapping it reaches the provider.

    **To adopt.** If your conformance suite fails `real-auth-provider`, mount the provider in your locale layout,
    `src/app/[locale]/layout.tsx`, in real mode only:

    ```tsx
    async function AuthProviders({ children }: { children: ReactNode }) {
        if (isSimulated) return children
        const { RealAuthProviders } = await import('@sssb/kit/adapters/real/providers')
        return <RealAuthProviders>{children}</RealAuthProviders>
    }
    ```

    and wrap the layout's children in `<AuthProviders>`. An app whose layout already mounts it, or that renders neither
    form, changes nothing.

    **Now deletable.** A `ClerkProvider` imported from `@clerk/nextjs` in your own layout to make real-mode sign-in work:
    `RealAuthProviders` is that provider, and keeps the vendor import inside SSSB's adapters.

- 3867cc8: ### An app that stores no files needs no S3 bucket

    **Kind.** operator

    **Action.** required

    **What changed.** The storage port is one of SSSB's optional ports, with the switch `STORAGE_PROVIDER` (`s3` or
    `none`). With `none` the port is absent: real mode no longer requires `STORAGE_BUCKET`, never loads the S3 SDK, and a
    call through the port (or a job handler's) throws an error naming the switch. `AWS_REGION` is now required only by
    what calls AWS: storage on `s3`, `JOBS_RUNNER=codebuild` and `DATABASE_TRANSPORT=data-api`. An unset switch is `s3`, so
    a deployment that sets nothing requires exactly what it did. `SssbApp` sets the switch from `params.ports.storage`, and
    with `none` builds no storage bucket, sets no `STORAGE_BUCKET` and grants the server no S3 access; with `s3` or left
    out, the bucket keeps its logical id. `SssbApp`'s `storageBucket` is therefore `Bucket | undefined`.
    `required-env.json` lists `STORAGE_PROVIDER`'s choices, and `AWS_REGION` under `JOBS_RUNNER`'s `codebuild`.

    **To adopt.** Add `storage` to the `ports` in `apps/<app>/config/params.ts`: `'s3'` if your app stores files
    (uploads, attachments, job artifacts), else `'none'`. Infra code that reads `app.storageBucket` handles `undefined`
    (TypeScript now says where). Before switching a deployed stack to `none`, copy out what its bucket holds: a
    `production: true` deployment retains the bucket outside the stack, and any other deletes it with its objects. A
    deployment that does not use `SssbApp` sets `STORAGE_PROVIDER` itself.

    **Now deletable.** A placeholder `STORAGE_BUCKET`, and a bucket created only so that real mode would start.

- 587112b: ### Object storage on any S3-compatible store: `STORAGE_PROVIDER=s3-compatible`

    **Kind.** operator

    **Action.** optional

    **What changed.** The storage port has a third choice beside `s3` and `none`: `s3-compatible`, for Cloudflare R2, MinIO
    and Backblaze B2, through the same S3 adapter. It is a choice of its own, never inferred from `s3` reading an endpoint.
    It requires `STORAGE_BUCKET`, `STORAGE_ENDPOINT`, `STORAGE_REGION`, `STORAGE_ACCESS_KEY_ID`,
    `STORAGE_SECRET_ACCESS_KEY` and `STORAGE_UPLOAD_TARGET` (`post` if the store accepts a presigned POST, which
    `createUploadTarget` is, or `none` if it does not, as Cloudflare documents for R2: `createUploadTarget` then fails with
    an error that names the setting, and every other method works), and fails at boot naming each one missing. It reads
    `STORAGE_FORCE_PATH_STYLE` (`true` or `false`) when set, which MinIO needs. It does not use `AWS_REGION` or the AWS
    key pair, which Lambda reserves. `SssbApp` accepts `params.ports.storage: 's3-compatible'`, builds no storage bucket
    and grants no S3 access for it. `required-env.json` lists the choice, so this is a `minor`; an app that keeps `s3`,
    `none` or no choice requires exactly what it did and keeps its bucket's logical id. Three cutover rows are new:
    `storage-compatible-store`, `storage-compatible-credentials` and `storage-compatible-live`.

    **To adopt.** Nothing, unless you want it. To use R2, MinIO or B2: set `ports: { storage: 's3-compatible' }` in
    `apps/<app>/config/params.ts`, add the six settings to the server's environment from your infra (`app.server`; the
    key pair kept out of the repository), and work the three cutover rows. Switching a deployed stack from `s3` takes its bucket
    out of the stack (retained in production, deleted elsewhere), as `none` does: copy the objects first. A store without
    presigned POST cannot take a browser upload through `createUploadTarget` yet.

    **Now deletable.** A hand-written storage adapter, or a copy of `createS3Storage` with an endpoint, that only pointed
    SSSB's storage port at another S3-compatible store.

### Patch Changes

- 69500cb: ### The `db-role-not-superuser` cutover row covers the Data API transport

    **Kind.** operator

    **Action.** optional

    **What changed.** The cutover row `db-role-not-superuser` said "The role in `DATABASE_URL`", but a deployment on the
    Data API transport sets no `DATABASE_URL`: the role it connects as is the one the secret at `DATABASE_SECRET_ARN` holds.
    The row (`@sssb/kit/cutover/rows.json`, and its proof in SSSB's checklist) now names both, and says how to run the
    check on each: through `DATABASE_URL` on `pg`, with `aws rds-data execute-statement` and that secret on `data-api`.

    **To adopt.** If your deployment uses `data-api`, close the row by running its check through the Data API as the
    role the secret at `DATABASE_SECRET_ARN` holds. You may copy the new wording into your own checklist's row; nothing
    reads it but people.

- 99fb466: ### A real deployment without a PostHog key no longer writes to disk

    **Kind.** operator

    **Action.** optional

    **What changed.** In real mode without `POSTHOG_KEY`, the analytics port was the simulated world's fake, which writes
    each capture and reads each flag under `.data/` in the server's working directory. On Lambda that directory is the
    deployment package, which is read-only, so those calls most likely threw, and sending an invite awaits one. It is now a
    no-op: nothing is captured, and `isFlagEnabled` answers the default its caller passes, as the PostHog adapter does
    when PostHog cannot be reached. With a key, PostHog is unchanged.

    **To adopt.** Nothing to change. If your deployment sets no `POSTHOG_KEY`, its analytics calls now do nothing instead
    of touching the filesystem; if you set `APP_DATA_DIR` to a writable directory such as `/tmp` to get past this, you
    can drop it.

    **Now deletable.** An `APP_DATA_DIR` (or a placeholder `POSTHOG_KEY`) set on a real deployment only so that analytics
    calls would not fail.

## 0.3.0

### Minor Changes

- 69ffb93: ### Job handlers get the auth port, and the digest addresses real members

    **Kind.** seam

    **Action.** required

    **What changed.** A job handler's context (`JobHandler`'s second argument, `@sssb/kit/ports/jobs`) now carries `auth`,
    the auth port, for handlers that address people, and an optional `resolveLocale`, a person's own locale where the runner knows it (in a simulated world). The framework's `digest-email` handler uses it: it sends a team's
    digest to the team's first active admin (else its first active member) as `auth.listMembers` lists them, which in a
    deployment is the identity provider, instead of a person from the seed. In a deployment, a team with no active
    member gets no digest; in a simulated world the digest now also reaches accepted invitees and writes in the recipient's current profile locale, and a team with no one to address still gets the synthetic `<org>@digest.example` address. No job handler reads the seed any more, and none may.

    **To adopt.** Where your own code calls a job handler directly (a unit test, say), pass `auth` in its context beside
    `llm`: an auth port, or a stand-in typed as one. A handler of yours that addresses people asks
    `ctx.auth.listMembers(orgSlug)`, never `@sssb/app-config/seed`, which a deployment does not have.

    **Now deletable.** A recipient list or address map a handler kept so that it would not read seed people in a
    deployment.

- 474eec5: ### Real-mode sign-in: `withAuthProxy` runs Clerk's middleware around your proxy

    **Kind.** seam

    **Action.** required

    **What changed.** SSSB's Clerk auth adapter calls Clerk's `auth()`, which refuses any request Clerk's middleware did
    not see, and SSSB never ran that middleware, so in real mode every sign-in failed. The new published subpath
    `@sssb/kit/adapters/proxy` exports `withAuthProxy(proxy)`: in real mode it runs your proxy inside Clerk's
    `clerkMiddleware`, loading it with `import()` on the first request; in simulated mode it runs your proxy as it is and
    loads no Clerk code, so `pnpm dev` stays hermetic. It protects no route: each route's `authorize()` still does.

    **To adopt.** In `src/proxy.ts`, wrap your proxy and send it every API route as well as your pages. Your proxy still
    decides what each path gets; let an API route through untouched:

    ```ts
    import createMiddleware from 'next-intl/middleware'
    import { NextResponse } from 'next/server'
    import { withAuthProxy } from '@sssb/kit/adapters/proxy'
    import { routing } from '@sssb/kit/i18n/routing'

    const locales = createMiddleware(routing)

    export default withAuthProxy((request) =>
        request.nextUrl.pathname.startsWith('/api') ? NextResponse.next() : locales(request),
    )

    export const config = {
        matcher: ['/((?!api|_next|_vercel|.*\\..*).*)', '/api/:path*'],
    }
    ```

    A proxy that already runs on every path (`matcher: '/:path*'`) keeps its matcher. Clerk's middleware reads the keys the
    auth adapter needs (`NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY`, `CLERK_SECRET_KEY`). In a deployment, also set `CLERK_JWT_KEY`
    to your Clerk instance's JWT public key (PEM, `\n` escapes accepted): Clerk does not read it itself, so the kit passes
    it on, and Clerk then checks each session without a call to Clerk's API. A value that is not a 2048-bit RSA public key
    stops the proxy at its first request. Clerk is never shown a request's `Authorization` header (users sign in by Clerk's
    session cookie), and your proxy and routes still receive it.

    **Now deletable.** A wrapper of your own that runs your proxy inside `clerkMiddleware` in real mode: an adapter that
    imports `@clerk/nextjs/server` for the proxy, the run-mode check and `import()` in `src/proxy.ts` that load it, and a
    test that mocks the run mode to reach it.

- e214c18: ### Machine callers send their credential in its own header, which CloudFront passes through

    **Kind.** operator

    **Action.** optional

    **What changed.** `withWebhookSecret` (`@sssb/kit/service-auth/webhook`) reads the shared secret from
    `x-sssb-webhook-secret`, and `verifyServiceCaller` (`@sssb/kit/service-auth/verify`) reads a service token from
    `x-sssb-service-token`, each exported as a constant (`WEBHOOK_SECRET_HEADER`, `SERVICE_TOKEN_HEADER`). The header wins
    when present; `Authorization: Bearer …` is still accepted when it is absent. The reason: `SssbApp`'s CloudFront signs
    every request it passes to the server's Function URL, and its signature replaces the `Authorization` header, so a
    credential sent there through the public host never reached the route and every such call answered 401. `pnpm tick`
    and `SssbApp`'s scheduled tick send the new header.

    **To adopt.** Every caller of your webhook and service routes that goes through your deployment's public host (a
    scheduler, a build's completion callback, a service) sends `x-sssb-webhook-secret: <secret>` or
    `x-sssb-service-token: <jwt>` instead of `Authorization: Bearer …`. A caller that reaches the server another way may
    keep `Authorization`, but the header works everywhere.

    **Now deletable.** A workaround that delivered a webhook secret or service token around CloudFront because
    `Authorization` never arrived.

- fca2628: ### Real mode requires only the optional ports your app uses

    **Kind.** operator

    **Action.** optional

    **What changed.** Each of SSSB's optional ports has a switch the server reads at boot: `LLM_PROVIDER` (`anthropic`
    or `none`), `EMAIL_PROVIDER` (`mailgun` or `none`), `INBOUND_EMAIL_PROVIDER` (`mailgun` or `none`) and `JOBS_RUNNER`
    (`codebuild`, `in-process` or `none`). A port switched to `none` is absent: real mode no longer requires its settings
    (`ANTHROPIC_API_KEY`; `MAILGUN_DOMAIN`, `MAILGUN_API_KEY`, `EMAIL_FROM`; `MAILGUN_WEBHOOK_SIGNING_KEY`;
    `JOBS_CODEBUILD_PROJECT`), never loads its SDK, and a call through it throws an error naming the switch. An unset
    switch is its first value, so a deployment that sets none requires exactly what it did. `SssbApp` sets the switches
    from a new, optional `params.ports` (`llm`, `email`, `inboundEmail`, `jobs`), and refuses a port or a value it does not
    know. `required-env.json` now also lists what each choice requires.

    **To adopt.** Add `ports` to `apps/<app>/config/params.ts`, beside `database`, with `none` for each port your app
    does not use, e.g. `ports: { llm: 'none', email: 'none', inboundEmail: 'none', jobs: 'in-process' }`; `SssbApp`
    already receives `params`. A deployment that does not use `SssbApp` sets the variables itself. Then delete the
    placeholder values you set for the ports you switched off.

    **Now deletable.** Placeholder values (`unused`, `unused-by-<app>`) set for `ANTHROPIC_API_KEY`, the Mailgun
    variables, `EMAIL_FROM` or `JOBS_CODEBUILD_PROJECT` only so that real mode would start.

- fca2628: ### Jobs and scheduled work without CodeBuild: the in-process runner and `SssbApp`'s scheduled tick

    **Kind.** operator

    **Action.** optional

    **What changed.** `JOBS_RUNNER=in-process` (`params.ports.jobs: 'in-process'`) runs each job's registered handler in
    the server, from the request or the scheduled tick that started it, records its terminal status and, for one of the app's own job kinds,
    notifies its org's admins before that call returns: no CodeBuild project and no jobs webhook route. A job shares that invocation's time limit (30
    seconds on `SssbApp`); longer work stays on `codebuild`. `SssbApp` takes a new option, `scheduledTick: { webhookSecret,
every? }`: an EventBridge rule (every five minutes unless `every` says otherwise) runs a function that reads that
    secret and invokes the server directly with a POST of `/api/webhooks/cron`, the route behind `withWebhookSecret` that
    `pnpm tick` calls in development. It goes through neither CloudFront nor the Function URL. Without the option nothing
    changes in your stack.

    **To adopt.** To run jobs without CodeBuild, set `jobs: 'in-process'` in `params.ports`. To run your scheduled work,
    pass the secret your server's `WEBHOOK_SECRET` holds (a plain string secret):

    ```ts
    new SssbApp(stack, 'Default', { ...props, scheduledTick: { webhookSecret } })
    ```

    The construct grants its function read on that secret and invoke on the server; getting the value into the server's
    `WEBHOOK_SECRET` stays yours. Close the `scheduled-tick` cutover row with its proof after the first deploy.

    **Now deletable.** A ticker of your own (an EventBridge rule and a Lambda that POSTs a route of yours with the webhook
    secret) whose route only does what a registered job kind and a `job_schedules` row would; and a route of your own that
    runs scheduled work in the server because SSSB's real jobs port started every job as a CodeBuild build.

- c650c05: ### The Simulator's People, Mail and Jobs tabs on an app's own `pnpm dev`

    **Kind.** seam

    **Action.** optional

    **What changed.** Two new published subpaths serve the Simulator panel from an app's own server. `@sssb/kit/server-lib/simulator-api` exports `simulatorApi(request, context)`, one handler for every `/api/simulator/*` call, simulated mode only (404 in a real build), with People (`summary`, `viewpoint`), Mail (`mail`, `mail/clear`, `mail/seen`) and Jobs with the world clock (`jobs`, `jobs/run-pending`, `schedules`, `clock`, `schedules/run-due`); any other path is a 404, every POST must send `content-type: application/json` (415 otherwise), a known path with the wrong method is 405, `viewpoint` answers only a path on this origin, and `mail/seen` only someone in the world. `@sssb/kit/components/simulator/simulator-host` exports `SimulatorHost`, the panel client that calls it. `SimulatorPanel` now shows a tab only when its host passes that tab's props (People always), so a host that wires every tab sees no change.

    **To adopt.** Mount the handler with one route file, `src/app/api/simulator/[...path]/route.ts`, whose `GET` and `POST` each open with the simulated-mode 404 and import the handler only after it, so the authorization scan's `simulator/` exemption holds:

    ```ts
    import { isSimulated } from '@sssb/kit/adapters/index'
    import type { SimulatorRouteContext } from '@sssb/kit/server-lib/simulator-api'

    export async function GET(request: Request, context: SimulatorRouteContext): Promise<Response> {
        if (!isSimulated) return new Response(null, { status: 404 })
        const { simulatorApi } = await import('@sssb/kit/server-lib/simulator-api')
        return simulatorApi(request, context)
    }
    // POST: the same body.
    ```

    Then render the panel around the page from `src/app/[locale]/layout.tsx`, in simulated mode only and through a dynamic import, as SSSB's starter does: `const { SimulatorHost } = await import('@sssb/kit/components/simulator/simulator-host')`, then `<SimulatorHost locale={locale}>{children}</SimulatorHost>`. An app with Simulator glue of its own (route files under `src/app/api/simulator/` and a client glue) can keep it: a route file of its own still wins for its path. Snapshots, presets, tours, the other subsystem tabs, the dev ticker and app-registered tabs are not served yet; keep your glue while you use them.

    **Now deletable.** Hand-written `src/app/api/simulator/{summary,viewpoint,mail,mail/clear,mail/seen,jobs,jobs/run-pending,schedules,clock,schedules/run-due}/route.ts` wrappers over the fake adapters, once a client glue no longer calls anything else under `/api/simulator/`.

### Patch Changes

- b28bc3b: ### SSSB's adoption guide is short, with a reference beside it

    **Kind.** none

    **Action.** none

    **What changed.** SSSB's `docs/adopting.md` is now a short guide in the order you act: generate, first boot, take out
    the starter's content, a first entity, deploy and cut over, upgrade by release. Everything else it held is in
    `docs/adopting-reference.md`. `sssb remove-items`, when it refuses, now points at the reference's "To remove the Items
    slice" for the steps by hand. A new workspace's `README.md` links both, the guide's "Upgrading by release" for
    the steps and the reference's "Upgrading, step by step" for why each is there.

- 667eae6: ### An app with no extra subject fields no longer silences a lint rule

    **Kind.** seam

    **Action.** optional

    **What changed.** `AbilitySubject` in `@sssb/kit/core/abilities` is now an intersection, `AppSubjectFields & { type; orgId?; ownerId? }`, instead of an interface that extends `AppSubjectFields`. The seam's `AppSubjectFields` may therefore be an interface, a type alias or a mapped type. An app with no fields used to declare an empty interface and suppress `@typescript-eslint/no-empty-object-type`, the one place the "empty registration is the off switch" rule was not true; `apps/starter` now writes `export type AppSubjectFields = Record<never, never>`. An app that declares an interface keeps working unchanged, and so does every caller of `AbilitySubject`.

    **To adopt.** Nothing breaks if you do nothing. If your `src/app-config/abilities.ts` carries an empty `interface AppSubjectFields {}` under an `eslint-disable-next-line @typescript-eslint/no-empty-object-type`, replace both with `export type AppSubjectFields = Record<never, never>`. Only code that wrote `interface X extends AbilitySubject` is affected, and it needs `type X = AbilitySubject & { … }` instead.

    **Now deletable.** An `eslint-disable-next-line @typescript-eslint/no-empty-object-type` above an empty `AppSubjectFields` interface.

- 3dc7b50: ### A generated app's port slot is its own, so it never says `starter`

    **Kind.** scaffold

    **Action.** optional

    **What changed.** `pnpm create @sssb` now gives the app a port slot named for its slug, at port 3700:
    `"sssb": { "port": { "name": "<slug>", "default": 3700 } }`, or `sssb-app` for a slug a slot cannot be named for. Its
    override is `<SLUG>_PORT`. The app's `dev` and `tick` scripts (`sssb dev-tick`, `sssb tick`) and its
    `playwright.config.ts` (`originForApp(__dirname)`) name no slot and read the declaration. Before, the app declared
    SSSB's built-in `starter` slot (port 3100, `STARTER_PORT`) and named it in all three. The app guide's example now shows
    a slot of the app's own. The generated README, `CLAUDE.md` and CI workflow name `pnpm exec sssb pin` where they say to
    raise SSSB's pins. In `@sssb/tools`, `sssb tick`'s usage and `sssb port`'s refusal of an app with no declaration
    lead with the app's own slot rather than SSSB's built-in ones.

    **To adopt.** Nothing is required: `"sssb": { "port": "starter" }` keeps working, on the same port. To give your app a
    slot of its own, as a new workspace's has:

    ```json
    "sssb": { "port": { "name": "<your app>", "default": 3700 } }
    ```

    in the app's `package.json` (any port from 1024 to 49151 outside SSSB's own: 3000, 3100, 3200-3599, 5439-5639,
    20000-29999, 61000-61199). Then, in its scripts, `sssb dev-tick starter -- …` becomes `sssb dev-tick -- …` and
    `sssb tick starter` becomes `sssb tick`; in `playwright.config.ts`, `originFor('starter')` becomes
    `originForApp(__dirname)`, imported from `@sssb/tools/ports`. The app's local port then moves to the default you chose,
    and its override from `STARTER_PORT` to `<YOUR_APP>_PORT`. A second app in the workspace must not take the same port.
    Refresh the app guide's copy as after any upgrade (`pnpm exec sssb guide`).

    **Now deletable.** A `starter` in an app's scripts and Playwright config, once the app declares a slot of its own.

- 69ffb93: ### A deployment loads `pg` and PostHog only when it uses them

    **Kind.** none

    **Action.** none

    **What changed.** The real ports load the `pg` driver only for the `pg` transport (`DATABASE_TRANSPORT=pg`, the default) and PostHog only when
    `POSTHOG_KEY` is set, as the Data API transport and the optional ports already did; a Data API deployment no longer
    loads `pg`. Nothing to set or change.

## 0.2.0

### Minor Changes

- 7ed3c7d: ### The authorization scan counts `authorize` only where its denial stops the handler

    **Kind.** seam

    **Action.** required

    **What changed.** The conformance suite's `authz-mutations` check counted `authorize(...)` wherever the handler's path
    reached it, even where its `ForbiddenError` could not stop the handler. Now it does not count `authorize` in these
    places:

    - In an `async` helper, or a callback, whose promise the handler neither awaits nor returns. The denial became an
      unhandled rejection, and the handler went on to mutate.
    - In an `async` callback to `forEach`, `map` or another array iteration method, even an awaited one.
    - In a callback handed to a function or wrapper defined in the route's own file. The scan does not follow a function
      through a parameter.
    - In a `try` whose `catch` does anything but rethrow, or whose `finally` can `return`, `break` or `continue`.

    A synchronous helper, a synchronous `forEach` callback, and `authorize` itself still count without `await`: they throw
    in place.

    **To adopt.** Run the conformance suite (`pnpm test:unit`). A route that now fails `authz-mutations` reaches
    `authorize` only where its denial is lost. Await the helper that authorizes, or return it:

    ```ts
    async function check(user: AuthUser, orgId: string) {
        authorize(user, orgId, 'update', { type: 'Item', orgId })
    }

    export async function POST(request: Request): Promise<Response> {
        return withPortErrors(async () => {
            // ...
            await check(user, orgId) // was: check(user, orgId)
            // ...
        })
    }
    ```

    - A callback that authorizes needs the call it is handed to awaited or returned:
      `return withPortErrors(async () => …)`, not `withPortErrors(…)` on a line of its own.
    - Write `for (const id of ids) await check(id)`, not `ids.forEach(async (id) => …)` or
      `await Promise.all(ids.map(async (id) => …))`.
    - Write `await check()`, not `await check().then(…)` or `const p = check(); await p`.
    - Let `withPortErrors` turn the denial into a 403 rather than a `catch` in the handler, or rethrow from the `catch`.
    - Move a wrapper the route defines for itself into a module of its own, or call `authorize` in the handler.

- 362056f: ### The app guide gains the cutover rule and the dev loop

    **Kind.** seam

    **Action.** required

    **What changed.** SSSB's app guide (`@sssb/kit/guide.md`) now also says what SSSB's own agent guide said only to its
    maintainers and an app author needs: anything needing real credentials is a row in the workspace's cutover checklist,
    never a blocker; scheduled work runs in dev only when something ticks it (`pnpm tick`, `DEV_TICK_SECONDS`), and the
    cron route stays behind `withWebhookSecret`; a linked worktree derives the app's ports per checkout
    (`pnpm exec sssb port`); and the workflow (`pnpm verify` before finishing, `pnpm lint:fix`, conventional commits).
    `sssb doctor` fails until the workspace's copy is refreshed.

    **To adopt.** Run `pnpm exec sssb guide` from your app and commit the diff of `.claude/sssb-guide.md`.

    **Now deletable.** Those rules copied by hand from SSSB's `CLAUDE.md` into your own.

- e574680: ### The app guide ships in `@sssb/kit`

    **Kind.** seam

    **Action.** required

    **What changed.** `@sssb/kit` ships the app guide, the rules an agent follows in your app (the seam, vendor SDKs only
    in adapters, `db.withTenant()`, `authorize(...)`, i18n, router-agnostic screens, hermetic dev, migrations, the
    conformance and contract tests), at the published subpath `@sssb/kit/guide.md`. `sssb guide` copies it into your
    repository under a hash stamp, and `sssb doctor` now fails while that copy is missing or stale. The doc-paths gate
    gained `sssb.docPaths.relativeTo`, which reads a doc's citations against a directory instead of the workspace root.

    **To adopt.** From any app, run `pnpm exec sssb guide`; it writes `.claude/sssb-guide.md` at the workspace root.
    Commit it, and import it from your own `CLAUDE.md` with a line holding `@.claude/sssb-guide.md`. The guide cites paths
    relative to an app (`src/app-config/`, `config/params.ts`), so if your `sssb.docPaths.include` reaches `.claude`, map
    the copy to your app in the root `package.json`: `"relativeTo": { ".claude/sssb-guide.md": "apps/<app>" }` inside
    `sssb.docPaths`. After each upgrade, run `pnpm exec sssb guide` again and review the diff before you commit it.

    **Now deletable.** Rules copied by hand from SSSB's `CLAUDE.md` into your own: the seam, vendor and `process.env`
    fences, tenancy, authorization, i18n, migration numbering and the test conventions the guide now states.

- b4770eb: ### An app names the cluster-wide roles its migrations create: `appRoles`

    **Kind.** seam

    **Action.** required

    **What changed.** An app whose migrations create a role of their own (beside the framework's `app_user`) now names it
    in an optional `appRoles` export of its `@sssb/app-config/db/migrations` module. The contract suite's owner pass grants a
    later owner ADMIN on exactly those roles, as it does on `app_user`, so a migration that alters such a role passes on
    every pass, not only the first. It grants on an ordinary role only: it refuses, before granting anything, a named role
    that can log in, has CREATEDB, CREATEROLE, SUPERUSER, BYPASSRLS or REPLICATION, holds a privilege on a server parameter
    (`pg_parameter_acl`), owns a database or tablespace, or is a member, at any depth, of any role but `app_user` and the
    app's other named roles (ADMIN lets the owner grant itself SET on the role and act as it and as all of those), and it
    fails when the owner's own migrations leave a named role more than ordinary. It holds `app_user`, on which every later
    owner gets ADMIN too, to the same attributes, privileges and ownerships, before granting and after the migrations:
    `app_user` may be a member of the app's named roles and of other roles ordinary in shape (another app's, on a shared
    server), never of a `pg_*` or `rds_*` role or one with any of those attributes, privileges or ownerships. A new conformance check, `app-roles`, fails a role the
    migrations create that `appRoles` does not name, a name no migration creates, and a named role or `app_user` the
    migrations leave more than ordinary, on pglite in the unit run. The owner pass's teardown now also revokes what
    its owner granted (`DROP OWNED BY`), so a migration that grants a role TO `app_user` no longer leaves the owner behind,
    and an owner it cannot drop fails the pass instead of staying on the server. An app that creates no role changes
    nothing.

    **To adopt.** If your migrations create a role, export its name beside `appMigrations`, from the module
    `@sssb/app-config/db/migrations` resolves to (`src/app-config/db/migrations.ts`, or `migrations/index.ts`):

    ```ts
    export const appRoles = ['app_maintainer'] as const
    ```

    Create the role only where it does not exist yet, as an ordinary role, and keep it one in every later migration:
    NOLOGIN, no other attribute, no privilege on a server parameter, no database or tablespace of its own, and no membership
    but `app_user` and your other named roles (granting it TO `app_user` is fine):

    ```sql
    DO $$ BEGIN
        IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'app_maintainer') THEN
            CREATE ROLE app_maintainer NOLOGIN;
        END IF;
    END $$
    ```

    Leave `app_user` ordinary as well: never change its attributes, give it no parameter privilege, database or tablespace, and grant
    it only your named roles.

    Then make a migration that only warned when it lacked ADMIN on its role fail again: the owner pass now gives a later
    owner that ADMIN, so a failure there is real.

    **Now deletable.** A migration that catches `permission denied` on its own role and warns instead of failing, to get
    past the contract suite's second owner pass.

- 835e887: ### The starter runs the conformance suite and doctor

    **Kind.** scaffold

    **Action.** required

    **What changed.** The starter gained `src/sssb.conformance.test.ts`, its `tests/contract/rls-contract.test.ts` calls
    `contractSuite` from `@sssb/kit/testing/contract`, and its `package.json` gained the `sssb:doctor` (`sssb doctor`) and
    `check:e2e` (`sssb check-e2e`) scripts and an `embedded-postgres` devDependency.

    **To adopt.** Copy the starter's `src/sssb.conformance.test.ts` into each app, replace the body of each app's
    `tests/contract/rls-contract.test.ts` with the starter's, and add the two scripts and the devDependency to each app's
    `package.json`. Run `pnpm exec sssb doctor` once from any app: it checks every app of the workspace.

- 835e887: ### The conformance suite, `sssb doctor` and `sssb check-e2e`

    **Kind.** seam

    **Action.** required

    **What changed.** The framework's checks that must hold for every app now ship as a suite the app calls from its own
    tree: `@sssb/kit/testing` (the authorization scan of the app's routes, i18n partition and parity, the pglite RLS
    proofs, migration order, demo presets, the seam map) and `@sssb/kit/testing/contract` (the same proofs on real
    Postgres as a non-superuser owner and as a superuser, and over the RDS Data API through its emulator). The kit no
    longer ships its seam-conformance test files. `sssb doctor`, one run for every app of the workspace, fails unless
    each singleton peer has one copy, every importer of `@sssb/kit` links its own seam, the `@sssb/*` packages share one
    version, the Vitest config a bare `vitest` would load for each app runs every unit check, and some config runs every
    contract check. It reports, without failing, any other Vitest config that runs an app's tests without the checks, a
    bare `vitest` from an app's directory that would not run its suite when the root's run is the main one, the narrowing
    flags the package.json scripts pass to vitest, and which script runs each contract config, since it cannot
    see what CI runs. Playwright specs may reach the framework only through `@sssb/kit/testing/e2e`, which ships compiled
    and seam-free, and `sssb check-e2e`, asking Playwright which files each config loads, fails a spec that reaches any
    other framework file.

    **To adopt.** In each app:

    - Add `src/sssb.conformance.test.ts` holding
      `conformanceSuite({ appDir: path.resolve(import.meta.dirname, '..'), optOut: {} })`, with `conformanceSuite` from
      `@sssb/kit/testing`. A check is left out only by name, with a reason: `optOut: { '<check id>': '<why>' }`; the ids
      are in `@sssb/kit/testing/checks.json`.
    - Make `tests/contract/rls-contract.test.ts` call `contractSuite({ port: portFor('contractPg'), optOut: {} })`, with
      `contractSuite` from `@sssb/kit/testing/contract` and `portFor` from `@sssb/tools/ports`, and add
      `embedded-postgres` to the app's devDependencies for local runs (CI can set `CONTRACT_DATABASE_URL` instead). Keep
      `test:contract` in CI: doctor proves the contract checks would run, not that CI runs them.
    - An authorization exemption of the app's own goes in `authz-exemptions.mjs` at the app's root, each entry with a
      `reason` and a `mustMatch` gate; one that matches no mutating route in the app, overlaps a framework entry, or is a prefix
      nested in another of the app's prefixes, fails.
    - In Playwright specs, import webhook-signature helpers from `@sssb/kit/testing/e2e`, not `@sssb/kit/core/…`, and
      read app constants from modules that import nothing from SSSB but types.
    - Run `sssb doctor` (once, from the workspace root) and `sssb check-e2e` (in each app) in verify and in CI, and read
      doctor's reports: if CI runs a Vitest config other than the one doctor holds to the checks, they do not run there.

    **Now deletable.** A Vitest `include` that reaches the framework's test files under `node_modules`, with the default
    `exclude` overridden to let them run; a copied real-Postgres contract harness (a `defineContractSuite` and its server
    helper); and a hand-run `readlink -f` comparison of the app's and the framework's React, Next or Mantine copies.

- 3c9d89a: ### Correction: keep the `.gitleaks.toml` entry for keel's `webhook.test.ts`

    **Kind.** scaffold

    **Action.** required

    **What changed.** v0.2.0-rc.0's notes ("Since keel 24b0589: scaffold changes to apply by hand", under `.gitleaks.toml`)
    said to remove the allowlist entry for `packages/keel/src/service-auth/webhook\.test\.ts` along with the directory.
    That was wrong for a workspace that was forked from keel: CI's gitleaks scans the whole history, not the tree
    (`gitleaks git` over a checkout with `fetch-depth: 0`), and the commits that hold that file still carry its
    placeholder secret, so a scan without the entry reports it. Deleting the directory takes the file out of the tree,
    not out of history. A workspace `pnpm create @sssb` generated has no keel history and no such entry.

    **To adopt.** Keep the entry, scoped as it was (`condition = "AND"`, the path and the one string), and say in its
    comment that it covers history only, so nobody removes it later because the file is gone. If you removed it, restore
    it:

    ```toml
    # History only: packages/keel is gone from the tree, but its webhook.test.ts and the placeholder secret below are
    # still in this repository's history, which gitleaks scans.
    [[allowlists]]
    description = "keel's webhook.test.ts WEBHOOK_SECRET fixture, in history only"
    condition = "AND"
    paths = ['''packages/keel/src/service-auth/webhook\.test\.ts''']
    regexes = ['''env-secret-abcdef0123456789''']
    regexTarget = "line"
    ```

    The rest of that item stands: give any entry of the app's own that pairs `paths` with `regexes` `condition = "AND"`.

- 2781d4a: ### Since keel 24b0589: framework migrations

    **Kind.** migration

    **Action.** required

    **What changed.** Three framework migrations, `0014` to `0016`, arrived after keel's `24b0589` and run on the
    migrator's next run. Before them comes a fix to the migrator itself: one bundled the way keel's `infra/stack.ts` did
    at `24b0589` carries the wrong app's migrations.

    **To adopt.** Deploy a migrator bundled from the app (first item) before it runs against any database, make sure the
    database is Postgres 16 or later, then run it once.

    #### The migrator runs the app's migrations only when bundled from the app (jpslav/keel#54)

    At `24b0589`, `infra/stack.ts` bundled the migrator Lambda with the repository's root `tsconfig.json`, whose
    `@app-config/*` path points at keel's test fixture, so the bundle carried the fixture's `1001_dockets`,
    `1002_dockets_due_on` and `1003_dockets_last_touched_at` and none of the app's migrations. `SssbApp` bundles it from
    the app's own `@sssb/kit` with the app's seam and fails `cdk synth` otherwise (see "Each app's deployment lives in the
    app, on the `SssbApp` construct"). A stack of the app's own passes the app's `tsconfig.json` as the migrator's
    `bundling.tsconfig` and checks the synthesized bundle with `migratorBundleProblems` from
    `@sssb/tools/assembly-checks`. If an old migrator ever ran, the database's `kysely_migration` table names
    `1001_dockets`, and it holds the fixture's tables rather than the app's.

    #### `0014_audit_credential` (jpslav/keel#34)

    Adds the nullable `credential_kind` and `credential_id` columns to `audit_events`: which credential an audited actor
    used. Earlier rows read NULL. Nothing to do.

    #### `0015_app_user_grant`, which needs Postgres 16 (jpslav/keel#53)

    Without it, on Aurora, whose master user is not a superuser, every `withTenant` failed with
    `permission denied to set role "app_user"`: the migrating role created `app_user` but could not switch to it.
    `0015` grants the migrating role `SET` on `app_user`, with `INHERIT FALSE`, and is a no-op for a superuser. It uses
    Postgres 16's `GRANT … WITH SET`, so SSSB now needs Postgres 16 or later. When the migrating role holds no ADMIN on
    `app_user` (a second owner on a cluster where another role created it), the run stops at `0015` and rolls back
    whole, and the error, which still begins `keel:`, gives the `GRANT` to run as a role that does hold it; the next run
    then migrates. A separate application role, and a restored dump, need the steps under "Operator actions".

    #### `0016_audit_detail` (jpslav/keel#58)

    Adds a nullable `detail jsonb` to `audit_events`, one `ALTER TABLE`; the table stays append-only for `app_user`.
    Nothing to do. An app's own screen that shows audit rows renders `detail` as text, never as HTML or Markdown.

    #### On the opt-in Data API transport (jpslav/keel#46)

    An app on `params.database.transport: 'data-api'` migrates every pending migration in one Data API transaction
    behind `pg_advisory_xact_lock`. The transaction dies after an hour or three idle minutes, and any statement still running at 45 seconds (waiting for
    that lock included) is cancelled (AWS's Data API limits, `packages/kit/src/adapters/real/migrate-handler.ts`); a
    migration that cannot fit runs on `pg`, from inside the VPC.

    **Now deletable.** A migrator entry in the app's own infra that names `packages/keel/src/adapters/real/migrate-handler.ts`
    with the root `tsconfig.json`.

- 2781d4a: ### Since keel 24b0589: operator actions

    **Kind.** operator

    **Action.** required

    **What changed.** What a deployer does for the changes since keel's `24b0589`: a Postgres floor, a grant a separate
    application role needs, a database transport chosen per app, the scheduled tick, and new cutover rows.

    **To adopt.**

    #### Postgres 16 or later (jpslav/keel#53)

    Framework migration `0015` needs it ("Framework migrations"). Aurora PostgreSQL 16.x meets it.

    #### A separate application role is granted the switch to `app_user` (jpslav/keel#53)

    Where the app connects as a role other than the migrating one (cutover row `db-role-not-superuser`), run this as the
    migrating role, or any role holding ADMIN on `app_user`:

    ```sql
    GRANT app_user TO <app role> WITH SET TRUE, INHERIT TRUE;
    ```

    After restoring a `pg_dump` into another cluster (roles are not in a dump, and the ledger says `0001` and `0015`
    already ran), as the migrating role: `CREATE ROLE app_user NOLOGIN;` before the restore; after it,
    `GRANT app_user TO CURRENT_USER WITH SET TRUE, INHERIT FALSE;` and the app role's grant above; then check
    `SET LOCAL ROLE app_user` as each role.

    #### The database transport is chosen per app, before the first deploy (jpslav/keel#46, #49)

    `apps/<app>/config/params.ts` names it as `database: { transport: 'pg' }` (the default, a Lambda inside the
    database's VPC) or `'data-api'` (opt-in: the RDS Data API from Lambdas outside any VPC, with no NAT). `SssbApp`
    refuses params without it. Both Lambdas now get `DATABASE_TRANSPORT`; on `data-api`, `DATABASE_CLUSTER_ARN`,
    `DATABASE_SECRET_ARN` and `DATABASE_NAME` replace `DATABASE_URL`, and IAM on that one cluster and its secret is the
    only path to the database. Switching an existing stack does not work (the new subnets overlap the old and the
    deploy rolls back): changing shape later means a new stack and a restore from a snapshot.

    #### The scheduled tick (jpslav/keel#55)

    Point a scheduler at the app's `/api/webhooks/cron` (cutover row `scheduled-tick`), POSTing on a fixed cadence with
    `Authorization: Bearer $WEBHOOK_SECRET`. An app with no such route takes the starter's ("Scaffold changes to apply
    by hand"); without one, nothing runs SSSB's schedules or webhook deliveries in a deployment.

    #### New cutover rows (jpslav/keel#40, #46, #49, #52)

    Add to the app's cutover checklist the rows it needs, as `@sssb/kit/cutover/rows.json` lists them: `data-api` and
    `data-api-access` for an app on the Data API, and `storage-copy` and `storage-head` for an app that calls the
    storage port's `copy` or `head`. Each is proven against the real service.

    #### Logs and alerts (jpslav/keel#61; safeinsights/sssb#8)
    - A pooled `pg` connection the server ends (a failover, an idle timeout) is now logged as
      `SSSB db: a pooled database connection ended (<code>: <message>)` instead of crashing the Lambda. A metric filter
      on that text counts them.
    - Sentry 11 changes its own span names and attributes (Sentry's v11 migration guide; safeinsights/sssb#8). Check any
      Sentry dashboard or alert that filters on v10's.

- 2781d4a: ### Since keel 24b0589: scaffold changes to apply by hand

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

    Keep the allowlist entry for `packages/keel/src/service-auth/webhook\.test\.ts` when the directory goes, and mark it
    as covering history only: CI's gitleaks scans the whole history, not the tree, and the commits that hold that file
    still carry its placeholder secret. (Corrected in v0.2.0-rc.2; v0.2.0-rc.0's notes said to remove the entry.) Give
    any entry of the app's own that pairs `paths` with `regexes` `condition = "AND"`: without it, gitleaks combines them
    with OR and exempts every finding in those paths.

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

- 2781d4a: ### Since keel 24b0589: seam changes

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
    - Make the seam a workspace package (`seam-workspace-package.md` has why: a `link:` is unlinked by `pnpm add`): list
      `apps/*/src/app-config` in `pnpm-workspace.yaml`'s `packages`, give `src/app-config/package.json`
      `{ "name": "<name>-app-config", "private": true, "exports": { "./db/migrations": "./db/migrations/index.ts", "./*": "./*.ts" } }`,
      plus the app's own `"type"` if its `package.json` sets one, and declare
      `"@sssb/app-config": "workspace:<name>-app-config@*"` in the app's `dependencies` (`<name>` is the app's package
      name). A seam module that is a directory or a `.tsx` file
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

- daa8637: ### The seam is a workspace package, so `pnpm add` keeps it linked

    **Kind.** seam

    **Action.** required

    **What changed.** An app's seam declared as `"@sssb/app-config": "link:./src/app-config"` is unlinked from the app's
    `@sssb/kit` by the next partial install for the app, `pnpm add <pkg>`, `pnpm remove <pkg>` or `pnpm update <pkg>`,
    whether run from the root with `--filter` or in the app's directory: `sssb doctor` then fails ("runs on a seam not its
    own") and typecheck fails inside the kit, and `pnpm install` does not bring it back. The seam is now a workspace
    package with a name of its own, which the app takes under the name the framework imports, and pnpm keeps that linked.
    `sssb doctor` fails an app that still declares its seam as a `link:`, even while it is linked, and says what to
    change; it also fails an app whose declared seam is another app's, and one whose `workspace:` seam names no workspace
    package, or more than one (an adopter who skips step 1 sees this).
    The conformance suite's `seam-map` check holds the seam's `package.json` to the name the app declares it by. A
    workspace `pnpm create @sssb` writes has the new form, and the plugin's commands say `pnpm --filter <app> add <pkg>`
    again.

    **To adopt.** For each app (`apps/<app>`, whose `package.json` name is `<name>`):

    1. In `pnpm-workspace.yaml`, add the seams to `packages`: `- apps/*/src/app-config`, or each app's
       `apps/<app>/src/app-config`.
    2. In `apps/<app>/src/app-config/package.json`, change `"name": "@sssb/app-config"` to `"name": "<name>-app-config"`
       (any name no other package of the workspace has; leave `exports` and `type` as they are).
    3. In `apps/<app>/package.json`, change `"@sssb/app-config": "link:./src/app-config"` to
       `"@sssb/app-config": "workspace:<name>-app-config@*"`.
    4. Run `pnpm install` and commit `pnpm-lock.yaml`, then `pnpm sssb:doctor` (or
       `pnpm exec sssb doctor --app apps/<app>`). This also repairs a seam a
       `pnpm add` already unlinked; no clean install is needed.
    5. If your `knip.json` lists `src/app-config/**` among an app's entries, knip now counts those files as the seam's own
       workspace: move them to `"apps/<app>/src/app-config": { "entry": ["**/*.ts"] }`.

    **Now deletable.** Any rule or note telling authors to edit `package.json` by hand instead of running `pnpm add`, to
    restore `pnpm-lock.yaml` after one, or to delete every `node_modules` and the lockfile to relink the seam.

### Patch Changes

- 03a2ae1: ### An app can declare a port slot of its own, and `sssb doctor` fails two apps on one slot

    **Kind.** seam

    **Action.** optional

    **What changed.** A workspace with two apps made from the starter had both on the `starter` slot, so both dev servers
    bound one port, and under Playwright's `reuseExistingServer` the second app's e2e run adopted the first app's server and
    tested the wrong app. An app now declares a slot of its own in its `package.json`, beside the string form, which works
    as before: `"sssb": { "port": { "name": "ledger", "default": 3700 } }`. The name is lowercase words joined by `-`; the
    default is an integer from 1024 to 49151 that no SSSB service's port holds (3000, 3100, 3200-3599, 5439-5639,
    20000-29999, 61000-61199). The override is `LEDGER_PORT` (`<NAME>_PORT`, `-` as `_`), and a linked worktree derives the
    port from 20000-29999, keyed on the name as well as the checkout. `sssb port`, `sssb tick`, `sssb dev-tick`,
    `sssb serve-standalone` and `sssb launch-json` read the declaration; `originForApp(__dirname)` from
    `@sssb/tools/ports` reads it for a Playwright config, and `originFor()` and `portFor()` called with no argument read it from the app
    the working directory is in. `sssb doctor` now fails an invalid
    declaration, two apps on one slot, and two slots with one default.

    **To adopt.** A workspace with one app needs nothing. A workspace with a second app declares its slot in that app's
    `package.json` (above) in place of `"port": "starter"`, and in the app: its `playwright.config.ts` calls `originForApp(__dirname)`
    instead of `originFor('starter')`, its `dev` script is `sssb dev-tick -- next dev …` (no `starter`
    before the `--`) and a `tick` script is `sssb tick` (no `starter`; the commands refuse `starter` and `showcase` in an
    app that declares a slot of its own, rather than quietly use the other app's port), and a contract test's `portFor('contractPg')` stays.
    Run `pnpm exec sssb doctor`: it fails while two apps share a slot.

    **Now deletable.** A hand-set `STARTER_PORT` or a `--port` literal in the second app's scripts that kept its dev server
    off the first app's port.

- 471e150: ### A generated workspace's README links SSSB's adoption guide, and the generated app stops calling itself a template

    **Kind.** none

    **Action.** none

    **What changed.** The `README.md` that `@sssb/create` writes now links SSSB's adoption guide (`docs/adopting.md`) and
    its reference app, both at the commit the workspace pins, says why the app sits under `apps/`, names the `UPDATE-ME`
    tags in `infra/lib/tags.ts` to replace before a deploy (they were `TEMPLATE-UPDATE-ME`), and points its "Upgrading
    SSSB" section at each release's "Upgrading to this release" commands and the guide's "Upgrading by release". The next steps the generator prints end by saying that
    `pnpm dev` runs the app. The generated app's welcome subtitle and comments no longer call it a template. The app
    guide says where to read its two worked examples, the first migration and the items route, once you have removed
    them, and the `scheduled-tick` cutover row no longer mentions two example apps.

- 7cd28e2: ### SSSB's packages are on npm, and a release is a plain version

    **Kind.** scaffold

    **Action.** optional

    **What changed.** `@sssb/kit`, `@sssb/tools`, `@sssb/eslint-plugin`, `@sssb/cdk` and `@sssb/create` are public, and
    SSSB's release flow publishes them to npm with provenance at one version. Release candidates (`-rc.N` tarballs on a
    GitHub prerelease) end here: this release's notes carry every change since the first candidate, and later releases are
    plain `0.x.y` versions on npm only. `pnpm create @sssb` now fetches the generator from npm, and the workspace it writes
    depends on each package at `^` its version.

    **To adopt.** In each workspace package that depends on an `@sssb/*` package by a release-candidate tarball URL (or a
    `file:` path), replace the URL with the version, and drop any `overrides` you kept for them:

    ```json
    {
        "@sssb/kit": "^0.2.0",
        "@sssb/tools": "^0.2.0"
    }
    ```

    Then `pnpm install`, commit the lockfile, and run `pnpm exec sssb doctor`: it reports a workflow or plugin marketplace
    pin that is not this release's commit, and you move each pin it names. Staying on a candidate's tarballs keeps working,
    but no later release ships as tarballs.

    **Now deletable.** Tarball URLs copied from a prerelease's notes, the `sha512` checks made against them, and any
    `overrides` or `file:` paths that pointed `@sssb/*` at a downloaded tarball.

- 8e5fd17: ### A dashed slug names a database Aurora accepts

    **Kind.** none

    **Action.** none

    **What changed.** `SssbApp` names the app's database from its slug with each dash as an underscore (`acme-corp`
    becomes `acme_corp`): the cluster's default database, the server's `DATABASE_NAME` or `DATABASE_URL`, and the
    migrator's `DATABASE_NAME`, which the framework's migrate handler now prefers to the secret's `dbname` on `pg`. Aurora
    PostgreSQL's database names allow no dash, so an app with a dashed slug synthesized and then failed at deploy. A slug
    with no dash names the same database as before, so no existing deployment's database changes. A slug whose name the
    engine reserves (`user`, `select`) or that runs past 63 characters is refused at synth.
    `databaseNameFor(slug)`, exported from `@sssb/cdk`, gives the same name to infra that does not use the construct.

- 846d11d: ### Linear-time trims, and complete escaping

    **Kind.** none

    **Action.** none

    **What changed.** Trims that used regexes taking time quadratic in a long run of one character now use loops or an
    index, with the same results: the doc-path engine (`@sssb/tools/doc-paths`, `sssb check-doc-paths`) on trailing
    slashes, quotes and `,;)`; `sssb doctor` on trailing slashes in `pnpm-workspace.yaml` globs; `@sssb/create` on a git
    remote's trailing slashes; and `@sssb/eslint-plugin`'s package-edge rule on a specifier's `?query` or `#hash`.
    `contractDatabaseName` (`@sssb/kit/testing`) trims its underscores by a loop too. `sssb doctor` still fills only the
    first `*` of a tsconfig `paths` target, as TypeScript's resolver does, without `String#replace`. The app preset of
    `@sssb/eslint-plugin` also escapes a backslash when it turns a name into a glob; no app can reach that case today (an
    app directory whose name holds a backslash cannot load its `lint-exceptions.mjs`, the only place the name is used).

- 3c9d89a: ### The real S3 storage adapter is published: `@sssb/kit/adapters/real/s3-storage`

    **Kind.** seam

    **Action.** optional

    **What changed.** The storage adapter SSSB's real-mode registry builds is now published as
    `createS3Storage(options)` from `@sssb/kit/adapters/real/s3-storage`, so an app that needs storage outside SSSB's
    registry (a simulated app run against a real bucket or an S3-compatible endpoint, say) uses the same adapter rather
    than a copy. The options are `bucket` (required), and `region`, `endpoint`, `credentials` (values or a provider) and
    `forcePathStyle`, each passed to the S3 client as the AWS SDK names it; or `client`, an `S3Client` you built, used as it
    is. A `client` together with any of the four client options is refused, since they would be ignored. Left out, region
    and credentials come from the AWS SDK's own lookup. The storage port (`@sssb/kit/ports/storage`) is unchanged.

    **To adopt.** Where the app builds the storage port itself, import the factory from a module in its own
    `src/adapters/real/` (elsewhere on the app's request path SSSB's real adapters are loaded only with `import()`):

    ```ts
    import { createS3Storage } from '@sssb/kit/adapters/real/s3-storage'

    // adapters/real/ is where an app reads process.env
    const storage = createS3Storage({
        bucket: process.env.STORAGE_BUCKET as string,
        region: 'us-east-1',
        endpoint: 'http://127.0.0.1:9000', // an S3-compatible endpoint; leave out for AWS
        forcePathStyle: true, // as most S3-compatible endpoints need
    })
    ```

    `credentials` takes what the AWS SDK's `S3Client` takes, static keys or a provider such as `fromIni()` from
    `@aws-sdk/credential-providers` (a dependency of the app's own).

    **Now deletable.** A copy of SSSB's S3 storage adapter (a `StoragePort` built on `@aws-sdk/client-s3`, its presigned
    download URLs forced to `attachment`) kept in the app's `adapters/real/` because the kit did not publish one.

- 9b1dce7: ### The conformance and contract suites clean up their scratch directories under `isolate: false`

    **Kind.** none

    **Action.** none

    **What changed.** With Vitest's `isolate: false`, a later test file that ran `conformanceSuite` or `contractSuite` could
    leave behind the contract server's scratch directory, made in a `beforeAll`, so `sssb check-tmpdir-leak` failed the
    run. Each suite now registers its file's cleanup itself, after its own teardown, so its directories are removed in
    every file. A demo-presets replay that outlives its test no longer has its directory deleted under it. Nothing changes in the app: both suites are already called at a test file's top level.

- 362056f: ### The plugin enabled at the workflow's commit, and `sssb doctor` reporting both pins

    **Kind.** scaffold

    **Action.** optional

    **What changed.** `@sssb/kit` names the commit it was released from in `dist/release.json`, and `sssb doctor` reports
    (never fails) when the commit your `.github/workflows/*.yml` pins SSSB's reusable workflow at, or the one your
    `.claude/settings.json` pins SSSB's plugin marketplace at, is not that commit, naming both, and when no plugin is
    enabled from that marketplace (naming the ones that are). A workspace
    `pnpm create @sssb` writes now has a `.claude/settings.json` that declares SSSB's marketplace (`sssb`) pinned to the
    workflow's commit and enables its plugin (`sssb@sssb`: the app-author commands as `/sssb:<command>`, and the
    `doc-steward` agent), and a `CLAUDE.md` that imports `.claude/sssb-guide.md`.

    **To adopt.** In an existing workspace, write `.claude/settings.json`:
    `{ "extraKnownMarketplaces": { "sssb": { "source": { "source": "github", "repo": "safeinsights/sssb", "ref": "<the
commit your workflow pins>" } } }, "enabledPlugins": { "sssb@sssb": true } }`. A commit `ref` needs Claude Code 2.1.324
    or later. Each person runs `claude plugin install sssb@sssb --scope project` once per clone, after trusting the folder.
    Keep a line holding `@.claude/sssb-guide.md` in your `CLAUDE.md`. On each upgrade, raise the marketplace's `ref` with
    the workflow's pin.

    **Now deletable.** Copies of SSSB's app-author commands and `doc-steward` agent kept in your own `.claude/commands/`
    and `.claude/agents/`.

## 0.2.0-rc.2

### Minor Changes

- b4770eb: ### An app names the cluster-wide roles its migrations create: `appRoles`

    **Kind.** seam

    **Action.** required

    **What changed.** An app whose migrations create a role of their own (beside the framework's `app_user`) now names it
    in an optional `appRoles` export of its `@sssb/app-config/db/migrations` module. The contract suite's owner pass grants a
    later owner ADMIN on exactly those roles, as it does on `app_user`, so a migration that alters such a role passes on
    every pass, not only the first. It grants on an ordinary role only: it refuses, before granting anything, a named role
    that can log in, has CREATEDB, CREATEROLE, SUPERUSER, BYPASSRLS or REPLICATION, holds a privilege on a server parameter
    (`pg_parameter_acl`), owns a database or tablespace, or is a member, at any depth, of any role but `app_user` and the
    app's other named roles (ADMIN lets the owner grant itself SET on the role and act as it and as all of those), and it
    fails when the owner's own migrations leave a named role more than ordinary. It holds `app_user`, on which every later
    owner gets ADMIN too, to the same attributes, privileges and ownerships, before granting and after the migrations:
    `app_user` may be a member of the app's named roles and of other roles ordinary in shape (another app's, on a shared
    server), never of a `pg_*` or `rds_*` role or one with any of those attributes, privileges or ownerships. A new conformance check, `app-roles`, fails a role the
    migrations create that `appRoles` does not name, a name no migration creates, and a named role or `app_user` the
    migrations leave more than ordinary, on pglite in the unit run. The owner pass's teardown now also revokes what
    its owner granted (`DROP OWNED BY`), so a migration that grants a role TO `app_user` no longer leaves the owner behind,
    and an owner it cannot drop fails the pass instead of staying on the server. An app that creates no role changes
    nothing.

    **To adopt.** If your migrations create a role, export its name beside `appMigrations`, from the module
    `@sssb/app-config/db/migrations` resolves to (`src/app-config/db/migrations.ts`, or `migrations/index.ts`):

    ```ts
    export const appRoles = ['app_maintainer'] as const
    ```

    Create the role only where it does not exist yet, as an ordinary role, and keep it one in every later migration:
    NOLOGIN, no other attribute, no privilege on a server parameter, no database or tablespace of its own, and no membership
    but `app_user` and your other named roles (granting it TO `app_user` is fine):

    ```sql
    DO $$ BEGIN
        IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'app_maintainer') THEN
            CREATE ROLE app_maintainer NOLOGIN;
        END IF;
    END $$
    ```

    Leave `app_user` ordinary as well: never change its attributes, give it no parameter privilege, database or tablespace, and grant
    it only your named roles.

    Then make a migration that only warned when it lacked ADMIN on its role fail again: the owner pass now gives a later
    owner that ADMIN, so a failure there is real.

    **Now deletable.** A migration that catches `permission denied` on its own role and warns instead of failing, to get
    past the contract suite's second owner pass.

- 3c9d89a: ### Correction: keep the `.gitleaks.toml` entry for keel's `webhook.test.ts`

    **Kind.** scaffold

    **Action.** required

    **What changed.** v0.2.0-rc.0's notes ("Since keel 24b0589: scaffold changes to apply by hand", under `.gitleaks.toml`)
    said to remove the allowlist entry for `packages/keel/src/service-auth/webhook\.test\.ts` along with the directory.
    That was wrong for a workspace that was forked from keel: CI's gitleaks scans the whole history, not the tree
    (`gitleaks git` over a checkout with `fetch-depth: 0`), and the commits that hold that file still carry its
    placeholder secret, so a scan without the entry reports it. Deleting the directory takes the file out of the tree,
    not out of history. A workspace `pnpm create @sssb` generated has no keel history and no such entry.

    **To adopt.** Keep the entry, scoped as it was (`condition = "AND"`, the path and the one string), and say in its
    comment that it covers history only, so nobody removes it later because the file is gone. If you removed it, restore
    it:

    ```toml
    # History only: packages/keel is gone from the tree, but its webhook.test.ts and the placeholder secret below are
    # still in this repository's history, which gitleaks scans.
    [[allowlists]]
    description = "keel's webhook.test.ts WEBHOOK_SECRET fixture, in history only"
    condition = "AND"
    paths = ['''packages/keel/src/service-auth/webhook\.test\.ts''']
    regexes = ['''env-secret-abcdef0123456789''']
    regexTarget = "line"
    ```

    The rest of that item stands: give any entry of the app's own that pairs `paths` with `regexes` `condition = "AND"`.

### Patch Changes

- 3c9d89a: ### The real S3 storage adapter is published: `@sssb/kit/adapters/real/s3-storage`

    **Kind.** seam

    **Action.** optional

    **What changed.** The storage adapter SSSB's real-mode registry builds is now published as
    `createS3Storage(options)` from `@sssb/kit/adapters/real/s3-storage`, so an app that needs storage outside SSSB's
    registry (a simulated app run against a real bucket or an S3-compatible endpoint, say) uses the same adapter rather
    than a copy. The options are `bucket` (required), and `region`, `endpoint`, `credentials` (values or a provider) and
    `forcePathStyle`, each passed to the S3 client as the AWS SDK names it; or `client`, an `S3Client` you built, used as it
    is. A `client` together with any of the four client options is refused, since they would be ignored. Left out, region
    and credentials come from the AWS SDK's own lookup. The storage port (`@sssb/kit/ports/storage`) is unchanged.

    **To adopt.** Where the app builds the storage port itself, import the factory from a module in its own
    `src/adapters/real/` (elsewhere on the app's request path SSSB's real adapters are loaded only with `import()`):

    ```ts
    import { createS3Storage } from '@sssb/kit/adapters/real/s3-storage'

    // adapters/real/ is where an app reads process.env
    const storage = createS3Storage({
        bucket: process.env.STORAGE_BUCKET as string,
        region: 'us-east-1',
        endpoint: 'http://127.0.0.1:9000', // an S3-compatible endpoint; leave out for AWS
        forcePathStyle: true, // as most S3-compatible endpoints need
    })
    ```

    `credentials` takes what the AWS SDK's `S3Client` takes, static keys or a provider such as `fromIni()` from
    `@aws-sdk/credential-providers` (a dependency of the app's own).

    **Now deletable.** A copy of SSSB's S3 storage adapter (a `StoragePort` built on `@aws-sdk/client-s3`, its presigned
    download URLs forced to `attachment`) kept in the app's `adapters/real/` because the kit did not publish one.

## 0.2.0-rc.1

No changes in this release.

## 0.2.0-rc.0

### Minor Changes

- 362056f: ### The app guide gains the cutover rule and the dev loop

    **Kind.** seam

    **Action.** required

    **What changed.** SSSB's app guide (`@sssb/kit/guide.md`) now also says what SSSB's own agent guide said only to its
    maintainers and an app author needs: anything needing real credentials is a row in the workspace's cutover checklist,
    never a blocker; scheduled work runs in dev only when something ticks it (`pnpm tick`, `DEV_TICK_SECONDS`), and the
    cron route stays behind `withWebhookSecret`; a linked worktree derives the app's ports per checkout
    (`pnpm exec sssb port`); and the workflow (`pnpm verify` before finishing, `pnpm lint:fix`, conventional commits).
    `sssb doctor` fails until the workspace's copy is refreshed.

    **To adopt.** Run `pnpm exec sssb guide` from your app and commit the diff of `.claude/sssb-guide.md`.

    **Now deletable.** Those rules copied by hand from SSSB's `CLAUDE.md` into your own.

- e574680: ### The app guide ships in `@sssb/kit`

    **Kind.** seam

    **Action.** required

    **What changed.** `@sssb/kit` ships the app guide, the rules an agent follows in your app (the seam, vendor SDKs only
    in adapters, `db.withTenant()`, `authorize(...)`, i18n, router-agnostic screens, hermetic dev, migrations, the
    conformance and contract tests), at the published subpath `@sssb/kit/guide.md`. `sssb guide` copies it into your
    repository under a hash stamp, and `sssb doctor` now fails while that copy is missing or stale. The doc-paths gate
    gained `sssb.docPaths.relativeTo`, which reads a doc's citations against a directory instead of the workspace root.

    **To adopt.** From any app, run `pnpm exec sssb guide`; it writes `.claude/sssb-guide.md` at the workspace root.
    Commit it, and import it from your own `CLAUDE.md` with a line holding `@.claude/sssb-guide.md`. The guide cites paths
    relative to an app (`src/app-config/`, `config/params.ts`), so if your `sssb.docPaths.include` reaches `.claude`, map
    the copy to your app in the root `package.json`: `"relativeTo": { ".claude/sssb-guide.md": "apps/<app>" }` inside
    `sssb.docPaths`. After each upgrade, run `pnpm exec sssb guide` again and review the diff before you commit it.

    **Now deletable.** Rules copied by hand from SSSB's `CLAUDE.md` into your own: the seam, vendor and `process.env`
    fences, tenancy, authorization, i18n, migration numbering and the test conventions the guide now states.

- 835e887: ### The starter runs the conformance suite and doctor

    **Kind.** scaffold

    **Action.** required

    **What changed.** The starter gained `src/sssb.conformance.test.ts`, its `tests/contract/rls-contract.test.ts` calls
    `contractSuite` from `@sssb/kit/testing/contract`, and its `package.json` gained the `sssb:doctor` (`sssb doctor`) and
    `check:e2e` (`sssb check-e2e`) scripts and an `embedded-postgres` devDependency.

    **To adopt.** Copy the starter's `src/sssb.conformance.test.ts` into each app, replace the body of each app's
    `tests/contract/rls-contract.test.ts` with the starter's, and add the two scripts and the devDependency to each app's
    `package.json`. Run `pnpm exec sssb doctor` once from any app: it checks every app of the workspace.

- 835e887: ### The conformance suite, `sssb doctor` and `sssb check-e2e`

    **Kind.** seam

    **Action.** required

    **What changed.** The framework's checks that must hold for every app now ship as a suite the app calls from its own
    tree: `@sssb/kit/testing` (the authorization scan of the app's routes, i18n partition and parity, the pglite RLS
    proofs, migration order, demo presets, the seam map) and `@sssb/kit/testing/contract` (the same proofs on real
    Postgres as a non-superuser owner and as a superuser, and over the RDS Data API through its emulator). The kit no
    longer ships its seam-conformance test files. `sssb doctor`, one run for every app of the workspace, fails unless
    each singleton peer has one copy, every importer of `@sssb/kit` links its own seam, the `@sssb/*` packages share one
    version, the Vitest config a bare `vitest` would load for each app runs every unit check, and some config runs every
    contract check. It reports, without failing, any other Vitest config that runs an app's tests without the checks, a
    bare `vitest` from an app's directory that would not run its suite when the root's run is the main one, the narrowing
    flags the package.json scripts pass to vitest, and which script runs each contract config, since it cannot
    see what CI runs. Playwright specs may reach the framework only through `@sssb/kit/testing/e2e`, which ships compiled
    and seam-free, and `sssb check-e2e`, asking Playwright which files each config loads, fails a spec that reaches any
    other framework file.

    **To adopt.** In each app:

    - Add `src/sssb.conformance.test.ts` holding
      `conformanceSuite({ appDir: path.resolve(import.meta.dirname, '..'), optOut: {} })`, with `conformanceSuite` from
      `@sssb/kit/testing`. A check is left out only by name, with a reason: `optOut: { '<check id>': '<why>' }`; the ids
      are in `@sssb/kit/testing/checks.json`.
    - Make `tests/contract/rls-contract.test.ts` call `contractSuite({ port: portFor('contractPg'), optOut: {} })`, with
      `contractSuite` from `@sssb/kit/testing/contract` and `portFor` from `@sssb/tools/ports`, and add
      `embedded-postgres` to the app's devDependencies for local runs (CI can set `CONTRACT_DATABASE_URL` instead). Keep
      `test:contract` in CI: doctor proves the contract checks would run, not that CI runs them.
    - An authorization exemption of the app's own goes in `authz-exemptions.mjs` at the app's root, each entry with a
      `reason` and a `mustMatch` gate; one that matches no mutating route in the app, overlaps a framework entry, or is a prefix
      nested in another of the app's prefixes, fails.
    - In Playwright specs, import webhook-signature helpers from `@sssb/kit/testing/e2e`, not `@sssb/kit/core/…`, and
      read app constants from modules that import nothing from SSSB but types.
    - Run `sssb doctor` (once, from the workspace root) and `sssb check-e2e` (in each app) in verify and in CI, and read
      doctor's reports: if CI runs a Vitest config other than the one doctor holds to the checks, they do not run there.

    **Now deletable.** A Vitest `include` that reaches the framework's test files under `node_modules`, with the default
    `exclude` overridden to let them run; a copied real-Postgres contract harness (a `defineContractSuite` and its server
    helper); and a hand-run `readlink -f` comparison of the app's and the framework's React, Next or Mantine copies.

- 2781d4a: ### Since keel 24b0589: framework migrations

    **Kind.** migration

    **Action.** required

    **What changed.** Three framework migrations, `0014` to `0016`, arrived after keel's `24b0589` and run on the
    migrator's next run. Before them comes a fix to the migrator itself: one bundled the way keel's `infra/stack.ts` did
    at `24b0589` carries the wrong app's migrations.

    **To adopt.** Deploy a migrator bundled from the app (first item) before it runs against any database, make sure the
    database is Postgres 16 or later, then run it once.

    #### The migrator runs the app's migrations only when bundled from the app (jpslav/keel#54)

    At `24b0589`, `infra/stack.ts` bundled the migrator Lambda with the repository's root `tsconfig.json`, whose
    `@app-config/*` path points at keel's test fixture, so the bundle carried the fixture's `1001_dockets`,
    `1002_dockets_due_on` and `1003_dockets_last_touched_at` and none of the app's migrations. `SssbApp` bundles it from
    the app's own `@sssb/kit` with the app's seam and fails `cdk synth` otherwise (see "Each app's deployment lives in the
    app, on the `SssbApp` construct"). A stack of the app's own passes the app's `tsconfig.json` as the migrator's
    `bundling.tsconfig` and checks the synthesized bundle with `migratorBundleProblems` from
    `@sssb/tools/assembly-checks`. If an old migrator ever ran, the database's `kysely_migration` table names
    `1001_dockets`, and it holds the fixture's tables rather than the app's.

    #### `0014_audit_credential` (jpslav/keel#34)

    Adds the nullable `credential_kind` and `credential_id` columns to `audit_events`: which credential an audited actor
    used. Earlier rows read NULL. Nothing to do.

    #### `0015_app_user_grant`, which needs Postgres 16 (jpslav/keel#53)

    Without it, on Aurora, whose master user is not a superuser, every `withTenant` failed with
    `permission denied to set role "app_user"`: the migrating role created `app_user` but could not switch to it.
    `0015` grants the migrating role `SET` on `app_user`, with `INHERIT FALSE`, and is a no-op for a superuser. It uses
    Postgres 16's `GRANT … WITH SET`, so SSSB now needs Postgres 16 or later. When the migrating role holds no ADMIN on
    `app_user` (a second owner on a cluster where another role created it), the run stops at `0015` and rolls back
    whole, and the error, which still begins `keel:`, gives the `GRANT` to run as a role that does hold it; the next run
    then migrates. A separate application role, and a restored dump, need the steps under "Operator actions".

    #### `0016_audit_detail` (jpslav/keel#58)

    Adds a nullable `detail jsonb` to `audit_events`, one `ALTER TABLE`; the table stays append-only for `app_user`.
    Nothing to do. An app's own screen that shows audit rows renders `detail` as text, never as HTML or Markdown.

    #### On the opt-in Data API transport (jpslav/keel#46)

    An app on `params.database.transport: 'data-api'` migrates every pending migration in one Data API transaction
    behind `pg_advisory_xact_lock`. The transaction dies after an hour or three idle minutes, and any statement still running at 45 seconds (waiting for
    that lock included) is cancelled (AWS's Data API limits, `packages/kit/src/adapters/real/migrate-handler.ts`); a
    migration that cannot fit runs on `pg`, from inside the VPC.

    **Now deletable.** A migrator entry in the app's own infra that names `packages/keel/src/adapters/real/migrate-handler.ts`
    with the root `tsconfig.json`.

- 2781d4a: ### Since keel 24b0589: operator actions

    **Kind.** operator

    **Action.** required

    **What changed.** What a deployer does for the changes since keel's `24b0589`: a Postgres floor, a grant a separate
    application role needs, a database transport chosen per app, the scheduled tick, and new cutover rows.

    **To adopt.**

    #### Postgres 16 or later (jpslav/keel#53)

    Framework migration `0015` needs it ("Framework migrations"). Aurora PostgreSQL 16.x meets it.

    #### A separate application role is granted the switch to `app_user` (jpslav/keel#53)

    Where the app connects as a role other than the migrating one (cutover row `db-role-not-superuser`), run this as the
    migrating role, or any role holding ADMIN on `app_user`:

    ```sql
    GRANT app_user TO <app role> WITH SET TRUE, INHERIT TRUE;
    ```

    After restoring a `pg_dump` into another cluster (roles are not in a dump, and the ledger says `0001` and `0015`
    already ran), as the migrating role: `CREATE ROLE app_user NOLOGIN;` before the restore; after it,
    `GRANT app_user TO CURRENT_USER WITH SET TRUE, INHERIT FALSE;` and the app role's grant above; then check
    `SET LOCAL ROLE app_user` as each role.

    #### The database transport is chosen per app, before the first deploy (jpslav/keel#46, #49)

    `apps/<app>/config/params.ts` names it as `database: { transport: 'pg' }` (the default, a Lambda inside the
    database's VPC) or `'data-api'` (opt-in: the RDS Data API from Lambdas outside any VPC, with no NAT). `SssbApp`
    refuses params without it. Both Lambdas now get `DATABASE_TRANSPORT`; on `data-api`, `DATABASE_CLUSTER_ARN`,
    `DATABASE_SECRET_ARN` and `DATABASE_NAME` replace `DATABASE_URL`, and IAM on that one cluster and its secret is the
    only path to the database. Switching an existing stack does not work (the new subnets overlap the old and the
    deploy rolls back): changing shape later means a new stack and a restore from a snapshot.

    #### The scheduled tick (jpslav/keel#55)

    Point a scheduler at the app's `/api/webhooks/cron` (cutover row `scheduled-tick`), POSTing on a fixed cadence with
    `Authorization: Bearer $WEBHOOK_SECRET`. An app with no such route takes the starter's ("Scaffold changes to apply
    by hand"); without one, nothing runs SSSB's schedules or webhook deliveries in a deployment.

    #### New cutover rows (jpslav/keel#40, #46, #49, #52)

    Add to the app's cutover checklist the rows it needs, as `@sssb/kit/cutover/rows.json` lists them: `data-api` and
    `data-api-access` for an app on the Data API, and `storage-copy` and `storage-head` for an app that calls the
    storage port's `copy` or `head`. Each is proven against the real service.

    #### Logs and alerts (jpslav/keel#61; safeinsights/sssb#8)
    - A pooled `pg` connection the server ends (a failover, an idle timeout) is now logged as
      `SSSB db: a pooled database connection ended (<code>: <message>)` instead of crashing the Lambda. A metric filter
      on that text counts them.
    - Sentry 11 changes its own span names and attributes (Sentry's v11 migration guide; safeinsights/sssb#8). Check any
      Sentry dashboard or alert that filters on v10's.

- 2781d4a: ### Since keel 24b0589: scaffold changes to apply by hand

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

- 2781d4a: ### Since keel 24b0589: seam changes

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
    - Make the seam a workspace package (`seam-workspace-package.md` has why: a `link:` is unlinked by `pnpm add`): list
      `apps/*/src/app-config` in `pnpm-workspace.yaml`'s `packages`, give `src/app-config/package.json`
      `{ "name": "<name>-app-config", "private": true, "exports": { "./db/migrations": "./db/migrations/index.ts", "./*": "./*.ts" } }`,
      plus the app's own `"type"` if its `package.json` sets one, and declare
      `"@sssb/app-config": "workspace:<name>-app-config@*"` in the app's `dependencies` (`<name>` is the app's package
      name). A seam module that is a directory or a `.tsx` file
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

- daa8637: ### The seam is a workspace package, so `pnpm add` keeps it linked

    **Kind.** seam

    **Action.** required

    **What changed.** An app's seam declared as `"@sssb/app-config": "link:./src/app-config"` is unlinked from the app's
    `@sssb/kit` by the next partial install for the app, `pnpm add <pkg>`, `pnpm remove <pkg>` or `pnpm update <pkg>`,
    whether run from the root with `--filter` or in the app's directory: `sssb doctor` then fails ("runs on a seam not its
    own") and typecheck fails inside the kit, and `pnpm install` does not bring it back. The seam is now a workspace
    package with a name of its own, which the app takes under the name the framework imports, and pnpm keeps that linked.
    `sssb doctor` fails an app that still declares its seam as a `link:`, even while it is linked, and says what to
    change; it also fails an app whose declared seam is another app's, and one whose `workspace:` seam names no workspace
    package, or more than one (an adopter who skips step 1 sees this).
    The conformance suite's `seam-map` check holds the seam's `package.json` to the name the app declares it by. A
    workspace `pnpm create @sssb` writes has the new form, and the plugin's commands say `pnpm --filter <app> add <pkg>`
    again.

    **To adopt.** For each app (`apps/<app>`, whose `package.json` name is `<name>`):

    1. In `pnpm-workspace.yaml`, add the seams to `packages`: `- apps/*/src/app-config`, or each app's
       `apps/<app>/src/app-config`.
    2. In `apps/<app>/src/app-config/package.json`, change `"name": "@sssb/app-config"` to `"name": "<name>-app-config"`
       (any name no other package of the workspace has; leave `exports` and `type` as they are).
    3. In `apps/<app>/package.json`, change `"@sssb/app-config": "link:./src/app-config"` to
       `"@sssb/app-config": "workspace:<name>-app-config@*"`.
    4. Run `pnpm install` and commit `pnpm-lock.yaml`, then `pnpm sssb:doctor` (or
       `pnpm exec sssb doctor --app apps/<app>`). This also repairs a seam a
       `pnpm add` already unlinked; no clean install is needed.
    5. If your `knip.json` lists `src/app-config/**` among an app's entries, knip now counts those files as the seam's own
       workspace: move them to `"apps/<app>/src/app-config": { "entry": ["**/*.ts"] }`.

    **Now deletable.** Any rule or note telling authors to edit `package.json` by hand instead of running `pnpm add`, to
    restore `pnpm-lock.yaml` after one, or to delete every `node_modules` and the lockfile to relink the seam.

### Patch Changes

- 8e5fd17: ### A dashed slug names a database Aurora accepts

    **Kind.** none

    **Action.** none

    **What changed.** `SssbApp` names the app's database from its slug with each dash as an underscore (`acme-corp`
    becomes `acme_corp`): the cluster's default database, the server's `DATABASE_NAME` or `DATABASE_URL`, and the
    migrator's `DATABASE_NAME`, which the framework's migrate handler now prefers to the secret's `dbname` on `pg`. Aurora
    PostgreSQL's database names allow no dash, so an app with a dashed slug synthesized and then failed at deploy. A slug
    with no dash names the same database as before, so no existing deployment's database changes. A slug whose name the
    engine reserves (`user`, `select`) or that runs past 63 characters is refused at synth.
    `databaseNameFor(slug)`, exported from `@sssb/cdk`, gives the same name to infra that does not use the construct.

- 846d11d: ### Linear-time trims, and complete escaping

    **Kind.** none

    **Action.** none

    **What changed.** Trims that used regexes taking time quadratic in a long run of one character now use loops or an
    index, with the same results: the doc-path engine (`@sssb/tools/doc-paths`, `sssb check-doc-paths`) on trailing
    slashes, quotes and `,;)`; `sssb doctor` on trailing slashes in `pnpm-workspace.yaml` globs; `@sssb/create` on a git
    remote's trailing slashes; and `@sssb/eslint-plugin`'s package-edge rule on a specifier's `?query` or `#hash`.
    `contractDatabaseName` (`@sssb/kit/testing`) trims its underscores by a loop too. `sssb doctor` still fills only the
    first `*` of a tsconfig `paths` target, as TypeScript's resolver does, without `String#replace`. The app preset of
    `@sssb/eslint-plugin` also escapes a backslash when it turns a name into a glob; no app can reach that case today (an
    app directory whose name holds a backslash cannot load its `lint-exceptions.mjs`, the only place the name is used).

- 9b1dce7: ### The conformance and contract suites clean up their scratch directories under `isolate: false`

    **Kind.** none

    **Action.** none

    **What changed.** With Vitest's `isolate: false`, a later test file that ran `conformanceSuite` or `contractSuite` could
    leave behind the contract server's scratch directory, made in a `beforeAll`, so `sssb check-tmpdir-leak` failed the
    run. Each suite now registers its file's cleanup itself, after its own teardown, so its directories are removed in
    every file. A demo-presets replay that outlives its test no longer has its directory deleted under it. Nothing changes in the app: both suites are already called at a test file's top level.

- 362056f: ### The plugin enabled at the workflow's commit, and `sssb doctor` reporting both pins

    **Kind.** scaffold

    **Action.** optional

    **What changed.** `@sssb/kit` names the commit it was released from in `dist/release.json`, and `sssb doctor` reports
    (never fails) when the commit your `.github/workflows/*.yml` pins SSSB's reusable workflow at, or the one your
    `.claude/settings.json` pins SSSB's plugin marketplace at, is not that commit, naming both, and when no plugin is
    enabled from that marketplace (naming the ones that are). A workspace
    `pnpm create @sssb` writes now has a `.claude/settings.json` that declares SSSB's marketplace (`sssb`) pinned to the
    workflow's commit and enables its plugin (`sssb@sssb`: the app-author commands as `/sssb:<command>`, and the
    `doc-steward` agent), and a `CLAUDE.md` that imports `.claude/sssb-guide.md`.

    **To adopt.** In an existing workspace, write `.claude/settings.json`:
    `{ "extraKnownMarketplaces": { "sssb": { "source": { "source": "github", "repo": "safeinsights/sssb", "ref": "<the
commit your workflow pins>" } } }, "enabledPlugins": { "sssb@sssb": true } }`. A commit `ref` needs Claude Code 2.1.324
    or later. Each person runs `claude plugin install sssb@sssb --scope project` once per clone, after trusting the folder.
    Keep a line holding `@.claude/sssb-guide.md` in your `CLAUDE.md`. On each upgrade, raise the marketplace's `ref` with
    the workflow's pin.

    **Now deletable.** Copies of SSSB's app-author commands and `doc-steward` agent kept in your own `.claude/commands/`
    and `.claude/agents/`.
