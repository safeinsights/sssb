# Decision log

Decisions made during the build that the approved plan didn't anticipate, with rationale. (Planned decisions
live in `docs/adr/`; this file is the delta.)

**Reading older entries.** These are dated and append-only: an entry was true when written and is
never edited to match today's tree, so a later entry supersedes an earlier one rather than replacing
it. Two vocabulary changes affect entries written before 2026-07-31 — the dev/demo panel was called
**Backstage** before it became the **Simulator**, and `isFakeMode` became `isSimulated`. Paths in old
entries may name files that have since moved; the doctrine docs under `docs/` are what the path gate
holds to today's tree.

- **`allowBuilds` instead of `onlyBuiltDependencies`** — the plan named pnpm's older setting; pnpm 11
  wants the `allowBuilds` map in `pnpm-workspace.yaml`.
- **Adopted `minimumReleaseAge: 2880`** — not in the plan, but a cheap supply-chain guard: only install
  package versions published at least two days ago.
- **CI can run real-Postgres contract tests without testcontainers** — GitHub-hosted runners have docker, so a
  plain `services: postgres` container job can run the same contract suite that runs on embedded-postgres
  locally. Simpler than testcontainers; planned for the Phase 4/5 workflow.
- **Hand-rolled pglite Kysely dialect instead of `kysely-pglite`** — the plan said to prefer the maintained
  library, but the package is unmaintained (2024) and crashes against kysely 0.29's export layout. A ~90-line
  dialect built from kysely's own exported Postgres pieces is smaller than a version-pin workaround and is
  what gets promoted into the app db adapter.
- **RLS policies use `NULLIF(current_setting(...), '')`** — spike discovered the GUC empty-string quirk (see
  build notes); the plan's policy SQL specified the two-arg form only. Both ADR-0004's policy template and
  the spike migration carry the hardened form.
- **The static demo is always single-file** — the plan had "single-file inlined variant" as a stretch goal,
  but Chrome blocks external `type="module"` scripts on `file://`, so inlining is the only way the shell
  runs from disk at all. Stretch goal became the baseline.
- **react-email templates are previewed in Ladle**, not react-email's own preview server — one component
  workshop instead of two tools.
- **No react-router for the static shell** — four routes need ~15 lines of hashchange glue; a router
  dependency would be weight without benefit. Revisit if the shell grows real navigation.
- **No GitHub Actions deploy workflow** — the plan said "staging-deploy workflows authored, unrun", but
  the deploy pipeline is the piece most tied to an organisation's accounts and approval gates, so GH
  Actions runs checks only. Authoring a GHA deploy would guess at that for no benefit. CD is cutover row
  `deploy-pipeline`.
- **Lambda runtime pinned to `nodejs22.x` in the draft stack** — aws-cdk-lib's enum is authoritative at
  deploy time; bump to nodejs24 at cutover if the installed CDK exposes it (the app itself targets
  Node 24).
- **`src/adapters/real/migrate-handler.ts`** — the migrator Lambda entry lives in adapters (it imports
  AWS SDKs), enforced by the same boundary lint as everything else.
- **Analytics event log is append-only JSONL, not file-per-item** — the dev-tools work mirrors the email
  catch store, but events are high-volume and small, so the fake writes `.data/analytics/events.jsonl`
  (one JSON object per line) instead of one file per event as `fakeEmail` does.
- **Feature-flag toggle folded into `/dev/events`, not a separate `/dev/flags`** — `isFlagEnabled` is an
  analytics-port method and the flag file sits under `.data/analytics/`, so one page (event log + flag
  toggle) tells the whole analytics-port story rather than adding a fourth dev route for a single toggle.
- **Page views captured via a client beacon mounted in the protected layout, not server-side in it** —
  the layout is an RSC that doesn't re-run on client navigation and can't see the pathname, so a
  `usePathname` beacon posting to `/api/analytics/page-view` captures both the path and SPA navigations.
- **The static shell grew real navigation but stayed on the hashchange glue** — the earlier "no
  react-router for the static shell" call said to revisit if the shell grew navigation; it now has a
  header nav + dev-tools menu, and the ~15-line `go()`/`useHashRoute` glue still covers it without a
  router dependency.
- **Backstage's Mail/Events/Errors tabs are gated by mode, not role — deliberately reversing the
  earlier role gate.** The old `/dev/mailbox` + `/dev/events` + `/dev/errors` pages required
  `canManageOrg(user.role)` on top of `isFakeMode`, added specifically because a tenant-global
  mailbox on a public demo URL could otherwise expose addresses other visitors typed. Backstage
  drops that role check: `/api/dev/flags` and `/api/dev/error` move from
  `requireRole(...ORG_MANAGER_ROLES)` to `requireUser()`, and the Events/Errors panel tabs render
  for every role, proven by `tests/e2e/backstage-technical.spec.ts` signing in as `persona-member`.
  Reasoning: the persona picker already lets anyone become an admin persona in one click, so a
  role gate in fake mode was never real protection — just friction on the lowest-privilege demo
  walk the whole point of Backstage is to support. The gate that IS real stands unchanged: every
  `/api/backstage/*` route and both `/api/dev/*` routes still 404 outside fake mode, first line,
  so production never serves any of this.
- **Backstage naming: the app is the stage, the panel is backstage.** The collapsible right-docked
  panel that hosts Cast/Mail/Events/Errors (and Scenes, a later slice) is deliberately framed as a
  theater metaphor: `Cast` is who you can become, `Mail` is what they've received, `Scenes` will
  reset/snapshot the whole set. The metaphor motivates the mode-not-role gating above — a
  stagehand walking backstage doesn't need the actor's own credentials to check the props table.
- **`handleOpenMailLink`'s same-origin check now also accepts absolute URLs, not just relative
  paths.** The invite email's accept link changed in slice 3 from the slice-2 placeholder relative
  link to a real fully-qualified URL (built via `new URL(...).toString()` in
  `src/app/api/org/invite/route.ts`, since real invite emails must carry an absolute link — the
  recipient reads them from an arbitrary mail client, not this app). The old
  `href.startsWith('/')` check silently no-op'd on that absolute URL instead of rejecting it
  loudly; `tests/e2e/accept-invite.spec.ts` caught this as a stuck navigation, not code
  inspection. `src/app/[locale]/backstage-glue.tsx`'s `handleOpenMailLink` now also allows
  `new URL(href).origin === window.location.origin`, so the design invariant (same-origin only)
  still holds while covering both link shapes.
- **Scenes (reset/save/restore) operate on `.data/` as plain directory copies, not an
  application-level export/import format.** Every fake adapter already treats `.data/` as the
  simulated world's actual state — auth (session secret, invites, dynamic-persona overlay,
  profile overrides), emails, analytics, pglite, storage, and Backstage's own continuity file — so
  a named snapshot is just `cpSync` of those directories into `.data/scenes/<name>/`, and restoring
  is the same copy in reverse; no serialization format needed beyond the files that already exist.
  `pglite` is copied as-is (the on-disk database files), which is why `closeFakeDb()` (build notes)
  runs first — nothing may be mid-write. `src/adapters/fake/backstage-admin.ts` serializes
  reset/save/restore against each other with a module-level in-flight promise chain, but an
  ordinary request (e.g. a page-view beacon) racing the copy window is an accepted dev-tool
  hazard, not something the module guards against: Scenes only exists in fake mode (404
  everywhere else), so the worst case is a demo/dev annoyance, never a production concern.
- **Gating reversal for Scenes matches the rest of Backstage: mode, not role.** `/api/backstage/reset`
  and `/api/backstage/scenes*` follow the same pattern as every other Backstage route (finding #6
  reversal, above) — 404 outside fake mode, first line, no `requireRole`/`requireUser` gate. A
  stagehand resetting the set doesn't need the actor's own credentials either.
- **Feature flags moved from the Events tab to the Scenes tab.** Flags are world _knobs_ (they change how
  the set behaves), events are _observations_ — Scenes now hosts reset, snapshots, and flags together and
  Events is purely observational. The move also fixed a latent bug: every flag switch rendered the one
  hardcoded "demo-banner" label; labels now map per-flag with a raw-key fallback, so a second flag can't
  silently borrow the first one's name.
- **`/api/dev/error` and `/api/dev/flags` relocated to `/api/backstage/error-scenario` and
  `/api/backstage/flags`, dropping their `requireUser()` gate.** They only ever served Backstage tabs, and
  the rest of the panel's routes are mode-gated with no auth at all (knobs stay reachable signed-out, like
  reset). "The Backstage surface is `/api/backstage/*`" is now a complete sentence, with one uniform
  containment rule: 404 outside fake mode, first line.
- **Backstage feedback stays inside Backstage — no app-level toasts.** Transient confirmations (new mail
  caught, link copied, world reset, scene saved/deleted) render as a notice strip inside the panel; when
  the panel is collapsed, the pill's unread badge pulses instead. Deliberately NOT Mantine notifications in
  the app's own real estate: the product may grow its own toasts later, and dev chrome must never collide
  with (or be mistaken for) product UI. For the same reason the org screen's "invite sent" copy no longer
  mentions Backstage — product copy ships in real mode too, where the panel doesn't exist.
- **The mail reading pane's iframe is `sandbox="allow-scripts"` with a postMessage click bridge.** The
  earlier `sandbox=""` killed clicks inside the email silently — the #1 demo'er trap this review found. A
  tiny script appended to the `srcDoc` intercepts anchor clicks and postMessages the href to the parent,
  which routes it through the SAME `onOpenLink` policy as the extracted link rows. The frame stays an
  opaque origin with no `allow-top-navigation`, so the email still can't navigate anything itself — it can
  only ask. Links the policy refuses now produce a notice instead of a silent nothing.
- **Sign-out keeps the Backstage viewpoint cookie.** Intended semantics: signing out ends the session, not
  "whose world you're watching" — the panel keeps following the last person, which is exactly what a
  demo'er stepping through someone's story wants. Documented here so it reads as a decision, not a leak.
- **Real builds ship zero Backstage client code via a fake-mode-only dynamic import.** The locale layout's
  `BackstageChrome` mirrors the existing `AuthProviders` pattern (which dynamic-imports Clerk only in real
  mode). The `/api/backstage/*` handlers still compile into the server artifact — runtime 404 gating plus
  the fail-closed adapter guard is the containment there; a second build flavor to strip the files was
  judged complexity without payoff (one-artifact philosophy, ADR-0001).
- **Invites are validated and deduplicated server-side (409).** The API now enforces the same email-shape
  check as the form and rejects addresses that are already members or already invited — duplicate Cast rows
  sharing one inbox confused demos. Consequence for tests: inviting an existing member's address is no
  longer a way to land mail in a seeded inbox; `backstage-mail.spec.ts` now follows an invited person
  instead.
- **Invite emails are localized with the inviter's locale.** The invitee has no account (and no locale)
  yet, so the inviter's is the best signal. Copy lives in a new `email` namespace in `messages/*`; react-
  email templates receive pre-localized strings as props (they render outside a request context, so they
  never call next-intl themselves).
- **The static twin does NOT render the real `InviteEmail` template — tried and reverted.**
  `@react-email/render` (react-dom/server) added ~560 kB to the single-file demo, blowing its 920 kB size
  budget — the budget wins. The twin hand-builds matching markup (`buildInviteEmailHtml`) but pulls its
  STRINGS from the same `email` messages namespace as the real template, so copy can't drift even though
  markup can. Twin invite ids are `crypto.randomUUID()` (a length-based id could be reused after an accept
  shrank the list, making a stale email link accept the WRONG invite — and colliding derived persona ids).
- **Split "tenant" into tenant (ambient site) vs organization (in-tenant team).** The scaffold conflated the
  two; the product needs GitHub-style teams within one customer's site. Orgs map to Clerk Organizations
  (one Clerk instance per tenant → our slug === Clerk slug); role is per-org membership. Code/data use
  `org`; user-facing copy says "team" (messages values only), so the display word is swappable without a
  refactor. See ADR-0003 addendum. Notes stay tenant-scoped for now — org-scoping is a follow-up slice.
- **Product has no cross-tenant surface; Backstage Cast IS the tenant hop.** Tenants are ambient, so the
  header switcher is now the OrgSwitcher (within one site). Crossing sites in fake mode means becoming a
  persona whose home tenant differs — the existing Cast tab already does this (persona rows carry a tenant
  chip and re-theme on switch), so no new dev surface was added. The `tenancy.spec.ts` UI-level RLS proof
  and the auth-flows retheme test now drive Cast instead of the header switcher; the real RLS proof
  (`tests/rls/proofs.ts`) is unchanged. The fake sign-in persona picker also lists personas across tenants
  — that's fine, it's the same fake-mode-only trust class as Backstage (real mode renders Clerk's form).
- **Rejected reusing Clerk's `@clerk/ui`/`@clerk/elements`.** Internal package, live-client coupling, and
  Elements unsupported as of Core 3 — see ADR-0003 addendum. We mine Clerk's anatomy as a design reference
  and re-express it in Mantine.
- **Org-scoped notes are an app-level filter; per-org RLS is deferred.** `notes.org_id` (nullable) +
  `where org_id = :active` inside `withTenant` gives "switch teams → switch the data you see" without a
  second RLS GUC. Teams are a collaboration boundary, not a hostile one; the tenant RLS still contains
  every row and port membership checks gate the active org. Full ADR-0004 addendum. Follow-up if a team
  ever needs hard isolation: promote to a second GUC + policy + proof cases.
- **Auth avatars are white-on-dark, not hash-colored.** Mantine's `color="initials"` (and `autoContrast`,
  and the plain gray placeholder) can't clear WCAG AA 4.5:1 across hue+initials combinations; a fixed
  white-on-dark-6 avatar is ~15:1 for any initials. The open-popover a11y sweep is scoped to
  `color-contrast` because an open Mantine Menu trips `region`/`aria-required-children` (portal +
  autofocus helper) — framework quirks, not our markup. See docs/build-notes.md.
- **The locale switcher moved from the demo header into Backstage, in both hosts.** A product
  header would never carry an en/es toggle — it is a simulated-world affordance, so it belongs on the
  Backstage surface (the panel header, next to the persona chip) alongside the other set controls. The
  real app wires it to a full reload that swaps the leading `/<locale>` path segment (theme + header are
  per-request RSC output, so a soft nav wouldn't re-render them — same reasoning as profile-glue); the
  static demo wires it to its in-memory locale state. The demo header no longer renders a toggle at all.
- **A draggable seam replaced the 360/520 width presets.** The two-value SegmentedControl was a blunt
  instrument; the panel edge is now a continuous drag (clamped 300–720, and to `viewport − 360`) that is
  also a real keyboard-accessible separator (`role="separator"`, arrows step, Home/End jump, double-click
  resets to 360). Same `<slug>-backstage-width` localStorage key — legacy `520` values parse straight through
  as a number — so nobody's persisted width breaks.
- **Events dropped the shared light-box wrapper and, with Errors, the "dev only" badge.** Events now renders
  as compact dark expandable rows matching the panel's own skin instead of the light `Table` both tabs
  inherited from their `/dev` page days; Errors keeps the light box for now since it hasn't been reskinned,
  not because it needs to stay light. The "dev only" badge was cut from both — the whole panel already reads
  as "not the product" (fake-mode-only, distinct chrome), so a per-tab label was redundant copy.
- **Clear-mailbox now requires a two-step inline confirm.** It shipped as a single irreversible click; moved
  next to the scope toggle, that's one accidental tap from wiping every caught email. It now asks inline
  ("Yes, clear all mail" / "Cancel") — the same shape Scenes' reset already uses — rather than introducing a
  second confirm pattern.
- **The jobs port is the execution seam only; job rows and the status timeline are app-owned.** The
  `jobs`/`job_status_changes` tables are identical in fake and real mode (like `notes`), so they live in
  the app DB behind RLS and are written through one choke point — `src/db/jobs.ts` `recordJobStatus`,
  validated by the pure `src/core` state machine. The port is just `start(job)`. What differs by mode is
  who executes and how completion returns: the fake runs an in-process handler; the real adapter only
  kicks off CodeBuild, and terminal transitions will arrive via the inbound webhook route calling the same
  `recordJobStatus`. Slice-3 actors complete jobs through that same path — no port surface grows.
- **Held mode is a world flag (`jobs-held`), not a per-submit option.** "Jobs wait for an operator" is a
  property of the simulated world, not of a call site — a per-submit option would leak fake-only concerns
  into product routes that must ship identically in real mode. The flag rides the existing flags store
  (Scenes toggle, persistence, reload glue all come free). `runPendingJobs()` steps held jobs forward
  regardless of the flag; slice 3's vendor actor replaces the button with webhook-driven completion.
- **`job_status_changes` is append-only by privilege, not convention.** `app_user` gets only
  `GRANT SELECT, INSERT`; the RLS proof suite asserts UPDATE and DELETE fail with permission errors on
  both pglite and real Postgres. Timelines you can rewrite are timelines you can't trust.
- **The fake executes jobs inline, awaited, in the submit request.** Determinism over realism (the
  `SIMULATE_CODE_BUILD` spirit): e2e never polls a race, and the timeline still records
  queued → running → completed with real timestamps because `recordJobStatus` enforces the machine — no
  shortcut transition exists. Held mode is the realistic path when the choreography matters. Scenes
  snapshots cover jobs for free: rows live in pglite and artifacts in `.data/storage`, both already
  LIVE_DIRS.
- **Static-demo feature parity is now standing doctrine.** The file:// demo twins every feature
  in-memory and degrades only where physics forbid (see development-approach). Applied here: the demo
  dashboard gets the Export card twin and the Jobs tab honors `jobs-held` and "run pending" as real
  in-memory logic; the only degrade is the download link (no server to serve bytes).
- **`recordJobStatus` locks the row; losing a start race is a no-op, not a 500.** Branch review
  caught that the read-validate-write choke point had no row lock (safe today only because the
  pglite dialect serializes connections — a guarantee pooled Postgres won't give the inbound webhook
  path) and that a raced `running` hop threw `InvalidTransitionError` all the way to a product 500.
  Now: the status read is `FOR UPDATE`, and the fake executor treats an already-claimed job as
  benign (`runPendingJobs` counts only jobs it actually ran). Webhook redelivery inherits
  a choke point that serializes instead of double-writing.
- **CSV exports neutralize formula injection.** RFC-4180 quoting alone doesn't stop Excel/Sheets
  from evaluating a user-authored `=…`/`+…`/`-…`/`@…` cell; `csvField` now prefixes such fields
  with an apostrophe. Known limitation, handled at the one place CSV is built.
- **Service auth is a shared implementation, not a port.** `src/service-auth/` verifies per-org
  RS256 JWTs and webhook shared secrets with ONE code path in both modes; only key/secret
  _sourcing_ differs (fake mints into the same `service_keys` table; the webhook secret comes from
  `.data/auth/webhook-secret` vs `WEBHOOK_SECRET`). Signature verification is an app-owned
  algorithm over app-owned state, not an external dependency — and if fake mode verified through a
  different adapter, the actors-drive-the-real-surface proof would be circular. The auth
  port is untouched; `ServiceIdentity` is deliberately not an `AuthUser`.
- **`service_keys` is an infra table (no RLS), multiple active keys per org.** Read during request
  authentication before any tenant context exists — the organizations/tenant-lookup precedent.
  Public material only; the hostile boundary is enforced cryptographically (the signature picks
  the true org even if slugs ever collide across tenants). Rotation = add a key, switch, revoke
  (`revoked_at`, never DELETE); `app_user` is SELECT-only, proven in the RLS suite.
- **Webhook semantics: idempotent redelivery, strict service API.** Redelivering an
  already-applied terminal status returns 200 `{idempotent: true}` (vendors retry on non-2xx —
  a 409 would cause retry storms); any other illegal hop is 409 with `{from, to}`. A completion
  webhook for a still-`queued` job walks `running` first (timeline message "completion webhook") —
  the real CodeBuild path may only call home at the end, and the vendor actor completes _held_
  builds, so the walk preserves "even an instant path records the full story." The counterparty
  service API gets no such courtesy: strict per-hop, because a polling counterparty just read the
  state and a 409 is information.
- **Service token policy: RS256-only, `aud <slug>-service`, required `iat`+`exp`, max age 15m, 30s
  clock tolerance.** No jti/nonce replay store — the 15-minute age bound is the whole replay
  posture; counterparties re-mint on their poll loop. All verification failures are one opaque
  401 (no oracle for which check failed); cross-org job access reads as 404 (existence never
  confirmed across the boundary).
- **Static-demo parity is explicitly N/A for this slice.** A server-only API surface has no
  file:// analog — there is no screen to twin. The capability becomes visible (and twinned) in
  the Actors tab, where inline actor components over an in-memory driver demo the same
  poll/advance/webhook story.
- **Caller-supplied `resultKey` is prefix-locked to the caller's tenant namespace.** Branch review
  caught that a service caller completing its own job could plant `exports/<victim-tenant>/…` as
  `resultKey`, which `GET /api/jobs` would later sign verbatim — storage tenant isolation is purely
  by key convention, so that would have been a cross-tenant download. Both write paths now reject a
  `resultKey` outside `exports/<tenantId>/` (service status route: the verified identity's tenant;
  webhook route: the payload tenant, defense-in-depth on the infra-secret trust class).
- **Actors split the async world by org, not by an abstract counterparty-kind taxonomy.**
  A single org-slug constant (`src/core/actors.ts`) names the one org the service runner
  serves; the builder-console's pool is defined as everything else (any other org, or no org),
  which keeps the two actors' work pools disjoint by construction. The 409-tolerance each tick
  already needed for a lost claim race stays a robustness net rather than the thing enforcing
  disjointness.
- **`/api/backstage/actors/artifact` produces the artifact only, never a status write.** An actor
  calls it to get the export's `resultKey`, then reports the terminal status itself over the
  genuine `/api/service/*` or `/api/webhooks/*` surface, so the timeline stays authored entirely
  by those real calls. This is the counterparty's simulated compute standing in for the part a
  real counterparty compute/build service would run — it guarantees a completed job always has a real,
  downloadable artifact behind it, so neither host can produce a dead download link.
- **Credential expiry recovers on a 401, not a clock.** Neither the service runner's token driver
  nor the builder-console's secret driver tracks lifetimes; any 401 clears the cached credential,
  re-mints, and retries the failed call once within the same tick. A world reset that revokes a
  live credential mid-run is indistinguishable from a real expiry — both heal through the same
  path.
- **No postMessage bridge for the actor frames.** Unlike the mail reading pane's opaque-origin
  sandboxed iframe (rendering untrusted caught-email HTML, needing a click bridge to reach the
  parent), each actor frame is same-origin, first-party code running its own page under
  `src/app/[locale]/backstage/actors/[actor]` — its own fetch, its own cookies, no message channel
  needed. The Actors tab's world-strip counts (queued/running/completed) simply ride the same jobs
  poll the Jobs tab already drives.
- **Actor iframes carry no `sandbox` attribute — a different trust class from MailApp's, on
  purpose.** Trusted first-party code needs the real origin for `fetch`/cookies to work at all;
  `sandbox="allow-scripts"` alone produces an opaque origin and would break it. Omitting `sandbox`
  keeps the frame's privileges identical to an ordinary same-origin navigation — nothing gained,
  nothing given up beyond what a page already has.
- **Each tick performs at most one product-visible mutation.** Both `serviceTick` and
  `builderTick` poll, then make one hop (claim, complete, or deliver) and return — never a batch.
  That's what makes Step meaningful (one click, one visible state change) and keeps the activity
  log a faithful blow-by-blow instead of a batched summary.
- **The Jobs tab's "run pending jobs" button was retained, not replaced.** The note above
  ("slice 3's vendor actor replaces the button with webhook-driven completion") anticipated the
  actors making it obsolete. It stayed instead: a useful manual operator override for stepping the
  world forward without opening the Actors tab, or for the old instant-advance demo beat. The
  actors are additive, not a replacement path.
- **The static twin reaches full parity by driving the SAME `serviceTick`/`builderTick` runtime
  over in-memory drivers.** `src/demo-static/actor-drivers.ts` implements the identical
  `ServiceDriver`/`BuilderDriver` contracts the real fetch drivers do, so `actor-runtime.ts` is
  shared verbatim by both hosts — only transport differs. The only physics degrade is the download
  link: the static shell has no server to serve CSV bytes from, so a completed job's timeline
  entry there carries no `resultKey`.
- **Hand-rolled ability model instead of `@casl/ability` (authorization slice).**
  `src/core/abilities.ts` is a small `can()`/`cannot()` switch over subject type — no new
  dependency, and `src/core` stays framework-free by construction (ADR-0006) rather than by
  auditing a third-party library's zero-dep claim. The public shape is deliberately CASL-like
  (`can(action, subject)` over `{type, orgId, ownerId}` subjects), so this is a two-way door: a
  later swap to the real library is a rewrite of one file's internals, not of any caller.
- **`authorize()` is an explicit per-handler call, not route middleware; the bypass-catcher is a
  build-time source scan, not a lint rule (authorization slice).** The subject's `orgId` is
  handler-derived — resolved from `user.orgSlug` after the tenant/org lookup each route already
  does — so it isn't known before the handler body runs; a wrapper would have to re-derive it
  anyway. `authorized-mutations.test.ts` instead proves the invariant ("every mutating route calls
  `authorize(...)` or is a justified exemption") by walking every `src/app/api/**/route.ts`: a
  test, not an AST lint rule, because the check is file-level (does this whole file call authorize
  anywhere?) — same reasoning as `messages-parity.test.ts`. A build-time scan that walks the route tree is the
  pattern; the exemption map (service/webhook/backstage routes, self-service profile,
  telemetry, session lifecycle) keeps new mutations honest — a new route must call
  `authorize(...)` or add a reasoned exemption, not silently fall through.
- **Restricted members losing note/job create is a deliberate product rule, not a regression
  (authorization slice).** `restricted: boolean` already existed on `AuthUser` (auth port); this
  slice is the first place anything enforces it — `Note`/`Job` `create` (and `Note` `update`/
  `delete`) require `!restricted`, while `read` stays open. This is the auth port's documented
  "reduced feature surface" made concrete: a forced POST still 403s
  (`tests/e2e/authorization.spec.ts`), and the dashboard shows a read-only `NotesCard` (disabled
  input, hint text) in both the real app and the static twin.
- **`requireRole` stays on the auth port as the coarse primitive; `authorize()` owns fine-grained
  resource decisions (authorization slice).** Both read the same `src/core/roles.ts` predicate
  (`canManageOrg`), so there's one source of truth for "who can manage an org," reachable either
  coarsely (gate a whole route by role) or finely (gate one action on one org-scoped resource).
  `org/invite`'s POST is the one route this slice actually retrofit, off
  `requireRole(...ORG_MANAGER_ROLES)` onto `requireUser()` + `authorize('create', Membership)`;
  `ORG_MANAGER_ROLES` is now module-private in `roles.ts`, consumed only through `canManageOrg`.
- **`AbilityActor.manageAll` is wired but pinned `false` this slice (authorization slice).** The
  staff cross-org superpower has no signal to derive it from yet — the staff org itself
  comes later. `abilityActorFromUser()` always sets it false, so flipping it later (once a staff-org
  membership signal exists) grants everything without touching any per-subject rule in
  `defineAbilitiesFor`.
- **Withdrawing a cross-org request is a soft `UPDATE`, never a `DELETE` (cross-org slice).**
  `org_requests` grants `app_user` only `SELECT, INSERT, UPDATE`; withdrawal is the state
  machine's `open → cancelled` hop, so the row and its audit trail (`created_by_user_id`,
  `decided_by_user_id`, both timestamps) can never be erased by the app role — the
  `job_status_changes` append-only precedent applied to a mutable-but-undeletable row instead of
  an append-only log. Proved in `tests/rls/proofs.ts`: a raw `DELETE` fails at the privilege
  layer, but an `UPDATE` of `status` succeeds.
- **`AbilitySubject` grew named `requesterOrgId`/`responderOrgId` fields, not a generic org array
  (cross-org slice).** A two-sided subject needs to know WHICH side the actor is testing —
  `create`/`delete` care only about the requester side, `update` only about the responder side —
  so a single `orgIds: string[]` would force every rule to re-derive direction from the action.
  Named fields keep each rule a one-line equality check, and `null`/absent never matches either
  side (a request naming neither of the actor's org on the acting side denies).
- **One unambiguous `authorize()` action per route (cross-org slice).** The three org-request
  routes each call a single, distinct action — `POST /org-requests` → `create` (requester),
  `POST .../respond` → `update` (responder), `POST .../cancel` → `delete` (requester, soft) —
  rather than a generic "act on this request" the ability rule would have to disambiguate by
  payload. Matches the existing Note/Job convention (`authorize(user, orgId, action, subject)`);
  no new verb was added to `AbilityAction`.
- **A restricted manager on the responder side may still respond — `restricted` reduces
  authoring, never management authority (cross-org slice).** `OrgRequest` `update` (accept/reject)
  is gated on `canManageOrg(actor.role) && isResponder` only — deliberately NOT
  `!actor.restricted && ...` — matching the existing Membership/Org house rule that `restricted`
  narrows what a member can AUTHOR, not what a manager can decide. Pinned by a comment in
  `src/core/abilities.ts` and a dedicated test in `src/core/abilities.test.ts` so a future "tidy
  this up" pass doesn't silently add the guard.
- **`decided_by_user_id`, not `responded_by_user_id` (cross-org slice, renamed during review).**
  The column records whoever drove the terminal transition — the responder's manager on
  accept/reject, but also the REQUESTER on withdrawal — so `responded_by` was inaccurate for the
  cancel path. Renamed before merge; no migration history to reconcile since 0006 hadn't shipped
  yet.
- **`InvalidTransitionError → 409` promoted from the service-only wrapper into the shared
  `src/app/api/respond.ts#withPortErrors` (cross-org slice).** The service API
  (`src/app/api/service/respond.ts`) already mapped a rejected state-machine hop to 409
  `{error: 'invalid-transition', from, to}`; org-requests' respond/cancel routes needed the
  identical behavior for the product API, so the mapping moved up to the one wrapper every
  product route already uses. Inert for every existing route — none threw
  `InvalidTransitionError` before this slice — so this is pure addition, not a behavior change.
- **Two-step mint + confirm with a `pending → ready` status, NOT write-row-on-confirm (uploads
  slice).** The brief leaned toward INSERT-only (write the artifact row at confirm), but that
  needs a way to carry the server-built key from mint to confirm without trusting the client — a
  second signed-token mechanism on top of the upload-target signing. The pending-row shape keeps the
  storage key entirely server-side at ALL times (the mint step stores it; confirm only takes the row
  id, never a key), avoids re-deriving trusted metadata from storage, and can't create duplicate
  rows. The cost is one `status` column + an `UPDATE` grant — which the brief explicitly permits.
  `GET /api/artifacts` lists only `ready` rows, so an abandoned pending row (upload never landed) is
  harmless and never shows a dead download link. Confirm re-uses the `create` ability (finalizing
  one's own upload), so no `update` rule was added to the `Artifact` subject.
- **The storage key is built entirely server-side, never client-supplied (uploads slice).** The
  mint route composes `artifacts/<tenantId>/<uuid>/<sanitizeFilename(name)>` — the resultKey
  prefix-lock lesson applied to uploads. The browser only ever holds an opaque upload
  target (whose fields encode the key) and an artifact id; it can never steer where bytes land.
  `sanitizeFilename` (pure core) strips any directory portion as defense-in-depth, and the fake
  storage `resolveKey` rejects escapes as a final backstop.
- **The fake upload endpoint is authenticated by HMAC-signed target fields, not a session (uploads
  slice).** `POST /api/storage-upload` is the fake-mode-only twin of an S3 presigned POST (404 in
  real mode, first line). It has no user session — the target was authorized (`create Artifact`)
  when the mint route issued it, and an HMAC over `{key, content-type, max-bytes}` (keyed on a
  per-checkout `.data/storage/upload-secret`, the fake-auth dev-secret pattern) proves the fields
  weren't tampered with since. It's in the authorize-scanner exemption map with that reason — the
  same trust class as the shared webhook secret. It approximates S3's status codes: 403 for a bad
  signature or a content-type mismatch (`eq $Content-Type`), 400 for oversize (`EntityTooLarge`),
  204 on success.
- **A hand-rolled drop region, NOT `@mantine/dropzone` (uploads slice).** `ArtifactsCard` uses a
  styled `<label>` wrapping a hidden `<input type="file">` with drag-and-drop handlers — real
  drag-drop AND click-to-browse — instead of adding the `@mantine/dropzone` dependency. Reasons:
  the card is shared by the file:// static twin, so the dependency would land in the single-file
  demo bundle (the `@react-email/render` 560 kB revert is the standing precedent for guarding it);
  a bare input is what Playwright's `setInputFiles` targets cleanly; and "parity is about
  capability, not pixel-identical widgets." Zero new client weight, zero budget risk. The static
  twin uses the same component — its `onUpload` just reads name/size/type in-memory (no bytes
  stored, no download link — the physics degrade, like the jobs CSV).
- **A security-review pass hardened the uploads slice in the same branch, before merge.** Four gaps
  found on self-review, fixed rather than filed as follow-ups: the real adapter's
  signed download URL didn't force `ResponseContentDisposition: attachment`, so an uploaded HTML/SVG
  could render inline on the bucket/CDN origin — fixed to match the fake route's `nosniff`+`attachment`,
  closing the same stored-XSS class the fake route already blocked. The mint route accepted any
  content-type string verbatim, so control characters (newlines) could ambiguate the fake target's HMAC
  canonical string or pollute a real S3 policy/Content-Type header — fixed with a printable-ASCII-only
  check. The fake upload endpoint called `formData()` (buffers the whole body) before checking the HMAC
  signature, letting an unauthenticated caller force large buffering — fixed with a pre-parse
  `Content-Length` guard (2x the artifact ceiling). And the dropzone's file input was `display: none`,
  invisible to both axe and the tab order — fixed to visually-hidden-but-focusable CSS (see
  `docs/build-notes.md`). None change the shipped shape; they harden it.
- **Audit lives in an Events-tab SECTION, not an eighth Backstage tab (audit slice).** `audit_events`
  is compliance-grade PRODUCT data (per-tenant, in pglite), not dev telemetry — but it is still an
  observation record, so it renders read-only in the existing **Events** tab beneath a labeled divider
  ("Audit trail — product record"), above which the analytics events stay. This respects the
  events-are-observations doctrine while making the two KINDS of record visually distinct, and avoids a
  tab-count creep the surface didn't need. Its data comes from a dedicated fake-mode-only god view
  route (`GET /api/backstage/audit`, 404 first line) that reaches past the tenant RLS scope exactly as
  `listWorldJobs` does; the static twin appends the same rows in memory from its own mutations (full
  parity — audit is just rows).
- **`recordAuditEvent` is a convention + helper called AFTER each authorized mutation, never inside
  `authorize()` (audit slice).** `authorize()` is a pure, side-effect-free decision; writing there
  would couple the choke point to IO and fire before the subject id exists. Instead each of the eight
  authorized mutating routes (notes, jobs, org-invite, artifact mint + confirm, org-request
  create/respond/cancel) calls `recordAuditEvent(db, {...})` on the line after its write — the natural
  moment the real subject id is known — with an `action` string like `note.created`,
  `org-request.accepted`. Deliberately NOT wired into the authorized-mutations scanner (that stays a
  pure "did you authorize" check); a focused helper unit test plus the RLS append-only proofs carry it.
  The table is append-only at the privilege layer (SELECT/INSERT only — the `job_status_changes`
  precedent), so a recorded event can never be rewritten or erased.
- **Staff manage-all is activated by WIELDING the staff org, not by membership (staff slice).**
  `abilityActorFromUser` derives `manageAll = user.orgSlug === STAFF_ORG_SLUG` ('ops-staff')
  — acting AS the staff org is the activation, anchored to the ACTIVE org exactly like every other
  power in the model, with no per-request membership-list lookup. It reads the active-org SLUG (not a
  uuid), so it holds whether a route passes a resolved uuid `activeOrgId` or `canInActiveOrg` passes
  the slug anchor. **It NEVER crosses tenants:** `manageAll` only short-circuits the per-subject
  rules, which are already tenant-bounded, and every product query still runs inside `withTenant`
  (ADR-0004). **Honest scope:** `manageAll` is an ability-layer override, NOT a query filter — routes
  with party-scoped row lookups (`orgRequestForActiveOrg`, `jobForOrg`) still return null for a
  non-party active org, so a staff actor gets no cross-org DATA on those surfaces; the product staff
  admin SCREEN is app work, out of scaffold scope. The functional override is proved
  in `authorize.test.ts` (a staff actor authorizes an action it has no side in); the visible e2e proof
  is just that Olive's dashboard works in ops-staff. **Naming:** the org `ops-staff` is distinct from the
  rank-ladder role `'staff'` (an org-manager rank) — disambiguated in `src/core/roles.ts`.
- **`deferAfterResponse` runs work INLINE in fake mode, via Next's `after()` in real mode (defer
  slice).** The seam over `after()` systematizes post-response side
  effects (the canonical one: notification email — a slow provider must never add request latency). In
  real mode it schedules `after(work)`. In fake mode it runs the work inline (awaited) for
  determinism — the SIMULATE_CODE_BUILD spirit — so a hermetic e2e that sends an invite and polls the
  fake mailbox finds the mail without racing a post-response microtask (exactly the ordering that held
  before the seam existed). Fake mode ALSO captures a `deferred_work` event first (so the deferral is
  visible in the Backstage Events tab) and `deferred_work_failed` on error; errors are always recorded
  and swallowed, never crashing the response (real) or the handler (fake). The worked call site is the
  org-invite email.
- **A review pass resolved four open scope/semantics questions before merge (audit/staff
  slice).** `recordAuditEvent` runs in its OWN transaction, strictly after the mutation's commit —
  deliberately non-atomic: a rolled-back write can never leave a phantom audit row (the dangerous
  direction), and a failed audit insert after a committed write surfaces as a 500, never a silent gap.
  A shared transaction was rejected because some audited mutations (org invites) happen on the auth
  port, not in the DB, so no single-txn shape covers every site. Invite ACCEPTANCE is deliberately left
  OUT of the trail: it's a fake-mode-only app route, while real mode accepts through Clerk's
  client-side ticket flow, which never hits an app route — auditing acceptance here would record fake
  acceptances while real ones stayed invisible; audit it when a real-mode acceptance route exists.
  `STAFF_ORG_SLUG` matching is per-tenant BY DESIGN, not an oversight: in production, org slugs are
  only tenant-unique, so any tenant naming an org `ops-staff` designates its own operator org, scoped
  strictly inside that tenant (ADR-0004) — not an escalation, since that tenant's admins already hold
  top authority there. And `manageAll` is checked BEFORE the `restricted` gate in
  `defineAbilitiesFor` — a restricted ops-staff member would otherwise be denied the very authority the
  org exists to grant; staff-org membership is assumed non-restricted (nothing enforces this yet),
  flagged as the gate to add if a restricted operator ever becomes a real configuration.
- **Conversation fixtures can the model's utterances, never the tool results (LLM-tools slice).**
  A tool-loop fixture entry's `conversation` records only `assistant` turns (text and
  `tool_use` requests); the `user`/`tool_result` turns the adapter interleaves always come from a
  LIVE call to the app's `execute` closure, in both real mode and fixture replay, against
  whichever world is running (fake DB in tests/dev, in-memory notes in the static demo). Canning a
  tool result instead would let a fixture assert a fact about the world (e.g. "the notes are X")
  that the actual seeded/edited world no longer holds — a silent lie the moment anyone changes the
  seed. The replay-honesty split trades a little determinism (the tool's numbers can vary run to
  run) for a fixture that can never claim something about the world that isn't currently true.
- **Adapters refuse to dispatch a `tool_use` for a name the app didn't supply, and the port doc
  now carries a written TRUST MODEL (LLM-tools slice).** Added in a follow-up commit after
  self-review of the first cut: both adapters previously relayed any `tool_use` block straight to
  `execute` on the strength of the model (or a hand-edited fixture) naming a real tool. Now each
  checks `call.name` against the supplied `tools` list with exact string equality before calling
  `execute`, returning `"unknown tool: <name>"` as the tool result otherwise — defense-in-depth,
  since a well-behaved model only ever names a tool it was given. The port doc's new TRUST MODEL
  section states the invariant this defends: tool results are user content into the model's
  context (a stored note can carry injection text), so model output is always untrusted —
  display-only, never branched on, never wired to a privileged action — and a tool's blast radius
  is exactly its `execute` closure, which must scope to session-resolved ids captured at build
  time, never model-supplied input.
- **The `list-notes` conversation fixture is hand-authored, not recorded (LLM-tools slice).**
  `fixtures/llm/assistant-demo.json` ships a `list_my_notes` tool-loop entry written by hand
  (no `ANTHROPIC_API_KEY` in this environment) and marked with a `note` field saying so. This
  follows the same provenance convention as every other authored-but-unverified fixture: it's
  typechecked and shaped exactly like a real recording (`pnpm llm:record`'s tool-loop path — a
  per-purpose recorder registry keyed by fixture purpose — will overwrite it once a key exists),
  but its assistant turns and their wording are not proven against the real API. Tracked as part of
  the existing `anthropic-key` cutover row, not a new one.
- **Tool descriptions and the assistant system prompt are plain strings, not next-intl (LLM-tools
  slice).** `src/app/api/assistant/tool.ts`'s `ASSISTANT_SYSTEM` and
  `LIST_MY_NOTES_TOOL.description` are MODEL-facing prompt content — sent to Anthropic to steer tool
  selection, never rendered in the UI — so they fall outside the no-hard-coded-UI-strings rule the
  same way `system` prompts already did before this slice. Keeping them as literals also keeps them
  byte-identical to what the committed conversation fixture was hashed against; routing them through
  next-intl would let a translation-file edit silently break fixture replay (see
  `src/app/api/assistant/tool.test.ts`'s fixture-contract guard).
- **Realtime collaboration closed as a recipe, deliberately building nothing.** The
  development-approach services section now carries the forced-extraction recipe: single-user as the
  hermetic default and the fake, the sidecar as another counterparty verified via the service-auth
  precedent, a `collab` port seam, simulated co-editors as Backstage actors, cutover rows for the
  service's infrastructure. A production-viable single-user degrade flag is the
  evidence this costs nothing to defer. Machinery lands only when a real app on this template is genuinely
  forced — the coverage sweep's own recommendation, now doctrine.
- **Post-campaign cross-slice review: export keys now encode the org, and the guarantees that held
  only by convention are enforced.** A whole-campaign adversarial review (all nine slices at once)
  confirmed the choke points hold but found the residual risk sitting exactly at slice seams. Three
  medium findings, all fixed: (1) export keys are now `exports/<tenantId>/<orgId>/<jobId>.csv`
  (core `exportKeyPrefix`), with the service status route prefix-locked to the CALLER's org and the
  webhook path validating the org half against the JOB ROW — before this, a same-tenant service
  caller could plant another org's export key and have `GET /api/jobs` sign it. (2) The
  authorize-bypass scanner's detector now catches every legal handler-export form (`export function
POST`, `export { POST } from`, const/let/var) with self-tests, plus a stale-prefix-exemption
  check; classification deliberately runs on RAW source (over-match fails loud) while the
  authorize(...) requirement runs on comment-stripped source. (3) Fake service keypairs are keyed
  by tenant AND org slug, and an org slug existing in multiple tenants refuses to mint without a
  `tenantSlug` disambiguator — same-slug orgs sharing a private key would have collapsed the
  "signature picks the true org" verification guarantee. Four low findings fixed alongside:
  the static twin no longer audit-logs refused org-request transitions; a webhook redelivery
  losing a race now re-observes (bounded retry) instead of bouncing the vendor with a 409; the
  dashboard refreshes org-requests on a decide-race 409 instead of leaving stale live buttons;
  fake upload targets carry a signed 15-minute expiry (S3 parity) and `confirmArtifact` is
  pending-only, closing silent byte/size swaps once the target expires (within the 15-minute
  window a still-live target can re-upload — exactly the property a real S3 presigned POST has).
- **Post-campaign cross-slice review, round 2: exemption claims are now enforced, not prose.** The
  round-2 pass (verify-the-fixes + a claims-vs-enforcement sweep) confirmed all seven round-1 fixes
  closed and found the same failure class one meta-level up: the authorize scanner's prefix
  exemptions asserted gates ("fake-mode-gated", "gated by withServiceCaller") it never checked. Each
  checkable exemption now carries a `mustMatch` guard the scan enforces per exempted mutating file —
  a backstage route that forgot its `isFakeMode` gate, or a service route that dropped
  `withServiceCaller`, now fails the build instead of shipping silently exempt. Also fixed: the
  mutating-export detector covers `export *` and `export const { POST } =` (treated as mutating
  sight-unseen — over-match fails loud); a re-confirm of a ready artifact is 200-idempotent WITHOUT
  a duplicate `artifact.confirmed` audit event (`confirmArtifact` reports 0 rows, the route skips
  the audit write); the service/ exemption justification cites the decision-log service-auth entry
  instead of a wrong ADR number. One operational note for pre-fix checkouts: the keypair-scoping fix
  does not revoke keypairs minted at the OLD `.data/auth/service-keys/<orgSlug>/` path or their
  still-active `service_keys` rows — a world that predates it should be Scenes-reset (or `.data`
  wiped) after upgrading; harmless for default seeds, which have no cross-tenant slug collisions.
- **Round-2 coverage sweep runs on app types, not a reference app** (2026-07-23,
  `docs/app-coverage-gaps.md`). Round 1 measured the scaffold against one reference app; round 2 enumerates app _types_
  until saturation (19 — new types stopped surfacing new capability rows) and triages each
  capability by demand breadth × retrofit pain × house leverage. The sweep's focus decision:
  the template concentrates on external-service seams and missing integration classes; UI kits
  (table kit, settings, charts, rich text, wizards) are tracked on a prioritized backlog in that
  doc rather than built speculatively.
- **The template/instance doctrine is now explicit** (2026-07-23, `docs/app-coverage-gaps.md`).
  The template ships three kinds of things: universal capabilities fully worked (port + default
  vendor + fake + Backstage), one worked example per integration class, and recipes for
  everything else. Vendor code must pass _universality_ (every instance uses it) or _new-class_
  (mechanics the template doesn't already teach) — fail both, write a recipe. This is why
  round 2 builds five slices with zero new vendors: Twilio, web-push, and Zoho-class
  e-sign land as recipes, because after signed egress the callback-vendor integration
  classes are complete and a second worked example per class is repetition, not coverage.
- **Access gating is a class, not a feature** (2026-07-23, access-gates intent). What began as
  "clickwrap ToS acceptance" generalized during triage: the reusable thing
  is a gate — a condition an actor must satisfy before proceeding, with scope, resolution flow,
  and block-vs-advisory behavior, hooked once into the protected layout. Agreements are the
  worked example with gating behavior as per-agreement data; email verification, MFA
  enrollment, onboarding, and billing entitlements ride the same seam later — which is also
  what makes deferring billing safe.
- **A dependent slice chain merges on green gates, with review retrospective** (2026-07-23). The
  round-2 slices were built sequentially, each merged once `pnpm verify` (+ `pnpm test:contract` for
  migration slices), the doc-steward pass and the pre-PR review were green. Deliberate trade: a
  blocking review on every link stalls a chain where each slice depends on the last, so the gates
  carry the risk and review catches what gates cannot. It is the wrong trade for a change that a
  gate does not cover.
- **Scheduled work: three closed spec shapes, UTC-only, no cron/RRULE** (2026-07-23,
  `src/core/schedules.ts`). `job_schedules.spec` is one of `interval` / `daily` / `weekly`,
  all interpreted in UTC with no timezone library — so `computeNextRunAt` is identical on every host
  and DST can never move a fire time (a UTC day is always 86,400,000 ms). Arbitrary cron expressions
  and calendar recurrence stay a recipe (per the round-2 doctrine), not template code; an instance
  needing local-time schedules layers a tz conversion at the edge above this pure core.
- **Interval drift policy: scheduled-time anchoring, with coalescing** (2026-07-23). A
  schedule advances by feeding its OWN `next_run_at` back into `computeNextRunAt`, never `now` and
  never the handler's completion time — so an interval series is anchored to its origin and immune to
  tick latency or handler duration. Missed slots (a late tick, or a demo clock-jump across periods)
  coalesce: the row advances to the first slot after `now` and fires ONCE, never one job per skipped
  period — the sane behaviour for both a recovered outage and a "+1w" demo jump.
- **Idempotent due-scan reusing the jobs machinery** (2026-07-23, `src/db/schedules.ts`).
  `runDueSchedules(now)` spawns through the EXISTING jobs path (a `jobs` row + its opening `queued`
  timeline, then `jobs.start` after commit — the `submitJob` shape) rather than a parallel one, so a
  scheduled job is indistinguishable downstream from a hand-submitted one. The spawn and the
  `next_run_at` advance commit in ONE tenant transaction that locks the schedule row `FOR UPDATE` (the
  `recordJobStatus` pattern), so a tick firing twice can never double-spawn. A tick belongs to no
  tenant, so the scan enumerates `tenants` raw (no RLS on that table — the `tenant-lookup`
  precedent) and reads each tenant's due schedules INSIDE `withTenant` — load-bearing under FORCE
  RLS, where a raw scan of `job_schedules` would return zero rows on a real Postgres role (pre-merge
  review finding; see build-notes). One bad row (malformed spec, `start()` failure) is caught
  per-schedule and counted as `failed` rather than stalling the whole tick; it retries next tick
  because its `next_run_at` never advanced.
- **`digest-email` is a new job KIND, not new machinery or a new vendor** (2026-07-23). The
  demo payoff extends an already-worked class (async jobs) rather than adding a port or adapter — the
  `email` port gained a second consumer via a new field on `JobContext`. A scheduled email has no
  request/user locale at fire time (unlike the invite, sent by an acting user), so the recipient's own
  seed locale drives the copy, falling back to the app default; the digest is addressed to the team's
  admin so it lands in a real Backstage inbox.
- **World-clock offset lives in a Scenes LIVE_DIR and is unreachable in real mode** (2026-07-23,
  `src/adapters/fake/clock.ts`). The "time control" the backlog left open is a signed ms
  offset in `.data/backstage/clock.json`; because `backstage` is a LIVE_DIR, a Scenes reset/restore
  clears/snapshots it with no extra wiring. `worldNow()` (real time + offset) is called ONLY behind
  `isFakeMode` — the cron webhook and the fake-mode-gated Backstage routes — so real time is always
  real time, structurally (the same containment shape as the fake-only webhook-secret helper). The
  Backstage advance controls also DRAIN due schedules after moving the clock, so "time jumps forward,
  the digest appears" is one click; a separate "run due now" and "reset clock" round out the surface.
- **System-initiated firings are audited as a synthetic actor** (2026-07-23). A scheduler
  tick has no acting user, so `schedule.fired` is recorded against `actor_user_id: 'system:scheduler'`
  with a new ability `SubjectType` `'JobSchedule'` (rule-less — schedules are system-managed, so the
  deny-by-default switch covers it). This deliberately stretches the audit trail's "per-actor product
  mutations" scope to cover system firings, because a schedule firing IS an org-scoped event worth a
  durable record (and it shows in Backstage's audit trail — a nice demo beat).
- **Webhook signing is pure isomorphic core, not server-lib** (2026-07-23,
  `src/core/webhook-signing.ts`). The scope note pointed at `src/server-lib` because it assumed
  `node:crypto` (the storage-upload HMAC precedent). But the static-demo twin must ALSO sign
  ("the signing helper is pure, so the twin can really sign"), and the twin is bundled by vite into a
  `file://` page where a node builtin can't load and Web Crypto's secure-context/async caveats bite.
  So HMAC-SHA256 is implemented in plain TS over bytes (via `TextEncoder`) and lives in `src/core` —
  isomorphic (ADR-0006), synchronous, shared verbatim by the server dispatch, the verify half, and the
  twin. Correctness is pinned by a colocated test that cross-checks EVERY output against `node:crypto`
  (a test may import node builtins even in core), including block-boundary and long-key/unicode edge
  cases — so hand-rolling the primitive is safe, not a liability.
- **Both halves of the scheme ship** (2026-07-23). Stripe-style `x-<app>-signature:
t=<unix>,v1=<hex>` over `{timestamp}.{body}`, PLUS `verifyWebhookSignature(body, header, secret,
{toleranceMs})` with a replay window (rejects stale AND future-dated timestamps, constant-time hex
  compare). The e2e imports the verify half to prove the egress the app produced actually verifies —
  the template teaches the receiver's side, not just the sender's.
- **Dispatch is an app-owned seam (server-lib real + adapters/fake), injected into the drain, not a
  vendor port** (2026-07-23). There is no vendor SDK (`fetch` is a global), so per the
  template/instance doctrine this is app machinery like `src/service-auth`, not a port. Real dispatch
  (`fetch` + timeout) lives in `src/server-lib/webhook-dispatch.ts`; the fake (catch-store + failure
  toggle) in `src/adapters/fake/webhooks.ts`; selection is `isFakeMode` (the service-auth precedent).
  Crucially the drain (`runDueDeliveries`) takes the dispatcher as a PARAMETER (the
  `runDueSchedules`-injects-`JobsPort` shape) instead of importing it — so `src/db` never imports
  `@/adapters`, which would drag `server-only` into its happy-dom unit tests (see build-notes).
- **Delivery is at-least-once via claim-then-dispatch** (2026-07-23, `src/db/webhooks.ts`).
  A non-idempotent HTTP POST must never be held inside a DB transaction, and two concurrent ticks must
  not double-send. So each due delivery is drained in three phases: (1) CLAIM under a `FOR UPDATE`
  lock — bump `attempt_count` and pessimistically arm `next_attempt_at` with the backoff (assume
  failure), commit; a racing tick then sees "not due" and skips; (2) DISPATCH outside any txn; (3)
  RECORD the real outcome. A crash between claim and record just re-sends at the backoff time — hence
  at-least-once, so the signed envelope carries the delivery `id` for consumer dedupe. Same per-tenant
  `tenants × withTenant` + per-item fault isolation as `runDueSchedules` (a FORCE-RLS table can't be
  scanned raw — build-notes).
- **Backoff policy: 1m/5m/30m/2h/6h, 5 attempts → dead** (2026-07-23,
  `src/core/webhook-events.ts`). Coarse and capped: enough spread to ride a counterparty's short
  outage without hammering it, short enough that a demo crosses a step with a one-hour clock advance.
  After `MAX_DELIVERY_ATTEMPTS` (5) failed attempts a delivery is `dead` and never retried. Pure core,
  unit-tested, and instance-tunable.
- **Delivery lifecycle + deliveries are OPERATIONAL records (full CRUD + cascade)** (2026-07-23,
  migration 0010). Status runs `pending` → `failed` (retry armed) → `delivered` | `dead`; the
  drain scans `pending`/`failed`. Unlike `audit_events`, `webhook_deliveries` is NOT append-only —
  `status`/`attempt_count`/`next_attempt_at` are UPDATEd in place — and it carries the full
  SELECT/INSERT/UPDATE/DELETE grant with the endpoint FK `ON DELETE CASCADE`, so removing an endpoint
  tidies its deliveries (the app-role DELETE grant is what lets that cascade run under FORCE RLS). The
  DURABLE webhook record is the audit trail (`webhook.delivered` / `webhook.dead`, append-only), not
  the delivery row — a deliberate split recorded so the no-DELETE precedent isn't assumed here.
- **Secret is server-generated, shown once, stored plaintext** (2026-07-23). Template-level
  simplicity: `whsec_<hex>` minted by the create route (`node:crypto` — a builtin, allowed outside
  adapters, the service-auth precedent), returned once, displayed once in the card, and never
  retrievable again. Stored plaintext in `webhook_endpoints.secret`; a real instance may vault it (no
  vendor is forced, so no cutover row — customer URLs and secrets are runtime data, not deploy params).
- **Backstage gets a separate Hooks tab; failure is a per-endpoint toggle** (2026-07-23).
  Endpoints + deliveries are a distinct concept from the Jobs tab's schedules, so they get their own
  `hooks` tab (the Actors-tab precedent for adding one) rather than overloading Jobs. The fake
  dispatch's failure mechanism is the simplest deterministic one: a per-endpoint id set in
  `.data/backstage/webhook-failures.json` (a `backstage` LIVE_DIR file, so a Scenes reset clears it),
  flipped live from the panel — beats magic URL markers. The catch-store `.data/webhooks/` is itself a
  new LIVE_DIR so reset/snapshot cover it. The drain is wired into the SAME ticks that drain schedules
  (cron / clock-advance / run-due), so "advance the clock past a retry's backoff and watch it fire"
  works alongside the schedules story.
- **SSRF posture: accept-with-note at template level, egress control is a cutover-time instance
  concern** (2026-07-23, pre-merge review finding). The real dispatcher POSTs to org-admin
  URLs with only a scheme check (http/https) — no private-IP/metadata-range filter. Recorded
  deliberately rather than half-guarded: endpoint registration is admin-gated (`authorize()`
  manage-org), the delivery body is app-composed, and the default deployment (ADR-0001: Lambda, no
  VPC) offers no internal network worth reaching. The seam is marked in
  `src/server-lib/webhook-dispatch.ts`: an instance deploying into a private network adds an egress
  proxy/allowlist or an IP guard there at cutover. Also recorded from the same review: emission is
  at-most-once (enqueue runs after the mutating commit, mirroring the audit-after-commit precedent),
  so the at-least-once guarantee begins at the delivery row; and a delivery killed by a disabled
  endpoint now writes the same `webhook.dead` audit event as a backoff death.

- **The fan-out is app-owned server machinery, NOT a vendor port** (2026-07-23,
  `src/server-lib/notify.ts`). Same settlement as the webhook-dispatch seam: no vendor SDK is
  involved — `in_app` is the db, `email` is the existing port, `sms` is an app-owned channel seam —
  so a `src/ports/notify.ts` would be a port with no vendor to wrap. `notify(deps, input)` takes its
  dependencies INJECTED (db/email/sms + an optional locale resolver), the `runDueSchedules(db, jobs)`
  precedent, so unit tests and the static twin exercise the same logic. The PURE decision
  (`resolveEnabledChannels`, `notificationCopy`) lives in `src/core/notifications.ts`, shared verbatim
  by server and twin like `abilities.ts`.
- **The SMS channel is a fake-only seam + a recipe — this slice ships ZERO vendor code**
  (2026-07-23, `src/server-lib/sms.ts`). `sendSms` selects the fake catch-store (`.data/sms/`,
  the mail/webhooks catch-store pattern) behind `isFakeMode` and is a deliberate NO-OP in real mode,
  with a comment pointing at `docs/recipes/sms-twilio.md`. The fake is the second consumer that keeps
  the channel abstraction honest without a Twilio adapter the template would carry unused (the
  two-tests doctrine: SMS fails universality AND is the same outbound-vendor class llm/email/webhooks
  already teach).
- **Opt-out / default-on preference model** (2026-07-23, `notification_prefs`, migration
  0011). Every channel is ON unless a pref row for that exact (kind, channel) says `enabled = false`;
  absence of a row means enabled. Rows exist only to record deviations (cheapest to persist,
  least-surprising template default). `notification_prefs` are ORG-SCOPED (org_id NOT NULL): the
  fan-out reads a recipient's prefs by the NOTIFICATION's org — always a team the recipient belongs
  to — and the profile grid edits the ACTIVE org's prefs, so a user in two teams can differ per team
  (granular, and the notification's org is always resolvable).
- **Recipients, where the obvious one doesn't exist** (2026-07-23). `org.invited` → the
  inviting team's OTHER admins ("X was invited"), because the invitee has no account yet and so can
  hold no in-app row; the inviter is excluded. `job.completed` → the job's org admins, because the
  `jobs` table has NO creator column (checked); fired ONLY for the user-facing `export-notes` kind on
  a terminal transition (the internal `digest-email` kind is denylisted so scheduled work isn't
  notification noise). `org_request.received` → the TARGET (responder) team's admins (the demo's
  headline flow). Admin = an active member whose role passes `canManageOrg`, resolved via the auth
  port's `listMembers`.
- **Two tables, matched grants** (2026-07-23, migration 0011). `notifications`:
  SELECT/INSERT/UPDATE, NO DELETE — an in-app notification is a durable record; mark-read is an
  in-place `read_at` UPDATE; the bell scans `(recipient_user_id, read_at)`. `notification_prefs`: full
  SELECT/INSERT/UPDATE/DELETE with a unique `(tenant_id, org_id, user_id, kind, channel)` index as the
  upsert conflict target (a re-toggle updates in place; clearing a pref deletes the row). Both carry
  the 0002_notes tenant RLS verbatim; the recipient/owner scope is an app-level WHERE on top (a user
  sees/marks only their own rows).
- **Per-channel fault isolation; in_app durable, email/sms deferred** (2026-07-23). `notify`
  writes the in_app row SYNCHRONOUSLY (the bell must be durable before the response), then fires email
  and sms through `deferAfterResponse` (post-response in real mode, inline in fake mode) — which
  already swallows-and-records failures. So a dead mail provider can never lose the in_app row or
  block the sms.
- **Bell marks ALL read on popover open** (2026-07-23; recorded UX choice, simplest
  deterministic e2e). The `POST /api/notifications/read` route also accepts `{ ids }` for future
  per-item marking. Mark-read is gated by `authorize()` with a self-only `Notification` subject AND a
  recipient-scoped WHERE — belt and braces. `Notification`/`NotificationPref` are new self-only
  ability subjects (the `User` pattern), never org-scoped: a teammate can't read or clear your
  notifications, and prefs are personal.
- **Backstage gets a new read-only Messages tab** (2026-07-23; sibling to Mail, not a Mail
  channel-filter). SMS is a different shape than email (no subject/html/iframe reading pane), and the
  doctrine already anticipates "an SMS surface joining the panel"; a dedicated tab is the simplest
  honest surface. `.data/sms/` is a new Scenes LIVE_DIR so reset/snapshot cover it. No clear control
  (Scenes reset wipes the store) — so no mutating backstage route, no exemption-map churn.
- **Recipient locale is a fake-only enrichment** (2026-07-23). `notify`'s optional
  `resolveLocale` dep is wired to the fake auth adapter's `personaLocale` (the digest-email
  precedent) so demo emails/SMS render in the recipient's language; the auth port's `Membership`
  carries no locale, so real mode omits it and copy falls back to the app default — a noted
  simplification a real instance closes at its IdP.
- **Recipes live in a new `docs/recipes/` directory** (2026-07-23; `sms-twilio.md`,
  `web-push.md`), cross-linked from `docs/app-coverage-gaps.md`. The web-push recipe records the
  `file://` service-worker physics degrade. **No cutover row** — zero vendor is forced (customer phone
  gateways are instance work).
- **The notify seam is best-effort by construction, not by caller discipline** (2026-07-23,
  pre-merge review finding). The exported entry points (`notifyAdmins`, `notifyJobTerminal`) swallow
  their own failures — per recipient in the admin loop, end-to-end for the job path (whose
  `listMembers` is a real IdP call in real mode) — because producers invoke them AFTER the primary
  mutation committed, and a notification failure must neither 500 a succeeded action nor (on the
  completion webhook) trigger a vendor retry that no-ops as idempotent and silently drops the
  notification anyway. Producers stay unguarded on purpose: safety lives at the seam so future
  producers inherit it. The previously-untested recipient logic (kind allowlist, active+managing
  filter, unknown-job no-ops) is now pinned by `src/server-lib/notify.test.ts` against the durable
  in_app rows.

- **Address scheme: plus/sub-addressing `<org-slug>+<handler>@<domain>`** (2026-07-23). Chosen over the
  subdomain form (`<handler>@<org-slug>.<domain>`) because it needs a SINGLE Mailgun domain and a SINGLE
  catch-all Route — no per-org DNS/MX. The plus sign is RFC-5321-valid in a local part and Mailgun Routes
  regex-match it; the classic "a mail client strips `+tag`" worry only bites addresses a HUMAN types as
  their OWN From/To — this is an intake address the app HANDS OUT for the world to send to, so stripping
  never applies. The base local part is the org, the `+tag` the handler. Parser + formatter are pure in
  `src/core/inbound-email.ts` (shared by server intake and the static twin).
- **Org resolution is global-by-slug; tenant comes FROM the org; `org_id` is NULLable for the
  multi-domain path** (2026-07-23). The recipient names only the org, so intake resolves the org GLOBALLY by
  slug (unique across the seed), which yields the tenant too. Zero or multiple matches → unresolved (an
  address alone can't disambiguate a collision). Because tenant is derived from the org, the single-domain
  template never files a row without an org — but `inbound_emails.org_id` is declared NULLable anyway,
  honestly, for the REAL multi-domain path where the recipient DOMAIN maps to the tenant while the local
  part's org may be unknown (and for deliverability events that belong to a tenant but no team). The RLS
  proof exercises a null-org row directly. Unparseable/unresolved inbound is dropped with a 200 + a
  recorded caveat (no domain→tenant map in the template); it is NOT filed.
- **Poison messages return 200; only infrastructure failures 5xx** (2026-07-23). Mailgun retries a non-2xx
  for hours, so a permanently-broken message must never surface as 5xx or it retries forever. Intake
  CATCHES a handler throw → status 'failed', row KEPT, caller returns 200. A failure of the row insert
  itself (infra) propagates → real 500 → an appropriate Mailgun retry. The signature/auth failures ARE
  4xx (401) — a bad-signature caller isn't Mailgun, so retries are irrelevant.
- **`unmatched` covers two distinct causes; the note handler is member-only** (2026-07-23). An unknown
  handler slug files 'unmatched' with `handler` NULL (no handler claimed it). The `note` handler, when it
  DOES claim a message, still declines an UNMATCHED SENDER (an address not in the org's active members) —
  filing 'unmatched' with `handler = 'note'` and no note. Rationale: email-to-note is a member
  convenience; letting an arbitrary internet sender write into a team's notes is an injection vector. The
  alternative posture (attribute unmatched senders to a system actor) is a one-line change, recorded but
  not taken. So `handler` NULL ⇔ "no handler for this slug"; `handler` set ⇔ "this handler processed it",
  with `status` telling the outcome.
- **Fake-mode intake bypasses the signature, honestly** (2026-07-23). Backstage "compose inbound" does NOT
  spoof a Mailgun signature — it calls the shared `intakeInboundEmail` seam DIRECTLY through a
  fake-mode-gated route (`/api/backstage/inbound/compose`). Spoofing a signature from the panel would be
  theater. The real signed route (`/api/webhooks/email`) still runs the verifier in fake mode (reusing
  the per-checkout dev webhook secret as the fake signing key) so its unit/integration test exercises the
  true signed path.
- **Compose + inbound list live IN the Mail tab, not a new tab** (2026-07-23). The doctrine says new
  world surfaces become Backstage tabs, but inbound email is the RECEIVING half of the SAME mail surface
  whose outbound half already lives in the Mail tab — a sibling section reads more honestly than a
  separate tab. The Mail tab now shows: compose-inbound (top), the outbound catch-store (scope switch),
  and the world inbound list (`InboundApp`). Native `<select>`s keep the compose form Playwright-simple;
  the handler is free-text so a bogus slug can be sent to demo the 'unmatched' path.
- **Retention is table-only; no DELETE grant** (2026-07-23). `inbound_emails` is durable like
  audit/notifications (SELECT/INSERT + UPDATE-for-status, no DELETE). No TTL sweep in the template; a
  high-volume/PII-sensitive instance adds one (which would need a DELETE grant). A Scenes reset wipes
  `.data/pglite` with the rest of the fake world.
- **Replay guard is per-process in-memory** (2026-07-23). Mailgun's per-request `token` is single-use within
  the freshness window, tracked in a module-level `Map<token, expiry>` in `src/service-auth/mailgun.ts`.
  Its limit, recorded on purpose: per-process, so a multi-instance real deployment needs a SHARED store
  (Redis/DynamoDB/a tokens table) for a global guard — a `mailgun-routes` cutover note. The timestamp
  freshness window is the primary, stateless guard; the token set is the in-window dedupe on top.
- **Inbound is intake machinery, not a port method** (see ADR-0011 addendum). No `receive()` on
  the `email` port — the app never calls "receive email", the world initiates it as a webhook. The seam
  is the webhook route + a `src/inbound-email/` handler registry (the `src/jobs/` shape). `InboundEmail`
  is a new audit-only ability subject (the `JobSchedule`/`WebhookDelivery` precedent). The `webhooks/`
  authorize()-exemption's `mustMatch` was widened to accept `withMailgunSignature` alongside
  `withWebhookSecret` — both are machine-caller gates, not user sessions.
- **The email-to-note handler enforces the notes route's OWN ability check; sender trust bottoms out
  at Mailgun's SPF/DKIM** (2026-07-23, pre-merge review findings). The handler originally
  matched the sender on active membership alone, which would have let a `restricted` member — denied
  Note.create in the product — author notes by email. It now compiles the matched
  member's ability (`defineAbilitiesFor`) and refuses senders who cannot `create` a Note, filing the
  message `unmatched`; the static twin mirrors the same gate, and a seed-persona regression test
  (Riley) pins it. Recorded residual: attribution trusts the envelope sender Mailgun hands us, so a
  message that passes Mailgun's SPF/DKIM checks with a forged member address would be attributed to
  that member — the same residual every reply-by-email product carries, accepted and noted in the
  handler docstring.
- **The gate is a CLASS; agreements are one rider.** `src/core/gates.ts` is the reusable
  thing: a `Gate` = { id, scope, behavior: block|advisory, resolutionPath, pending(facts) }, evaluated
  by a pure `evaluateGates(registered, facts)` over an OPEN `GateFacts` bag the server assembles. It
  COMPLEMENTS `authorize()` — that seam denies one action (403, no resolution); a gate blocks-or-advises
  across a scope AND carries a resolution flow. Agreements (`src/core/agreements.ts`) are the worked
  example: each current agreement becomes a gate via `gatesForAgreements`, its behavior read from the
  row's `gating` data. Future riders (email verification, MFA per the ADR-0003 addendum, onboarding,
  suspension, billing entitlements) register their own gate + fact key with no change to the evaluator
  or the layout hook — which is what defuses the billing-retrofit risk the coverage doc names.
- **v1 implements scope 'all' only; action-scoped gates are TYPED but not built.** `GateScope`
  is `'all' | 'actions'`; only `'all'` (block/advise the whole protected area) is wired. The seam note
  in `gates.ts` documents exactly where an `'actions'`-scoped gate would hook — inside `authorize()`,
  after the abilities check, consulting pending action-scoped gates for the (action, subjectType) and
  surfacing `resolutionPath` — and it is deliberately NOT built (the round-2 "write it down, don't build
  it early" doctrine). Correspondingly `AgreementGating` is `'block-all' | 'advisory'` only; the plan's
  `'block-actions'` value is omitted because it needs that unbuilt action-scoped seam.
- **Agreements are TENANT-level, not org-scoped — a deliberate deviation from the default.**
  Every other content table (notes/jobs/artifacts) defaults to org-scoping; `agreements` carries NO
  `org_id`, because a site's Terms of Service / privacy notice applies to everyone in the tenant, not
  per-team. So tenant RLS (the `0002_notes` NULLIF policy) is the WHOLE isolation story here, with no
  second app-level org filter. `agreement_acceptances` is APPEND-ONLY at the privilege layer (SELECT/
  INSERT, the `audit_events` precedent) and denormalizes `agreement_version` so an old acceptance stays
  truthful when the agreement is later edited/bumped. `agreements` is SELECT/INSERT/UPDATE (the version
  bump is a granted UPDATE) with NO DELETE. RLS proofs cover both, incl. the append-only rejections.
- **The interstitial renders INSIDE the protected layout — no separate resolution route in v1 (slice
  N).** The gate hook is the layout RSC (`src/app/[locale]/(protected)/layout.tsx`): it assembles the
  user's pending agreements, evaluates gates, and for a pending BLOCK gate renders the generic
  `GateInterstitial` (agreements fill it with body + accept) INSTEAD of children; advisory gates pass
  through with a dismissible banner (the demo-banner precedent). Because the interstitial renders in
  place (not a redirect to `/agreements`), there is no resolution route to allowlist and NO gate loop is
  possible: `POST /api/agreements/accept` lives under `/api` (outside the layout), and signin/
  accept-invite live outside `(protected)`, so all three stay reachable while a gate is active. The
  header stays visible during a block so sign-out/org-switch remain reachable. `resolutionPath` is thus
  informational in v1; it earns its keep for a future externally-resolved rider (the e-sign recipe).
- **Accept is a self-only authorized mutation; bump is a fake-mode god op.** `POST
/api/agreements/accept` calls `authorize(user, …, 'create', { type: 'AgreementAcceptance', ownerId:
user.id })` — a new self-only ability subject (the `NotificationPref`/`User` precedent), so a user
  records only their OWN acceptance; the accepted version is read server-side, never client-supplied;
  the acceptance is audited (`agreement.accepted`). The version bump is a Backstage god op
  (`/api/backstage/agreements/bump`, 404 first line, `!isFakeMode` mustMatch-exempt) that resolves the
  agreement's tenant via a raw cross-tenant read and then bumps through `withTenant` — exercising the
  app_user UPDATE grant the RLS proof covers, the shape a real admin agreements UI would use.
- **Seed shape keeps every existing e2e green: pre-accept + clickwrap-on-join.** The alpha
  `tos` (block-all, v1) is pre-accepted by EVERY seed persona in tenant alpha, so no seed-persona sign-in
  is ever blocked — the world stays stable until an operator BUMPS the version (the demo story). The
  demo-org `privacy` (advisory, v1) is accepted by nobody, so its dismissible banner shows out of the
  box (proving advisory). The one case the pre-acceptance can't cover is a NEWLY invited (dynamic)
  persona — Bob joins Research (alpha) and would hit the block-all ToS, breaking the accept-invite specs
  (real AND static). Resolved by **clickwrap-on-join**: accepting an invitation records acceptance of
  the tenant's current agreements (the accept-invite route + the twin's accept handler both do this),
  so a fresh joiner isn't immediately gated — a legitimate "you agreed to the terms by joining" stance,
  and a later bump re-arms the gate for them too. In real mode this route doesn't run (Clerk join lands
  the user on the interstitial instead — the same seam), a documented real/fake entry-point difference.
- **The gate control is a SECTION in the Scenes tab, not a new Backstage tab.** Scenes hosts
  world knobs (reset, flags, clock); a ToS version bump is a world knob (it re-arms the gate for
  everyone), so the Agreements section lives there — the same "prefer a section over tab-count creep"
  call the audit-in-Events-tab decision made. It lists every agreement across all tenants
  (a cross-tenant god view) with version, gating, and acceptance tallies, each with a bump button.
- **Clickwrap-on-join now carries its notice; the v1 gate posture is recorded honestly**
  (2026-07-23, pre-merge review findings). The fake-host accept-invite screen discloses that
  joining also accepts the tenant's current agreements (`agreementsNotice`, both locales) — an
  acceptance record without notice isn't real clickwrap, and the worked example exists to teach the
  pattern; provenance was already in the row (`metadata.via: 'invite'`). The hosts differ on purpose:
  real mode records nothing at join — Clerk-joined users land on the interstitial (full notice +
  assent), so the notice line belongs to the fake host alone. Separately, `src/core/gates.ts` now
  states the v1 enforcement posture plainly: a block-all gate blocks the protected UI only; direct
  API mutations by a blocked-but-authenticated user are not gated until action-scoped gates hook into
  authorize() — a compliance/UX gate, not a security boundary (abilities and RLS are unchanged by
  gating). Also recorded: the accept route's bump-race tradeoff (server-current version wins over a
  forgeable client-supplied one), and profile acceptance rows key on acceptedAt to tolerate
  append-only duplicates.
- **Mechanical identifiers de-branded ahead of templating: derive from `APP_SLUG` or go neutral**
  (2026-07-23, `feat/app-identity`). New `config/app.ts` exports `APP_SLUG` as the ONE place an
  adopter changes the app's mechanical identity; it is dependency-free so both `src/` and `infra/` import
  it. The split is by COLLISION RISK. Identifiers that can collide across two coexisting apps DERIVE from
  the slug: the fake session cookie (`${APP_SLUG}_session`), fake-auth JWT issuer (`${APP_SLUG}-fake-auth`),
  Backstage viewpoint cookie (`${APP_SLUG}_backstage_viewpoint`) — cookies are port-agnostic on localhost,
  so two local apps would otherwise clash — the service-token audience (`${APP_SLUG}-service`, one const
  fans out to issue/verify/tests), and the infra names (stack id `${Capitalized}AppStack`, `Name`/
  `Application` tags, Aurora DB name, budget name) that share one AWS account. Identifiers that are only
  origin- or process-scoped are instead NEUTRALIZED so they never need adoption-time renaming:
  the data-dir env var → `APP_DATA_DIR`, the fake-db global → `__appFakeDb`, the `localStorage` keys →
  `app-backstage-*`, the mail-preview `postMessage` type → `app-mail-link`, the public-metadata type →
  `AppPublicMetadata`, test tmp-dir prefixes and the contract-test DB name, and the
  `.claude/launch.json` profile → `app-dev`. The per-slug workspace scope became `@app/*`
  (`@app/seed`). Residual INSTANCE identity is deliberately kept: the root package name, the infra
  package name, the `APP_SLUG` value itself, all display copy (`messages/*.json`,
  the `layout` metadata title), and `config/params.ts` `sentry.org` — these belong to an instance and
  are handled by docs/cutover, not by templating. Outbound webhook header names (`x-<slug>-signature` and
  siblings) DID get derived (`WEBHOOK_*_HEADER` consts in `src/core/webhook-signing.ts`, built from
  `APP_SLUG`): they are an external signing contract that receivers pin at integration time, which is
  exactly why the change happens NOW — pre-cutover there are zero real receivers, and after cutover the
  names freeze. An adopter's receivers thereby pin `x-<their-app>-*`, never the template's brand.
- **The framework/app seam is one alias, `@app-config/*`, deliberately distinct from `@/app-config/*`**
  (2026-07-23, PR 1a, ADR-0012). Framework code reaches app content ONLY through the seam modules under
  `src/app-config/`, imported by the `@app-config/*` alias. The eslint fence bans the `@/app-config/*`
  path (and `@/app/*`, `@/domain/*`, `@/jobs/*`, `@/demo-static/*`, `@app/seed`) in framework dirs — so
  the two spellings that resolve to the SAME files split into "banned direct path" vs "allowed seam". No
  DI, no module augmentation: framework→seam is a plain typed import (types exported by the framework,
  values enumerated). Rejected module augmentation (solves only the type half) and generics (threads a
  `<TSubject>` everywhere for one consumer).
- **eslint fence structure re-lists patterns per block (the merge trap, again)** (2026-07-23, PR 1a).
  `no-restricted-imports`/`no-restricted-syntax` REPLACE by file-match rather than merge, so every
  framework block re-lists `vendorSdkPattern` + `appCodePattern` (+ `nextFontPattern`), and the
  app/component `no-restricted-syntax` blocks re-list `getDbSelector`/`processEnvSelector` alongside the
  new `a11yLiteralSelector`. Adapters get `appCodePattern` only (no vendor ban — vendor SDKs are their
  job). Proven by temporarily adding a forbidden `@/domain/*` import to a `src/core` file and watching
  lint fail with the ADR-0012 message.
- **Migration numbering convention: framework 0001–0999, app ≥1001** (2026-07-23, PR 1a, ADR-0012). When
  `notes`/`org_requests`/`artifacts` became app tables they moved to `src/app-config/db/migrations/` and
  renumbered `0002→1001`, `0006→1002`, `0007→1003`. Kysely runs the composed registry NAME-SORTED, so app
  migrations run after every framework table exists — safe because app tables only reference framework
  tables (`organizations`), never the reverse. The framework's `0003_organizations` used to `ALTER TABLE
notes ADD org_id`; a framework migration must never touch an app table, so that column moved into
  `1001_notes`'s `createTable` (notes now runs after organizations). Safe only pre-cutover (wipe `.data`).
- **Jobs compose like migrations, and the SEAM is the handler composition root** (2026-07-23, PR 1a).
  `src/core/jobs.ts` keeps statuses/machine/`exportKeyPrefix` + `FRAMEWORK_JOB_KINDS = ['digest-email']`;
  the seam supplies `appJobKinds = ['export-notes']` + `appJobHandlers`. `JobKind = FrameworkJobKind |
AppJobKind`, `isJobKind` composed. Because the fence bans framework files from importing `@/jobs/*`, the
  fake jobs adapter can't reach the (framework, temp-housed-in-`src/jobs`) `digest-email` handler
  directly — so the seam `src/app-config/jobs.ts` is the composition root that merges both into a single
  `jobHandlers` map the adapter consumes. `isJobKind` reads `appJobKinds` LAZILY (never a top-level
  spread) so the benign core↔seam value cycle (`core/jobs → seam/jobs → export-notes → core/jobs`, all
  runtime-only) can't crash at module-init. PR 2 relocates the framework handler into the package.
- **Three event vocabularies split framework/app by the same union pattern** (2026-07-23, PR 1a).
  `AuditAction`, `NotificationKind`, and `WebhookEventKind` each become `Framework* | App*`: the framework
  keeps its own verbs/kinds (`membership.invited`/`job.submitted`/…, `org.invited`/`job.completed`,
  `job.status_changed`) and the mechanism; the seam (`src/app-config/{audit,notifications,webhooks}.ts`)
  supplies the app vocabulary (`note.*`/`org-request.*`/`artifact.*`, `org_request.received`, the
  `org_request.*` webhook pair) + payload shapes, composed with type-only seam imports (plus a value
  import for the notification copy delegation). Audit's `action` was an untyped `string`; typing it as the
  composed union added real safety with no route changes (the literals already matched).
- **Abilities BaseSubjectType follows reality (11 framework subjects), not the plan's earlier list of 4**
  (2026-07-23, PR 1a). ADR-0012's B.1 text (`'Org'|'Membership'|'User'|'Job'`) predated the round-2 subsystems;
  `BaseSubjectType` actually spans every framework subject (adds `JobSchedule`, `WebhookEndpoint`,
  `WebhookDelivery`, `InboundEmail`, `Notification`, `NotificationPref`, `AgreementAcceptance`), while
  `AppSubjectType` is exactly `Note | OrgRequest | Artifact`. `AppSubjectFields` (the two-sided
  `requesterOrgId`/`responderOrgId`) and `anchorSubjectExtras` moved to `src/app-config/abilities.ts`
  beside `appAbilityRules` + `staffOrgSlug`; `src/core/abilities.ts`'s `default:` delegates to
  `appAbilityRules`, deny-by-default.

- **2026-07-23 — inbound-email handler registry joins the seam (review finding).** The pre-PR review of
  the ADR-0012 diff found `src/inbound-email/handlers.ts` still hard-wiring the app's `note` handler —
  structurally the same weld as the old `src/jobs/handlers.ts` map the diff had just split, missed
  because inbound email landed after the exploration snapshot. Fixed in the same PR by the established
  pattern: `note-handler.ts` → `src/domain/inbound-note-handler.ts`, registrations in
  `src/app-config/inbound-email.ts` (`appInboundHandlers`), the framework registry composes
  `{ ...appInboundHandlers }`, and `src/inbound-email/**` joined the fence globs. The registry's OPEN
  `Record<string, InboundHandler>` key (vs the jobs union) is unchanged — deliberate, per the
  inbound-email decision that email handler slugs are instance vocabulary.

- **2026-07-30 — the framework package split takes six decisions the ADR left open (PR 2).**
  (1) _Imports inside the package are relative, not self-referential_ — `keel/…` self-reference works
  in TS but adds a resolver dependency the package would carry into any future extraction; relative paths
  resolve everywhere, unaided. Outside the package it is always `keel/<subpath>`.
  (2) _Both an `exports` map and matching aliases_ (tsconfig `paths`, both vitest configs, the demo vite
  build). Aliases are what actually resolve in every tool we run; the exports map is the declared public
  surface and the fallback. Cost: knip treats an exports wildcard as "every file is an entry", so unused
  files/exports inside the package are no longer reported (the app half still is). Enabling
  `includeEntryExports` to win that back produced 25 findings, nearly all migration `up`/`down` pairs
  reached through `import * as` — noise that would have to be silenced with ignores, so it was rejected.
  (3) _`src/inbound-email` moved with the framework_ even though ADR-0012's list omitted it: it was already
  inside the fence and importing through the seam, and leaving it in `src/` would have kept a second
  framework glob alive after the whole point was collapsing to one.
  (4) _The `jobs` i18n caveat is resolved by splitting the namespace_, not by keeping the mixed one: the
  four job-status labels the framework's `JobTimeline` renders became the framework namespace
  `jobTimeline`; the export-card copy stays in the app's `jobs`. The alternative (framework keeps `jobs`,
  app renames) was equal churn and a worse name for app copy.
  (5) _The merged-catalog tests live in the package and reach the app half through the seam loader_
  (`loadAppMessages`), rather than moving to the app side or reaching for `../../../../messages`. So the
  package keeps proving its own guarantee AND the merged one without breaching its own boundary.
  (6) _The mutation-scan resolves the app's route dir from `process.cwd()`_ instead of a relative path out
  of the package — the scan is framework code whose subject is whatever host app it runs in, and its
  "found no mutating routes" case fails loud if the root is ever wrong.
- **The doc set split four ways, and doctrine paths became a gate** (2026-07-30, branch
  `docs/truth-pass-template-hygiene`). The 2026-07-30 framework relocation updated the README, CLAUDE.md,
  CONTRIBUTING, adopting.md and ADR-0012 but left four doctrine documents and all three recipes teaching
  `src/ports` / `src/adapters` / `src/core` — 180 backticked citations pointing at directories that no
  longer existed, with the recipes actively instructing adopters to create ports where the lint fence now
  rejects them. Fixing the paths was the easy half; the durable half is `tests/docs/doc-paths.test.ts`,
  which fails the build when a doctrine doc cites a path that does not resolve. Three design calls made
  while writing it. (1) **Scope by document KIND, not by directory.** ADR bodies, `decision-log.md` and
  `build-notes.md` are dated append-only records whose entries were true when written; rewriting them to
  match today's tree would falsify them, so they are exempt from the gate and corrected opportunistically
  instead. ADRs are amended by dated addendum, which the set already did — that convention is now written
  down rather than merely practised. (2) **A file citation may resolve on its PARENT directory; a
  directory citation may not.** Every recipe names files you are meant to create
  (`…/adapters/real/esign.ts` is the recipe's output), so requiring exact existence would forbid the
  genre. But letting directories take the same fallback made `src/app-confgi` pass on the strength of
  `src/` existing — caught only because the test was deliberately made to fail before it was allowed to
  pass. (3) **Globs and `<metavariable>` placeholders assert only their static prefix**, so
  `…/adapters/<real|fake>/<name>.ts` checks `…/adapters/`. The gate immediately paid for itself by
  catching a stale path in `.claude/commands/repo-health.md`, a file no one had thought to include in the
  sweep. Also split the doc set four ways — doctrine (gated), dated records (exempt), frozen history
  (deletable by an adopter, and deleted at publication), and future tasks (`.claude/future-tasks/`, one
  file per item with a priority index) — because "doctrine vs history"
  had been putting a live troubleshooting reference (`build-notes.md`) and a 1000-line provenance log in
  the same bucket as a frozen build report.
- **The cutover checklist split into a template and a frozen instance list** (2026-07-30, same branch).
  The file described itself as "this instance's live punch list" while also being the only cutover artifact
  a fork inherits, so every adopter started with another team's rows, another team's accounts, and
  another team's name in the "what unlocks it" column. `docs/cutover-checklist.md` is now the rows every
  instance needs, empty and vendor-neutral in the item names (`auth-dev`, `email-inbound`, `llm-key`)
  while keeping the vendor-specific proofs in the deferred-verification column, because that column is
  the point. A filled-in row is kept at the top of that file as the worked example. `config/params.ts` comments were re-pointed at the new row names, and its last piece of
  instance identity (`sentry.org`) became a placeholder like its neighbours.
- **`apps/starter` keeps its seed inside the app, not in a `packages/*` workspace** (2026-07-31,
  `feat/starter-app`). The showcase's world lives in `packages/seed` (`@app/seed`) for historical
  reasons — it predates the `apps/` tree. But the framework never imports it: it reads
  `@app-config/seed`, which re-exports it, so WHERE an app keeps its seed is entirely the app's choice.
  Sharing one seed package between two apps would have been exactly the coupling the second app exists
  to disprove, and an app-local module is one fewer workspace for an adopter to find, rename and
  repoint. It also proves `keel/seed/contracts` is a real published surface rather than a private
  arrangement with one package: `apps/starter/src/seed` fills the same contracts with no `@app/seed`
  anywhere in its graph.
- **Root scripts fan out by directory glob, except the four that must pick one app** (2026-07-31, same
  branch). `pnpm verify` covering both apps is non-negotiable — a green gate that silently skips an app
  is worse than no gate — so `typecheck`, `test:e2e`, `build`, `build:demo-static`, `check:demo-size`
  and `e2e:demo-static` all became `pnpm --filter './apps/*'`, which picks up an added or renamed app
  with no edit to the root. `verify` itself is unchanged: fanning out is a property of the scripts it
  calls, not of the gate. The heavy ones pin `--workspace-concurrency=1`, because two Next dev servers
  and two Chromium fleets on a 10GB VM is the OOM the e2e config already warns about. `dev`, `start`,
  `ladle` and `build:demo` still name `showcase`: a command that starts one server has to choose, and
  saying so in `docs/adopting.md` as a four-line repoint is more honest than a clever default.
  `apps/starter` runs on port 3100 so both apps can be up at once.
- **`apps/starter` ships no Panda and no Sentry** (2026-07-31, same branch). Panda is vestigial in this
  repo — `panda.config.ts` sets only `preflight` and the generated output is imported by nothing, while
  Mantine ships its own reset — so adding it to the starter would have meant 121 committed generated
  files for no behaviour. Sentry is inert without a DSN and is a cutover row. Both are documented in
  `docs/adopting.md` as things to copy from `apps/showcase` when you reach them, rather than dead weight
  in the app an adopter keeps.
- **The showcase became a support desk, and its world starts mid-shift** (2026-07-31,
  `feat/support-desk`). The example app was an excellent coverage harness and a thin product: every
  framework capability had a caller, but the nouns were abstract (`notes`, `org_requests`,
  `artifacts`), the cast was "Ada Admin" in "Alpha Organization", and `packages/seed` seeded **zero**
  product rows — so the demo opened empty and the tour was "click each card" rather than a story. The
  domain is now a desk: `tickets`, `escalations` (two-sided: raising desk ↔ receiving team) and
  `attachments`, run by Northwind Support (a frontline desk, a platform team, a desk-ops operator org)
  with Pinebrook Desk as the second site. The ROLE MATRIX is unchanged — admin / staff / member /
  staff-org operator / guest / restricted, with one multi-org persona — because the ability tests and
  the e2e suite depend on its shape; only the names and the domain moved. Persona IDS were deliberately
  left alone: they are the opaque user ids every table stores, and renaming them would have been churn
  with no reader.
- **Product rows are seeded through an OPTIONAL seam, looked up rather than imported** (2026-07-31,
  same branch). A believable demo needs a queue, an open escalation, an analyzed bundle and an unread
  mail already on the table — and it needs them back after a Backstage world reset, which rules out
  seeding from the app's own boot hook (reset wipes `.data/`, and only the framework seeder re-runs).
  So `keel/db/seed.ts` calls an app-supplied `appSeedRows` last, after its own tables exist. It is
  found by LOOKUP on `@app-config/seed` rather than by a named import, because `apps/starter` has no
  product corpus and a named import would make its absence a build error instead of a no-op — the one
  place the framework tolerates not knowing whether the seam exports something. The hook is handed
  `storage` and `email` as well as the db: a seeded attachment with no bytes is a dead download link,
  and an outbox that starts empty has to be talked into looking used.
- **App notification copy moved to the app catalog, closing the last "edit keel to add an app
  feature"** (2026-07-31, same branch). `notificationCopy` now stamps a NAMESPACE onto the copy it
  returns — `notifications` for framework kinds, `appNotifications` for app-registered ones — and every
  surface that renders a notification (the bell, the email, the SMS, the prefs grid) resolves
  `${namespace}.${key}` through a root translator. This is option 2 of the three the open task listed:
  the framework declares a copy CONTRACT and the app satisfies it entirely app-side. The seam itself is
  unchanged (`appNotificationCopy` still returns bare keys), so an app that registers no kinds — the
  starter — notices nothing. Same treatment for the two other places app copy had leaked into keel's
  catalog: a Backstage ACTOR card is now handed finished strings by the host, like
  `BackstageExtraTab.label`, and an app-registered Scenes FLAG carries a fully-qualified message path.
  Net effect: keel's catalog lost nine app-specific keys and gained none.
- **The assistant answers in two passes so it can stream without lying** (2026-07-31, same branch).
  `llm.stream()` takes no tools — deliberately; a streaming tool loop is a much larger contract than a
  template needs — so the route GATHERS with `runToolLoop` (canned model turns, live tool execution)
  and COMPOSES with `llm.stream()`, forwarding chunks as NDJSON. The compose request necessarily
  carries live ticket facts, so it can never hash-match a recorded fixture and always resolves to its
  purpose's DEFAULT entry. That is the fixture mechanism working as designed rather than a gap, and it
  is why the compose pass has its own purpose: pinning the fall-through there keeps the tool-loop
  purpose's own fallback clean. Live data still reaches the screen — the route returns the tickets the
  TOOLS actually read as the answer's sources, so the prose is replayed and the evidence beside it is
  real. `llm.complete()` got its first caller the same way: the `analyze-bundle` job, whose prompt
  carries a customer's bundle bytes and whose fixture is therefore default-only (recording a per-bundle
  entry would mean committing a customer log file to the repo).
- **Every registry that had one member got a second, chosen to differ in the thing that matters**
  (2026-07-31, same branch). Not two of the same shape: `analyze-bundle` differs from `export-tickets`
  by touching three ports instead of two; `search_tickets` differs from `list_my_tickets` by taking
  model-supplied input (so validation is demonstrated, not assumed); `ticket.assigned` differs from
  `escalation.received` by addressing a PERSON rather than a team's managers (which is why
  `notifyMember` had to be exported); `feedback` differs from `support` by the status the resulting
  ticket starts in; `diagnostic-bundle` differs from `attachment` by being the only kind the analyzer
  will take. A second member that merely copies the first proves the registry has two entries, not that
  it composes.
- **Plays drive Backstage through Backstage, so the deep-link seam was never needed** (2026-07-31,
  `feat/plays`). A play has to put the panel on a given tab, which is exactly what
  `.claude/future-tasks/resolved/simulator-deep-links.md` was opened for (`#backstage=mail:all` or an event bus).
  The engine does it with a `['panel', tabId]` script action instead: if the panel is collapsed it
  clicks the pill, waits for the column, then clicks the tab — idempotent, host-independent, and no new
  state anywhere. Better than the seam for this purpose, not just cheaper: a walkthrough exists to show
  a viewer how they would do it themselves, and a hash that teleports the panel open teaches nobody
  anything. The task is marked RESOLVED with the one motivation it leaves behind (an app-side "open the
  panel here" affordance, which is a callback, not a design).
- **A play's `advance` is the reload boundary, which is why every submission belongs there**
  (2026-07-31, same branch). The house pacing rule (submissions fire on the viewer's Next, never on a
  timer) turned out to have a second, mechanical justification on the server host: restoring a scene,
  flipping a feature flag and switching cast member all reload the page there, and the engine's resume
  marker is written when Next is pressed. So an action that reloads must sit in `advance` (it is
  replayed at most once, on the step it belongs to), and anything in a step's entry `script` must be
  safe to re-run after a reload. The team switch in the showcase play is in a `script` precisely
  because the switcher ignores a click on the active team; the `jobs-held` toggle is in an `advance`
  because a Switch is not idempotent.
- **A play's spotlight lights AFTER its entry script, not before** (2026-07-31, same branch). The
  ported engine set the vignette on step entry, which raced the script that navigates to the thing
  being spotlighted — invisibly at rehearsal speed (the script finished inside the 1.5s wait) and
  visibly at presentation speed, where it timed out and reported a missing target. Attaching after the
  script is both correct and better paced: dim, then halo, once the cursor has arrived. Worth
  recording because the CI run would never have found it: **a speed control means the gate and the
  audience are not watching the same thing**, and only watching it at real speed caught it.
- **Tenant/org 404 resolution consolidated into one helper, replacing 22 call sites across 15
  routes** (2026-07-31, `fix/full-code-review-findings`). A full-codebase review found the same six
  lines — resolve `tenantIdForSlug`, 404 `unknown tenant`, resolve `orgIdForSlug`, 404 `unknown org`
  — pasted across every product route that needs the active org (tickets, escalations, attachments,
  jobs, webhook-endpoints, org invite, notification prefs, assistant). Nothing was wrong yet, but 22
  independent copies of a 404 contract are 22 places it can quietly drift the next time one route's
  error body changes and the others don't. Replaced with `resolveOrgContext`/`resolveTenantId` in
  `apps/showcase/src/app/api/org-context.ts`, called by every route that used to inline the lookup;
  callers return the `Response` verbatim on the `instanceof Response` branch. Same treatment for the
  five copies of the DB-test `ids()` helper (`audit.test.ts`, `jobs.test.ts`, `webhooks.test.ts`,
  `attachments.test.ts`, `escalations.test.ts`), which now wrap the same exported lookups instead of
  hand-rolling the `tenants`/`organizations` queries each carried.
- **The cursor is opaque, canonical, and its own codec** (2026-07-31, `feat/keyset-pagination`).
  base64url over `"<iso-instant>|<id>"`, hand-rolled in `packages/keel/src/core/keyset.ts` for the same
  reason `webhook-signing.ts` hand-rolls SHA-256: the module must run identically on the server and
  inside a `file://` bundle, so no node builtin and no environment-dependent global (`btoa`/`atob` are
  latin1-oriented and their availability is an assumption, not a property of the code). The payload is
  ASCII by construction — both halves are pattern-checked before encoding — so it is a plain byte↔char
  map with no UTF-8 machinery, cross-checked against `Buffer.toString('base64url')` in test. Decoding
  rejects padding, a dangling character, and non-zero padding bits, which makes the encoding CANONICAL:
  one position has exactly one cursor, so a malleated cursor is refused rather than quietly normalised.
- **A malformed cursor is a 400, and validation is split across the two layers that can enforce it**
  (2026-07-31, same branch). `parseKeysetCursor` (pure) validates the transport shape — a strict
  ISO-8601 UTC instant and a bounded `[A-Za-z0-9_-]{1,64}` id — and `parseDbKeysetCursor` adds the one
  constraint only the SQL layer knows: the id must be a uuid, since that is what it will be bound as, and
  a non-uuid could only ever have become a cast error (a 500, and a probe signal) inside the statement.
  Routes over SQL use the second; the static-demo twin uses the first, whose row handles are not uuids.
  The route returns 400 rather than silently serving page one — a cursor the server cannot read means the
  client is confused and should hear about it — but the failure mode if a route forgot that is a repeated
  FIRST page, never a widened one, because scope never came from the cursor in the first place.
  Calendar validation is a round trip, not a parse: JS silently rolls `2026-02-31` over to March 3rd
  rather than reporting NaN.
- **The desk's page size is 5, and the seed grew an archive to make it visible** (2026-07-31, same
  branch). A page size no seeded world ever reaches is a pagination feature nobody can watch working, so
  the frontline queue gained six older resolved tickets (11 total, three pages). Two constraints shaped
  them, both from things that already read the queue: they are all OLDER than the existing five, so page
  one is byte-for-byte the list that was there before paging existed (the ticket play asserts `NW-1028`;
  the SLA banner counts the loaded rows), and they are numbered BELOW `NW-1041`, so the next reference
  the desk issues is still `NW-1042`, which that play says out loud in its narration.
- **A mutation re-anchors the paged queue to page one rather than patching the loaded pages**
  (2026-07-31, same branch). A create lands at the head, a delete leaves a hole, and a status edit can
  move a row — so after any of them the only honest thing to show is what the server says the queue is
  now. The static-demo twin differs, in its favour and deliberately: it holds a page COUNT rather than a
  cursor and re-walks the chain from the start on every render, because the whole world is in memory and
  re-walking is free. A ticket arriving at the head (an inbound email) therefore appears immediately
  without disturbing how far down the reader has walked.
- **Ports are derived per checkout; `workers` stays 1; CI parallelises by sharding** (2026-07-31,
  `fix/e2e-port-isolation`). Three decisions from one investigation. (1) `scripts/ports.mjs`
  derives every port from the checkout path, so a linked worktree under `.claude/worktrees/` gets its
  own and two agent sessions stop adopting each other's dev server — the failure `build-notes` records
  three times. The MAIN checkout keeps :3000/:3100 deliberately, so every runbook and ADR that names a
  port stays true for a human reading it; only worktrees derive. Derivation is a pure function of the
  path rather than a free-port scan because showcase's `test:e2e` is two Playwright invocations that
  must agree without talking to each other. (2) `workers: 1` stays, but the REASON in the config is
  replaced: it was "10GB VM, renderers get OOM-killed", and the measurement says flakes scale with
  parallelism on a 64GB machine too, because every worker shares one `.data` behind one dev server.
  (3) Therefore CI stops trying to buy parallelism inside a shard and buys it ACROSS runners instead —
  the `e2e` job is now a matrix of showcase / showcase-destructive / starter, plus a separate
  `demo-static` job, so wall clock is the slowest shard rather than the sum. Separate runners have
  separate worlds, which is the property that makes it safe. This also supersedes the
  `--workspace-concurrency=1` reasoning above for `e2e:demo-static`, which was never justified: those
  specs drive `file://` with no server and no shared state at all.
- **The Simulator vocabulary: every noun in the panel is now literal.** SUPERSEDES the earlier
  "Backstage naming: the app is the stage, the panel is backstage" entry above, which framed the panel
  as a theatre metaphor. Five renames landed together: Cast → **People** (and `Persona` → `Person`
  through the seed, so the tab and the type finally agree), Scenes → **Snapshots**, Plays → **Tours**,
  Backstage → **Simulator**, `isFakeMode` → **`isSimulated`**. The rule that came out of it is recorded
  in ADR-0012's 2026-07-31 addendum: one proper noun per half (`keel`, `Simulator`), everything inside
  literal. The diagnostic that produced it: a name glossed in the next line of copy is not earning its
  keep — the catalog was already writing "the five seed personas", "Save a snapshot", "Scripted
  walkthroughs" directly beneath Cast, Scenes and Plays.
- **Considered and rejected, so it is not relitigated.** For the PACKAGE: `Theater` and `AllTheWorld`
  — both name the framework after its most vivid surface, the exact mistake ADR-0012 already recorded
  when it rejected `backlot`/`soundstage`; `AllTheWorld` additionally collides with "the world", which
  the simulated half already owns. For the PANEL: Engine Room, Control Room, Cockpit, Bridge,
  Belowdecks, Workbench, Lab, Inspector, World — Engine Room was the runner-up and lost on a fact, that
  the panel exists only when everything is fake, so naming it after real machinery would have been less
  true, not more. For the ACTORS tab: Services, Processes, Counterparties (see the ADR addendum for why
  each fails); Actors stays because it is the actor model, a software term, not a theatre borrowing.
- **Spanish translates the panel name; it did not before.** `Backstage` was left untranslated as a
  proper noun. `Simulador` is translated, because every other tab in that panel is (Personas,
  Instantáneas, Recorridos) and the whole premise of the rename is that the name should need no gloss —
  which "Simulator" does not satisfy for a Spanish reader when an exact cognate exists. Two Spanish
  hazards found doing this and worth remembering: `personas` is an ordinary Spanish word, so a bare
  `personas -> people` codemod silently anglicised eight legitimate strings (caught by diffing es.json
  values against HEAD, now the standard check); and `escena` contains no `scene` substring, so the
  Spanish values needed updating deliberately rather than mechanically.
- **A codemod is verified by grepping for the old token AND its all-caps form.** The case-preserving
  rules used here covered `Foo`/`foo` and twice missed `FOO` — `SCENE_NAME_PATTERN`, `EMPTY_SCENES`,
  and three `PLAYS` in comments — each caught by a case-sensitive sweep afterwards, never by the
  guards. Traps that DID hold, and are worth keeping on any future list here: `cast error` (17 times in
  SQL comments), `personal`, `impersonates`, `refactor`/`factory`/`factor`, `Playwright`, `display`,
  `replay`, `playbook`, `multiplayer`, `error-scenario`, and the generated Panda tokens
  `animation-play-state` / `media-play-button` (which is why `styles/generated/` is skipped outright).
- **The Simulator rename requires wiping `.data`, and nothing persisted is migrated.** The seed person
  ids changed (`persona-admin` -> `person-admin`), and those ids are the opaque user ids every table
  stores — assignees, escalation creators, attachment uploaders, notification recipients, audit
  `actor_user_id`. The framework seeder is guarded by "does this world have any rows yet", so a stale
  world keeps the old ids while sign-in mints the new ones: signed-out sessions and orphaned assignees,
  with nothing crashing to tell you. Wipe `apps/*/.data` after pulling this.
  Deliberately NOT migrated, because this is `isSimulated`-only surface that degrades cleanly and a
  migration for preferences would be more code than the problem: the eight `app-backstage-*` browser
  keys (now `app-simulator-*`, including `app-backstage-play` -> `app-simulator-tour`), the
  `_backstage_viewpoint` cookie, `.data/backstage/` -> `.data/simulator/`, `.data/scenes/` ->
  `.data/snapshots/`, and `.data/auth/personas.json` -> `people.json`. Consequences an existing world
  will show: panel width/tab/collapse reset, the coachmark re-shows, a mid-tour resume marker is
  dropped, previously saved Scenes are invisible to the Snapshots list, and invite-accepted dynamic
  people vanish while `invites.json` (name unchanged) is still read. Every read path defaults cleanly
  and the old tab id is unreachable through the new key, so none of it is a break — it is a reset.

## keel's own tests get a fixture app (2026-07-31, `feat/keel-test-fixture-app`)

- **The framework's test seam lives at `packages/keel/test-fixture`, outside `src/`.** Four tools treat
  `packages/keel/src` as the framework — the ESLint fence, `.jscpd.json`'s `{apps/*/src,packages/*/src}`
  pattern, knip's `includeEntryExports`, and the root tsconfig's `include` — and a fixture app inside
  `src/` would have had to fight all four (most sharply jscpd, where a fixture seed is a near-clone of
  `apps/starter/src/seed`). One directory up costs nothing and weakens nothing; each of the four was
  verified rather than assumed.
- **Exemption staleness in `authorized-mutations.test.ts` is now measured against the FIXTURE tree, not
  the apps.** The alternative was deleting the five exemptions backed only by the demo
  (`profile/`, `assistant/`, `analytics/page-view/`, `auth/accept-invite/`, `storage-upload/`), which
  would have made the map a description of whichever apps happen to be checked out and would delete
  real, considered reasoning the moment an adopter ejects. The fixture backs all eight exact exemptions
  and all three prefixes, so the map stays a statement about the FRAMEWORK's classes of route. What is
  given up is honest and small: an app deleting its own assistant route no longer marks that exemption
  stale. What is kept: every app route is still scanned, still has to call `authorize(...)` or match an
  exemption, and every `mustMatch` gate is still enforced on the file that claims it.
- **The fixture's vocabulary is deliberately unlike either app's** (`harbor`/`lakeside`,
  `depot`/`annex`/`steward`/`wharf`, `fixture-*`, `dockets`, `export-dockets`). Reusing the starter's
  `northwind`/`ops` would have been less typing and would have hidden exactly the regression the fixture
  exists to catch: a framework test quietly reading a host app's world and passing because the slugs
  coincided.
- **`scripts/llm-record.ts` moved into `apps/showcase/scripts/`.** It reads one app's assistant
  registration and writes that app's `fixtures/llm`, so it was app code sitting in a repo-level
  directory; the root program compiling it was the thing that made this visible. Two side benefits:
  `--eject-showcase` no longer needs a special case to delete it, and it is now typechecked against the
  seam it actually runs under.
- **The CSV-escaping coverage moved to the app that owns the code.** RFC-4180 quoting and CSV
  formula-injection neutralization live in `apps/showcase/src/jobs/export-tickets.ts`, but their only
  test was riding along inside keel's fake-jobs suite. That coverage would have died with the move, so
  it became `apps/showcase/src/jobs/export-tickets.test.ts` (driving the handler with stub ports, no
  pglite) and was extended while it was being written — every formula trigger, not just `=`, plus the
  header-only no-team case. keel's test now asserts only the framework's half.
- **No `FRAMEWORK_SUITE_APP` any more.** `vitest.config.ts` had to name one app to carry keel's suite;
  that choice is gone, and with it the reason `init-app` had to rewrite a second literal in that file.

## The starter's leftover content is documented, not gated (2026-10-02, `docs/adopting-starter-content`)

An adopter reported that their product's static demo opened on the starter's tenants and Items card
four days after adoption. `docs/adopting.md` had told them to "keep the shape" of the seed world, they
read that as "keep the fixtures", and built their own world beside the starter's.

- **The fix is the sentence, plus an inventory.** `docs/adopting.md` gains "The starter's content is
  still wired into your UI" — the seed world, `welcome.subtitle`, the Items slice and the static demo's
  composition root, each with where it shows — and `scripts/init-app.ts` prints the same four as their
  own closing section — only when the app being kept has the starter's layout, since `--app showcase`
  keeps an app with neither that seed directory nor an Items slice. The advice is to REPLACE the seed world: only the starter's own two specs and
  `staffOrgSlug` read its names, and all three are the adopter's files.
- **No residue check.** The report proposed a scan for UI code still importing the starter's fixtures.
  There is no symbol to scan for: the seed is one world behind `@app-config/seed`, so starter content
  is identifiable only by its VALUES. A check would need a manifest of those values, which drifts from
  the seed, cannot run in `pnpm verify` (it is red on keel itself by definition), and goes meaningless
  the first time an adopter renames a tenant.
- **No "not offered at sign-in" flag on `SeedPerson`.** The adopter's local fix hid the starter's
  people from the product pickers while leaving them reachable from the Simulator. Putting that in
  `keel/seed/contracts` would make the framework support the arrangement the doc now tells adopters not
  to build — two worlds in one seed — and would touch both apps, the fixture seam and the static demo
  to do it.
- **The printed section is pinned by a test, and the pin checks paths, not prose.**
  `tests/docs/adopter-identity.test.ts` asserts the section is printed and that the seed, seam,
  catalog and demo paths it names exist in the ejected tree. Watched failing with the heading changed
  and one path misspelled.
- **Removing the content by command is deferred**, not rejected:
  `.claude/future-tasks/init-app-blank-option.md`. The seed cannot go to zero and the Items slice can,
  but an app with no tables and no subjects has never been built here, and deleting Items deletes the
  RLS example the scaffolds cite.

## Simulator People `orgs` mirrors `SeedMembership`; actor keep-alive is lazy, then sticky (2026-10-03, `feat/simulator-people-orgs-actor-keepalive`)

- **`Person.orgs` is `{ orgSlug, role }[]`, not the `{ slug, role }` the task sketched.** It is
  `SeedMembership`'s own shape, so both row builders pass `memberships` through untouched. Renaming the
  key needs a call on the array, which trips a misdirected `react-hooks/purity` error in the static twin
  (see build-notes). `role` stays on `Person` so an app that never sets `orgs` renders as before.
- **`keepMounted` is lazy, then sticky, not always-on.** An always-on Actors tab would start its tick
  loops at page load, so every spec and tour would begin in a world that is already moving. Nothing
  mounts until the tab is first opened; from then on it stays mounted, hidden, through tab switches and
  collapse. The collapsed panel keeps its hidden aside at the same tree position, because an iframe
  that moves reloads. Replaced: "a host-built tab's content exists only while that tab is active".
- **Actors off the page stay undecided.** Running an actor with no page open contradicts the stated
  "client-side processes, in same-origin iframes" design and can never work on the `file://` host; it
  stays open in `.claude/future-tasks/actors-as-independent-systems.md`.

## Simulator actors run from page load, held by a world flag; People chips show only what distinguishes (2026-10-03, `feat/actors-always-on`)

- **Actors are always on.** Replaced: the same day's "`keepMounted` is lazy, then sticky". A real
  counterparty doesn't wait for someone to open a Simulator tab, so the Actors tab now mounts from page
  load. Lazy mounting existed only to keep specs and tours quiet; that job moves to an explicit world
  switch, the showcase's `actors-held` Snapshots flag. `ActorShell` asks its host's `held()` before
  every autonomous tick, keeps its schedule while held, and shows a `held` state; a manual Step ignores
  the hold, because stepping is an explicit operator act. Specs that drive held jobs by hand turn it on.
- **The flag is the app's, not the framework's.** Actors are app content (`@app-config/actors`), so the
  switch that holds them is registered on the same seam (`@app-config/simulator` flags). The framework
  supplies only the `held` hook, so an app with no actors — the starter — shows no such toggle.
- **People chips derive from the rows, not from configuration.** Every keel app HAS a tenant and an org
  for every person (the auth port requires both), but many only ever run one of each. The tenant chip
  shows only when the rows span more than one tenant, and the org name only when they span more than
  one org (`people-dimensions.ts`); role always shows. A second tenant or team makes the chip appear on
  its own.

## A `date` column reads as a string, on both engines (2026-10-03, `feat/upstream-date-storage-keyset`)

- **The return type is the wire string, `'YYYY-MM-DD'`, not a `Date`.** A `date` is a calendar day
  with no time and no zone; any `Date` built from it has to pick a zone, and each driver's default
  picks a different one. `pg` builds local midnight, so a server east of UTC hands back the previous
  day once the value is read as UTC (watched: `2026-10-03` came back as `2026-10-02T15:00:00.000Z`
  under `TZ=Asia/Tokyo`). pglite builds UTC midnight, so the fake and the real engine disagreed on the
  same row. The string is also what the schema types already promised (`string`), it sorts and
  compares correctly as-is, and `'infinity'` survives (pglite's default turned it into `null`).
  `date[]` reads as `string[]` for the same reason.
- **Per pool, not process-global.** The real adapter passes a `types` override to its own `Pool`
  rather than calling `pg.types.setTypeParser`, which would rewrite the parser for every `pg` client
  in the process from whichever module happened to load first. Only text-format `date`/`date[]` are
  overridden; everything else falls through to `pg`'s defaults.
- **pglite gets the same override, and the tests use it.** The claim that pglite could not take a
  parser was wrong: `PGliteOptions.parsers` does exactly this. Every pglite the framework opens now
  comes from one factory (`openPglite`, `packages/keel/src/adapters/fake/pglite-dialect.ts`), and the
  pglite RLS suite builds its engine there too. Before this it called `new PGlite()` directly, so it
  proved a configuration the app never ran.
- **keel's fixture got its own contract database.** The proof is a `date` column on the fixture's
  `dockets` table (`1002_dockets_due_on`), and the fixture's migrations had never run on real Postgres:
  the contract runner held a single app. `vitest.contract.config.ts` now has a second project, `keel`,
  aliased at the fixture seam. Its harness
  (`packages/keel/src/adapters/real/db.contract.test.ts`) creates `keel_contract` on whichever server
  it is given and drives the real adapter's `createRealDb`, so the contract run proves the pool
  configuration production uses. Files run one at a time because both harnesses default to the same
  derived embedded-postgres port. The showcase harness is unchanged. It still builds its own `Pool`,
  and with no `date` columns in its proofs that difference is harmless today. Watched failing:
  removing the `date` override, then the `date[]` override, from the real adapter turns the `keel`
  contract project red, and removing pglite's turns the pglite suite red.

## Per-person cloud workspaces: a recipe, not a port (2026-10-03, `upstream-mechanical-bundle`)

A future task proposed a `workspace` port generic over the backend, with its adapter selection gated
independently of `APP_MODE`. It is resolved the other way, as `docs/recipes/workspace-coder.md`.

- **Fails both vendor-code tests.** Almost no instance provisions per-person dev environments
  (universality), and an authenticated REST vendor behind a polled long-running operation is a class
  the LLM, email and webhook-dispatch adapters already teach (new-class).
- **The implementation it was drawn from broke doctrine twice**: it chose its adapter from the
  backend's own env vars rather than `APP_MODE`, and it let product vocabulary into the adapter
  registry. Writing the plan down, rather than lifting the code, is what keeps both out.
- **The one legitimate need survives as an explicit override.** A real backend inside an otherwise
  simulated demo is allowed only as a named, fail-closed switch with its costs stated in the recipe —
  never an adapter that turns itself on because its env vars happen to be present.

## What a derived app's mechanical changes did NOT bring back (2026-10-03, `upstream-mechanical-bundle`)

A derived app's change list was mined for small, mechanical items worth taking back into keel. Four of
them were declined, each for the same reason: keel has no caller for them, and dead exports fail the
gate (`knip`) as surely as dead vendor code fails the doctrine.

- **`BadRequestError` / `ConflictError` in `packages/keel/src/ports/errors.ts`.** The derived app throws
  them from adapters keel does not ship (a workspace backend — now `docs/recipes/workspace-coder.md`,
  which tells an adopter to export their own typed conflict from that port) and maps them in its own
  respond helper. The nearest keel candidate is the fake storage adapter's path-escape refusal, but
  making that a 400 would give the fake a failure mode the real S3 adapter does not have, which is the
  opposite of what a fake is for. Revisit when a real keel adapter has a caller-input failure to report.
- **Optional `themePrimaryColor` / `themeRadius` on `SeedTenant`.** `getTenantTheme`
  (`packages/keel/src/theme.ts`) already falls back when they are missing, but every keel seed world —
  both apps and the fixture — sets both, so optional fields would be a contract widened for nobody.
- **A `label` prop on the user menu.** Generic presentation (text and a chevron beside the avatar),
  not a framework invariant made visible; it fails the component test in
  `docs/development-approach.md`, and no keel shell draws a name in its top bar.
- **Out of scope by choice, not by test:** stopping the invite flow from emailing admins (a product
  decision), a caller-named org for `sendInvite` and the live-org list it needs, a fake-person helper,
  and a package licence file.

## Demo presets are declarative, registered beside the flags, and replayed per host (2026-10-03, `prebaked-demo-presets`)

- **No prebaked `.data/` worlds.** The task proposed a `pnpm snapshots:seed` that drove the fake
  adapters and saved through `saveSnapshot()`. Those copies carry pglite's binary state, so they could
  only ever restore on a server, and the task's own second half asks for the `file://` demo too. Presets
  are a seed-relative script instead (`keel/core/presets.ts`), replayed fresh on each load. Nothing
  binary is generated or committed, and nothing goes stale when a migration changes the database.
  Directory snapshots stay as the server's "save what I clicked together".
- **Registered on `@app-config/simulator`, not a new seam module.** Presets are Simulator content,
  like the flags beside them, and `simulator` is already on ADR-0012's list of value imports. A new
  module would cost every app and the fixture one more file to say nothing in. The starter registers
  `presets = []`; the fixture registers one preset in its own vocabulary, because the server replay's
  test must replay keel's world, not an app's.
- **Three operations: `invite` and `inbound` name their actor and team; `flag` is world-wide.** That set
  covers the task's worlds (a pending invite, unread mail, tenant rows, both tenants busy). App rows
  come in through inbound email, which the app already registers handlers for on both hosts, so
  presets need no app-registered operation kinds yet. That stays a possible extension point; nothing
  needs it today. Operations never mean "whoever is signed in", so a replay is deterministic.
- **Authorization moves to build time.** A replay has no session. Instead of authorizing at replay
  time, `presetProblems` holds every registered preset to the product's own rules: the inviter must
  manage the team, the role must be grantable, no duplicate addresses, and handlers and flags must
  exist. It runs as a seam-conformance test under every app and the fixture. The server replay throws
  on anything it cannot perform, rather than skipping it, because getting that far means the gate was
  bypassed.
- **The invite flow was extracted, not copied.** Everything after the org route's decision to invite
  (mint, audit, email, analytics, admins' notification) is now `keel/server-lib/invite.ts`
  `sendOrgInvite`, shared by the route and the replay. The route keeps authorization, validation and
  the duplicate check, which genuinely differ by caller.
- **The viewpoint is who the restorer sits down as, not captured state.** It is a per-browser cookie
  and the world is shared. A preset may name a seed person, and loading it signs in only the browser
  that loaded it (cookies on that one response). Other browsers keep their viewpoint. If theirs
  pointed at a person the reset removed, they land on sign-in, as after any reset. Viewpoint capture
  for directory snapshots was not added: it would raise the same question with no good answer.
- **One resolution order for a world-start name: `'reset'` → preset → saved snapshot**
  (`resolveWorldStart`), shared by both hosts' tour starts (and the showcase test that checks every tour's
  start). Saving a snapshot under
  `reset` or a preset id is refused, in the UI and with a 403 from `saveSnapshot`, so a tour's
  `snapshot` can never name two worlds. Restore and delete stay permitted, so a snapshot saved before a
  preset took its name is not orphaned.
- **A tour start a host cannot honour is a miss.** `useTours`' `onSnapshot` may now answer `false`.
  The static shell does that for a saved-snapshot name, so a tour that only works on a server fails the
  `file://` walkthrough gate, and a unit test in the showcase says so without building a bundle. The
  server glue's reset/restore/preset handlers answer a promise that settles `false` on refusal and
  never settles on success, because the page is reloading. This also closed a race that predates
  presets: step 1 used to render on the doomed document, and a Next pressed there was lost.
- **A second tour, rather than re-pointing the flagship one.** `invite-from-preset` starts from
  `mid-demo` and walks the pending invite to a member, so a preset start runs end to end in CI. The
  ticket tour keeps `'reset'` and its "press Next to become Dana" opening, which is its first lesson.

## Presets move to their own seam module and gain `extends` (2026-10-03, `presets-own-module`)

- **A seam module of their own.** Replaced: the same day's "registered on `@app-config/simulator`, not a
  new seam module". A list expected to grow to dozens of entries, now with composition, is its own
  registry, and `simulator.ts` goes back to being the panel's tabs and flags. Each preset is one file
  under `presets/`, listed in `presets.ts`. The cost is one more file for the starter (`presets = []`)
  and the fixture, which is now an 18-module seam.
- **Single inheritance only.** A preset has at most one `extends`. A list of bases raises ordering and
  conflict questions (whose viewpoint wins, whose duplicate invite) that nobody needs answered yet. The
  rule today is the plain one: base operations first, the nearest viewpoint wins.
- **`operations` is optional.** A preset can differ from its base by viewpoint alone ("mid-demo, signed
  in as someone else"), without restating the script.
- **Validation runs on the expanded list.** `presetProblems` checks what actually replays, so a duplicate
  invite split across a base and its child is caught, and a child that overrides a bad viewpoint is not
  blamed for it. The price is that a base's own problem repeats under each child, and operation numbers
  count in the expanded list.
- **A consequence in the showcase.** `multi-tenant` now builds on `mid-demo`, so it also contains
  Jordan's pending invite, which it did not before. The static-shell spec that proved "loading another
  preset is a reset underneath" by Jordan's absence now proves it with a hand-made flag flip instead.

## Preset operations become a registry keel and the app both extend (2026-10-03, `preset-operations`)

- **The operation kinds are a registry, not a closed union.** `invite`, `inbound` and `flag` were a
  union in `keel/core/presets.ts` that each host replayed with its own hard-coded `switch`, so an adopter
  could neither add a kind ("assign a ticket") nor make a preset follow a customized invite flow. Now keel
  contributes its kinds, the app registers its own on the seam (`appPresetOperations`, typed by an
  `AppPresetOperation` union composed like job kinds), and each host dispatches every step through ONE
  function that looks the kind up: `performPresetOperation` on the server, its twin in the static world.
- **Three parts per kind, never in one module.** A pure DEFINITION (argument schema, the product rules
  as `check`, the named results it `consumes`) on `@app-config/presets`; a SERVER half on the new
  server-only `@app-config/preset-operations`; a STATIC half supplied by the static composition root
  through `DemoWorldOptions.presetOperations`. The split is physical, not stylistic: a server half
  reaches `server-only` modules and pglite, and the `file://` demo is one browser bundle that fails to
  load with either inside it. It is the same split inbound email already had (server registry vs the
  static twins in `inboundHandlers`). The bundle carries no `pglite` string after the change.
- **Replacement by kind name.** Definitions and both halves compose `{ ...framework, ...app }` keyed by
  kind, so an app entry named `invite` replaces keel's. keel's server halves are published
  (`keel/server-lib/preset-operations`) and its static halves reach an app half through the context's
  `framework` map, so a replacement can WRAP keel's behaviour instead of copying it — the fixture's `flag`
  does exactly that, and keel's replay test proves the app entry is the one that ran.
- **Standard Schema, with Valibot for keel's own kinds.** `PresetOperationDefinition.args` is typed
  against the Standard Schema v1 interface, vendored as types only (`keel/core/standard-schema.ts`), so
  an app may write its kinds in Zod or ArkType. keel's three kinds, the fixture's and the showcase's use
  Valibot, which makes it a new runtime dependency of `keel/core` (allowed: the core fence bans
  frameworks and vendor SDKs, not small pure libraries). Valibot over Zod for the static demo's byte
  budget: Valibot is standalone functions a bundler can keep one at a time, where Zod's default API
  hangs its methods on schema classes (Zod was not measured here). Measured: the showcase's `dist-demo/index.html` went from 938,049 to 942,766 bytes (+4,717;
  budget 950,000, unchanged), the starter's from 849,632 to 853,371 (+3,739). About 3 KB of each is
  Valibot's four schema constructors and issue plumbing, which the bundler keeps although the static
  world never calls them (no host validates at replay time; the conformance gate does): annotating the
  schema calls `/* @__PURE__ */` brought the showcase to +1,690 in a trial, and was not adopted because
  every app author would have to repeat it on every nested call.
- **Shape in the schema, rules in `check`.** keel's `invite` schema accepts any role (`v.picklist(ROLES)`)
  and any string as the email; "cannot be granted by invite" and the email shape stay in `check`, with
  their old sentences. A preset asking for `admin` is a product rule being broken, and the gate should
  answer with the org screen's own words. `check` runs only once the shape passes, and it receives the
  script's earlier valid operations (`earlier`), which is what the duplicate-invite rule always needed.
- **Named results.** An operation may say `as: 'refund'`; the id of what it created is bound to that
  name for the rest of the replay, and a later operation names it in an argument its kind `consumes`.
  Each host keeps its own name → id map (a uuid on the server, the twin's id in the static world), so a
  script never holds a host's ids. `presetProblems` holds names to be unique and bound EARLIER; an
  unbound name throws on the server and settles the static replay false. For `inbound` to produce a
  name, a handler's 'handled' result (and the static twin's) gains an optional `subjectId` — the row it
  created — which intake passes through on `IntakeOutcome`. Additive: no existing handler had to change,
  and the compose route's response simply gains the field.
- **Operations, not a bus, for product code a preset drives.** The showcase's `ticket.assign` does not
  re-implement assignment or post an event a listener reacts to. The PATCH ticket route's post-authorize
  body — write, `ticket.assigned`/`ticket.updated` audit, the assignee's notification — moved, with the
  session's user replaced by an explicit actor, into a named domain operation, `applyTicketChanges` (`apps/showcase/src/domain/ticket-changes.ts`),
  which the route and the preset's server half both call; the route keeps parsing, validation,
  `requireUser`, org resolution, the org-scoped lookup and `authorize(...)`. The core takes the ticket
  as the caller resolved it, rather than its id, so the org-scoped lookup cannot be skipped and the
  route makes no extra read. The static twin got the same treatment (`applyDemoTicketChanges`, shared
  by the ticket card and the static half). The route's unit suite passed unchanged across the move.
- **Coverage where each half lives.** The seam-conformance suite holds definitions and server halves to
  each other both ways under every app. Static halves are built at runtime by the composition root, out
  of a unit test's sight, so the static-shell e2e loads every registered preset and waits for its
  "Preset loaded" notice: a kind with no static half settles the replay false and the notice never comes.

## Holding one actor is a preset operation kind, answered per actor (2026-10-03, `preset-actor-holds`)

The Simulator's actors have had ONE hold, the app's world-wide `actors-held` flag. A demo preset can now
hold a single counterparty (`{ op: 'actor.hold', actor: 'partner-desk', held: true }`), which `multi-tenant`
uses: the outsourced desk has gone quiet, the bundle analyzer keeps running.

- **An operation kind, not a field on `DemoPreset`.** A `holds: [...]` field would have been a second
  mechanism beside the script, with its own replay path on each host and no place in the ordered, named,
  recordable list a preset already is. As a kind it reuses all of it: the same conformance gate, the same
  `extends` composition (a child can release what its base held), and the same two halves. It also
  prepares the next step. Per-actor scenario settings (an actor that fails a given share of its calls,
  say) become more fields on the SAME per-actor world state this slice adds, and more operation kinds
  or arguments over it, rather than another channel.
- **World state is a per-actor map.** Server: `readActorHolds`/`setActorHold` in the fake Simulator state
  (`keel/adapters/fake/simulator`), persisted at `.data/simulator/actor-holds.json`. That directory is
  already a LIVE_DIR, so reset, save and restore cover it with no new code, and a test proves each. Static:
  `actorHolds` in the in-memory world, cleared by `resetWorld` and exposed on `DemoWorld`.
- **The server host asks one question per tick.** The actor frame used to fetch every flag from
  `GET /api/simulator/flags` and pick `actors-held` out. It now calls `GET /api/simulator/actors/held?actor=<id>`,
  which answers `{ held }` for exactly that actor: the world-wide flag OR its own hold. The flags route stays
  (its POST is how the Snapshots tab and the specs flip a flag; its GET, the read-out of every flag, has no
  caller left in this repo, and was kept rather than removed in a slice about something else). The static host computes the same OR in memory
  (`actorsHeld || actorHolds[id]`).
- **The framework still does not value-import the actor registry at runtime.** keel's `actor.hold` `check`
  needs the registered ids, so `PresetWorld` gains `actors`, derived in the seam-conformance suite from the
  seam's `actors` list. That is a value read by a TEST only, but it means `@app-config/actors` is no longer
  type-only: the starter registers `actors = []` and the fixture one actor, `fixture-tug` (ADR-0012
  addendum). Neither host's half validates the id at replay, since neither could without that import; an
  unknown id would write a hold nothing reads, and the gate rejects the preset first.
- **Deferred: an Actors-tab toggle.** A per-actor hold switch in the Snapshots or Actors tab is a natural
  follow-up (it would call a route that writes the same file, and the static twin would set `actorHolds`).
  Not built here: the slice's job was the preset path, and a toggle needs its own copy in both catalogs and
  its own specs.
- **Measured:** the showcase's `dist-demo/index.html` went from 942,766 to 942,996 bytes (+230; budget
  950,000), the starter's from 853,371 to 853,483 (+112).

## Demo presets: final-review fixes before `main` (2026-10-03, `presets-main-sync`)

- **A replay that cannot finish says so, on both hosts.**
    - **Static demo:** an abandoned queue now pushes `noticePresetFailed`, rather than leaving the "World reset" notice over a half-replayed world.
    - **Server:** a refused or failed load shows the same notice and does NOT reload. Reloading would show the reset world, but it would also hand a waiting tour to its resume marker, so the tour could never record the miss. The notice tells the viewer the world is only partly set up and to reset it.
- **The server replay holds the world lock across the reset AND the script** (`resetWorldThen` in `keel/adapters/fake/simulator-admin.ts`). Before, the lock covered only the reset, so a second load arriving mid-script wiped the first one's world under it. A test running two loads at once was seen failing without the lock.
- **A throwing inbound handler twin is filed `failed`**, as the server intake files it, instead of escaping the static replay.
- **The static shell tracks the in-flight load.** The Snapshots tab's "one world rewrite at a time" is now true on the `file://` host too, not only on the server.
- **A tour start that rejects outright is a recorded miss,** never an unhandled rejection that leaves a resume marker for a tour that never began.
- **CLAUDE.md no longer counts the fixture's seam modules.** The number had no stated counting rule: top-level files, `db/` files and `presets/operations/` files each gave a different answer, and it drifted three times in one day. The sentence now says what the fixture registers: every `@app-config/*` module the framework reads.
- **`main`'s role check (`isAssignableRole`) lives in the static `sendInvite`**, the path that mirrors the route, not in the shared `inviteInto`. A preset's invite is held to the same rule at build time, by the `invite` kind's check.

## Demo size budgets re-based, and the starter's is the adopter's (2026-11-16, `demo-size-headroom`)

Requested by an adopter whose ejected app sat at 873,581 of its 880,000-byte budget with one small screen.

- **Prune the demo's CSS instead of raising a budget.** The budget file's rule is that its tightness is
  deliberate, and the growth since 2026-08-01 (+18,787 showcase, +10,061 starter) was mostly the presets, a
  feature. But the most avoidable thing in the artifact was never growth: the dead 15% of it, rules of Mantine's whole stylesheet that no shipped component can match.
  Removing what no shipped component can match is a smaller change in what the artifact IS than raising the
  number 25 KB and calling the next 25 KB a decision. Rejected: per-component CSS imports (a hand-kept list
  whose misses are silent), and trimming only what grew.
- **Budgets went down.** Showcase 950,000 → 840,000, starter 880,000 → 820,000, each below its unpruned
  size, so the savings are not slack and a regression in the pruning is a red gate. The showcase keeps ~3%
  headroom on purpose, as the Tours raise did.
- **The starter's budget is the adopter's, and is sized for them.** An adopter inherits it. A budget kept
  3% over the framework's own size is 3% for their first screens. So the two apps' numbers now have two jobs: the showcase's paces the
  framework (every framework screen and twin is in it, so a framework change costs bytes there first); the
  starter's lets the starter grow to the showcase's size before it asks anything, and still fails on gross
  bloat and on the pruning stopping. Rejected: a gate that
  separates framework baseline from app growth (the bundle has no such attribution, and the adopter wants
  a ceiling, not a ledger); a tight starter budget plus a note (red on their second screen); raising 880,000.
  **JP's call to overrule:** if the starter's number should pace as tightly as the showcase's, set it to ~745,000 (721,386 plus 3%).
- **Prior art, and what changes.** The 2026-10-03 entry "Standard Schema, with Valibot for keel's own kinds"
  measured ~3 KB of valibot in each demo and accepted it (`/* @__PURE__ */` on the schema calls was tried and
  rejected: every app author would repeat it). Building keel's own definitions by function takes keel's share
  out without asking an author anything. An app's own definition still pays ~2.8 KB.
- **The gate warns under 2% headroom** and says what to do, on CI as a workflow annotation. It passes: the
  cue to look while it is cheap. It would have fired through the whole of the presets work.
- **`init-app` should say whose number it is.** `scripts/init-app.ts` is PR B's, so this is the proposed
  wording for its "WHAT THIS DID NOT TOUCH" list, where it names deployment parameters and the cutover
  checklist:

    > • The demo size budget — apps/<slug>/package.json's `check:demo-size` passes the static demo's byte
    > budget. It is yours now: the starter ships it with room to grow to the showcase's size, which is
    > sized for an app's own screens, not for the framework's pace. Re-set it when you want a tighter
    > gate (what your app measures plus the headroom you want, in its own commit). When it goes red,
    > scripts/check-demo-size.mjs says what to look at first.

- **Not done.** An app's own preset operation definition still ships in its demo (~2.8 KB on the showcase);
  fixing it is a seam change for 0.3% of the file, recorded in
  `.claude/future-tasks/resolved/demo-size-budget-headroom-thin.md`. The Next apps still serve the whole
  Mantine stylesheet; nothing gates their page weight.

## Adopter papercuts: the repo name, the identity gate, one-tenant seeds (2026-11-16, `fix/adopter-papercuts`)

Four gaps a first adopter reported, decided together. Each is a small change; the reasons are the part
worth keeping.

- **The repo name is a flag, `--repo`, and a placeholder without it. It is not read from `git remote`.**
  `init-app` wrote the app's slug into the repository position of the advisory and discussions links, which
  is right only when a repo is named after its one app (an app `console` kept in a repo `pages` got
  `…/console/security/advisories/new`, a link that 404s and looks plausible). Rejected: deriving it from
  `origin`. At adoption time that remote is often still the template, or a fork under its default name, so
  the derived value would be plausible and wrong with nothing to flag it, and `--dry-run` would print a
  different plan on each machine. The flag takes the NAME only (not `owner/name`, because the owner also
  fills CODEOWNERS, where it may be a team). Without it the links carry `PLACEHOLDER_GITHUB_REPO` beside
  `PLACEHOLDER_GITHUB_OWNER`, which the closing output names and `git grep` finds. "I forgot the flag" is a
  re-run: `pnpm init-app --repo <name>` alone replaces the placeholder segment in the three files (whatever
  the owner says by then, since filling the owner first is the natural order) and does nothing else; it
  refuses on a tree init-app has not adopted, where it would scrub the identity and nothing else. On links that already
  name a repository a `--repo` is reported as ignored, and the summary and closing text are driven by the
  state the run found in the files, not by the flag, so they never claim a change that did not happen.
- **`tests/docs/adopter-identity.test.ts` classifies its tree before asserting, rather than skipping.** It
  ran `init-app acme --eject-showcase` on a copy of whatever tree it was in and asserted what the rewrite
  produced. In an adopted tree the rewrite has nothing to replace (it replaces the template's literals),
  so the assertions read the adopter's own files and went red on their slug and, once filled in, their
  owner. It was green in the `adoption-probe` job only because that job also adopts as `acme`. The test
  now runs the `init-app` suite only in the pristine template, which it recognises by STRUCTURE
  (`apps/showcase` exists and the root package is still `keel-workspace`; every adopting `init-app` run
  renames the root or deletes the showcase). Everywhere else it checks the real files directly: none may
  name the template's maintainer, which is also the check that catches an upstream merge adding a
  `@jpslav`-owned line to an adopter's CODEOWNERS. In the template all four must name him. The first
  version recognised the template by the identity strings themselves, and review found the hole in that:
  move the maintainer's identity in the four files and nothing else, and every file reads as "adopted", the
  suite switches itself off and `init-app` silently stops scrubbing anything. A sentinel comparing the
  test's constants with `init-app`'s literals was added to patch it, then dropped once the structural
  test made it redundant (and it was red in adopters who scrubbed the script). Exact-spelling matching is
  deliberate: the template's files use one spelling and the rewrite is a literal replace.
  Rejected: skipping on "`apps/showcase` is absent" (the probe's ejected tree has none, so it would switch
  the gate off where it is meant to run), and having `init-app` delete the test (ADR-0013 makes updates a
  merge, so a file deleted in the fork and edited upstream is a modify/delete conflict on every merge).
- **ADR-0004's two-seeded-tenants rule is scoped, by an addendum, with no new gate.** keel's own apps and
  multi-tenant adopters keep two; a one-tenant-per-deployment app may seed one if its RLS proof half still
  uses two tenants. Nothing in the framework reads the seed's tenant count, and the proof runner makes its
  own two tenants per run, so the seed cannot starve a proof. No cheap check says whether an app's proof half
  crosses a tenant boundary (a comment satisfies a presence check, and an app with no tables legitimately has
  an empty half), so it stays a convention, and `/new-entity` and `/new-slice` now say to write the
  table's proof section with both tenants. That convention was not written down anywhere before.
- **`CLAUDE.md` said the authorization scan walks `apps/*/src/app/api`; it walks the whole
  `apps/*/src/app`.** The behaviour was right and stricter than the sentence: a mutating `route.ts` outside
  `api/` is scanned and, since exemption keys are measured from `src/app/api`, can match no exemption.
  Watched failing with a bare `POST` at `src/app/[locale]/danger/route.ts`.

## App-owned vendor adapters (2026-11-16, `feat/app-owned-adapters`)

- **An app may own a port, fake and real adapter, and the vendor zone is `apps/<app>/src/adapters/real/`,
  not the whole adapters directory.** An adopter asked for a lint-allowed `apps/*/src/adapters/`. The
  narrower zone keeps the app's registry and fakes under the same vendor and `process.env` bans as the
  rest of the app, which is what makes them hermetic by construction. ADR-0012's 2026-11-16 addendum has
  the full fence and the rejected alternatives.
- **Declined: a key-value port in keel.** It was offered as the alternative and fails both the
  universality and the new-class tests.
- **The app's real adapters read `process.env`, not imported `params.ts` values.** keel's own real adapters
  already work this way, and secret values cannot live in the repo. `params.ts` keeps recording names,
  placeholders and cutover rows.
- **A static import of an app's `adapters/real` is banned outside the adapters directory, and `import()` is
  not.** The dynamic form inside an `!isSimulated` branch is how keel's own real-mode sign-in form is
  loaded, so banning it would forbid the one legitimate case. Inside the directory it is stricter: the
  registry reaches `real/` only by `import()`, and a fake not at all, statically or dynamically. The
  pre-PR review found the static gap (and the first version's registry test passing vacuously); review
  round 1 found the dynamic one, in that fix.
- **`process.env` is now banned in `apps/*/config/` too.** Nothing there read it, and without the ban it was
  the obvious place for a helper handing the registry its own reading of `APP_MODE` (pre-PR review).
- **The app's registry does not import `server-only` itself.** It takes `isSimulated` from
  `keel/adapters/index`, which imports `server-only`, so the guard arrives transitively. Neither app lists
  `server-only` as a dependency, and knip flagged it as unlisted when a scratch registry imported it
  directly.
- **No lint rule keeps a registry out of the static demo.** The import arrives transitively in practice,
  which lint cannot follow. The measured backstop is `check:demo-size` (54 MB against 880,000 bytes on the
  starter) and then the static e2e.
- **No worked example in the starter or the showcase.** A recipe (`docs/recipes/app-owned-adapter.md`), an
  updated `/new-port` and a lint gate test (`tests/lint/app-owned-adapters.test.ts`) instead. The recipe was
  checked by building a scratch port, fake, real adapter and registry in the starter: typecheck, lint and
  knip passed, and the same files still lint clean under the final config. The scratch files were never
  committed.
- **Recipes that predate this** (`e-sign.md`, `workspace-coder.md`) still put their ports in keel's tree.
  Each now says the app-owned alternative exists. Retargeting them fully is a follow-up
  (`.claude/future-tasks/retarget-vendor-recipes-app-owned.md`).

## Storage port: `copy(from, to)` (2026-11-16, `storage-copy`)

Requested by an app that stages uploads and finalizes them by copying into place. Without a copy it reads
and re-`put`s every file, which in a deployment streams each one through the app's Lambda. It is a generic
primitive (S3 `CopyObject` server-side; a file copy in the fake), so it passes the universality test.

- **The port has no tenant scoping of its own, so `copy` has none.** Keys are full keys the CALLER builds
  server-side (`attachments/<tenantId>/<uuid>/<name>`, `apps/showcase/src/app/api/attachments/route.ts`);
  `put`, `get`, `list` and `delete` never look inside one. `copy(from, to)` takes two keys of the same kind
  and likewise inspects neither: a stage-then-finalize flow builds both from the same tenant. What the
  port DOES guarantee is that a copy never leaves the store: the real adapter's source bucket is always its
  own (`other-bucket/x` is the key `other-bucket/x` of THIS bucket), and the fake resolves both keys inside
  its store directory and refuses an escape in either.
- **A missing source throws `NotFoundError`, where `get` returns `null`.** `get` has a natural "nothing"
  to return; `copy` has none, and a silent no-op would let a finalize step carry on and report success for
  a file that was never put in place. Both adapters throw it; the real one maps only S3's `NoSuchKey` to it (a
  missing bucket is a misconfiguration and is not reported as a missing object).
- **An existing destination is overwritten**, as `put` does and as S3's `CopyObject` does, so a retried
  finalize converges. `copy` does not delete the source; "move" is `copy` then `delete`, and there is no
  `move` method because S3 has no atomic move and a method of that name would hide the gap between the two.
- **`from === to` is refused on both**, before any request on the real adapter: a copy onto itself changes
  nothing, and is nearly always two keys built the same way by mistake. (The fake compares resolved paths, so
  `a/../a` is the same key there; S3 would see two keys. That is the fake's existing quirk for every method.)
- **The real adapter encodes `CopySource` per path segment**, with `encodeURIComponent` on each and the
  slashes left alone, and sends `MetadataDirective: 'COPY'` so the content type and user metadata carry
  over. The SDK does not encode `CopySource`; `encodeURI` leaves `+`, `?` and `#` alone, and encoding the whole
  key turns every `/` into `%2F`. The test asserts the exact input for a space, a `+`, non-ASCII, `?`, `%`,
  `#`, `&`, `;` and empty segments.
- **Over 5 GB it fails with a clear error; multipart copy is not implemented.** AWS's CopyObject reference
  gives 5 GB for one call and `UploadPartCopy` above it. A multipart copy (parts, plus carrying the content
  type and metadata by hand and aborting on failure) is a real feature with its own failure modes. The port's
  upload ceiling, `UploadConstraints.maxBytes`, is the app's own, so an app that accepts uploads above 5 GB
  cannot copy them with this method and should keep `maxBytes` below it. The error is mapped from S3's
  wording, which has not been seen from a real bucket (the cutover row says how to prove it).
- **The fake stages both copies, then publishes.** Each file is copied to a temp name beside its destination;
  only when both exist whole are they renamed in, the sidecar first and the body last, so a key exists (to
  `get` and `list`) only once complete and with its content type in place, and a failure or a source deleted
  mid-copy leaves nothing behind. A directory is not an object, so it is a missing source.
  Known gaps, all of the fake: over an existing destination the content type changes a moment before the
  bytes; a body that cannot be published after its sidecar was (a destination that is an existing directory)
  leaves a stray sidecar, invisible to `get` and `list`; and a source rewritten while it is copied can pair
  one version's bytes with another's content type, where S3 snapshots an object. `put` has the same gap
  between its own two files, and this is a fake.
- **No static-demo twin:** the static demo implements no storage port, so there is nothing to mirror. **No
  IAM change:** the app role's `grantReadWrite` already covers `s3:GetObject*` on the source and `s3:PutObject`
  on the destination, plus the `s3:List*` that (per AWS's GetObject reference) makes a missing key a 404 and not
  a 403. Cutover row
  `storage-copy` carries what only a real bucket can prove.
- **How an app calls it** (stage, then finalize):

    ```ts
    // at finalize, with both keys built server-side from the same tenant:
    await storage.copy(stagedKey, finalKey) // NotFoundError if the staged file is gone
    await storage.delete([stagedKey]) // idempotent, so a retry after this line is harmless
    ```

    A retry after a finalize that failed between the two calls re-copies over `finalKey` and converges; a retry
    after both succeeded gets `NotFoundError` from `copy` (the staged file is gone), which the caller reads as
    "already finalized" by checking `finalKey` exists.

## `init-app` says the demo size budget is the adopter's (2026-11-16, `fix/init-app-demo-budget`)

- **"WHAT THIS DID NOT TOUCH" gains a bullet, after the cutover checklist.** It is the line the demo-size
  headroom work proposed (`.claude/future-tasks/resolved/demo-size-budget-headroom-thin.md`), built from the
  survivor's own `check:demo-size` script instead of fixed text, because what is true depends on it. The
  starter passes a number, which is stated back as read from `package.json`; a survivor that passes none
  (a renamed showcase) is told `DEFAULT_BUDGET_BYTES` is its budget and that it is thin on purpose; an app
  without the script, or whose script is neither of those two shapes (a number then more shell, a quoted or
  underscored number the script would reject), gets no bullet rather than a wrong one. `<slug>` is the survivor's directory name, as everywhere else in that
  list. The "roomy on purpose" wording is only used where a number is passed, since that is the starter's.
  The proposal's "room to grow to the showcase's size" is dropped: after an eject there is no showcase to
  measure against.
- **A note, not a rewrite, for `scripts/check-demo-size.mjs` after an eject.** Its header is two apps'
  history plus a measurements table, and `DEFAULT_BUDGET_BYTES` (the showcase's) goes unused by a survivor
  that passes its own number. `ejectShowcase` used to rewrite one phrase there ("the showcase's size" to "the reference
  app's size"), which left line 2 saying the reference app measures 814660 bytes, a number nothing in an
  ejected tree has. That rewrite is removed and the script is left exactly as the template has it. Rewriting
  any of it is the false-sentence trap `.claude/future-tasks/eject-rewrites-prose-into-false-sentences.md`
  describes, so the bullet says the header and the default describe the showcase you removed and only the
  number you pass counts. The sentence appears only when the showcase is gone.
- **Pinned in `tests/docs/adopter-identity.test.ts`.** The number is read back from the probe's own
  `package.json`, so a change to the starter's script fails the test rather than leaving the output wrong; the
  removal sentence is checked present after an eject and absent after a rename; the script must still carry
  `DEFAULT_BUDGET_BYTES` and `WHEN IT GOES RED`; the no-number branch is reached by a `--dry-run` rename
  of the showcase; a script that is neither shape gets no bullet; and a renamed showcase counts as still
  there on a dry run and a real one alike. Each was watched failing against a deliberate break.

## Catching up October's minor-and-patch group (2026-11-16, `deps/catch-up-2026-11`)

- **keel's peer floors move with the apps' floors.** Dependabot's group PR (#30) raised `next`,
  `next-intl`, `react` and `@mantine/core` in the root and both apps but left `packages/keel`'s
  `peerDependencies` at the old floors. Before it, each of the four peer floors was the floor the apps
  named. Leaving keel's lower is what kept the old `next-intl` and `@mantine/core` in keel's part of the
  lockfile (build-notes, same date, has the mechanism). keel's peer ranges now match the apps' again:
  `^16.4.6`, `^4.14.9` and `^9.7.3`, and `react` at `~19.2.8` for the hold below. A lower floor would
  mean something only to a consumer installing keel from a registry with an older host, and nobody does:
  `packages/keel` is `private` and ships by fork and merge (ADR-0013).
- **next 16.4.6, not the group's 16.4.2.** GHSA-mfr8-8qww-v76h (medium, published 2026-11-16) covers next
  16.3.0 through 16.4.4 and is fixed in 16.4.5. keel calls neither `'use cache'` nor `unstable_cache`, so
  its code was not exposed, but 16.4.2 is the version `next dev` stopped on (build-notes). 16.4.6 is the
  newest 16.4 patch and was published on 2026-11-09, past the two-day `minimumReleaseAge`.
  `@next/eslint-plugin-next` moves with it.
- **`@axe-core/playwright` is held at `~4.12.1`.** The group took it to 4.14.0, whose `axe-core` turns
  on `label-content-name-mismatch` by default. Twelve showcase e2e tests then failed on that one rule,
  on four framework controls whose `aria-label` replaces their visible text. The finding is real (WCAG
  2.5.3, Level A), but fixing it means choosing new accessible names in two locales, which is a11y design
  work rather than part of a dependency catch-up. The tilde keeps the hold through a lockfile
  regeneration: with 4.14.0 already in the lockfile, `^4.12.1` resolved to 4.14.0. The fix and the way to
  lift the hold are in `.claude/future-tasks/resolved/label-in-name-axe-4-14.md`.
- **`react`, `react-dom` and their types are held at 19.2 (`~19.2.8`, `~19.2.17`, `~19.2.3`).** The group
  took React to 19.3.1, which put the showcase's static demo at 845,719 bytes, over the 840,000 budget
  re-based the same day (starter 755,326 of 820,000). With only `react` and `react-dom` pinned back to
  19.2.8, the showcase built at 816,387 and the starter at 725,995: React was about 29 KB of the
  showcase's ~31 KB growth. It is React's own code, not something keel can trim: react-dom's
  `cjs/react-dom-client.production.js` is 536,016 bytes in 19.2.8 and 625,168 in 19.3.1. Taking it means
  raising the showcase budget, which the budget's own rule reserves for a feature
  (`scripts/check-demo-size.mjs`, "WHEN IT GOES RED"), so that is JP's call.
  Until then the tildes keep 19.2 through a lockfile regeneration. keel's `react` peer is `~19.2.8` too,
  the same range the apps name. Holding React back took one more lockfile regeneration (build-notes,
  same date).
- **Next's generated `AGENTS.md` is switched off (`agentRules: false` in both apps' `next.config.ts`).**
  With next 16.4, `next dev` writes `apps/<app>/AGENTS.md` whenever it detects an AI coding agent, and
  the block it writes tells the agent to commit the file. CI is not an agent and never sees it, but every
  agent's `pnpm verify` starts `next dev` for e2e, so the file appeared untracked in agent worktrees, one
  add-everything commit away from landing in a PR. keel's agent guide is the root `CLAUDE.md`, so a
  second, generated one in each app is not wanted. The Next docs the block pointed to still ship with the
  installed version, under `node_modules/next/dist/docs/` (resolved from an app directory). The manager
  session that ran this catch-up decided this on JP's behalf; JP can overrule it when approving the PR.
- **Next's upgrade advisor is switched off (`experimental.agentUpgrade: false` in both apps).** next 16.4
  added it with the default `'security'`: every `next dev` outside CI queries npm's advisory feed, as does
  `next build` when an agent runs it or the CLI can prompt at a terminal, and an agent's run stops when an
  advisory matches (build-notes, same date). The CLAUDE.md hard rule that `pnpm dev` makes no network calls
  decides this, so it is not a new choice. It does not make `pnpm dev` offline: the dev overlay's version
  check, which next 16.2 already had, still fetches `next`'s dist-tags. Advisories now have to reach keel
  another way, through Dependabot security updates (currently off in the repository settings) or review.

## Lint fences cover every extension; carve-outs name what their runner loads (2026-11-16, `fix/lint-fence-gaps`)

- **Fence globs take their extensions from one constant, `SRC_EXT`.** They named `{ts,tsx}`, so a `.mjs`
  file in `apps/*/src`, `packages/keel/src` or keel's test fixture got past the vendor, `process.env` and
  `getDb` bans. `SRC_EXT` lists all eight extensions ESLint lints here, `.mts` and `.cts` included.
- **Carve-outs do NOT use `SRC_EXT`.** A test carve-out names what vitest runs (`*.test.{ts,tsx}`), the story
  carve-out what Ladle loads, the `next.config` carve-out the four names Next reads, the instrumentation one
  Next's default `pageExtensions`. Widening each to every extension was the alternative. It was rejected
  because a `.test.mjs` that vitest never runs is an ordinary module a route can import.
- **The app's registry stays `adapters/index.ts` by name.** An `index.mjs` beside it is one more module
  that may not load `real/`. Widening the registry exemption across extensions was the alternative. It was
  rejected because the recipe names one file, and a second registry-shaped file is the thing to catch.
- **Selectors that implement one rule travel as one array** (`getDbSelectors`, `runModeEnvSelectors`),
  replacing re-listing them one by one. Re-listing is what let the a11y block drop the computed `getDb` form.
- **Tests under an app's adapters directory stay exempt from the dynamic `real/` ban**, as they are from
  the other syntax bans there. A story beside a fake was given it back, since the static form was already
  banned in stories.

## The RDS Data API transport (2026-11-16, `feat/rds-data-api-dialect`)

- **JP decided, 2026-11-16: it lives in keel, as an opt-in.** Tenant isolation through any transport is
  keel's to prove. So the transport sits beside the `pg` one in `packages/keel/src/adapters/real/`. `pg`
  stays the default, and the Data API is chosen per deployment.
- **The switch is `DATABASE_TRANSPORT=pg|data-api`.** Each app records it as `params.database.transport`
  in its `config/params.ts`. It is never inferred from which variables are set, and an unknown value
  throws. `DATABASE_URL` left `REQUIRED_ENV`: each transport's variables come from `DATABASE_ENV`
  (`packages/keel/src/adapters/real/database-transport.ts`), so only on `data-api` do its three replace it.
  "Transport" rather than "driver": both paths are Kysely over Postgres, and what differs is how the SQL
  travels.
- **Loaded only when chosen.** `db-data-api.ts` is reached by dynamic import alone, so a `pg` deployment
  never loads the RDS Data SDK. `packages/keel/src/adapters/real/index.test.ts` proves it by watching the
  module loads. A static import of the module was watched turning it red, whichever test runs first.
- **`withTenant` sets the role and the tenant in one statement**, with `set_config('role', 'app_user', true)`
  beside the tenant's `set_config` (ADR-0004 addendum). On the Data API, every statement is an HTTPS call.
- **Hand-written, not `kysely-data-api`.** That package peers on `kysely ^0.27`, sends parameters untyped
  and turns `date` into a `Date`. ADR-0002 hand-rolled the pglite dialect for the same kind of reason.
- **Parameters are typed by PREPARE, not by guessing.** Guessing a `UUID` type hint from the value breaks
  `set_config`'s text argument as soon as a tenant id is passed to it. Postgres's own inference, read back
  once per SQL shape, gives node-postgres's semantics exactly. Rejected as well: inlining escaped literals.
  It would be safe if escaped correctly, but ADR-0004 keeps the tenant id a real parameter on purpose.
- **SDK retries off (`maxAttempts: 1`); resume retried by hand.** AWS warns that retrying a statement
  whose call timed out can write twice. A paused Serverless v2's `DatabaseResumingException` means the
  request never ran, so the dialect retries that one alone, for about 15 seconds.
- **Errors carry `code` and `constraint`.** They are read from a stated SQLSTATE when the Data API gives
  one, and otherwise from Postgres's wording. Reports differ on whether the Data API includes the
  SQLSTATE, and the showcase's ticket-reference retry keys on `23505`.
- **Proven through a strict emulator; the live proof is deferred.** `pnpm test:contract` runs the
  migrations, the full RLS suite and a pg-parity battery through the dialect against
  `packages/keel/src/adapters/real/rds-data-emulator.ts`. The live check is `docs/runbooks/data-api.md`,
  for the `data-api` cutover row. The community `local-data-api` emulator was rejected: it binds untyped
  strings as `unknown`, so it passes exactly the queries Aurora rejects.
- **The migrator runs all pending migrations in one Data API transaction**, as it does on `pg`. That
  transaction opens with `pg_advisory_xact_lock` on Kysely's lock id. Kysely's own session-level lock
  would be dropped by the connection reset, and Kysely creates its tables before locking at all. A
  single statement over 45 seconds, or a run over an hour, fails loudly. A migration that cannot fit runs
  on the `pg` transport from inside the VPC. The pre-PR review found the lock gap. A race test of two
  migrators on an empty database, which first failed on Kysely's create-before-lock, proves the fix.
- **The emulator lives in `packages/keel/src/adapters/real/`, not in `test-fixture/`.** It needs `pg` and
  the RDS Data SDK, which only an adapters directory may import. Test-only modules in `src/` have
  precedent in `rls-proof-runner.ts`. Nothing in an app or a deployment imports it, and knip would report
  it if nothing did.
- **Review rounds 1 and 2 (Opus) found the same shape twice, so it was swept rather than run a third time.**
  An explicit CAST truncates or pads where node-postgres's untyped parameter is refused: first
  `char(n)`/`bit(n)`, whose inferred type printed as `character`/`bit` (length 1), then domains over
  `char`/`varchar`/`bit`. The sweep found the divergence only in length-bearing types: inferred base types
  carry no length, and a domain is the only other way a length reaches the cast. So the dialect now walks
  each domain down to its base type and prints it with `format_type(…, -1)`. The parity battery covers
  `char(3)`, `bit(4)`, `char(3)[]` and two domains, and a too-long domain value is refused on both
  transports.
- **The same rounds found two transaction-state bugs, both fixed and pinned.** A transaction Postgres had
  aborted (a caught statement error) was reported as committed; it now throws Kysely's
  `AbortedTransactionError`, as the `pg` driver does. And a raw `ROLLBACK TO SAVEPOINT`, the recovery
  available inside `withTenant`, did not count as recovery.
- **Declined: invalidating the type cache.** A statement that fails inside a transaction has already
  aborted it, so a retry with fresh types could only help outside one. It is an accepted limit (ADR-0002
  addendum): deploys replace processes.
- **Round 2's fixes were reviewed as a diff, not by a third general round** (Opus): its findings were one
  more instance of round 1's shape, now swept, and one defect in round 1's fix. The diff review found
  nothing at MEDIUM. Fixed from its LOWs: EXPLAIN is recognised after a comment, as `ANALYSE`, and before
  a parenthesised statement; a contract test now runs a parameterised EXPLAIN through the dialect, which
  nothing did; and the too-long-value test asserts each refusal's reason, not merely that something
  failed. Accepted as limits (ADR-0002 addendum): an explicit `::domain` cast in the SQL, and a colon
  before a column name, as in `a[lo:hi]`.
- **An independent cold review (2026-11-17, on a different model) found no tenant-isolation or injection
  defect.** The manager decided on every finding, and all were made:
    - A leading `;` hid COMMIT from the guard, and a statement after a `;` was never looked at, so `;commit`
      inside `withTenant` ended the tenant's transaction. Now one scanner (`sqlSegments`) says where code
      is, for the dialect and the emulator alike. A multistatement is refused before calling, and the
      emulator refuses one as AWS does, before running any of it.
    - The emulator's own colon scanner was weaker than the dialect's (E-strings, nested comments). It now
      uses the dialect's.
    - Parameter types expire after five minutes. Within them a type change is silent; ADR-0002 says so.
    - A commit counts only when CommitTransaction answers "Transaction Committed".
    - The runbook now proves migrations through the Data API on an empty database, sends statements on
      ended transaction ids, and asks whether AWS accepts 0001's `DO` block. If it does not, 0001 changes;
      that is written down, not built.
    - The 1 MiB response cap meeting a page of unbounded text is an accepted limit.

## The Data API network shape in the infra draft (2026-11-16, `feat/rds-data-api-infra`)

- **The stack takes `params.database.transport`, passed in by `infra/app.ts`.** It does not read its own
  CDK context. One value decides both what the app's runtime does and what network it gets, so the two
  cannot disagree. It is a prop rather than an import inside the stack so that `infra/check-shapes.ts`
  can build both shapes.
- **On `data-api`, the VPC still exists, but holds only the database.** The subnets are isolated, with
  no NAT gateway and no internet gateway. A cluster has to live in a VPC. Nothing else in the stack needs
  a route out of one once the Lambdas run outside it.
- **The `pg` shape stays the default.** The Data API transport is proven only through its emulator until
  its cutover row closes, and a socket is faster per statement. Its limits (45 seconds per call, 1 MiB
  per response, an hour per transaction) are the app's limits on that shape.
- **CDK's `grantDataApiAccess`, not a hand-written policy.** It grants exactly the five `rds-data`
  actions on the cluster's ARN, plus read on its secret, as the synthesized `data-api` shape shows.
  `BatchExecuteStatement` is among them although the dialect never sends it; it allows nothing that
  `ExecuteStatement` does not. The `data-api-access` cutover row checks the deployed policy, and that a
  role without it is refused.
- **Both shapes are checked by a gate.** `pnpm --filter infra synth`, which CI runs, now also runs
  `infra/check-shapes.ts`. It found what review found missing: nothing built the `data-api` shape, and
  nothing tied its environment to `DATABASE_ENV` in `packages/keel/src/adapters/real/database-transport.ts`.
  knip needs no entry for it: it reads the `synth` script.
- **The gate checks the way in, not only the wiring** (the independent cold review, 2026-11-17). It passed
  with `secretsmanager:GetSecretValue` on `*` and the database port open to `0.0.0.0/0`. Now every
  Secrets Manager grant must name the cluster's own secret alone, on both shapes; every `rds-data` grant
  must name this cluster alone; and on `data-api` the database's security group must admit nothing. The
  grants are read from every IAM policy, managed policy and role's inline policy in the stack, after the
  mechanical re-check showed a second stack secret, a managed policy and an inline policy slipping past an
  earlier version. The review's re-check then showed `Action: "*"` on `Resource: "*"` passing, because
  statements were picked by the text `rds-data:` or `secretsmanager:`. Now a statement counts if it can
  grant the service at all: a wildcard action that reaches it, or any `NotAction`. Since the contents of an
  AWS-managed policy cannot be read from the template, a role may attach only the two Lambda execution
  policies. Each check was seen red by a mutation of the stack.

## Security patches the October group did not cover (2026-11-17, `deps/security-patches-2026-11`)

- **Three packages raised past their advisories, staying on their current majors.** `@sentry/nextjs`
  `^10.75.2` (resolves 10.78.0) clears GHSA-mchm-gjx6-7h55, a critical middleware bypass through the
  tunnel route. keel configures no `tunnelRoute`, but the version is raised anyway rather than relying on
  that. `vitest` and `@vitest/coverage-v8` `^4.1.12` (resolve 4.1.12) clear GHSA-82fw-gwwq-j7x9 (fixed in
  4.1.11) and two `@vitest/mocker` advisories fixed only in 4.1.12, GHSA-qxg6-89mg-rqv8 and
  GHSA-xp26-3454-mjgp. Review caught that the first floor, `^4.1.11`, still admitted both.
  `happy-dom` `^21.0.4` clears GHSA-5fpq-26gf-qwcr, GHSA-c8p4-j97h-3vg8 and GHSA-834v-8h66-3h79. The
  last two have no fix on 20.x, so this is a major bump. 21.0.0's one breaking change turns off CSS-file
  and iframe loading by default, its fix for the SSRF; no keel test configures happy-dom or loads either.
  GitHub's advisory database lists nothing against any of the four resolved versions. Not taken: Sentry 11
  and vitest 5 (new majors, no advisory requiring them).
- **`withSentryConfig` stays imported from `@sentry/nextjs`.** Since 10.73.0 Sentry also exports it from
  `@sentry/nextjs/config`, its v11 path, and calling the old export logs a deprecation warning once.
  `apps/showcase/next.config.ts` imports it on every `next dev` and build, but calls it only when a DSN is
  set (cutover row `errors`), so no run here prints the warning. Moving it belongs with the Sentry 11
  upgrade.

## `authorize()` judges actors that are not sessions (2026-11-16, `feat/authorize-non-session-actors`)

The design is in the ADR-0012 addendum of the same date. The port method is in ADR-0003's. These are
the calls the work made that no plan anticipated.

- **The requester's evidence.** The sharing site's console (`safeinsights/pages`) names its callers in
  `apps/console/src/domain/pages/callers.ts`: a session, a CLI's API token, and later CI's GitHub OIDC
  token. On its `main`, read before the requester's shape arrived, `sessionUser(ctx)` throws
  `AuthRequiredError` for anything but a session. The worker on its token branch then reported the
  design of record, relayed by the keel manager; that branch was not read here. The token is PERSONAL: it acts as the publisher who approved it, its console role is
  resolved afresh on every call, removing the publisher stops it at once, and it never wields
  `manageAll`. Its stand-in actor is an `AuthUser` with placeholder role and locale. Its audit rows read
  exactly like browser ones. CI is a principal of its own.
- **The machine design was built first, and the person kind came after.** The first cut gave keel
  machine actors only, for keel's own service keys and for CI. The requester's answer showed that the
  caller it has NOW is a person holding a token, which a roleless machine cannot express. Both kinds
  shipped in one PR. They share the `Actor` union, the `Credential` vocabulary, the `authorize`
  overload, the audit columns and one addendum, so a split would have landed the overload with half its
  union and rewritten the same functions in the second PR. The commits are separate: machine actors,
  then the person kind.
- **The person's standing is read by keel, through the auth port, on every call.**
  `abilityActorFromCredential` takes no role at all, so "never cache a role in the token" is a property
  of the function's signature rather than a convention. `listMembers` could not supply it, because
  `restricted` is not on `Membership`, so the port gained `getMember` (ADR-0003 addendum). Inbound email
  had guessed `restricted` from the role; it now uses the same rule a session does (`isRestricted`).
- **`manageAll` is a STATED session's alone, enforced in `defineAbilitiesFor`.** It is not left to
  whoever builds the actor. A token's owner acting in the operator org is an ordinary member there. The
  first version read a missing credential as a session, so a hand-built actor that left the field out
  and set `manageAll` from the org would still have wielded it. The pre-PR review caught that, and a
  missing credential now means "not stated".
- **Credential kinds are composed, not closed.** `PersonCredentialKind` and `MachineCredentialKind`
  each add the app's kinds from the abilities seam, as subjects and audit verbs already do. The
  console's one-time `cli-login` kind is app vocabulary; keel never edits a base union for it.
- **Narrowing by kind, not per-credential scopes.** The console's narrowing ("publisher administration
  takes a browser session") is by credential KIND, and the app's rules can see the kind. That makes
  per-credential scopes (option b of the fork sent to JP) unnecessary for now. The place where a
  per-credential cap would intersect `can()` is marked in `defineAbilitiesFor`, and nothing is built
  there.
- **Machines get a separate rule function, not a role.** Giving a machine a role and passing it to
  `appAbilityRules` fails open: both apps' person rules let any member who is not restricted author the app's own subjects (the showcase's tickets and attachments, the starter's items). `appMachineAbilityRules` with a `return false` default fails closed. It is also one new
  export for an adopter, not a changed signature.
- **The framework's one machine grant names a credential kind.** Job `read`/`update` in the caller's
  own org goes to `service-key` only. `machineActor` refuses that kind, keel's person kinds and
  `system`, so an app's machine cannot pass for any of them.
- **The audit columns are nullable, and NULL means "not recorded".** Rows before 0014, `system:*`
  writers, and session routes that don't yet pass a credential all record NULL. A NOT NULL default
  would have had to claim a kind for rows nobody can vouch for. The session routes are left as they were.
  Making them record `session` would touch every audited route in the showcase, in a PR about callers
  that are not sessions.
- **An overload, not a migration.** `authorize(actor, action, subject)` sits beside the four-argument
  session form. Changing the 19 existing calls (16 in the showcase, one in the starter, two fixture
  routes) and their tests would have been mechanical here, but every adopter's routes would have
  changed too (the console has nine calls), and the four-argument form is still the right shorthand
  for a session.
- **`kind` and `credential` are optional on the person actor.** Requiring them would have broken every
  `AbilityActor` literal: the preset checks, both static demos and every adopter's tests. A literal with
  no credential keeps the person rules but neither wields `manageAll` nor records a credential. The
  three literals in this repo that stand for a session (both static shells and the ticket-assign
  preset check) now say so.
- **The seam's machine rules are bound at call time.** `defineAbilitiesFor` assigns
  `appMachineAbilityRules` to `MachineAbilityRules` inside the function, not at module load. That lets
  the empty registration take no parameters, and a seam module that later value-imports
  `keel/core/abilities` cannot hit the binding before it is initialized.
- **The `service/` exemption is retired, and the scan says what to do instead.** Once a service route
  can authorize, an exemption that says it need not is a second way through the gate. The scan's
  failure message names the three non-session constructors, so an adopter whose old service route goes
  red learns the fix from the failure itself.
- **Token storage stays in the app.** keel owns what `authorize()` needs, and the token itself is the
  app's for now: `.claude/future-tasks/personal-api-tokens.md` records the console's shape for when keel
  takes it.
- **The migrator runs unordered, so a framework migration can reach an existing database.** The first
  run of the full gate after 0014 failed the starter's e2e. Its local world had run `1001_items`, and
  Kysely's strict ordering refused a new migration that sorts before it. The alternatives were worse.
  Wiping `.data` fixes a laptop, not a deployment. Numbering framework migrations above the app's range
  breaks the "framework first" order for a fresh database. `allowUnorderedMigrations: true` keeps
  name order for pending migrations and keeps the missing-migration check.
- **Unordered migration needed a rule and a gate.** Strict ordering had also been what refused an app
  migration numbered into 0001–0999, and an unordered framework migration that sweeps the catalog
  (`GRANT … ON ALL TABLES`) would leave an upgraded database different from a fresh one. Both are now
  `packages/keel/src/db/migrate.test.ts`, a seam-conformance test run against the fixture and each app.
  It checks the numbering, and it compares an upgraded schema with a fresh one. Both checks were seen
  failing.
- **Kept as built, after review:**
    - `abilityActorFromCredential` takes `org: { id, slug }` rather than resolving one from the other.
      The auth port names orgs by slug, as Clerk does, and resolving inside would couple `authz` to the
      database. The docstring now requires both from one organizations row.
    - `machineActor` is kept although only keel's own tests call it. Its consumer is the first adopter's
      planned CI identity, and its run-time checks are what a hand-written `MachineActor` would lack.
- **What three review rounds changed** (a pre-PR review and two code rounds, all on Opus):
    - `service/` routes still need their verifying wrapper (`REQUIRED_ALONGSIDE`). Without it,
      retiring the exemption had let a request-built machine literal pass the scan.
    - Restriction has one rule, `isRestricted(flag, role)`, in both adapters. This changes real-mode
      sessions.
    - The credential-kind check runs in both directions and refuses `string`.
    - The migrator refuses an out-of-order migration within its own sequence and keeps Kysely's "is
      missing" error. `schemaOf` now covers RLS flags, constraints, triggers, functions and column grants.
    - The intake's system rows record no credential.
    - The real `getMember` matches the membership by user and returns null for an unknown org.
- **Declined after review, with reasons:**
    - A lint ban on hand-built `kind: 'machine'` literals: keel never guarded against a route building
      an `AuthUser` either, and the fixture builds actors by hand on purpose.
    - Requiring `authorize(ctx.actor…)` by name under `service/`: brittle, and bypassable by renaming.
    - An advisory lock around the migration preflight: two releases migrating one database at the same
      moment is outside keel's deploy model.
- **JP decided the fork (2026-11-16, via the keel manager).** A machine's powers come from the app's
  abilities seam, through a deny-by-default `appMachineAbilityRules`, and per-token scopes are not built.
  The place for a later per-credential cap stays marked in `defineAbilitiesFor`, and retiring the
  `service/` exemption stands.
- **An independent review, decided by the keel manager.** A cold review by a different model, at
  `833638a`, found three MEDIUMs:
    - The upgrade test's "old" database could not hold an app migration that builds on the newest framework
      one. Fixed by building it one migration at a time.
    - A banned user kept their standing. They now have none, and `locked` deliberately still does.
    - A possibly-true `manageAll` without a session failed closed silently. It is now a type error.
- **The administrative subjects are a manager decision, the conservative one, and JP was told.** They are
  Membership, Org and WebhookEndpoint, and non-read actions on them take a stated session. An app widens
  one subject at a time through `nonSessionAdministration`.
- **Also from that review:**
    - the inbound handler now reports its credential instead of the intake inferring it;
    - `isRestricted` is used at every remaining literal;
    - malformed actors are denied;
    - an org's id and slug come from one row (`orgIdentityForSlug`);
    - the numbering test no longer requires an app migration, and the four-digit rule is in
      `docs/adopting.md`;
    - one ADR sentence about un-forced RLS was corrected in place, since the addendum is today's.
- **The independent re-check found one regression of this PR's own (N1), and the manager made three more
  calls.** N1: the validated actor was read through its prototype, but the judged one was `{ ...actor }`,
  so a restricted admin built as a class with getters, or with `Object.create`, could author. The person
  is now copied field by field by name, that copy is validated, and only it is judged. Seen failing
  first. The three calls below are the MANAGER's, recorded as such and open to JP:
    - Accepting terms (AgreementAcceptance `create`) takes a stated session. It is a legal act a person makes
      in a browser, so it joins the session-only subjects, and the app hook may widen it.
    - `nonSessionAdministration` may not widen to `inbound-email`, by type (`WidenableCredentialKind`) or
      at run time. An email's From line is the weakest credential keel has.
    - `OrgIdentity` is branded: `orgIdentityForSlug` is its only producer, and tests cast deliberately. The
      inbound intake now gets `ctx.org` through it, at the cost of one more indexed read per email.

## Nothing an upstream merge brings should need the adopter to edit keel's files (2026-11-16, `fix/adopter-merge-friction`)

Two reports from the first adopter's second upstream merge, one bug class: keel depending on, or telling an
adopter to edit, something a later merge (ADR-0013) will change. `init-app` runs once; a merge happens every
update.

- **A doc citing the reference apps no longer turns an adopter's path gate red.** Reproduced first: a tree
  adopted from the commit before the app-owned-adapters work, then given that work's new docs verbatim as a
  merge would, failed `doc-paths.test.ts` on `docs/recipes/app-owned-adapter.md:167`
  (`apps/starter/src/app/[locale]/signin/page.tsx`). `resolves` in `tests/docs/doc-set.ts` now treats a
  citation under `apps/showcase/` or `apps/starter/` as keel's whenever that app is not in the tree, and checks
  it like any other wherever the app exists. "In the tree" is the app's `package.json`, not its directory: review
  found that a merge brings back any new file upstream adds under `apps/showcase/` even after the adopter
  deleted the app, and a directory holding one stray file had switched the rule off. The template stays strict (a broken one fails, watched
  failing), a rename-only tree is strict about the showcase it kept, and the adopter's own app and
  `packages/keel` are strict everywhere. Rejected: asking every doc to cite `apps/<app>/…` (it depends on
  each future author, and the live docs hold 159 citations of the showcase in 46 files and 46 of the
  starter in 17 (counted 2026-11-17), most of them pointing at keel's worked examples and not at the reader's own app), and a rule in the
  test alone (`init-app` asks `resolves` which citations are gone before it generalizes them, so the rule
  lives where both read it). The list is closed at two names: `init-app` reserves `showcase`, and an adopter
  who keeps the name `starter` has the directory, so their own citations of it are still checked.
- **keel's demo size script holds no number and no history.** Its header told an adopter to record every
  budget change in it, and its default was the showcase's number, so changing either meant editing a file
  upstream also edits. The budget is now a required argument from each app's `package.json` (the showcase
  passes `840000` explicitly). The starter's history moved, split per app and lightly reworded (every number
  checked), into `apps/starter/DEMO-SIZE.md` beside its number, and the script's header is generic. That file
  keeps the adopter's "Changes" section above keel's history, so a later upstream addition to the history and
  an adopter's own entries sit in different regions. The showcase's history is in this log, below, and NOT in a
  file in `apps/showcase/`: an adopter deletes that app, and review showed a file keel adds there afterwards
  comes back on the next merge (and two same-named new files in both app directories make git refuse to map
  them for an adopter who ejected and renamed). Rejected: a comment in `package.json` (JSON has none), and a
  `DEMO-SIZE.md` for the showcase. `init-app`'s bullet from the previous change lost its no-number branch and
  its "the header still describes the showcase" sentence, since neither is true any more, and points at
  `DEMO-SIZE.md` only when the app has one.
- **The sweep for other instructions of this kind** fixed the one that was plainly wrong (`docs/adopting.md`
  told adopters to promote a keel module "by adding one line" to `packages/keel/package.json`, which ADR-0013
  says never to carry in a fork). The rest each need a decision and are in
  `.claude/future-tasks/adopter-instructions-edit-keel-owned-files.md`, including the largest: `init-app`'s
  day-one rewrite of about 60 docs, which is a conflict waiting at every later upstream edit.

## The showcase's demo size budget history, moved out of `scripts/check-demo-size.mjs` (2026-11-16, `fix/adopter-merge-friction`)

This was the HISTORY section of that script's header, and the showcase has no `DEMO-SIZE.md` of its own: an
adopter deletes the showcase, and a file keel adds under `apps/showcase/` after that comes back on the next
merge. The starter's history is in `apps/starter/DEMO-SIZE.md`, where an adopter inherits it. Moved, split per
app, lightly reworded; every number was checked against the original.

What the number is for: the showcase's budget is the framework's pace-setter: about 3% over what it measures, deliberately thin, so that
growth is a decision someone makes on purpose. Every framework screen and twin is in the showcase, so a
framework change that costs bytes costs them here first.

**Raised 2026-11-17, 840000 → 860000, for React 19.3** (`deps/react-19-3`)

JP's call: take React 19.3 and raise the budget to fit it, which lifts the 2026-11-16 hold ("Catching up
October's minor-and-patch group"). The growth is React's own code, not something to trim: the demo grew 29332
bytes, 804574 on main (React 19.2.8, after Panda 2) to 833906 (19.3.1), with one copy of React in the bundle
(every version marker in the file reads 19.3.1, as many as main's read 19.2.8). The starter grew by 29331, so
none of it is the showcase's. The new number keeps the rule above, about 3% over what it measures: 860000
leaves 26094 bytes (3.0%). It sits below the unpruned demo (984317 bytes with `pruneMantineCss()` taken out of
`vite.demo.config.ts`, which exits 1), so a pruning that stops still turns it red. The full entry is
"React 19.3, with the demo budgets raised" (2026-11-17), below.

**Re-based 2026-11-16, 950000 → 840000**

Since the first commit (925623 bytes) the demo had grown 18787 bytes, to 99.4% of its budget. Per merge: demo
presets (#26) +16924, the Simulator's people-and-orgs work (#15) +810, actors that start with the page (#16)
+855, the mechanical bundle (#19) +198. Two things were removed:

- 493 bytes were incidental: keel's four preset operation definitions were module-level constants, so valibot
  and four schemas rode in every app's bundle although the demo never validates a preset. They are built by
  function now, and `tests/tooling/static-demo-bundle.test.ts` holds it. (An app's OWN definition is not
  covered: the showcase's `ticket.assign` still carries about 2.8 KB, its definition and valibot's schema
  functions.)
- 129257 bytes were Mantine's stylesheet. The apps import `@mantine/core/styles.css` whole, 273 KB for ~100
  components, of which the demo's bundle reaches 33. The static demo's build now drops every rule whose hashed
  class is in no shipped file (`scripts/vite-prune-mantine-css.ts`, wired in each app's `vite.demo.config.ts`):
  14-15% of the file.

What stays is the presets themselves: net of the trim about 16.4 KB on the showcase, real code (the static
twin's replay, the operation registry, the seam module with `extends`) plus its copy and its tour.

`pnpm build:demo-static`, bytes: 925623 at the first commit, 944410 before the re-base, 814660 after it. The
budget is 840000, which leaves 25340 bytes (3.0%).

The budget went DOWN, so the bytes saved are not slack: they are the margin above, on purpose. If the pruning
or the lazy definitions regress, the number turns red, which is the point of it.

**Raised 2026-07-31, 920000 → 950000, for tours**

The tour engine (ghost cursor driver, engine hook, narration bar, Tours tab) plus the showcase's 16-step
walkthrough and its narration in both locales cost 25244 bytes, 2.8% of the artifact: 10932 of that is the
engine (measured against the starter, which registers no tours and still passed its own unchanged budget) and
about 14300 is the tour itself, most of it narration in two locales. That is the one feature whose whole point
IS that file: a stakeholder who is emailed `dist-demo/index.html` can now press Start instead of reading a
runbook and clicking fifteen things in the right order.

## The getDb ban is deny-by-default; two fences hold outside declarations (2026-11-16, `fix/lint-import-fences-getdb-default`)

- **The getDb ban covers all of an app's `src/`, keel's screens (`components/`, `demo-static/`) and the
  fixture.** It used to name `app/`, `components/`, `domain/` and `jobs/`. The alternative was adding
  `actions/` and `lib/` to the list. It was rejected because the next directory would be missing in the
  same way. The one exception is tests outside routes, screens and the fixture, which arrange cases through
  the fake db. No production module needs the raw client today; one that does is added by exact path.
- **The ban is a rule of its own id, `keel/no-raw-db-handle`**, not `no-restricted-syntax` selectors. Its
  three selectors and messages are unchanged.
- **keel's own `src/` outside its screens stays outside the ban.** keel/db's helpers and keel's adapters are
  what open `withTenant`, and they are what the ban's message sends request code to.
- **The framework/app fence and keel/core's fence gained declarationless halves** (`keel/no-dynamic-app-import`,
  `keel/no-dynamic-framework-import-in-core`). They match through the `ignore` package loaded from ESLint, as
  `no-restricted-imports` does. A regex converter was the alternative, as the future task sketched; it was
  rejected because it would read some specifiers differently from the static half.
- **The vendor rule keeps its own matcher, `isVendorSpecifier`.** The static vendor ban's bare names (`pg`,
  `posthog-js`, `posthog-node`, `mailgun.js`) match at any depth and ignore case, so it flags a local `./pg`, which a test
  from the app-owned adapters work pins as not a vendor for the declarationless half. Matching both halves the
  same way means anchoring those names in `vendorSdkPattern`, which changes the static ban, so it is left for
  its own change.
- **The vendor rule gained the type position too.** It now shares the factory, so `type T = import('pg').X`
  outside an adapters directory is a finding, as `import type` from `pg` already was.

## Storage port: `head(key)` and `copy`'s `ifMatch` (2026-11-17, `storage-head`)

Requested because `copy` alone cannot serve a finalize step that re-checks each staged file's size and content
type before making it live: the port could only read them by fetching the whole object. A metadata read is a
generic primitive (S3 `HeadObject`; a stat in the fake).

- **Named `head`, after the port's verbs.** `put`, `get` and `delete` are HTTP verbs already; `head` is `get`
  without the body and is S3's own name for it. `stat` would have been the filesystem's.
- **It returns `StoredObjectInfo { size, contentType, etag, lastModified }`.** Size and content type are what
  finalize needs. The etag is there so the check can be tied to the copy (below); it pins the bytes, so the size
  check is exact, while the content-type check stays advisory, because neither adapter's etag covers the content
  type (a rewrite with identical bytes and another type keeps it). A flow that must hold the type relies on the
  upload target's `eq Content-Type` condition. `lastModified` is the one
  field nobody asked for; both adapters give it truthfully and a stat without a time looks wrong, but nothing
  else depends on it.
- **The etag is opaque.** AWS's own reference calls it "an opaque identifier", so callers compare two for equality
  and pass one back UNCHANGED as `ifMatch`; the port promises no format and not whether rewriting identical
  bytes changes it. Real: exactly what S3 sent, quotes included. Fake: a quoted SHA-256 of the bytes, shaped like
  S3's so a caller that mishandles the quotes fails here too. The fake computes size, modification time and hash
  from ONE open handle, so a writer that renames a new file over the old one cannot make them describe two
  versions; the cost is that a fake `head` reads the whole file.
- **A missing object is `null`, as for `get`; `copy` throws.** A read has a natural "nothing" to return, so a
  caller asks `if (!info)`; `copy` has nothing to return and a silent no-op would hide a lost file. Both
  adapters agree: the real one maps S3's `NotFound` (the SDK's error for a HEAD 404) and `NoSuchKey`; the fake
  answers `null` for anything that is not a regular file (a directory, a bookkeeping name).
- **What S3's HEAD cannot say.** A HEAD response has no body, so AWS gives only a generic status ("It's not
  possible to retrieve the exact exception"): a missing BUCKET, which S3 also reports as a 404 (not stated on the HeadObject page, so the
  cutover row confirms it), could not be told apart and reads as `null`, where `put` or `get` would surface it. A 403 (the role lacks `s3:ListBucket`, so a missing key is not a 404) is not
  mapped and throws, as in `copy`. A response without a size, ETag or date throws: defaulting a size to 0
  would let a maximum-size check pass on something S3 never said.
- **A stat-then-copy check is advisory; `ifMatch` makes it exact.** The object can change between the two
  calls, so `copy(from, to, { ifMatch: info.etag })` copies only if the source is still that version, else throws
  the new `PreconditionFailedError` and copies nothing. Real: S3's `CopySourceIfMatch`, which S3 evaluates with
  the copy. Fake: it compares the staged copy's hash, the very bytes about to be published, so the bytes that land
  are exactly the ones that matched even if a writer replaces the source mid-copy (a test races exactly that). The order
  of the other checks is same key, missing source, precondition (the real adapter leaves the last two to S3, whose order for a
  missing source with an `ifMatch` is unconfirmed; the cutover row asks). An `ifMatch` that is empty or `*` is refused first of all, on both adapters, with a
  plain `Error`: HTTP gives an empty If-Match no meaning and `*` the meaning "any version", so S3 could read either as no
  condition and copy unchecked where the fake refuses (what S3 does with them is unverified, and no etag `head` returns is
  either). No route glue maps the new error; the caller says
  409 or 412.
- **412 is inferred, not read.** The CopyObject reference states 412 for its other conditional headers and gives no
  code for `x-amz-copy-source-if-match`, which is HTTP's rule for a failed If-Match. The adapter maps the name
  `PreconditionFailed` or a bare 412, and the cutover row `storage-head` asks to confirm it.
- **No IAM change** (`HeadObject` needs `s3:GetObject` per AWS; `grantReadWrite` has `s3:GetObject*` and
  `s3:List*`), **no static-demo twin** (no storage port there). **Not done:** `copy` returning the new object's
  info, a create-only copy (`ifNoneMatch`), and reading a specific version.
- **The finalize sequence an app uses:**

    ```ts
    import { NotFoundError, PreconditionFailedError } from 'keel/ports/errors'

    const info = await storage.head(stagedKey)
    if (!info) return (await storage.head(finalKey)) ? alreadyFinalized : stagedFileVanished
    if (info.size > MAX_BYTES || info.contentType !== EXPECTED_TYPE) {
        await storage.delete([stagedKey])
        return rejected
    }
    try {
        // exactly the version that was checked, copied server-side
        await storage.copy(stagedKey, finalKey, { ifMatch: info.etag })
    } catch (error) {
        if (error instanceof PreconditionFailedError) return changedAfterTheCheck // re-head, or reject
        if (error instanceof NotFoundError) return stagedFileVanished
        throw error
    }
    await storage.delete([stagedKey]) // idempotent
    ```

    A retry after a copy that succeeded and a delete that failed finds the staged file again, gets the same etag,
    and converges over `finalKey`. A retry after both succeeded gets `null` from `head(stagedKey)`, which the
    first line of the snippet reads as "already finalized" by checking `head(finalKey)`.

## The migrating role may switch to `app_user` (2026-11-16, `fix/grant-app-user-to-owner`)

The design is in ADR-0004's addendum of the same date.

- **A framework migration, not a deploy step.** The grant has to exist before the first tenant query on
  any database keel migrates, and the migrator is the one role every deployment runs. A runbook line
  would be forgotten exactly once, and that once is every request failing.
- **Guarded by `pg_has_role(current_user, 'app_user', 'SET')`, not a bare GRANT.** The guard makes it a
  no-op for a superuser and on a re-run (a fresh superuser in the contract suite pins it). Separately, the
  block's `insufficient_privilege` handler means a role that cannot grant the switch to itself fails with
  the statement to run, instead of a bare `permission denied to grant role`.
- **INHERIT FALSE for the migrator, INHERIT TRUE for a separate app role.** The migrator owns every table,
  so it needs only the switch. A separate app role owns nothing and reads `tenants`, `organizations` and
  `service_keys` before any tenant is set, and those grants are `app_user`'s.
- **The non-superuser pass runs the existing proofs, not a new suite.** `RlsProofContext` gained
  `appDb`: every `runWithTenant` and every `SET LOCAL ROLE app_user` in the framework's and all three
  seams' proofs moved to it. Seeding and the negative control stay on the superuser. So every isolation
  claim is now proved for the connection a deployment actually uses, and an adopter's own proof half that
  still switches on `db` keeps passing, just less strictly.
- **The shared-server problem is measured, not assumed.** `app_user` is cluster-wide, and CI's suites
  share one Postgres. The pass measures what this server gives a role's creator, then gives the owner
  exactly that where `app_user` already exists. The pass runs twice in its file, so the genuine path (the
  owner's own 0001 creates `app_user`) and that one both run every time. Before that, a scratch run on a
  fresh cluster had checked the genuine path: the owner created `app_user`, failed without 0015, and passed
  with it.
- **`down` is a no-op.** Revoking the switch would take every tenant query down with it, and keel never
  runs `down` migrations.
- **A self-granted membership keeps its INHERIT.** If an operator set `createrole_self_grant`, the
  creator already holds a membership it granted itself, and a plain GRANT would rewrite that row's
  INHERIT. 0015 adds SET to that row instead (found in review; tested on real Postgres).
- **A migrator with no ADMIN on `app_user` now fails at 0015, deliberately.** That happens on a shared
  cluster where another role created `app_user`, or with a migrator that never runs the app. It used to
  migrate cleanly. Now it stops with the one statement to run. The alternative, migrating anyway, would
  leave a role that might be the app's unable to serve a single tenant query, discovered at the first
  request instead of at deploy.
- **A second owner on one cluster fails at 0015 rather than migrating, and the failure carries its
  remedy.** Staging and production on one Aurora cluster, migrated by different owners, is a real setup.
  A reviewer proved that the second owner's grant fails. Skipping 0015 there would have migrated a database
  whose owner cannot serve a tenant query. So it stops, rolls back, and prints the GRANT. The contract
  suite runs the case end to end, executing the printed statement as written.
- **A role name with capitals broke 0015, and the second-owner test found it.** `current_user::regrole`
  parses its input as an unquoted identifier and folds it to lower case, so a role named `Keel_Second_…`
  was "not found". 0015 now finds the role by its exact name in `pg_roles`, and the remedy it prints quotes
  the name (`quote_ident`), so copying it runs as-is. The test's second owner has a mixed-case name to pin
  both. Its remedy is run by an ADMIN-only creator, not the superuser, so the docs' "a role holding ADMIN"
  is what is tested.
- **Postgres 16 or later is stated as keel's minimum, not branched on.** 0015's `pg_has_role(…, 'SET')`
  and `GRANT … WITH SET` arrived in 16, and nothing in the repo stated a minimum version (found in the
  independent re-check). Every server keel targets is 16 or later (Aurora 16.10, CI's postgres:16, pglite
  18.6), so a `server_version_num` branch for 15 would be code no gate runs. The minimum is in
  `docs/adopting.md`, the ADR addendum and 0015's header.
- **A logical restore carries the ledger, not the grant.** `pg_dump` dumps one database, and roles and
  their memberships are cluster-wide. Restored into another cluster, the ledger says 0001 and 0015 ran, so
  neither runs again, and neither `app_user` nor anyone's switch to it came along. The
  `db-role-not-superuser` cutover row says what to do before and after a restore.

## JSX banned in keel/core; paths into apps/ fenced; getDb as a string banned (2026-11-16, `fix/lint-core-jsx-app-paths-getdb-string`)

- **JSX in keel/core is banned with a rule of its own, `keel/no-jsx-in-core`,** reported for each outermost
  element or fragment, so a disable comment on one does not hide the next. Banning `*.{tsx,jsx}` files under
  core was the alternative. It was rejected because the extension is not what imports React: the JSX is.
- **A path into app code is judged by where it lands, not how it is spelled.** `keel/no-path-to-app-code`
  resolves a relative or absolute specifier against the importing file, following symlinks, and reports it if it
  lands in `apps/` or `packages/seed/`. The first version was a `regex` on the spelling (an `apps/` segment anywhere in a
  specifier). It closed the seam for `@app-config/apps/…`; round 1's fix, which kept `@` specifiers out of it, let
  `@scope/../../apps/…` through; and each review round found a spelling it missed. Listing the two
  apps' directories was rejected too: an adopter renames and adds apps.
- **A `..` in any package or alias specifier is banned** (`bareTraversalPattern`), not only after
  `@app-config/`: no package specifier has a reason to climb, and TypeScript resolves one that does out of
  node_modules. So is **any specifier through `node_modules`** (`nodeModulesPathPattern`), where pnpm links the apps
  and the seed. Both travel with `appCodePattern` as `appCodePatterns`.
- **A specifier two patterns match is two findings, in both halves.** The declarationless half now reports every
  pattern a specifier matches, as `no-restricted-imports` does. The alternative, exempting from the traversal ban
  what the alias pattern "already bans", was tried and rejected: written as spellings, the exemptions let
  `@\..\..\apps\…` and then `@//../../apps/…` through, because the alias group matches neither.
- **The app's aliases are a `regex`, not a `group`** (`^(@[\\/]|@app[\\/]+seed([\\/]|$))`). A fuzz of 7,069 specifier
  spellings against TypeScript's resolver found `@//domain/tickets` past the `@/*` group, whose gitignore syntax
  does not match an empty segment. The regex matches every specifier the group did on the fuzz's corpus, plus the
  empty-segment and backslash spellings, which no published package uses.
- **The getDb ban also matches the name as a string.** Type positions are left out because they load nothing,
  and so are keys that define a member. Strings the computed and destructure selectors already report are left
  to them, so each finding is reported once. A spy's key (`vi.spyOn(db, 'getDb')`) is exempt in a test file
  only: a spy calls through, so anywhere else it is the raw handle.
- **Two gaps stay documented and filed, not fixed:** a hand-written `.mjs` in the generated styles directory
  (`.claude/future-tasks/generated-styles-mjs-unlinted.md`), and the vendor ban's two halves reading the list
  differently (`.claude/future-tasks/vendor-ban-matcher-parity.md`).

## App-owned lint exceptions (2026-11-16, `fix/lint-core-jsx-app-paths-getdb-string`)

- **An app's exceptions to a fence live in `apps/<app>/lint-exceptions.mjs`**, read by `eslint.config.mjs` for
  every app at load. The alternative, an exact path in `eslint.config.mjs`, stops matching after `pnpm init-app`: the path named
  the app's directory, which `pnpm init-app` renames without rewriting keel's config. Every upstream change to the
  file would also conflict with the adopter's edit.
- **Only `keel/no-raw-db-handle` takes one.** It is the one fence the docs tell an adopter to except a module
  from. The recipe and `/new-port` still say to add a vendor to `vendorSdkPattern` in `eslint.config.mjs`. That
  widens a ban rather than excepting a file, and is left where it is.
- **Each entry names one existing file under the app's `src/` and gives a reason, or the config fails to load.**
  The alternative was warning on a broad glob. It was rejected because a warning is easy to scroll past, while a
  failed load names the entry. A Next route's `[locale]` is escaped, so the path matches literally.
- **`KEEL_LINT_EXCEPTIONS_ROOT` points the loader at a scratch tree**, for the one test that runs the real config
  end to end without writing into this repo's `apps/`. It is read only under vitest, so a variable left in a shell
  cannot swap the exceptions; that guards against accidents and is not a boundary.

## Audit events take the simulated world's time; an ejected app carries the cron route (2026-11-17, `fix/audit-clock-and-cron-route`)

Two requests from the first adopter (pages), both written so they work the same whether an app takes keel by fork
or as a package: the logic is in `packages/keel`, and the app holds thin wrappers.

- **An audit event's time comes from the database port, never from a caller.** `audit_events.at` defaulted to the
  database's `now()` and nothing set it, so a demo that advanced the Simulator's world clock still recorded events
  in real time, and anything comparing an event's age with that clock (a retention demo) never lined up. `DbPort`
  gains an optional `now(): Date`; the fake database implements it as the world clock (`worldNow()`), and
  `recordAuditEvent` stamps `at` from it when it exists. A real adapter must not define it, so `at` stays
  Postgres's `now()` there. Rejected: an `at` field on `AuditEventInput`, which is exactly what must not exist
  (every route could then supply a time, and "real mode ignores it" is a rule somebody has to keep); and reading
  `isSimulated` inside `recordAuditEvent` (it would couple the db module to the adapter registry, and the port
  already is the place that differs between modes). Every writer reaches the table through that one function, so
  schedules, webhooks, inbound mail and invites are covered without a change. The file:// demo twin had the same
  defect (`appendAudit` defaulted to real time, and the inbound-mail path passed a real-time `at` explicitly); it
  now uses its own world clock, with the inbound ROW keeping real time as the server's `inbound_emails.created_at`
  does. Known consequence, not fixed: the Simulator's "reset clock" returns to real time while the database
  persists, so events recorded afterwards sort below ones stamped in the advanced future in the Events tab, which
  orders by `at desc`; and because that tab shows the newest 100, a world holding 100 or more future-stamped rows
  hides every event recorded after the reset until it is re-seeded (a sequence column would fix the order; it is
  not worth a migration for a demo-only tab). Not changed here: the other timestamp columns (`jobs`, notifications, deliveries) still use
  the database's `now()`; only the audit trail was asked for.
- **The starter has the scheduled-tick route.** The showcase's `/api/webhooks/cron` route held the whole tick, so an
  app built from the starter had no route and nothing ticked keel's scheduler in a deployment (the `scheduled-tick`
  cutover row needs it). The tick is now keel's `runScheduledTick` (`keel/server-lib/scheduled-tick`, one new
  published subpath, 131), and both apps' routes are `withWebhookSecret(...)` around it. `withWebhookSecret` joins
  `keel/service-auth/webhook` (no new module for it) and maps nothing but the opaque 401; the showcase keeps its
  own guard of the same name, which also maps port errors. The route has to name `withWebhookSecret(` in its own
  file because the authorization scan accepts a `webhooks/` route on that text, so a bare re-export of a framework
  handler would fail the scan; watched failing with the guard removed. The starter's coverage is a route test and
  the framework's tests, not an e2e: its e2e is deliberately one claim.
- **`pnpm dev` without the Simulator has no tick source, and that is documented, not fixed.** The showcase's
  Simulator controls are buttons; nothing polls. An automatic dev ticker would change when the showcase's e2e and
  demos see digests fire, so `docs/adopting.md` ("The scheduled tick") says how to tick by hand with the dev
  secret instead. A `pnpm tick` helper or an opt-in ticker is the next step if it is wanted.
- **The audit write is total against a bad clock file; the tick is not, and that is left as it was.** A corrupt or
  absurd `.data/simulator/clock.json` makes `fakeDb.now()` fall back to real time (any instant Postgres cannot
  store counts as absurd: past year 9999 or before year 0), because an audited mutation has already committed
  and must not answer 500 with no audit row. `runScheduledTick` calls `worldNow()` directly, so the same file
  makes the cron route answer 500 until it is fixed, exactly as the showcase's route did before this change; a
  tick that silently ran on real time would hide that the demo's clock is broken. Not worth a second fallback.
- **Corrected figure:** the adopter guide said the starter imports 32 of keel's published subpaths; it was 33 before
  this change (every counting rule gives 33) and is 35 of 131 now from the starter's source, 37 counting its tests (the new cron route test imports
  `keel/adapters/fake/db` and `keel/adapters/fake/service-auth`), so from here on the figure depends on the rule: say which.

## Audit rows carry a `detail` (2026-11-17, `feat/audit-detail`)

The design is in ADR-0012's addendum of the same date. It was asked for by the pages console (item T-037).

- **One nullable jsonb column, not typed columns.** A refusal's reason and a purge's count share nothing
  but "why", and the next adopter's why will be different again. Typed columns would make every one a
  framework migration.
- **Checked in the writer, before any transaction opens.** The trail is append-only, so a bad detail could
  never be taken back. A refused detail throws, and the audited mutation (already committed) answers 500,
  the existing "committed write, failed audit" direction. The bound is 1024 bytes because codes and counts
  take a few dozen, and a list that grows with the data then fails in a test rather than in a log nobody
  can trim.
- **A key denylist, matched on the key's last word or last two.** Matching the whole key on a substring
  refused `tokensRemoved`, exactly the kind of count a purge records. Matching on the last word refuses what a
  key NAMES (`accessToken`, `apiKey`) and passes what it describes (`tokenId`, `tokenCount`). A plural
  is let through only as a number under a qualifying word (`revokedTokens: 3`): review showed a bare
  `otps: 482913` is the code, not a count. A boolean or null passes under any key, since neither can
  carry a secret. Personal data is caught only by value, as an email-address shape, because no key name
  reliably marks it.
- **The serialized text is bounded first, and checked second.** Review found two ways round a single
  walk of the input: a `toJSON`, getter or Proxy could write what the walk never saw, and the patterns
  read unbounded strings (60 KB took seconds with the email pattern). So the input is walked for JSON's
  types (and a key shown in an error's path, at most 64 characters, is shape-checked), serialized once,
  bounded, parsed, and the parsed value is walked with every rule and written.
- **The error never repeats the value.** It names the rule and the path. The value may be the secret, and
  the error goes to logs and to error tracking. A key in the path that is long or fails a shape check is
  withheld as well, since a map keyed by email address is a plausible accident.
- **Intake records a closed vocabulary, not the handler's reason.** Both reference handlers (the
  showcase's and keel's test fixture's) write the sender's address into `reason`. Copying it would have put personal data into the one table nobody can
  redact, in keel's own first use of the column. Letting a handler add a structured code of its own is a
  possible follow-up; nothing asks for it yet.
- **`intake-threw` is not `handler-threw`.** Intake's catch also covers its own recording after the
  handler returned. Narrowing the catch would turn that failure into a 500, and Mailgun's retry would run
  the handler again. So the catch stays, and the cause says who threw.
- **No SQL CHECK.** jsonb normalizes numbers and whitespace, so a SQL byte bound and the writer's would
  measure different texts.

## The starter has a contract suite of its own, and the suite is generic (2026-11-17, `starter-contract-suite`)

ADR-0014 step P11. `pnpm test:contract` ran the RLS proofs on real Postgres for ONE app, named by a
`CONTRACT_APP` literal in `vitest.contract.config.ts`, and `pnpm init-app --eject-showcase` copied the
showcase's suite and `config/params.ts` into the starter to keep that literal pointing at something.
`apps/starter` now has its own suite, its own database and its own `config/params.ts`, and the command runs
every app plus keel's fixture, each in a database of its own.

- **One suite, written once, in `tests/support`.** `contract-suite.ts` is `defineContractSuite({ database })`:
  a non-superuser owner pass, the same again where `app_user` already exists, then the full proof suite as a
  superuser. It names no app and no table. The two apps' `tests/contract/rls-contract.test.ts` files are the
  same four lines of code, and the conformance kit (P5) takes the suite over as it is. It lives at the repo's
  `tests/support`, not in `keel/testing`, because P5 is where `keel/testing` is designed; until then it is
  the one place both apps and keel's fixture already reach. The server helper (`contract-postgres.ts`) holds
  the "embedded-postgres, or CI's service container" choice that `db.contract.test.ts` and
  `rds-data.contract.test.ts` each carried their own copy of; both now call it.
- **`keel/db/owner-pass` is published.** The suite imports it, so it needed an `exports` line, and the line is
  the only way to widen the map (the count went up by one, to 132 once main's own addition merged, and the internal-module count from 46 to 45,
  both pinned in `public-surface.test.ts` and read from `CLAUDE.md` and `docs/adopting.md`).
- **Discovery, not a literal.** `vitest.contract.config.ts` builds one project per `apps/*` directory that has
  a `tests/contract` (`contractApps`), plus keel's fixture. `init-app` renames the app and the discovery
  follows, so the config is no longer rewritten on eject. The database is named from the app's own slug
  (`contractDatabaseName`: `acme-corp` becomes `acme_corp_contract`), for the same reason.
- **Two migration sets cannot share a database.** They share 0001-0999 and differ from 1001, and Kysely
  reports corrupted migrations when the second set runs over the first. Each suite is therefore one database
  on a shared server: `showcase_contract`, `starter_contract`, `keel_contract`, `keel_data_api_contract`. On a
  shared server `app_user` is cluster-wide, so a later suite finds it already present. That is the branch the
  second owner-pass test exists to run, and it is what CI's service container does anyway.
- **`pg`, `kysely` and `embedded-postgres` are the root's devDependencies.** The helper is at repo level, so
  they must resolve from there, and the vendor-SDK fence covers `apps/*/**` and `packages/*/src/**` only. The
  showcase's two devDependencies and keel's one moved up with them (knip flagged keel's as unused once the
  fixture tests stopped importing it).
- **`init-app` lost a step.** `rescueFromShowcase` (copy `tests/contract` and `config/params.ts`, add three
  devDependencies) and both rewrites of the contract config are gone, and so is the `hasParams` branch in the
  summary: the starter carries all of it before anyone ejects. 66 lines left the script and 7 were added.
- **A gate that the next app cannot skip: `tests/tooling/app-scaffold.test.ts`.** An app with no `params.ts`,
  whose params have different keys from another app's (both directions), that cites a cutover row the checklist
  does not have, that has migrations and no `tests/contract` file calling `defineContractSuite(` (a mention in a
  comment is not a call), whose contract database is another app's (two slugs can fold to one name, and on CI's
  one server their migrations would meet) or starts with `keel_` (keel's own fixture databases), fails it.
  `scaffoldProblems` is a pure function with synthetic negative tests, like `presetProblems`, and it names no
  app, so it travels with `tests/` to an adopter. Params shape parity is the cheap half of "every app's
  deployment parameters look alike", which the conformance kit will state properly.
- **The helper's pools carry the real adapter's client error listener.** A connection the server ends is an
  'error' event, and with no listener it is an uncaught exception that takes the whole run down instead of
  failing the test using it. Probed both ways: with the listener a server-terminated idle connection and one
  inside a transaction fail only that test; with it removed the run reports an unhandled 57P01.
- **`apps/starter/config/params.ts` is the showcase's file, copied.** Same keys, same cutover rows. The
  checklist rows are the contract; a second value set that drifts is what the shape-parity gate catches.

Seen failing, then restored: removing `ENABLE/FORCE ROW LEVEL SECURITY` from the starter's `1001_items.ts`
turned all three starter contract tests red ("public.items is reachable by app_user"); deleting the
`database` section of the starter's params, citing a row that does not exist, and removing the file each
turned the scaffold gate red; so did removing `apps/starter/tests/contract`, giving the starter the
showcase's slug or a `keel-` one, and commenting out its `defineContractSuite(` call.

Measured, `pnpm test:contract` with one embedded server per file: on main (3604aa1) 3 files and 40 tests, 6.7 s
once warm (11 s on a cold first run); here 4 files and 45 tests, 9.4 to 10.5 s. The five extra tests are the
starter's three and two in the showcase's file, which on main ran only the superuser proofs and now runs the
owner pass twice as well. Against one shared server, as CI runs it (`CONTRACT_DATABASE_URL`): 3.8 s on main,
5.4 to 6.1 s here, green twice running on the same live server. Covering every app costs about 3 s locally. The
owner pass found nothing new in either app's migrations.

Found by running the whole flow on an ejected copy (`init-app acme --eject-showcase`), not by reading: a
scaffold-gate assertion that named `starter` (it fails once the app is renamed), the internal-module count in
`docs/adopting.md`, and the unused devDependency. The adoption probe does not run `test:contract` (`pnpm
verify` does not either), so the ejected suite is proven by hand here and by the gate's own
"every app with migrations has a suite" check.

## The authorization scan reads each handler (2026-11-17, `fix/authz-scan-per-verb`)

- **The TypeScript compiler's parser and binder, one file at a time, with no import resolution.** Each route file
  becomes its own `ts.createProgram` with `noResolve` and `noLib`. That is enough for the checker to answer every
  question asked of it, all of which are about bindings inside the file: which declaration a callee names, what an
  `export { h as POST }` points at, whether an identifier is a `const`. Following an import is done explicitly, with
  `ts.resolveModuleName` and the root's tsconfig. Rejected: one full program per app, which would load each app's
  whole import graph (keel, Next, React types) to answer questions about 81 small files. Also rejected:
  typescript-eslint's parser, which the lint rules use. It would serve within one file, but following a re-export
  means reading another module and resolving its specifier through the root's tsconfig, which the compiler API does
  in one call. The check stays a test, as it was, because it judges a file's exports and the modules they lead to,
  not one node.
- **`authorize` is known by its import, not its name.** A call counts only if its callee is the `authorize` imported
  from `keel/authz/authorize` (by any local name, or through a namespace import). The old regex took any
  `authorize(`, so a local `function authorize() {}` satisfied it. The module list is a scan option, so an adopter
  who wraps `authorize` can name its own module.
- **A gate's name is bound to an import, but not to a module.** A gate name must be a value import kept under its
  exported name, so a local look-alike and an alias both fail. Which module exports it is not checked. Pinning
  `isSimulated` to `keel/adapters/index` would fail an app that re-exports it from its own module, and the wrappers
  are app code with no module to pin. The limit is written into ADR-0012's addendum.
- **The simulated 404 must run nothing in real mode.** Its branch is a lone `return` of a `Response`/`NextResponse`
  built from literals, or a lone `throw` of an `Error` or an imported error class. No parameter may carry a default.
  A value that is an identifier or a property read is refused even when harmless, because an object's `toJSON` or
  getter runs when the response is built. Every gated route in both apps already had this shape.
- **An exemption never bans `authorize`.** A handler under an exempted path that does not pass the gate is judged like
  any other, so one that authorizes passes. Main's file-level match passed such a route on the other verb's gate; the
  first per-verb version failed it, which was a false red.
- **Calls into other modules are not followed.** A handler whose only `authorize` is inside an imported helper
  fails. Following them would mean resolving and reading arbitrary app modules, and a helper reached on an unknown
  path is the case the scan cannot judge. Same-module functions are followed, to any depth, unless the file
  reassigns or redeclares them. No route in either app authorizes only through a helper in another module.
- **A function literal passed as an argument is assumed to run.** Every route body is `withPortErrors(async () =>
…)`, and the scan cannot read the imported wrapper to check that it calls its argument. This is the one trust the
  analyser extends, and it is stated in the module and in ADR-0012's addendum.
- **A `wrapped-by` gate needs the handler to BE the call.** A function handler that calls `withWebhookSecret(…)`
  inside does not pass, even if its body is nothing but `return withWebhookSecret(…)`. With the apps' wrappers that
  shape returns a function rather than a response, so it is a bug, not a variant. The fixture's two stand-ins had
  that shape (their stand-in wrappers invoked the handler at once). They were changed to the apps' shape, not
  accommodated.
- **The fixture imports its stand-ins.** The fixture's gated routes each defined a local stand-in for the gate. Once
  a gate binds to an import, a local stand-in is a look-alike that no longer passes as the gate, so they moved to one module,
  `packages/keel/test-fixture/api/stand-ins.ts`, which knip already ignores with the rest of `test-fixture/api`.
- **A module with two candidate files is refused, not guessed.** TypeScript and Next's bundler disagree on some
  layouts (`impl.ts` beside `impl.js`, `impl.mjs` beside `impl/index.ts`, a `package.json` the bundler follows by
  `main`). Matching the bundler's resolution exactly was rejected as a moving target. When the module has more than one
  candidate, the scan reads none and says why.
- **Refuse rather than guess.** A destructured export, a `let` handler, an unresolvable re-export or `export *`, a
  file that does not parse, `export =` and CommonJS exports each fail with the reason. The old scan treated `export *`
  as mutating sight unseen. The new one resolves it, and refuses it only when it cannot.
- **An un-awaited async helper is left to lint, and lint does not catch it yet.** A handler that calls an `async`
  same-file helper without awaiting it reaches `authorize`, but the helper's `ForbiddenError` becomes an unhandled
  rejection. Requiring the call to be awaited was considered and left out of this change. The rule that catches it,
  `@typescript-eslint/no-floating-promises`, needs type information, which the lint config does not load.
- **The policy stays in the test; the analyser is a module of the package.** `route-scan.ts` takes the roots and the
  exemption map as input (ADR-0014's conformance kit will need that). It is not in the `exports` map, so it is internal
  (`docs/adopting.md`'s count of internal modules grows by one). `typescript` stays a devDependency of keel;
  publishing the analyser for adopters would make it a dependency, and that is ADR-0014's decision.

## ADR-0014's open decisions, decided by JP (2026-11-17, `docs/adr-package-model`)

ADR-0014 (Proposed) left seven decisions open. JP Slavinsky decided all seven on 2026-11-17, and the same day added D8 to D11 and revised D3, in a chat with the
keel manager session, which relayed them to the session writing the ADR. The ADR records each with its reasons.

- **D1, registry: public npm.** GitHub Packages was the alternative. It needs a classic personal access token to
  install even a public package, on every adopter's machine and in their CI.
- **D2, name: keel is renamed.** `keel` on npm is another project's active backend framework, and a rename is
  cheapest before anything is published and before Pages switches. The first choice, strake, was dropped the same
  day (below), and the name is SSSB (below). The naming rule was left to the ADR: every package, the never-published seam included, is under the project's
  npm organization, so owning the scope reserves every name. It first left the framework and its generator
  unscoped, and npm refused the framework's name (below). Unscoped tooling (`eslint-plugin-<name>` and the like)
  was rejected from the start, because each unscoped name is one more that someone else could publish first. ADRs 0001–0013, this log and `docs/build-notes.md` keep saying keel, because they were
  true when written.
- **D3, licence: unchanged**, MIT and "Copyright (c) 2026 JP Slavinsky".
- **D4–D7, as the ADR recommended:** the showcase stays as the never-published reference app; Pages switches at
  the first release candidate; SSSB's own packages are exempt from `minimumReleaseAge`; no backports during 0.x.
- **D8, added by JP the same day: per-app infra.** The root `infra/` was the showcase's deployment and nothing
  else, and `init-app` rewrote its paths on every rename or eject. Each app's deployment now lives in the app
  (`apps/<app>/infra/`), the reusable code in `@sssb/cdk`, and nothing at the root names an app. The starter
  gets one too. An adopter whose infrastructure spans several apps, as Pages' does, keeps its own root `infra/`.
- **D2 reopened, the same day.** The independent design review found that an npm organization `strake` already
  exists and is not JP's (the registry answers `/-/org/strake/package`, though every package name under it is a
  404), and that Strake is an existing project. JP is choosing another name. It is reserved on npm first (step zero in ADR-0014's plan: organization ownership confirmed and placeholders published),
  and only then written into the repository.
- **D2 settled, the same day: SSSB**, written `sssb` in code. **The name is deliberately left undefined**: JP asked
  that it not be overly defined, so the letters have no official expansion, in the docs or anywhere else. The
  names: `sssb` (the framework), `create-sssb`, `@sssb/tools` (its CLI is `sssb`), `@sssb/eslint-plugin`,
  `@sssb/cdk` (the `SssbApp` construct), the seam `@sssb/app-config` (a local link only, never published), and
  the repository `safeinsights/sssb`. Checked on 2026-11-17: those names are unpublished, the registry had no `sssb` organization until
  `safeinsights-bot` created it that day, and npm's search finds nothing similar. On GitHub a few small, unrelated repositories use
  the letters, some of them watchers for SSSB, the Stockholm student-housing foundation: a different field, and
  a low risk.
- **D2's names corrected, the same day: unscoped `sssb` refused by npm as typosquat-similar; all packages
  scoped.** Publishing `sssb` failed with a 403, "Package name too similar to existing packages ssri, ssh2, ses,
  sass, scss, jss, csso, xss, css", and nothing was published. So the framework is `@sssb/core`, imported
  directly as `@sssb/core/…` (JP chose that over an `npm:` alias), the generator is `@sssb/create`, which
  `npm create @sssb` runs, and `create-sssb` is dropped; `@sssb/tools`, `@sssb/eslint-plugin`, `@sssb/cdk` and
  the seam are unchanged. Owning the `@sssb` scope is step zero: nobody else can publish under it. The
  organization's package list names `@sssb/core`, `@sssb/create`, `@sssb/tools`, `@sssb/eslint-plugin` and
  `@sssb/cdk`, which gives P14 a package to configure a trusted publisher on; `@sssb/app-config` stays
  unpublished.
- **D2's framework name, the same day: `@sssb/kit`, not `@sssb/core`.** As `@sssb/core`, keel's own `core`
  module would have read `@sssb/core/core/…`; as `@sssb/kit` it reads `@sssb/kit/core/…`. Apps import
  `@sssb/kit/…` directly, and in the repository the framework moves to `packages/kit`, beside `packages/cdk`.
  `@sssb/core` stays as a deprecated, unused placeholder saying the framework package is `@sssb/kit`. ADR-0014
  now calls its conformance checks "the conformance suite", so "kit" only means the package. `safeinsights-bot` published
  `@sssb/kit` and a `create-sssb` guard the same day, and deprecated `@sssb/core` ("Not used. The SSSB framework
  package is @sssb/kit."). npm accepted `create-sssb`: its bin prints "SSSB's generator is @sssb/create. Run: npm create @sssb"
  and exits 1, which covers the mistype `npm create sssb`. The docs run the CLI as `pnpm exec sssb`, never
  `npx sssb`.
- **D3 revised, the same day: copyright assigned to Rice University.** JP transfers keel's copyright to SafeInsights,
  that is Rice University. The `LICENSE` line becomes "Copyright (c) 2026 Rice University", MIT unchanged. The line
  records an assignment JP makes, and changes only once JP has executed it, before the first release candidate.
- **D9, stewardship: maintained by SafeInsights, not SafeInsights-specific.** The universality test
  (`docs/development-approach.md`, "What the template ships") is the guard. The rename PR says so in `README.md`,
  `CONTRIBUTING.md` and `docs/README.md`.
- **D10, a new home.** `jpslav/keel` is archived after a commit pointing its README at `safeinsights/sssb`, which
  starts as a copy of the full git history, so every commit and author is kept. The rename is its first PR. PR
  numbers restart there, so the doctrine docs qualify old references (`jpslav/keel#54`), and each dated record
  gets an appended entry saying which repository its earlier numbers refer to. Rewriting the records' numbers
  was the alternative, and it was rejected because the records are append-only. The npm organization `sssb` was created by the `safeinsights-bot` npm account, its sole owner for now, since JP
  has no personal npm account (CanopyCMS is set up the same way). That single owner is recorded as a known risk,
  and adding a second, human owner is an account action for when a maintainer has an npm account. In-flight `jpslav/keel` PRs land before the copy.
- **D11, the same day: no more manual npm publishes.** Every passkey approval is friction JP wants gone. The
  packages already exist, so the release workflow modeled on CanopyCMS's `publish.yml` and a trusted publisher on
  every package, `create-sssb` included, move to right after the rename (ADR-0014's P1b), the last passkey round.
  Pages' prereleases are GitHub-release tarballs, which involve no npm publish; iteration happens on an
  integration branch, and npm sees only real releases.

## The move to `safeinsights/sssb`, and the rename (2026-11-17, `chore/move-and-rename-sssb`)

**Earlier entries, and their numbers.** Every entry above this one was written in `jpslav/keel`, under the name
keel. A bare PR number above (`#54`) is a PR in `jpslav/keel` (jpslav/keel#54); this repository's PRs number from 1
again. keel above means the project now called SSSB, `packages/keel` is today's `packages/kit`, `keel/…` is
today's `@sssb/kit/…`, `@app-config/*` is today's `@sssb/app-config/*`, and a `keel/…` lint rule id is today's
`sssb/…`. Entries from here on say SSSB.

Decisions P1 made that ADR-0014 did not:

- **The seam is an optional peer through `peerDependenciesMeta` alone.** With `@sssb/app-config` in
  `peerDependencies` and marked optional, `pnpm install` in this workspace asked the registry for it (404): pnpm
  installs a workspace project's own peers, optional or not. A `peerDependenciesMeta` entry with no
  `peerDependencies` entry is an optional peer of any version, the install stays offline, and a packed `@sssb/kit`
  installed beside a `link:` seam still gets the seam linked into its directory in the virtual store.
- **The Vitest project that runs the packages' suites is `kit`**, in both `vitest.config.ts` and
  `vitest.contract.config.ts`: it runs the framework package's suite. Nothing selected it by name.
- **`init-app` refuses the slugs `kit`, `sssb` and any `sssb-…`**, and `keel` is no longer reserved. `init-app`
  reserved `keel` because it was the framework's workspace and Vitest project name. An app slug cannot spell
  `@sssb/kit`, but an app named `kit` would collide with the Vitest project, and an app's contract database is its
  slug folded to underscores plus `_contract` (`tests/support/contract-postgres.ts`), so `sssb` would be the
  fixture's own `sssb_contract` and any `sssb-…` slug would start with the `sssb_` prefix that
  `tests/support/app-scaffold.ts` reserves for the framework, turning the adopter's first `pnpm verify` red.
- **One statement in the ADR index, not an addendum per ADR**, says that the ADR bodies' bare PR numbers refer to
  `jpslav/keel`. Only ADR-0004 and ADR-0014 cite bare numbers today, but every body says keel, and one paragraph
  where readers enter the ADRs covers all fourteen and any later addendum that quotes an old one.
- **The 0015 migration's error text keeps `keel:`.** `RAISE EXCEPTION 'keel: role % cannot switch to app_user …'`
  is a shipped migration's body. Editing it would change nothing in a database that already ran it and would make
  a fresh database's error differ from an old one's, so the migration and the contract test that matches its text
  are left as they are.
- **Test-only and transient names became `sssb_…`**: the contract databases (`sssb_contract`,
  `sssb_data_api_contract`, `sssb_data_api_lock`), the owner-pass roles and databases (`sssb_owner_…`,
  `sssb_creator_…`, `sssb_second_db_…`, `sssb_0015_…`), the Data API driver's `sssb_describe_…` statements, the
  test GUC `sssb.probe`, temp-dir prefixes, the tour cursor's DOM ids (`sssb-tour-cursor`), the test MIME types
  (`application/x-sssb-test`), the fixture's slug (`sssbfix`) and the Vite plugin name `sssb:prune-mantine-css`.
  None is deployed state.

## Pack and consume (2026-11-17, ADR-0014 P2, `ci/pack-and-consume`)

`scripts/pack-and-consume.mjs` and the `pack-and-consume` job in `checks.yml` pack `@sssb/kit`, build an
adopter-shaped workspace outside the checkout from copies of `apps/starter`, install the tarball and run that
workspace's verify. Decisions ADR-0014 did not pin down:

- **Two apps, one full verify.** `apps/console` runs everything part 7 lists for P2. `apps/ledger`, the second
  app with a different seam (its own slug, and an extra migration imported through `@/`), runs typecheck at the
  floor and with the strict flags, unit tests with the conformance suites, and its migrator bundle, but not
  `next build`, e2e or the static demo: a second copy of the same starter adds CI minutes there and no
  resolution path the console does not already cover.
- **The seam's isolation is proved four ways**: on disk (each app's `@sssb/kit` in the virtual store has the
  app's own `src/app-config` linked beside it, and the two apps hold two instances), at run time (each app's
  `seam-identity.test.ts` reads its own slug through the framework's `WEBHOOK_SIGNATURE_HEADER`), in each
  migrator bundle (the app's migrations and no other app's), and by the conformance suites running from each
  app's own copy (Vitest's JSON report is matched against both spellings of that copy's path).
- **"No install reaches the registry for `@sssb/app-config`" is enforced, not observed.** The consumer's
  `.npmrc` routes the whole `@sssb` scope to `http://127.0.0.1:9/`, where nothing listens, so any registry
  request for an SSSB package fails the install; the lockfile check fails any `@sssb/kit` resolution that is not
  a `file:` tarball and any seam that is not a `link:`; and the lockfile's integrity for the framework must be
  the sha512 of the tarball this run packed.
- **P1's `peerDependenciesMeta`-only shape matters inside this repo, not to a consumer.** Probed: with the seam
  also listed in `peerDependencies` (still optional), the consumer's install did not request it. With the seam
  not optional at all, the install did, and the dead registry failed it. The packed manifest is still held to
  P1's shape, because this repo's own install needs it.
- **The typecheck covers the framework's whole public surface.** A consumer typechecks only the framework modules
  it reaches, and the starter reaches a fraction of them, so each app re-exports every `exports` key type-only
  (`src/sssb-surface.ts`). Without it, a new strict-flag error in an unreached module stayed green.
- **The strict-flag typecheck is a ratchet on the framework and a hard gate on the app.** All nine of part 2's
  flags are on at once. Errors are split by where they sit: any in the app's own code fails, and the framework's
  must equal `STRICT_KIT_ERROR_BASELINE` exactly (122 over the whole published surface; part 2 counted 116 over the
  non-test source at 6d67a7c), so P3 lowers the number as it fixes them and a new framework error cannot hide
  under it.
- **The starter's own code now passes the strict-flag set**, through edits to five files: bracket access to
  `process.env` in both Playwright configs and in the cron route test (and to a request header there), a typed
  `welcome()` catalog helper, and the sign-in picker leaving out a person with no membership instead of throwing.
  The starter is `@sssb/create`'s template, so an adopter who turns the flags on starts clean; and with the app's
  own errors at zero, a framework type change that surfaces as an error in app code shows up.
- **The packed source may import only what its manifest declares.** pnpm's hidden hoist
  (`node_modules/.pnpm/node_modules`) lends every package in the graph to every other, so an undeclared import
  resolves in the consumer and nothing else would notice. The job parses each shipped file with TypeScript's
  `preProcessFile`. `typescript` itself, imported by `src/authz/route-scan.ts`, is today's one exception, a named
  workaround until P3 makes it a peer.
- **The consumer installs from a committed lockfile seed** (`scripts/pack-and-consume/consumer-lock.yaml`), as an
  adopter commits theirs. pnpm keeps every resolution whose specifier still matches and resolves only what changed:
  the tarball, and any range this repo moved. With fresh resolution, a third-party typings release could move the
  framework's strict-error count and turn unrelated PRs red (round 1 of review). When the resolution moves, the job prints a notice
  (not a failure: a Dependabot PR cannot refresh the seed), and `pnpm pack-and-consume --update-lockfile` refreshes
  it. Version ranges come from this repo's manifests, with `minimumReleaseAge: 2880`.
- **The negative fixture runs under tsx**, from `packages/seamless`, which takes the tarball and links no seam.
  It must exit non-zero AND name `@sssb/app-config` in its error, so a failure for any other reason does not
  count as the loud failure part 5 asks for.
- **The app-owned adapter is reached through a route**, `/api/objects`, so `next build` compiles the registry,
  its `import()` of `real/` and the vendor SDK against the packed framework. A unit test did not load the
  registry: the framework's adapters import `server-only`, and the app's `vi.mock('server-only')` did not stop it
  throwing.
- **The consumer stands only on what it installed.** Its commands run with every `PATH` entry under this repo
  removed (through `pnpm pack-and-consume`, PATH starts with the repo's `node_modules/.bin`) and without pnpm's
  `npm_*` variables; the starter is copied from what git sees, so an ignored `.env.local` stays behind; and every
  parent of `--dir` must hold no `node_modules`, `package.json` or `pnpm-workspace.yaml`.

## Publishing from CI, before anything needs publishing (2026-11-17, `ci/release-workflow`)

ADR-0014's P1b: `.github/workflows/release.yml`, Changesets in one fixed group, and `scripts/release.mjs`, which
both the workflow and CI's `release-plan` job run. Decisions the ADR left open:

- **The workflow file is `release.yml`.** npm's trusted publisher on every package names it, so a rename stops
  every publish until each publisher is edited. CanopyCMS's is `publish.yml`; here the file also cuts the release
  commit, and "release" names both halves.
- **Dormant through `privatePackages.version: false`, not through a switch in the workflow.** Every package is
  private until P14, so Changesets plans no release, `plan` reports none and `push` is skipped, and on a tag `pack`
  lists nothing and `publish` is skipped. Taking `private` off in P14 is the whole switch. The cost is that
  Changesets' own plan is empty today, so a check of that plan could never fail; `pnpm release:check` judges the
  plan with private packages versioned instead, which is the plan the packages will release once public.
- **The part 10 `release-commit` job is two jobs, `plan` and `push`.** `plan` installs the workspace and runs
  Changesets, which is dependency code; `push` holds the release app's key. In one job, dependency code could have
  written a `BASH_ENV` into `$GITHUB_ENV` and so run inside the later step that holds the token (the independent
  review found it). `plan` hands `push` a patch, and `push` installs nothing, copies `scripts/release.mjs` out of
  the commit, applies the patch and runs `verify-release`, which works out from HEAD alone which changesets must be
  consumed and what version they imply, and refuses any other change: each released manifest may differ in its
  version line and nowhere else, and changelogs only beside them. A compromised `plan` can still write changelog
  text, and nothing else.
- **`changeset version` runs with `pnpm_config_verify_deps_before_run=false`.** With `format: "prettier"`,
  Changesets formats the changelogs through `pnpm exec prettier`, and pnpm 11, seeing a workspace version changed
  since the last install, first re-installs with every script, the root `prepare` included. Run under
  `pnpm exec vitest`, the setting is already in the environment and hides this, so the test clears it.
- **Every fixed-group package needs `repository.url` from the first PR.** npm requires it to match the publishing
  repository (docs.npmjs.com/trusted-publishers), and a publish refused for it would come after the tag exists, so
  `pnpm release:check` requires it now and `packages/kit/package.json` gains one.
- **The release waits for `checks` twice**: `plan` on the merge commit, as CanopyCMS's does, and `pack` on the
  release commit, because part 10 asks for both apps and pack and consume (a `checks` job since P2) to be green
  on the release commit itself. The wait is one function (`scripts/release.mjs wait-for-checks`), fail-closed: anything
  but a completed, successful push run on `main` for that exact commit keeps it polling until an hour has passed,
  and the workflow requires its `passed <sha>` line, not only its exit code. For that, `checks` no longer cancels a
  push run on `main` when the next push arrives: its concurrency group is the commit for a push and the ref for a
  PR, so PRs still cancel their own older runs.
- **The tag's work is two jobs, not one.** `pack` installs the workspace (with `--ignore-scripts`), lists and
  packs; `publish`, the only job with `id-token: write`, sparse-checks out three files, installs nothing, re-reads
  each tarball's own manifest (fixed group, the tag's version, not private) and layout (plain files under one
  `package/`, at normalized paths), skips a version npm already holds from this commit (so "Re-run failed jobs"
  resumes a release stopped part-way), refuses one npm holds from another commit or a `latest` newer than this
  release, and only then runs `npx npm@11.21.2 publish --provenance`. A compromised dependency therefore runs only
  where there is no OIDC token. CanopyCMS installs and builds in its publishing job. npm's documentation puts the
  floor for trusted publishing at npm 11.5.1, not the 11.5.0 that part 10 and the brief carried over from
  CanopyCMS's comment; the pin is above both.
- **`publish` runs in an environment of its own, `npm-publish`**, separate from `release`, which holds the release
  app's key. npm's trusted publisher binds the repository, the workflow filename and, optionally, an environment,
  but no ref, so any branch can carry a `release.yml`. GitHub admits a job to an environment only on the refs its
  deployment rule allows, so naming `npm-publish` on npm and limiting it to `v*` tags stops an edited `release.yml`
  on a branch; a tag ruleset under which only the release app may create `v*` tags stops one on a tag. Both are
  repository settings, so neither is in this PR.
- **`create-sssb`'s source stays out of this repository for now.** It is the published mistype guard, it prints
  one line and exits 1, and nothing about it is due to change. Bringing it in would add a workspace package that is
  outside the `@sssb/*` group, so it would need either a second release path (a second way to publish, which part 10
  rules out) or a place in the fixed group (a new guard version with every release, for no change). Its trusted
  publisher still names `release.yml`, so if it ever must change, its source comes in then and goes out through this
  file; `scripts/release.mjs` refuses to publish any package outside the fixed group until that is decided.
- **npm does not refuse a private tarball on a dry run.** `npm publish <tarball> --dry-run` (npm 11.21.2) printed
  `+ @sssb/kit@0.1.0` for the packed kit, whose manifest says `"private": true`. So the private check is the
  workflow's own (`preflight`), not npm's.

## Sentry 11, with an explicit v10 data-collection baseline (2026-11-17, `deps/sentry-11`)

- **Sentry 11 is taken now, and `withSentryConfig` moves to `@sentry/nextjs/config`.** This supersedes two
  bullets in the dependency-advisory entry above: "Not taken: Sentry 11", and "`withSentryConfig` stays
  imported from `@sentry/nextjs`", which deferred the move to this upgrade. 11.x no longer exports
  `withSentryConfig` from the package root, so Dependabot's bump (#2) failed to build on that import alone.
- **The upgrade does not widen what reaches Sentry.** v11's unset `dataCollection` and its new default
  integrations collect more than v10 with `sendDefaultPii` unset did, so both framework inits now spread
  `SENTRY_V10_BASELINE` (`packages/kit/src/adapters/sentry/baseline.ts`), which holds collection at or below v10.
  The reasoning is in ADR-0010's 2026-11-17 addendum.

## React 19.3, with the demo budgets raised (2026-11-17, `deps/react-19-3`)

JP's call on 2026-11-17, made to the manager session: take React 19.3 and raise the showcase's static demo budget
to fit it. That lifts the React hold in "Catching up October's minor-and-patch group" (2026-11-16), which left
the call to JP because the budget's own rule reserves a raise for a feature. This replaces the React half of
Dependabot's #1.

- **Every declaration moved in one commit.** `react` and `react-dom` go to `~19.3.1` in the root and both apps,
  `@types/react` and `@types/react-dom` to `~19.3.0` in the root, and `@sssb/kit`'s `react` peer to `~19.3.1`.
  The kit declares no `@types/react` peer yet (ADR-0014 part 2 moves it there,
  `docs/adr/0014-distribution-as-versioned-packages.md:424`). #1 moved the apps and not the
  kit's peer, and the kit kept its own React: unit tests failed with "mismatching versions of React and the
  renderer", the starter's e2e lost next-intl's provider, and the static demo bundled two Reacts (1,012,958
  bytes; #1's checks run 44171028375).
- **One copy of each singleton, checked by realpath.** From `packages/kit` and from each app, the nearest
  `node_modules/<pkg>` of `react`, `react-dom`, `next`, `next-intl`, `@mantine/core` and `@types/react`
  resolves to one directory each (build-notes' `readlink -f` check, run over the three importers). Seen to
  fail: with the kit's peer put back at `~19.2.8` and `pnpm install` run, the kit got `react` 19.2.9 and its
  own `next`, `next-intl` and `@mantine/core` with it, four of the six forked.
- **The budgets.** The showcase's demo grew 29,332 bytes on React's own code, 804,574 on main (after Panda 2)
  to 833,906, and its budget goes 840,000 → 860,000 by its rule of about 3% over what it measures (3.0%, 26,094
  bytes). The starter's grew 29,331, 727,778 to 757,109; its budget is sized as room to grow to the showcase's
  size, rounded up, so it goes 820,000 → 840,000 (9.8% headroom). Each was raised in its own commit, the
  showcase's recorded in its history section above ("The showcase's demo size budget history") and the
  starter's in `apps/starter/DEMO-SIZE.md`. Both numbers still sit below the unpruned demos (984,317 and
  908,510 bytes), so a pruning that stops still fails the gate. The branch first set 874,000 and 850,000
  against the showcase's pre-Panda-2 size (847,534); merging Panda 2 in shrank it, and the numbers were re-set
  so the showcase's stays a pacing gate.
- **Pack and consume's lockfile seed moved with it.** `pnpm pack-and-consume --update-lockfile` re-resolved the
  consumer to React 19.3.1, its types and `scheduler` 0.28.0. The rest of the change to
  `scripts/pack-and-consume/consumer-lock.yaml` is peer suffixes naming the new React and the packed kit's
  integrity hash; no other package's version moved, and the full run passed.
- **`@axe-core/playwright` stays held at `~4.12.1`.** The other half of #1 is not decided:
  4.14's `label-content-name-mismatch` fails twelve showcase e2e tests, and the fix and the way to lift the
  hold are still `.claude/future-tasks/resolved/label-in-name-axe-4-14.md`.

## Copyright assigned to Rice University (2026-11-17, `chore/copyright-rice`)

ADR-0014's D3: JP Slavinsky assigns SSSB's copyright (keel's, before the rename) to Rice University, and the licence
stays MIT. This change records the assignment: `LICENSE` now reads "Copyright (c) 2026 Rice
University". JP opens and merges the PR that records it, with a commit he authored. `tests/docs/adopter-identity.test.ts` checks that an adopted
tree keeps the notice verbatim, as MIT requires, so it now expects Rice University. ADR approver lines keep JP's
name: they record who decided. This lands before P7, whose release-candidate tarballs carry the `LICENSE`.

## A second npm owner is not needed (2026-11-17, `chore/post-p2-cleanup`)

JP's call on 2026-11-17: the `sssb` npm organization and its packages keep `safeinsights-bot` as their only owner,
and no second owner is added. The account's credentials are shared among the maintainers and its email is a group
address, so losing one person does not lose the account. That answers the known risk ADR-0014 recorded on
2026-11-17 ("The npm names have a single owner"), which rested on JP having no personal npm account and said a
second, human owner would be added once a maintainer had one.

- **ADR-0014 gets a dated addendum, and its body is untouched.** The addendum says the Consequences bullet no
  longer describes a risk to carry and that the follow-up "add a second, human owner" is dropped.
- **Nothing that would let someone reach the account is written here or in the ADR**: no credential, address or
  place where one is kept. Where the credentials live is the maintainers' to know.
- **Releases do not depend on it.** Publishing runs from GitHub Actions through trusted publishing (D11), so the
  shared credentials are for administering the names, not for shipping a version.

## Package hygiene (2026-11-17, ADR-0014 P3, `chore/package-hygiene`)

- **A `files` allowlist, with the conformance suites re-included by name.** `packages/kit/package.json` ships
  `src` minus every `*.test.*` and `*.stories.*` file, then names the five seam-conformance suites
  back in. `pnpm pack` went from 293 files on main (2242a28) to 191: the 45 files of the test fixture and 60
  test and story files no longer ship, and the scratch-directory helper's three files (below) now do. The suites
  list lives once, in `CONFORMANCE_SUITES` (`scripts/pack-and-consume/checks.mjs:29`); a unit test
  (`tests/tooling/pack-and-consume.test.ts:243`) holds the list to exactly `src`, the two negations and these,
  and pack and consume checks the tarball itself (`shippedFileProblems`, `checks.mjs:43`). P5 replaces the suites
  with `@sssb/kit/testing`.
- **The strict set runs in this repo too, over the whole of `packages/kit/src`.** `packages/kit/tsconfig.strict.json`
  turns on part 2's nine options at the ES2022 lib floor, and `pnpm typecheck` runs it, so a regression fails
  `pnpm verify` and CI's `lint-typecheck-unit` before pack and consume sees it. Tests and stories are in it, because five tests ship and P5
  ships more. 191 errors in `packages/kit/src` were fixed (this step's base source, typechecked under this config):
  122 index-signature accesses written with brackets (and one more in `tests/support/contract-postgres.ts`, which
  the contract tests bring into the program), 11 parameter properties written as fields, and the rest
  possibly-undefined values handled by a guard that throws
  where the invariant holds, a conditional spread, or an optional property declared `| undefined` where
  `undefined` is part of its contract. No non-null assertion and no suppression. Pack and consume's baseline of
  122 is gone: any error inside the framework fails its strict typecheck.
- **`@types/node` is a peer, beside `@types/react`.** Part 2's rule is that the types of host singletons are peers,
  and the rest dependencies; `@types/node` declares globals the way `@types/react` declares JSX, so two copies in one
  program conflict. Its range, like the others', is the one this repo tests (`^26.6.5`); an adopter on an older
  `@types/node` gets a peer warning until a test widens it. The peers parts 2 and 5 name are peers too, at this
  repo's ranges: `@types/react` `~19.3.0` and `typescript` `~6.0.3` (part 2), and `kysely` `^0.29.7`, moved from
  `dependencies` because an app's migrations receive the framework's `Kysely` instance (part 5). `@types/pg` is a
  dependency. So the peers are `react`, `next`, `next-intl` and `@mantine/core` (as before), `kysely`,
  `@types/react`, `@types/node` and `typescript`, plus `vitest`, optional (below); `@types/node` and `vitest` are
  this step's additions to the set the ADR names.
- **`vitest` is an optional peer.** Shipped files import it: the five conformance suites, and the
  scratch-directory helper moved into the package (`packages/kit/src/testing/tmp-dir.ts`, internal, not in
  `exports`), which the demo-presets suite uses. Pack and consume's undeclared-import check would otherwise fail
  on it, rightly. `@sssb/kit/testing` (P5) needs the same peer.
- **The helper moved; the repo's copy re-exports it.** 24 of the framework's files imported
  `tests/support/tmp-dir`: 23 tests and the demo-presets conformance suite (part 2's 23, at 6d67a7c, counted the
  test files importing anything from the repo's `tests/`). They import the package's own module now, and
  `tests/support/tmp-dir.ts` re-exports it for the repo's and the apps' tests until P4 moves it into
  `@sssb/tools`. The leak guard reads the marker suffix from the package.
- **A lint rule holds the package's edge.** `sssb/no-path-out-of-package` reports, from any file in `packages/kit`
  (fixture included), a relative or absolute path or a `file:` URL that lands outside it (a landing in app code is
  `sssb/no-path-to-app-code`'s); an absolute path or `file:` URL into it, which names this checkout; and, from a
  shipped file, a path to one the `files` allowlist leaves out (a test, a story, the fixture, a config beside
  `src`), with `package.json` and `LICENSE` counted as shipped whatever `files` says. A `/// <reference path=…>`
  or `types=…` counts as a path, in any case and with its attributes in any order, and a relative path's `?query`
  or `#hash` is dropped before it is judged (`packageEdgeFinding`, `eslint.config.mjs:744`). The two real-Postgres
  contract tests are its only exemptions, by name: they start their server through `tests/support/contract-postgres.ts`,
  which needs `scripts/ports.mjs`, and P5 moves that runner into the package. Neither ships.
- **What the review left for later steps.** The options the framework needs beyond the strict set (`strict`,
  `moduleResolution: "bundler"`, `jsx`, `dom`, `skipLibCheck`) are written in `packages/kit/tsconfig.strict.json`'s
  header and in the `tsconfig-written` workaround (`scripts/pack-and-consume/workarounds.mjs:36`), and P4's
  tsconfig base is where an adopter gets them. `dedupePeerDependents: false`, which the consumer's workspace sets,
  is a registered workaround now (`dedupe-peer-dependents-written`, `workarounds.mjs:68`, P12). `src/authz/route-scan.ts` and `src/adapters/real/rds-data-emulator.ts` ship
  but nothing shipped reaches them; P5's `@sssb/kit/testing` is what will.

## The release app, made by a script (2026-11-17, `ci/release-app-setup`)

`release.yml` (P1b) needs a GitHub App whose token pushes the release commit and its tag. JP asked to make it the
way CanopyCMS makes its App, by GitHub's App-manifest flow from a script, not by hand in settings.
`pnpm release-app:init` (`scripts/release-app.ts`, `scripts/release-app/`) is that script, with
`docs/runbooks/release-app.md` and the `release-app` cutover row. Decisions:

- **Borrowed, not shared.** The loopback callback server, the manifest form, the JWT over `node:crypto` and the
  read-back come from CanopyCMS's `src/cli/init-github-app.ts`, adapted rather than imported: Canopy's is a
  per-site tool for adopters, and this one has one fixed repository and one fixed destination for the key.
- **The key goes to `gh secret set` on stdin and nowhere else.** No file, no argv, no output. If `gh` fails, the
  operator retries while the key is in memory; giving up costs one "Generate a private key" on the App's page.
  Canopy also offers a key file as a fallback; this does not, so the only file the script writes is the creation
  form (the manifest, no key), in a private temporary directory it removes. A failed manifest exchange (no answer,
  or a GitHub error) is retried too, since only this process holds the one-time code.
- **The client id is a variable, not a secret.** `release.yml` reads `vars.RELEASE_BOT_CLIENT_ID`, and a client id
  is not secret.
- **Who the App is, checked before anything trusts it.** The exchange's answer is checked before the key is stored
  (owned by safeinsights, exactly `contents: write` and `metadata: read`). `bypass` and `verify` take `--app-id` on
  the command line, so both look that id up in the organisation's installations, with the client id the
  environment holds, on selected repositories, with exactly those permissions: a typo, or another App's id, never
  becomes the bypass on `main`.
- **The token asks for the App's permissions explicitly** (`permission-contents: write` on
  `create-github-app-token`), so an App widened later mints nothing wider in `release.yml`.
- **Four rulesets, not two.** A bypass covers every rule in its ruleset. Adding the App to `release tags: v*` as it
  stood (creation, update, deletion, non-fast-forward) would have let it move and delete release tags, and the App
  must also bypass the organisation's `require-pr`, which carries deletion and non-fast-forward on `main`. So the
  rules the App passes and the rules nobody passes are split: `release tags: v*` keeps creation (App bypass), new
  `release tags: v* immutable` holds the rest (no bypass), and new `main: history` re-states deletion and
  non-fast-forward on `main` with no bypass. The script creates the no-bypass ones first. `main: required checks`
  may hold only its checks, or the App would bypass whatever else was added there.
- **The script never changes an organisation ruleset.** `require-pr` is shared by the org's repositories and needs
  `admin:org`; the script lists it, and `verify` fails until it lists the App as "Always allow" and no other
  actor. It also reports any other ruleset the release's push would meet (on `main`, or a tag ruleset that might
  cover a release tag, judged generously), so `verify` cannot pass while the push would be refused.
- **The drift guard pins the job that holds the key.** Canopy's guard drives its worker against a recording proxy;
  the only consumer here is a workflow, so `tests/tooling/release-app-drift.test.ts` parses every workflow file
  (the `yaml` package, a new root devDependency). It began as rules alone, a deny-by-default reading of the shell in
  the step holding the token; each review round then found shell forms it let through (`PATH=`, `printf -v`, a
  step before the mint writing `$GITHUB_ENV`, `container:`, a moving action ref). So the `push` job is pinned by a
  hash of its parsed form, and any edit to it fails until it is re-reviewed; the rules stay, to say why the pinned
  job needs exactly the App's permissions and to cover what lies outside that job (triggers, other jobs and
  workflows, environment names in any case). In-memory mutations of the real workflow show the rules failing.
- **What the key is worth is written down.** The App bypasses review and checks on `main`, so its key can land a
  fast-forward commit there (including a merge through the API) and tag it, which starts a publish; it cannot
  change workflow files. The runbook says so, and names a required reviewer on `npm-publish` as the setting that
  would still stand between a stolen key and npm. That setting is JP's call and is not made here.

## Transitive dependency advisories, handled by reach (2026-11-17, `deps/advisories`)

JP's call on 2026-11-17: "address the transitive dependencies appropriately with judgement". Before this branch
`pnpm audit` reported 37 advisory entries (33 distinct GHSA ids; 3 low, 10 moderate, 24 high), 18 of them in the
`--prod` graph, every one in a transitive dependency. After it, 2 remain, 1 of them in the `--prod` graph. Only
`pnpm-lock.yaml` changed: no `package.json` range, no `pnpm.overrides` entry.

- **The policy.** An advisory whose package reaches shipped code is fixed whenever a fix exists, preferring a
  lockfile refresh, then a parent upgrade, then a `pnpm.overrides` entry that names the advisory, why, and when to
  remove it. "Shipped" means an app's server or client bundle, the migrator Lambda, the static demo, or the
  `--prod` graph of `@sssb/kit` and the apps, which an adopter installs even when only its build tooling runs
  it. A dev-only advisory (lint, commit hooks, Ladle, tests) is fixed when a lockfile refresh or a safe patch
  bump does it, and otherwise accepted and recorded here. An advisory with no patched release is accepted and
  rechecked when one appears. `minimumReleaseAge` is not bypassed for a fix, and no hold recorded in this log is
  raised for one.
- **Reach was measured, not inferred.** None of the twelve affected packages appears in what ships: the
  showcase's simulated `next build` (its `.next/server` and `.next/static` chunks and its standalone trace), the
  static demo's Rollup module graph (31 packages: React, Mantine, next-intl's runtime, floating-ui, valibot and
  their helpers), or an esbuild bundle of the migrator entry with `infra/stack.ts`'s options (kysely and `pg`).
  The 18 `--prod` entries reached the graph through build tooling: `postcss` and `styled-jsx`'s Babel under
  `next`, webpack's `schema-utils`/`ajv` under `@sentry/nextjs`'s bundler plugins, `@rollup/plugin-commonjs` and
  `@sentry/cloudflare`'s `vite` under `@sentry/nextjs`, `@parcel/watcher` under `next-intl`, and `zod` as the
  `@anthropic-ai/sdk` optional peer that this workspace's `autoInstallPeers` installs. The SDK imports `zod` only
  in its `helpers/zod` and `helpers/beta/zod` modules, and SSSB imports only the package root
  (`packages/kit/src/adapters/real/llm.ts:1`); pack and consume's adopter install does not install `zod` at
  all.
- **Fixed by refreshing the lockfile inside the parents' existing ranges:** `fast-uri` 3.1.3 → 3.1.9 (12
  entries), `browserslist` 4.28.5 → 4.29.5 (2; 4.29.6 is younger than the release-age window), `nanoid` 3.3.16
  → 3.3.20, `source-map-js` 1.2.1 → 1.2.2, `zod` 4.4.3 → 4.6.7, `brace-expansion` 1.1.16 → 1.1.22 and 5.0.8 →
  5.0.13 (9), `js-yaml` 4.3.0 → 4.3.2 (2), Ladle's `vite` 6.4.3 → 6.4.6 (5), and Ladle's `query-string` 9.4.1 →
  9.5.1, which is inside Ladle's `^9.1.1` and moves `decode-uri-component` 0.4.1 → 0.5.1 (2).
- **Accepted: GHSA-fc5q-39xc-vjpf, `picomatch` ReDoS (high, `--prod`).** No patched release exists: 4.0.7 and
  2.3.2 are the newest of their lines and both are affected. It is reached through file watching and globbing
  (`@parcel/watcher`, `@rollup/plugin-commonjs`, `vite`, `tinyglobby`). `next-intl`'s plugin requires
  `@parcel/watcher` when it loads, so any process that evaluates `next.config.ts` loads it, a plain `next start`
  included; the standalone server does not evaluate it, and its trace holds no `picomatch`. The advisory needs a
  hostile glob pattern, and every pattern here comes from configuration, never from a request. Recheck when a
  fixed `picomatch` is published.
- **Accepted: GHSA-g3hv-75wg-m249, `minimatch` (moderate, dev-only).** `typescript-eslint` 8.72's estree takes
  `minimatch` `^10.2.2`; the fix is in 11.0.1, which only `typescript-eslint` 8.73.0 takes, published
  2026-11-16 and still inside the two-day release-age window. ESLint globs are this repository's own. The next
  `typescript-eslint` refresh clears it; an override forcing a new major onto a transitive dependency was not
  worth it for a dev-only moderate.
- **Next's vendored copies are outside `pnpm audit`.** `next/dist/compiled` carries its own `zod`, `nanoid` and
  `picomatch`, without versions an audit can read. They move only with `next` itself. Next's `picomatch` does run
  at request time: `/_next/image` matches the requested URL against `images.remotePatterns` and `localPatterns`
  (`next/dist/shared/lib/match-remote-pattern.js`). Those patterns are configuration, and neither app sets
  `images`; an adopter who writes an extglob there should check it against GHSA-fc5q-39xc-vjpf.
- **No standing audit gate on pull requests.** `pnpm audit --prod --audit-level high` is red today on the
  unfixable `picomatch` entry, and with that one ignored it would still turn every open PR red on the day any new
  advisory is published, whatever the PR touches. Advisories reach SSSB through Dependabot and through review
  instead (the Next upgrade advisor is off; see "Next's upgrade advisor is switched off" above).

## `pnpm tick`, and a dev ticker that is opt-in (2026-11-17, `feat/pnpm-tick`)

JP asked for both on 2026-11-17, with the ticker as an option, and asked whether it should be the default. It is not.
This is the "next step if it is wanted" that "`pnpm dev` without the Simulator has no tick source" (above) left.

- **`pnpm tick` calls the route; it adds nothing to it.** `scripts/tick.mjs` POSTs the app's `/api/webhooks/cron` with
  `Authorization: Bearer <the per-checkout dev secret>` from `<app>/.data/auth/webhook-secret`, which is how
  `withWebhookSecret` authorizes any caller in a simulated world. No bypass, no flag the server reads, and nothing in
  `packages/kit` or an app's `src` changed. The first request to a server is what creates the secret, so with none on
  disk it sends one throwaway bearer first. `--url` accepts only loopback hosts over http, so the secret cannot be sent
  anywhere but this machine, and a server in real mode (`WEBHOOK_SECRET`, no secret file) answers 401 with the reason.
  Exit codes: 0 ticked, 1 the tick failed (unreachable, 401, non-2xx, a body that is not JSON), 2 a bad command line.
  A schedule or delivery that FAILED inside a successful tick is printed and exits 0: the tick ran, and the next one
  retries it.
- **The ticker is a wrapper around `next dev`, not code in the app.** `pnpm dev` runs `next dev` through
  `scripts/dev-tick.mjs` in both apps; with `DEV_TICK_SECONDS` unset it only starts the command, forwards SIGINT, SIGTERM and
  SIGHUP, and exits with its code. (SIGINT is forwarded even though a terminal's Ctrl-C also reaches the server directly:
  the wrapper is now the pid a supervisor holds, and swallowing it left `kill -INT` unable to stop `pnpm dev`; found by
  review, and the SIGINT case seen failing with it unforwarded.) Putting it in the app would have meant reading `process.env` in `src`, which is lint-banned. The name is a count of seconds rather than a
  `=1` flag like `E2E_BUILD` and `DEMO_MODE` because those pick a build and this takes a number; anything that is not a
  whole number of 1 to 86400 is an error before the server starts, not a silent no (a typo for another unit, and far below the ~24.8 days
  where `setTimeout`'s 32-bit limit overflows and the loop would tick continuously; seen with 9999999).
- **Off by default, and why.** (1) The showcase's Simulator controls the world clock in a demo: a ticker firing digests
  on real time underneath it changes when a presenter sees them fire. (2) The e2e suites expect a scheduler that does
  nothing until a test asks, so a background tick could land between a test's two steps. (3) Hermetic dev should not
  do work nobody asked for. Opt-in costs one environment variable for someone who wants it; default-on would put every
  one of those three at the mercy of a timer.
- **It cannot run where it must not.** Both playwright configs start `pnpm dev` with `DEV_TICK_SECONDS` blanked, so a
  value exported in a developer's shell never reaches an e2e server; a test reads the configs for it. A ticker asked
  for with `E2E_BUILD` or `DEMO_MODE` set is refused with a message. The e2e and demo servers (`start:e2e`,
  `start:demo`) do not go through the wrapper at all, and the `file://` static demo has no server to tick. The blank
  cannot reach a server Playwright did not start, and off CI it adopts one already on its port
  (`reuseExistingServer`), so a ticking server you left running would be tested against. While a ticker runs it
  leaves `<data dir>/dev-ticker.json` (pid, interval), and both playwright configs throw at load if that pid is alive;
  a marker whose process is gone (a SIGKILLed wrapper) is ignored. Found by review; a test loads the real configs both
  ways. The marker lives in the data directory, so wiping `.data` under a running ticker removes it too; that is already a
  broken setup (the showcase's destructive spec wipes `.data` itself, `apps/showcase/playwright.config.ts:72`), and the
  guard then has nothing to see.
- **The ticker is one module with start, stop and status, for a Simulator control later.** `scripts/ticker.mjs`
  (`createTicker`) owns the loop, the interval bounds, the dedup of repeated errors and the marker; it reads no
  environment. `scripts/dev-tick.mjs` is the policy for `pnpm dev` and its only caller. JP asked whether the Simulator
  can start it from its UI: not in this change (the panel is in `packages/kit`, which P3 is editing), but the shape is
  there for it, and `.claude/future-tasks/resolved/simulator-ticker-control.md` has the design, including why the control must
  keep it off by default and out of e2e and the static demo.
- **`init-app` learned the second root script.** Root `tick:starter` is renamed with the app (`tick:<slug>`) and, when
  the showcase is ejected, dropped as a duplicate of `tick`, as `dev:starter` already was; each seen failing against the
  old `init-app` in `tests/docs/adopter-identity.test.ts`.
- **Two things CI found that the local run could not.** (1) The adoption probe runs the whole suite in a tree `init-app`
  has renamed and ejected, where `apps/showcase` and `apps/starter` do not exist; the tick tests named them. They now
  read the app directories of the tree they run in (and the PORT key from the app's own `dev` script, which `init-app` does
  not rename), and ran green in an `init-app acme --eject-showcase` copy. (2) Pack and consume's consumer workspace
  holds only the scripts it is told to copy, and the starter's Playwright config now imports `scripts/ticker-marker.mjs`:
  typecheck failed with "Cannot find module". A new named workaround, `tick-scripts-copied`, copies the four tick scripts,
  removed by P4 with the rest (`sssb tick` in `@sssb/tools`); ADR-0014's table of what moves to `@sssb/tools`
  (`scripts/ports.mjs` and the like) has no row for them yet.
- **Lint.** The `scripts/**` block gained the globals these two scripts use (`fetch`, `URL`, `AbortController`,
  `AbortSignal`, `setTimeout`, `clearTimeout`).

## Label in Name fixed, and the axe hold lifted (2026-11-18, `fix/axe-label-in-name`)

JP approved the fix on 2026-11-17. It closes `.claude/future-tasks/resolved/label-in-name-axe-4-14.md`, the reason
`@axe-core/playwright` was held at `~4.12.1` (the "held at `~4.12.1`" entries above).

- **The hold is lifted.** `apps/showcase/package.json` has `^4.14.0` again, and `.github/dependabot.yml` no longer
  ignores minor and major updates to it. The React rules there stay. 4.14.0 is the newest stable release, published
  2026-10-15, well past the two-day `minimumReleaseAge`.
- **Each control's accessible name starts with its visible text,** in both locales: the team switcher "{team}, switch
  team", the account menu "{user's full name}, account menu" (the email if the name is blank), the Simulator pill
  "Simulator, open the panel" or "Simulator, 3 unread emails, open the panel", and the Hide button "Hide the
  Simulator panel".
- **Three of them are named by content, not by `aria-label`.** axe 4.14 compares an `aria-label` with the text on
  screen, word by word and in order, and it counts `aria-hidden` text. The switcher shows initials before the team
  name, the account menu shows only initials, and axe joins the pill's label and badge into one word ("Simulator1").
  No sensible `aria-label` contains those, and the rule only applies where there is one. The switcher's and pill's
  names are their visible text plus a visually hidden suffix, so they cannot drift from the screen; the account
  menu's is all visually hidden. Only the initials and the pill's badge are `aria-hidden`.
- **Avatar initials are decorative.** They are WCAG 2.5.3's "symbolic text characters" case. `PreviewRow`'s avatar is
  `aria-hidden` wherever it appears; a voice-control user says the person's or team's name. A checker that compares
  the computed name (ACT rule 2ee8b8) may still flag the account menu, whose only visible text is initials.
- **The pill's badge uses the name's number format** (`useFormatter().number`, as ICU's `#` does: "1,000" in en). The
  notification bell's plain `{count}` renders "1000", like its badge, so it stays as it was.
- The keyboard pass found that opening or hiding the Simulator panel drops focus. That was already on main; it is
  `.claude/future-tasks/resolved/simulator-panel-focus-on-toggle.md`.

## `@sssb/cdk` and per-app infra (2026-11-18, ADR-0014 P9, `feat/sssb-cdk`)

- **`SssbApp` is a construct with five props** (`appDir`, `slug`, `params`, `environment`, `production`). Rejected:
  reading the `environment` context inside the construct, as the old stack did. Which environments exist is the app's
  policy (Pages has its own), so `infra/app.ts` reads and checks the context and hands the construct a name and a
  boolean.
- **The construct's id is `Default`** in both apps, so logical ids stay as they were (ADR-0014, addendum 2026-11-18).
  Rejected: a descriptive id such as `App`, which would have renamed every resource and made the first deploy after P9
  replace the database and the VPC.
- **The seam reaches esbuild as an alias alone; the app's tsconfig is no longer passed.** Rejected: passing both. Seen
  failing without the alias: the bundle then names neither the app's migration registry nor any of its four migrations,
  and the synth fails on each.
- **Kit resolution and the assembly checks come from `@sssb/tools`** (`@sssb/tools/kit`'s `kitDirOf`,
  `kitVersionOf` and `resolveAppsKit`, which P4 published for this; `@sssb/tools/assembly-checks`): `@sssb/cdk`
  depends on `@sssb/tools`, a plain dependency. Rejected: a resolver of `@sssb/cdk`'s own, which would split rule 4's
  one shared check in two, and a peer dependency, the form ADR-0014 part 10 warns can lift the fixed group to 1.0.0.
  Part 10 says the packages carry no dependency on each other; the probe it calls for, a `minor` and then a `patch`
  changeset on `@sssb/tools` through `pnpm release:check`, planned the same step for all three packages and nothing
  at 1.0.0 (ADR-0014, addendum 2026-11-18, P9). P4's resolver walks `node_modules` from the app rather than calling
  `require.resolve`, which matters here: the construct runs under `pnpm exec`, which sets `NODE_PATH` to the
  hoisted store.
- **`check-shapes` became `packages/cdk/src/sssb-app.test.js`, a Vitest project of its own (`cdk`)**, which discovers
  every `apps/*/infra` and synthesizes both shapes for each. It reads `DATABASE_ENV` from the `@sssb/kit` each app
  resolves (by file, since it is not a published subpath), so it keeps the runtime and the infra from drifting on a
  name. `init-app` reserves the slug `cdk` with `kit`, since a project of that name would collide.
- **Each app's infra is outside the app's vendor fence** (`APP_INFRA_GLOB`), as ADR-0014 part 8 asked: a CDK custom
  resource there may call the AWS SDK. Pinned in `tests/lint/extensions.test.ts`, and seen failing without the
  carve-out.
- **`@sssb/cdk` typechecks under every flag of the framework's strict set but `exactOptionalPropertyTypes`**
  (`packages/cdk/tsconfig.json` against `packages/kit/tsconfig.strict.json`), which aws-cdk-lib's own declarations
  fail: six errors, every one between two of CDK's own types (`Vpc` against `IVpc`, `Bucket` against `IBucket`,
  `DefaultStackSynthesizer` against `IStackSynthesizer`, and the props objects that carry them). It ships
  JavaScript and a declaration file, so an adopter's flags never reach its sources.
- **`init-app` renames the app's infra package** (`<slug>-infra`) with the app, and refuses a slug that names one.
  Nothing else in an app's `infra/` names the app, so nothing else is rewritten.
- **CI synthesizes with `--fail-if-no-match`**, because `pnpm --filter` with no match exits 0: a tree whose apps all
  lost their `infra/` would otherwise pass the synth step having run nothing.
- **Pack and consume copies `apps/starter/infra` but does not install or synthesize it**: the consumer's workspace lists
  `apps/*` and `packages/*`, and `@sssb/cdk` is not packed. The construct's synth assertions are what catch a wrong
  kit or a wrong seam in a consumer; proving that from tarballs is P12's, when the generator ships the starter's
  `infra/`.
- **What the reviews added, each seen failing in `packages/cdk/src/sssb-app.test.js`.** The independent review asked
  whether a stack could run with fake adapters, the wrong app's migrations or another app's seam while every check
  passed, and found no accidental route; the code review found no HIGH. The construct now also refuses: a `slug`
  other than the `APP_SLUG` the app's `config/app.ts` declares (a root `infra/` composing several apps could pair one
  app's directory with another's slug); an app whose linked `@sssb/app-config` is not its own `src/app-config`; a
  migrator whose deployed `Code` is not the bundle this synth staged (an escape-hatch override); a migrator
  environment carrying `DEMO_MODE` or `E2E_BUILD`; and a `production` that is not a boolean, which in JavaScript
  silently gave the destructive non-production defaults. The migration names it expects are the index's literal keys,
  comments left out; an index with migration files beside it and no literal key, whose computed keys made the check
  expect nothing, is refused (seen, in a scratch app). Round 1's first answer, also expecting every migration file's
  name, was rejected in round 2: a migration registered under a key other than its file name, or a draft file not
  registered yet, would fail the synth for nothing.
- **Local bundling only, and the construct checks for it.** It refuses a project root (the lock file's directory)
  with no `node_modules/esbuild`, and a framework installed outside that root, each with a message saying what to
  change (`docs/build-notes.md`, P9). Rejected: an alias relative to the working directory, which in Docker is `/`,
  not the project root, and which `NodejsFunction` does not let a caller change; and round 1's first answer, an
  `esbuild` dependency of `@sssb/cdk`, which round 2 showed is not what CDK runs.
- **The deployed migrator's `Code` is compared with the asset's own bucket and key, as the synthesizer assigned
  them**, not with `<asset hash>.zip`, which round 2 showed fails under a synthesizer's `bucketPrefix` and under the
  legacy synthesizer. A stack with `bucketPrefix: 'apps/'` synthesizes in the test.
- **Accepted, not closed:**
    - App source can still import from `apps/<app>/infra`, which the vendor fence no longer covers; the
      `tests/contract` carve-out has the same shape. No import pattern bans it without also banning an app's own
      module that happens to be called `infra`.
    - The VPC's `Name` tags carry the construct path (`…/Default/Vpc`), so they change in place on the first deploy
      after P9.
    - What synth cannot see (the server's uploaded zip, a synth with validation off, changes after synth, a seam
      index that brings in another app's registry, re-exported by an app with no migration files of its own or
      spread beside a literal key) is
      `.claude/future-tasks/deployed-artifact-identity.md`.
    - A project whose only esbuild is a global one is refused, though CDK would bundle with it locally.
    - The migration-key regex reads text: a `//` or `/*` inside a key's string can hide later keys from the check
      (it then fails closed if none is left), and a comment directly after a quote can count a key that is not
      there (a false alarm, never a pass).
- **Found, not this branch's:** `defaultDatabaseName` is the slug, and `init-app` accepts dashes, which an Aurora
  database name cannot hold. A follow-up.

## `@sssb/tools` (2026-11-18, ADR-0014 P4, `feat/sssb-tools`)

P4 of ADR-0014: the `sssb` CLI, the helpers any workspace package imports, the Next, Vite and Vitest presets and the
tsconfig base, as `packages/tools` (`@sssb/tools`, `private` until P14, in the Changesets fixed group). Both apps use
them; `scripts/` keeps only what is this repository's own (`init-app`, `release`, `release-app`, `pack-and-consume`).

- **JavaScript with hand-written declarations, and no build.** Every module is ESM with `// @ts-check`, and each
  published entry has a `.d.ts` beside it that the JavaScript is annotated against, so the root `tsc` checks the
  implementation against its contract. A build step was the alternative ADR-0014 allows ("written in TypeScript and
  built when packed"); without one, the bin and the presets run from source inside this repository too, where a
  workspace link would otherwise need a build before any app script could start. Pack and consume checks that the
  tarball ships only JavaScript, declarations and the tsconfig base (`toolsShippedFileProblems`).
- **One resolver, `packages/tools/src/kit.js`.** It finds the app's `@sssb/kit` by walking `node_modules` up from the
  app's directory, as Node's lookup does, and checks that every framework file a tool loads has its real path inside
  that directory. It started as `require.resolve(…, { paths: [appDir] })`, as the ADR wrote it; the tests found that
  pnpm's bin shims (`node_modules/.bin/<bin>`, which `pnpm exec <bin>` and package scripts run) set `NODE_PATH` to the hoisted `.pnpm/node_modules`, which Node's resolver falls back to,
  so an app with no framework of its own resolved the hoisted copy, another app's instance: the slip rule 4 exists for.
  The walk never reads `NODE_PATH`. Its users are the `dev:real` preflight, the Next preset's next-intl request path
  and `sssb guide`. `sssb/no-bare-kit-import` bans a literal `@sssb/kit` specifier (declarations, `import()`, type
  imports, `require`, any `.resolve('…')`, Vitest's loaders) in every package under `packages/` but the framework and
  the showcase's seed, deny-by-default, so P6's and P9's packages are covered before anyone names them; seen red on a probe in each form `tests/lint/no-bare-kit-import.test.ts` lists.
- **A preset configures the app's own tools.** The Vite preset loads `@vitejs/plugin-react` and
  `vite-plugin-singlefile`, the Vitest preset the React plugin and jest-dom, and the Next preset next-intl's plugin,
  each resolved from the app's directory, so `@sssb/tools` never brings a second copy of them; its only peers are
  optional: `next` and `vite` for its declarations' types, `vitest` for the scratch-directory helper's `afterAll`. jest-dom goes to Vitest as the bare specifier, not a resolved path: resolved with Node's
  `require` conditions it is jest-dom's CommonJS build, which cannot load Vitest.
- **The Vite and Vitest presets pass the seam explicitly** (`@sssb/app-config` to the app's `src/app-config`), as the
  ADR says every SSSB builder does: the same directory as the link in an adopter's app, the only way in this
  repository. The Next preset does not, since `next build` resolves the seam through the app's tsconfig `paths` here
  and the link in an adopter's app. Pack and consume therefore proves the link through `tsc`, `next build`, the
  migrator bundle and the negative fixture, and no longer through Vitest.
- **The Next preset takes the app's directory** (`withSssb(config, { appDir: __dirname })`). Its default, the working
  directory, is the app's when Next loads the config, but knip loads it from the repository root, and the next-intl
  request path came out relative to the wrong directory.
- **Each app declares its port slot** in its package.json (`"sssb": { "port": "starter" }`). `sssb port` with no
  argument reads it, as do `sssb serve-standalone` and `sssb launch-json`, so the dev server, the standalone server
  and the browser pane read one declaration. The slots are unchanged (showcase, starter, ladle, contractPg) and still
  name a slot, not an app, so `init-app`, which leaves the declaration as it is, needs no change. The browser pane's
  configurations are named `<app directory>-dev`, so the showcase's `app-dev` is now `showcase-dev`.
- **The `dev:real` preflight is bundled by esbuild** (`sssb check-real-env`), as CommonJS, with every package but the
  framework and the app's own source left external at the path esbuild resolves from the importing file, preferring
  each package's `require` entry. Under plain Node two packages fail otherwise: `@clerk/nextjs`'s ES build imports
  directories, which Node refuses, and `pg`'s CommonJS has no named exports for an ES `import { Pool }`.
- **The tsconfig base sits at the ES2022 floor** (target and lib) and carries the compiler contract
  `packages/kit/tsconfig.strict.json`'s header measured. Both apps extend it and typecheck there; they had `esnext` from
  the root config before. The root config extends it too and raises `lib` to `esnext` for the repo's scripts and tests.
- **The tick scripts moved into `@sssb/tools`** (`sssb tick`, `sssb dev-tick`, `@sssb/tools/ticker`,
  `@sssb/tools/ticker-marker`), in a commit of their own: every app with a scheduled-tick route needs them, and the
  starter's Playwright config imports the marker. ADR-0014's table had no row for them (`pnpm tick` merged after it).
  Their logic is unchanged: against `scripts/`, the diff is imports, entry points, comments, the usage text, and three constants no longer exported (for knip).
- **The framework keeps its own scratch-directory helper** for its tests, the shipped conformance suites among them,
  because the framework depends on no other SSSB package; everyone else imports `@sssb/tools/testing/tmp-dir`. The two marker
  suffixes are held equal by `tests/tooling/tmp-dir.test.ts`. The framework's copy lost `makeTestTmpDirAsync`, which
  only the repository's own tests used.
- **`sssb ci`** has three jobs today: `e2e-shards` (discovering shards from the workspace's apps, with a project named
  `destructive` splitting an app in two, as the shell in `checks.yml` did), `e2e` and `demo-static`. `checks.yml` runs
  `e2e-shards` from the package's source before any install, as its shell loop ran. P10's reusable workflow adds the
  rest.
- **`sssb guide` exists ahead of the guide.** It copies the framework's published `@sssb/kit/guide.md` to
  `.claude/sssb-guide.md` with a `sha256` stamp and `--check` compares stamps; until P7 publishes the guide it says so
  and exits 1.
- **The assembly checks** (`@sssb/tools/assembly-checks`: the migrator bundle, the fail-closed environment, #49's Data
  API shape) are functions over a synthesized template and its assembly directory, which `infra/check-shapes.ts` now calls. It also gained
  the fail-closed check on the server function's environment, on both shapes.
- **`sssb check-doc-paths`** runs the doc-path gate's engine (`@sssb/tools/doc-paths`) over the doc set in the root
  package.json's `sssb.docPaths`. `tests/docs/doc-set.ts` reads the same configuration, so the gate, the CLI and
  `init-app`'s rewriter still share one list.
- **Pack and consume** packs `@sssb/tools` beside the framework and installs both tarballs. Nine P4 workarounds are
  gone: `prune-plugin-copied`, `ports-copied`, `check-demo-size-copied`, `tmp-dir-helper-copied`,
  `vitest-config-written`, `tsconfig-written`, `vite-aliases-removed`, `next-intl-request-path` and
  `tick-scripts-copied`. One is new, `in-repo-tsconfig-stripped` (P12): the starter's tsconfig extends the base but also
  maps the framework and the seam to source and includes `packages/kit/src`, which only this repository can. New
  steps check the packed tools (no SSSB dependency in any field, JavaScript only) and run the `dev:real` preflight
  from each app, and the sibling package `gate` uses `@sssb/tools`' helper with no framework installed.
- **knip** cannot see what a preset loads from the app or what `@sssb/tools` imports from its optional peers; the
  narrow entries are in `docs/build-notes.md`.
- **What review changed** (two rounds and a diff review, Opus and Fable). Framework source is now recognised by its
  package, not its path: a file is the framework's when its nearest named package.json is `@sssb/kit`'s
  (`isFrameworkFile`), which also catches a copy of the framework's tree reached by a relative path. The `dev:real`
  preflight bundles every file outside `node_modules` (a workspace package the seam imports included, so its own
  `@sssb/kit` imports are checked rather than loaded natively past the check) and runs the identity check on every
  bundled input and every external. Each bundled file that uses `import.meta` is first transformed with `import.meta`
  defined as an object holding its own location, since a CommonJS bundle has none. The Vite and Vitest presets add a
  guard plugin that runs the same check on every module they load, so a workspace package bringing a framework
  instance of its own fails there too, instead of running beside the app's on the app's seam. `resolveFromApp` walks
  `node_modules` as `kitDirOf` does. The doc-path gate, and this repository's `tests/docs/doc-paths.test.ts`, fail an
  `include` entry that names nothing. Labels for shards and launch configurations are unique; `sssb tick` and
  `sssb dev-tick` take `--app`.
- **The resolver is published as `@sssb/tools/kit`** (`kitDirOf`, `kitVersionOf`, `assertAppsKitFile`,
  `resolveAppsKit`, `isFrameworkFile`, `assertNoForeignFramework`, `resolveFromApp`, `importFromApp`), at P9's
  request: `@sssb/cdk`'s construct runs the same check rather than a second copy. P9 records the dependency that
  takes on `@sssb/tools`.
- **Port slots stay a closed list** (`showcase`, `starter`, `ladle`, `contractPg`), as `scripts/ports.mjs` had them, so
  two apps of an adopter's own made from the starter share one; the independent review found it, and
  `.claude/future-tasks/port-slots-for-adopter-apps.md` designs a slot an app declares itself.

## A Simulator control for the dev ticker, and focus on panel toggle (2026-11-18, `feat/simulator-ticker-control`)

JP asked on 2026-11-17 whether the Simulator could start the ticking clock from its UI. This builds
`.claude/future-tasks/resolved/simulator-ticker-control.md` and, in the same panel, fixes
`.claude/future-tasks/resolved/simulator-panel-focus-on-toggle.md`.

- **The ticker runs inside the dev server, owned by a route.** `apps/showcase/src/app/api/simulator/ticker/route.ts`
  (GET status, POST start or stop) drives one `createTicker` from `scripts/ticker.mjs`, kept on `globalThis` so a hot
  reload of the module does not orphan a running loop and start a second (`dev-ticker.ts` beside it). It ticks this
  server's own `/api/webhooks/cron` over HTTP with the per-checkout dev secret, exactly as `pnpm tick` does, so
  `withWebhookSecret` stays the only door into `runScheduledTick`. It leaves the same `dev-ticker.json` marker the
  `DEV_TICK_SECONDS` wrapper does, with the server's pid, so `pnpm test:e2e` refuses to adopt a server whose ticker was
  started from the UI (checked live: the playwright guard threw while it ran, and stop removed the marker).
- **A new run-mode flag, `isSimulatedDevServer`, because `isSimulated` is not enough.** The future task said to 404
  "outside a simulated world", like the flags route. But the hosted demo and CI's e2e build are simulated worlds with a
  server, and the ticker must exist in neither. `@sssb/kit/adapters/index` already reads `DEMO_MODE` and `E2E_BUILD`
  (it is where `process.env` may be read), so it now exports `isSimulatedDevServer`: simulated, `NODE_ENV` of
  `development`, and neither switch. The logic is a pure function in `packages/kit/src/adapters/dev-server.ts`, outside
  `index.ts`, because `production-guard.test.ts` counts every `&& !is…` in that file as a bypass of the fail-closed
  guard; a source test pins how `index.ts` wires it. The route opens with the `isSimulated` 404 every simulator route
  has, then a second 404 on `!isSimulatedDevServer`, and only then imports the ticker module, so a production build
  never evaluates `scripts/ports.mjs` (which looks for the workspace root from the working directory at load).
- **No `authorize(...)` call.** The brief said every new mutating route calls it. The scan's rule is "calls it, or has a
  justified exemption whose gate it passes", and every route under `simulator/` passes the `opens-with-simulated-404`
  gate: the Simulator's knobs are reachable signed-out (pick a person to sign in, reset the world), so there is no
  actor to authorize. This route is one of those knobs, and the scan accepts it on that gate.
- **The panel shows the control only where the route answers.** The kit's Jobs tab takes an optional `ticker` prop
  (`DevTickerLike`); the showcase glue asks the route when the Jobs tab opens and on its poll, and on a 404 stops asking
  for the page's life. So the control is absent in real mode, in every production build, and in the static demo, whose
  twin never wires it. A local `pnpm test:e2e` runs against `pnpm dev`, where the control exists, stopped, and nothing
  clicks it; `simulator-panel.spec.ts` asserts that locally and, on CI's `E2E_BUILD`, that the route is 404 and the
  control absent.
- **One ticker per world.** A live marker whose pid is not the server's (the `DEV_TICK_SECONDS` wrapper, or another
  server on the same data directory) makes start answer 409, and the control says a ticker started outside the panel is
  running, with its interval and pid, and to stop it there. The panel cannot stop a ticker another process owns.
- **The origin is `http://localhost:<portFor('showcase')>`, not the request's host.** The dev secret is sent there as a
  bearer, and a Host header is the client's to choose. `pnpm dev` takes its `--port` from the same function. A server
  started on another port by hand ticks whatever listens on the derived port instead: its last-error line then says
  "could not reach", or a 401 if another checkout's server is there. `pnpm tick` has the same exposure.
- **The control keeps focus.** Start and Stop are one button whose label changes, not two buttons swapped, and it is
  `aria-disabled` while a request is in flight rather than `disabled`: disabling a focused button moves
  `document.activeElement` to `<body>` (measured in Chromium with Playwright). While the
  ticker runs the interval field is not rendered: the status line names the interval, and a disabled Mantine field
  on the dark panel was hard to read.
- **Focus follows a panel toggle.** After `toggle()`, an effect keyed on `collapsed` focuses Hide when the panel opens
  and the pill when it closes, gated on a ref only `toggle()` sets, so page load never takes focus. A mouse click on the
  pill moves focus to Hide too; that is where the next Tab should start.
- **`scripts/ticker.mjs` changed only in its header comment** (its two users, and where each one's policy lives), so
  P4's move of the tick scripts into `@sssb/tools` resolves against it simply. The route's `dev-ticker.ts` imports
  `scripts/ports.mjs`, `scripts/ticker.mjs` and `scripts/ticker-marker.mjs` by relative path (its test imports the last
  two); when they move, those imports move with them.
- **Two things review added.** The POST takes only `application/json` (415 otherwise): a page on another origin can
  send a text/plain POST to localhost without a preflight, and this route starts a loop that outlives the request. And
  the server removes its own marker on `exit`, so a dev server stopped with a UI ticker running leaves none behind.
- **Left as they are, from review.** A Start clicked by hand during a local `pnpm test:e2e` ticks under the run (the
  guard checks the marker at config load). Wiping `.data` under a running ticker removes its marker, as it does the
  wrapper's. An `APP_DATA_DIR` set only in a `.env` file would reach the server but not the playwright config or the
  wrapper, which read the shell's environment (no `.env` file exists here). Each needs an unusual setup, and closing
  them means changing `scripts/` while P4 moves it.
- **A dev-only route imports the ticker scripts at run time, and that crosses ADR-0014 rule 4 once P4 lands.** Rule 4
  says only `@sssb/kit` is imported at run time; after P4 these scripts are `@sssb/tools`, an app devDependency. The
  import stands because it is the showcase's (SSSB's reference app, not the starter an adopter keeps), Next bundles it
  at build time so production never resolves the devDependency, and it sits behind the `isSimulatedDevServer` 404 so a
  production build never evaluates it. If the rule is to hold without exception, the alternative is a kit-owned
  ticker, which would duplicate `scripts/ticker.mjs`.
- **The interval is a native number field, not Mantine's `NumberInput`.** `NumberInput` brought `react-number-format`
  into the showcase's static demo, which renders the kit's Jobs tab but never the control, and put it 8,364 bytes over
  its 860,000-byte budget. A `TextInput` of type number took the bundle to 840,890 bytes, under budget again; the route
  validates the value either way.

## Changesets are required on PRs that change what ships, and carry the release note (2026-11-18, `ci/changeset-required`)

JP asked whether CanopyCMS's way of keeping a changelog up to date could be copied. Its mechanism: every PR that
changes a published package adds a `.changeset/*.md` that is its changelog entry, in a fixed template ending with a
"Now deletable" part, and CI fails the PR without one. SSSB already had Changesets but no rule, template or lint.

- **What was taken:** the gate, the template, the explicit "no adopter-visible effect" answer (an empty changeset),
  and "Now deletable". The template's `**Kind.**` is one of P7's four release-note sections (`seam`, `migration`,
  `operator`, `scaffold`) or `none`, so the notes can be written from the files by section.
- **Kind and Action are separate fields.** Canopy keeps "which area" and "must the adopter act" apart; a first
  version here tied the bump to Kind and left an additive migration or a new optional export with no honest home
  (ADR-0014 part 10 calls a migration breaking only when it needs operator action). `**Action.** required` is a
  `minor`; `optional` and `none` may be a `patch`. Part 10's other breaking items (a raised peer floor, a rule that
  turns app code red) are filed under `seam`, and a change in two sections is two files.
- **What was not taken:** CanopyCMS's 3,286-line assembly script, its area table and its int-prerelease labels. They
  serve an npm prerelease channel; SSSB's release candidates are tarballs on a GitHub prerelease (ADR-0014 P7).
  Assembling the notes from the files waits for `@sssb/tools` to exist to host it, and the stock
  `@changesets/cli/changelog` ignores Kind and Action, so P7/P14 need a custom changelog function or an assembler
  (said in `.changeset/README.md`). Rejected alternative: port the script whole.
- **The gate is path-based, not `changeset status`.** Every package is `private` until P14 and `status` ignores
  private packages, so it would pass for any change. "Ships" is every `@sssb/*` package under `packages/` (read from
  its manifest, so P4's tools, P6's plugin, P9's cdk and P12's create are covered the day they land; the kit is
  narrowed to its `files` allowlist, the seam-conformance tests included, other tests and stories not) and
  `apps/starter`, the scaffold an adopter copies and the future `@sssb/create` template. `apps/showcase`,
  `packages/seed`, the lockfile and the kit's `test-fixture` are not shipped. The lockfile counts in CanopyCMS
  because its worker is an esbuild bundle; SSSB ships source. A test fails when the kit manifest's `files` gains an
  entry the gate does not know.
- **Known gap, taken on purpose:** while adoption is a fork, adopters also receive `infra/`, the cutover checklist,
  the ESLint config, `.gitleaks.toml`, the CI workflows, `scripts/` and the docs. Gating them now would make every
  P5, P6, P9 and P10 PR carry a changeset for files those steps are moving. Some of them land in packages and the
  starter, which the gate covers; some land elsewhere (the showcase's `infra/`, a generator's write-once files).
  The README says to check whether the gate sees a change.
- **Exemptions:** the release merge (`integration` into `main`, same repository, so a fork's branch of that name is
  not exempt); Dependabot's PRs unless one changes the kit's `peerDependencies`; a PR opened before the gate reached
  its base branch (read from git, so no date is written down); and a file a PR carries only because it merged `main`
  in (ported from CanopyCMS), since the repository does merge `main` back into branches.
- **The logic is a shell script under `.github/scripts/`, tested by a vitest file** that builds real git repositories
  (the machine's git config isolated), and the shape lint is `tests/support/changeset-shape.ts` run by the same file.
  Neither adds a `scripts/` file, a `package.json` script or a `knip.json` entry, because P4 is moving `scripts/`
  and P4, P5 and P6 own the root manifest. Each moving part of the script was mutated to confirm a case goes red.

## Doc agents: one steward, plus a line-delta rule and a reading map (2026-11-18, `docs/doc-hygiene`)

JP asked what is worth borrowing from CanopyCMS's documentation setup. Two things, and not the rest.

- **Taken: the net-line-delta rule.** Canopy measured that its doc-update steps only ever added: four root docs grew
  by 2,154 lines in a month and none shrank. SSSB has the same shape (every `doc-steward` step is written to add), so the
  agent now reports the net line delta of each doctrine doc the diff touches, says why any grew, and proposes
  deleting what the diff supersedes in the same pass. The dated records are exempt from deletion: they are
  append-only, so for them it only notes growth. `CLAUDE.md` carries one sentence pointing at it.
- **Taken: the task-to-doc table.** `docs/README.md` lists documents; it now also has a "Read this for X" table by
  task, so an agent starting a job finds the doc to read first. Its backticked paths are gated
  (`doc-paths.test.ts`); its links are not.
- **Not taken: Canopy's four per-document maintainer agents.** `doc-steward` already walks SSSB's doc set in order,
  and it is one agent to keep current instead of four whose scopes can drift.
- **Not taken: `CODEBASE_GUIDE.md` and its codebase-guide agents.** A file-by-file map of the code is a second copy to
  keep true. The agent instructions do have a planned home (ADR-0014's P4 `sssb guide`, content from P7, which
  copies the app guide into an adopter's repo), but a file map like `CODEBASE_GUIDE.md` is deliberately not planned.

## Trojan Source scan and an action-pin gate, borrowed from CanopyCMS (2026-11-18, `ci/ci-hygiene`)

- **A Trojan Source scan** (`.github/scripts/check-bidi.sh`, the first step after checkout in `checks.yml`, before
  any install). It fails when a tracked file's contents or name holds one of the nine bidirectional reordering
  codepoints (U+202A-202E, U+2066-2069), which let a reviewer read one program while the compiler builds another.
  It is CanopyCMS's step, kept fail-closed: the locale is pinned, because `git grep -P` dies with exit 128 outside
  a UTF-8 locale; the exit status is read with `case`, because `if git grep; then` reads 128 as "nothing found";
  `pipefail` covers the filename pipeline; and the filename byte pattern is self-tested against all nine. It
  scans from the repository root, and reads source-type files as text and refuses a NUL in one, because
  `.gitattributes` or a NUL can make git call a file binary, which `git grep -I` skips.
- **An action SHA-pin gate** (`tests/tooling/action-pins.test.ts`, finder in `tests/support/action-pins.ts`). It
  parses every workflow and local composite action and fails on a `uses:` that is not a full 40-hex SHA
  (`./` refs exempt, `docker://` flagged). Every action is already pinned today, so it prevents drift (a job merged
  from a sibling branch, a Dependabot bump to a tag) rather than fixing anything. It does not check
  `jobs.*.container` or `services.*.image` tags, or what a symlink points at.
- **A bash script and vitest tests, not `scripts/`.** P4 is moving `scripts/`, and P4, P5 and P6 all
  touch the root `package.json`, the lockfile and `knip.json` (ADR-0014, the paragraph after the step table), and P9's
  row changes `pnpm-workspace.yaml` and the knip globs; neither piece needs a `package.json` script or a knip entry here. The script's
  tests (`tests/tooling/check-bidi.test.ts`) run it against real scratch repositories, including a repository
  that is not one, and a parent `LC_ALL=C`.
- **Rejected: porting `check-action-pins.mjs` into `scripts/`** with a `package.json` script. It would grep for
  `uses:` rather than parse, and would touch the files other work owns.

## The database is named from the slug with dashes as underscores (2026-11-18, `fix/aurora-db-name`)

`@sssb/cdk`'s entry above left this as a follow-up: `SssbApp` named the deployed database by the app's slug, `pnpm
init-app` accepts dashes in a slug, and Aurora PostgreSQL's database names take letters, numbers and underscores only,
so `pnpm init-app my-app` gave a stack that synthesized and failed at deploy.

- **Derived, not refused.** Dashes are ordinary in a slug, so the construct names the database
  `databaseNameFor(slug)`: the slug with each dash as an underscore (`packages/cdk/src/database-name.js`). A slug has no
  underscore of its own, so two slugs never share a name, and a slug with no dash names the same database as before:
  the showcase's and the starter's templates are unchanged but for one variable on the migrator.
- **Every place the name is used takes it from there**: the cluster's `defaultDatabaseName`, the server's
  `DATABASE_NAME` (data-api) or the path of its `DATABASE_URL` (pg), and the migrator's `DATABASE_NAME`, on both
  transports now. On pg the migrator used to take the name from the secret's `dbname`, which the synthesized secret
  does not carry (only the cluster's secret attachment would add it, at deploy); the framework's handler now prefers
  `DATABASE_NAME`. The contract test databases already folded dashes (`contractDatabaseName`), and nothing in
  `packages/kit/src/db` or an app's `config/params.ts` turns the slug into a database or role name.
- **Refused where the name cannot be made**: a slug over 63 characters, or one whose name the engine reserves (its
  reserved key words, `postgres`, `rdsadmin`, `template0`, `template1`), throws at synth, and `pnpm init-app` refuses it
  where the slug is chosen, importing the same function.
- **Proved** by a test that synthesizes a dashed-slug app on both transports (red with the old naming), by `pnpm
init-app my-app` in a copy of the repository followed by its real `cdk synth` (`DatabaseName: my_app`), and by
  `init-app` refusing `user`, `select`, `rdsadmin` and a 64-character slug (each red without the check).

## `@sssb/eslint-plugin`: the fences as one plugin (2026-11-18, ADR-0014 P6, `feat/eslint-plugin`)

- **Every fence is a rule with an id of its own.** The fences that were `no-restricted-imports` patterns or
  `no-restricted-syntax` selectors are now `sssb/no-vendor-import`, `sssb/no-next-font-google`,
  `sssb/no-real-adapter-import`, `sssb/no-static-real-adapter-import`, `sssb/no-kit-real-adapter-import`,
  `sssb/no-dynamic-real-adapter-import`, `sssb/no-process-env`, `sssb/no-run-mode-env`, `sssb/no-literal-a11y-copy`,
  and, SSSB-internal, `sssb/no-app-import` and `sssb/no-framework-import-in-core`. The declaration rules match as
  `no-restricted-imports` did (the `ignore` package with `allowRelativePaths` and `ignorecase`, a `regex` with `iu`,
  the specifier trimmed, `import m = require()` included; they also trim that last form's specifier, which ESLint
  does not, a tightening) and report each pattern's own message, so every
  probe in `tests/lint` kept its message fragment and only its rule id changed. `eslint.config.mjs` no longer sets
  either core rule. The alternative, keeping the core rules for SSSB's own repository and ids only in the preset,
  would have left two readings of each fence.
- **`react/jsx-no-literals` became `sssb/no-jsx-literals`**: react's rule, run with SSSB's options fixed and no
  options of its own. The alternative, leaving `react/jsx-no-literals` in the preset, let an adopter's block that
  configures that rule for its own reasons replace SSSB's options for every file it matched.
- **`configs.app({ root })` is async**, because it imports the app's `lint-exceptions.mjs` (an ES module, re-read by
  mtime as before). A synchronous factory through `require()` of ESM was the alternative; it cannot re-read an edited
  file in a long-lived lint server. Adopters write `...(await sssb.configs.app({ root: import.meta.dirname }))`.
- **`root` must be absolute, and every block carries `basePath`**: `root` itself, or its parent directory when
  `root`'s last segment is `*`. A relative root is refused: it would be
  relative to wherever ESLint started (ADR-0014 part 4). A last segment of `*` means every app in that directory;
  this repo's config passes `join(import.meta.dirname, 'apps/*')`, the ADR's `apps/*` anchored.
- **The internal rules' anchors are a `{ root }` option**, read when the rule runs: `sssb/public-surface` and
  `sssb/no-path-out-of-package` read `packages/kit/package.json` under it, and both path rules resolve landings
  against it. Nothing in the plugin reads a file when it loads but its own `package.json` (for `meta.version`).
- **Scope changes, each a tightening or a no-op.** The a11y-copy ban now covers the app's registry
  (`src/adapters/index.ts`), which lost it only because the fakes block ignored the registry for the dynamic real/
  ban. The `next/font/google` ban now covers `next.config.*` and `tests/contract/`, which the vendor block's carve-outs
  had dropped with it. The registry pattern (`appRealAdapterPattern`, now `sssb/no-real-adapter-import`) no longer applies to
  `packages/*/src`: a package
  has no registry, and in `packages/kit/src` the merge trap had already replaced it with the framework fence's list.
  `SSSB_LINT_EXCEPTIONS_ROOT` is gone: the tests point `configs.app` at a scratch tree directly.
- **An app adds its own vendors in its `package.json`** (`"sssb": { "vendors": [...] }`, beside P4's `sssb.port`). An
  app-owned adapter's SDK used to go into `vendorSdkPattern` in a fork's `eslint.config.mjs`; once the list ships in
  the plugin, an adopter cannot edit it. The first cut was a `configs.app({ root, vendors })` option, and round 1 of
  review (both reviewers) found it could narrow SSSB's list: `ignore` reads a leading `!` as a negation, and
  check-fences skipped the vendor rules' options, so a later block could also swap the app's list for one directory.
  Now the list is a file check-fences reads too, the options are compared exactly, and a leading `!` is refused in
  the package.json and in the rules' schema. The alternative, keeping the option and teaching check-fences a superset
  test, still needed check-fences to know the app's list, which only a file gives it.
- **What the plugin depends on.** `eslint` is a peer; the base config's plugins (`@eslint/js`, `typescript-eslint`,
  `eslint-plugin-react`, `-react-hooks`, `-jsx-a11y`, `@next/eslint-plugin-next`, `eslint-config-prettier`) and
  `ignore` are dependencies, so `configs.app` needs nothing else installed. An adopter's own block that binds one of
  those plugins to another copy gets ESLint's loud `Cannot redefine plugin`, never a silent change.
- **The e2e import ban (ADR-0014 part 2) waits for P5.** The spec it allows, `@sssb/kit/testing/e2e`, does not exist
  yet, and `apps/showcase/tests/e2e/destructive/simulator-webhooks.spec.ts` imports `@sssb/kit/core/webhook-signing`.
- **What `sssb check-fences` defends against: an adopter's config weakening a fence by ACCIDENT.** Three review rounds
  and an independent reviewer (Fable) on "can a config composed after the preset silently switch off or narrow a
  fence?" closed every plain-configuration case they found: a rule turned off or down, narrowed to a directory, an
  `ignores`, a nested config file, a processor or parser for one directory, an app's vendor list negated or swapped,
  inline directives in every form ESLint reads, an `eslint-suppressions.json` (the ESLint CLI applies it, the ESLint
  class only with `applySuppressions: true`, which check-fences does not pass, so check-fences now reports every fence finding in the app's own files, at any severity), symlinked
  files and directories, and build-output names deeper in `src/`. What is left needs config code written to deceive,
  and each case keys on the probes' public file name: a parser that borrows the real one's `meta`, the preset's blocks
  rewritten to bind `sssb` to a look-alike plugin, a module the rules read rewritten. These are OUT OF SCOPE (manager,
  2026-11-18): a config that is written to deceive can as well delete the preset, and no lint-time check stops that.
  The plugin, its rules, its patterns and react's `create` are frozen or captured anyway, because that was cheap. The
  stronger check, a probe at every real file's path, is `.claude/future-tasks/check-fences-real-file-probes.md`:
  rejected for now because it adds a third lint per file to a check that already takes about 5s on the showcase (233
  files; `sssb check-fences --app apps/showcase`, measured 2026-11-18).
  Also not covered, by nature: flags on the app's lint command (any fence finding is still reported by check-fences,
  whatever the command does with it), and a config that behaves differently when it detects which tool loaded it.
- **Typed linting cannot pass check-fences yet.** Its probe files are virtual and outside the app's TypeScript
  project, so `parserOptions.project` or `projectService` makes every probe a parse error, which check-fences reports
  with that reason (a false red, not a hole).

## The reusable workflow (2026-11-18, ADR-0014 P10, `ci/reusable-workflow`)

- **`.github/workflows/app-checks.yml`**, `on: workflow_call` only, `permissions: contents: read`, no secrets. Its jobs
  are `lint-typecheck-unit` (the workspace's lint, typecheck and unit tests, then `sssb check-fences` in each app,
  one `sssb doctor` run and `sssb check-e2e` in each app),
  `contract` (a `postgres:16` service and the workspace's `test:contract`), `discover` (the e2e shards and the
  static-demo apps), `e2e (<shard>)`, `demo-static (<app>)`, an optional `synth`, and `all-checks`. Every step that
  is not setup is one `pnpm exec sssb ci <job>`; the jobs P10 adds to `sssb ci` are `lint-typecheck-unit`,
  `contract`, `matrix` and `synth`, and `--apps` narrows the ones that fan out.
- **`all-checks` is the one check an adopter requires.** A skipped job reports as a passing check, and a job that
  never starts reports nothing, so requiring the jobs one by one lets a check go missing or pass without running.
  `all-checks` runs `if: always()`, needs every other job, and fails unless each one's result is `success` (synth's
  `skipped` when no synth was asked for). A test holds its `needs` and its list to every other job. The alternative,
  documenting a list of checks to require, leaves each adopter's ruleset to drift from the workflow.
- **A job with nothing to run fails.** A missing root script, an e2e or static-demo list that comes out empty, or a
  synth selector that matches no package is an error, not a quiet pass. So the workflow assumes a few conventions,
  which it says at its top: a pnpm workspace at the repository's root, depending on `@sssb/tools`, whose root defines
  `lint`, `typecheck`, `test:unit` (or `test:coverage`, which is run instead when present) and `test:contract`, and
  apps that each have a Playwright config and a `test:e2e` script (and a `chromium` project beside a `destructive`
  one), and the scripts `build:demo-static`, `check:demo-size` and `e2e:demo-static`. `@sssb/create` (P12) writes them.
- **`apps` is optional and defaults to the workspace's apps** (the root's `sssb.apps`, or every `apps/<name>`, P4's
  rule). This repository passes none, so `pnpm init-app`'s rename and eject need no edit to `checks.yml`. A listed app
  must be a package inside the workspace.
- **`synth` is a pnpm `--filter` selector** (`./apps/console/infra`, or this repository's `./apps/*/infra`), run with
  `--fail-if-no-match`. Empty skips the job.
- **This repository calls it by its local path**, so it runs at the commit under test; an adopter pins it to a
  commit SHA. The alternative, pinning this repository's own call to an earlier SHA, would test old CI against new
  code.
- **Check names change.** GitHub names a called workflow's jobs `<caller job> / <job>`, so the app checks are now
  `sssb / lint-typecheck-unit`, `sssb / contract`, `sssb / discover`, `sssb / e2e (showcase)`,
  `sssb / e2e (showcase-destructive)`, `sssb / e2e (starter)`, `sssb / demo-static (showcase)`,
  `sssb / demo-static (starter)`, `sssb / synth` and `sssb / all-checks`. The old `e2e-shards` is `sssb / discover`,
  and the old single `demo-static` is one job per app. What only this repository checks (the bidi scan, knip, jscpd,
  the spike) is a new job, `repo-checks`. `tests/tooling/app-checks-workflow.test.ts` pins the fixed names, and
  in SSSB's own tree the five per-app names, so a renamed job or Playwright project goes red here before a ruleset
  blocks every PR (a renamed app skips the per-app pin).
- **`release.yml` is unchanged.** Its gate (`scripts/release.mjs wait-for-checks`) reads the conclusion of
  `checks.yml`'s push run, and a called workflow's jobs are part of that run and of its conclusion
  (docs.github.com, "Reusing workflow configurations": the called workflow's jobs run in
  the caller's workflow run; PR 28's runs show them there).
- **`sssb doctor` and `sssb check-e2e` (P5) run inside `sssb ci lint-typecheck-unit`**, after check-fences,
  not as jobs of their own: no check name changes, and the job already has the workspace installed. Doctor runs once,
  for the first app (one run checks every app of the workspace, and an adopter's root need not resolve `@sssb/kit`;
  run from `apps/showcase` here it makes the root's checks less the root's own singleton and version lines, which
  check no app). check-e2e runs in each app the job covers. In this repository they leave `repo-checks`, where
  merging P5 had put them. The alternative, two more jobs, would add two required check names for no isolation
  gained: both need the same install.

## Release notes are assembled from the changesets by a script, and committed with the release (2026-11-18, `feat/release-notes`)

The entry on requiring changesets (`ci/changeset-required`) deferred this until `@sssb/tools` existed; this ends that deferral, but in `scripts/` rather than in `@sssb/tools` (below). #21 made every PR
that changes what ships carry a changeset with a Kind and an Action; ADR-0014 part 10 wants notes with "Seam changes",
"Framework migrations", "Operator actions" and "Scaffold changes to apply by hand", and the stock Changesets changelog
ignores Kind and Action and deletes the files. `scripts/release-notes.mjs` reads the files first and writes those
sections, with each entry's What changed, To adopt and Now deletable.

- **Taken from CanopyCMS** (`scripts/migration-notes.mjs`): the entries are the changeset files, assembled by a script
  that lints them first and gives the same bytes for the same files; the idea that a later candidate says what changed
  since the earlier one (`--since`, and the corrections to entries edited after it). **Not taken:** its area table, int
  labels, `## Unreleased` table, rewriting a changelog in the repository and `--promote`, which serve an npm
  prerelease channel. The whole of that script is 3,286 lines, about half of them its own self-test.
- **A script in `scripts/`, not an `@sssb/tools` command.** Only SSSB's maintainers release SSSB. `@sssb/tools` ships
  to adopters, so a command there would ship maintainer-only code, and P4 left `scripts/` for what is the repository's
  own. `pnpm release:notes` runs it. Rejected: `sssb release-notes`.
- **One shape lint, and it is the assembler's.** `lintChangeset` moved from `tests/support/changeset-shape.ts` into the
  script, which the test file re-exports: the tests, `release.mjs check`, `release.mjs prepare` and the command lint a
  changeset with the same code. It no longer uses the `yaml` package, because the `push` and `publish` jobs install
  nothing and the module must load there: the frontmatter is read one quoted `'@sssb/pkg': bump` per line, with `#`
  comments and a quoted bump allowed and a BOM skipped, as Changesets reads it. A changeset using YAML's other forms
  is refused. `release.mjs` has its own small reader for the same frontmatter (`changesetReleases`, which `verify-release`
  runs in the key-holding job), and a test holds the two together: a reader stricter than the lint would pass every
  PR and then stop a release in `push`. Review found exactly that, after the lint was widened to what Changesets reads.
- **Loaded dynamically.** release.yml's `push` job copies `scripts/release.mjs` out of the commit and `publish` checks
  out three files (`release.mjs` among them, `release-notes.mjs` not), so `release.mjs` imports the notes module only inside `check` and `prepare`; a test runs the lone
  copy to pin it.
- **`check` lints every changeset on every PR; `prepare` always assembles before `changeset version`.** A changeset that
  is not a readable entry would otherwise fail a release after its plan was accepted. Both leave the package names and
  bumps to the plan's own checks (`judgePackages: false`), so a bump Changesets accepts (`none`) cannot pass one and
  stop the other. While every package is private `prepare` returns before this point, so a release stays dormant;
  the lint on PRs does not.
- **The notes are a file in the release commit, `docs/releases/v<version>.md`.** The first version kept them out (the
  `push` job is hash-pinned, and a lone `verifyRelease` cannot regenerate them to compare) and offered an artifact and
  the run summary. Review answered that `verifyRelease` already accepts any bytes in `packages/*/CHANGELOG.md`, so one
  more plain file is the same class of trust, and that an artifact expires: ADR-0014 part 10 says these sections
  "replace the merge-time discovery ADR-0013 relied on", and a fork merging `main` gets the deleted changesets and no
  notes unless a file carries them. So `prepare` writes the file before `changeset version`, `verifyRelease` accepts
  exactly one added plain file at that path whose first line is `# Release notes: v<version>` and requires it, and the
  `plan` job also appends the notes to its summary. The job's YAML (its hash) does not change. Its content is not
  regenerated and compared, because the checker runs alone; it comes from reviewed changesets, like the changelogs.
  Rejected: an artifact only (expires, and not in the repository).
- **`docs/releases/` is exempt from the doc-path gate** (`sssb.docPaths.exempt`), like the other dated records: the
  notes cite paths in an adopter's tree (`apps/<app>/…`) that this repository does not hold. They are also held to
  prettier, since `pnpm lint` checks every markdown file and a red release commit blocks the publish: the first draft
  left two blank lines between sections and review found it; a test now checks the notes of the repository's own
  changesets and of fixtures against the repository's prettier config.
- **`--since <ref>` and corrections.** A release candidate's notes are what was added since the previous one, with the
  range in the heading, and the changesets EDITED since (the README allows editing one only to correct it) come back
  under "Corrections to earlier notes", so an adopter who followed an earlier, wrong instruction is told. `--since`
  and `--at` read git, never the working tree.
- **No GitHub release is created.** That is publishing, which P7 (a release candidate, from `--since <previous tag>`)
  and P14 (npm) own.
- **Order inside a section:** Action required first, then optional, then none, then by file name, so the entries that
  break an adopter who does nothing come first. The Action line names the packages, not their bumps: the group is
  fixed, and the Action says what the adopter must do.
- **The `release.test.ts` fixtures now carry a shaped body**, since `check` and `prepare` refuse any other.
- **Not done, left for P7 and P14** (review raised each; none is needed for a first release candidate to be honest):
  the history since 24b0589 (the rename among it) is still hand-written, so P14's unattended notes would omit it unless
  it is backfilled as changesets or a hand-written `docs/releases/` file first; labelling each entry with the
  candidate that first carried it; refusing a rename or deletion of a changeset a candidate already carried;
  ordering entries so a scaffold step an adopter needs first comes before the seam change that presupposes it;
  prepending sha512s and install lines to the notes for P7's GitHub release (a header file or `--no-title`); whether
  GitHub's release body renders these hard-wrapped lines as it should (unverified); and the VPC entry from P9, which
  is filed Operator actions with Action none though its body says lookups by tag need the new value.

## `@sssb/kit/testing/e2e`: compiled when packed, source in the repo (2026-11-18, ADR-0014 P5, `feat/conformance-suite`)

ADR-0014 part 2: Playwright loads e2e specs with Node, so a spec reaches the kit only through
`@sssb/kit/testing/e2e`, shipped compiled and seam-free, and packing fails if that entry imports the seam.

- **The split.** `core/webhook-signing.ts` read `APP_SLUG` from the seam when it loaded. The pure half (SHA-256,
  HMAC, sign/verify, the replay tolerance, the Mailgun recompute) moved to `core/webhook-hmac.ts`, which imports
  nothing; `webhook-signing.ts` keeps the three `APP_SLUG` header names and `export *`s the rest, so its published
  surface and every importer are unchanged. The `node:crypto` cross-check moved with the code
  (`webhook-hmac.test.ts`). `webhook-hmac.ts` gets no `exports` line: only `webhook-signing` and the e2e entry
  import it, so it is one more internal module.
- **The mechanism: `exports` names the compiled file, and a `prepack` script builds it.**
  `"./testing/e2e": "./dist/testing/e2e.js"`, with `dist` in the `files` allowlist and gitignored.
  `packages/kit/scripts/build-testing-e2e.mjs` (the kit's `prepack`; `pnpm pack`, and so pack and consume, runs
  it) bundles `src/testing/e2e.ts` with esbuild into one ES2022 module with no imports, and emits its declarations
  with the TypeScript API (`dist/testing/e2e.d.ts`, found by the sibling rule, so the map keeps one string per key;
  relative specifiers get `.js` so `nodenext` resolves them too). esbuild became a kit devDependency (the root already had it).
- **Why not the alternatives.** `publishConfig.exports` replaces the whole map, so it would repeat 130-odd entries.
  Conditions (`"sssb-source"` in the repo, `default` for Node) would make the map's values objects, which the
  public-surface test reads as strings, and would need the condition passed to tsc, Vitest and
  Playwright. A `prepare` script was not needed: **nothing in this repo resolves through `exports`.** Every tool
  aliases `@sssb/kit/*` to `packages/kit/src` (tsconfig `paths`, both Vitest configs, each app's Vite build), and
  Playwright honours tsconfig `paths` too: `playwright test --list` loads `simulator-webhooks.spec.ts` with no
  `dist/` on disk. So in the repo a spec runs the entry's source through Playwright's transform, and building on
  every install would only add a step that can fail an install. `public-surface.test.ts` reads a `./dist/<p>.js`
  target as its source `./src/<p>.ts`, for both the "target exists" check and the internal-module count.
- **The seam guard is the build.** It fails, naming the importer, if the closure imports `@sssb/app-config/*` or
  any other package (a plugin records every bare specifier before esbuild resolves it; no tsconfig is read, since
  the root one maps the seam to the test fixture), or if the bundle or the declarations reach a file outside an
  explicit allowed set (`src/testing/e2e.ts`, `src/core/webhook-hmac.ts`). A failed build deletes `dist/`, so a
  half-built entry is never packed. Seen failing: with the entry re-exporting from `../core/webhook-signing`, the
  build exited 1 with `@sssb/app-config/identity (imported by src/core/webhook-signing.ts)`; with
  `../core/state-machine` added, it exited 1 naming that file; restored, it passed. Review added a second half:
  esbuild sees only literal specifiers, so the EMITTED file is parsed with TypeScript and must hold no module import
  or export, no `import()`, no `import.meta`, and no free reference to a loader (`require`, `module`, `globalThis`,
  `eval`, `Function`, ...), since `globalThis['req'+'uire']` never spells require. Rejected: a regex over the output
  (misses the computed key), and an allowlist of free identifiers (needs a binder, for an output that uses no
  globals). Not closed, deliberately: `[].filter.constructor(...)` reaches `Function` through a property chain; the
  scan catches the accidental loader a contributor writes, and a deliberate bypass in SSSB's own source is code
  review's to catch. The script takes `--entry`/`--out-dir` so its tests build into scratch dirs, and refuses (exit 2,
  before touching anything) an `--out-dir` that is neither the package's `dist/`, a new path, nor an empty directory,
  since it wipes its output on failure.
- **Proven from the tarball.** Pack and consume gained a step: plain Node, from the consumer's `seamless` package
  (the one with no seam), imports `@sssb/kit/testing/e2e`, checks it resolved to `dist/testing/e2e.js`, and calls
  the verifier. The consumer's whole-surface typecheck now covers the entry's declarations.
- **The apps' specs moved onto it.** Bundling every file under `apps/*/tests/{e2e,demo-static}` (and the Playwright
  configs) with esbuild, through each app's tsconfig, found three that reached the kit at run time:
  `simulator-webhooks.spec.ts` (`core/webhook-signing`, now `@sssb/kit/testing/e2e`), `tickets-pagination.spec.ts`
  (`src/domain/tickets` imports `core/state-machine`; `TICKET_PAGE_SIZE` moved to `src/domain/ticket-page-size.ts`,
  which `tickets.ts` re-exports) and the static demo's `static-shell.spec.ts` (`src/app-config/presets` imports the
  `ticket.assign` definition, which runs `core/abilities` and `core/roles`; the preset list moved to
  `src/app-config/presets/list.ts`, which `presets.ts` re-exports). `tours.spec.ts` reads `src/app-config/tours`,
  whose kit import is type-only and erased. The starter's specs reach nothing. That check is now the gate
  `sssb check-e2e` (below); the lint ban on other `@sssb/kit/*` imports from specs is P6's preset (ADR-0014 part 4).

## The conformance suite's unit half: what moved, what stayed, and the choices the design left open (2026-11-18, ADR-0014 P5, `feat/conformance-suite`)

`@sssb/kit/testing` (`conformanceSuite({ appDir, optOut })`) replaces the five seam-conformance test files and the
authorization scan's walk of `apps/*`; each app calls it from `src/sssb.conformance.test.ts`. The design (checks as
data in `checks.json`, fixed test names, named opt-outs, the file-level skip guard, app-owned exemptions, the seam
map, the cutover rows as data) was set before the work; these are the calls it did not pin down.

- **The app file passes `appDir: path.resolve(import.meta.dirname, '..')`.** Measured under the app projects'
  happy-dom environment (Vitest 4.1.12): `import.meta.dirname` and `import.meta.url` are the file's real path and
  `file:` URL, in the app and in kit code alike; only the global `URL` mis-resolves a relative reference. So the
  suite takes a directory, never reads `process.cwd()`, and resolves nothing with `new URL`.
- **An app's `authz-exemptions.mjs` is loaded with Node's `require`, not `import()`.** Under happy-dom, Vite reads an
  absolute path as a URL under the project root and refuses a `file:` URL, so a dynamic import of the file failed
  ("Cannot find module") for any app outside the Vitest root. `require` of an ES module is Node's own (22.12+), and
  the file is plain JavaScript, as `lint-exceptions.mjs` is.
- **"Collides with a framework entry" means overlaps, not only equals.** An app entry fails if its key equals a
  framework exemption or required-alongside key, sits under a framework prefix, or is a prefix over one: an exact
  entry wins over a prefix in the scan, and an exemption is checked before the `service/` gate, so an app file entry
  at `webhooks/x/route.ts` or `service/x/route.ts` would otherwise weaken a framework gate. A malformed or colliding
  entry is reported AND not applied.
- **The per-handler results are one assertion.** The test names are fixed (doctor computes them), so
  `every mutating handler reaches authorize(...) or passes its exemption's gate` lists every failing
  `<app>: <rel> <VERB> …` line; likewise the numbering, catalog-key and preset-copy checks list every offender instead
  of stopping at the first (`expect.soft` for the ICU placeholders).
- **Three migration cases stay the kit's own** (`packages/kit/src/db/migrate.test.ts`): `outOfSequence`'s unit case,
  the synthetic-registry case, and the refuse/renamed cases. The last two exercise the guard on the FRAMEWORK
  sequence (the first and second framework migrations), and nothing an app registers changes the outcome: the
  app's migrations only ride along in `migrateToLatest`, and if they fail, `rls-pglite` and `migration-order` fail
  first. Moving them would add two pglite migrations to every app's run for no new coverage. `migration-order` keeps
  the numbering and the upgrade-to-the-same-schema case, which are about how the two sequences compose.
- **The demo-presets mocks are `vi.doMock`, registered while the file is collected, and proven applied.** A
  library's `vi.mock` is not hoisted; `doMock` (resolved relative to the calling module, measured) applies to every
  later import, and the suite imports everything that reaches the adapter registry inside a test. The mocked
  registry carries a marker, and the two tests that replay check it first, so a mock that silently did not apply
  fails with a sentence instead of replaying on the real adapters.
- **The replay's data dir is ASSIGNED, not `vi.stubEnv`ed** (`setDataRoot` in
  `packages/kit/src/adapters/fake/data-dir.ts`, where the lint allows an env write, restored in the check's
  `afterAll`), and each test that reaches the adapters first proves `dataRoot()` is still the scratch dir. Under an
  adopter's `unstubEnvs: true` Vitest unstubs before every test, so the replay fell back to `<cwd>/.data` and reset
  the developer's dev world (reproduced). Rejected: a lint exemption for `demo-presets.ts`, and re-stubbing in a
  `beforeEach` (a concurrent test's unstub still undoes it mid-test).
- **`seam-specifiers.json` is checked against the `files` allowlist read in order** (npm's last-match-wins), and a
  seam module's spelling anywhere other than an import specifier (a template, a string) fails the scan. Today the
  shipped source imports 18 specifiers, all literal.
- **`cutover/rows.json` holds `{ id, what }` verbatim from the "## Rows" table**, markdown and all, including
  `release-app`, which is SSSB's own repository's row: equality with the doc is the rule. That row carries
  `"scope": "sssb"`, which doctor reads (below).
- **The contract checks are in `checks.json` too** (`contract-owner-pass`, `contract-rls`, `contract-data-api`,
  `runner: "contract"`), named from the old `tests/support/contract-suite.ts` tests and two of
  `rds-data.contract.test.ts`'s; `contractSuite` (next entry) registers them. The unit suite refuses an opt-out
  naming one.
- **The skip guard is a file-level `aroundAll`, checked after the whole file has run.** It began as an `afterAll`;
  Vitest abandons a suite's remaining `afterAll` hooks at the first that throws, so a guard that fired skipped
  `server.stop()` and the scratch-dir cleanup. `aroundAll`'s teardown runs after every `afterAll` of the file under
  any `sequence.hooks` (Vitest >= 4.1, inside the peer range). Rejected: registering the guard first (right only under
  `stack`), wrapping the checks in an enclosing `describe` (changes every full name doctor computes), and having the
  guard run the cleanups itself. The guard tells three causes apart: a check kept from running by a failed setup hook,
  one that was to run when the file started and did not (a cancelled run: `--bail`, an interrupt), and only the rest
  as an `.only`, `.skip` or name filter.
- **Each check's tests run in order, whatever the adopter's config says** (`describe.sequential`, which changes no
  name). Under `sequence.concurrent: true` the demo-presets replay always failed: Vitest's mocker hands an import made
  while a `vi.doMock` factory is still running the REAL module, and two of the check's tests imported the registry at
  once; the checks' shared state (the data root, the fake world) wants order too. Rejected: warming the mock in a
  `beforeAll` (fixes the race, not the shared state) and documenting "don't use `sequence.concurrent`" (a false red
  with no escape but an opt-out).
- **Without isolation the suite cleans up per file.** Under `isolate: false` the replay's pglite client stayed cached
  on `globalThis` pointing at the scratch world, and the kit's `tmp-dir.ts` registered its one cleanup hook in the
  first file only. Now the demo-presets check's `afterAll` closes the fake db, restores the data root and removes its
  scratch dir (`removeTestTmpDir`), in one hook so the order holds; and `tmp-dir.ts` registers a hook for each later
  file whose first call comes while it is collected. Rejected: `process.on('exit')` (pool teardown may not fire it)
  and pushing into Vitest's runner hooks (internals, in a shipped file). `@sssb/tools/testing/tmp-dir` has the same
  single-hook flaw, left for `.claude/future-tasks/resolved/tools-tmp-dir-without-isolation.md`.
- **The demo-presets check's teardown waits for a replay that outlived its test.** A Vitest timeout fails the test
  but cannot stop its body: the replay ran on into `afterAll`, which closed the db and restored APP_DATA_DIR, and the
  replay then wrote `auth/`, `pglite/` and `simulator/` into the working directory's `.data` (reproduced: a probe that
  parks the first preset's invite for 1.5 s past a 300 ms timeout, with a second file keeping the worker alive). Now
  the replay test's body is recorded on the file's scratch world; `afterAll` marks the world stopping (the replay stops
  before its next preset) and waits for the body to settle, up to 30 s (`demoPresets.replayStopWaitMs`); only then
  closes the db, restores APP_DATA_DIR and removes the dir. If the body is still running after the wait, the teardown
  FAILS saying so and leaves APP_DATA_DIR on the scratch dir, closing and removing it once the replay settles (the db
  only if the adapters still point there). The hook's own timeout is the wait plus 30 s (it was the adopter's
  `hookTimeout`). Pinned by the two timed-out-replay cases of `packages/kit/src/testing/conformance/adopter-config.test.ts`,
  both seen red with the wait removed. Rejected: waiting on simulator-admin's world queue (`tail`): it covers
  `applyDemoPreset`'s reset and script but not the test body's reads after it (`readActorHolds` makes its directory
  under the data root, `listMembers` and `getCurrentUser` reach auth files and the db), which would then run against
  `.data`; and keeping APP_DATA_DIR on the scratch dir unconditionally, which leaks the dir on every timeout. The
  timeout and the wait are injectable only by mutating the exported `demoPresets` object before `conformanceSuite()`
  registers (the kit's own test does); `@sssb/kit/testing` exports `conformanceSuite` alone, as before.
- **An app's nested exemption prefixes are refused, both of them** (`hooks/` and `hooks/partner/` would leave a route
  under both to whichever the scan met first). Rejected: most-specific-wins in `exemptionFor`, which is shared with
  the framework's policy and would change its matching too.
- **`seam-map` resolves an `exports` target as Node does**, measured against Node: Node's own conditions for an ES
  import, in the target's key order, `null` stopping a conditions object, Node's pattern-key order, a non-empty `*`
  match, and the targets Node refuses (`ERR_INVALID_PACKAGE_TARGET`) reported as such; the target must be a file, and
  a `types`-only entry fails. Rejected: adding a bundler's conditions (`module`, `browser`), which belong to one
  environment and cannot stand in for Node, tsx and migration scripts.
- **`seam-map` matches `module-sync`, and resolves an `exports` array as Node does.** Measured against Node's own
  resolver: each array and condition case in `packages/kit/src/testing/conformance/seam-map.test.ts` gives what Node
  24.19's `import.meta.resolve` gives for a fixture package holding the same map. Node matches `module-sync` by default for an ES import, so
  `{"module-sync": "./ms.js", "default": "./ok.js"}` loads `ms.js`; the conditions are now `node`, `import`,
  `module-sync`, `default`. In an array a `null` item does NOT stop the search: Node goes on to the next item and keeps the null only as the answer if no later item
  gives a file. An array whose items all match no condition is unmatched, so the condition holding it falls through to
  the next one; an empty array is `null`; and when no item gives a file, the answer is the last null-or-invalid item's
  (`[null, "../x"]` is invalid, `["../x", null]` is not found). A conditions object still stops at a `null` (the entry
  above). `seam-map.test.ts` pins `module-sync`, the null item, the invalid item after a null, the unmatched array and
  the empty array, each seen red with its line of `seam-map.ts` reverted. Rejected: nothing new; this
  corrects reading an array's `null` as stopping the search, which holds only for a conditions object.
- **Pack and consume** drops `conformance-by-include`: the consumer apps carry the starter's
  `src/sssb.conformance.test.ts`, their Vitest projects keep `configDefaults.exclude` (node_modules and all), and the
  job requires every unit check's every test, named from the PACKED `checks.json`, to pass in each app, with the
  file itself not failed by the skip guard. The tarball must ship `checks.json` and `seam-specifiers.json` and no
  test file at all.

## The contract runner ships in `@sssb/kit/testing` (2026-11-18, ADR-0014 P5, `feat/conformance-suite`)

- **`contractSuite` from `@sssb/kit/testing/contract`** replaces the repo's `tests/support/contract-suite.ts` and
  `contract-postgres.ts`. Each app's `tests/contract/rls-contract.test.ts` is one call,
  `contractSuite({ port: portFor('contractPg'), optOut: {} })`; the database defaults to `contractDatabaseName` of the
  seam's `APP_SLUG` (`database` overrides it). Its checks are the `contract` checks of `checks.json`
  (`contract-owner-pass`, `contract-rls`, `contract-data-api`), registered, opted out and guarded against skipping by the
  same code as the unit suite's (`packages/kit/src/testing/conformance/register.ts`), in the old order: owner pass
  twice, then the superuser proofs. New: `contract-data-api` runs the app's migrations and proofs, and the owner pass,
  over the RDS Data API transport through the emulator, in `<slug>_contract_data_api`, made empty first so the
  migrations really run through the dialect. Before, only SSSB's fixture met the Data API.
- **The server half is `packages/kit/src/adapters/real/contract-postgres.ts`** (and the Data API passes
  `contract-data-api.ts` beside it), because it drives `pg` and only an adapters directory may import a vendor SDK; the
  testing module imports it, and loads everything that reaches the seam lazily, so `contractDatabaseName` imports with no
  seam (the repo's scaffold gate uses it). No lint exemption was widened; the package-edge rule lost its two named
  exemptions (the kit's own contract tests no longer reach `tests/support`). The emulator ships, as before, under `src`;
  it gets no `exports` subpath because nothing outside the runner needs it.
- **`embedded-postgres` is an OPTIONAL peer of `@sssb/kit`**, imported with `import()` only when
  `CONTRACT_DATABASE_URL` is unset, with an error naming the package when it is missing. It is also the kit's
  devDependency, and both apps' (so the template, and pack and consume's consumer, carry it); the root's, and the root's
  `pg` and `@types/pg`, went (knip). Rejected: a plain dependency, which would put Postgres binaries in every adopter's
  production install for a test-only path; an adopter whose CI brings its own server needs none of it. Like `vitest`,
  it is optional at run time, not to the type checker: an app that keeps `tests/contract` keeps the package.
- **The port is the caller's**: `port` (the apps pass `portFor('contractPg')` from `@sssb/tools/ports`), else
  `CONTRACT_PG_PORT`, else a refusal that says which to set. The framework takes no `@sssb/tools` (rule 4), so the kit's
  own contract tests get `CONTRACT_PG_PORT` from `vitest.contract.config.ts`. Rejected: importing `scripts/ports.mjs`
  or `@sssb/tools/ports` from the kit. Scratch directories are the kit's `makeTestTmpDir` (its copy has no async
  variant, and none is needed).
- **Pack and consume runs it.** `contract-test-dropped` is gone: the consumer apps keep `tests/contract`, the workspace
  gets a `vitest.contract.config.ts` built from the preset as an adopter would write one, and a step runs it on
  embedded Postgres on a free port (CONTRACT_DATABASE_URL blanked) and holds each app to every `contract` test of the
  packed `checks.json` (`expectedConformanceTests(registry, 'contract')`, `conformanceProblems`). No service was added
  to the workflow.

## `sssb doctor` and `sssb check-e2e` (2026-11-18, ADR-0014 P5, `feat/conformance-suite`)

ADR-0014 part 5 names doctor's three checks and part 3 its `vitest list`; part 2 names check-e2e. What they left open,
as it stands after three rounds of review (ADR-0014's addendum "P5 as built" lists where this departs from its body):

- **One doctor run checks the whole workspace.** Doctor walks `pnpm-workspace.yaml` for every importer of `@sssb/kit`
  (in any dependency field, `peerDependencies` included) and every APP (in-repo, `sssb.apps` or `apps/*`; otherwise
  every importer with its own `src/app-config`), and gives each app the per-app checks. So the root's `sssb:doctor` is
  one `sssb doctor`, and an app's own `sssb:doctor` checks every app too. It fails unless the app it runs for is among
  the importers it found and, when that app has a seam, among the apps: the first walk read a column-0 `packages`
  list as empty and passed every workspace-wide check over nothing. Rejected: `pnpm --filter './apps/*' sssb:doctor`,
  which silently skips an app without the script; and a `--app apps/<x>` per app, which ejecting or renaming breaks.
- **`pnpm-workspace.yaml` is read by a small reader that throws on what it does not understand**, naming the line
  (in `packages` or `dedupePeerDependents`: anchors, aliases, tags such as an unquoted `!glob`, nested items; anywhere:
  a duplicate key, a second document, a flow collection still open at the end; any other key's value is skipped
  unread, `parseWorkspaceYaml` in `packages/tools/src/commands/doctor-checks.js:58`), and a file it cannot read is a
  FAIL that stops the run. Rejected: the `yaml`
  package, which `packages/tools` reaches only through the root's hoisting; and a reader that returns what it can,
  which is how the empty list happened.
- **Doctor reads `vitest list --json=<file>`, never stdout.** Vitest 4 writes the list to the file when `--json` is given a
  path (`--outputFile` is ignored by `list`), so Vite's warnings on stdout cannot corrupt it. When a test file throws
  while it is collected (an opt-out typo), Vitest exits 1 and writes NO file; doctor then names Vitest's error line
  (never its `Collect Error` banner) and every expected test as not listed. Rejected: parsing stdout between brackets.
- **Which Vitest runs hold an app to which checks.** Discovery is `vitest list --filesOnly`, which loads each config and
  globs but runs no `globalSetup` (measured, Vitest 4.1.12). The MAIN unit run is the first run a bare `vitest` would
  make for the app that runs any of its `src/` test files: from the root with the root's own config, then from the app
  with the config Vitest finds walking up (the app's, else the root's, else Vitest's defaults). It must list every unit
  check; no such run, or a bare run doctor cannot list, fails. Some config that runs the app's `tests/contract/` files
  must list every contract check. Every other config (each `vitest*.config.*` at the root and in the app, and the
  `vite.config.*` Vitest itself would load) that runs some of the app's `src/` tests but not its suite file, runs its
  contract files without every contract check, or cannot be listed, is a REPORT that names it. Only the main run and
  the contract configs are listed in full. The projects are the ones that run a file inside the app, asked rather than
  assumed by name (here the contract projects are rooted at the repo). Rejected: holding every config that runs any of
  the app's tests to every check (round 1), which failed a browser, integration or env-gated config beside a passing
  main one with no escape but deleting it, held a build-only `vite.config.ts` to the suite, and ran every such
  config's `globalSetup`; and guessing CI's config from workflow files.
- **What that rule does not catch, accepted.** A CI step that runs a non-main config (a `vitest.ci.config.ts` excluding
  `**/sssb.*`) is a report, not a failure, so CI can go green without the checks if nobody reads it; and a non-main
  config that does run the suite file is not listed by name, so a `testNamePattern` set there is not seen. Doctor
  cannot see which config CI runs, as it cannot see CI's flags; failing every config made legitimate ones impossible
  to keep.
- **The bare `vitest` from the app's directory is reported when the root's bare run is the main one** and the app's
  would not run `src/sssb.conformance.test.ts`, even when it runs none of the app's `src/` files: a root config with
  root-relative globs finds nothing from the app and passes on `passWithNoTests`, so an app script `vitest run` under
  `pnpm -r test` runs no check. Found with `--filesOnly` only (no `globalSetup`), and report-only: it never joins the
  contract configs, which are listed in full and alias-checked (`planFor` in `packages/tools/src/commands/doctor.js`).
  The report names the run (a bare `vitest` from `apps/web` loads `vitest.config.mjs`), what it runs ("none of its
  src/ test files, so not src/sssb.conformance.test.ts"), and that if CI runs it there (the app's own scripts,
  `pnpm -r`) instead of the main run from the root, the conformance checks do not run. Pinned by
  `tests/tooling/tools-doctor.test.ts` ("reports, and does not fail, the bare `vitest` from the app's directory…"),
  seen red with the report removed.
  Rejected: failing it (doctor still cannot see which run CI makes; the main-run rule is unchanged), and adding it to
  the contract configs: in SSSB's own repository the root config run from `apps/showcase` lists the showcase's
  `tests/contract/` file under the `repo` project, which has no seam alias, and that turned `sssb doctor` red.
- **CI's command line is reported, not checked.** Doctor reports every narrowing flag or file filter (`-t`, `--project`,
  `--exclude`, `--shard`, `--changed`, `related`, a positional path...) that the root's and the apps' package.json
  scripts pass to vitest, and, since it lists the contract checks and never runs them, which script runs each app's
  contract config, or that none does. Rejected: failing on a narrowing flag (a sharded CI is legitimate, and doctor
  cannot see the other shards).
- **Check names and opt-out markers count only from the app's own suite files**: the unit ones from
  `<app>/src/sssb.conformance.test.ts`, the contract ones from `<app>/tests/contract/`, never from a workspace package
  nested in the app. Each opt-out prints as a report with its reason. Rejected: a marker from any listed test (round
  1), which let an ordinary test file opt a check out.
- **Optional peers** (`vitest`, `embedded-postgres`): neither side has it is a note (not installed); only the kit finds
  it is a note (not the app's to share); only the app finds it fails, because the kit would load another copy or none.
  A required peer the app cannot find fails. Peers are compared as real package DIRECTORIES found by walking
  `node_modules` up from each side, never NODE_PATH (the shared resolver's reason).
- **In-repo mode is detected, not configured**: the kit the app resolves is in-repo when its real directory is one of
  the workspace's package directories. There the per-importer seam check is replaced by an alias check over every
  app: each target of every tsconfig `paths` key that is or starts with `@sssb/app-config` (read by the app's own
  TypeScript, so `extends` and `baseUrl` count), and every alias, string or RegExp, that would match a seam specifier
  in the Vitest projects of the app's main unit run and contract configs (read through `createVitest`), must land in
  the app's own `src/app-config`. Every matching alias counts, not only the one that wins today; a tsconfig key that
  matches only by wildcard (`@sssb/*`) is not covered. The other importers (the root, `packages/seed`) are named as
  not checked: in-repo each compiles within a program that names a seam. Rejected: a flag or environment variable,
  which an adopter could set.
- **The per-importer walk includes the workspace ROOT** (pnpm treats it as an importer). The seam an instance runs on
  is `@sssb/app-config` as Node's lookup finds it from the kit's own directory, and doctor names whose seam that is.
- **Versions in step** cover every `@sssb/*` the app resolves (nearest `node_modules/@sssb` first), the seam left out.
  The workflow-SHA and plugin-pin comparisons print "not checked" with the reason: nothing to compare yet (no release
  stamp, no reusable workflow until P10, no plugin until P13). Doctor runs `sssb guide --check` once the kit ships a
  guide (`guide.js` already promised it), and reports that it does not until then.
- **SSSB-only cutover rows**: a row marked `"scope": "sssb"` in `rows.json` (`release-app`) is not looked for in an
  adopter's checklist, and doctor says it skipped it. `tests/docs/cutover-rows.test.ts` holds the field to the
  checklist's own wording (exactly the rows whose "What it is" begins "SSSB's own repository only"). Rejected: doctor
  matching that wording itself, which made a sentence in a doc the switch.
- **The scripts are `sssb:doctor` and `check:e2e`, not `doctor`**: `pnpm doctor` is pnpm's own command and shadows a
  script of that name (measured: the root's `pnpm doctor` ran pnpm's environment check and exited 0). The root's
  `check:e2e` fans out over `apps/*`.
- **check-e2e asks Playwright which files it loads.** Each config (`playwright*.config.*` in the app, plus each
  `--config <file>`) is listed by the app's own Playwright from the app's directory, `playwright test --list
--reporter=json`, the report written to a file (`PLAYWRIGHT_JSON_OUTPUT_FILE`: a spec's own output shares stdout).
  Measured on Playwright 1.65.1, `--list` starts no `webServer`, runs no global setup and needs no browser. The checked
  files are each config, the global setup and teardown the report names, and every file holding a listed test; each
  is then bundled. A config Playwright cannot list fails with Playwright's error (and the kit file, when the error
  names one); a config that lists no test fails. Rejected, in order: reading the configs' text with regexes (a
  template literal, `path.join`, a project-level `testDir` or an array `globalSetup` each defeated it); loading them
  ourselves through an esbuild bundle (any `require` broke it, Playwright's own CommonJS scaffold and
  `globalSetup: require.resolve(...)` included, while Playwright loaded both); re-implementing Playwright's file
  selection; and the hidden `test-server` command's `listFiles`.
- **What Playwright's report cannot say.** Any load error makes `--list` list nothing, and Node's error for TypeScript
  under `node_modules` names the kit file but not the spec, so in an adopter's workspace a spec reaching the kit's
  source fails its CONFIG, with the kit file named; the per-spec import chain is reported wherever Playwright can load
  the spec (this repository, where the kit is workspace source). The report holds only the FIRST entry of a
  `globalSetup`/`globalTeardown` array, so a second is not checked; and a matched file holding no test is not listed.
- **check-e2e follows what Playwright transforms**: a bare specifier is bundled when its real path is outside
  `node_modules` (the app's files, a sibling workspace package such as Pages' `packages/gate`, and what they import)
  or is framework source in any copy (`isFrameworkFile`); every other package stays external. The allowed set comes
  from bundling `@sssb/kit/testing/e2e` alone from the app: in-repo its source closure, from a tarball the compiled
  file only. A failure names the file, the kit file where it ENTERS the kit, and the import chain. Rejected: bundling
  only the app's own files (the first version), which left a workspace package external and missed a spec reaching the
  kit through it.
- **`createRequire` is checked by the app's own TypeScript parser**: a followed file outside the kit whose code names
  `createRequire` fails for each `@sssb/kit` string literal in its code that esbuild did not resolve, except the entry
  and `@sssb/kit/package.json`. Rejected: a regex over the text, which matched comments and failed
  `createRequire(import.meta.url)('@sssb/kit/package.json')`.
- **Pack and consume proves both from the tarball.** The negative fixture joins after the verify, with a second
  install: doctor walks every package, so with `packages/seamless` installed from the start the verify's doctor could
  not be green. The consumer's console carries `tests/e2e/kit-entry.spec.ts`, which imports `@sssb/kit/testing/e2e`
  and an app domain module; check-e2e must pass it, `playwright test --list` must load it (even with
  `--skip-build-and-e2e`), and with two specs dropped in that reach `@sssb/kit/core/webhook-signing` (directly and
  through an app module) check-e2e must exit 1, failing `playwright.config.ts` as unlistable and naming
  `@sssb/kit:src/core/webhook-signing.ts`. Rejected: adding the spec to `apps/starter` itself, whose one e2e spec is
  its tenancy claim.

## `@sssb/tools/testing/tmp-dir` under `isolate: false`: a setup module, and never removing too early (2026-11-18, `fix/tools-tmp-dir-isolation`)

Resolves `.claude/future-tasks/resolved/tools-tmp-dir-without-isolation.md`.

- **No hook registered at a call is both late enough and wide enough.** The task's design, and the kit's fix in P5,
  register a hook at a later file's first call. Review reproduced, in real Vitest runs, that a hook registered from a
  `describe` body belongs to that `describe` and removed directories the rest of the file still used, and that it runs
  before any `afterAll` the file registered earlier, so the cleanup could precede the file closing what lives in the
  directory. Registering a hook per suite instead still removed a nested `describe`'s directory before an outer test
  used it. The kit's copy is unchanged here and has the first two: `.claude/future-tasks/resolved/kit-tmp-dir-cleanup-order.md`.
- **A setup module carries the file's hook,** and is the supported path under `isolate: false`. Vitest runs a setup
  file before every test file even with `isolate: false`, and an `afterAll` it registers runs after the file's own
  (checked with Vitest 4.1.12, three files in one worker). `@sssb/tools/testing/tmp-dir-setup` calls
  `registerTestTmpDirCleanup()`; `appTestProject` adds it to every app project, so an app on the preset needs nothing.
  Rejected: asking adopters to import the helper first in every file (a later file's import is a cache hit, which
  registers nothing).
- **Without it, never too early, at the cost of the last file.** A later file's first call registers a hook that removes
  only EARLIER files' directories (a worker runs files one after another, so those files have finished). Every file's
  directories are removed except each worker's last file's, which `sssb check-tmpdir-leak` reports, and the helper says once per
  worker which setup file is missing. A leak the gate names is recoverable; a directory removed under a running test
  is a false red.
- **A file's first registration removes what earlier files left.** Vitest runs no `afterAll` for a file whose tests are
  all skipped (`it.skip`, a `-t` filter), so its directories stayed queued; they go when the next file in the worker
  registers, and that file's stale registry entries go too, so a watch-mode rerun registers again. With isolation
  nothing carries to the next file, so a skipped file's directories are left for good; that predates this change and
  is Vitest's. The cleanup's place after the file's own `afterAll` also assumes `sequence.hooks: 'stack'`, Vitest's
  default; `'list'` and `'parallel'` reverse it. Both limits are in the module's header.
- **`removeTestTmpDir` removes only what the helper made.** The kit's removes any path it is given, recursively.
- **A new `exports` subpath, so the changeset is a `seam` entry,** optional: an app on the preset gets the setup module,
  and another project with `isolate: false` adds it to `setupFiles`.

## The first release candidate, cut by a merge to main (2026-11-18, ADR-0014 P7, `feat/release-candidate`)

JP, 2026-11-18: "I don't want publishing a release to be my call separately from merges to main." Each decision below
names what was rejected; ADR-0014's addendum of the same date summarises them.

- **Changesets' pre mode `rc`, not a hand-pushed tag.** A merge to `main` with changesets versions the group to
  `0.x.y-rc.N` through `release.yml`'s existing `plan` and `push`, so a candidate passes the same gates as a release
  (CI on the merge commit, `verify-release` in the job holding the key, the atomic push). Rejected: a separate
  `workflow_dispatch` or a tag pushed by hand, each a release step apart from the merge, which is what JP ruled out.
  This reverses P1b's "never Changesets' pre mode" (its `loadWorkspace` refused a `pre.json`).
- **Private packages are versioned, and everything outside `@sssb/*` is ignored with `"*"` and `"@app/*"`.** Without
  the ignore the apps, their infra and the showcase's seed are bumped as dependents (seen: `showcase -> 0.1.1-rc.0`).
  Rejected: naming the apps (`init-app` renames them), and `"!@sssb/*"`, which Changesets' matcher does not read as a
  negation (seen: every app still planned).
- **Pre mode and privacy are tied by `release.mjs check`**: a private group needs pre mode `rc` and a config that
  versions private packages; a public group must have left pre mode. Rejected: leaving it to review, since a private
  group outside pre mode would cut a plain `0.x.y` on the next merge, tagged, with nothing able to publish it.
- **`verify-release` recomputes the candidate's number itself**, because the `push` job installs nothing: semver's
  `inc` on the group's version (a prerelease bumped by a patch or a minor is already on its way there), then one past
  the group's highest `-rc.N`, which is Changesets 3's `getPreVersion` over a fixed group. `prepare` refuses to go on
  when Changesets' number and this one differ. A consumed changeset must be moved to `.changeset/pre/` byte for byte.
  Rejected: trusting the plan job's number, which ran dependency code.
- **The tarballs attached are the ones CI tested on the release commit**: `checks`' pack-and-consume job uploads them
  as `sssb-tarballs` on a push (overwriting on a re-run, so the artifact is the last attempt's), and `candidate`
  downloads that run's artifact after the CI gate. Rejected: packing again in the tag run, whose bytes nobody tested.
  Pack and consume now packs `@sssb/cdk` too (its packed shape checked, not installed: P12).
- **The id-token on a candidate's tag is `attest`'s**, in no environment, so npm's trusted publisher (bound to the
  `npm-publish` environment) refuses it; a candidate's tag never runs `pack` or `publish`. Each run holds the id-token in
  one job. Rejected: attesting in `prerelease`, which would put the id-token beside `contents: write`.
- **`prerelease` creates a draft, uploads, downloads every asset to compare sha256s, then publishes** as a prerelease
  never marked latest; a re-run finishes a draft and confirms a published candidate, and fails rather than replace one
  whose bytes differ. Rejected: `gh release create` with the assets in one call, which on a failure part-way leaves a
  visible prerelease missing a tarball while the run is red.
- **The pre-changeset history is four changesets**, `.changeset/history-since-keel-*.md`, one per section, consumed by
  the first candidate. Rejected: a seed file the assembler would include once, which needed a change to
  `scripts/release-notes.mjs` (another session's) and a rule for "once" that changesets already have.
- **The install lines use `overrides`** in `pnpm-workspace.yaml` as well as each package's dependency, because the packed
  `@sssb/cdk` depends on `@sssb/tools` at exactly its version, which npm does not have (seen: offline, cdk's tarball
  installed with tools resolved to its tarball through the override).
- **The app guide: `sssb doctor` reports a missing copy in this repository** rather than failing, because here the guide
  is the source and no copy is kept until this repo's `CLAUDE.md` imports one (P13); in an adopter's workspace it fails.
  Rejected: committing `.claude/sssb-guide.md` now, a second copy of the guide nothing reads yet. The guide's changeset is
  a `seam` change, `required`, because doctor now fails an adopter who never runs `sssb guide`.
- **Until JP makes the release app, a merge to `main` with changesets fails at `push`'s token mint**, having written
  nothing; the changesets stay pending. Rejected: skipping `push` when the app is missing, which would turn a missing
  release into a green run, the failure the review question names.
- **What the reviews added (P7).** Both found the flow sound: no path to npm, to a non-candidate version while private,
  off `main`, or to tarballs other than the tested ones. Closed after them; each is seen failing in a test except
  three no unit test reaches: `prepare`'s cross-check reading the manifests (`check` refuses a split group first), pack
  and consume's unpacked-package check (CI runs it), and `overwrite` on the `candidate` artifact (a workflow setting):
    - `check` refuses a fixed group at more than one version (a package joining mid-cycle at `0.1.0` passed `check` and
      `prepare`, then stalled `push`), and a pending changeset named like one in `.changeset/pre/` (Changesets would
      overwrite it); `prepare`'s cross-check reads the manifests, not the plan, whose `oldVersion` Changesets evens out.
    - `candidate` requires each tarball's file name to be the one `pnpm pack` gives it; pack and consume fails when a
      `@sssb/*` package is not packed, at PR time rather than after a candidate's tag exists.
    - `prerelease` treats only "release not found" as no release, re-uploads every tarball into a draft with
      `--clobber`, and publishes with its own title and notes, so neither a lookup failure, a half-written asset nor a
      draft someone else made decides what goes out; `candidate`'s artifact overwrites on "Re-run all jobs".
    - The notes' attestation check names the signing workflow, the tag and the commit (`--signer-workflow`,
      `--source-ref`, `--source-digest`), not just the repository, which any workflow of it could satisfy.
    - The prerelease notes are unwrapped (`unwrap`): a release body renders each newline as a line break, seen through
      GitHub's markdown API in `gfm` mode; with soft breaks joined, the rendered sample had none.
      Left for P14: leaving pre mode (`.claude/future-tasks/p14-leave-pre-mode.md`).

## The kit's tmp-dir helper under `isolate: false`: the suites register its hook (2026-11-18, `fix/kit-tmp-dir-cleanup`)

Resolves `.claude/future-tasks/resolved/kit-tmp-dir-cleanup-order.md`, the kit's half of
`.claude/future-tasks/resolved/tools-tmp-dir-without-isolation.md`.

- **`conformanceSuite` and `contractSuite` register the file's cleanup hook first.** The kit's helper
  (`packages/kit/src/testing/tmp-dir.ts`) is not in the package's `exports`, so an adopter reaches it only through those
  two. Both must already be called at a file's top level, so a hook they register is the file's own, and registered
  before their own `afterAll` (the contract server's stop, the demo-presets teardown), so it runs after them. The kit's
  P5 fix registered the hook at the helper's first call instead. Under `isolate: false` that call came from the suites'
  `beforeAll`, where Vitest drops a hook, so a later file's contract-server directory was left behind. Seen red with
  the suite's call removed, once for each suite.
- **Rejected: a kit setup module that the app's Vitest config lists** (`@sssb/kit/testing/tmp-dir-setup`, mirroring
  `@sssb/tools/testing/tmp-dir-setup`). Every app's unit and contract configs would have to list it, or the tools preset
  would have to carry a `@sssb/kit` specifier. A string resolved from the app's directory keeps rule 4's letter, that
  `@sssb/tools` imports no kit module, and breaks its point, that `@sssb/tools` knows nothing of the kit. It would also
  run a second setup module before every file of every app. The suites registering their own hook needs nothing from
  the adopter.
- **A replay that outlives its file keeps its directory, out of the file's cleanup.** When the demo-presets replay
  outlasts its teardown's wait, the teardown fails and leaves the replay its scratch directory, to be removed when it
  stops. Vitest still ran the file's cleanup hook after that teardown failed, which deleted the directory under the
  running replay. The replay recreated it without its marker, so the leak gate could not see it. The old
  `removeTestTmpDir`, which removed any path, then removed it, hiding all of this; with the new guard the case
  "when the replay outlasts the wait too" went red. `keepTestTmpDir(dir)` now takes the directory out of the file's
  cleanup, and `removeTestTmpDir` removes it, with its marker, when the replay stops. Seen red with the call removed.
- **Limit: one suite call, at the file's top level,** as both suites' docs already say. Under `isolate: false`, a later
  file that calls a suite inside a `describe` gets that `describe`'s hook. A second call in another `describe` then
  gets none, so its directory waits for the next file. Nothing in use is removed.
- **The rest follows `@sssb/tools`' copy**, for the same reasons (its entry above):
    - a later file with no hook removes only earlier files' directories, never its own, and the helper says so once per
      worker;
    - a file's first registration removes what earlier files left;
    - `removeTestTmpDir` ignores a path it did not make, where the kit's used to remove any path, recursively.

    The two copies stay separate files (rule 4), so the same change lands twice. jscpd does not compare them: its pattern
    takes `.ts`, and `@sssb/tools`' copy is `.js`.

## Retiring init-app, the adoption probe and the adopter-identity test (2026-11-18, ADR-0014 P12, `feat/sssb-create`)

ADR-0014's Consequences retire all three when `@sssb/create` ships, and its P12 row does it in the same PR as the
generator. What went, what replaced each, and what was kept:

- **`scripts/init-app.ts`, the root `init-app` script, `tests/tooling/init-app-slug.test.ts`, its `CODEOWNERS` line.**
  Replaced by `@sssb/create` (`pnpm create @sssb <dir>` / `npm create @sssb <dir>`), which writes a new workspace
  from `apps/starter` instead of renaming and ejecting inside a fork. The slug refusals the slug test pinned (reserved
  names, Aurora's database-name rules) are the generator's to carry; `@sssb/cdk`'s `databaseNameFor` and its
  synth-time refusal stay, since the construct still needs them.
- **The `adoption-probe` job's steps** (copy the checkout, `init-app acme --eject-showcase --yes`, `pnpm verify`,
  synth). **The job name is kept**: `integration`'s ruleset requires a check called `adoption-probe`, and
  dropping the name would block every PR until the ruleset was edited. The new job of that
  name generates a workspace with the packed `@sssb/create` and runs its own `pnpm verify`, which is what the old
  probe proved for a fork: that an adopter's first command leaves a green gate. It is pack and consume's second
  shape (below, "Pack and consume's two shapes and the `adoption-probe` job");
  `tests/tooling/app-checks-workflow.test.ts` still pins the name.
- **`tests/docs/adopter-identity.test.ts`.** Dropped, as ADR-0014's table says: the generator writes the owner files
  from its flags, so there is no maintainer identity in an adopter's tree to scrub. The check that the template's
  own owner files name the maintainer went with it.
- **Kept: `tests/docs/doc-set.ts`**, shared with init-app until now. It lost what only the rewriter used (`EXEMPT`
  and the `generalizeAppCitations` wrapper) and imports `@sssb/tools/doc-paths` by package name, since the reason for
  the relative import (init-app running in a copy with no `node_modules`) is gone. The gate is unchanged.
- **Kept: `generalizeAppCitations` in `@sssb/tools/doc-paths`.** It is a published export, so removing it is a
  release-note decision rather than a cleanup; its tests moved from `tests/docs/doc-set.test.ts` to
  `tests/tooling/doc-paths-engine.test.ts`, which tests the engine directly. It now has no caller in this repository.
- **Kept: the doc gate's reference-app rule** (a citation of an absent `apps/showcase` or `apps/starter` resolves).
  It served forks that took docs by merge; ADR-0014 says it then serves only this repo, and a fork adopted before
  the switch still needs it.
- **Future tasks.** `eject-rewrites-prose-into-false-sentences.md` is resolved by retirement (the rewrite it
  describes no longer exists). `init-app-blank-option.md` became `create-blank-option.md`: a `--blank` option is as
  much needed on the generator. The rest had their init-app mentions retargeted.
- **Docs, as far as P12 needs.** `docs/adopting.md`'s fork and `init-app` sections now start from the generator, as
  built (its usage block is `--help`'s output). The full rewrite, and ADR-0013's supersession, are P15.

## `@sssb/create` (2026-11-18, ADR-0014 P12, `feat/sssb-create`)

`packages/create`, `@sssb/create` with the bin `sssb-create` (what `pnpm create @sssb` and `npm create @sssb` run):
plain JavaScript, no dependencies, no `@sssb/*` dependency (rule 4), `private: true` until P14 and in the fixed
group. The choices the P12 row and the design left open, each with what was rejected:

- **The template is the starter's TRACKED files, copied from the working tree, and stamped.** `buildTemplate`
  (`packages/create/src/template.js`) copies what `git ls-files` lists under `apps/starter`, and six generic root
  files (`.editorconfig`, `.nvmrc`, `.prettierrc.json`, the two husky hooks, `commitlint.config.mjs`; `ROOT_FILES`,
  which must be tracked too), each as the working tree has it. Untracked files are left out with one warning naming
  them; a symlink, a submodule, an unmerged file or a tracked file missing from the working tree is refused with the
  list; a checkout without git is refused. It writes `template/{meta.json, guide.md, app/, root/}`, a leading `.` in
  a path segment stored as `_dot_` because npm's packing drops some dotfiles. `meta.json` holds what the generator
  needs once it is away from the repository: the version, the workflow's repository and commit, `packageManager`,
  `engines`, the ranges of the root's tools, the `allowBuilds` approvals, `minimumReleaseAge`, the seam specifiers,
  the framework's cutover rows (less `scope: sssb`), the action pins `app-checks.yml` uses, the gitleaks version
  `checks.yml` uses, and the dependency names the slug check reads (below). The package's `prepack` builds
  `template/` and its `postpack` removes it (it is gitignored, and ignored by Prettier and ESLint), so no copy of the
  starter is ever committed; run from a checkout, with no `template/`, the bin builds one into a temporary
  directory. **Consequence: a new starter file must be `git add`ed before a local pack or the create tests see it.**
  Rejected: round 0's deny-list over the working tree (it copied any local file nobody listed, such as an `.npmrc`
  holding a token, a key, `.vscode/` or a swap file, and dropped symlinks silently);
  `git ls-files --cached --others --exclude-standard` (still packs a developer's unignored local file, the leak the
  deny-list had); refusing when
  untracked files exist (blocks every local test run while a new starter file is unstaged); copying symlinks (what a
  link points at is outside what git tracks, npm's packing treats links inconsistently, and the starter has none);
  building from `HEAD` with `git show` (a second copy path the tests, which build from the working tree, would not
  exercise). Also rejected: the generator reading the seam specifiers from `@sssb/kit` when it runs (rule 4; and it
  runs before anything is installed).
- **The workflow pin is the packing commit, and packing checks it is on GitHub and is the template's.** The pin is
  `git rev-parse HEAD`, asserted to hold `.github/workflows/app-checks.yml`; `--workflow-ref <sha>` overrides it. An
  adopter's `uses:` resolves only if that commit is on GitHub, so `prepack` (`scripts/build-template.js`) refuses a
  `HEAD` that no remote-tracking branch contains (`git branch --remotes --contains`, as of the last fetch: no
  network) of a remote whose path is the package's `repository` (`unpushedPin`). The remote is recognized by its
  PATH, `safeinsights/sssb` (case-insensitive, `.git` and a trailing `/` optional), in an scp-like URL (any ssh host
  alias) or one with a scheme (`ssh://git@ssh.github.com:443/…` included); a local path or `file://` is not a
  network remote. It also refuses template sources that differ from `HEAD` (`uncommittedSources`:
  `git status --porcelain --untracked-files=all -- apps/starter packages/kit/src/guide.md`, so modified, staged,
  deleted or untracked), since the template is copied from the working tree and the release it ships in is `HEAD`'s.
  **`SSSB_CREATE_UNPUSHED_PIN=1` turns both into warnings**, for a tarball no workspace will run on GitHub. Pack and
  consume sets it but on a push to `safeinsights/sssb` (`createPackEnv` in `scripts/pack-and-consume/checks.mjs`),
  the one run whose tarballs a release candidate attaches. The checkout path (`node packages/create/bin/create.js`)
  only warns about the pin, on stderr, and does not check the sources: a developer generating while editing the
  starter is its normal case, and it is how the repository's own tests generate. Rejected: asking GitHub (network
  at pack time); failing the checkout path too; requiring `github.com` in the URL (misses ssh aliases and
  ssh-over-443; the known looseness is that a mirror at that path counts, a fork never); turning the checks on for
  any push (a fork's push to its own `main` would fail: its commit is on no branch of SSSB's remote); refusing only
  tracked changes (strict is simpler to state, and a pack that needs an untracked file opts out).
- **The generated workflow is `.github/workflows/checks.yml`**, not the design's `ci.yml`: the starter's
  `infra/README.md` already says "`.github/workflows/checks.yml` runs checks only", which is then true in both
  trees. Three jobs: `sssb` (the reusable workflow at the pinned SHA, `permissions: contents: read`,
  `synth: ./apps/<slug>/infra`, no secrets), `workspace-checks` (knip and jscpd, which `app-checks.yml` does not
  run) and `secret-scan` (gitleaks as a pinned binary over the whole history, as SSSB's own). Triggers are pushes to
  `main` and pull requests, with `permissions: {}` at the top. The one check to require is `sssb / all-checks`, as
  P10 decided; the generated README asks for the other two jobs as well.
- **The seam package's `exports` is one pattern plus the directory modules**: `./*` to `./*.ts` for the flat
  modules and each directory module by name (`./db/migrations` to `./db/migrations/index.ts`), computed from the
  seam specifiers against the template's seam; a specifier with no module fails generation. Rejected: a line per
  specifier, which would leave a seam module a later kit adds unexported until the adopter edits the map. **Its
  `type` is the app's own** (the starter declares none, so none is written), as pack and consume already did.
  Rejected: the design's `type: module`, since a nested `package.json` resets the module type for everything under
  it and the app's other files are CommonJS-typed (its configs use `__dirname`).
- **The port service stays `starter`.** The generated app keeps `"sssb": { "port": "starter" }`,
  `originFor('starter')`, `sssb tick starter` and `sssb dev-tick starter --`. The service names a port band in
  `@sssb/tools` (`packages/tools/src/ports.js`: an app keeps the slot it was generated with when it is renamed), not
  the app. A rename is a tools change, out of P12's scope; `tests/tooling/create-generate.test.ts` allows exactly
  those forms of the word, and `.claude/future-tasks/neutral-app-port-service.md` carries the neutral service.
- **The identity is renamed, and only the identity**: `APP_SLUG` and `<slug>_session` in `config/app.ts`,
  `welcome.appName` and `welcome.title` in both catalogs, the root layout's title, the static demo's `<title>`, and
  the app and infra package names. Each rename must find its text exactly once, so a template that moves its
  identity fails generation rather than shipping half-renamed. The starter's prose was rewritten at the source
  instead (D4: the starter is the template): its comments that named the showcase, "the starter" or a
  `packages/kit/src/…` path now read true in both trees, and the static-shell spec's title lost "starter".
  Rejected: rewriting prose in the generator, which is brittle and leaves the template false for an adopter reading
  it.
- **`--sssb <dir>` writes absolute `file:` paths and a pnpm `overrides` block** in `pnpm-workspace.yaml` mapping
  every `@sssb/*` package to its tarball, with a comment to remove it on moving to published versions. Without it
  pnpm asks the registry for `@sssb/tools`, which `@sssb/cdk` depends on at an exact version (P9's addendum). This
  refines ADR-0014 part 7's "No overrides are used": that holds for published versions, where none is written, and
  not for tarballs. `--sssb <version>` writes the version as given; the default is `^<the generator's version>`.
  The `file:` paths in the overrides are quoted as Prettier's YAML printer would (`yamlString` in
  `packages/create/src/yaml.js`: single quotes with `''`, except a value with `'` and no `"` or `\`, which is
  double-quoted, so `prettier --check` stays green), and so is a scoped `allowBuilds` key; a control character is
  refused, and values already held to plain-safe characters (slug, repository, SHAs, versions) stay plain.
- **`--sssb` must be the generator's own version.** A tarball directory refuses tarballs of mixed versions, naming
  each version's packages (the fixed group never publishes a mix), and a directory or version flag whose version
  (`^`/`~` stripped) is not the template's `meta.version` is refused, naming `@sssb/create@<that version>` to run
  instead. The workspace's `.claude/sssb-guide.md` is stamped with the hash of the guide packed into the generator,
  and `sssb doctor` fails the first verify when the installed kit's guide differs. Rejected: copying the guide out of
  the `--sssb` tarballs (a tarball reader in a package with no dependencies, and nothing for the version form). A
  `^<version>` can still resolve a later patch whose guide differs; keeping a guide change out of a patch is the
  release process's, not checked here.
- **The root's `sssb:doctor` is `sssb doctor --app apps/<slug>`.** An adopter's root installs no `@sssb/kit`, and
  doctor will not start from a directory that does not resolve it; one run still checks every app. Rejected: a
  bare `sssb doctor` at the root, which works in this repository only because its root resolves the framework.
- **No Changesets for adopters.** An app workspace publishes nothing, and `.changeset/` and
  `scripts/release-notes.mjs` are SSSB's release machinery for SSSB's packages. No `.changeset/` and no
  `@changesets/cli` are written; an adopter who wants a changelog adds Changesets themselves.
- **`docs/cutover-checklist.md` and `apps/<slug>/DEMO-SIZE.md` are generated.** The checklist is a task list, one
  ``- [ ] `<id>`: <what>`` per framework row less `scope: sssb`: the starter's `config/params.ts` cites rows by id,
  and `sssb doctor` reports a workspace that stops mentioning one. A list rather than SSSB's table, so the output is
  Prettier-clean without re-implementing table alignment. `DEMO-SIZE.md` is written fresh, with the budget at
  generation and an empty "Changes", because the starter's copy carries SSSB's history and links into
  `jpslav/keel`; the starter's own copy is untouched.
- **The workspace carries `.claude/sssb-guide.md`**, since P7's `sssb doctor` fails a workspace without it: the
  template packs `@sssb/kit`'s `src/guide.md` as `template/guide.md`, and the generator writes the stamped copy byte
  for byte as `sssb guide` writes it (the test compares against `sssb guide --out`). The stamp's format is duplicated
  from `@sssb/tools`' `guide` command (rule 4), held by that test. The README says to import it from the adopter's
  `CLAUDE.md` with `@.claude/sssb-guide.md`, and that `pnpm exec sssb guide` refreshes it after an upgrade.
- **Not written: `LICENSE`, `CLAUDE.md`, `.github/dependabot.yml`; no `license` field; and no `git init`.** The
  README says to add a licence. The app's and infra's `package.json` lose the starter's `license`: they are private
  (never published, so npm does not ask), and `UNLICENSED`, the alternative, would claim a proprietary choice the
  adopter has not made. The commands arrive with P13's plugin. The generator runs no `git init`, no install, no
  Prettier and no network; the README and the closing output put `git init` first, before `pnpm install`, so
  husky's `prepare` finds a repository.
- **The owner files come from flags.** `--repo owner/name` (validated) fills the advisory links in `SECURITY.md`,
  `CODE_OF_CONDUCT.md` and the issue-template config; without it they name
  `PLACEHOLDER_GITHUB_OWNER/PLACEHOLDER_GITHUB_REPO`, init-app's convention. `--owner` (repeatable, `@` optional,
  `@user` or `@org/team`) fills `CODEOWNERS`; without it, a placeholder under a comment warning that "require review
  from Code Owners" makes every PR unmergeable on an owner GitHub does not know. The closing output names whichever
  is still a placeholder. `SECURITY.md` is the adopter's own short policy, pointing at SSSB only as "the repository
  its packages name in their `package.json`", so no `safeinsights/sssb` survives but the `uses:` line.
- **The slug rules are `@sssb/cdk`'s database name's.** `--slug`, else `<dir>`'s basename lowercased, refused
  unless it matches `^[a-z][a-z0-9-]*$`, its database name (dashes to underscores) has at most 63 characters, and
  that name is not a word Aurora PostgreSQL reserves. The reserved list is a copy of
  `packages/cdk/src/database-name.js`'s (rule 4: no SSSB dependency), held equal by
  `tests/tooling/create-args.test.ts`. init-app's other refusals (`kit`, `cdk`, `repo`, `sssb-*`) guarded collisions
  inside SSSB's repository and do not apply to a fresh workspace.
- **A slug that names a dependency is refused**, in `generate` (so by the CLI and the API): one where `<slug>`,
  `<slug>-infra` or `<slug>-workspace` is the unscoped name of a package in pack and consume's lockfile seed
  (`scripts/pack-and-consume/consumer-lock.yaml`), stamped into `meta.json` as `dependencyNames`. pnpm mistook an app
  named `ws` for the `ws` package and handed it that package's optional peers. The seed is the generated shape's own
  resolution (a slight superset: it also holds the pages shape's second app and sibling package), so `ws`, `react`,
  `next` and `kysely` are refused and this repository's own tooling (`events`, `history`, `open`, `cookies`) is not.
  Rejected: SSSB's `pnpm-lock.yaml` (it refused names no generated workspace installs); walking the generated
  importers' tree in the seed (precise, but more code for the handful of names the pages shape adds); a scoped app
  package (`@<slug>/app`: it changes every `--filter <slug>`, the CLI's identity surface and pack and consume's pins,
  and only narrows the collision to a scope).
- **The display name is held to what every file it lands in carries as itself** (`displayName` in
  `packages/create/src/args.js`, applied by the CLI and by `generate`). It lands in TypeScript and JSON strings, an
  HTML `<title>`, markdown and the app's catalogs, which next-intl parses as ICU messages. Control characters,
  U+2028/9 and bidirectional overrides are refused; it is trimmed and each whitespace run made one space; it may hold
  letters, marks, digits, emoji (with their joiners), spaces and `. , ' ’ " & ( ) ! ? : / + % ; = ~ _ # -`, starting
  with a letter or digit (a leading `-`, `1.` or `#` would make a markdown line a list or heading); `_` only inside a
  word, at most one `~` (a pair is strikethrough), no `#` as a word of its own at the end (a heading's closing
  sequence), no `''` (ICU reads one apostrophe), and no `&` that markdown reads as a character reference: `&#`
  anywhere, or `&` with letters or digits and a `;` (`R&D`, `Q & A` and `Harbor & O'Neill` stay allowed; `&amp;`,
  `&copy;`, `R&D;Lab` are refused). At most 60 columns, a wide character counting two, and the static demo's
  `<title>` line must fit 120. `SECURITY.md`'s sentence was written so the name never starts a markdown line.
  Rejected: escaping (it would have to be right for markdown, HTML, ICU and TS/JSON at once, and Prettier-stable in
  each: Prettier rewrites `*x*` to `_x_` and drops needless markdown escapes); collapsing control characters (a
  newline in a name is a mistake to report); a list of HTML5 entity names (2000+, for names that are only
  entity-shaped). Pack and consume generates its second shape with `Harbor & O'Neill C# Console; 50% = data_lab ~ v1`,
  so every allowed special goes through install, typecheck, lint and the unit run.
- **JSON is written Prettier-shaped without Prettier** (`packages/create/src/json.js`): `package.json` in
  `JSON.stringify`'s layout (Prettier's `json-stringify` parser), other `.json` with short arrays of plain values on
  one line within 120 columns. A test runs the repository's Prettier `--check` over a whole generated workspace.
  `allowBuilds` is read from this repository's `pnpm-workspace.yaml` as data (name to boolean) and written with the
  generator's own comment, so SSSB's comments about its own platforms stay in SSSB's file.
- **Generation writes into the target in place, all or nothing, and never removes or replaces an existing target.**
  The target is created if absent (remembered); the workspace is written into `<target>/.sssb-create-<hex>/`, and at
  the end its entries are renamed up into the target, after checking nothing else arrived meanwhile and never over
  an existing entry. A failure removes the stage, the entries already moved up, and each directory this run created,
  walking up from the target only while they are empty. A target that is a symlink is refused; one holding only
  `.git`, `.DS_Store` or `lost+found` counts as empty (`LEFT_ALONE` in `generate.js`), so `gh repo clone` of a new
  repository then `pnpm create @sssb .` works and a Finder `.DS_Store` written mid-run neither refuses nor rolls back;
  those are never removed. Filesystem errors become `CreateError`s ("could not write the workspace: …", "could not
  build the template: …"); a bug still shows its stack. Rejected: a sibling stage renamed over the target (it removes
  the user's directory: `pnpm create @sssb .` loses the shell's cwd, a parent that is not writable fails, the
  target's mode, owner and ACLs reset, a mount point is `EBUSY`); writing straight into the target (a failure leaves
  half a workspace mixed with whatever the user adds); ignoring every dotfile (`.gitignore`, `.github` and `.env`
  are content the workspace would clash with); only `.git` (macOS volumes hit `.DS_Store` routinely).
- **SIGINT, SIGTERM and SIGHUP are held while the generator works** (`packages/create/src/signals.js`). The work is
  synchronous, so a signal's default action would end the process part-way and leave it behind: while a generation
  (or, on the checkout path, the template build into its temporary directory, held from before `mkdtempSync`) is
  under way, one module-level listener defers the signal; when it is dispatched it undoes everything still held, even
  work that finished, each undo best-effort, and raises the signal again so the process ends as signalled. Release,
  and the CLI's "Created" and failure paths, wait two event-loop turns (`signalsSettled`): libuv reads a pending
  signal only in the poll phase, and when `generate` runs inside a poll callback (`main()` resumes from the prompt's
  stdin read), the first turn's check phase comes before any poll phase. With one turn the run printed "Created" and
  exited 0 with the SIGINT dropped; the test (a child generating from `fs.readFile`'s callback) reds that way. A
  signal that arrives after the work returned is not promised either way. Rejected: keeping a finished workspace when
  the interrupt arrives during the write (the person asked to stop); a listener per call (Node's MaxListeners
  warning); a flag set by the handler (it has not run yet: that is the bug); `process.nextTick` or microtasks (never
  reach the poll phase); `setTimeout(0)` (it can fire in the next turn's timers phase, still before its poll phase);
  a `process.on('exit')` cleanup (it does not run on a default-action kill); an async template build (a rewrite for
  a sub-second window).
- **The generated `pnpm verify` runs what CI runs, but the secret scan**: `concurrently --kill-others-on-fail --group`
  over `typecheck`, `lint`, `test:coverage`, `knip`, `jscpd`, `check:fences`, `sssb:doctor`, `check:e2e` and `synth`,
  then `test:contract` alone (embedded Postgres starting on a loaded machine is the step that timed out), `test:e2e` and
  the static demo's three. `check:fences` is a root script of the workspace's own,
  `pnpm --filter './apps/*' --fail-if-no-match exec sssb check-fences`, per app as `sssb ci` runs it, and every
  generated `--filter './apps/*'` script carries `--fail-if-no-match`, so a selector that matches nothing fails.
  `tests/tooling/create-generate.test.ts` reads `sssb ci`'s source for the scripts its jobs run and the workflow for the
  workspace's own job, and fails a verify that misses one. Rejected: verify as the `sssb ci <job>` commands themselves
  (serial, and `sssb ci matrix`/`e2e` are CI's orchestration); a root `check:fences` naming the one app (it misses an
  app added later).
- **`infra/` is typechecked by a program of its own, run by the app's `typecheck`.** In the starter (so in both
  trees): `apps/starter/infra/tsconfig.json` extends the app's, with `include: ["**/*.ts"]`, `types: ["node"]`
  (TypeScript 6 includes no `@types` by default) and `incremental: false`, and the app's `typecheck` is
  `next typegen && tsc --noEmit && tsc --noEmit -p infra`. SSSB's `pnpm typecheck` and the generated one both reach it
  through `pnpm --filter './apps/*' typecheck`, with no root change in either. Rejected: `infra/**` in the app's
  tsconfig (`next build` would typecheck the CDK's declarations on every build and e2e run); a `typecheck` script in
  infra's `package.json` (`./apps/*` does not match `apps/*/infra`, so both roots would change).
- **Small CLI choices.** A bare `--` is ignored (`npm create @sssb dir -- --slug x` hands it through); the closing
  `cd` line is shell-quoted; `--workflow-ref` reaches the checkout path's template build (no `git rev-parse` then);
  the checkout path's temporary template is removed however the run ends.
- **The root's devDependencies are a list in the generator** (`ROOT_DEV_DEPENDENCIES`) at this repository's
  ranges, captured when the template is built: pack and consume's `root-devdeps-picked` workaround, moved. `vite`
  and `@vitejs/plugin-react` are not among them: the app has them. The app gains `@sssb/eslint-plugin` and `eslint`.
- **The generated `knip.json` has three narrow entries**: at the root, `vitest.contract.config.ts` as an entry
  (knip's Vitest plugin reads `vitest.config.ts` only) and `esbuild` ignored (`SssbApp` bundles with the root's
  esbuild); in the app, `@sssb/app-config` ignored (the link only the framework resolves) beside the two
  preset-loaded tools this repository's knip already ignores. Their reasons are comments in
  `packages/create/src/files.js`; the JSON carries none. It leaves `includeEntryExports` off, as
  `docs/adopting.md` argues. This repository's `knip.json` gained no entry for `packages/create`.

The `TODO(P12)` markers the previous section left in `docs/adopting.md` are resolved against the built CLI.

## Pack and consume's two shapes and the `adoption-probe` job (2026-11-18, ADR-0014 P12, `feat/sssb-create`)

Pack and consume (`scripts/pack-and-consume.mjs`) now proves the generator as well as the packages, and the
`adoption-probe` check is its second shape. What it does, and what was rejected:

- **It packs all five `@sssb` packages flat into one `tarballs/` directory**, the directory the generator's `--sssb`
  takes, checks the packed `@sssb/create` (`createPackageProblems`: no dependency at all, the bin shipped, the
  template packed whole with none of a checkout's local state in it, JavaScript only under `bin/` and `src/`) and that
  its `postpack` left no `packages/create/template` behind, and extracts it. Both shapes run THAT generator under
  plain Node. On a push, `checks.yml` keeps the directory's tarballs as the run's `sssb-tarballs` artifact, so a
  release candidate attaches `@sssb/create` with the rest (it is in the fixed group). `candidateNotes`
  (`scripts/release.mjs`) leaves the generator out of the overrides and dependencies it tells an adopter to write and
  says how to run it instead: a generator is run, never depended on.
- **Two shapes, two jobs.** `--shape pages` (CI's `pack-and-consume`) generates the workspace (`--slug console`),
  generates a second app (`--slug ledger`) elsewhere and moves it in, extending the root's three app lists as an
  adopter adding an app would, and adds the shape's own code (an adapter, a sibling package, the seamless negative
  fixture, the strict-flag tsconfig) for the script's checks. `--shape generated` (CI's `adoption-probe`) changes not
  one file: every file the generator wrote is hashed and must be byte-identical at the end (a tool that rewrites one
  means the generator must write it that way). No flag runs both. Rejected: one job running both (each is its own
  required check, and they run in parallel).
- **The generated shape runs the workspace's own gates**: `pnpm verify` (`verifyGateProblems` first: verify must reach a
  script for every gate `sssb / all-checks` holds, plus knip and jscpd, and no reached script may hold a form that
  passes with a step failed or not run: `||`, a lone `|`, a newline, `;` outside quotes no other shell reads, a lone
  `&`, `--if-present`, concurrently's `--success` other than `all`, `echo`, a `#` comment, or a `--filter` without
  `--fail-if-no-match`); the unit tests through every script that runs them on the way to a green (`heldUnitScripts`:
  the one verify reaches and the one `sssb ci lint-typecheck-unit` runs, `CI_UNIT_SCRIPTS`, which a test holds to
  `ci.js`), each held to every conformance test the packed registry names; `pnpm test:contract`, held likewise;
  `sssb ci lint-typecheck-unit`; and synth, knip and jscpd as steps of their own, as CI runs them
  (`sssb ci synth --filter <the selector the generated workflow passes>`, `pnpm knip`, `pnpm jscpd`). Rejected: holding
  only `test:unit` (nothing in verify or CI runs it any more, so a `test:coverage` that excluded the conformance file
  passed); a shell parser for the gate check (heavy for input the generator writes; plain matches refuse a rare
  `grep -E 'a|b'`, and a non-pnpm `--filter` is refused without the flag only pnpm takes); catching every no-op
  (`synth: 'true'` still passes composition, which is why synth runs on its own: CI never runs the root `synth`).
- **One lockfile seed for both shapes, with two tokens.** `consumer-lock.yaml` is the pages shape's resolution; the
  generated shape's importers (`.`, `apps/console`, `apps/console/infra`) are a subset, and pnpm keeps the seed's
  resolution when it drops the rest. The generator writes ABSOLUTE `file:` paths, which pnpm copies verbatim into the
  lockfile's specifiers and `overrides`, so the seed holds `__PACK_AND_CONSUME_TARBALLS__` for the run's tarball
  directory and `__PACK_AND_CONSUME_VERSION__` for the group's version (a candidate's tarballs are
  `sssb-kit-x.y.z-rc.N.tgz`), swapped in on the way in and back by `--update-lockfile`, which fails if any other path
  of the run's directory is left. Shape 2's "resolution moved" notice counts package versions the seed does not hold
  (`packagesBeyondSeed`), not lines: dropping importers moves `optional: true` flags. `lockfileProblems` reads the
  `overrides:` section (each `@sssb/*` to a `file:` tarball, the seam never). Rejected: a second seed for shape 2
  (another ~8k lines to refresh, for the same resolution).
- **The workaround register is empty.** P12's six (the stripped in-repo tsconfig, the seam package, the root's
  tools, `allowBuilds`, the ESLint configs, `dedupePeerDependents`) left with the generator, which writes each. The
  machinery stays for the next gap.
- **The `adoption-probe` job** runs `node scripts/pack-and-consume.mjs --shape generated`, with the same install as
  `pack-and-consume` (the kit's dependencies for its `prepack`, the cdk's `workspace:` link; `@sssb/create`'s
  `prepack` needs Node and git only) and caches keyed on the same seed under prefixes of its own (the two stores hold
  different sets). Its name is the one the rulesets already required.
- **Left for later**: a way to add a second app to a generated workspace (`@sssb/create --add-app` or
  `sssb add-app`); the pages shape does it by hand today, as an adopter with two apps would, and it is not a workaround
  because no ADR-0014 step promises it. ADR-0014 part 7's "a sibling package that imports keel and links the seam"
  is still not in the pages shape (it had none before P12 either).

## The Claude Code plugin, and CLAUDE.md cut to the maintainer half (2026-11-18, ADR-0014 P13, `feat/claude-plugin`)

P13 moves the commands an app author runs out of `.claude/commands/` into a Claude Code plugin that an adopter's
workspace enables at a pinned commit, makes `@sssb/kit` name the commit it was packed from so `sssb doctor` can hold
the pins to it, and cuts this repository's `CLAUDE.md` to what holds only here. ADR-0014's addendum of the same date
says where this differs from part 9. Each decision, and what was rejected:

- **Marketplace `sssb` at the repository root (`.claude-plugin/marketplace.json`), listing one plugin, `sssb`, at
  `plugins/sssb/`** (relative source `./plugins/sssb`). The enable key is `sssb@sssb`, the commands are
  `/sssb:<name>` and the agent `sssb:doc-steward`. The generator reads both names from the two manifests
  (`pluginNames`, `packages/create/src/template.js`) and refuses a marketplace that does not list the plugin, so a
  rename cannot drift from the settings it writes. Rejected: the plugin at the repository root (`source: "./"`), which
  makes the whole repository the plugin directory and mixes the maintainer's files into what adopters load.
- **No `version` in `plugin.json` or the marketplace entry.** Claude Code takes a plugin's version from the manifest's
  `version`, then the entry's, and only without either from the source (for a relative path in a git-hosted
  marketplace, the commit SHA); a pinned string keeps every user on the cached copy until its author changes it
  (Claude Code's plugin docs, "Plugin loading reference", "How Claude Code computes the version"). Left out, raising
  the pin moves the plugin. The cost: `claude plugin validate --strict` exits 1 on exactly one warning,
  `version: No version specified`. The gate filters that one line and fails any other warning or error
  (`tests/tooling/plugin.test.ts`, "claude plugin validate --strict"; an unknown key in `plugin.json` turns both of
  its rows red). Rejected: the fixed group's semver in `plugin.json`: nothing in the release flow stamps it, and a
  stale string would silently freeze adopters' plugins across a pin bump.
- **Which commands move.** Into the plugin: `new-entity`, `new-job`, `new-actor`, `new-notification-kind`,
  `new-webhook-event`, `new-tour`, `new-preset`, `new-preset-operation`, `new-slice`, `new-port` (an APP-owned port
  only), `verify`, `pre-pr`, `a11y-review`, `design-review`, and the `doc-steward` agent: each acts on an app and works
  in a generated workspace. Kept in `.claude/commands/` as the maintainer's: `branch-review` and `sub-review`
  (generic, not SSSB's to ship), `repo-health` (triages `@sssb/kit/core` and the kit's fakes), `record-fixtures` (the
  showcase's `llm:record`; a generated app has no LLM fixtures), and **`new-kit-port`**, the framework-port half of
  the old `/new-port`, renamed so `/new-kit-port` and `/sssb:new-port` are never confused; each sends the other kind
  of port to the other. Rejected: shipping `record-fixtures` (no such script in a generated app); keeping a project
  copy of any moved command (two copies drift).
- **How a command addresses the app and cites SSSB.** "The app" is the root `package.json`'s `sssb.apps` (with
  several, the one the request names, or ask), and every path is relative to it, else to the workspace root. SSSB's
  reference app is cited only as a code span `https://github.com/safeinsights/sssb/(blob|tree)/<ref>/apps/showcase/…`,
  where each command defines `<ref>` as the commit the project's Claude Code settings pin the `sssb` marketplace to (in
  SSSB's own repository, the local showcase). The plugin and the cited file are then read at one commit, and the gate
  fails a URL at a branch or a path not in the tree. A generated app's own Items slice is the worked example where it
  has one. Rejected: `apps/<app>/…` everywhere (wrong for a Pages-shaped workspace, ADR-0014 part 9); a bare `src/…`
  with no rule; `main` URLs (they drift from the pinned plugin); copying the examples into the plugin (a third copy of
  the showcase).
- **The commands are written for the app a generated workspace has**, which lacks the showcase's server Simulator: its
  only Simulator panel is the static demo's (`DemoShell` with `extraTabs={[]}`), and it has no `/api/simulator/*`
  routes, no `/api/jobs`, no header bell and no `src/domain`. So `/sssb:new-actor` adds the actor to the static demo
  and keeps the server host as a section for an app that has one (porting the server Simulator is its own work), and
  the job, webhook, notification, tour and accessibility commands say what the generated app lacks and where the
  capability does exist (the static demo's Jobs, Hooks and Snapshots tabs, its bell and profile preferences). An actor
  registration copies the reference's `as const` shape (the kit exports no actor-definition type), and a tick is
  picked by id exhaustively. A spec reads the kit's catalog as a file through `require.resolve` of an exported
  subpath, never an import (`sssb check-e2e` fails any kit import but `@sssb/kit/testing/e2e`). Rejected: inlining the
  server port into "add an actor" (the showcase's `simulator-glue.tsx` is 867 lines, beside 33 `/api/simulator` and 2 `/api/service` routes); dropping the server guidance.
- **Adding a package: by hand, never `pnpm add`.** In an installed generated workspace, `pnpm --filter <app> add
<pkg>` re-resolves `@sssb/kit` without its optional `@sssb/app-config` peer (`sssb doctor` fails "has no seam
  linked"; typecheck fails inside the kit). The three commands that add one (`new-preset-operation`, `new-port`,
  `a11y-review`) carry one shared "Adding a package" section, which the gate holds identical: edit the app's
  `package.json`, `pnpm install`, `pnpm sssb:doctor`; after a `pnpm add` already ran, keep the manifest, restore the
  lockfile with `git checkout HEAD -- pnpm-lock.yaml`, install, run doctor. The root cause is open as
  `.claude/future-tasks/pnpm-add-drops-seam-link.md`. Rejected: `git restore pnpm-lock.yaml` (it restores from the
  index, which may hold the broken lockfile after a `git add`); the clean reinstall (it re-resolves the whole tree); a
  sentence per command pointing at one of them (a second hop).
- **Playwright's browser install is filtered to the apps**: `pnpm --filter './apps/*' exec playwright install
chromium` (or `--filter <app>`) in the commands, the generator's "Next:" lines and README, and `docs/adopting.md`. A
  generated workspace declares `@playwright/test` in the app, not the root; the root form worked in one workspace only
  because pnpm hoisted the bin. This repository's root declares it, so this repository's own `README.md` and
  `CLAUDE.md` keep the root form. Rejected: the root form for adopters (hoisting is not a contract); `pnpm dlx
playwright` (a version unpinned against `@playwright/test`).
- **The plugin's gate, `tests/tooling/plugin.test.ts`** (its header lists the conventions): (a) the manifests' shape,
  which never skips (CI has no `claude`); (b) every reference a command or agent makes resolves in a workspace
  generated from the live tree: paths, `pnpm` scripts (here as well), `pnpm exec` binaries that a dependency of the
  package it runs in declares, `sssb` commands, `@sssb/kit` subpaths and the identifiers and props the prose ties to
  them, rule ids, `/sssb:` commands, SSSB URLs, fenced shell lines and TypeScript imports, and `npx`, `npm`, `yarn`,
  `pnpm dlx` of SSSB's packages and an un-negated `pnpm add` fail; (c) `claude plugin validate --strict` where the
  binary is on PATH. A canary of planted rows must each yield exactly its own problem. Rejected: installing `claude`
  in CI for (c) (a network install of a moving binary into every run, for checks (a) mostly mirrors); a type-checker
  `Program` for the identifier and props checks (slow); a block-level "a capability word needs a host word" rule (it
  flagged true sentences).
- **This repository dogfoods the plugin.** `.claude/settings.json` commits only `enabledPlugins: {"sssb@sssb": true}`,
  so nothing loads until a maintainer either installs it (`claude plugin marketplace add ./ --scope local`, which
  writes a `directory` source with the checkout's absolute path to the gitignored `.claude/settings.local.json`, then
  `claude plugin install sssb@sssb --scope local`, once per checkout) or starts the session with
  `claude --plugin-dir plugins/sssb`. Checked with Claude Code 2.1.280 in a scratch `CLAUDE_CONFIG_DIR`: the install is
  a copy in the plugin cache under the commit's SHA (`installed_plugins.json`'s `installPath` and `gitCommitSha`),
  `claude plugin update` ignores an uncommitted edit and moves to a new commit, and `--plugin-dir` loads the tree as it
  is (`claude plugin list` shows both `sssb@sssb` and `sssb@inline`). Claude Code's plugin docs say a `--plugin-dir`
  plugin replaces an installed one of the same name ("Name conflicts"), and describe a local marketplace's
  relative-path plugin as loaded in place, which 2.1.280 did not do, so `CLAUDE.md` names the version it describes.
  Rejected: a committed `directory` source with a relative path (undocumented; the CLI resolves `./` to an absolute
  path before writing it); a `github` source (maintainers would run `main`'s plugin, not their tree's).
- **The release stamp, `dist/release.json`** (`{ "commit": "<40 hex>" }`), written by the kit's `prepack` after
  `build-testing-e2e.mjs`, which empties `dist/` first (a test pins the order). It ships under `dist`, which `files`
  already names. It refuses shipped sources (`src/`, `package.json`) that differ from `HEAD`, staged, unstaged or
  untracked, read from `git status --porcelain=v1 -z` by position, never by status letter (a `T` once slipped
  through), under `@sssb/create`'s switch `SSSB_CREATE_UNPUSHED_PIN=1`; it fails outside a git checkout. It does not
  repeat the generator's unpushed-`HEAD` refusal: the generator's pin, which GitHub must resolve, is the same commit
  and is refused there. `release.mjs candidate` refuses a kit whose stamp is not the candidate's commit. Rejected: a
  field in the packed `package.json` (pnpm reads the manifest before `prepack` runs); an `exports` entry (doctor reads
  the file by path, and the public surface would widen for a file no app imports); the repository in the stamp (the
  kit's `package.json` `repository` names it); mirroring the unpushed check in the kit (a second copy, or an import
  from a kit script into `packages/create`); a `"modified": true` flag doctor would then have to explain.
- **`sssb doctor`'s pin report** (`pinReport`, `packages/tools/src/commands/doctor-checks.js`) replaces "workflow and
  plugin pins: not checked". SSSB's repository is the installed kit's `package.json` `repository`; its pins are every
  `uses: <owner>/<name>/.github/workflows/<file>@<ref>` in the root's workflows and every `extraKnownMarketplaces`
  entry of `.claude/settings.json` from that repository (`github` `repo`, or `git` `url`). It is `ok` only when the kit
  has a stamp, the workspace has a workflow pin and a marketplace pin, every one is the stamp's commit, and
  `enabledPlugins` enables some plugin from that marketplace (`true`, or a non-empty array: Claude Code 2.1.280's
  settings schema describes an "extended format with version constraints"). Otherwise it reports, naming both commits,
  a branch or missing `ref`, what is enabled instead, or why it cannot judge; it never fails (ADR-0014 part 5). In-repo
  it is "not checked", decided by doctor's in-repo flag, not by the file's absence (a `dist/` a local pack left behind
  is not read). Rejected: hardcoding `safeinsights/sssb` (a fork publishing under its own repository would be
  misjudged); hardcoding the plugin's name (the kit would have to know it, and a rename would break the check
  quietly); reading `settings.local.json` (a machine's, not the repository's pin).
- **Doctor's in-repo guide check**: with no `.claude/sssb-guide.md`, `ok` when the root `CLAUDE.md` imports the kit's
  guide from its source (`@packages/kit/src/guide.md` as a whitespace-separated token; a backticked mention is no
  import), a report otherwise. Rejected: "holds no copy yet" (this repository never will: the import is the
  mechanism); failing in-repo (doctor's failures are for adopters' installs).
- **`@sssb/create` writes `.claude/settings.json` and `CLAUDE.md`.** The settings declare the marketplace as a
  `github` source of the template's workflow repository at the workflow's pin (`--workflow-ref` moves both) and enable
  `<plugin>@<marketplace>`. A commit `ref` needs Claude Code 2.1.324 or later (Claude Code's marketplace reference,
  "Fields by type", `ref`), which the generated README, `docs/adopting.md` and the changeset say, beside
  `claude plugin install sssb@sssb --scope project` once per clone after trusting the folder (a project's
  `enabledPlugins` installs nothing). `CLAUDE.md` is a heading, a sentence, the line `@.claude/sssb-guide.md` and a
  heading for the adopter's own rules, written once. This reverses P12's "not written: `CLAUDE.md`": without it the
  guide steers no agent until the adopter writes the file, and the plugin's commands assume the guide is loaded. The
  plugin's files are template sources for the uncommitted check (`TEMPLATE_SOURCES`), so a pack refuses a plugin that
  differs from the `HEAD` the settings pin. Rejected: leaving `CLAUDE.md` to the README (most adopters would not
  write it); the app's display name in it (one more Prettier-sensitive place for a name).
- **Pack and consume's generated shape gains a pin step** (`pinsGenerated` in `scripts/pack-and-consume.mjs`,
  `generatedPinProblems` in `scripts/pack-and-consume/checks.mjs`): the workflow calls the reusable workflow once at a
  full SHA, the settings declare exactly one marketplace of that repository at that SHA and enable its plugin, the
  packed kit's stamp names it, the generated workspace's `sssb doctor` prints the `ok` pin line, and `git cat-file -e`
  finds the marketplace and plugin manifests at that commit in this checkout. The kit is packed under the generator's
  switch. So the plugin must be committed before a local run, as the starter must. Rejected: checking the plugin only
  in the pages shape (the generated shape is the one whose settings are untouched); reading doctor's line from
  verify's interleaved output.
- **`CLAUDE.md` cut to the maintainer half.** It opens with `@packages/kit/src/guide.md` (the source, not a copy, so
  nothing can make it stale), then says nothing the guide says is repeated and an app-facing rule goes into the guide
  (it ships, so it takes a changeset). The app half left (the seam, vendor SDKs and `process.env` in an app, `getDb`,
  keyset and migration rules, `authorize`, i18n, router-agnostic screens, hermetic dev, the conformance and e2e
  rules, knip's narrow entry); the maintainer half of each stayed. **The guide gained the cutover rule and a "dev
  loop" section** (`.changeset/app-guide-dev-loop.md`, a `minor`, Kind seam, since doctor fails a stale copy):
  ticking scheduled work, the cron route behind `withWebhookSecret`, per-worktree ports via `pnpm exec sssb port`,
  and verify, `lint:fix` and conventional commits. Rejected moving: the gate-must-fail and git habits (general
  engineering), the product name in tests (the generator's concern), ladle (the starter has none); naming the
  `starter` port band in the guide (the generator's no-survivor test bans it).
- **This repository's root `package.json` gains `sssb.apps: ["apps/showcase", "apps/starter"]`**, the set doctor
  already walked, so the commands' "the app" rule is literal here, and `plugins/` in `sssb.docPaths.roots`, so a doc
  citing a command file is checked. Not added to `include`: the commands' paths are app-relative, and the plugin's
  gate checks them more strictly.
- **The changeset gate covers `plugins/` and `.claude-plugin/`** (`.github/scripts/require-changeset.sh`,
  `tests/tooling/changesets.test.ts`, `.changeset/README.md`): adopters load the plugin from this repository at the
  pin they raise at a release, so a plugin change reaches them as a shipped file does. Its changeset names
  `@sssb/create`, the package that writes the pin. Rejected: leaving it ungated (the plugin is no npm package, but it
  is adopter-visible).
- **Command names say `/sssb:`** wherever they mean the plugin's: the starter's comments (a generated workspace holds
  no bare `/<command>`, which `tests/tooling/create-generate.test.ts` checks against the plugin's command list), the
  kit's shipped comments, the docs, `README.md` and `CONTRIBUTING.md`; a framework port is `/new-kit-port`.

## The seam is a workspace package (2026-11-18, `fix/pnpm-add-seam-link`)

P13 found that `pnpm add` in a generated workspace unlinks the app's seam from its `@sssb/kit`, and worked around it in
the plugin's commands (its task, cited in P13's entry above, is now
`.claude/future-tasks/resolved/pnpm-add-drops-seam-link.md`). This fixes it in what `@sssb/create` writes (ADR-0014's addendum of the same date has the
cause, in pnpm's source). Each decision, and what was rejected:

- **Each app's `src/app-config` is a workspace package named `<slug>-app-config`, declared
  `"@sssb/app-config": "workspace:<slug>-app-config@*"`**, with `apps/*/src/app-config` in `pnpm-workspace.yaml`'s
  packages (`packages/create/src/generate.js`, `packages/create/src/files.js`). Tried first in generated workspaces
  under the pinned pnpm 11.14.0, counting the kit's peer suffix in the lockfile and running `sssb doctor` after each
  command: `add`, `remove`, `update` (with `--filter`, `-r` and `--latest`), `add -w`, `add` run in the app, and a
  fresh install all kept it, with one app and with two. Rejected, each tried the same way and each dropping the peer
  on the first `add`: a `.pnpmfile.cjs` `readPackage` hook re-declaring the peer on the kit;
  `resolvePeersFromWorkspaceRoot: false`; `dedupePeerDependents: true` (which also breaks part 5's instance per
  importer); `autoInstallPeers: false`; `dependenciesMeta.<seam>.injected`; pnpm 11.21.0 in `packageManager`.
  Rejected without trying: a `sssb add` wrapper (authors and agents reach for `pnpm add`, and Renovate or Dependabot
  never run a wrapper); one seam package named `@sssb/app-config` declared `workspace:*` (it works for one app, but
  two apps' seams would be two workspace packages of one name).
- **The name is `<slug>-app-config`, beside `<slug>` and `<slug>-infra`.** The slug check already refuses a slug that
  names a package the workspace installs; the seam's name is not checked against them, since nothing a workspace
  installs ends in `-app-config`. `workspace:` resolves only to a workspace package, so this unscoped name is never
  fetched from a registry; the name the kit's peer declares stays `@sssb/app-config`, in SSSB's scope.
- **`@sssb/kit`'s manifest does not change**, so P2's dead-registry check of the packed kit is not re-run: the seam
  stays an optional peer in `peerDependenciesMeta` alone. Its shipped source does: the conformance suite's `seam-map`
  check (`packages/kit/src/testing/conformance/seam-map.ts`) refused a seam package not named `@sssb/app-config`, which
  pack and consume's unit step found. It now reads the app's declaration and requires the name a
  `workspace:<name>@<range>` names, else `@sssb/app-config`. Rejected: dropping the name check (a seam package whose
  name matches nothing the app declares is a seam pnpm does not link).
- **`sssb doctor` fails a `link:` seam even while it is linked** (`importerSeamProblems`,
  `packages/tools/src/commands/doctor-checks.js`), with the four changes in the message. Rejected: reporting it
  without failing, which leaves an adopter green until their next `pnpm add`, then red with a message about the kit.
  It also fails an importer whose declared seam is another importer's (`workspace:` makes that one edit away).
- **The generator's check that no `package.json` depends on a missing workspace package** now reads each
  `workspace:` specifier's target (`workspace:<name>@<range>` names `<name>`; any other form, the dependency's own
  key) instead of refusing every `workspace:`, which would refuse the seam.
- **The generated `knip.json` gives the seam a workspace entry of its own** (`apps/<app>/src/app-config`, every `.ts`
  an entry), since knip now counts its files as that workspace's: the app's entry pattern for them matched nothing.
- **Pack and consume's generated shape adds `partialInstallsKeepSeam` after every other step**
  (`scripts/pack-and-consume.mjs`): `pnpm --filter <app> add ms@2.1.3`, `remove ms`, `update zod`, each followed by
  `sssb doctor` and `checkSeamLinks`. Last, because each rewrites files the generator wrote, which the step before
  holds unchanged. `ms` is in the seed already. Seen red with the `link:` seam: "after pnpm add, sssb doctor fails".
- **P13's workaround is reverted**: the plugin's **Adding a package** sections, the gate's rule failing an un-negated
  `pnpm add` (and the negation reading only it needed), and the section test. The commands say
  `pnpm --filter <app> add <pkg>`, as before P13.
- **Doctor fails a `workspace:` seam whose name is not exactly one workspace package's.** The review asked which pnpm
  command or setting still unlinks the seam without doctor noticing; it found one: a copy of an app's seam left under
  its name in a package that takes no kit (`apps/zzz/src/app-config` named `acme-app-config`). pnpm took both without
  a warning and linked the later one, into the app and its kit alike, so the seam check's two readings agreed and
  doctor said ok. Rejected: holding every seam to `<importer>/src/app-config` (it would also refuse a seam an adopter
  keeps elsewhere on purpose, which the names alone do not). Everything else the review reported running (the claim
  check re-ran `dedupe`, `install --force` and `nodeLinker: hoisted`, with the same result) kept the seam or made
  doctor fail: `pnpm up -r` with and without `--latest`, `--lockfile-only` and Renovate-style updates, `dedupe`,
  `rebuild`, `prune`, `patch`, `catalog:`, overrides, `install --force`, pnpm 11.21.0, `shamefullyHoist`,
  `publicHoistPattern`, the three workspace-protocol settings, renaming an app, and running pnpm inside the seam
  (kept); `nodeLinker: hoisted`, `injectWorkspacePackages`, `injected`, a filtered install, and a copied second app
  with the seam's name or dependency left unrenamed (failed). Not run: `nodeLinker: pnp` (doctor's Vitest listing hung
  there), `pnpm import`, Renovate and Dependabot themselves, and a kit from a registry.
- **Not covered: `nodeLinker: hoisted`.** One hoisted `@sssb/kit` cannot hold two apps' seams; with two apps doctor
  fails it ("runs on a seam not its own"), as it did before this change.

## `sssb doctor` needs nodeLinker isolated, and stops a vitest list that never ends (2026-11-18, `fix/doctor-nodelinker-pnp`)

The workspace-package seam's review (the entry above) found `pnpm sssb:doctor` hanging under `nodeLinker: pnp`.
Measured in a workspace `@sssb/create` generated, with `nodeLinker: pnp` (pnpm 11.14.0):

- **Run directly, doctor finished and said "sssb doctor: ok"**: a false pass on a layout nothing of SSSB's is built for.
- **Run as `pnpm sssb:doctor`, it hung.** `pnpm run` puts `--require=<root>/.pnp.cjs` in `NODE_OPTIONS`, and the
  `vitest list` child doctor spawns, inheriting it, never finished. The same listing without that option finished in
  under 3 s.
- **Under `nodeLinker: hoisted`, doctor failed only indirectly** ("runs on a seam not its own", from the seam check),
  never naming the cause.

Decisions, each with what was rejected:

- **Doctor requires `isolated`, pnpm's default, with no Plug'n'Play left, and checks it first, alone**
  (`nodeLinkerProblem`, `packages/tools/src/commands/doctor-checks.js`, called at the top of `run` in
  `packages/tools/src/commands/doctor.js`). It reads the layout pnpm actually installed, `nodeLinker` in the root's
  `node_modules/.modules.yaml` (JSON in pnpm 11; a damaged or YAML file is read for a `nodeLinker` key, and one that
  cannot be read fails), rather than the setting (`pnpm-workspace.yaml`, an environment variable or a flag could each ask
  for it; pnpm 11 ignores `node-linker` in `.npmrc`). Both `pnp` and `hoisted` fail. So does a `.pnp.cjs` left at the root (pnpm writes and loads no other PnP file), and
  doctor's own `NODE_OPTIONS` loading a `.pnp.cjs`: the review found that removing the setting and reinstalling leaves
  `.pnp.cjs` behind, `pnpm run` keeps loading it, and doctor then spent 6 minutes on three killed listings and printed
  two false FAILs (PnP resolving inside doctor itself). The message names the setting to remove and the file to delete.
  Nothing else is checked, since every other check reads the isolated layout. Rejected: supporting `pnp` (pnpm 11
  still builds the isolated `node_modules` there, but `.pnp.cjs` makes every script resolve through Plug'n'Play, which
  doctor's checks and Vitest's listing do not survive) or `hoisted` (one instance for every app, against ADR-0014 part
  5's own instance per app, linked to its own seam); failing only `pnp` (`hoisted` breaks the same model, and doctor's indirect failure there named the
  wrong cause); stripping PnP from the listing's environment (doctor's own resolution was wrong too).
- **Not added to the shared kit resolver** (`packages/tools/src/kit.js`). It resolved the kit under pnp (pnpm still
  links direct dependencies into `node_modules` there), so the other `sssb` commands are left to fail on their own;
  doctor, which every workspace's `pnpm verify` runs, is where the layout is named. Rejected: checking the layout on
  every resolution, a file read per command for a setting doctor already names.
- **A `vitest list` that runs past 120 s is killed, with every process it started** (`SSSB_DOCTOR_VITEST_TIMEOUT`
  seconds overrides it, rounded up to whole milliseconds; `vitestList` in `packages/tools/src/commands/doctor-vitest.js`),
  and reported as that listing's error ("did not finish within …"), which doctor already turns into a problem, so no
  other cause can hang it. A small launcher (`node -e`) runs Vitest in a process group of its own and kills the group (on Windows, Vitest's own process only):
  the review found that killing Vitest's own process left a pool worker of a hung test file running under init, and
  `SIGTERM` does no better. After one listing runs out of time, doctor returns "not listed, since an earlier listing ran out of time (…)" for every later listing
  instead of waiting again (`listOnce`, `doctor.js`), so one hang costs one limit, not one per config. 120 s is far
  above the few seconds a listing takes. Rejected: no limit (a `spawnSync` that never returns also blocks a test
  runner's own timeout, as the probe of this very test showed); writing the child's output to files instead of pipes
  (tried, for a grandchild holding a pipe: `spawnSync` returned at the limit either way, so it bought nothing).
- **Tests** (`tests/tooling/tools-doctor.test.ts`): `nodeLinkerProblem` on isolated, pnp, hoisted, nothing installed,
  a truncated or YAML record, an unreadable one, PnP files left at the root and a `NODE_OPTIONS` loading one; doctor end
  to end on a workspace marked pnp fails at once with only that problem; a fake `vitest` that never exits, with a
  "worker" that never exits either, is stopped at a 1 s limit with the worker dead, and at the environment's
  (`0.0015`, rounded); doctor end to end on configs that never load waits out one 3 s limit and reports the other
  listings as not listed. Seen red, one guard at a time: each of these fails without its guard; with no limit at all the test
  never returns, and ignoring the variable it fails only after the 120 s default limit.

## `sssb doctor` works from the root with no `--app`, rather than every instruction learning `--app` (2026-11-18, `fix/doctor-from-root`)

Found by the seam-link session: the files `@sssb/create` generates, its README among them, tell people to run
`pnpm exec sssb doctor`, which failed at a generated workspace's root ("does not resolve @sssb/kit"), because that root
takes no framework and doctor resolved the kit from the working directory. The root script `sssb:doctor` worked only
because the generator wrote `sssb doctor --app apps/<slug>` into it.

- **Chosen: the short form works.** With no `--app`, doctor starts from the working directory when it resolves
  `@sssb/kit` (an app, or this repository's root, as before). At a workspace root that does not, it starts from the
  workspace's first app (`sssb.apps`, else `apps/*`) and says so in its first line. Doctor already ran ONE time for the
  whole workspace once given any app, so the start does not change what it finds, with one addition: when doctor chose
  the start itself, its workspace walk must also reach every app the workspace names, because the walk only had to reach
  the one doctor runs for, and `--app <an app the walk drops>` fails where the bare form would have passed. An explicit `--app` is never replaced, and a root with no apps refuses, saying what to pass. People and
  agents type the short form, so the short form has to be the one that works.
- **Rejected: change every instruction to `--app apps/<name>`.** That is a longer command to remember, every doc, guide
  line and generated comment would carry an app name that is wrong for the next workspace, and the next person to write
  `pnpm exec sssb doctor` in a README repeats the bug.
- **The generated root script is now `sssb doctor`**, with the `--app` form still valid for workspaces generated
  before. `docs/adopting.md`, `CLAUDE.md` and the generator's comment said why `--app` was there and no longer do.
- **Pinned where it matters:** end-to-end tests run doctor as a child process from the root of a workspace laid out on
  disk (packed and in-repo), from an app, with an explicit `--app`, with `sssb.apps` reordering the first app, from a
  root with no apps and outside a workspace; and pack-and-consume runs the bare form from the real generated
  workspace's root before it reads doctor's pin report. A changeset (`@sssb/tools`, `@sssb/create`, scaffold, optional).

## `.changeset/pre/` and `pre.json` are Changesets' own state, and every tool that walks `.changeset/` says what it does with them (2026-11-18, `fix/changeset-pre-dir`)

The first release candidate (`v0.2.0-rc.0`, commit 28a04c1) was cut by the release flow, and CI failed on it in
`tests/tooling/changesets.test.ts` ("every changeset in this tree is well formed": `expected [ 'pre' ] to deeply equal
[]`). In pre mode `changeset version` moves each changeset it consumes to `.changeset/pre/`, byte for byte, and keeps
`.changeset/pre.json`; that test read `pre` as a stray subdirectory. The tag run's `candidate` job refused to publish
because `checks` had failed on the commit, which is what it is for, and nothing was published. Reproduced first on the
`.changeset/` directory of 28a04c1 (the whole directory, with the earlier pending files removed as a merge-back would
leave it): that test failed, and `release.mjs check`, `release-notes.mjs --check` and the `changeset-required` gate (run
over a merge of `main` into `integration`) all passed. `release.mjs` already knew about `pre/` (P7); only that test, and
nothing that ran the tools together over such a tree, did not.

What each tool does with the moved files, decided one by one (`.changeset/README.md`, "What reads `.changeset/pre/`"):

- **The shape lint over the tree** reads `.changeset/*.md` only, and does not lint `pre/`: they were linted when they
  were pending, and a rule tightened since must not turn a shipped candidate's record red. It does fail on anything in
  `pre/` that is not a changeset file and on any other subdirectory, so a stray is still caught. The enumeration is one
  helper, `tests/support/changeset-files.ts`, which the whole-flow test uses too. Rejected: lint `pre/` as well (it
  would pin every old rule forever), and skip every subdirectory (a stray directory would pass).
- **`release.mjs` `check`, `prepare`, `verify-release`**: they already treat `pre/` as consumed, with one change in
  `check`: its package-name and 0.x-major rules judged every changeset, `pre/`'s included, so a group or a rule that
  changed after a candidate could have turned that candidate's record red on every later PR (found by claim-check, by
  adding a `pre/` file naming another package). They now judge the pending ones only; the name-reuse rule still reads
  `pre/`'s names.
- **`release-notes.mjs`**: unchanged, pending only. A candidate's notes hold what is new, and are regenerated after its
  release commit moved the changesets with `--at <release commit>^` (the flow test pins that they equal the committed
  file). A `--consumed` flag to read `pre/` for the whole series' notes (what the release that leaves pre mode, P14, will
  want) was written and then cut in review: nothing calls it before P14, it adds a way to lint `pre/`, which the rule
  above says not to do, and it brought its own edge cases (a `pre` that is a file, symlinks). P14 will decide how it
  gets the series' notes, from the `docs/releases/` files or from `pre/`.
- **The `changeset-required` gate**: unchanged; it counts only `.changeset/<name>.md`, so what a release commit adds to
  `pre/` never satisfies it, and a release commit merged back from `main` is not charged to the PR (a test pins both).
- **Added: `tests/tooling/release-pre-mode.test.ts`**, which prepares a fixture workspace (the `plan` job), stages and
  checks it (`verify-release`), commits and tags it as a candidate, builds the prerelease's notes from it
  (`candidateNotes`), then runs the directory reader, `release.mjs check` and the notes tool over the committed tree and
  cuts the next candidate from it, checking its notes carry only what is new and regenerate from the commit before it.
- **No changeset in this PR**: nothing it changes is a gated path. The changeset on `integration` already (`@sssb/tools`,
  `@sssb/create`: doctor from the root) is what lets the next merge to `main` cut `rc.1`; a merge of `main` into
  `integration` planned `0.2.0-rc.0 -> 0.2.0-rc.1` from it.

## A vouched-for bypass actor on an organisation ruleset passes `release-app verify` (2026-11-18, `fix/release-app-verify-org-bypass`)

JP created the release app (App 5820735), and `pnpm release-app verify --app-id 5820735` failed on one thing: the
organisation ruleset `require-pr` (7484436) also lets App 4038189, canopycms-release-bot, bypass it always, and
`release.yml` assumes the release app is the only actor that can push to `main` past it. JP says that App is installed
on `safeinsights/canopycms` only, so it cannot reach this repository. The API shows only part of that: the
organisation's installation list (which `verify` already reads with the operator's own token) says the App is
installed once, on selected repositories, but which repositories are selected needs a token this tool does not have.

- **A checked-in list, not a flag.** `VOUCHED_ORG_BYPASSES` in `scripts/release-app/rulesets.ts` names each actor a
  person has vouched for: the organisation ruleset's id, the actor's type and id, its name, a one-line reason, who
  vouched and the date. `verify` and `bypass` report each as a ✓ with that reason, and anything else on an
  organisation ruleset the release meets still fails. A command-line flag was rejected: it would widen the check for
  whatever it named, a typo included, with no record of who decided or why.
- **Exact matches only, and Apps only.** An entry covers one App (`Integration` and its id) on one ruleset; the same
  App on another ruleset, another actor type with the same id, or a neighbouring id is not covered. An organisation
  admin, a team or a role cannot be vouched for: "cannot reach this repository" is never true of one.
- **The vouch holds only while the installation list agrees.** `verify` and `bypass` read the organisation's
  installations and accept the vouch only while the App is installed exactly once, on selected repositories, and not
  suspended; otherwise it is a ✗ that says what changed. So the drift nobody would notice (the App moved to all
  repositories, a second installation) turns the check red; the part the tool cannot see (which repositories are
  selected) stays the person's word. The review of this change found the tool already read that list, which the
  first version of this entry said it could not.
- **The first entry:** Integration 4038189 on `require-pr`, canopycms-release-bot, installed on
  `safeinsights/canopycms` only, vouched for by JP on 2026-11-18. It has to be re-vouched or removed if that App is
  ever installed on more repositories.

## `@sssb/tools` is a peer of `@sssb/cdk`, and Next's lint knows the apps (2026-11-18, `fix/cdk-tools-peer`)

Pages' switch to v0.2.0-rc.1 found two packaging problems (its items 1 and 5). ADR-0014's addendum of the same date
records the first. Decisions, each with what was rejected:

- **`@sssb/tools` is a peer of `@sssb/cdk`, not a dependency** (`packages/cdk/package.json`). Reproduced first with
  the packed tarballs served over a local URL, installed as the rc.1 notes say (pnpm 11.14.0): with the notes'
  `overrides`, `ERR_PNPM_EXOTIC_SUBDEP`; without them, pnpm asked npm for `@sssb/tools` and found no release candidate, only the `0.0.0` and `0.0.0-stage` placeholders. With the
  peer and no `overrides`, the install resolved and cdk's peer was the package's own `@sssb/tools`. Rejected:
  documenting `blockExoticSubdeps: false` (it turns off a supply-chain guard for every dependency of the workspace, to
  admit one); keeping the dependency and `overrides` (the error above); publishing release candidates to a registry
  (npm publishing waits for P14, and it would not fix the tarball recipe `@sssb/create --sssb` writes).
- **`SssbApp` refuses to synth beside an `@sssb/tools` of another version** (`toolsVersionProblem`,
  `packages/cdk/src/sssb-app.js`, read from cdk's own resolution of `@sssb/tools/package.json`). The exact dependency
  used to pin it; a peer at another version is only pnpm's warning (`strictPeerDependencies` is off), and cdk's
  deploy-time checks are that tools release's, while `sssb doctor`'s version check reads each app's own packages, never
  its `infra/`. The review found it. `packages/cdk/src/sssb-app-tools-version.test.js` pins the refusal (cdk reads its
  `@sssb/tools` manifest as another version; without the call in `resolveMigrator` the test goes red).
  Rejected: `strictPeerDependencies` (an adopter's whole-workspace setting).
- **Each app's `infra/` declares `@sssb/tools`** beside `@sssb/cdk` (`apps/starter/infra/package.json`,
  `apps/showcase/infra/package.json`), so the peer is met by a dependency of the package itself rather than by pnpm's
  `resolvePeersFromWorkspaceRoot` finding the root's copy, or `autoInstallPeers` asking the registry.
- **The peer cannot lift the fixed group to 1.0.0** (part 10's reason for keeping peers out): measured with
  `@changesets/cli` 3.0.3, a `minor` on `@sssb/tools` versions the set to 0.3.0 from 0.2.0 and to `rc.2` in pre mode;
  a peer range the bump leaves out of range (`^0.2.0`) moved cdk with the set to 0.3.0, and with the fixed group
  removed gave it only a patch, never a major. The release plan's 1.0.0 backstop stays.
- **No `overrides`, anywhere** (`release.mjs` `candidateNotes`, `@sssb/create`'s `--sssb`): nothing needs one now.
- **The packed cdk's check** (`cdkPackProblems`, `scripts/pack-and-consume/checks.mjs`) requires `@sssb/tools` as a
  required peer at exactly cdk's version, and fails it as a dependency.
- **Pack and consume proves the notes' recipe** (`notesRecipe`, the pages shape): `candidateNotes` rendered for the
  packed tarballs, its JSON block taken verbatim into a workspace package, the URLs pointed at a local server (a child
  process, stopped when the step ends or the run exits), the generated workspace's `minimumReleaseAge` guard kept and
  nothing else set, installed with `--ignore-scripts`. The guard and the flag came from review: the install has no
  lockfile, and this job's tarballs become a release candidate's assets, so a package published in the last days must
  not be installed, nor any install script run, beside them. Past pre mode (P14) `candidateNotes` has no notes to
  render, so the step says it is skipped (`.claude/future-tasks/p14-leave-pre-mode.md` has the follow-up). Rejected:
  rewriting the whole pages shape to install by URL (the shape's `file:` installs and committed seed would need a URL
  token, for no more coverage of the recipe); a committed lockfile seed for the recipe (one more seed to refresh, for a
  step that checks only how the `@sssb` packages resolve).
- **Next's lint gets each app as its root dir** (`settings.next.rootDir` on the preset's `next` block,
  `packages/eslint-plugin/src/app-config.js`). `@next/next/no-html-link-for-pages` looked for `pages/` and `app/`
  under the directory ESLint ran from, so from a workspace root it printed "Pages directory cannot be found" on every
  run (exit 0), and found no app to check links against. The preset already knows the apps (`resolveRoot`). Next
  reads each as a fast-glob pattern after turning every backslash into a slash, so a backslash escape broke any path
  with a special character (the review found it); each special character is a one-character class instead
  (`nextRootDir`), and `!` is left as it is (`[!]` is a negated class). This repository's own root config, which gives
  the framework's screens Next's rules too, points them at the apps (`apps/*`), where they render; `pnpm verify`'s
  `eslint .` showed it warning the same way. Rejected: switching the rule off (it then checks nothing anywhere); an
  option adopters set (the preset has the answer).

## The real S3 storage adapter is published as a factory, and rc.0's gitleaks advice is corrected (2026-11-18, `feat/s3-storage-factory`)

The first adopter, on `v0.2.0-rc.1`, kept a copy of the kit's real S3 storage adapter for a simulated app run against a
real bucket (`dev:edge`), because the kit did not publish it; and found that rc.0's notes told it to drop a
`.gitleaks.toml` entry that its full-history scan still needs.

- **`@sssb/kit/adapters/real/s3-storage` exports `createS3Storage({ bucket, region?, endpoint?, credentials?,
forcePathStyle?, client? })`**, the adapter the real-mode registry builds, moved from `adapters/real/storage.ts` to a
  module of its own so the published surface is the factory and its options alone; `storage.ts` keeps the registry's
  `createRealStorage(bucket, region)` as a two-line wrapper, so the registry, its mocks and its tests did not change. The
  options are `S3ClientConfig`'s own keys, passed through when set. A `client` beside any of the others is refused,
  since they would be ignored silently. Rejected: publishing `createRealStorage(bucket, region)` (no endpoint, path
  style or credentials, which is what the copy needed), and an `S3ClientConfig` pass-through (it would publish the
  SDK's whole configuration surface as the kit's). The port is unchanged, the SDK stays in `packages/kit/src/adapters/`,
  and an app imports the factory from its own `src/adapters/real/` (`sssb/no-kit-real-adapter-import` bans it only in the
  registry and the fakes). It passes the universality test: it is the real adapter of SSSB's own storage port.
- **The gitleaks correction is a new changeset, and the consumed one is corrected in place.** The advice was in
  `.changeset/pre/history-since-keel-scaffold.md`, consumed by rc.0. The notes tool's "Corrections to earlier notes"
  lists changesets EDITED since a ref, but only `.changeset/*.md` and only under `--since`, and a candidate's notes are
  built without `--since` from the pending changesets (`release.mjs prepare`), so an edit to a `pre/` file reaches no
  candidate's notes. The README's rule for "more to say about a change a release candidate already carried" is a new
  file, so `gitleaks-keep-keel-webhook-entry.md` (scaffold, required) is what rc.2's notes carry; the `pre/` file is
  corrected too, so the record P14 reads for the whole series does not repeat the wrong advice. Rejected: editing only
  the `pre/` file (rc.2's notes would say nothing) and teaching the notes tool to read edits in `pre/` (the
  decision of 2026-11-18 above left reading `pre/` to P14).

## SSSB's real adapters are fenced across the app, not only in its registry and fakes (2026-11-18, `fix/fence-kit-real-adapter-imports`)

Found while publishing `@sssb/kit/adapters/real/s3-storage`: `sssb/no-kit-real-adapter-import` ran only over an app's
`src/adapters/` (less `real/`), so a route, a domain module or a screen could import `@sssb/kit/adapters/real/llm` or
`s3-storage` by a declaration and load the vendor SDK in a simulated run.

- **The same rule id, a wider block.** `kit-real-adapters-by-import` in the app preset runs it over every file of the
  app, deny-by-default, less `src/adapters/real/` and the vendor ban's three carve-outs (`next.config.*`,
  `tests/contract/`, `infra/`); `registry-and-fakes` no longer lists it. Review found that the first version, over
  `src/` and `config/` only, let a module outside them (a `lib/`, a test helper, a script) re-export one into `src/`
  with every check green, the route the vendor ban closes by covering the whole app; so it covers what the vendor ban
  covers. Rejected: a second
  rule id. The pattern and what it bans are unchanged, only where; a second id would leave two rules saying one thing,
  and an adopter config that switched the old one off for the registry would have kept doing so. The message now
  says where it holds.
- **What stays allowed, and why.** `import()` anywhere (it is a declaration rule, as the app's own real-adapter rule
  is): the sign-in, accept-invite and layout modules load SSSB's real-mode forms and providers that way when
  `!isSimulated`, and lint cannot see the branch. `src/adapters/real/` may import one statically, as it imports a
  vendor: an app-owned storage adapter builds on `createS3Storage`. The showcase's fixture recorder
  (`apps/showcase/scripts/llm-record.ts`), which runs the real LLM client on purpose, now loads it with `import()`
  rather than being carved out.
- **What is banned with it, and what is not.** Tests and stories are banned too (a story would put the SDK in the
  workshop; the app's real adapters' own tests sit in `real/`), and so are re-exports and the inline
  `import { type X }`, which `verbatimModuleSyntax` emits as `import {} from …` and so loads the module. A declaration
  that is type-only as a whole (`import type`, `export type … from`, `import type x = require()`) is allowed: TypeScript
  erases it under every setting, and the fence is about loading the SDK (`allowTypeOnly` in
  `packages/eslint-plugin/src/import-ban.js`, for this rule alone). The first version banned it, like every other
  declaration fence, and pack and consume's consumer failed: its `src/sssb-surface.ts` names every published module
  with `export type * as …` to typecheck the whole surface. Rejected: rewriting that file to `typeof import()`, which
  would have kept a ban on code that loads nothing.
- **Not covered, by design parity.** A `require()` of one is not this rule's (it is a declaration rule, so `import()`
  stays open); `@typescript-eslint/no-require-imports` reports a `require()` call, nested ones too (seen in `.ts`, `.js`, `.mjs`
  and `.cts` files), but that is a base
  rule, not a fence `sssb check-fences` holds. The app's own real-adapter rule has the same gap.
- **Existing code.** Every reach into `@sssb/kit/adapters/real/*` from either app's `src/` was already an `import()`;
  the one declaration was the showcase's fixture recorder (above), and the starter-built template has none. The
  kit-s3-storage changeset's parenthesis, which said the
  ban held only in the registry and the fakes, is corrected in place (it is pending, in no release candidate yet).

## An app names the cluster-wide roles its migrations create (2026-11-18, `fix/owner-pass-app-roles`)

Reported by Pages: the contract suite's owner pass (`packages/kit/src/db/owner-pass.ts`) gave a later owner ADMIN on
`app_user` only. Pages' migration 1003 creates a role of its own, `pages_maintainer`, and on the pass after the first,
where the role already exists, the new owner holds no membership in it, so the migration's statements that need ADMIN
on it fail (`permission denied to alter role`). Pages made 1003 warn instead of fail to get past it. Roles are
cluster-wide, so a real cluster takes that branch too: any owner after the one that created the role.

- **Chosen: an optional `appRoles` export** (`readonly string[]`) from the app's `@sssb/app-config/db/migrations`
  module, beside `appMigrations`, because migrations are what create roles. Optional, so an app that creates none
  changes nothing. The kit reads it with `in` on the module namespace (`packages/kit/src/db/app-roles.ts`), which
  compiles against a seam that lacks it (the starter's: `apps/starter/tsconfig.json` compiles `packages/kit/src`
  against the starter's own seam), and validates it when read: an array of distinct lowercase unquoted role names,
  never `app_user`, `pg_*` or `rds_*`.
- **The owner pass grants the creator's membership** (`GRANT <role> TO <owner> WITH ADMIN TRUE, INHERIT FALSE, SET
FALSE`, what it already grants on `app_user`) on each NAMED role that already exists; one that does not exist yet is
  created by the owner's own migration, which gives it that membership. It grants on nothing unnamed, and refuses,
  before granting anything, a named role that is a superuser or has BYPASSRLS, REPLICATION or CREATEROLE: ADMIN on such
  a role is more than ADMIN on an app's ordinary role. After the migrations it checks the owner holds ADMIN on every
  named role, whichever branch each took. Teardown is unchanged: a role a migration creates is the cluster's.
- **The conformance check `app-roles`** (unit, `packages/kit/src/testing/conformance/db.ts`) migrates a fresh pglite,
  the framework's migrations alone first and then the app's, and diffs `pg_roles` after each: what the framework's
  add is the framework's (today `app_user`, derived, not listed), and what the app's add must be exactly `appRoles`.
  A created role left unnamed fails, and so does a named role no migration creates, so a stale or hostile name never
  reaches the owner pass's grant.
- **The fixture is the case**: `packages/kit/test-fixture/app-config/db/migrations/1004_fixture_docket_clerk.ts`
  creates `fixture_docket_clerk` idempotently, grants it SELECT on `dockets` and sets its `statement_timeout` (the
  ALTER needs ADMIN), each statement one Data API call. With the grant removed, the second `pg` pass and the Data API
  pass fail with `permission denied to alter role`, as Pages saw, and the first pass passes.
- **Rejected: a new required seam module `@sssb/app-config/db/roles`.** Every adopter would have to add a file, a
  breaking seam change for the apps (both of SSSB's included) that create no role, and the roles would live apart from
  the migrations that create them.
- **Rejected: an option on `contractSuite`.** The conformance check, and any production code that needs the list (a
  migrator granting a second owner, say), could not see it, and the list would be kept in step with the migrations in
  two places with nothing to compare them.

Review round 1 (same day, Fable and Opus, each finding confirmed on Postgres 18.4 and pglite) changed three things.
These bullets replace the refusal and the "Teardown is unchanged" sentences above.

- **An app's role must be ORDINARY, and the refusal reads its memberships, not only its attributes.** ADMIN on a role
  lets its holder grant itself SET and INHERIT on it, and so act as every role it is a member of: a named role that was
  a member of a SUPERUSER role, of `pg_execute_server_program` (Fable ran `COPY ... FROM PROGRAM` as the owner) or of
  `rds_superuser` handed the owner that power while all four attributes read false; and with ADMIN and CREATEROLE the
  owner can reset a LOGIN role's password. The rule (`refusedOf`, `packages/kit/src/db/app-roles.ts`): no SUPERUSER,
  BYPASSRLS, REPLICATION, CREATEROLE, CREATEDB or LOGIN, and no membership, at any depth through `pg_auth_members`
  (recursive, whatever its INHERIT and SET options), in any role but `app_user` and the other named roles. Refused
  before anything is granted, as before. _Rejected:_ an allow-list of "harmless" predefined roles
  (`pg_read_all_stats`, say): which ones are harmless changes by Postgres release and by provider, and an app's own role
  has no reason to hold any. _Rejected:_ counting only the memberships whose INHERIT or SET is on: ADMIN turns them on.
- **The owner pass checks the roles again after the migrations.** The owner's migration runs with ADMIN and CREATEROLE
  on every named role, which lets it (Fable's probe, Postgres 18) make one LOGIN with a password it chose, CREATEDB or
  CREATEROLE, though never SUPERUSER, BYPASSRLS or REPLICATION. The pass fails, naming the role and what it gained,
  when a named role is no longer ordinary once the migrations ran; the conformance check `app-roles` gains the same
  check on pglite ("every role appRoles names is an ordinary role once the app's migrations ran"), so an adopter sees
  it in the unit run. pglite reports the attributes and memberships faithfully: `packages/kit/src/db/app-roles.test.ts`
  reads each case back from it. _Rejected:_ the conformance check alone: pglite migrates as a superuser, so it cannot
  see what depends on running as the owner.
- **Teardown revokes what the owner granted, and a role it cannot drop fails the pass.** A migration that grants a
  membership as the owner (`GRANT fixture_docket_clerk TO app_user`) makes the owner that membership's grantor, a
  cluster-wide dependency: `DROP ROLE` failed with "cannot be dropped because some objects depend on it", the teardown
  swallowed it, and every run on a reused server left LOGIN CREATEROLE owners holding ADMIN behind, green (measured: 3
  `sssb_owner_*` roles and a `sssb_creator_*` after one kit run, 6 and 2 after two). Now `dropPassRole`
  (`packages/kit/src/db/owner-pass.ts`) runs `DROP OWNED BY` in the maintenance database, once the owner's own database
  is dropped, then `DROP ROLE`; on Postgres 18 that revokes the memberships the owner granted and leaves a superuser's
  grant of the same membership in place (no role left after two runs). An owner the teardown cannot drop fails the
  pass after every other teardown step ran, together with the pass's own failure when there is one (an
  `AggregateError`). The fixture's 1004 now grants the clerk to `app_user`, so every pass exercises it; that weakens no
  proof, since `app_user` already holds SELECT on `dockets`, the clerk holds nothing else, and `tenant_isolation` is a
  policy for every role. _Rejected:_ `REVOKE ... GRANTED BY <owner>` for each membership read from `pg_auth_members`:
  it clears the memberships alone, where `DROP OWNED BY` also clears any other shared-object grant the owner made.
  _Rejected:_ `REASSIGN OWNED BY <owner> TO postgres`: it keeps the pass's grants on the server as the superuser's, so a
  later pass would meet them as though a real creator had made them.
- **The two checks no test reached now have one each** (Opus). `grantAppRoles` validates the names it is handed again
  (`checkAppRoles`), because a caller other than `runOwnerPass` may pass any list, and `pg_execute_server_program` or
  `app_user` read as ordinary roles to `refusedOf`; the post-migration ADMIN assertion fails when the owner's ADMIN on a
  named role is revoked during the migration. Both are in `packages/kit/src/adapters/real/db.contract.test.ts`, and
  each was seen red with its check removed.

Review round 2 (same day; the reviewer's finding confirmed on Postgres 18.4) changed these. They add to round 1's
bullets, and replace its reading that a named role's walk passes through `app_user`.

- **`app_user` is held to the ordinary-role rule too.** Every later owner gets ADMIN on it, as on a named role, but
  nothing read its own attributes: with `app_user` made LOGIN CREATEDB with a known password and a member of
  `pg_execute_server_program`, both owner passes and the RLS proofs stayed green, and every owner got ADMIN on it.
  `refusedOf` now reads `app_user` first, then the named roles, wherever they exist, and the same three places act on
  it. `grantAppRoles` refuses a non-ordinary `app_user` and grants nothing; `runOwnerPass` now calls it BEFORE it grants
  `app_user`, so nothing at all is granted on a refusal (a test records every statement the pass sends and sees no
  GRANT). The check after the migrations covers it, and the conformance check `app-roles` gains a fifth test, "app_user
  is an ordinary role once the app's migrations ran". The framework's own migrations ask nothing of it the rule
  forbids: 0001 creates it NOLOGIN, 0015 grants it TO the migrating role (a membership of that role, not of
  `app_user`), and no framework migration makes it a member of anything.
- **For `app_user`, the membership rule is adjusted, not copied.** It may hold none of the six attributes, and it may be
  a member of the named roles and of any role ORDINARY IN SHAPE: none of the six attributes and not `pg_*` or `rds_*`,
  at any depth. The reason is measured: CI's contract job runs every suite against ONE server
  (`CONTRACT_DATABASE_URL`, `.github/workflows/app-checks.yml`), and `app_user` is cluster-wide, so once the framework's
  suite has migrated there as the superuser, `app_user` is a member of `fixture_docket_clerk` for good (the
  superuser's grant, which no teardown removes). With the named-roles-only rule, every owner pass of both apps' suites
  failed on a fresh shared Postgres 18.4 (6 tests, and the kit's own case for it: 7 of 57); with this one all 57 pass,
  twice over on the same server.
  The same holds on any cluster several apps share. A named role's walk now stops at `app_user`, which answers for what
  it leads to under its own rule. _Rejected:_ the named roles' rule for `app_user` (breaks every shared server, as
  measured); cleaning the fixture's grant up after the framework's suite (any app that grants its role to `app_user`,
  as the guide allows, would break the next app's pass the same way). _Accepted gap:_ the shape rule cannot see what an
  unnamed attribute-free role owns or is granted in other databases; on a cluster several apps share, `app_user` is
  shared too, so each app's owner already reaches what the others grant it.
- **The contract tests assert the one error they expect, and that no owner is left** (`expectOnly` and `ownersOn` in
  `packages/kit/src/adapters/real/db.contract.test.ts`): the outcome is an Error and not an AggregateError, whose text
  would still contain the expected message when the teardown also leaked; and no `sssb_owner_*` role is on the server
  that was not there before. The second owner's hook drops each role whatever the other did and reports every failure
  (`dropPassRoles`, with a test of its own).
- **The AggregateError stays.** Measured: Vitest 4.1 prints each error an AggregateError holds on its own, the inner
  assertion's expected/actual diff included, so nothing is hidden. _Rejected:_ rethrowing the pass's own error with the
  teardown failure as its `cause`: its message would no longer say an owner was left, so a caller matching the message
  would not see the leak, and a `cause` the error already had would be overwritten.
- **Seen red, one change at a time:** `refusedOf` without `app_user` (3 contract tests, 2 pglite tests); `app_user`
  granted before `grantAppRoles` (the recorded-GRANT test); a teardown that always reports a leak (the LOGIN and ADMIN
  tests, which `String(outcome)` let pass); a teardown that silently keeps the owner (the four tests that read
  `ownersOn`, and round 1's teardown test); the hook
  helper dropping in sequence (its test); the fixture's 1004 making `app_user` LOGIN and a member of
  `pg_read_server_files` (the new conformance test).

Review round 3 (same day; a claim check, every measurement on Postgres 18.4 and pglite 0.5.16). It replaces round 2's
_Accepted gap_ and adds to the rule.

- **"Ordinary" now reads the cluster-wide catalogs too.** An attribute-free role that is a member of nothing can still
  hold cluster-wide power, and ADMIN on it hands that power to the owner: measured, an owner with only ADMIN on a role
  granted `ALTER SYSTEM ON PARAMETER archive_command` granted itself SET on it and ran
  `ALTER SYSTEM SET archive_command` (a shell command the server runs), which it is refused as itself. So `refusedOf`
  (`packages/kit/src/db/app-roles.ts`) refuses, for `app_user`, a named role, and (in the shape test) every role
  `app_user` reaches: a privilege on a server parameter (`pg_parameter_acl`), a database it owns
  (`pg_database.datdba`) and a tablespace it owns (`pg_tablespace.spcowner`). All three are shared catalogs, read from
  whatever database the pass connects to, by any role (measured as a `NOSUPERUSER` login). The owner's own migration
  can make a named role a database's owner (it grants itself SET, then `ALTER DATABASE ... OWNER TO`; `CREATE DATABASE` cannot run in the migrations' transaction), but not grant a
  parameter privilege or create a tablespace (both refused to it): the check after the migrations catches the first,
  in a test of its own. The rule's text now has one home, `ORDINARY_NAMED` and `ORDINARY_APP_USER` in `app-roles.ts`,
  which the owner pass's and the conformance check's messages print; the conformance message for `app_user` said
  "grant it only the roles appRoles names", stricter than the rule round 2 settled on, and now says that rule.
- **Each attribute is seen on a reached role.** Only SUPERUSER had been: removing any other of the six attributes
  from the shape test passed every test. Now each attribute and each catalog entry has a role of its own that
  `app_user` is a member of, in `app-roles.test.ts` (pglite) and in the contract test, which adds a leaked owner pass's
  owner (`LOGIN CREATEROLE CREATEDB`).
- **Accepted gap, now:** what a role owns or is granted INSIDE a database other than the one being read (a table it
  owns in another app's database, say) is in that database's catalogs, not the shared ones. `pg_shdepend` records
  ownership across databases (measured: a table in `starter_contract` owned by a role shows there as `deptype 'o'`),
  so a later round could refuse that cheaply; the grants recorded there also include `app_user`'s ordinary table
  grants, so they would need sorting first. On a cluster several apps share, `app_user` is shared too, so each app's
  owner already reaches what the others grant it.
- **Seen red, one change at a time:** each of the six attributes removed from the shape test (one pglite test and the
  contract `app_user` refusal each time); each catalog entry removed from a role's own reasons (the pglite and
  contract named-role tests, and for the parameter both `app_user` tests) and from the shape test (the pglite and
  contract `app_user` tests); the own-database entry removed (the new after-the-migrations test). Round 1's and round
  2's mutations were re-run on this branch and still red what they name; with this round's test added, the
  "keeps the owner" mutation reds five `ownersOn` readers, and the named-roles-only rule for `app_user` reds 7 of 58 on
  a fresh shared server (all 58 pass twice over on one). Both apps' typecheck, not
  `packages/kit/tsconfig.strict.json`, is what compiles the kit against a seam without `appRoles` (the strict config
  resolves the seam to the fixture, which exports it): reading `.appRoles` directly fails `apps/starter` and
  `apps/showcase` with TS2339 and passes the strict config.

## P14: the first release to public npm (2026-11-18, `release/p14-first-npm-release`)

JP's standing rule for this work: decide, record the decision and what was rejected, and report it.

- **0.2.0, not 0.1.0.** The P14 row predates the candidates; the group is at `0.2.0-rc.2`, and leaving pre mode takes
  it to `0.2.0`. Recorded in an ADR-0014 addendum rather than by editing the row. Rejected: forcing 0.1.0, which is
  behind the candidates already installed and which `prepare` refuses as going backwards.
- **Pre mode is left by deleting `.changeset/pre.json`.** Rejected: `changeset pre exit` (`"mode": "exit"`). Read
  from `@changesets/assemble-release-plan` 7.0.0 and `apply-release-plan` 8.1.1: both release every `pre/`
  changeset and delete it; exit mode adds a forced patch when nothing is pending and deletes `pre.json` in the
  release commit, which `verify-release` would then have to accept. Deleting it in the PR keeps one state fewer.
- **Out of pre mode the `pre/` changesets are pending everywhere at once**: `loadWorkspace`, `verify-release` and the
  notes tool. `check` judges them again (the next release reads them); all 31 pass today's lint. `check`'s rule
  against a pending changeset reusing a consumed one's name now holds in both modes. Rejected: leaving them unlinted
  out of pre mode, which would let the release find a malformed one after merge.
- **The first plain release's notes are every changeset since the first candidate.** Rejected: notes that point at
  the three candidates' prereleases, which an adopter starting on 0.2.0 from npm would have to chase. Pages, on rc.2,
  gets its delta from `--since v0.2.0-rc.2`; the "Upgrading to this release" section is a sibling task's.
- **The changeset is `scaffold`, `optional`, a patch on all five packages.** An adopter on a candidate's tarballs
  keeps working; moving to npm is their choice. A patch and a minor both release 0.2.0 from `0.2.0-rc.2`. Rejected:
  `required`/`minor`, which would tell pages it breaks by doing nothing.
- **The release dry-run is a `checks.yml` job that rehearses the real commands**, `prepare` → `verify-release` (from a
  copied checker) → local commit and tag → `publishable` → `pnpm pack` → `preflight` (reading npm) → `npx
npm@11.21.2 publish --provenance --dry-run`. Measured: npm 11.21.2 accepts `--provenance --dry-run` with no OIDC
  token (it signs nothing on a dry run) and refuses a prerelease version without `--tag`, so the rehearsal fails a
  release that would publish a candidate. The job holds `contents: read` only, keeps no credentials, and sets
  `SSSB_CREATE_UNPUSHED_PIN` for its packing (its release commit exists only there). Rejected: a dry-run job in
  `release.yml` (it would run only on `main` and tags, after the decision), and packing at the PR's own version
  (`0.2.0-rc.2`, which is not what a merge publishes). Not a required check until JP adds it to the rulesets.
- **"Nothing publishes early" is a test over the workflow files** (`tests/tooling/release-reach.test.ts`), not prose:
  the triggers, the `if`s and `needs` from a tag to `publish`, the order of `pack`'s gates, the id-token holders, and
  no publish elsewhere but a dry run. Each was seen red: a `pull_request` trigger added to release.yml, and
  `--dry-run` dropped from the rehearsal. What it cannot read (environments' deployment rules, the tag ruleset, npm's
  trusted publishers) stays JP's settings, listed in release.yml's header.
- **A copy of this repository's own tree is released in a test** (manifests and `.changeset/` only): `prepare` with
  the real CLI, then `verify-release` and `publishable`. While the group is a candidate, the release must be its own
  version. Seen red with `verify-release`'s `pre/` handling removed.
- **Not changed: `pack` still packs again on the tag** rather than publishing the tarballs `checks`' pack-and-consume
  job tested on the release commit, as a candidate's tag does. Out of this task's scope; the rehearsal packs as `pack`
  does.

## Pack and consume proves the by-version install against a local registry (2026-11-18, `release/p14-first-npm-release`)

`registryRecipe` (pages shape) installs the packed `@sssb/*` by version, as `@sssb/create` writes them without
`--sssb`, from a minimal npm registry on 127.0.0.1 that serves the TARBALLS directory (`.npmrc` `@sssb:registry=`, so
only the scope is local). It runs for every packed version: a caret range on a prerelease matches it.

- **The specifier is read from the packed generator's own output**: the step runs `create.js <dir> --yes` with no
  `--sssb` and collects the `@sssb/*` specifiers from the generated manifests, rather than hard-coding `^` or importing
  `generate.js` out of the tarball. The generator is what is under proof, so a hard-coded rule would pass a generator
  that stopped writing it. Rejected: importing `resolveSssb` (not exported, and a second path to the same rule).
- **The tarball URL in the packument has npm's own shape** (`/<name>/-/<unscoped>-<version>.tgz`), so pnpm records
  an integrity alone in the lockfile; the lockfile check then refuses any `tarball:` or `file:` outright, which a
  free-form URL would have made impossible to tell from a mis-resolution. Rejected: reusing `SERVE_DIRECTORY` with
  flat file URLs.
- **The pure helpers sit in `scripts/pack-and-consume.mjs`, between `registry-helpers` markers, and the test loads that
  text as a module.** The usual home, `scripts/pack-and-consume/checks.mjs`, was outside the files this change was
  allowed to touch (another session edits the release scripts in parallel), and the script cannot be imported (it runs
  the job). Move them into `checks.mjs` when that is open: the test's loader then becomes an import.
- **Correction, same branch: the registry recipe's pure helpers moved to `scripts/pack-and-consume/checks.mjs`**, where
  the script's other pure checks live, and the test imports them; the marker-delimited block loaded as a data-URL
  module (the entry above) is gone. The rehearsal job also re-installs, frozen, on its local release commit before
  packing, as `pack` installs on the tag.

## Release snapshots: stateful logical ids and the required environment, each a `minor` to change (2026-11-18, `release/p14-first-npm-release`)

ADR-0014 part 10 says CI snapshots the logical ids of stateful resources and the `REQUIRED_ENV` list, and a change to
either requires a `minor` changeset; its P14 row lands them. Built as two committed JSON files and one rule in the
`changeset-required` gate.

- **Plain JSON compared with `toEqual`, not a Vitest snapshot.** `toMatchFileSnapshot` (or `toMatchSnapshot`) is
  rewritten by `vitest -u`, and a run outside CI writes a missing one, so deleting or regenerating the file would make
  the test pass and leave the gate nothing to see. The tests read the file and fail with the full new content in the
  message, to be copied in by hand beside the changeset. Rejected: a Vitest file snapshot, relying on CI never passing
  `-u` (true today, but a local `-u` is the habit that would rewrite it silently).
- **Where they live: `packages/<package>/release-snapshots/`**, outside each package's `files` allowlist, so neither
  ships (`packages/kit/release-snapshots/required-env.json`, `packages/cdk/release-snapshots/stateful-logical-ids.json`).
  The gate matches the directory pattern, not two named files, so a package that adds a snapshot is covered the day it
  lands; `tests/tooling/changesets.test.ts` checks this repository's two exist. Rejected: a repo-level directory (the
  kit's test would read a path out of the package) and a JSON under `src` (it would ship).
- **The required environment is read from `assertRealEnv`, not exported.** The kit test empties the environment, sets
  only `DATABASE_TRANSPORT`, and records the variables `assertRealEnv` names as missing, per transport: that is
  `REQUIRED_ENV` and `DATABASE_ENV` together, as a deployment meets them at boot. Rejected: exporting `REQUIRED_ENV`
  from `adapters/real/index.ts` (a published subpath, so a new name on the public surface, for a test), and moving it
  into an unpublished module of its own (a shipped source change made only to be testable). The cost is that the test
  parses the error's `Missing env:` list; a change to that message fails the test loudly rather than passing.
- **What counts as stateful** is `STATEFUL_TYPES` in `packages/cdk/src/stateful-logical-ids.test.js`, with a reason per
  type: the cluster, its writer instance, its subnet group (a new one has a new name, and CloudFormation's reference
  lists the cluster's `DBSubnetGroupName` as requiring replacement, so it would take the cluster with it; not
  re-checked against the reference offline when this was written), the cluster's secret, and the buckets;
  plus KMS keys, DynamoDB tables, EFS file systems, Cognito user pools and log groups, which `SssbApp` does not create
  today, so one added later is snapshotted from its first commit; plus any resource whose DeletionPolicy or
  UpdateReplacePolicy is `Retain`, `RetainExceptOnCreate` or `Snapshot`. Rejected: snapshotting every logical id (a
  Lambda's or an alarm's replacement loses nothing, and a `minor` for each would teach people to ignore the rule), and
  the network (VPC, subnets, security groups), whose replacement loses no data.
- **Synthesized from `apps/starter` under the id `Default`, in four shapes** (each transport, staging and production),
  the ids an adopter's stack holds. Today all four are the same six resources; they are kept apart so a resource only
  one shape creates is still caught.
- **The gate:** a PR that changes, deletes or moves a file under `packages/*/release-snapshots/` must add a changeset
  with a line filing `minor` for an `@sssb/*` package, read as `scripts/release.mjs`'s `changesetReleases` reads the
  frontmatter (inlined: the gate's tests run it in scratch repositories without the repo's scripts). Any `@sssb/*`
  package counts, since the group is fixed and one minor bumps all of them. Rejected: requiring the package that owns
  the snapshot (the same release either way). Exempt: the release merge, a file merged in from `main` (its PR carried
  the changeset), and a snapshot's first commit (it records the current state and changes nothing; this PR is one).
  Not exempt: Dependabot, since a person committing an updated snapshot to a Dependabot branch is how a CDK bump that
  moves a logical id would arrive, so the check runs before the Dependabot exemption.
- **`runGate` in `tests/tooling/changesets.test.ts` now removes its scratch repository as soon as the gate has run.**
  With about twenty more scratch repositories, removing them all in the file's `afterAll` overran the 10-second hook timeout on a loaded machine
  (load average 18).
- **Noticed, not changed:** the cluster's secret (`DbSecret…`) synthesizes with `DeletionPolicy: Delete` even when
  `production` is true, while the cluster, its instance, its subnet group and both buckets are retained. The snapshot
  records it by type, so it is covered either way; whether the secret should be retained is a question for `@sssb/cdk`.

## An app declares a port slot of its own (2026-11-18, `feat/app-declared-port-slots`)

Built from `.claude/future-tasks/resolved/port-slots-for-adopter-apps.md` (the future task, moved there by this change; an
earlier entry names its old path): a workspace with two apps of its own, both made from the starter, both declared
`starter` and bound one port. The design stood as written (`"sssb": { "port": { "name": "ledger", "default": 3700 } }`
beside the string form); the judgement calls it left open, each with what it beat:

- **The override variable is `<NAME>_PORT`, from the slot's name with `-` as `_` (`LEDGER_PORT`, `BACK_OFFICE_PORT`).**
  The built-ins already follow it (`STARTER_PORT`, `CONTRACT_PG_PORT`), and a name made of lowercase words and `-` maps
  to exactly one variable. Rejected: an `env` field in the declaration, which is one more thing for two apps to
  declare the same way by mistake (it is refused: a slot has `name` and `default` only). A name whose variable is a
  built-in's (`contract-pg`) is refused too, since the two services would then read one variable.
- **A worktree's port comes from 20000-29999, `20000 + sha1(root NUL name) % 10000`.** The design asked for a band the
  four built-in slots do not use, keyed on the name as well as the checkout. It is clear of every built-in default and
  derived band (3000, 3100, 3200-3599, 5439-5639, 61000-61199) and below the ephemeral ranges (Linux 32768, macOS 49152),
  so the OS never hands one out. Ten thousand ports make two slots of one worktree collide about once in ten thousand,
  and a collision is a loud EADDRINUSE, as it already is for the built-ins. Rejected: a narrow band beside the built-ins
  (3600-3999, 400 ports), where two slots of one worktree would collide forty times as often; and a scan for a free port,
  which the module's header rules out (two processes could disagree on the answer).
- **A declared default may not lie in a port band SSSB's own services use, nor above 49151 or below 1024.** In a main
  checkout it is the port; if it sat in a built-in's derived band a linked worktree of SSSB could derive the very port
  an adopter's main checkout binds, the collision the built-ins' separate bands exist to rule out. The task's own
  example, 3300, is inside the showcase and starter band (3200-3599), so the examples use 3700 and 3710. Rejected: accepting
  any port and leaving a collision to a loud bind failure, which the doctor cannot see in advance.
- **Two apps on one slot, and two on distinct slots with one default, both fail `sssb doctor`.** The second is the
  collision the first check cannot see: in a main checkout two distinct names with one default still bind one port. A
  worktree's derived ports differ by name, so only the default needs checking. An app with no declaration is not
  checked (launch-json already skips it), and an invalid declaration is a failure naming its package.json, where it was
  a failure of `sssb port` alone before.
- **`originFor()` and `portFor()` with no argument read the app the working directory is in, the nearest package.json at or
  above it that declares a port (no higher than the checkout root); a Playwright config names its own app with
  `originForApp(__dirname)`.** The first design read the working directory's package.json alone and told adopters to
  call `originFor()` in the config. Review found `pnpm knip` (in `pnpm verify` and the generated workflow) loads every
  workspace's Playwright config from the workspace root, where the call threw and knip exited 2, as `playwright test -c
apps/x/…` from the root does; and a test run from `apps/x/tests` read no declaration at all. The config's own
  directory is the one place that names the app wherever it is loaded, and Playwright and knip both compile the config
  to CommonJS, so `__dirname` holds; `originForApp` resolves symlinks, as `sssb port` (which runs in a real working
  directory) does. Rejected: the nearest package.json of any kind, which lets a package nested in the app (its `infra/`)
  hide the app's slot, and `originFor(readPortDeclaration(__dirname))`, which hands an undefined declaration to the
  no-argument form when the app declares none, a worse error than the one `originForApp` gives. With no app around it
  throws, and says to name a service, run from the app, or use `originForApp`.
- **`tick` and `dev-tick` know a custom slot only for the app in the working directory (or `--app`).** A slot is the
  declaring app's alone, so `sssb tick portal` run from the ledger app is an unknown app, listing the known ones, rather
  than a guess at another app's default. Rejected: reading every app's declaration in the workspace, which the commands
  (which run in one app's directory, and from a package script) do not otherwise do.
- **An app on a slot of its own may not name `showcase` or `starter`.** Review found the hole in the design as written: a
  second app made from the starter keeps `originFor('starter')`, `sssb tick starter` and `sssb dev-tick starter --` in
  files the generator copies, so its dev server would bind its own slot while its ticker and e2e run used the first
  app's port, the wrong-app adoption this exists to stop, with `sssb doctor` green because the declarations differ.
  `portFor`, `sssb port`, `serve-standalone`, `tick` and `dev-tick` now refuse another app's built-in slot when the
  app in the working directory declares a custom one (`foreignAppSlotProblem`, `packages/tools/src/ports.js`), naming
  what to do. `ladle` and `contractPg` stay free to name. Rejected: a doctor check that reads each app's scripts and
  Playwright config for a stale slot name, which has to parse shell command lines and TypeScript to find what a
  one-line refusal at the point of use catches with certainty. The pack-and-consume pages shape, which has two apps
  made from the starter, now gives its ledger a slot of its own the way `docs/adopting.md` tells an adopter to; with
  both on `starter` it failed `sssb doctor` by design.
- **The string form is untouched**: `portForRoot(…, 'starter')` takes the same code path to the same numbers (the
  existing tests pass unchanged), and a built-in's derived port is still keyed on the checkout alone. One message
  changed: a declaration naming an unknown service now says `unknown service "x"` with the known ones and the slot form,
  where it said `declares port service "x"`.

Not done: `.claude/future-tasks/neutral-app-port-service.md` (a neutral slot the generator writes in place of
`starter`) still stands; this makes it buildable without a new built-in. The starter and the showcase keep their string
declarations, so an app the generator writes is unchanged.

## P15: ADR-0013 superseded, and the adopter guide rewritten around the generator and upgrading by release (2026-11-18, `docs/p15-adopting-by-release`)

ADR-0014's P15 row. Its two dependencies are done: the generator (P12) and Pages' switch (P8:
`safeinsights/pages#11`, v0.2.0-rc.1, and `safeinsights/pages#14`, v0.2.0-rc.2, both merged into Pages'
`integration`). ADR-0013's Status line now says Superseded, with a dated addendum saying what replaces each of its
parts; its body is unchanged. ADR-0014 gains a matching addendum.

- **Chosen: supersede ADR-0013 now, not at the first npm release (P14).** The plan row depends on P8 and P12 only, and
  what ADR-0013 decided (fork and merge as the way updates arrive) stopped being true for the one adopter at P8. P14
  changes where the tarballs come from, not whether there is a merge.
- **Chosen: before npm, generate from a release candidate's tarballs, then point the `file:` dependencies at the
  release's URLs before the first install.** The guide's pre-npm path used to be packing SSSB's packages from a
  checkout, which pins whatever commit the checkout is at, not a release. Run against a downloaded candidate (the
  generator's own `--sssb .`, as the candidate's notes say), the workspace pins the release commit, and its `file:`
  paths name the download directory, which CI cannot see; the six dependency lines in three `package.json` files are
  changed to the URLs the notes print. Tried on v0.2.0-rc.2: generated, URLs swapped, installed, `sssb doctor` all ok,
  the pins matching the kit's release stamp. **Rejected:** a generator flag taking a release's URLs, which is
  `@sssb/create` work for after P14 shows what the npm path looks like, and teaching the checkout path first. The
  checkout path stays, as a subsection for trying an unreleased commit.
- **Chosen: the upgrade's version step says "change each version" in each `package.json`, not `pnpm up`.** The old
  text said `pnpm up`; a URL dependency has no range for it to move, and with nothing on npm yet the npm form cannot be
  tried. Listing the three files and the packages each declares is true for both and checkable. The generated
  `README.md`'s shorter "Upgrading SSSB" section is left as it is: it says nothing false.
- **Chosen: fix `sssb guide` rather than teach `--app`.** Writing the upgrade steps against a generated workspace found
  that `pnpm exec sssb guide`, which the generated `README.md` and `CLAUDE.md` tell people to run, failed at the
  workspace root ("does not resolve @sssb/kit"), the bug `fix/doctor-from-root` fixed for doctor. It now starts from
  the workspace's first app the same way, saying so; an explicit `--app` is never replaced. **Rejected:** writing
  `--app apps/<app>` into the guide alone, for the reason that entry gives, and because the shipped text would stay
  wrong. The guide says releases up to v0.2.0-rc.2 need `--app` at the root. A changeset (`@sssb/tools`, none).
  Seen red: the new test fails with `run` calling `takeAppDir` again, and passes with the fix.
- **Retired from `docs/adopting.md`**: taking updates by `git merge`; "add the line upstream and take it back by
  merge" for an `exports` entry; "don't edit SSSB's `eslint.config.mjs` … every later SSSB update would conflict";
  "if you keep the showcase around"; the layout's `packages/kit/src` and `packages/kit/test-fixture` lines; the stale
  claims that `next.config.ts` points next-intl at `packages/kit/src/i18n/request.ts` and that nothing typechecks an
  app's `infra/`; and the advice on SSSB's dated records ("truncate them at the date you forked"), which the generator
  never copies. New sections: "Upgrading by release", "Changing SSSB itself".
- **The same fork-era advice outside the guide went too**, as doctrine must stay true: `README.md`, `CONTRIBUTING.md`
  ("sending a fix upstream" from a fork), `docs/README.md` and `CLAUDE.md` (the doc gate's rule for reference-app
  citations no longer argued from merged-in docs), `docs/development-approach.md`, and the two recipes that pointed at
  ADR-0013 (`app-owned-adapter.md`, `workspace-coder.md`). `CLAUDE.md`'s "Follow the Accepted ones (0001–0014)" now
  names 0013 as Superseded.
- **Walked as an adopter, twice.** A workspace generated from v0.2.0-rc.2's tarballs and one generated at rc.1 and
  upgraded to rc.2 by the new section's steps (`sssb doctor` ok, `pnpm typecheck` and `pnpm lint` green after). The
  upgrade found the one trap the steps had in the wrong order: a workspace generated before rc.2 carries an
  `overrides` block mapping the `@sssb/*` packages to the old tarballs, so changing the `package.json` URLs and
  installing kept rc.1, with doctor still ok at rc.1. rc.2's notes remove the block, but as a scaffold change, which
  step 5 applied after step 2's install. Step 2 now says to make an install-affecting scaffold change first, and to
  check what the lockfile resolves. **Rejected:** having `sssb doctor` fail an `overrides` block for `@sssb/*`, a
  `@sssb/tools` change worth considering separately, since an override is the adopter's own setting.

## The authorization scan counts a denial only where it reaches the handler's outcome (2026-11-18, `fix/authz-scan-unawaited`)

The 2026-11-17 entry on the scan left a known hole to lint. A handler that calls an `async` same-file helper without
awaiting it "reaches" `authorize`, yet the helper's `ForbiddenError` becomes an unhandled rejection and the handler goes
on to mutate. The lint rule that entry named was never added. The session that fixed the hole made these decisions
under JP's standing rule. Two Opus review rounds, a sweep of the walk's trust points, and an Opus review of the
second round's fixes widened the fix from the floating helper to every place the walk lost a denial.

- **A scan change, not type-aware lint.** `route-scan.ts` now walks each function under an outcome: whether a throw
  at that point, and a promise the function returns, reach what Next awaits. `authorize` throws synchronously, so it
  counts wherever a throw does. A call into an `async` function, or into a call a function is handed to, carries the
  denial only when its result is `await`ed or returned on the spot (`settledBy`).
    - Rejected: `@typescript-eslint/no-floating-promises` scoped to route files. It answers a different question. It
      accepts `void p`, `p.catch(() => {})` and `p.then(ok, onError)` as handled, and each of those drops the denial.
    - The lint rule would sit beside a conformance check that still passed the route.
    - An adopter can turn a lint rule off, where a conformance opt-out has to be named and given a reason.
    - It needs type information in `@sssb/eslint-plugin`'s preset (`parserOptions.projectService`), so every
      adopter's lint run would build a type-checked program.
    - The scan needs no types. The only functions it credits are same-file ones and literals, and it can see whether
      each is `async`.
- **A function handed to an unknown call needs that call awaited or returned, sync or async.** The scan cannot read
  the callee. `.then`, a timer, `new Promise` and an `async` wrapper (`db.withTenant`) all run a sync function where
  its throw never reaches the handler. Rejected: trusting any sync callback to run in place. That passes
  `load().then((row) => authorize(row))`, and an unawaited `db.withTenant(org, () => { authorize(…) })`.
- **Array iteration methods are known by name, and an `async` callback to one is dropped.** An array iteration method
  is recognized when its receiver is neither an import nor an object whose code is in this file (whose `forEach` is
  its own). An `async` callback to one is dropped, so `await ids.forEach(async (id) => …)` fails: awaiting
  `forEach`'s `undefined` settles nothing. A sync callback runs in place, so `items.forEach((i) => authorize(…))` and
  `items.map((i) => { authorize(…); return i })` count as statements of their own. A `map`, `filter` or `flatMap` on
  a receiver that is visibly an iterator (`ids.values()`, `.keys()`, `.entries()`, `Iterator.from(…)`) runs nothing
  until consumed, so it counts for nothing.
    - Rejected: requiring every callback's call to be awaited, the first draft. That failed the `forEach` idiom.
    - Rejected: trusting the names on any receiver. That passes Ramda's curried `R.forEach(() => authorize(…))`, which
      only defines a function.
    - Rejected: treating `map`, `filter` and `flatMap` as lazy everywhere, the second draft. That failed the
      per-item `map` on an array, a natural bulk-route shape, to catch a lazy iterator nobody consumes.
- **A callee whose code is in this file is not trusted the way an imported wrapper is.** `isSameFile` covers:
    - a function, class or object literal, or an array literal holding one;
    - a function or class declaration;
    - a variable or destructured name holding one of those, or what such a callee returns (also through either arm
      of a ternary, either side of `&&`, `||`, `??` or a comma);
    - anything the file assigns to.

    A function handed to such a callee counts for nothing, and so does one handed to a same-file wrapper handler or to
    a wrapper nested in one. The scan can read that code, but it does not follow a function through a parameter, so
    it could neither trust nor check what `async function run(fn) { fn() }` does with `fn`.
    - Rejected: binding arguments to parameters and following them. Done soundly, that needs a binding environment
      per call site (bindings merged across call sites credit a floating site through an awaited one). That is too
      much new machinery in a security gate for a shape no route uses.
    - An imported wrapper stays trusted, as before. Its code is out of sight either way.

- **A `try` whose `catch` can do anything but rethrow swallows the denial.** That covers a catch that falls through,
  returns, or leaves by `break` or `continue`. A `finally` that can leave in the throw's place also swallows it. A
  promise the `try` returns (`return p`) is not caught; `return await p` throws inside it.
    - Rejected: leaving `try` alone, the first draft. `try { authorize(…) } catch (e) { log(e) }` passed.
    - Rejected: crediting a catch that returns. A handler's `catch { return new Response(…) }` might answer 403 or 200,
      and the scan cannot read which. An async helper's `catch { return }` resolves, and the handler goes on.
      `withPortErrors` or a rethrow is the shape to write.
    - No route in either app or the fixture has a `try` around `authorize`.
- **`settledBy` passes through the left of `||` and `??`.** A promise is truthy and never nullish, so it is their
  value. It does not pass through the left of `&&`.
- **Fail closed on chains, stored promises and `Promise.all`.** `await check().then(…)`, `const p = check(); …;
await p` and `await Promise.all(ids.map(async …))` do carry a rejection. The scan does not follow a chain, a
  variable or `Promise.all`'s array, and a stored promise lets the handler mutate before the await. All three fail;
  `await check()`, or a `for … of` that awaits each, is the shape to write.
- **Gate calls are unchanged.** `calls` (`auth.updateProfile`, `auth.setActiveOrg`) still counts an unawaited call,
  because there the call is the mutation the port guards: a rejected one mutated nothing. A gate proves the kind of
  route, not that it waits.
- **No route in either app or the fixture changes verdict.** Every one authorizes in its body, or in a wrapper it
  returns. The real trees were scanned after each round.

## Licence scan: a pnpm-native CI job, not a required check (2026-11-18, `ci/licence-scan`)

The Canopy survey deferred a licence scan ("Trivy or equivalent"), and P14 is about to put SSSB's packages on public
npm, so what an adopter inherits through them matters now. The question was whether a licence gate catches anything
real at a cost worth a check. It does, and it earns a job. JP's standing rule applied: decided here, not asked.

- **What the survey found, today.** `pnpm licenses list --json` over the workspace less the showcase: 763 packages,
  of which 745 are MIT, Apache-2.0, ISC or BSD, and the rest is a short list worth knowing: `sentry` 0.49.0 (**FSL-1.1-Apache-2.0**,
  source-available, with a competing-use restriction), which `@sentry/bundler-plugins` depends on, so it
  arrives with `@sentry/nextjs`, one of the kit's own dependencies; `@img/sharp-libvips-*` (**LGPL-3.0-or-later**), `next`'s image
  library as a shared native library; `lightningcss` and its platform binaries, and `axe-core` (**MPL-2.0**);
  `caniuse-lite` (CC-BY-4.0, data); and BlueOak, Python-2.0, Unlicense, CC0 and `(MIT OR CC0-1.0)`, which are permissive.
  Over the whole workspace there is also `only` (**no licence declared**), a dependency of Koa under the showcase's
  component workshop, which is why the showcase is out of scope. None of the first group is a defect; each is a fact
  an adopter's legal review would want and nobody had written down, and the FSL one is invisible from a dependency list
  (it is two hops below a package the kit names). That is the case for the job. The probe below also met
  `parse-cache-control` declaring `BSD`, which is not an SPDX identifier: a registry's loose strings are noise the
  policy must be able to except, not a reason to loosen it.
- **The tool is `pnpm licenses`, run by `scripts/licence-scan.mjs`, judged against `.github/licence-policy.json`.**
  No new binary, action or package to pin or trust, no network beyond the install CI does anyway, and the scan takes about a
  second. The policy is an allowlist of SPDX identifiers (an `OR` expression needs one side, an `AND` both) plus named
  exceptions, each naming the package and the licence it carries today (so a bump that changes the licence fails
  again) and a reason. An exception that matches no installed package fails too, unless marked `platform`, so the
  ledger cannot rot. Weak copyleft (MPL, LGPL), source-available and data licences are exceptions with reasons, never
  in `allowed`: a new one is a decision for review.
- **Scope: every workspace project but the showcase**, which is a superset of what ships: the published packages with
  their dev and peer-installed tools, the starter that `@sssb/create` copies, and the workspace root whose tools the generated
  root repeats. A superset, because reading the exact closure of each published package (`--prod` per project) would
  miss the starter's and the root's dev tools, which an adopter inherits too, and a dev-only copyleft tool
  is still a fact to tell them. The cost is that a repo-only tool (Changesets, jscpd) is held to the same list;
  none is a problem today.
- **A job of its own in `checks.yml` (`licence-scan`), not a step of `repo-checks`**, so a licence failure is a red
  check named for it and does not hide in a bigger one; and not a step of the reusable `app-checks.yml`, which every
  adopter calls: an adopter's own dependencies are theirs to judge, and what SSSB hands them is judged here. The script is
  dependency-free, so an adopter who wants the same gate can copy it and a policy (a recipe if one asks).
- **Not a required check, by instruction, and what that means.** Making it required is a ruleset change, which is JP's:
  add the status check `licence-scan` to the required checks of the rulesets on `main` and `integration` (and on any
  integration branch of the day, `int-p14` now). Until then a red `licence-scan` blocks no merge. It still holds a
  _release_ back: `release.yml` waits for the whole `checks` workflow to conclude `success` on the merge commit, so a
  licence the policy fails, merged to `main`, stops the next release until it is decided. That is the right place for
  it to bite; it is stated so nobody is surprised. `tests/tooling/app-checks-workflow.test.ts` lists the job as
  advisory beside the required names, and moves to the required list with the ruleset.
- **Rejected: Trivy** (`trivy fs --scanners license`), the tool the request named. Not run here: this session could not
  fetch and run the binary (the sandbox refused the download) and Docker's daemon was down, so this is its documented
  behaviour, not a measurement. For pnpm it reads the `package.json` files under `node_modules` ("you need to download
  dependencies to `node_modules` beforehand", trivy.dev/latest/docs/coverage/language/nodejs/), the same data `pnpm
licenses` reads, so it needs the same install; what it would add is Google's licence classification mapped to
  severities (trivy.dev/latest/docs/scanner/license/), and what it would cost is a downloaded binary or an action to pin and
  keep current (the repository already pins gitleaks that way), and no place in the repository to record WHY a licence was
  accepted, which the policy file is for. Both pages were read on 2026-11-18. Revisit if the gate should also cover container images, which this project has none of.
- **Rejected: `license-checker` and its forks.** Not evaluated beyond this: it would be a new dependency to keep
  current for the data `pnpm licenses` already gives, and the policy and exception work would still be ours to write.
- **Rejected: the exact production closure only.** See scope.
- **Rejected: a step in `repo-checks`.** That job is required, so the step would have made the licence scan a required
  check by the back door, which is the ruleset change JP keeps.
- **A limit, stated:** `pnpm licenses` sees what this machine installed, so a per-platform native package is judged on the
  platform that runs the scan (CI is Linux; a local run on macOS sees the `darwin` binaries, which the `platform`
  exceptions cover by prefix). A licence that exists only on a platform CI does not run is not seen.
- **Seen red.** The scan was run over the real install: with `ffmpeg-static` (GPL-3.0-or-later) added to the root's
  dev dependencies it failed naming it (and `parse-cache-control`, `BSD`), and passed again once the manifest and
  lockfile were restored; with the `sentry` exception removed from a copy of the policy it failed naming `sentry@0.49.0`;
  with an exception for a package that is not installed added, it failed naming the stale entry.
  `tests/tooling/licence-scan.test.ts` holds the same cases against fixed reports, with the expression grammar.

## P14 review: what the rounds changed, and corrections to the entries above (2026-11-18, `release/p14-first-npm-release`)

- **Review round 1 (Opus code, Fable "can anything reach npm early").** Fable found no way through, and three LOWs
  that are now closed: the own-tree test pins the next release to exactly 0.2.0 until `docs/releases/v0.2.0.md`
  exists (a hand-edited manifest version would otherwise plan another); `release-reach.test.ts` holds every step of
  `plan`, `push`, `pack` and `publish` to no `continue-on-error`, no `|| true` and no `if:` but on artifact uploads,
  and each gate's answer to being required; and it counts `secrets: inherit`, `secrets['X']` and a publish through a
  `uses:` action. Opus found that the rehearsal would cut `main`'s latest release again on a PR into a base behind
  `main` (`integration` before its sync): it now rehearses this commit with `origin/main` merged in, locally, and says
  "not rehearsed" when they conflict. Rejected: filtering the job to PRs into `main` and `int-*`, which leaves a
  stale base unrehearsed. Also from it: the checker is copied before `prepare` runs; the database's network
  (`AWS::EC2::VPC`, `Subnet`, `SecurityGroup`) joins the logical-id snapshot, since a new one means moving a subnet
  group RDS refuses to move; and a test holds every `need('X')` in `createRealPorts` to the required environment,
  which the snapshot alone did not see. Each new assertion was seen red.
- **Corrections, from the claim check** (the entries above stay as written):
    - "P14": `prepare` would not refuse a planned 0.1.0 "as going backwards". Its floors are the latest plain `v*` tag
      (none yet) and npm's `latest` (0.0.0). What stops a hand-edited version is the own-tree pin in
      `tests/tooling/release-pre-mode.test.ts`.
    - "P14": the rehearsal does not fail a release that would publish a candidate. A candidate plan ends the step,
      green, with a summary line, before anything is packed. npm 11.21.2 does refuse a prerelease without `--tag`,
      measured again, but the rehearsal never asks it. Out of pre mode `check` refuses a public group in pre mode,
      so no candidate is planned.
    - "Release snapshots": the four shapes no longer hold "the same six resources". With the network counted, each
      pg shape holds 14 and each data-api shape 10, and the sets differ: pg has the migrator's and the server's
      security groups and the public and private subnets, data-api the database subnets. The rejected "including
      the network" is reversed by the review bullet above. The subnet-group reason is confirmed: `DBSubnetGroupName`
      on `AWS::RDS::DBCluster` is "Update requires: Replacement"
      (docs.aws.amazon.com/AWSCloudFormation/latest/TemplateReference/aws-resource-rds-dbcluster.html).
    - "Release snapshots": the snapshot gate's exemptions also include a PR opened before the gate's cutover, since
      that early exit runs first (`.github/scripts/require-changeset.sh`).

## Adoption wording review, and `apps/<app>/` kept for a one-app workspace (2026-11-18, `docs/adoption-review`)

At JP's request: reword the README's "not a library" section, sweep the wording an adopter or evaluator meets, and
judge whether adoption is as simple as it can be (`docs/adoption-review-2026-11.md`).

- **"The template" now names only the generator's template, `apps/starter`.** Across the doctrine docs it meant SSSB
  itself, a fork-era usage that reads as "what `apps/starter` carries" now that the generator has a template. The
  section `docs/development-approach.md` and four other docs cite is "What SSSB ships"; `docs/app-coverage-gaps.md`'s
  "template/instance doctrine" is "What SSSB ships, and what an instance builds". "Instance" for an adopter's product
  stays: it was never misleading. Rejected: keeping the old heading for its citations' sake, which keeps the
  ambiguity; ADR-0014's body cites the old heading and stays as written.
- **README: "It is a framework you start from, not a library you add."** The manager's wording, with the packages
  named and "writes a workspace that carries" for "hands you". Rejected: keeping "not a library", which is false of
  `@sssb/kit`.
- **SSSB's cutover checklist says it is SSSB's own** and the worked reference, not "your instance's": a generated
  workspace writes its own.
- **The changeset README's "Known gaps" no longer describes adoption as a fork.** It names the two things adopters
  receive that the changeset gate does not see: the reusable workflow and the generator's `ROOT_FILES`.
- **The generated README links SSSB's adoption guide and the showcase at the pinned commit**, and the generator's
  printed next steps end with what `pnpm dev` does. `tests/tooling/create-generate.test.ts` allows exactly those
  links in `README.md` (each a line of its own, at a 40-character commit) past its "no survivor of SSSB's repository"
  check, and holds each linked path to one SSSB's repository has. Rejected: naming SSSB's repository only through the
  packages' `repository` field, as `SECURITY.md` does, which gives a newcomer no link to click.
- **`docs/adopting.md` opens with a five-step reading path, and "Trying an unreleased commit of SSSB" moved under
  "Changing SSSB itself"**, out of the newcomer's way. Its "First boot" no longer says the Simulator drives a generated
  app's `pnpm dev`: the server-side panel is the showcase's alone. Rejected for this PR: splitting the guide into a
  short guide and a reference (`.claude/future-tasks/adopting-guide-split.md`), a larger diff that deserves its own
  review.
- **A one-app workspace keeps its app under `apps/<app>/`** (ADR-0007 stands), explained in one sentence in the
  generated README, SSSB's README and `docs/adopting.md`. Rejected, as proposals for JP: the app at the workspace root,
  and the workspace with its app at `app/`. Both make every tool carry a second layout for good, since pages (a
  workspace with an app and packages of its own) stays on `apps/`, for a one-segment gain the root scripts already
  hide. The review doc has the table.
- **Review round (Opus code, Opus newcomer, Fable on the review doc).** The code reviewer found no defect and three
  test gaps, all closed: the README's links are held to a `--workflow-ref` override, to paths that exist at the
  pinned commit rather than in the working tree, and, past the survivor check, to the exact link text the generator
  writes. The newcomer found the app guide's two worked examples (`1001_items.ts`, the items route) were the files
  the adoption guide says to delete: the guide now says where to read them once removed. Rejected: describing the
  patterns in the guide itself, which makes the guide a second copy of code it should point at. Also fixed from that
  walk: the generated app's "template" copy and `TEMPLATE-UPDATE-ME` tags (now `UPDATE-ME`, named in the generated
  README), the `scheduled-tick` row's "both example apps", a misnamed section, the stale "until SSSB's first npm
  release", and the migration number for a first table. Fable found the review overstated the alternatives' tool
  costs (the CLI already treats a non-`apps/` layout as first-class) and leaned on pages as decisive; the layout
  section now answers ADR-0007's own "for a product, root is right" with the three-package argument, weighs a fixed
  `apps/web/`, a layout flag and a symlink, and pairs the recommendation with `sssb add-app`. The guide's stamped copy
  stays, on ADR-0014 part 9's trust decision; deriving both pins from the kit on upgrade is a follow-up.

## Every release's notes carry a standing "Upgrading to this release" section (2026-11-18, `feat/release-notes-upgrade-section`)

Pages, taking v0.2.0-rc.2, hit three steps the notes did not list: `sssb doctor` failed until `sssb guide` was rerun, the
reusable-workflow pin and the plugin pin had to move to the release commit, and knip flagged three AWS SDK packages the
app no longer used after it switched to `createS3Storage`. The first two are what every upgrade takes, so they are now
a section of every release's notes, written by `upgradeSection` in `scripts/release-notes.mjs`; the third is a step in
that section too.

- **The section is generated, not a changeset.** It is the first `##` section of the notes, ahead of the entries (an
  adopter does it first), with the version filled in: move the `@sssb/*` packages (from npm for a plain release, by
  tarball URL for a candidate), `pnpm exec sssb guide`, both pins, apply the entries and `pnpm knip`, then `sssb doctor`
  and `pnpm verify`. `assembleNotes` adds it whenever it is given a version, so `prepare`'s notes, `--since` notes and
  `--at --version` regenerations all carry it, and `pnpm release:notes` with no version (a preview) does not. Rejected: a
  changeset for it, which only the release that carried it would show, and an entry in each release's `docs/adopting.md`
  alone, which an adopter reading the notes would not see. `docs/adopting.md`'s "Upgrading by release" now points at the
  section and keeps the reasons.
- **How it names the release commit.** The notes are a file in the release commit, so `prepare` cannot know its SHA, and
  `verify-release` accepts only the staged patch it plans. A plain release's section therefore has the pins as
  `<sha>` and the one command that reads it off the release's tag
  (`git ls-remote https://github.com/safeinsights/sssb 'refs/tags/vX.Y.Z' 'refs/tags/vX.Y.Z^{}' | tail -n 1 | cut -f 1`,
  which prints the peeled commit when a tag is annotated and the commit when it is lightweight, as release.yml's
  `git tag "v$VERSION"` makes it; run against v0.2.0-rc.2 it printed the commit `git rev-parse` gives). A candidate's
  prerelease notes are written by `release.mjs candidate-notes` on the tag, with the SHA in hand, and it writes the SHA
  into the section (`withUpgradeSection` replaces it, or inserts it into a file that has none). Rejected: pinning the
  tag, which `sssb doctor` reports as differing ("a branch or tag, not a commit"), a follow-up commit that edits the
  file with its own SHA (the notes of a release would then differ from the file at its tag), and leaving the SHA to
  `sssb doctor`, which prints it only beside a pin that already differs. A test drops the section's own yaml and json
  blocks into a workspace and runs doctor's `pinReport` on them: `ok` with the SHA, a report with the tag.
- **The knip step is general, not a second changeset.** After an adopter deletes what an entry's "Now deletable"
  describes, a vendor SDK its `package.json` listed only for that code is flagged, because the kit's adapter that
  replaces it depends on the SDK itself (`@aws-sdk/client-s3`, `s3-presigned-post`, `s3-request-presigner` are kit
  dependencies). That holds for any release that publishes an adapter, so it is a step of the standing section (and of
  "Upgrading by release", step 5) with `@aws-sdk/client-s3` as the example. Rejected: a new changeset beside
  `kit-s3-storage-factory`, which would name the S3 case and leave the next one unlisted; and an edit to that changeset,
  which an earlier candidate already carried (`.changeset/README.md`: a name is never reused, a file is edited only to
  correct it).
- **`candidateNotes` stays synchronous** and loads `release-notes.mjs` with `createRequire` (Node 24 requires an ES
  module). Rejected: a static import, which breaks the `push` and `publish` jobs' lone copy of `release.mjs` (it is
  loaded in `candidateNotes` alone, and `candidate-notes` runs on a full checkout), and an `async` `candidateNotes`,
  which `pack-and-consume`'s synchronous `step()` and every caller would follow.
- **The repository is `safeinsights/sssb` by default.** `upgradeSection` takes `repo` (`candidateNotes` passes the one it
  is given); `prepare` does not, since the notes tool takes no environment. Rejected: reading it from the kit's
  `repository` field, which would make a dependency-free module read manifests for one string.
- **Ranges.** The package step shows `^<version>`, as `@sssb/create` writes them, not an exact version: `sssb doctor`
  checks that the packages resolve to one version, which a range over one release line does.

## A production stack keeps its database secret (2026-11-18, `fix/cdk-retain-db-secret`)

Closes the "Noticed, not changed" bullet in the snapshot entry above (the cluster's `DbSecret…` synthesizing with
`DeletionPolicy: Delete` in production). JP decided it is fixed before 0.2.0 ships.

- **The secret takes the cluster's removal policy: `Retain` for both policies in production, `Delete` otherwise.**
  Deleting or replacing a production stack kept the cluster and dropped the only credentials to it. A synth comparison
  of the pg and data-api stacks, production and not, before and after, differs in exactly two lines: the production
  secret's `DeletionPolicy` and `UpdateReplacePolicy`. The two non-production templates are byte-identical. The logical
  id (`DbSecretCF6D79B0`) is unchanged, so the snapshot is too (the secret was already in it, by type), and the changeset
  is a `patch`, not the snapshot's `minor`.
- **The policy goes on the underlying `CfnSecret`, found in the cluster's subtree.** `DatabaseCluster.secret` is the
  `SecretTargetAttachment` CDK returns from `secret.attach`, not the `Secret`: the first attempt, `applyRemovalPolicy`
  on `db.secret`, retained the attachment and left the secret on `Delete`, and the new test caught it. The construct
  throws if the cluster does not own exactly one `CfnSecret`, so a CDK change that moves it fails the synth rather than
  quietly dropping the policy.
- **Nothing else needs it.** There is no KMS key (the cluster uses the account's AWS-managed key, the secret the
  AWS-managed `aws/secretsmanager` key, the buckets S3's own) and no rotation schedule; a test pins both
  as absent on both shapes, so one added later is a decision made then. The secret's attachment stays `Delete`: its
  synthesized properties are the secret, the cluster and the target type, and the username and password are the secret's
  own `GenerateSecretString`. Not exercised against AWS (no live calls): whether deleting the attachment while the secret
  stays also strips the connection details (host, port) the attachment adds to the secret's value is not known here, and
  the credentials survive either way.
- **Rejected: leaving the secret `Delete`.** It keeps the database and discards its credentials: the operator has a
  cluster they can only reach by resetting its master password. **Rejected:
  retaining it in every stage.** A non-production stack is meant to disappear whole (`removalPolicy` DESTROY on the
  cluster and the buckets), and a retained secret per torn-down staging stack is an orphan that costs money and names a
  cluster that no longer exists.
- **Rejected: a fixed secret name.** It would make a redeploy after a teardown collide with the retained secret. CDK's
  generated name does not, so the retained one is simply left for the operator to delete (the changeset says so).
- **Corrections, from the claim check** (the bullets above stay as written):
    - "'The template' now names only the generator's template": true of the doctrine docs once `SECURITY.md`,
      `.claude/commands/new-kit-port.md` and the issue templates were swept too, which the claim check found still
      saying it (two cited the old heading). Five open future tasks keep "an app derived from this template" in their
      "Found by" line, as provenance.
    - "four other docs cite" the section: seven do (README, CONTRIBUTING, CLAUDE.md, docs/README and three recipes),
      plus the two the sweep above reached.
    - "names the two things adopters receive that the changeset gate does not see": there are more. The generator
      also reads the root's dependency ranges and engines, `pnpm-workspace.yaml`'s build approvals and release age,
      and the gitleaks version from this repository when it is packed (`TemplateMeta` in
      `packages/create/src/template.js`); `.changeset/README.md` and `require-changeset.sh`'s header now say so.

## The Simulator on a generated app's `pnpm dev`, stage 1 (2026-11-18, `feat/simulator-on-app-dev`)

Adoption follow-up 6 (`docs/adoption-review-2026-11.md`): the panel's server side ships from `@sssb/kit` behind one
catch-all route, starting with People, Mail and Jobs with the world clock. JP's standing rule for these sessions: decide,
record the rejected alternative here, report it.

- **One handler, one route file, and no change to the authorization scan.** `@sssb/kit/server-lib/simulator-api`
  exports `simulatorApi(request, context)`, which dispatches on the catch-all's segments through a fixed table
  (`Object.hasOwn`, so `constructor` is a 404, not a prototype key). The app's `src/app/api/simulator/[...path]/route.ts`
  opens each verb with `if (!isSimulated) return new Response(null, { status: 404 })` and `import()`s the kit's handler
  only after it. That first line is exactly the gate the existing `simulator/` prefix exemption already checks
  (`opens-with-simulated-404`, `packages/kit/src/authz/route-policy.ts`), so the scan accepts the file with no new
  exemption, no new gate kind and no new entry in the framework's policy; the probe that removed the line from POST
  failed the starter's `authz-mutations` check. **Rejected: `export { simulatorApi as GET, simulatorApi as POST } from
'@sssb/kit/server-lib/simulator-api'`**, a true one-line mount. It passes the scan as it stands: the scan follows a
  re-export to the function that defines the handler and checks the gate there (a probe re-exporting an ungated POST
  under `simulator/` failed `authz-mutations`; re-exporting `simulatorApi`, which opens with the gate, passed). It was
  rejected for two other reasons: it loads the kit's module in every build, real ones included, and the route's
  exemption would rest on the scan resolving into the installed package, which was proven here only against the
  workspace link, never against `@sssb/kit` installed from npm. The gate in the app's own file holds however the
  package resolves. Two five-line handlers are its price. **Rejected: a handler factory taking
  options** (`createSimulatorApi({ … })`): stage 1 has nothing an app would configure, and a factory call at module
  scope is code that runs in a real build before any gate.
- **The kit's handler gates itself too, and a real build never loads it.** `simulatorApi` repeats the simulated-mode
  404 as its own first line (a test runs it with `isSimulated` false; a probe that removed it went red), and the route
  imports it dynamically after the gate, so a real build never loads the module. (The fake adapters it calls are in
  every build regardless: the adapter registry, `packages/kit/src/adapters/index.ts:11-17`, imports them statically.)
  The showcase's route files import their handlers' modules statically; that stays as it was.
- **Every POST must be `application/json`, or 415 before it runs.** The showcase asks this only of the ticker. Here the
  same handler signs a browser in as anyone (`viewpoint`) and empties the mail catch-store, and a page on another
  origin can send a no-preflight `text/plain` POST to a developer's localhost or a hosted simulated demo. The host
  always sends JSON, so the rule costs nothing. **Rejected: matching the showcase's routes exactly**, which would have
  made the kit's version the weaker of two copies. A known path with the wrong method is 405 with `Allow`; an unknown
  one 404, so an app's own `api/simulator/<name>/route.ts` beside the catch-all keeps working (Next routes the static
  segment first).
- **The client is the kit's too: `@sssb/kit/components/simulator/simulator-host`, rendered by the starter's locale
  layout** through the same simulated-only dynamic import the showcase uses for its glue. Without it the route has no
  caller, and a generated app would need the glue this task exists to remove. It is the showcase glue's People, Mail
  and Jobs half (polling, notices, mail scope, clock), about 330 lines against 867. **Rejected: shipping the route
  alone in stage 1** and the client in a later stage: nothing would prove the route on an app's own server, and the
  brief's "first tabs that make the case" need a panel to make it.
- **The panel shows only the tabs its host wires.** `SimulatorPanel`'s per-tab props (everything but People) are
  optional, and a tab without its props is not in the strip, as Tours already worked. A persisted tab the host does not
  show falls back to People. The showcase and the static demo pass every prop, so nothing changes for them.
  **Rejected: passing empty data for the unserved tabs**, which shows Hooks, Events and Snapshots tabs that never fill
  and buttons that call paths the host does not serve.
- **The stage-1 tabs: People, Mail (outbound catch-store only), Jobs with schedules and the world clock.** Ten of the
  showcase's 33 route files. Left for later stages, one future task each: Snapshots, presets and tours
  (`.claude/future-tasks/simulator-host-stage-2-world-state.md`); Events, Messages, inbound mail, Hooks and Errors
  (`…-stage-3-subsystem-tabs.md`); the dev ticker and app-registered tabs such as Actors (`…-stage-4-ticker-and-app-tabs.md`);
  the showcase onto the kit's host (`…-stage-5-showcase-migration.md`). **The dev ticker is not in stage 1** although it
  sits on the Jobs tab: its policy module builds on `@sssb/tools`, which `@sssb/kit` does not depend on, and its origin
  is the app's port slot. That is a package-graph decision of its own (stage 4). The clock's advance, reset and
  run-due are in.
- **The showcase keeps its own glue for now.** It uses every tab; migrating it means stages 2 to 4 first, or mounting
  the catch-all beside 23 of its route files while keeping its glue anyway. **Rejected: migrating the showcase in
  stage 1.** Until stage 5 the kit's host has one consumer, the starter (and every generated app), plus the kit's own
  unit test against the fixture seam and the starter's e2e spec, which the adoption probe runs in a generated workspace.
- **`viewpoint` refuses a person who is not in the world** (400 `unknown person`), where the showcase's route lets
  `devSignIn` throw its `ForbiddenError` (a 403). The other differences from the showcase's routes came from review
  (next bullet); otherwise every path answers what the showcase's route answers, field for field.
- **Hardening from review** (an Opus and a Fable reviewer; simulated worlds only, nothing reachable in a real build):
  `viewpoint` answers a remembered `lastPath` only when it is a path on this origin, because it is recorded from a
  page-view beacon's body and the client navigates to it; `mail/seen` accepts only someone in the world, since the key
  is written to the state file every poll reads; and the clock stops at a century ahead in all (a year per call was
  already the cap, but repeated calls could leave the range a `Date` holds). On the client, every navigation the host
  makes (`viewpoint`'s answer, a mail link, a locale switch) goes through one check, `sameOriginPath`
  (`packages/kit/src/core/same-origin-path.ts`, internal), which parses the target rather than testing a prefix:
  `/\host`, a tab inside the path and `/.//host` all read as another origin to a browser. Overlapping poll answers are
  applied in order (a ticket per fetch), and a mail answer for a scope no longer shown is dropped. **Rejected: two
  copies of the check, one per side**: the first round had them, and the second found the client's mail links still on
  the old prefix test.
- **The starter's e2e budget grows by one spec** (`apps/starter/tests/e2e/simulator.spec.ts`): signed out, open the
  panel, become a person in the other tenant, see Mail and Jobs and not Hooks, run what is due. It is what makes the
  mount a gate in every generated workspace.

## Small starter fixes: a paged items list, the eslint 10 peers, an empty `AppSubjectFields` (2026-11-18, `fix/starter-small-fixes`)

Adoption follow-up 9 (`docs/adoption-review-2026-11.md`, ranked item 9 and "What surprised" 2 and 9). Decided without
asking JP, as his standing rule for these sessions says.

- **The starter's items route pages like the showcase's tickets route.** `GET /api/items` parses `?cursor=` with
  `parseDbKeysetCursor` (400 `invalid-cursor`), clamps `?limit=` with `clampKeysetLimit` (the primitive's default of
  20, since the starter has no page-size constant of its own), and the query is `listItems` in `src/domain/db/items.ts`,
  ordered by the primitive's fixed `created_at`, `id`. The response gains `nextCursor`. The card shows "Show older
  items" and the glue appends. The static demo twin holds every item in memory and stays unpaged: `hasMore` defaults to
  false, and a twin with a handful of in-memory rows teaches nothing a cursor chain would.
    - **Rejected: leave the query in the route.** The RLS proofs must drive the production read path, and a route file
      exports nothing a proof can import. A new `domain/db/` directory costs the adopter one file, and it is where
      `/sssb:new-slice` already tells them to put a table's queries.
    - **Rejected: edit `1001_items` to carry the index.** An applied migration is a record, and pages (the first
      adopter) copied the starter on 0.2.0 and has run it. `1002_items_keyset_index` is the shape of the change an
      adopter makes later, a list that grew on a table that exists.
    - **Rejected: a `limit` constant and a visible page-size control.** The default of 20 is enough for an example, the
      e2e creates 22 rows to cross it, and a constant is one more thing for follow-up 2 (removing the Items slice) to
      delete.
    - **Rejected: `useEffect` calling a `useCallback` loader, as the showcase's glue does.** The starter's lint has no
      suppression and an adopter copies this file, so the first page is fetched inside the effect's own promise chain
      (`react-hooks/set-state-in-effect` does not fire there) and the loader is a module-level function.
- **The eslint 10 peer warning is silenced by two `peerDependencyRules.allowedVersions` entries in the generated
  `pnpm-workspace.yaml`**, `eslint-plugin-react>eslint` and `eslint-plugin-jsx-a11y>eslint`, both `'10'`, under a comment
  that says why and when to delete them. Checked on 2026-11-18: no release of either plugin lists eslint 10 (the latest,
  7.37.5 and 6.10.2, stop at 9), so there is no version to bump to, and the preset runs both under eslint 10 in this
  repository's own CI. Reproduced in a scratch project and gone with the entries.
    - **Rejected: explain it in the README or the printed next steps.** The warning would stay on every adopter's first
      install; an adopter reads the explanation after they have already worried.
    - **Rejected: a blanket `allowedVersions: { eslint: '*' }`.** It would hide a real eslint mismatch from every other
      plugin, which is the check a peer warning exists to give.
    - **Rejected: adding the rule to this repository's own `pnpm-workspace.yaml`.** `pnpm install` here printed no
      warning in this session, though `pnpm peers check` lists the same two plugins; the entry matters to a first
      install in a generated workspace, and a second copy of the list is one more place to forget to delete.
- **`AbilitySubject` is an intersection (`@sssb/kit/core/abilities`), and the starter writes
  `export type AppSubjectFields = Record<never, never>`.** The kit's fixture does the same, so the framework's own tests
  compile the new form and the showcase (an interface with fields) compiles the old one. ADR-0012 has the addendum.
    - **Rejected: keep the interface and widen the lint rule's exemption** (`allowInterfaces: 'with-single-extends'` or a
      per-file override). It would remove the suppression from the starter by hiding the same friction in a preset an
      adopter cannot see, and the next one to write an empty interface would not be told.
    - **Rejected: also making `appNotificationCopy` optional in this change.** The framework imports it by name through
      the `@sssb/app-config/notifications` alias, which has no "absent" form a type checker accepts, so an optional
      export means a framework contract change (a default the seam falls back to) that deserves its own entry. The
      future task stays open for that half, and says so.

## Dependabot alert 82 (`minimatch`) closed by taking `typescript-eslint` 8.73 (2026-11-18, `deps/minimatch-alert-82`)

The 2026-11-17 dependency audit accepted GHSA-g3hv-75wg-m249 until the next `typescript-eslint` refresh ("Accepted:
GHSA-g3hv-75wg-m249" above), because 8.73.0, published 2026-11-16, was inside the two-day release-age window. It is
outside it now, so this is that refresh.

- **What was affected.** Of the three `minimatch` versions in `pnpm-lock.yaml`, only 10.2.6 is in the advisory's range
  (`>= 7.0.0, < 11.0.1`): 3.1.5 is below it and 11.0.8 is above the fix. `pnpm why minimatch` shows one parent for 10.2.6,
  `@typescript-eslint/typescript-estree` 8.72.2, reached through `typescript-eslint`, which the root
  `package.json` (dev) and `@sssb/eslint-plugin` (a shipped dependency) both take. The code runs only when ESLint
  parses a project; no request path reaches it, and the globs are the workspace's own configuration. So the alert was
  dev-scope for SSSB and for an adopter alike, and reachable only by a hostile glob in a lint config.
- **Fixed by raising both `typescript-eslint` ranges from `^8.72.0` to `^8.73.0`** and refreshing the lockfile
  (`pnpm update typescript-eslint -r`). 8.73.0's estree takes `minimatch` `^11.0.1`, and the lockfile no longer holds
  10.2.6 (11.0.8 and 3.1.5 remain, neither affected). No override: the fix is the parent's own range.
- **The floor in `packages/eslint-plugin` moves too, so a changeset (patch, Kind `scaffold`, Action `optional`).** The floor
  alone does not fix an adopter: `@sssb/create` also writes `typescript-eslint` into the workspace root's
  `devDependencies` at this repository's root range (`ROOT_DEV_DEPENDENCIES` in `packages/create/src/template.js`), so a
  workspace generated at 0.2.0 or earlier holds 8.72 and `minimatch` 10 through its own range, and on upgrading the plugin
  would gain a second, fixed copy beside it. The changeset therefore tells that adopter to raise its root range in the same
  change. The floor still earns its place: a workspace that lists no `typescript-eslint` of its own, and every one
  generated from now on (the generator reads the root's range), takes 8.73 or later. Raising a dependency's floor within
  the same major breaks no one.
- **`scripts/pack-and-consume/consumer-lock.yaml` was refreshed** (`pnpm pack-and-consume --update-lockfile`) because the
  root's range is part of what the generator copies into a workspace. The refresh re-resolved more than that range, all
  inside existing ranges: `@clerk/*` patch and minor releases, `minimatch` 11.0.8 → 11.0.9, two browser-data packages, and
  `@sssb/cdk`'s peer `@sssb/tools` 0.2.0-rc.1 → 0.2.0, stale since the release commit.
- **Checked against 8.73:** `docs/build-notes.md` warns to re-check the `TSImportType` `node.source` shape on a
  `typescript-eslint` other than 8.72; `tests/lint` and `packages/eslint-plugin`'s suites pass on 8.73.0.
- **Rejected: a `pnpm.overrides` entry forcing `minimatch` 11 onto 8.72's estree.** It forces a new major onto a
  parent that declared `^10.2.2`, on the strength of nothing but the advisory, and would have to be removed later; the
  parent's own release does the same without one. (The 2026-11-17 entry rejected it for the same reason.)
- **Rejected: leaving the alert open as accepted.** The accepted reason, the release-age window, no longer holds.
- **For JP.** The alert should close by itself when Dependabot rescans `int-adoption` and then `main` (the fix
  reaches `main` with the next release merge). If it is still open after that, dismiss nothing: re-read it, because
  it would then name something else. Nothing here needs a setting change.

## `sssb doctor` reports the adopter's own settings (2026-11-19, `feat/doctor-reports-settings`)

Adoption review follow-up 8 (`docs/adoption-review-2026-11.md`, "What surprised" 11): the settings only the adopter can
make are named in the README and the generated workspace, and nothing tells them they are still undone. The code is
`packages/tools/src/commands/doctor-settings.js`; `doctor.js` appends its lines after the cutover rows. Decided
without asking, as JP's standing rule for these sessions says.

- **Reported, never failed, never written.** Every line is `ok` or `report`, and the exit code does not move: the
  settings are the adopter's, in GitHub and on a machine, and a doctor that went red on a missing `gh` or a plugin
  nobody here uses would break `pnpm verify` for people who did nothing wrong. Read-only is enforced where the process
  starts: the only way out is `ghGet`, `gh api --method GET <path>`, stdin closed, prompts and update notices off,
  `GH_HOST` pinned to github.com, eight seconds a call, and a test fails if any call is not that. Rejected: failing on
  "not required" (it would be the first doctor failure that no commit of the workspace can fix).
- **Skipped when `CI` is set** (anything but empty, `0` or `false`), with one line saying so. In CI the token is the
  job's `GITHUB_TOKEN`, which cannot be relied on to read these settings (observed with a non-admin account: the
  organization's and the repository's Actions policies answer 403), so lines would read "not checked"; a CI runner
  does not normally have Claude Code, so the plugin line would be a false alarm; and the checks
  would add network calls to the gate that runs doctor on every PR (`sssb ci` and `adoption-probe` both run it).
  Rejected: running them with `GITHUB_TOKEN` (noise, not information); a flag to force them in CI (nothing needs it:
  `gh` on a laptop is where the answer is wanted).
- **The repository is the workspace's `origin` remote** (`git config --get remote.origin.url`, github.com only), not
  the kit's: the settings are the adopter's. No GitHub origin reads "not checked". Rejected: `gh repo view` (needs a
  signed-in `gh` and a network call just to learn the name, which git already holds); a field in
  `package.json` (a second copy of what git knows); a `--repo` flag (one more thing to remember).
- **"Required" looks in both places GitHub keeps it**: the rules that apply to the default branch
  (`rules/branches/<branch>`, an organization's rulesets included; read by a non-admin account with push access on
  SSSB's own repository, where it lists `sssb / all-checks`) and classic branch protection
  (`protection/required_status_checks`, which answered that account a bare 404 "Not Found"), matching the context
  `sssb / all-checks` exactly (the reusable workflow is called by a job named `sssb`). "Not required" is said only when
  the rulesets were read and branch protection was read or answered that it requires nothing (an admin's 404 "Branch not
  protected"); a protection the account may not read says "not confirmed" and names why, because "not required" would be a claim doctor cannot back.
  Rejected: rulesets only (misses every repository on classic protection); calling a
  failure to read "not required" (the most common wrong report a non-admin would see).
- **Private vulnerability reporting** is `GET repos/<r>/private-vulnerability-reporting`: `enabled: false` is `report`,
  a failure is "not checked".
- **The reusable workflow is reported only for a private repository in an organization** (the review's case), read from
  the Actions policy at both levels, the organization's and the repository's (`allowed_actions`: `all`, `local_only`,
  or `selected` with `patterns_allowed`). Each level is judged on its own and a level that cannot be read (it needs an
  admin) is named and never guessed: "no" if any readable level refuses, "yes, as far as the policies that could be
  read go" if some could not be read, "not checked" if neither could. `selected` is judged by matching the workspace's
  own `uses:` (`owner/name/.github/workflows/file@ref`) against `patterns_allowed`, with `*` as any run of characters;
  GitHub's exact wildcard rules are not published precisely enough to prove this, so it is the one approximation here,
  and the line says "none of its N pattern(s) matches", never "not allowed". Rejected: the organization level only
  (needs organization admin, which an adopter with repository admin lacks); saying "check by hand" for `selected`
  (no use to the adopter who has it right).
- **The plugin line covers every plugin the shared `.claude/settings.json` enables** (`enabledPlugins` true, or a
  non-empty constraint array), not only SSSB's: the install step is the same for any, and telling them apart would
  need the kit's repository and a marketplace walk. No enabled plugin, no line. Installed means a record in
  `<CLAUDE_CONFIG_DIR or ~/.claude>/plugins/installed_plugins.json` (`plugins["<plugin>@<marketplace>"]`) that is
  user scope, or project or local scope with a `projectPath` that is this workspace. A plugin installed only for
  another clone says so and names the path. **Assumption not verified**: this machine's record has only a user-scope
  install, so the `projectPath` field of a project-scope entry is assumed, from memory of Claude Code's format and not
  from a record or its documentation; if it differs, the line reads "not installed" for a project-scope install, which is a false
  report, never a failure, and the fix is one field name. Rejected: `claude plugin list` (starts Claude Code, slow,
  and its output is not a stable format); counting a user-scope install as not enough (it makes the plugin available
  everywhere, which is what the workspace wants).
- **A machine with no install record at all reads "not installed … ignore it when nobody here uses Claude Code"**
  rather than silence: a workspace that enables a plugin should hear that this clone lacks it, and the line names the
  one command. Rejected: skipping the line when `claude` is not on PATH (a laptop whose Claude Code lives elsewhere
  would never hear).
- **From the first review round.** Doctor never throws: each group of reports (GitHub, plugin) runs under a guard that
  turns an unreadable file or an answer shaped unlike GitHub's documents into one "not checked" line, so a root-owned
  install record cannot stop a run. The rules are read 100 to a page, because the `required_status_checks` rule can be
  on page two of the default thirty. A 404 "Required status checks not enabled" counts as "branch protection requires
  nothing", like "Branch not protected". When branch protection's own endpoint does not answer a non-admin, the branch
  (`repos/<r>/branches/<branch>`, read by the same non-admin account) is the fallback for `protected` and
  `protection.required_status_checks`: seen on SSSB's own repository as `protected: true` with
  `protection: { enabled: false, required_status_checks: { enforcement_level: 'off', contexts: [], checks: [] } }`
  (the branch is protected by a ruleset), and a shape that differs leaves "not confirmed". The organization's own reusable workflows are never held to the Actions
  policy (`local_only` and `selected` both allow them), only a call into another owner is; an enterprise-level
  `local_only` is not told apart from the organization's. The organization's `enabled_repositories: none` is "Actions
  off". An older install record with one entry per plugin, not a list, reads as a user-level install.
  **Rejected: deriving the required check's name from the workflow's calling job** (`checks / all-checks` for a job
  named `checks`): the generator writes the job `sssb`, the guide and README name `sssb / all-checks`, and an adopter who
  renamed it chose a name SSSB cannot vouch for; the report says what it looked for.
- **From the second review round** (no finding above LOW). A protected branch's answer counts as read only when it
  carries `protection.required_status_checks`, and an `enforcement_level` of `off` requires nothing; otherwise the line
  is "not confirmed", never "it is not". A rulesets answer that is not a list is unread. An organization with Actions
  enabled for selected repositories, or a `selected` list with a blocking `!` pattern, is not judged: the line says it
  was not read or evaluated. A `managed`-scope install counts for every workspace. **Accepted, not changed:** a local
  `pnpm verify` (where `CI` is not set) now makes up to nine `gh` calls against this repository's own `origin`, and a
  doctor e2e that does not set `CI` reads the developer's Claude config folder: neither can fail a run, and a time
  budget or an in-repo skip would be a second mechanism for a cost of about a second. `sha_pinning_required` is not
  modelled. `githubRepositoryOf` (shared with the pin report) keeps its unanchored host match: tightening it changes
  the pin report too, and a look-alike origin only changes which repository doctor reads, by GET.

## A hosted showcase demo on each release (2026-11-18, `feat/hosted-showcase-demo`)

Adoption follow-up 4 (`docs/adoption-review-2026-11.md`): an evaluator should see the Simulator without cloning SSSB.
JP's standing rule for these sessions is to decide and record; each choice below is one he would otherwise have been
asked. **This makes a new outward artifact**: from the first release after 0.2.0, every plain release's tag makes a
public GitHub release of `safeinsights/sssb`, marked Latest while it is the newest, holding its notes and
`sssb-showcase.html`. Nothing about what or when anything publishes to npm changes.

- **A GitHub release asset, made by release.yml for every plain release.** Two jobs, `demo` and `github-release`,
  split as the candidate's `candidate` and `prerelease` are (the one that reads holds no write token and runs no
  dependency's code; the one that writes holds only `contents: write`, checks out nothing and installs nothing).
  Rejected: **GitHub Pages**, which needs Pages enabled (a repository setting, JP's) and whose `actions/deploy-pages`
  needs `id-token: write`, which `tests/tooling/release-reach.test.ts` holds to `publish` and `attest` alone; a second
  id-token holder in the release workflow is a worse trade than a download. Rejected: **a third-party HTML preview
  service** pointed at the asset or the repository, which would serve SSSB's page from someone else's domain.
- **The new jobs need `pack`, and nothing needs them; `publish` is untouched.** They run only for a plain tag on `main`
  once `checks` passed on it (`pack`'s gates), beside `publish`. Rejected: **steps in `pack`**, which would let a demo
  problem stop an npm publish, a change to when npm publishes. Rejected: **needing `publish`**, so the page appears only
  once npm has the version: it would tie the page to npm's outcome, and the task forbade anything downstream of
  `publish`. The consequence, accepted: if `publish` fails, the tag's GitHub release is still made; re-running
  `publish` finishes npm, and the page's notes are true of the tag either way.
- **"A release whose demo does not build fails before it publishes" is the CI gate's job.** `checks`' demo-static job
  builds the showcase's demo, holds it to its budget and drives it from `file://`; `pack` waits for `checks` to pass on
  the release commit. The new jobs add no failure mode on the way to npm.
- **The attached file is the one CI tested**, the `static-demo-showcase` artifact app-checks.yml's demo-static job
  uploads, fetched from the checks run on the release commit (`release.mjs checks-run`, as a candidate fetches its
  tarballs) and checked again (`release.mjs demo`: the asset's name, an HTML document, within the showcase's
  `check:demo-size` budget). Rejected: **building it again in the release run**, which would install dependencies in
  the tag's run for a file CI never drove. The artifact's 14-day retention bounds a re-run, which is days, not weeks.
- **The asset is `sssb-showcase.html` in every release, not `sssb-showcase-<version>.html`** as the future task
  sketched: `releases/latest/download/<name>` needs one name, and the release page says the version. Rejected:
  **attaching both names**, two copies of one file. The newest release is marked Latest (candidates stay never-Latest),
  which is what makes that URL the newest release's.
- **The README links `releases/latest/download/sssb-showcase.html` and says every release after 0.2.0 carries it**,
  so the link reads true before and after the next release; until it, the link answers 404 and the same sentence names
  `pnpm build:demo-static`. Rejected: **backfilling a 0.2.0 GitHub release** by hand, an outward artifact this task was
  not given to make.
- **No changeset.** It touches nothing an adopter receives (`scripts/`, `.github/`, `tests/`, docs), as the future task
  said; `changeset-required` sees no shipped path.
- **Latest only while the tag is the highest plain release tag** (`gh api …/git/matching-refs/tags/v`, compared
  numerically, candidates ignored), from the round-1 review: a re-run of an older tag's job, or two tags' runs
  finishing out of order, would otherwise move Latest, and the README's link, back to an older demo. Rejected: always
  `--latest`, and leaving it to GitHub, whose default for a newly published release is also Latest.
- **No page for a tag that publishes nothing**: `demo` takes `publish`'s own condition,
  `needs.pack.outputs.count != '0'`, so the page and npm agree on whether a version exists. Unreachable while the group
  is public; it costs one line.
- **The fake `gh` the prerelease job's test used moved to `tests/support/fake-gh-release.ts`**, shared with the new
  job's test, and reads a boolean flag as gh does (`--x`, `--x=true`, `--x=false`), so `--prerelease=false` and
  `--latest` are told apart.

## Real mode requires only the optional ports an app uses, and jobs can run without CodeBuild (2026-11-19, `fix/kit-optional-real-ports`)

Pages, SSSB's first adopter, prepared its first real-mode deployment and found that real mode refused to start
without LLM, Mailgun and CodeBuild settings it does not use (it filled them with a placeholder), and that SSSB's only
real job runner was CodeBuild, so its scheduled maintenance could not run through SSSB's scheduler (it ticks its own
route from a ticker Lambda instead).

- **The declaration is a switch per optional port, set by the deployment from `params.ports`**, exactly as
  `DATABASE_TRANSPORT` is set from `params.database.transport`: `LLM_PROVIDER` (`anthropic` | `none`),
  `EMAIL_PROVIDER` (`mailgun` | `none`), `INBOUND_EMAIL_PROVIDER` (`mailgun` | `none`), `JOBS_RUNNER` (`codebuild` |
  `in-process` | `none`), in `packages/kit/src/adapters/real/optional-ports.ts`; `SssbApp` sets each one `params.ports`
  names. Rejected: **a new `@sssb/app-config/*` module** declaring the ports, which every adopter's build would have
  to add before it compiled again (a seam module cannot be optional), for a choice that is a deployment's as much as
  the code's (the job runner decides what infrastructure exists); and **deriving it from what the app registers**,
  which cannot be done: the framework's own invitations and notifications send mail whatever the seam says, and an
  app's route can import `llm` from the registry with nothing registered.
- **An unset switch is today's behaviour** (every optional port on, CodeBuild the runner), so a deployment that sets
  none boots exactly as it did; `required-env.json` keeps the defaults per transport and adds, under `ports`, what each
  choice requires. Rejected: **defaulting to off**, which would boot an existing deployment with ports it uses absent.
- **Inbound email is its own switch**, not part of `email`: an app may send mail and receive none (the starter does),
  and the signing key is a separate cutover row (`email-inbound`). Without the key the inbound route refuses every
  request, as before, so turning it off fails closed.
- **`WEBHOOK_SECRET` stays required whatever the switches say.** The cron route and the jobs webhook both verify it,
  and an app with no jobs may still tick its outbound webhook deliveries. Rejected: tying it to `JOBS_RUNNER`.
- **An absent port is an object whose every call throws `AbsentPortError`**, naming the port, its switch and its
  cutover rows (`packages/kit/src/adapters/real/absent.ts`). Rejected: **leaving the registry's export undefined or
  nullable**, which would change the type of `llm`, `email` and `jobs` for every caller to serve the case that should
  never be called. `stream` throws when called, before anything is streamed.
- **The optional adapters are dynamic imports in `createRealPorts`**, as the Data API transport already was, so a port
  switched off never loads its vendor's SDK; the registry test counts the loads.
- **The CodeBuild-free runner is `JOBS_RUNNER=in-process`**: `start` runs the job's handler in the server, now, and
  records its terminal status and notifies before it returns. The executor is shared with the simulated adapter
  (`packages/kit/src/jobs/run-in-process.ts`), which ran the same steps inline. Rejected: **leaving the job queued for
  the next tick to drain**, which adds a second queue, a time budget per tick and a wait of up to a tick for a job a
  user just submitted, for the case (long work) that belongs on CodeBuild anyway. The limit, recorded where it is
  chosen: a job shares its invocation's time limit (30 seconds on `SssbApp`).
- **The default runner stays `codebuild`; the starter declares `in-process`**, with `llm: 'none'` and
  `inboundEmail: 'none'`: it has no jobs webhook route for a build to complete through, no model call and no inbound
  route, so those are what is true of it. A generated app therefore needs no build project to run its jobs.
- **The scheduled tick is `SssbApp`'s `scheduledTick: { webhookSecret, every? }`, opt-in.** An EventBridge rule
  (every five minutes by default) runs a function that reads the secret and invokes the server directly with a Function
  URL event for `/api/webhooks/cron`, which the Lambda Web Adapter serves like any request; the route stays behind
  `withWebhookSecret`. Rejected: **POSTing through CloudFront**, which today refuses an unsigned POST (the sibling fix
  `fix/cdk-function-url-post` addresses it) and would make the tick depend on that; **signing a request to the Function
  URL**, which needs a SigV4 signer the function would have to bundle (the runtime documents none to import); **an EventBridge API destination
  and connection**, which needs the secret's value at deploy time; and **on by default with a generated secret**: the
  construct never puts a secret's value in an environment (pages keeps its secrets by ARN), so the server could not know
  a secret the construct made, and every tick would be a 401.
- **The tick's function may read that one secret and invoke the server's function and its versions**, nothing else,
  runs outside any VPC (it calls AWS APIs only), and is not retried: the next tick runs on schedule, and two ticks never
  double-spawn a schedule.
- **The kit's changeset files `minor` with Action `optional`.** The snapshot changed, which the gate requires a minor
  for, but nothing an existing deployment sets becomes required: Action `required` would tell an adopter something
  breaks when nothing does.
- **Not verified live** (no AWS calls): that the Lambda Web Adapter answers a direct invocation carrying a Function URL
  event as it answers the URL, and the in-process runner on a deployed server. Both are in the `scheduled-tick` and
  `job-runner` rows' proofs.
- **From the first review round.** `sssb check-real-env` bundles `adapters/real/index` as CommonJS, and the in-process
  runner's notification imports had pulled in the adapter registry, whose top-level await esbuild refuses there:
  `dev:real` failed for every app. The registry now hands `createRealPorts` the notifier
  (`notifyJobTerminal`; replaced in round 2: the registry hands in `inProcessJobs`), so the real ports never import a
  module that imports the registry, and
  `tests/tooling/tools-check-real-env.test.ts` bundles the real framework for both apps (it had bundled only a stub).
  Rejected: bundling the preflight as ESM, which would leave the next such import to break the Next server instead.
- **A job the in-process runner loses is failed, twice over.** A handler still running after 20 seconds
  (`IN_PROCESS_DEADLINE_MS`, under `SssbApp`'s 30; removed in round 2, below) fails its job; and a new optional `JobsPort.sweep(now)`, which the
  scheduled tick calls before it drains the schedules, fails a job still `running` five minutes after its last status
  change (the invocation was cut off before it recorded anything). Optional on the port, so every other runner,
  an adopter's own included, is untouched. The tick's answer keeps its shape (the starter's route test, which adopters
  copy, pins it exactly): the failed jobs' errors say what the sweep did. Rejected: **a per-tick time budget**, which
  the runner cannot know (nothing hands it the invocation's remaining time).
- **The tick's function is not retried by Lambda either** (`configureAsyncInvoke({ retryAttempts: 0 })`: EventBridge's
  retry policy does not reach Lambda's own two retries of an asynchronous invocation), and an Errors alarm watches it,
  as the server's errors are watched.
- **A failed deferred side effect is logged in real mode**, beside its analytics event, which without a PostHog key is
  the simulated one, writing only to the server's local disk: an invitation sent with `EMAIL_PROVIDER=none` now leaves a log line saying the port is absent.
- **Left as they are, with the reason.** `JOBS_RUNNER=none` still commits a submitted or scheduled job's row before
  `start` throws, leaving it `queued`: `none` declares that the app runs no jobs, so a job reaching the port is the
  declaration being wrong, and the throw names the switch. And the framework's `digest-email` handler, which the
  in-process runner can now run in a deployment, picks recipients from the seam's seed people: a real-mode concern of
  that handler with any runner (CodeBuild would run the same handler), so it is a follow-up, not this change's.
- **Machine credentials get headers of their own, because CloudFront replaces `Authorization`.** Found in a review of
  the sibling `fix/cdk-function-url-post` and checked here against CloudFront's guide ("Restrict access to an AWS
  Lambda function URL origin"): with signing behavior `always`, which `SssbApp`'s origin access control uses, CloudFront
  signs every origin request, and the signature is the `Authorization` header; besides, `CACHING_DISABLED` leaves
  `Authorization` out of the cache key, so the viewer's header is not forwarded at all. Every webhook and service call
  through the public host would answer 401. `withWebhookSecret` now reads `x-sssb-webhook-secret` and
  `verifyServiceCaller` reads `x-sssb-service-token` (`packages/kit/src/service-auth/credential.ts`), the header winning
  when present, and every sender in SSSB sends it (`pnpm tick`, the scheduled tick, the showcase's simulated actors).
  `Authorization: Bearer` stays accepted when the header is absent: a direct invocation or `pnpm dev` keeps it, a sender
  written before this keeps working where it worked, and nothing that passed before is refused now. Rejected:
  **signing behavior `no-override`**, which passes a viewer's `Authorization` through but then needs it to be a SigV4
  signature for the Lambda URL's host, so a Bearer credential would fail Lambda's IAM check instead; **dropping
  `Authorization` at once**, which breaks direct callers for no gain; and **fixing the webhook alone**: the service token
  had the same defect in the same shape, so both moved in one change. The sibling keeps the origin access control (it
  adds a body hash at the edge), so the defect stands with it; a live POST through the host is in the `job-runner` and
  `scheduled-tick` rows' proofs.
- **From the second review round, which revises the first.**
    - **The 20-second deadline is gone.** A handler abandoned at a soft deadline keeps running in a Lambda environment
      that is frozen once the invocation returns, holding any transaction it had open (its row locks, its pooled
      connection) until a later invocation thaws it, and finishing its side effects for a job already marked failed. The
      server's own time limit ends the process instead, so the job's open transaction rolls back (at once on `pg`; on the Data API when that transaction times out, after three minutes with no call: the BeginTransaction API reference), within the sweep's five minutes), and the sweep fails the job. A per-job deadline also never bounded the invocation, whose total the runner cannot know.
    - **The sweep fails only jobs this runner claimed.** Its `running` entry carries `IN_PROCESS_CLAIM`, so a job
      another runner holds `running` (a service caller's, through its status route, or one the jobs webhook is walking
      to its end) is left to it. A CodeBuild build in flight holds its job `queued`, which the sweep never reads. It is fault-isolated per
      tenant and per job, and the tick catches a sweep that throws, as `runDueSchedules` isolates each schedule.
    - **The registry builds the in-process runner** and hands it to `createRealPorts` (`inProcessJobs`). The first
      round's fix had kept the notification modules out of `adapters/real/index`, but the runner itself runs the app's
      handlers, so an adopter whose handler reached the registry would have broken `dev:real` again;
      `packages/kit/src/adapters/real/index.test.ts` now reads esbuild's account of that module's CommonJS bundle and
      fails if it reaches the registry, `server-lib` or the seam's jobs. The hook is optional, so
      `createRealPorts()` (a published subpath) still takes no argument; choosing `in-process` without the hook fails at
      boot, naming it.
    - **Accepted, recorded:** a tick that spawns several in-process jobs runs them one after another inside one
      invocation, so a backlog can outrun the time limit (the cut-off job is swept; schedules after it wait for the next
      tick, and that tick's deliveries do too). Threading an invocation budget through the tick is a design of its own;
      in-process is for short jobs. A job whose `start` was never reached (an audit write failing between the spawn and
      the start) stays `queued`: `queued` is also a CodeBuild job's state while it builds, so the sweep cannot tell it
      lost. The sweep's per-tenant scan of `running` jobs has no index of its own; a partial index is a framework
      migration, for when a deployment's job history makes it matter.
- **From the third review round.**
    - **The registry loads the in-process runner on its first use** (`packages/kit/src/adapters/lazy-jobs.ts`), never
      during its own top-level await. Loading it loads the app's job handlers, and a handler that imports the registry
      (for `isSimulated`, as the guide says to) closes a cycle whose root is the registry, which would then wait
      forever on its own import: the hang was reproduced in plain Node ESM (exit 13, "unsettled top-level await"), and
      the lazy shape boots there. The test pins the helper (nothing loaded until the first call, one load, a failed
      load retried), not the hang.
    - **Recording a job's outcome is outside the handler's `try`.** Only the handler's own failure fails the job; a
      failure after `completed` has committed (the webhook enqueue that follows it) propagates, instead of an attempt
      to record `failed` over `completed`, which the state machine refuses. The simulated runner shares the change.
    - **The Sentry scrubber drops the two credential headers**, as it drops `authorization`. Sentry's own filter
      already masks names containing `secret` or `token`; the scrubber no longer relies on that.
    - **Phase 1 stops here, at the cap.** Round 3's one HIGH was in round 2's fix, not in the original work, and its
      LOWs were either taken above or already recorded (a job that `none` or a cut-off invocation leaves `queued`).
- **`CLERK_JWT_KEY` stays optional** (asked when `fix/kit-clerk-middleware` merged, which left it out of
  `assertRealEnv` for this change to decide). Clerk verifies a session without it, by fetching its signing keys when
  it meets a key id it has not cached; the key saves that request, and the `auth-dev` row and that change's changeset
  already recommend setting it. Rejected: **requiring it**, which would stop every deployment that boots today from
  booting, for a request it saves, and would add a required variable (a `minor` in the snapshot's terms) for no
  correctness gain.

## `SssbApp` takes request bodies, and pins the server's `HOSTNAME` (2026-11-19, `fix/cdk-function-url-post`)

Pages, the first adopter, found before its first deploy that `SssbApp`'s distribution refuses every request with a
body (its Function URL is behind an origin access control, which needs the body's hash), and that the server's
`HOSTNAME` must be `0.0.0.0`. ADR-0001's addendum of 2026-11-19 holds the hosting decision and its rejected
alternatives (no origin access control with a secret header, an ALB, API Gateway, a CloudFront Function, hashing in the
browser). JP's standing rule for these sessions is to decide and record; each choice below is one he would otherwise
have been asked.

- **An origin-request Lambda@Edge function, not viewer-request.** It runs just before CloudFront sends the request to
  the origin, and CloudFront hands it up to 1 MB of body against a viewer-request function's 40 KB. Pages chose the
  same.
- **A body over 1 MB answers 413 from the function.** Rejected: **forwarding it with the hash of the part CloudFront
  handed over**, which Lambda refuses with a 403 that names nothing. Rejected: **not setting the header**, the same 403.
- **The header is always set, a request with no body getting the empty string's hash.** Rejected: **setting it only on
  `POST`, `PUT` and `PATCH`**: a viewer's own `x-amz-content-sha256` would then reach the signer on every other method,
  and whether Lambda accepts a body on a `DELETE` would become this function's question.
- **A stack whose region is us-east-1 or unresolved keeps the function in the stack; a stack with an explicit region
  elsewhere gets CDK's `EdgeFunction`.** `EdgeFunction` refuses an environment-agnostic stack, which the starter's is
  until cutover, and `pnpm synth` must stay offline; and one construct path for both in-stack cases means naming
  us-east-1 at cutover does not replace the function (a replicated one cannot be deleted for hours). Rejected: **a
  CloudFormation rule refusing any other region** up front: CloudFormation's guide shows rules reading template
  parameters, never a pseudo parameter such as `AWS::Region`, this could not be tried without an account, and a rule
  CloudFormation refused would stop every deploy of the stack.
  CloudFront's own refusal of the association is the error instead. Its cost: that refusal comes after the database
  is created, so a production stack (retained database and buckets) deployed that way may leave them behind; the
  starter's infra README says to give the stack its `env` first.
- **`EdgeFunction`'s us-east-1 stack is one per `SssbApp` and region (`edge-<region>-<construct address>`), not CDK's
  one per parent stack.** CDK's default collides on a second `SssbApp` in one stack, and is shared by one stack deployed
  to two regions of an account. Rejected: **CDK's default name**, for those two reasons.
- **That stack carries exactly the app's tags.** CDK copies the parent's tags into it when it creates it, before any
  `Tags.of(...)` aspect has applied, and under `explicitStackTags` (`cdk init`'s default) the parent stack has no stack
  tags at all. An aspect run after every tag aspect gives each of its resources the server function's final tags, and
  the stack the parent stack's. Rejected: **asking adopters to tag at the App**, which the starter's `infra/app.ts`
  does not do and a tag policy would refuse silently until the first deploy.
- **The function's version is destroyed with the stack, not retained (CDK's default).** Its logical id carries a hash
  of the code, so a retained one would pile up on every change, and would enter the stateful-logical-ids snapshot, which
  takes any retained resource, under a name that changes with the code. The cost: a delete can fail while CloudFront
  holds replicas, recorded in the `deploy-pipeline` row.
- **The edge role's trust in `edgelambda.amazonaws.com` is CDK's.** `Distribution` adds it for every function it runs at
  the edge; the test reads it from the template rather than the construct adding a second statement.
- **`HOSTNAME=0.0.0.0` in the server's environment, not in a `run.sh` SSSB writes.** The deploy pipeline, and so its
  `run.sh`, is the adopter's (`deploy-pipeline`); the environment is the one place the construct controls. Rejected:
  **SSSB shipping the `run.sh`**, which would decide the pipeline's packaging for it.
- **The live proofs extend two existing cutover rows** (`origin-not-publicly-reachable`, `deploy-pipeline`) rather than
  adding one. A new row is a new id in `@sssb/kit/cutover/rows.json`, which `sssb doctor` reports as missing from every
  adopter's own checklist.
- **Out of scope, reported to the manager:** CloudFront sends the origin the Function URL's own host
  (`ALL_VIEWER_EXCEPT_HOST_HEADER`), so the app builds absolute URLs and redirects on the Function URL's host. Pages sets
  `x-forwarded-host` from the viewer's `Host` in a CloudFront Function of its own; one in `SssbApp` would also decide
  what becomes of a viewer's own `X-Forwarded-Host`.

## One command removes the starter's Items slice (2026-11-19, `feat/remove-starter-items`)

Adoption follow-up 2 (`docs/adoption-review-2026-11.md`, ranked item 2; `.claude/future-tasks/resolved/create-blank-option.md`).
Decided without asking, as JP's standing rule for these sessions says.

- **An `sssb` command, `sssb remove-items [--app <dir>] [--drop-migrations] [--dry-run]`, and no plugin command.** CI can run
  it, which is what makes "tested once against the starter" true: pack and consume's `generated` shape runs it on the
  generator's output and then the workspace's own gates (`pnpm verify` and the held unit and contract runs, knip, jscpd).
  Rejected: a plugin command (`/sssb:strip-starter`), an agent recipe no gate can run; a `--blank` generator flag, a second
  starter shape the gates would have to keep green (the review's own recommendation); both together, two things to keep true.
- **It applies two diffs of the starter, exactly** (`packages/tools/src/remove-items/{code,database}.patch`,
  `exact-patch.js`), not scripted edits of TypeScript. A hunk applies only where every line it names is found once, wherever
  it has moved to; nothing is fuzzed. A file the adopter edited inside a hunk, deleted, or that is not what the starter wrote
  is refused, by name, with every edit computed first and **nothing written** (a dry run is the same computation).
  Rejected: regex or AST surgery on the starter's files (the fragile part of the task, and silently wrong on an edited file);
  whole-file replacement from a checked-in blank variant (the third app in disguise that the future task warned of, and it
  overwrites an adopter's unrelated edit to `abilities.ts`); `git apply` (needs a repository, tolerates what it should refuse,
  and cannot say what it would refuse before touching anything). The starter keeps its one shape; the diffs are kept true by
  `tests/tooling/remove-items.test.ts`, which fails, naming the file, when a starter change makes one stop applying (probed:
  a hunk dropped from the patch, and a line appended to the starter's card; both red).
- **The rule for migrations: never delete one unless told.** A database records each migration it runs, and the migrator
  refuses to start when a recorded one is missing from the code (the first adopter, pages, may have deployed). Without
  `--drop-migrations` the command takes out the code and leaves `1001_items`, `1002_items_keyset_index`, `ItemsTable` and the
  `items` RLS proofs registered, which keeps every gate green. With it, they go too: for a workspace just generated, with the
  local `.data` deleted and the first table numbered `1001`. The two halves are one choice made once: the second half is
  not available after the first ran alone, because its diff is made against what the first leaves; `--drop-migrations` after
  a plain run is refused, with nothing written. Rejected: deleting the migrations by default (a deployed adopter's next
  deploy fails); detecting a deployment from the repository (nothing in a workspace says whether a database ran a migration);
  a database-only mode for later (a second command to keep true, for the one case where the adopter should be writing a
  migration of their own).
- **The result is the empty registration, proved to compile.** `AppSubjectType = never`; `appAbilityRules` keeps its four
  parameters (the framework calls it with them) and returns false; `AppTables = Record<never, never>` (an empty interface
  would trip `no-empty-object-type`, as `AppSubjectFields` did); an empty `appMigrations`; an empty proofs body, so
  `pnpm test:contract` runs only the framework's half, which the command and the guide say. Typecheck, lint, knip, the conformance suite and the
  contract runner pass on it. `DashboardScreen`'s `children` became optional for the same reason.
- **It writes no replacement e2e spec.** An app with no spec in its e2e directory fails `sssb check-e2e` and its CI shard,
  but the starter has had a second one since follow-up 6, `simulator.spec.ts` (sign in through the Simulator, its tabs),
  which names no item and stays. `tests/tooling/remove-items.test.ts` asserts it is what remains, so a change that
  removes it fails there and must give the command a spec to write. Rejected: a `dashboard.spec.ts` the command
  writes (the one file it would add to an adopter's tree, repeating the sign-in the Simulator's spec already walks;
  an earlier version of this change had it, and dropped it when the starter gained its own spec).
- **The proof is a leg of the `generated` shape in pack and consume, not a new job.** A new job is a new check name, and the
  ruleset requires its checks by name (a settings change this work may not make). The leg runs after "every file the
  generator wrote is unchanged", because removing the slice rewrites those files, and before the partial installs. It deletes the
  dev database the earlier gates created (`.data` recorded `1001_items`), which is exactly what the command tells an adopter
  to do. Rejected: a fourth shape (a second install of the same tarballs); running it in the pages shape (its ledger app's own
  migration `COMMENT`s on `items`, so removing the table would remove its premise).
- **`@sssb/tools` ships the two `.patch` files.** ADR-0014 part 2 says every package but the kit ships JavaScript; the rule's
  reason is no build step, which text read at run time does not break. `toolsShippedFileProblems` names exactly these two
  files and still fails any other. ADR-0014 has the addendum. Rejected: the diffs as JavaScript string constants (the starter's
  backticks and `${` make that unreadable and unreviewable).
- **Hunks are not anchored to the ends of a file.** A hunk with fewer than three lines of context sits at a file's start or
  end, and anchoring it there refused an adopter who had added a comment above the imports. A hunk applies when what it names
  occurs exactly once, anywhere, and a file deletion needs the file to be exactly what the starter wrote. Rejected: anchoring.
- **It also removes `.next/dev/types`, Next's dev type validator**, found by review. `next dev` writes a validator naming every
  route file, the app's tsconfig includes it, and `next typegen` (what `pnpm typecheck` runs) rewrites only `.next/types`, so an
  adopter who had run `pnpm dev` or the e2e got a TS2307 on the deleted route at their next `pnpm verify`. It is generated and
  ignored by git. The pack-and-consume leg plants such a validator and checks it is gone, and a unit test pins the same.
  Rejected: telling the adopter to delete `.next`.
- **Pack and consume runs both modes**: the default (database half kept) first, typecheck and lint only, then the app is put
  back as generated and the whole slice goes with the full gates. Rejected: the default mode with only a file-list test.
- **Known limits, accepted.** The writes are not transactional (a failing disk leaves a half-removed app; the message says
  `git restore .`). A hunk is matched on its own text, so an adopter helper appended to a file whose imports the patch
  removes fails typecheck loudly rather than silently. A CRLF checkout of an adopter's files refuses every hunk (the shipped
  patches are `eol=lf` by `.gitattributes`). Rejected: a rollback journal, and line-ending normalization, for failures that
  are loud and leave the diff in git.
- **The starter's `proxy.test.ts` (from the Clerk middleware fix) used `/items` and `/api/items` as sample paths.** They
  are only strings, but a removal that leaves "items" in `src` is not clean and the pack-and-consume leg checks for it, so
  the sample paths are now `/projects`. Rejected: teaching the command to patch a test of the proxy, and exempting the file.

## Real-mode sign-in: the kit runs Clerk's middleware around the app's proxy (2026-11-19, `fix/kit-clerk-middleware`)

The first adopter's first real-mode deployment found that SSSB's Clerk adapter (`packages/kit/src/adapters/real/auth.ts`)
calls `auth()` and `currentUser()`, which refuse a request Clerk's `clerkMiddleware` did not see, and that nothing in
SSSB ran that middleware: every real sign-in failed. The adopter wrapped its own proxy. Decided without asking, as JP's
standing rule for these sessions says.

- **A wrapper the app's `src/proxy.ts` calls, `withAuthProxy(proxy)` from `@sssb/kit/adapters/proxy`.** The app's
  proxy keeps deciding what each path gets. Rejected: **the kit owning the proxy with an app hook**. Apps' proxies
  differ in what they see (the adopter's answers page hosts on every path, `/_next` included), and Next reads
  `config.matcher` only as a literal in the app's own file, so the kit could not own the part that matters most.
- **The Clerk half is `packages/kit/src/adapters/real/clerk-proxy.ts`, internal, reached only by `import()` from
  `packages/kit/src/adapters/proxy.ts` in real mode, on the first request.** Vendor SDKs stay in the adapters, and
  simulated mode loads no Clerk code. Rejected: **publishing the Clerk half** for the app to load itself, which hands
  every app the run-mode branch the guide keeps out of app code. Rejected: **a top-level `await import()`** in the
  kit's module: lazy loading keeps importing `@sssb/kit/adapters/proxy` free of effects (its tests load it in both modes
  without Clerk), at the price of loading Clerk on the first real request instead of at start.
- **The run mode moved to `packages/kit/src/adapters/run-mode.ts`, which the registry re-exports.** The proxy asks it
  without importing the registry. Rejected: **importing `isSimulated` from `@sssb/kit/adapters/index`** in the proxy,
  as the adopter did: that loads every port and fake into the proxy, and in real mode builds the real ports there,
  refusing to start without the LLM, mail and job-runner settings, for a module that needs one boolean. Rejected: **a
  second reader of `APP_MODE`**, which the run-mode lint rule exists to prevent in apps. The fail-closed production
  guard stays in the registry, which every route still loads.
- **No edge-runtime branch.** Next 16 runs a proxy on the Node.js runtime and refuses a `runtime` setting in it (Next's
  `proxy.md`, "Runtime"; `get-page-static-info.js`: "Proxy always runs on Node.js runtime"), so `import()` of Clerk's
  Node build is an ordinary one.
- **Both apps' matchers add `/api/:path*` and keep the page pattern as it was; the proxy passes an API route
  through with `NextResponse.next()`.** Clerk must see API routes too (its error for a missing middleware names the
  matcher). Rejected: **`/:path*`**, which would run Clerk and the locale routing on every static file and `/_next`
  request. The old pattern excluded every path starting with `api` (`/apiary` too); `startsWith('/api')` keeps that.
- **Both apps' `src/proxy.test.ts` mock `next-intl/middleware`.** next-intl's ESM build imports `next/server` without
  an extension, which Node's resolver refuses under Vitest; the test checks the proxy's routing, not next-intl's.
  The matcher is tested with Next's own `unstable_doesMiddlewareMatch`.
- **`@sssb/kit` minor, Kind `seam`, Action `required`; `@sssb/create` minor, Kind `scaffold`, Action `required`.** A
  new published subpath is a seam change, and an app that does not adopt it cannot sign in in real mode. Rejected:
  **Action `optional` and a patch**: the app is broken without it in the one mode that has users.
- **The wiring is a guide rule kept by hand.** Rejected for now: **a conformance check that reads `src/proxy.ts`**,
  which would have to parse the matcher literal and recognise the wrapper through aliases; worth it only if an
  adopter misses the rule.
- **Not verified live**: a real sign-in through Clerk's middleware, its handshake redirect and `auth()` in a page and
  an API route. Those are the `auth-dev` row of `docs/cutover-checklist.md`.
- **`CLERK_JWT_KEY` is passed to Clerk's middleware as `jwtKey` when set, and stays optional** (round-1 review).
  Clerk 7.10 does not read it from the environment (its `constants.js` reads the publishable, secret, machine-secret and
  encryption keys, not the JWT key), and without it Clerk's middleware, now on every `/api` route, fetches its signing
  keys from Clerk's API for any bearer JWT whose key id it has not cached: a service caller's token, or one an
  unauthenticated client makes up, each costing a Clerk request against the instance's rate limit. With `jwtKey` Clerk
  verifies locally. Rejected: **making it required** in `assertRealEnv`, which changes the required-environment release
  snapshot while another task is reworking which settings real mode requires; it is a cutover-checklist step instead.
  Rejected: **skipping Clerk's middleware on requests with an `Authorization` header**, which would break a Clerk
  session token sent in that header.
- **A failed load of the Clerk half is forgotten** (round-1 review), so the next request tries again instead of every
  request failing until a restart.
- **The page matcher still leaves out any path with a dot** (round-1 review, kept): in real mode such a page would not
  pass Clerk's middleware and its `auth()` would fail. Rejected: **Clerk's matcher, which leaves out only listed static
  extensions**: it would send `/robots.txt` and any other unlisted file to the locale routing, which redirects it. The
  guide says a page path has no dot.
- **API request bodies now pass through the proxy** (round-1 review, kept): Next buffers at most
  `proxyClientMaxBodySize` (10MB by default) of a proxied body, above the 5MB attachment limit. An app that raises an
  upload limit past it raises that setting too; the guide says so.
- **A request carrying a token in `Authorization` skips Clerk's middleware** (round-2 review, then a sweep). Clerk
  accepts any kind of token there (`acceptsToken: 'any'`, set after the app's options, so it cannot be narrowed) and
  verifies its machine tokens (`ak_`, `mt_`, `oat_`) through its API on every request, which `jwtKey` does not help.
  Round 1 and round 2 found the same shape (a caller-chosen value that makes Clerk call its API), so instead of a third
  round the sweep listed where Clerk 7.10's `authenticateRequest` reads caller input: the `Authorization` header
  (`parseAuthorizationHeader`: the token after `Bearer `, or the whole value when it is one word), the session, refresh,
  handshake and dev-browser cookies, and the handshake query parameters. The header is closed by skipping Clerk when it
  would read a token there, by its own rule: SSSB's users sign in by Clerk's session cookie, and SSSB's own bearer
  tokens (the webhook secret, service callers' JWTs) are checked by their routes and never need Clerk. Another scheme
  (`Basic …`) gives Clerk no token, so Clerk still runs. The session and handshake tokens are closed by `jwtKey`, which
  stays optional (above) and is a cutover step. Not followed to the end: whether a forged expired session token with a
  refresh cookie reaches Clerk's refresh call before its signature is checked; with `jwtKey` set the signature check is
  local either way. Rejected: **skipping Clerk only for the three machine-token prefixes**, which leaves a one-word
  value and any prefix Clerk adds later.
- **`CLERK_JWT_KEY` is read as a secret store often holds it** (`\n` escapes, surrounding space) **and refused at the
  first real request if it is not a PEM public key** (round-2 review): Clerk would otherwise fail every session check
  with it and sign everyone out, without saying why.
- **Superseding the skip above: Clerk runs on every request, shown a copy without `Authorization`** (round-3 review of
  the sweep). Skipping Clerk left a client's own `x-clerk-auth-*` and `x-clerk-request-data` request headers in place,
  which Clerk's `auth()` trusts once their signature checks out; under `next dev` Clerk's keyless fallback decrypts the
  request data with a public constant, so anyone reaching a `dev:real` server could forge a user. A page request with a
  header token also failed (`auth()` with no middleware). Now Clerk always runs, and its decoration writes its own
  `x-clerk-auth-*` headers over the client's (`decorateRequest`, `setRequestHeadersOnNextResponse` in @clerk/nextjs
  7.10). It is shown a body-less copy of the request with no `Authorization` header, so it reads no header token and
  calls nothing for one; the app's proxy gets the original. When the app's proxy built no override list and Clerk
  built it from the copy, `Authorization` is added back to it, so the route still gets it. Rejected: **forcing
  signed-out headers on the skip path**, which recreates Clerk's header handling outside Clerk and has to track every
  header it adds. Rejected: **refusing a request with both a header token and an `x-clerk-*` header**, which still
  fails the page case.
- **`CLERK_JWT_KEY` must be a 2048-bit RSA public key in SPKI PEM** (round-3 review): Clerk's `loadClerkJwkFromPem`
  strips that key's fixed prefix as text, so a private key, a certificate, another size or another type passes
  `createPublicKey` and still fails every session check.
- **`Authorization` is put back only into a list Clerk built** (round-4 review): the handler records whether the app's
  proxy answered with its own override list, and a list the proxy built stands as it is, `Authorization` left out on
  purpose included. The handler throws if Clerk hands it a request it was not given, rather than handing the app's
  proxy the stripped copy. The tests' Clerk follows Clerk's own decoration rules (only a "next" or a same-origin
  rewrite is decorated, a "next" becoming a rewrite) and check the headers a route receives with Next's own merge.
- **Clerk's Frontend API proxy is not provided for** (round-4 review): it would forward the stripped copy, with no body
  and no `Authorization`, but it runs only with `frontendApiProxy` set or a production key on a `.vercel.app` host,
  and SSSB sets neither. Turning it on first needs `withClerk` to leave the proxy path's request whole.

## One list of apps, and `sssb add-app` (2026-11-19, `feat/one-list-of-apps`)

The adoption review's follow-up 3 (`docs/adoption-review-2026-11.md`, ranked item 3 and "What surprised" item 10):
a generated workspace named its apps in `sssb.apps` and again in both Vitest configs' `APPS` and in `knip.json`, and
nothing wrote a second app. JP's standing rule for these sessions: decide, and record the rejected alternative.

- **Where `sssb add-app` gets the starter: the `@sssb/create` installed at the workspace root**
  (`node_modules/@sssb/create`, `pnpm add -D -w @sssb/create@<version>`; the command prints that line when it is
  missing), whose packed template is the starter and whose code is the renames. `@sssb/tools` imports its new export,
  `@sssb/create/add-app`, by path from there, as rule 4 reaches `@sssb/kit` from the app; `--create <dir>` names an
  unpacked one instead. Rejected: **`@sssb/tools` depending on `@sssb/create`**, which undoes "no SSSB package depends
  on another" (ADR-0014, the 2026-11-18 addendum making `@sssb/tools` a peer of `@sssb/cdk`) and would meet the same
  `ERR_PNPM_EXOTIC_SUBDEP` for a release candidate installed by URL. Rejected: **a copy of the template in
  `@sssb/tools`**, a second packed starter and a second template build. Rejected: **running `pnpm dlx
@sssb/create@<version>`** from the command, which reaches the network from a command that needs none and finds no
  release candidate (they are not on npm). Rejected: **copying an app already in the workspace**, which is the
  adopter's app, not the starter. Rejected: **the generator writing `@sssb/create` into every workspace's root**, so
  that every workspace installs a generator for a rare command, and both of pack and consume's shapes move their
  lockfile seed.
- **The renames are the generator's code, shared, not copied.** `generate.js`' app half is `writeApp`, which
  `generate` and `addApp` (`packages/create/src/add-app.js`) both call; `addApp` adds a port slot of the app's own and
  rewrites the starter's `sssb dev-tick starter`, `sssb tick starter` and `originFor('starter')` to read it, failing
  if any other `starter` slot reference is left. It writes into a stage beside `apps/<slug>` and renames it into
  place, so a failure or a signal leaves nothing. Rejected: the renames written again in `@sssb/tools`.
- **The version check is `@sssb/create`'s against `@sssb/tools`' own** (the running CLI's), so the command works before
  the workspace's install, as pack and consume runs it. Rejected: against the installed `@sssb/kit`, which needs an
  install; `sssb doctor` already fails a kit and tools out of step.
- **The new app takes each `@sssb` package as the workspace's first app takes it** (its package.json, and its
  `infra/`'s when it has one, else the app's), a relative `file:` or `link:` rebased; a package neither names is written
  at the template's `^<version>` with a note. Rejected: always `^<version>`, which is wrong for a workspace on tarballs,
  URLs or a release candidate.
- **The port slot is named for the slug, its default the first of 3700, 3800, … that no app binds and SSSB keeps for
  nothing** (`--slot`, `--port` override). Rejected: requiring `--port` (one more thing to know), and a hashed default
  (not memorable, and the docs' example is 3700).
- **`sssb add-app` changes the workspace in one place, `sssb.apps`, and says the rest.** The root's `dev`, `tick` and
  `start` scripts and the CI workflow's `synth` name one app on purpose (the review), so it prints them rather than
  rewriting them; `knip.json` is left to the person too, and `sssb doctor` reports it (below). Rejected: editing
  `knip.json`, which is the adopter's config (it may be `.jsonc`, or customised), and rewriting the workflow's `synth`
  to `./apps/*/infra`, a CI cost the adopter chooses.
- **`workspaceAppProjects({ root, options })`** in `@sssb/tools/vitest`: `appTestProject` for each app `workspaceApps`
  returns, with `options(appDir)` for what one app's project needs. **This repository's `vitest.config.ts` uses it
  too**, its per-app `@sssb/kit` alias and fixtures directory through `options`, so `sssb.apps` is this repository's
  one list as well and the helper runs on every unit run here. Rejected: keeping `APPS` here, a second list in the one
  repository whose docs tell adopters not to keep one. Its `vitest.contract.config.ts` is unchanged: it discovers its
  apps (`tests/support/contract-apps.ts`) and aliases the kit's source, and keeps no copy of the list.
- **knip: `sssb doctor` reports, never fails, an app or an app's seam package that the root's `knip.json` gives no
  workspace** (`knipGaps`), as the future task preferred. A seam that is not a workspace package (this repository's)
  is not looked for; a knip config without `workspaces` gives no per-app line, and no knip config gives none at all; one that does not parse is "not
  checked". Rejected: a `knip.config.ts` building its workspaces from `sssb.apps`, one more file to run, and failing,
  since knip's own run is the gate.
- **Pack and consume's pages shape adds its ledger with `sssb add-app`**, run with the packed `@sssb/tools`' bin and
  `--create` the packed `@sssb/create`, before the workspace's one install; it then checks what the command wrote and
  that `sssb doctor` reports the ledger's knip gap. Rejected: installing first, running `pnpm exec sssb add-app`, and
  installing again: the lockfile seed resolves both apps in one install, and a second one is minutes for the same
  file `pnpm exec` would run.
- **The app guide (`packages/kit/src/guide.md`) does not mention the command**; `docs/adopting.md` does. Rejected: a
  guide line, which every adopter would have to refresh (`sssb guide`) for a command few run.
- **jscpd is said, not silenced** (the hands-on review: after `sssb add-app` a generated workspace's `pnpm jscpd` fails,
  50% against its 2%, because the new app is the starter and so is much of the first). The command's "left to you"
  and `docs/adopting.md` say so and how through. Rejected: **adding the new app to `.jscpd.json`'s `ignore`**, which
  would hide its duplication after the app is the adopter's own, and **a jscpd run per app** in the generated
  workspace, which changes every workspace's gate and stops seeing a copy across apps, the case a shared package
  exists for.
- **A root `@sssb/create` is reported, not written around**: nothing imports it, so `pnpm knip` calls it unused.
  `sssb doctor`'s knip line reports it when knip's root config does not ignore it, and the command says to remove it
  or ignore it. Rejected: the generator writing `@sssb/create` into every workspace's knip ignores (an entry for a
  package most workspaces never install), and the command editing `knip.json` (above).
- **Also from the round-1 reviews**: each Vitest project is named by `appLabels`, as `sssb ci` names the app, since
  Vitest refuses two projects of one name (`apps/web` beside `services/web`); a signal that comes while `addApp`
  writes is dispatched only once it returns, so `addApp` keeps what it made and the caller's `sssb.apps` change (made
  in its `finish`, under the same hold) until then, and undoes both; a spec no app names is looked for in the
  workspace's other packages (a root `infra/`) before the template's range; the slug is refused when a workspace
  manifest depends on a package of the new app's names; knip's `.jsonc` configs are read with their comments.

## 2026-11-18 — `sssb pin`: one command raises the workflow's pin and the marketplace's `ref` (adoption follow-up 7)

`sssb pin [--app <dir>]` (`packages/tools/src/commands/pin.js`) reads the release commit from the installed kit's stamp
(`dist/release.json`, through `kit.js`'s `kitReleaseStampOf`) and writes it into every `uses: <repo>/.github/workflows/…@<ref>`
line under `.github/workflows/` and every `extraKnownMarketplaces` entry of `.claude/settings.json` that names SSSB's repository.
Decisions, each with the alternative rejected:

- **A text edit, not a re-print.** The workflow is edited line by line and `settings.json` at the offsets of the `ref`
  string (a small JSON scanner), so the adopter's formatting, key order and inline arrays survive and the diff is the two
  pins. Rejected: `JSON.stringify` of the parsed settings, which reflows anything Prettier laid out another way and
  buries the pin in noise; and a YAML round trip, which drops comments.
- **Judged before written.** Every pin is planned first (`planPins`, pure), and a refusal anywhere writes nothing, so a
  bad `settings.json` never leaves the workflow raised and the marketplace behind. Rejected: raising what can be raised
  and failing on the rest, which leaves the two pins on two commits, the state this command exists to end.
- **What it refuses.** No release commit to pin to: SSSB's own repository (`isInRepoKit`, even with a `dist/` a pack left
  behind, as doctor ignores it), a kit with no stamp or a stamp that names no commit. Files that are not the shape it
  edits: no workflow calls SSSB's reusable workflow, `settings.json` not JSON, no marketplace from SSSB's repository, a
  `ref` that is not a string. Exit 1 and a message, as every `UsageError`.
- **A missing `.claude/settings.json` is not a refusal**, as it is not one for doctor (a workspace whose people do not use
  Claude Code has no plugin): the workflow is raised and the run says there was no second pin. Rejected: refusing, which
  leaves such a workspace no command for its one pin. A marketplace entry with no `ref` (it follows the default branch) gets
  one added, in the entry's own layout, since doctor reports exactly that as a pin that differs.
- **The version comment moves, an adopter's own comment does not.** A trailing `# @sssb/create 0.2.0`, `# @sssb/kit 0.2.0`
  or `# v0.2.0` is what the generator and the old notes wrote, and a stale one names a release the pin has left; any other
  comment is left. Rejected: rewriting every trailing comment, which deletes text the adopter wrote, and leaving them all,
  which the old hand edit had to remember ("and the version in the comment after it").
- **One definition of a pin.** `doctor-checks.js` now exports the `uses:` regex (`WORKFLOW_USES`), the marketplace's
  repository test (`sourceRepository`) and `stampedCommit`, which doctor's report and this command both use, so they
  cannot disagree about what a pin or a stamp is. The command picks its app as `sssb guide` does (`--app`, the working
  directory, else the workspace's first app, here the first that resolves `@sssb/kit`) instead of importing doctor's chooser, whose
  messages name doctor.
- **The release notes' step 3 is the command.** `upgradeSection` no longer writes a yaml and a json block with `<sha>` in
  them, nor the `git ls-remote` that read the SHA off a tag: the installed kit has the commit. It keeps one sentence of
  hand edit for when the command refuses (with the `git ls-remote` that reads the tag's commit, because doctor names no commit
  for a kit with no stamp, one of the two causes of a refusal), a candidate's notes still name the commit (`sha`), and `docs/adopting.md`'s step 4
  says the same. `docs/releases/v0.2.0.md`, a dated record, still carries the hand edit. Rejected: keeping the hand edit
  beside the command, which would be two ways to do it in every release's notes.
- **At the new budgets**, five more runs of the destructive shard on CI (one push and four reruns, 2026-11-27): 16 passed
  each time, in 1.5 to 1.9 min, none flaky. Locally under `next dev` at load ~330, the destructive project passed 16 of
  16 in 5.8 min.
- **Not done here:** the generator's own text in a workspace's `README.md` and `CLAUDE.md` (`packages/create/src/files.js`,
  "Raise the pin when you upgrade") still says to raise the pins without naming the command; it stays true, and changing it
  changes what `@sssb/create` writes, so it is a separate change.
- **Round-1 review (Opus), code only: no finding at MEDIUM or above; three LOW fixed.** A repeated key acts on the LAST
  one, as `JSON.parse` (doctor, Claude Code) reads it; a missing `ref` is added to a CRLF settings file with CRLF; a quoted
  `uses: "…@<sha>" # v0.2.0` line's version comment moves too. Accepted as they are: the files are written one after the
  other, so an I/O error (EACCES, a full disk) can leave one raised (every refusal is decided before the first write, and
  a rerun finishes it); a `settings.json` that exists but declares no SSSB marketplace refuses, where an absent one does
  not (a file that is there and says nothing about the plugin is more likely a mistake than a workspace without one); a
  `uses:` line inside a `run: |` block scalar counts as a pin, in doctor's report too.

## Real mode reads people from the identity provider, never the seed, and loads only the SDKs it chose (2026-11-19, `fix/realmode-digest-and-static-loads`)

Two follow-ups recorded when the optional real ports landed (`fix/kit-optional-real-ports`, PR #67).

- **The framework's `digest-email` handler addresses the auth port's members, not the seed's people.** It took its
  recipient from `@sssb/app-config/seed`'s `people`, so in a deployment, whatever the job runner, a team's digest went
  to a seed person's address, or to a synthetic `<org>@digest.example` one. It now asks `auth.listMembers(orgSlug)`, the
  identity provider in a deployment (the same call the jobs' notifications make), and picks the team's first active
  admin, else its first active member: the rule it had, applied to the real store. People are not in the database
  (there is no users table), so "the real store" is the auth port; the `withTenant` read is the digest's rows, which the seam's `digestBodies` makes under `withTenant`, as its contract (`DigestBodySource`) requires.
    - **Handlers get the auth port in their context** (`JobContext.auth`), as they get `llm` and `email`, rather than
      reaching for the adapter registry, which loads the handlers. Every runner supplies it: the simulated one, the
      in-process one (the registry's hook), and the artifact producer. Rejected: **importing `auth` from the registry in
      the handler**, a static cycle with the module that loads it, which the context exists to avoid.
    - **The locale** is the person's own only in a simulated world: the fake auth adapter's `personLocale`, imported
      dynamically behind `isSimulated` (`makeNotifyDeps`'s precedent). The auth port carries no locale, so a deployment
      writes in the app's default, as its notifications do. The handler reads the run mode from `adapters/run-mode`, as
      the request proxy does, since the registry is what loads it. (Superseded by the two review rounds below: the
      locale now comes from the runner's `resolveLocale`.)
    - **Nobody to address:** a deployment's team with no active member with an email address gets no digest (the job completes, having sent
      nothing); the simulated world keeps the synthetic address so a demo never shows an empty digest. An org that no
      longer exists gets none either. Rejected: **failing the job**, which would turn a schedule on an empty team into a
      failure every period.
    - **Pinned twice.** `packages/kit/src/jobs/digest-email.test.ts` runs the handler in real mode with every read of the
      seed throwing, and `tests/tooling/jobs-graph.test.ts` (first named `jobs-seed-free.test.ts`) walks each seam's `jobs` module (the fixture and both
      apps) by static imports alone and fails if one reaches a seed module; a dynamic import behind `isSimulated` is
      allowed. Every other job kind (the showcase's `export-tickets` and `analyze-bundle`, the fixture's `export-dockets`) was already seed-free.
- **`adapters/real/index` loads `pg` and `posthog-node` only when chosen.** The `pg` transport (`./db`) and PostHog
  (`./analytics`) were static imports, so every deployment loaded both, a Data API one included, and one with no
  PostHog key. Both are dynamic imports now, as the Data API transport and the optional ports already were, and
  `dbPortFor`, which the Data API transport shares, moved to its own module (`./db-port`), since importing it from
  `./db` loaded `pg` too. `DATABASE_TRANSPORT` behaves as before. Auth (Clerk) and storage (S3) stay static: every
  deployment uses both. `packages/kit/src/adapters/real/index.test.ts` pins it from esbuild's account of the static
  graph: of the SDKs a choice brings, none is reached before the choice, and the Data API transport reaches no `pg`.
  The migrator (`migrate-handler.ts`) still imports the `pg` transport statically; it is bundled into one file for its
  own Lambda, so a dynamic import there would only defer evaluating `pg` on the Data API path, not drop it from what the
  Lambda ships.
- **Seen, not changed here:** real mode still reads tenants and organizations from the seed for display (the theme's
  `findTenant`, and the showcase's `findTenant` and `findOrg` in its layouts, sign-in, org page and invitations, and the starter's `findTenant` in its protected layout). Those are tenant
  configuration, not people, and moving them to the database is a design of its own.
- **From the first review round, and CI.** The first version read the simulated locale from the fake auth adapter by a
  dynamic import, and the showcase stopped building: a client component (the dashboard's glue) imports
  `@sssb/kit/core/jobs`, which imports the seam's `jobs` module for its kinds, which registers the handlers, so a
  bundler puts everything a handler can import, dynamic imports included, into the client bundle, and the fake auth
  adapter reads request cookies (`next/headers`). The locale now comes from the seed's people, dynamically imported
  behind `isSimulated` (reversed in the second round, below): plain data, which the client bundle carried before this change. `tests/tooling/jobs-graph.test.ts`
  now also fails if anything a handler reaches, by any import, imports `next/headers` or `server-only`. Rejected:
  **a locale hook in the job context** (the runner passing `personLocale`), a second context field for what only the
  simulated world has; and **splitting the job kinds out of the handlers' seam module**, a seam change for every app.
  The cost, recorded: an app's own handler could still import the seed dynamically without `isSimulated`, which no
  graph test can see; the digest's real-mode test throws on any seed read, and the app guide's rule (`@sssb/kit/guide.md`,
  "Vendors, environment and parameters": a job handler never reads the seed) covers the rest.
- **The static demo's digest twin picks from everyone in its world** (the seed and accepted invitees), as the server's
  simulated digest now does through the fake auth adapter, instead of the seed alone.
- **From the second review round, which revises the first.**
    - **The locale comes from the runner after all**, as an optional `resolveLocale` in the job context, which the
      simulated runner fills with the fake auth adapter's `personLocale` (`makeNotifyDeps`'s pattern) and a deployment's
      leaves out. The seed's people knew neither an accepted invitee's locale nor a changed profile's, so a simulated
      digest to either went out in the default language or the seed's, while their notifications followed their own; and the handler now imports
      no seed at all, so the client-bundle question is gone at its root. This reverses the first round's rejection of a
      locale hook: the second field earns its place by being right for everyone the world holds.
    - **Only an address is addressed.** The real auth adapter lists a member's Clerk identifier, "such as their email
      address or phone number" (`PublicUserData.identifier` in `@clerk/shared`'s `types/session.d.ts`); the digest
      skips a member whose identifier holds no `@`, where it would have sent to a non-address, and likely failed the
      job each time the schedule fired.
    - **The client-bundle guard also refuses every Node builtin (`node:module`'s `builtinModules`, bare or `node:`),
      `pg`, `@clerk/nextjs/server`, the AWS SDKs and `next/server`**, not only `next/headers` and `server-only`.
    - **The review's phase 1 stopped here:** the second round (an Opus reviewer, code only) reported two LOW findings,
      both taken above, and nothing at MEDIUM or above.

## `SssbApp` tells the app the viewer's host, and redirects plain HTTP to HTTPS (2026-11-19, `fix/cdk-forwarded-host-https`)

Two real-mode defects found while fixing POSTs (`fix/cdk-function-url-post`). CloudFront sends the server's Function
URL its own `Host` (it signs for it) and forwarded a viewer's `X-Forwarded-Host` as sent, so what reads that header
(Clerk's request URL, Next's server-action origin check, next-intl's domain redirects) saw the Function URL's host, or
a host the viewer chose. Next's own `request.url` keeps the Function URL's host either way. And the two S3 behaviors
(`/_next/static/*`, `/assets/*`) answered plain HTTP. Pages worked around the first with a CloudFront Function of its
own. JP's standing rule for these sessions is to decide and record; each choice below is one he would otherwise have
been asked.

- **A viewer-request CloudFront Function sets `x-forwarded-host` from the `Host` CloudFront received**
  (`packages/cdk/src/forwarded-host.js`), on every behavior that reaches the server (today the default one), overwriting
  what the viewer sent. Next fills `x-forwarded-host` only when it is absent (`next/dist/server/base-server.js`), and
  Clerk builds its request URL from it. Rejected: **setting it in the origin-request Lambda@Edge** that already hashes
  the body: by the origin request the `Host` is the Function URL's. Rejected: **forwarding the viewer's `Host`**, which
  stops a Function URL origin working (CloudFront's guide, `AllViewerExceptHostHeader`). CloudFront allows a viewer-request CloudFront Function beside an origin-request
  Lambda@Edge on one behavior.
- **It lowercases the host and drops any port, sets `x-forwarded-port` to 443, and drops a viewer's `Forwarded`.**
  next-intl's domain redirects read the port, a viewer could set it, and 443 is the only port a viewer reaches the app
  on once HTTP redirects. Nothing in Next or Clerk reads `Forwarded`; a viewer's is never CloudFront's.
  `X-Forwarded-Proto` is left alone: functions may not touch it, and CloudFront removes a viewer's.
- **The function's name is keyed by region, stack name and construct path.** CloudFront Function names are unique per
  account, and CDK's default leaves the stack name out, so one stack deployed under two names into one account would
  collide. Rejected: **CDK's default name**.
- **Every behavior redirects HTTP to HTTPS**, as the default behavior already did. Rejected: **`https-only`**, which
  answers 403: no safer, since the plain request has already crossed by then, and a typed `http://` link would break.
- **The function is exposed as `SssbApp.forwardedHost`**, so an adopter who adds a behavior of their own to the
  server's origin can associate it. Rejected: **keeping it private**, which would leave such a behavior forgeable.
- **Out of scope, reported to the manager:** an HSTS header (a response-headers policy; pages sets its own), without
  which a first `http://` visit can be intercepted before its redirect, and `X-Forwarded-For`, to which
  CloudFront appends the viewer's address after any the viewer sent, so the first entry is the viewer's to choose.

## No `starter` in a generated app (2026-11-19, `feat/no-starter-in-generated-app`)

The adoption review's follow-up 5 (`docs/adoption-review-2026-11.md`, ranked item 5 and "What surprised" item 7): an app
called `acme` said `starter` in its port declaration, its `dev` and `tick` scripts and its Playwright config. JP's
standing rule for these sessions: decide, and record the rejected alternative.

- **A generated app takes a port slot of its own, named for its slug, at 3700**
  (`"sssb": { "port": { "name": "acme", "default": 3700 } }`): `sssb add-app`'s rule (#65) for the first app too.
  Rejected: **a neutral built-in service, `app`** (the future task's design: `APP_PORT`, the starter's port and band,
  `starter` kept as an alias): a new built-in in `@sssb/tools`' ports with alias rules, and every generated app on one
  shared name, so a second app still needs a slot of its own, which custom slots (built since the task was written)
  already give. Rejected: **keeping `starter`** (the P12 addendum's reasoning, and CLAUDE.md's "the slot is a port band,
  not the app's name"): the review found it the newcomer's main "not mine" signal, and the risk `docs/adopting.md` named
  before this change (its paragraph "The port key keeps its old name, on purpose"), a declaration and a Playwright
  config that agree only by spelling one literal, is gone (next). This supersedes the 2026-11-18 "`@sssb/create`"
  entry's "The port service stays `starter`".
- **The starter names its slot only in its `package.json`.** Its scripts call `sssb dev-tick` and `sssb tick` with no
  slot, and its Playwright config `originForApp(__dirname)`; all read the declaration. So the generator's rename of the
  slot is one value in one file, which it finds by checking that the template declares `starter`, and it fails on a
  template whose scripts or Playwright configs still name the slot. SSSB's starter keeps `starter` itself (port 3100,
  `STARTER_PORT`, `pnpm tick:starter`), so this repository's runbooks stay true. Rejected: the generator rewriting the
  scripts and the config as well, as `sssb add-app` did, three rewrites where one declaration does.
- **Its default is 3700, not 3100.** 3100 is the built-in `starter` slot's, which a slot of the app's own may not take
  (`@sssb/tools`' ports.js refuses SSSB's ports), and 3700 is the first port `sssb add-app` offers, so a second app takes 3800. The app guide's and `docs/adopting.md`'s examples moved with it. A generated app's local port changes from 3100
  to 3700, and its override from `STARTER_PORT` to `<SLUG>_PORT`; a workspace generated before keeps 3100.
- **A slug a slot cannot be named for gives the slot `sssb-app`** (`SSSB_APP_PORT`): one longer than a slot name's 32 characters,
  with a doubled or trailing `-` (which a slug allows and a slot name does not), or reading a built-in's variable
  (`showcase`, `starter`, `ladle`, `contract-pg`). Rejected: refusing such a slug, which the generator accepted until
  now, and a `--slot` flag on the generator, one more option for a corner case. Rejected (round-1 review): **`app`**,
  whose `APP_PORT` many shells already hold for another project, and which would then move the app's dev server and
  e2e run onto that port. The same risk stands for any slot named for a slug (`API_PORT`, `WEB_PORT`), as it has for
  `sssb add-app`'s slots since #65; prefixing every custom slot's variable (`SSSB_<NAME>_PORT`) would change
  `@sssb/tools`' published `<NAME>_PORT` contract, which adopters' `LEDGER_PORT`-style overrides read, so it is left
  for a release that takes that change on purpose.
- **The slot rules are copied into `@sssb/create`** (`firstAppSlot`), which depends on no SSSB package, and
  `tests/tooling/create-generate.test.ts` holds the copy to `@sssb/tools`' `parsePortDeclaration` by trying every choice
  on it, as `RESERVED_DATABASE_NAMES`' copy is held. Rejected: importing `@sssb/tools` from the generator (rule 4).
- **The app guide changed** (its example said `"sssb": { "port": "starter" }`, now false of a generated app, and a
  second app at 3700, now the first's default), so `@sssb/kit` is in the changeset and an upgrading workspace refreshes
  its copy (`sssb guide`), as every release asks. Rejected: leaving the guide's example, which a generated workspace's
  copy would contradict.
- **Pack and consume's ports follow the slot**: the pages console's e2e and the generated shape's checks pass
  `CONSOLE_PORT` (`<SLUG>_PORT`) where they passed `STARTER_PORT`, its ledger takes 3800, and the generated shape fails if
  the packed generator's workspace says `starter`.
- **`pnpm exec sssb pin` is named** where the generated README, `CLAUDE.md` and CI workflow say to raise the pins
  (follow-up 7, #66, left them saying it in words).

## `SssbApp` sends HSTS and safe security headers (2026-11-19, `fix/cdk-hsts`)

The security review of `fix/cdk-forwarded-host-https` rated a missing `Strict-Transport-Security` MEDIUM. Every
behavior now redirects HTTP to HTTPS, but without HSTS a visitor's first `http://` request can be intercepted before
its redirect. Pages, the first adopter, sets its own response headers policy. JP's standing rule for these sessions is
to decide and record; each choice below is one he would otherwise have been asked.

- **A response headers policy on the three behaviors `SssbApp` builds**: the app's pages and the static files alike.
  Rejected: **headers set by the app** (Next's `headers()`), which would never reach the S3 behaviors.
- **AWS's managed SecurityHeadersPolicy by default** (`67f7725c-6f97-4210-82d7-5512b31e9d03`). It sends:
    - HSTS for a year (`max-age=31536000`), without includeSubDomains or preload;
    - `X-Content-Type-Options: nosniff`, always sent;
    - `Referrer-Policy: strict-origin-when-cross-origin`, browsers' own default, stated;
    - `X-Frame-Options: SAMEORIGIN`, refusing other sites' frames and keeping the app's own;
    - the legacy `X-XSS-Protection: 1; mode=block`, which current browsers ignore.

    All but nosniff yield to a header the app sends itself (CloudFront's guide, "Use managed response headers
    policies"). Nothing in the kit, the tools or the starter sets any of them (searched), so there is no duplicate.

    Rejected: **a custom policy per deployment** (written first, then changed after round 1 of review). An account holds
    20 custom response headers policies, raisable on request; managed ones don't count (CloudFront's guide, "Quotas").
    One per stack would stop the 21st deployment in an account, previews included. What the custom policy bought was
    small: two years of HSTS instead of one (renewed on every visit either way), and no legacy XSS header.

- **`includeSubDomains` is off by default, behind `hstsIncludeSubdomains`.** It binds every subdomain of the host the app
  is served on, which on an adopter's domain may include hosts SSSB knows nothing about. The managed policy cannot send
  it, so opting in builds a custom policy: the managed policy's headers with HSTS's includeSubDomains (and without the
  legacy XSS header), taking one of the 20. Its name is keyed like the forwarded-host function's (region, stack name,
  construct path), since CDK's default name for it carries no region. `preload` is never set: a submission to
  browsers' lists is the domain owner's act. Rejected: **includeSubDomains on by default**.
- **Framing.** An app that must be framed by another site sends its own CSP `frame-ancestors`, which browsers prefer
  to `X-Frame-Options`. Rejected:
    - **DENY**, which would break an app that frames its own pages;
    - **a default Content-Security-Policy for the app**, as one that fits every app would allow everything (a
      sandboxing one for the static files is a future task: `.claude/future-tasks/static-files-sandbox-csp.md`).
- **An adopter's own policy (`responseHeadersPolicy`) replaces SSSB's whole set on those three behaviors.**
  `hstsIncludeSubdomains` beside it is refused rather than silently ignored. A behavior the adopter adds gets no policy
  unless they give it one; the construct exposes its own as `responseHeadersPolicy` for that.
- **A correction to the entry above (`fix/cdk-forwarded-host-https`):** it says Next's own `request.url` keeps the
  Function URL's host. Next 16.4.6 builds it from the server's own bind address, `localhost` and its port for a server
  bound to `0.0.0.0` (`next/dist/server/next-server.js`, `start-server.js`). Either way it is not the visitor's host.
  The code comment, the changeset and the cutover row now say so, and
  `.claude/future-tasks/request-url-is-not-the-public-url.md` records the fix.
- **Recorded as future tasks, not built:**
    - that public-URL helper;
    - `X-Forwarded-For`'s viewer-chosen first entry (`x-forwarded-for-first-entry.md`);
    - the default certificate's minimum TLS (`viewer-tls-minimum.md`);
    - the live check of a tagged Lambda@Edge function (`edge-function-tags-live-check.md`);
    - a sandboxing CSP for the static files (`static-files-sandbox-csp.md`).

## The adoption guide is split in two (2026-11-19, `docs/adopting-guide-split`)

The adoption review's follow-up 1 (`docs/adoption-review-2026-11.md`, ranked item 1): `docs/adopting.md` had grown to
921 lines, of which a newcomer needs about 150. JP's standing rule for these sessions: decide, and record the rejected
alternative.

- **`docs/adopting.md` is the guide (156 lines), `docs/adopting-reference.md` the reference.** The guide keeps the
  file name every link already uses, and the heading "Upgrading by release", which every generated README links by
  anchor. Rejected: a new name for the guide (`docs/start.md`) with `adopting.md` as the reference, which breaks every
  generated workspace's README link and a test that holds it.
- **The guide is written for the order a newcomer acts, not moved from the old text**: generate, first boot, take out
  the starter's content, a first entity, deploy and cut over, upgrade. It defines tenant, organization (team) and the
  staff team where a first table needs them (ADR-0004's boundary, development-approach's "Teams", `staffOrgSlug`'s
  comment). The reference takes the old sections whole, reordered under the old headings where they are cited.
  Rejected: trimming the old file in place, which keeps the reference's order on the newcomer's path.
- **Stale text is deleted, not moved**: the release-candidate history (tarball URLs, `overrides`, rc notes), the
  fork-era switch, the story behind the required `appName` prop, the history of SSSB's test fixture, and "the starter
  has no server-side Simulator" (false since follow-up 6). Rejected: a history section in the reference, which the
  decision log and ADRs already are.
- **The guide's commands were run** against a workspace generated from this commit's packed packages, with the
  checkout's generator (`pnpm create @sssb` reaches npm's last release, which predates `sssb remove-items` and the rest):
  `pnpm verify` on the fresh workspace, `pnpm dev` on a free port of its own and stopped after its checks, the
  Simulator's API, `pnpm tick`, the static demo, doctor, synth, `sssb guide`, `sssb pin`, `sssb remove-items`, `pnpm
verify` after it, `pnpm knip` and `pnpm lint:fix`. Not run: `pnpm create @sssb` and `npm create @sssb` (for that
  reason), and the three `claude plugin` commands, which change the machine's Claude Code state.
- **Citations of moved sections are repointed in place** (code comments, `CLAUDE.md`, `CONTRIBUTING.md`, the
  release-notes script, `sssb remove-items`' refusal, open future tasks), and ADR-0014 gets an addendum naming where
  its cited sections live; dated records and ADR bodies are left as they were.

## ADR-0015 is Proposed: swappable kit ports (2026-11-19, `docs/swappable-ports`)

JP asked whether an adopter could use libsql or Turso, Cloudflare R2, Auth0 or other optional providers, and whether
the spine could stay required but swappable. The answer is a Proposed ADR
(`docs/adr/0015-app-supplied-adapters-for-kit-ports.md`), no code. Decisions taken in writing it, under the standing
rule for these sessions, several of them changed by its review (an Opus and a Fable reviewer):

- **The study ends in a recommendation, not a menu.** Rejected: each port's options unranked, which hands the approver
  the analysis instead of a decision.
- **Protocol choices before app adapters.** Storage's `s3` choice takes an endpoint (R2, MinIO, B2), and email gains an
  `smtp` choice; the `app` value is limited to the ports no protocol covers (LLM, analytics, jobs, auth). Rejected, at
  first drafted: R2 and other providers as app adapters too, which puts a third-party contract on storage and email for
  vendors a protocol already reaches. Both reviewers raised it.
- **The app supplies only the real adapter; the fake stays SSSB's.** Rejected: app-supplied fakes, because the
  Simulator reads the fakes' state and the hermetic promise would become each app's.
- **Registration in three seam modules (settings as data, factories handed in by the registry, the auth provider's
  middleware on its own for the request proxy), with the full factory signature settled at once, and a graph check,
  not a lint rule, keeping app adapters out of the registry's module graph.** Rejected, at first drafted: one module read by `createRealPorts`, which would pull every
  app adapter into `sssb check-real-env`'s CommonJS bundle and could deadlock boot through the registry; and an
  argument-less factory, which a job runner cannot use.
- **Analytics in two parts: a patch now, so real mode without a key gets a no-op and never the fake (which writes
  under `.data/`, likely failing on Lambda's read-only directory), then an explicit switch, default `posthog`, filed as
  the breaking change it is.** Rejected: "the same default behaviour", which is the inference the switch rule forbids;
  and folding the patch into the switch's step, which would leave a likely live defect waiting on unrelated work.
- **No `app` for inbound email.** Another provider is the app's route outside `webhooks/` under its own exemption.
  Rejected: an `app` value that changes nothing `none` does not.
- **libsql and Turso are answered "not an adapter"**, with both tenancy strategies and what each does to ADR-0004; a
  different Postgres host is a conditional yes, its conditions named (genuine PostgreSQL 16+, an owner that may create
  roles, no `BYPASSRLS`, a migrate entry point off AWS). Rejected: "any Postgres works today", which overstated it.
- **Vendor suites run apart from the hermetic contract run**, in `tests/ports/` with a runner of their own. Rejected:
  putting credentials into the contract run.
- **Build on first real demand.** Rejected: building every port's swap now, ahead of any adopter asking.
- **`docs/adr/README.md` lists 0015 as Proposed** and its count sentence says fifteen. `CLAUDE.md`'s list of Accepted
  ADRs is unchanged until JP decides.

## Storage is an optional port: a deployment needs no S3 bucket (2026-11-19, `feat/storage-optional`)

JP, 2026-11-19: an SSSB deployment must not require an S3 bucket. Storage gets the treatment the 2026-11-19 entry
"Real mode requires only the optional ports an app uses" gave LLM, email and jobs. JP's standing rule for these
sessions: decide, and record the rejected alternative.

- **A switch, `STORAGE_PROVIDER` (`s3` | `none`), set by `SssbApp` from `params.ports.storage`**, in the optional
  ports' one table (`packages/kit/src/adapters/real/optional-ports.ts`, `packages/cdk/src/optional-ports.js`). Unset is
  `s3`, so a deployment that sets nothing requires what it did. A string with named choices, not a boolean, so a later
  choice can name another provider (the sibling study `docs/swappable-ports`, an app's own adapter for a kit port, would
  be one more value). Rejected: inferring storage from whether `STORAGE_BUCKET` is set, which the `DATABASE_TRANSPORT`
  rule already refuses (a half-configured port must fail at boot, not quietly vanish).
- **`none` is the absent port (`absentStorage`)**: every method throws `AbsentPortError` naming the switch, and the S3
  adapter is a dynamic import, so the SDK never loads. Rejected: a no-op or in-memory storage, which would accept a
  `put` and lose it.
- **What in the framework uses storage, and what each does without it.** The kit stores nothing of its own: its
  inbound email handling keeps no attachments and its digest job sends mail only. The job handler context carries the
  port, and gets the absent one, so a handler that stores fails its job with the switch named (proven for the
  in-process runner). The seed and the Simulator use the fake storage, in simulated mode only, which ignores the
  switch as it ignores the other ports'. Exports, attachments and uploads are the app's (the showcase's), so they
  require the port, and the showcase declares `s3`.
- **`AWS_REGION` is required only by what calls AWS**: storage on `s3`, `JOBS_RUNNER=codebuild` (both in the ports'
  table) and the Data API transport (`DATA_API_REGION_ENV` in `adapters/real/index.ts`). A `pg` deployment with
  `storage: 'none'` and in-process jobs calls no AWS API, so requiring a region there would be a placeholder.
  Rejected: adding it to `DATABASE_ENV['data-api']`, whose every variable `SssbApp`'s test expects on the server, where
  Lambda reserves `AWS_REGION` and sets it itself.
- **`SssbApp` with `none` builds no storage bucket, sets no `STORAGE_BUCKET` and grants no S3**; with `s3` the bucket's
  construct id, and so its logical id, is unchanged, and the stateful-ids snapshot (synthesized with `ports` left out)
  is unchanged. `storageBucket` becomes `Bucket | undefined`, filed with the required-env snapshot's `minor`.
  Rejected: adding `storage: 'none'` shapes to the snapshot, which would change it for nothing that is replaced; a
  test in `sssb-app.test.js` proves every other stateful id stays put on `none`.
- **Switching a deployed stack from `s3` to `none` is documented, not refused.** The bucket leaves the stack: in
  production its removal policy (`Retain`) keeps it, orphaned with its objects; elsewhere `autoDeleteObjects` empties it
  and it is deleted, as on the stack's own deletion. Rejected: refusing the switch (synth cannot see what is deployed)
  and keeping the bucket on `none` (then every deployment still has one, which is what JP ruled out).
- **The starter declares `storage: 'none'`**: it stores no files, so a generated app deploys without a bucket, with a
  comment saying to set `s3` when it starts storing (cutover row `cloud-accounts`, which now says the storage checks
  do not apply with `none`). Rejected: `s3`, a bucket every generated app would carry and cut over before it needs one.

## Two real-mode fixes: keyless analytics, and the starter's auth provider (2026-11-19, `fix/realmode-analytics-and-clerk-provider`)

The two follow-ups ADR-0015's study found, each verified from the code first; neither was observed on a deployment, and
pages' sandbox branch has both (its locale layout mounts no provider while its sign-in page loads SSSB's real form, and
its deployment sets no `POSTHOG_KEY` or `APP_DATA_DIR`). JP's standing rule for these sessions: decide, and record the
rejected alternative.

- **Real mode without `POSTHOG_KEY` gets a no-op adapter** (`packages/kit/src/adapters/real/no-analytics.ts`), never
  the fake, whose `capture` and `isFlagEnabled` create and write `.data/analytics` in the working directory, the
  read-only deployment package on Lambda. Rejected: pointing `APP_DATA_DIR` at `/tmp` in `SssbApp`, which would keep a
  simulated-world store, per instance and lost on recycle, behind a real deployment; and an `AbsentPortError`, which
  would fail every invite.
- **A flag answers the default its caller passes**, as the PostHog adapter does when PostHog cannot be reached.
  Rejected: `false` for every flag, which would override a caller that declared `true` as the safe default.
- **The real ports reach no fake adapter at all**: the bundle test now fails one. Rejected: checking the analytics
  module alone, when the import of any fake into the real registry is the class of mistake.
- **This is the patch ADR-0015 proposed, not its analytics switch**, which stays proposed.
- **The starter's locale layout mounts `RealAuthProviders` in real mode**, as the showcase's does: `@clerk/react`
  6.18.8's `useSignIn` calls `useAssertWrappedByClerkProvider`, which throws outside `ClerkProvider`, and the starter's
  real-mode sign-in page renders SSSB's form that calls it.
- **A conformance check, `real-auth-provider`, holds every app to it**: from each of Next's rendering files under
  `src/app` it follows the app's own imports (relative, `@/`, `@sssb/app-config/`; type-only ones skipped) with
  TypeScript's parser, and a file that reaches SSSB's real sign-in or invite form needs a layout or template wrapping
  it that reaches the provider. Rejected: a test of the starter alone, which would not have caught pages, the first
  adopter, which has the same gap; a render test of the layout in real mode, which needs the real registry to boot;
  and, as first written, judging only a layout's own imports and a module's own directory, which review showed failing
  correct apps (a provider behind a wrapper module, a form in a shared folder) that could only opt out. Its limits are
  in its header: it reads imports, not whether they run, and no alias but those two. SSSB's fixture opts out (no
  `src/app`); scratch apps test the check itself.
- **The check ships as `@sssb/kit` minor**, though the brief said patch: an adopter whose layout lacks the provider sees
  its suite go red on upgrade, and the release notes call an action-required change a minor. The analytics fix is a
  patch, and the starter's change a patch of `@sssb/create`.

## A fast path for docs-only pull requests (2026-11-19, `ci/docs-only-fast-path`)

JP, 2026-11-19, on safeinsights/sssb#78 (three markdown files, every job run): "Is there an optimization here? See
CanopyCMS". CanopyCMS's `ci.yml` (`dual-build`, `standalone-image`, `release-dry-run`) runs every job so each reports a
conclusion, and gates its expensive steps per step. SSSB copies that. JP's standing rule for these sessions: decide,
and record the rejected alternative.

- **Docs-only is narrow: every changed path under `docs/` (but `docs/releases/`) or `.claude/future-tasks/`**
  (`.github/scripts/docs-only.sh`). Docs are not inert here, so the jobs that read them keep no fast path:
  `lint-typecheck-unit` runs Prettier, the doc-path gate, and the plugin, generator and release-notes tests. The jobs
  that do take one read no doc: e2e, the static demos, the contract tests and synth build and test the apps; both pack
  and consume shapes pack the packages and generate from the starter, and the generated README links SSSB's docs by
  URL without reading them (`packages/create/src/files.js`). `docs/releases/` is excluded because `scripts/release.mjs`
  writes a release's notes there and the release rehearsal runs it. Rejected: root markdown (`CLAUDE.md`,
  `README.md`) and `.changeset/`, for want of evidence that no fast-path job reads them (the release jobs read
  `.changeset/`); a path joins the list only with that evidence.
- **Which jobs take it.** The reusable workflow's `contract`, `e2e`, `demo-static` and `synth`, and checks.yml's
  `adoption-probe`, `pack-and-consume`, `release-dry-run`, `licence-scan` and `repo-checks`' knip, jscpd and spike suite.
  Always in full: `lint-typecheck-unit` (it reads the docs), `discover` (cheap, and the matrices keep every shard's
  check under its own name), `release-plan` (half a minute), `changeset-required`, `secret-scan` (a doc can leak a
  secret) and `repo-checks`' bidi scan (a doc can carry bidi characters). Every push to `main` runs everything.
- **Each job still runs and reports; only its steps are gated**, behind a visible "Skipped (docs-only change)" step.
  Rejected: a `paths:` filter on the trigger, which leaves a required check that never reports pending forever
  (CanopyCMS's `dual-build` comment); and job-level `if:` skips, under which a matrix never expands, so no shard
  reports under its own name, and which would make `all-checks` accept skips, weakening the one check an adopter
  requires.
- **The reusable workflow takes the answer as an input, `docs-only`, false by default**, so an adopter who sets
  nothing runs exactly what it did, and `all-checks` is unchanged: a job that ran its fast path concluded success.
  The contract job's Postgres service gets an empty image on the fast path, which starts none. Rejected: a pathspec
  input the reusable workflow evaluates itself, which would put diff logic in the file adopters pin, for a docs set
  that is theirs to decide.
- **Plain git, not `dorny/paths-filter`.** The script diffs the pull request's merge commit (two parents, as
  actions/checkout leaves it) against its first parent, the base as it is when the run starts, with `--no-renames`
  so a file moved out of code counts. Anything else answers false: another event, a HEAD that is not a merge commit,
  an empty diff, a path git quotes. Rejected: the action, a third-party dependency with the repository's checkout in
  reach, which lists a pull request's files through the API (`pull-requests: read`, a permission no job here has).
  The rulesets require the branch up to date, and bringing it up to date makes a new merge commit and a new run, so a
  fast path decided on an old base is never the one a merge goes on.
- **checks.yml's own jobs each run the script themselves; only the `sssb` call waits on a `changes` job**, because
  a reusable workflow's input must be known when the call starts. Rejected: every job `needs: changes`. A job whose
  dependency failed is skipped, and a skipped job reports as a passing check, so a failed `changes` would have turned
  `repo-checks`, `adoption-probe` and `pack-and-consume` green unrun. The `sssb` call runs `if: ${{ !cancelled() }}`
  and passes `docs-only` only when the output is exactly `true`. The script's step in `changes` is
  `continue-on-error`, so a script that fails leaves no answer and a green `changes`, and everything runs. A `changes`
  that fails outright (its checkout) never reads as the fast path either: should GitHub skip the called jobs for the
  failed dependency, `all-checks` fails. Either way the check is red or does the work, never green unrun.
- **What the fast path trusts, and what still catches a mistake in it.** That no job with a fast path reads a path
  the script counts as documentation: true when it was written (the readers of `docs/` outside `docs/releases/` are
  the unit tests and `sssb doctor`, all in `lint-typecheck-unit`), held only by review for a script added later, and
  by a test for a tracked symlink into those directories (`tests/tooling/docs-only.test.ts`). The push run on `main`
  is always the full one, and the release gate reads only push runs (`wait-for-checks`, `scripts/release.mjs`), so a
  mistake can reach `main` but never a release. And a docs-only pull request no longer notices a base that is already
  red: its own checks pass on the base's tested tree, as they would have on the same tree before.
- **What it saves, measured.** #78's full run (2026-11-19): 32 runner-minutes, 5m36s end to end. The probe,
  safeinsights/sssb#79 (one line of `docs/README.md`, closed unmerged): 8 runner-minutes, 5m57s end to end, every check
  green, each fast-path job done in 2 to 8 seconds with only its skip step run, and `contract` starting no database.
  So a docs-only pull request costs a quarter of the runner time, and the wall clock does not move:
  `lint-typecheck-unit` (5m41s on the probe) is the critical path and runs in full. Recorded as a future task
  (`.claude/future-tasks/docs-only-lint-typecheck-unit.md`): a docs-only mode for that job that runs only what reads
  the docs.

## The invitation mail carries the auth adapter's link (2026-11-19, `fix/realmode-invite-link`)

Found by ADR-0015's addendum review: SSSB mailed `/<locale>/accept-invite?invite=<id>`, the fake's link, in every mode,
while the real accept page reads Clerk's `__clerk_ticket`, so a real invitation could not be accepted from SSSB's mail.
JP asked for the fix. Decisions, with the rejected alternative:

- **The adapter builds the link**: `createInvite` takes `acceptPageUrl` and returns `CreatedInvite.acceptUrl`. The fake
  appends `?invite=<id>`; Clerk gets the page as `redirectUrl` and its invitation's `url` is returned. Rejected: the
  framework appending a provider-specific query itself, which would put Clerk's ticket format in shared code; and
  sending no SSSB mail in real mode, which gives up the app's own, translated invitation (ADR-0003's one UI, ADR-0008).
- **No link, no mail**: Clerk types `url` as nullable, and a mail with no working link is worse than none. Rejected:
  throwing, which would fail an invitation that Clerk may well have delivered itself.
- **The link never goes back to the inviter**: `sendOrgInvite` strips it from what it returns, because the route answers
  the inviter with it and the link is the invitee's credential.
- **A port change, filed `minor`**: an app that calls `createInvite` itself must pass `acceptPageUrl`.
- **Clerk gets the accept page as a path**, which its `redirectUrl` accepts ("The full URL or path"): the absolute URL
  is built from the request's URL, which names the server's own `localhost` behind `SssbApp`
  (`.claude/future-tasks/request-url-is-not-the-public-url.md`). Rejected: the absolute URL, which review showed would
  send every invitee, Clerk's own mail included, to `localhost`; and building a public origin from the forwarded
  headers here, which is that future task's whole job.
- **An existing user's invitation is handled**: setting `redirectUrl` sends every invitee to the accept form, and Clerk
  marks one who already has an account `__clerk_status=sign_in`, which takes `signIn.ticket()` (Clerk's guide to
  accepting organization invitations). The form takes the status as an optional prop, and `complete` (Clerk accepted it
  already) only redirects. Rejected: leaving it for later, which this change would have made a regression, since
  without `redirectUrl` Clerk's own flow handled it.
- **The form submits a ticket once, after Clerk has loaded**, reading Clerk's resources through a ref. Review found the
  sign-up path already submitting twice under StrictMode and again as clerk-js loaded and the resources changed
  identity; a ticket is single-use, so the second submission could report an error for an accepted invitation.
  Rejected: depending on the resources in the effect, which is what re-ran it.
- **Two invitation mails stay possible**: Clerk can deliver its own, and no API call turns that off per invitation, so
  the `auth-dev` row asks for the instance to be set so an invitee gets one.

## ADR-0015 addendum: auth as a provider bundle, datastores in tiers (2026-11-19, `docs/adr-0015-addendum`)

JP asked, after reading ADR-0015, why real auth is tied to Clerk when the fake works as an adapter, and whether an app
could forgo the tenancy promise or keep its data in another store (DynamoDB, say). He framed SSSB as separating an app's
logic, its simulated world and its tours from the vendors underneath, while staying honest about what each arrangement
can guarantee, and asked for this addendum. Decisions taken in writing it, several changed by its Opus review:

- **The unit of an auth swap is a bundle, and it owns the invitation link**; kit entry points that dispatch on
  `AUTH_PROVIDER` choose it. Rejected: `auth: 'app'` as a port alone, which leaves every other piece naming Clerk; and,
  as first drafted, a bundle with no way of being chosen, the app's route files still loading Clerk's modules by path.
- **Datastores in three tiers, each stating its guarantee.** Rejected: the body's "the engine stays fixed", which
  answered "can it be done" where the honest answer is "here is what each choice promises"; and other stores offered
  without a stated guarantee.
- **DynamoDB's `LeadingKeys` isolation is comparable to row-level security, not stronger**: whatever mints the
  per-tenant session holds the boundary, as `set_config` does, and the proof runs against AWS only. Rejected, as first
  drafted: "enforced by the database's access control" without those limits.
- **A single-tenant declaration means the deployment is the boundary, checked by boot refusing a second tenant**; on
  another store it replaces the per-table policies and two-tenant proofs. Rejected, as first drafted: tying it to the
  query-layer filter, which is several tenants in one store.
- **Auth as a bundle comes after the `app` mechanism, when an adopter needs another provider.** Rejected, as first
  drafted: ahead of the mechanism, which would build it on the hardest port or deliver a refactor no provider can use.
- **The invitation link is a separate fix, now**: the framework mails `/accept-invite?invite=<id>` in every mode, which
  Clerk's accept form, reading `__clerk_ticket`, cannot use.

## ADR-0015 accepted in part (2026-11-19, `docs/adr-0015-decision`)

JP agreed four points in chat ("Agree all four"), recorded as ADR-0015's second addendum, which sets its status to
Accepted in part; the work it starts is seven briefs under `.claude/future-tasks/`. Decisions taken in writing it:

- **Each work item is a future task**, the repository's home for designed-but-unbuilt work, linked from the addendum.
  Rejected: briefs inside the ADR, which is a dated record a builder should not have to edit as work lands.
- **The S3-compatible store is a storage choice of its own** (`s3-compatible`), not the `s3` choice reading an endpoint
  when one is set. The switch rule forbids choosing behaviour from which settings happen to be set. Rejected: the
  body's "the `s3` choice takes an endpoint", read literally.
- **The Postgres groundwork references today's modules rather than moving them**, so the doc-path gate's citations of
  `packages/kit/src/db/migrations/` stay true. Rejected: a tidy move into a family directory, which buys nothing a
  family object does not.
- **`CLAUDE.md` names ADR-0015 among those to follow, in the parts its second addendum accepts.** Rejected: leaving it
  out until every part is built, which would leave the accepted principles unstated where sessions read them first.
- **The addendum records the four agreed points and nothing more; every further detail is a brief's proposal** for
  its builder to decide and record (the registration's shapes, reserved names, how `SssbApp` learns names, the
  isolation values, the drift test, port versioning). Review found the first draft presenting those as decided.
  Rejected: settling them in the addendum, which would put words in the approver's mouth.
- **On an S3-compatible store the upload target is explicit**, a setting saying whether the store accepts presigned
  POST (MinIO does, R2 does not), never guessed from the endpoint. Rejected: refusing it always, which would take
  browser upload from stores that support it.

## `s3-compatible` storage choice (2026-11-19, `feat/storage-s3-compatible`)

Built from `.claude/future-tasks/resolved/storage-s3-compatible-choice.md` (ADR-0015, second addendum). Decisions taken
in building it:

- **`STORAGE_UPLOAD_TARGET` is a required setting of the choice, `post` or `none`.** The brief proposed the setting and
  left its default open. Either default is a guess that fails only when a browser first uploads: `post` on R2 fails at
  the first upload, `none` on MinIO silently drops a feature it has. Requiring it makes it the sixth variable of the
  choice, which costs nobody anything: the choice is new. Rejected: optional with a default of either.
- **A new `createCompatibleStorage` beside `createRealStorage`, which is unchanged.** The `s3` choice takes the bucket
  and the AWS region and must keep doing so. Rejected: widening `createRealStorage`'s parameters, which would make one
  function behave differently by which of them is set (the switch rule again).
- **Values that choose behaviour are checked where the adapter is built, and a wrong one fails at boot naming its
  variable**: `STORAGE_UPLOAD_TARGET` outside `post` and `none`, `STORAGE_FORCE_PATH_STYLE` outside `true` and `false`
  (an empty value is unset), `STORAGE_ENDPOINT` that is not an http(s) URL. Rejected: coercing (`TRUE`, `1`), which turns a
  typo into the other behaviour. `assertRealEnv` runs the same checks (below), after it has reported what is missing.
- **`STORAGE_FORCE_PATH_STYLE` unset leaves the SDK's own addressing**, never derived from the endpoint or the provider.
  MinIO needs `true`, and the adopter reference says so.
- **With `none`, `createUploadTarget` throws a plain `Error` naming `STORAGE_UPLOAD_TARGET`**, as the absent port
  throws, so a route that reaches it answers 500 and the log says which setting to change. Rejected: a port error class
  `withPortErrors` maps, since a deployment's declaration is a misconfiguration to the route that hits it, not a request
  the client can fix.
- **`SssbApp` sets only the switch for `s3-compatible`.** The endpoint, region and keys are the deployment's to add to
  `app.server`, and the construct never handles a secret. Rejected: new
  `SssbApp` props for the store's settings, which would put the key in a stack's template.
- **Three cutover rows**, two for the groups of settings the choice's `env` map names (`storage-compatible-store`,
  `storage-compatible-credentials`) and one for the live check (`storage-compatible-live`), which asks a round trip of
  every other port method against a real bucket on the chosen store. Rejected: one row for all six variables, which
  would make a missing key and a missing endpoint the same row, and reusing `cloud-accounts`, which says AWS.
- **The PUT form of the upload target is its own future task**, `storage-upload-target-put-form.md`, with `put` named as
  a third value of the same setting.
- **The compatible client sets `requestChecksumCalculation` and `responseChecksumValidation` to `WHEN_REQUIRED`; the
  `s3` choice keeps the SDK's default.** The default (since SDK v3.729) puts CRC32 on every PutObject, and Cloudflare tells
  R2 users to turn it down. It is not a full answer: DeleteObjects requires a checksum, so it still sends CRC32 and no
  Content-MD5 (measured against the installed SDK), which a store that insists on MD5 would refuse. Rejected: a
  middleware that adds Content-MD5 to DeleteObjects, a guess about stores nothing here can call; the live cutover row
  runs `delete` against the real store and says what to look for. `S3StorageOptions` gains the two settings, optional.
- **The values that choose behaviour are checked in `storage-settings.ts`, which loads no SDK, by the adapter and by
  `assertRealEnv`**, so `sssb check-real-env` refuses what the server would refuse at boot, as a `CutoverPendingError`
  naming `storage-compatible-store`. Rejected: checking only in the adapter, which let the preflight say "complete"
  for a value that stops the server. An endpoint carrying a user or password is refused and its error never repeats it;
  the upload-target and path-style errors do repeat their values, which are not secrets.
- **The apps' `params.ports.storage` type is widened to include `s3-compatible`**, the starter's too, so an adopter's
  generated app accepts the choice without editing the cast.

## The Postgres family's groundwork (2026-11-19, `feat/db-postgres-family`)

ADR-0015's second addendum, point 3, built from `db-postgres-family-groundwork.md`. Decisions its "proposed" details
left to the builder:

- **The family is two internal modules, split by who imports them.** The runtime half,
  `packages/kit/src/db/family.ts` (`DbFamily`, exported as `family`): the dialect helpers (`json`, `lockRow`,
  `currentTime`, `keysetSlice`), the `isolation` and the tenant scope (`runWithTenant`), which the data modules and the
  transports import on the request path. The suite half, `packages/kit/src/db/family-suite.ts` (`DbFamilySuite`,
  `familySuite`): loaders for the migrations, the migrator and the proof runner, imported only by the conformance
  suite and the contract runner. Both reference today's modules where they stand. Rejected: the loaders on the runtime
  object, as first built: a bundler follows a literal `import()`, so a server build took in the proof suite and the
  app's own `rls-proofs.ts`, which review measured on the starter's module graph. Neither is in `exports`. Rejected: a
  published subpath, which no adopter needs before a second family, and adding one is a deliberate act
  (`sssb/public-surface`).
- **The data modules reach the family through a module-level `family`, which is Postgres.** Rejected: a `family`
  member on `DbPort` now, a second break for every double before a second family exists to need it. Choosing the
  family from the app's declaration arrives with the second family, which may move it onto the port.
- **The keyset helper takes the whole slice** (cursor window, ordering, the `keyset_at` rendering and the limit), and
  `keyset.ts` keeps the paging (the clamp, the probe row, the cursor). Rejected: one helper per SQL fragment, which
  would still leave a raw `id` ordering and the `sql.ref` in the generic module.
- **`DbPort.isolation` is required.** The three Postgres transports and the proof runner's port declare the family's
  `'rls'`; the doubles in the showcase and the kit say `'rls'`; the changeset files `minor`, Kind seam, Action
  required. Rejected: optional, with an absent declaration meaning `'rls'`, which is an implied guarantee, the thing
  the addendum says SSSB never leaves.
- **`DbIsolation` is `'rls'` alone.** Rejected: the four candidate arrangements as values now, which would let a port
  declare a guarantee with no mechanism or proof behind it.
- **The fence is a repository test, `tests/lint/db-family-fence.test.ts`**, reading every module `@sssb/kit` ships
  with the TypeScript parser: a raw `sql` (by any name, re-export, namespace or dynamic import of `kysely`),
  `CompiledQuery`, a row lock (called, destructured or named), the jsonb module. Exempt by exact path, each with its
  reason; a stale exemption fails. It also holds the runtime half's import closure to Kysely, `jsonb.ts` and
  `with-tenant.ts` (a computed `import()` fails it), and the suite half to its two importers. Tests and stories are out
  of scope: they do not ship, and a test of the family's SQL has to write it. Rejected: a
  `sssb/*` rule in `@sssb/eslint-plugin`, which ships to every adopter for a fence that holds only this repository's
  framework tree.
- **The SQL is shown unchanged two ways**: `packages/kit/src/db/family.test.ts` compiles each helper's query beside
  the inline form its call site wrote and compares text and parameters; and the 407 distinct statements pglite
  received across the kit's db tests, the conformance suites and both apps' route and domain tests were recorded
  before the change and at its final commit, and were identical.
- **`sssb doctor` does not print the isolation yet.** With one family it is a constant. Proposed for the second family:
  the app declares its family in its `package.json`'s `sssb` block, which doctor already reads (the port slot), and the
  conformance suite holds that declaration to the port's `isolation`, so doctor never boots the adapter registry.
  Rejected: printing `rls` today, which reads as a choice the app made.

## Single-tenant sign-in, and a configurable tenant metadata key (2026-11-19, `feat/auth-single-tenant`)

JP decided: "yes I think we want such a mode so we don't have to set up a useless
tenantSlug. Separately, I hope the tenantSlug name is configurable." ADR-0003's addendum of this date records the
design; these are the calls made building it, each with the rejected alternative.

- **A new role, `none`, with no standing**, rather than mapping single-tenant users to `restricted`. The framework's
  rules let any member read its org's jobs, members and org record (`restricted` included), and on a shared Clerk
  instance that would be every user of the other product. Rejected as well: placing users in no org at all, which
  leaves the protected layout, data scoping and the app's own rules without the home org.
- **No standing means no `sameOrg`, in the framework's rules and in the predicate handed to the app's**, and no
  manage-all, refused both where the actor is built and in `defineAbilitiesFor`. The starter's one team is its staff
  org, so a generated app turned single-tenant would otherwise hand every user manage-all. Rejected: gating only the
  framework's rules, which leaves an app's `sameOrg`-based rules granting `none`.
- **One wrapper for both adapters** (`packages/kit/src/adapters/single-tenant-auth.ts`), fed by a small identity
  source each adapter supplies, so the mode's meaning is written and tested once. Clerk's source makes no
  organization call per request. Rejected: a branch inside each adapter.
- **The fake runs the mode when its environment sets it**, so a single-tenant app's `pnpm dev` places people as its
  deployment does. Rejected: leaving the fake multi-tenant, where seeded roles would grant what deployed users never
  have.
- **Per method:**
    - `listMembers` is empty: listing a shared instance's users would enumerate the other product's.
    - `createInvite` is refused: membership is implicit.
    - `getMember` answers `none` for an account Clerk still has, so a credential is judged as a session.
    - The home org is the only org, named by its slug, since the adapter reads no database.
- **A user whose metadata names a different tenant is refused**, so the mode switched on for a multi-tenant instance by
  mistake cannot merge its tenants. Users with no claim, a shared instance's other users, are admitted with `none`.
  Rejected: ignoring the claim, which would make that mistake a cross-tenant exposure.
- **An explicit switch, `AUTH_TENANCY`, set from `params.auth` and validated at synth and at boot**, refusing a
  single-mode slug left on a multi deployment. Rejected: inferring single mode from the slugs being set.
- **`sssb doctor` and the conformance suite gain nothing.** Doctor reads no deployment settings, and the conformance
  suite cannot tell an app rule that grants by its own list from one that grants by mistake. The kit's tests prove
  `none` gets nothing from the framework's rules and a false `sameOrg` in the app's, and the guide says how app rules
  must grant. Rejected: a conformance check running every app subject past a `none` actor, which would fail apps that
  rightly grant a person their own records.
- **Org-scoped reads authorize**, after the security review found that the reference apps' GET routes scope by the
  session's org after `requireUser()` alone, which in single mode would show the home org's items, tickets, jobs,
  attachments, escalations and webhook endpoints to every user of a shared Clerk instance. The starter's items GET and
  the showcase's org-scoped GETs now call `authorize(user, orgId, 'read', …)`, and the guide makes it a rule.
  Rejected: refusing a person without standing in the showcase's `resolveOrgContext`, which self-only routes share
  (accepting the terms among them), so a `none` user could not get past the agreement gate; and taking the home org
  off the session, which leaves the app's UI and its token credentials with no org. Not closed: the authorization scan
  still exempts GET handlers, so an app's own reads are held to this by the guide alone.
- **The app's rules see a person without standing as active in no org** (a sentinel no org id equals), so a rule that
  compares org ids itself, as the showcase's two-sided `Escalation` does, cannot grant `none`. Rejected: fixing only
  the showcase's rule, which leaves the pattern open to every app that copies it.
- **The simulated auth is one memoized function** (`packages/kit/src/adapters/fake/simulated-auth.ts`) shared by the
  registry, the fake job runner and the conformance replay, after review found job handlers and notifications in
  simulated single mode still on the bare fake. It is read on first use, so real mode, which imports the fakes too,
  reports a misconfigured switch through the boot check.
- **An unreadable tenant claim is refused.** Absent, null or empty is no claim. A non-string is not a slug, and
  admitting it would let a malformed claim through the tenant guard.
- **A refused person is not signed out**, reversing a first fix. Signing them out inside `getCurrentUser` changed a
  cookie while server components render, which Next refuses (every page failed in simulated single mode), and on
  Clerk it revoked the shared session on every call, so a link to this app would have ended the person's session in
  the other product. Rejected: that sign-out, and a refusal page with its own sign-out, left as a follow-up for a
  state a correct deployment does not reach.
- **The conformance preset replay runs the simulated auth, single mode included**: a preset that invites someone or
  signs in a person of another tenant describes a world single-tenant auth cannot reach, and that check exists to
  say so. Rejected: replaying on the bare fake, which would pass presets the deployment cannot replay.
- **Known and left open, from the security review's second round:** the showcase's `[id]` routes read a row before
  they authorize, so a `none` user can tell an existing id from a missing one (no data returned, ids opaque); and the
  authorization scan still exempts GET handlers. Both are recorded for a later change.
- **Single mode's seeded people keep a membership in the home org**, documented, rather than making the fake's session
  code work without one: the simulated sign-in resolves a membership, and a dev-only edge is not worth reworking it.

## A job kind says when its end is notified (2026-11-19, `feat/job-notify-on`)

An app may run its maintenance as an hourly in-process job, each run idempotent and time-budgeted so that a
cut-off run resumes the next hour. SSSB notified the home org's admins of every completed app job, so a routine job meant
24 in-app notifications, refused email attempts and `listMembers` calls (an identity-provider call in real mode) a day.
An adopter asked for a kind to opt out, or to notify only on failure, and for job retries with backoff.

- **The setting is an optional seam export, `jobNotify`, in `@sssb/app-config/jobs`**:
  `Partial<Record<AppJobKind, 'always' | 'failure' | 'never'>>`. A kind it does not name, and an app that has no export,
  is `always`: today's behaviour, so nothing changes for an existing kind. The framework's own kinds (`digest-email`)
  still never notify, as before, and a `jobNotify` entry cannot turn that on (the type names app kinds only; an entry
  for a framework kind is read by nothing). Rejected: **a `notify` field on each kind's registration**, as the brief
  sketched it. The registration is two parallel things, a `appJobKinds` tuple and a `jobHandlers` map of bare functions,
  and neither has a place for a field: making a handler `{ handler, notify }` changes the type every adopter's
  `jobHandlers` declares and every kit reader of it, so every app would break on upgrade for a setting most will never
  use. Rejected: **a property on the handler function** (`Object.assign(handler, { notify })`), which hides the setting
  in a value and which a re-wrapped handler silently drops.
- **It is optional as an export, read through the namespace**, as `db/seed.ts` reads `appSeedRows`:
  `import * as jobsSeam` and `jobsSeam['jobNotify']`. The earlier decision (2026-11-19, optional real ports) rejected "a
  new seam module" because a seam module cannot be optional; an optional export of an existing module can be, and this
  is what `appSeedRows` already is (`packages/kit/src/db/seed.ts:23`). Rejected: **a required export**, which would fail the typecheck of every adopter that has not
  added it, a `required` seam change for a setting whose default is the old behaviour.
- **The check is in `notifyJobTerminal`, before the org is read**, so a refused run costs no `listMembers` call, no in-app
  row and no email attempt. That function is the one hop every runner already ends in: the simulated runner, the
  in-process runner and its sweep (which fails a lost job and notifies it), and the jobs webhook route the CodeBuild
  runner completes through. Rejected: **gating in `runJobInProcess`**, which only two of the three runners run, so a
  CodeBuild job would notify what an in-process job did not, the dev-versus-deployment gap the simulated world exists to
  close.
- **`failure` means a job that ended `failed`, whatever failed it**: a handler's error, a failed build, and a job the
  sweep judges lost. Rejected: **`failure` excluding the sweep's**, which would silence the one failure nobody was
  watching.
- **A value that is not a mode counts as `always`.** The types refuse it, but a seam can be untyped, and the notification
  layer is never load-bearing: a typo must not silence a kind. Rejected: failing at boot, which turns a typo in a
  maintenance setting into an outage. Pinned in `server-lib/notify-opt-out.test.ts`, with the absent export and an entry
  for another kind.
- **The static demo takes the map as a `useDemoWorld` option, `jobNotify`**, and its twin skips a notification for
  `failure` and `never`, since the twin only ever completes a job. It cannot read the seam: the `jobs` seam module imports
  every server handler, and the twin deliberately does not (`world.ts`). `contracts.ts` imports the type only, and `world.ts` imports nothing new. Rejected:
  **calling the server's `notifiesOn` in the twin**, a value import of `core/jobs`, which reaches the seam. The showcase
  sets no `jobNotify`, so it passes none; an adopter that sets one and starts the kind in its demo passes the same map.
- **The fixture has a kind for each mode** (`export-dockets` says nothing, `sweep-dockets` is `failure`, `quiet-dockets`
  is `never`), and `server-lib/notify-opt-out.test.ts` runs every kind to both ends on the simulated runner, the
  in-process runner (and its sweep) and the CodeBuild runner's webhook sequence. Seen red first: with the check absent,
  10 of 21 runner cases failed, each one a refused run that still called `listMembers`.
- **The changeset files `minor`, Kind seam, Action optional**, as the brief asked, though Action `optional` could be a
  patch: the seam module's contract grew. It names `@sssb/create` too, for the plugin's `/sssb:new-job`.
- **Retries with backoff are recorded, not built**: `.claude/future-tasks/job-retries-with-backoff.md`. Its first
  decision (a retry as the same row or a new one) turns on terminal states, which the jobs webhook's idempotency rests on.

## The tenant and the organizations are separate choices (2026-11-20, `feat/auth-tenancy-and-org-source`)

JP found that single-tenant auth fixed the organization as well as the tenant, which turned off the provider's
organizations, roles, invitations and admin notifications, and asked what an app that uses Clerk without organizations
gets. ADR-0003's addendum of this date records the design; these are the calls made building it, each with the
rejected alternative.

- **Two settings, `AUTH_TENANCY` and `AUTH_ORG_SOURCE`.** Single tenancy fixes the tenant and nothing else. Rejected:
  a third tenancy value (`single-fixed`), which keeps the two questions in one switch, when a single tenancy over the
  provider's organizations is a mode of its own.
- **A fixed org source needs a single tenancy**, refused at synth and at boot otherwise, after both round-one reviewers
  found the gap. A fixed org source reads no org or role from the provider, so with a multi tenancy the tenant claim
  in the provider's metadata is all that places a person, and another product's operator on a shared instance writes
  that metadata. `getMember` could not check a credential against its org's tenant either: it is given an org slug,
  not a tenant. Rejected: allowing every pairing, as first built; and passing the org's tenant to `getMember`, a port
  change for a pairing no adopter has asked for. With ADR-0003's one provider instance per tenant, a deployment
  without organizations serves one tenant, which a single tenancy says.
- **The org source's values are `provider` and `fixed`.** Rejected: `single`, which reads as a tenancy, and `none`,
  which is wrong: the person is placed in an org.
- **A fixed org source's role is `none` by default, or `restricted`; nothing that writes.** On an instance shared with
  another product, everyone that product signs in gets the role, and `guest` can submit jobs and the app's
  `!restricted` writes. Rejected: `guest` as the default, and any role configurable. An app that wants more grants it
  through its own rules, for the people it knows.
- **A fixed org source reads no role from the provider.** Rejected: a role in the user's public metadata, which another
  product on a shared instance may write for its own reasons, and which would make that product's operator an admin of
  this app.
- **A home org that is the staff org, with `restricted`, is refused at boot**, and allowed with `none`. The staff org's
  members wield manage-all, and `restricted` has standing. Checked where the port is built
  (`fixedOrgProblem`), with the seam's `staffOrgSlug`. `SssbApp` cannot know the staff org at synth, so this one check
  is boot-only. Rejected: making manage-all require a managing role, which changes what every staff-org member has.
- **A fixed org source's members list is empty, and its invitations refused**, as the first single mode had them: the
  only list would be every account on the instance, another product's included, and a digest or an admin notification
  would mail them. Rejected: Clerk's user list as the members, and Clerk's instance invitations, which would create
  accounts on a shared instance.
- **A job's end reaches the person who started it when the team has no active admin.** The `jobs` table records them
  (`requested_by`, migration 0017), set by `submitJob`'s optional `requestedBy`, and the auth port's `getMember` says how
  to reach a person (`name`, `email`, optional). The rule does not ask which org source is on: an org on the provider's
  organizations whose admins have all left now tells the requester too, where before it told no one. Rejected: a
  configured list of admin user ids for a fixed org source, a second way to raise people that a deployment must
  defend; reading the submitter from the audit trail, which the app writes, not the framework; storing their email on
  the job, a copy of personal data; and a new port method, which a test double would lack.
- **Under a fixed org source no one passes SSSB's `Job` rule**: creating a job needs a member who is not restricted,
  and the source offers `none` and `restricted`. So the requester there is someone the app's own rules let start a
  job, on a subject of its own, and the guide and `/sssb:new-job` say so. Found by the claims pass, which caught the
  cutover row asking an operator to submit a job through a route that would refuse them. Rejected: letting `restricted`
  create jobs in this mode, which would hand job submission to every user of a shared instance.
- **`name` and `email` on `MemberStanding` are optional.** SSSB's adapters always fill them, but a required field would
  fail every app's typecheck that writes a stand-in `getMember` returning the old shape. A standing without an email is
  told in-app only.
- **A scheduled job, and the digest email, have no one to tell under a fixed org source.** Documented, with
  `jobNotify` `never` for a routine kind. Rejected: a fallback operator address, which is a setting of its own for a
  case no adopter has asked about.
- **A provider membership whose role is the string `none` stays `none`**, no standing, where before the role existed it
  fell back to `guest`. SSSB never writes that string (an invitation cannot grant it), so it is an operator's own word,
  and reading it as `guest` would grant more than they wrote. Rejected: mapping it back to `guest`. Pinned in
  `packages/kit/src/adapters/real/auth-tenancy.test.ts`.
- **One module applies both settings, `configured-auth.ts`, replacing `single-tenant-auth.ts`**, and on the defaults it
  returns the adapter itself, so a deployment that sets nothing makes no extra call. Single tenancy over the provider's
  organizations reads the signed-in account through the identity source (for the raw claim, which the adapter's user
  folds into `''`) and then the adapter's user, and refuses a mismatch of the two ids. That is two reads of the
  account, which on Clerk may be two user requests per call; the cutover row says to measure it. Rejected: two stacked
  wrappers, one per setting, each reading the identity on its own.
- **The tenant guard now also covers `createInvite`, `setActiveOrg` and `listMyOrgs` over the provider's
  organizations**, which call the adapter only once the port has a user. The adapter checks only that someone is signed
  in.
- **`listMembers` under single tenancy is the provider's, unfiltered.** An org's membership is the provider's own grant,
  and filtering it by each member's claim is a request per member. A member whose claim names another tenant is still
  refused as a credential (`getMember`) and in session.
- **The first single mode's settings are refused, not translated.** `AUTH_TENANCY=single` with `AUTH_HOME_ORG_SLUG` and no
  org source fails at boot ("set AUTH_ORG_SOURCE=fixed"), as `params.auth` with `homeOrgSlug` fails at synth. It never
  shipped in a release, so no deployment has it. Rejected: reading `homeOrgSlug` as an implied fixed org source, the
  inference the explicit switch exists to prevent.
- **Adopter names that the first single mode's records carried are taken out of the records it added**, which have not
  reached `main`, as well as out of the changesets, the future task and the ADR addendum: the dependency runs from an
  adopter to SSSB, never back.

## Baseline review of 0.4.0 (2026-11-20, `fix/post-0.4.0-baseline-review`)

Five reviewers read the whole repository at 4dc9a89, the commit 0.4.0 was cut from (its release commit is dfc5cdd), one area each; five workers fixed
what was confirmed, and each reviewer then read its area's fix diff. JP was away, so these were decided without him.

- **`@sssb/kit/core/same-origin-path` is published.** The starter's sign-in page guarded `returnTo` with a prefix test
  a browser does not share (`/\\host`, a tab). The kit already had the right function, and the starter may import only
  published subpaths. Rejected: an inline check in each app, which is the copy that went wrong.
- **The authorization scan is stricter, and reads Server Actions.** ADR-0012's 2026-11-20 addendum has the rules.
  Rejected: documenting the floating-denial shapes as a "trusted callee" limit, since the scan's header already
  claimed them; a lint rule for `'use server'`, which would not read what the action does. A Server Action can match
  no exemption, as a mutating route outside `src/app/api` cannot. This can fail an adopter's conformance run on
  upgrade: the changeset names every newly refused shape.
- **A job left `queued` is failed by the in-process sweep, never run.** A job whose `start()` failed or never ran
  stayed queued for ever, and the schedule that spawned it had already advanced. After `IN_PROCESS_LOST_AFTER_MS` the
  sweep fails it ("lost: never started") and notifies. Age alone is enough because the sweep exists only with
  `JOBS_RUNNER=in-process`, where every job is that runner's. Rejected: putting `next_run_at` back when `start()`
  throws, which makes scheduled work at-least-once and cannot be done for an invocation that died. Known edge: a
  deployment switched from `codebuild` to `in-process` with builds in flight sees those jobs failed after five
  minutes; drain them first.
- **The email port takes exactly one address**, in the real adapter and the fake alike, so a test on the simulated
  world catches a list in `to`. `sendTemplate` collapses line breaks in a composed subject; the port refuses them
  from a direct caller.
- **A simulated-only POST answers 415 unless it is JSON**, in both apps, body-less ones included, as the kit's own
  simulator API already did: a cross-origin "simple" POST could sign in as a seeded person or wipe the world on a
  developer's machine. The one exception, which the test names, is the showcase's fake storage upload target: it takes a multipart POST under its signed policy.
- **The contract runner connects through the real `pg` adapter.** It built a bare pool, so an app's contract pass
  proved a driver configuration it does not deploy (a `date` column came back as a `Date`).
- **The proxy matcher's excluded prefixes end at a slash** (`api(?:/|$)`, `_next/`, `_vercel/`), and the proxy's API
  branch matches `/api` or `/api/...`. `/apiary` is a page and reaches the auth provider's middleware. The earlier
  entry kept the prefix match only to preserve behaviour.
- **`sssb.vendors` entries are a package name, one subpath of it, either followed by `/*`, or a whole scope.** The
  declaration half read gitignore patterns and the `import()` half did not, so most other patterns banned one form
  and passed the other. Rejected: matching the dynamic half with the same matcher, which changes SSSB's own list.
- **A linked git worktree anywhere derives its ports**, by a `.git` file that points into `worktrees/`, not only
  under `.claude/worktrees/`: the guide already promised it. A submodule keeps the defaults.
- **`sssb/no-path-into-kit` is a new app-side fence.** `sssb/public-surface` judged only `@sssb/kit/...` specifiers,
  and the kit ships its source, so a relative path through `node_modules` reached any internal. With it, the
  conformance suite's check that `appDir` is the suite file's own package cannot be stepped round without a lint
  failure; that check's exemption is internal to the kit.
- **CI checkouts keep no credentials** (`persist-credentials: false` in `checks.yml`, the reusable `app-checks.yml`
  and the generated workflow), and the secret scan checks gitleaks' tarball against the sha256 its release publishes.
  A gitleaks version bump changes the URL and the digest together.
- **`release-app verify` holds the `npm-publish` environment to tag `v*`**, and `planBypass` holds the main ruleset
  to main alone: the tool's own claims, which it did not check.
- **Deferred, each needing a design decision**: `.claude/future-tasks/baseline-review-0-4-0-deferred.md`.

### Adopter names out of SSSB's live files (2026-11-20)

JP's rule: SSSB's code, docs and tasks do not talk about a specific adopter, because the dependency arrow runs from
the adopter to SSSB. The sweep rewrote every live mention in general terms and left the dated records (this log, the
build notes, ADR bodies, release notes, changelogs, resolved tasks, the adoption review) as they are.

- **Pack and consume's `pages` shape is now `multi-app`** (`--shape multi-app|generated`, the step names, `checks.yml`,
  `CLAUDE.md`). The job name `pack-and-consume` is unchanged, so no required check changes.
- **Credits to a sibling project's code ("borrowed from", "modeled on") stay.** They record where code came from, not
  who adopts SSSB. Rejected: rewriting them to "an upstream project", which loses the pointer to the source.
- **The vouched org-ruleset bypass entry** names its bot generically in the report text; its App id, the part that
  matches, is unchanged.
- **No automated gate.** A check that fails on a named adopter must contain the name, which is the mention it forbids,
  and the bare word "pages" is also Next's term, paging and web pages, so a precise pattern does not exist. The house
  rule and review carry it.

## A fixed org source in first use: restricted people, the refused account, the home org's name (2026-11-20, `fix/auth-fixed-source-followups`)

An adopter running a single tenancy with a fixed org source, default role `none`, found three gaps. ADR-0003's second
addendum of this date records the design; these are the calls, each with the rejected alternative.

- **`none` stays restricted, and the guide says how an app grants its own people.** Under a fixed org source everyone
  is `none` (or `restricted`), so an app rule that denies on `restricted` before anything else locks out everyone,
  the app's own admins included. The fix is the order of the app's own checks: grant from the app's own data first,
  then deny on `restricted`. The guide, the adopter reference and the release note say so, and
  `packages/kit/src/core/abilities-fixed-grants.test.ts` pins the grant-first order and that `none` is still restricted.
  Rejected: **`none` no longer implying `restricted`**. SSSB's own rules would grant nothing more (each also needs
  `sameOrg` or the person themself), but every person on a shared identity-provider instance would turn unrestricted
  in the next release. Any app code that gates on `!restricted` alone (a rule against the guide, a route's `if (user.restricted)`,
  a screen hiding a feature) would open to them, including code written against 0.6.0. Fail-closed is kept: the
  lockout is visible at once and the app fixes it in its own rule; the opening would be silent. Rejected: **a seam
  hook that lifts a person's role from the app's data**. It is a second way to raise people that the auth port would
  have to read on every request, for what the app's own rule already expresses.
- **A refused person is told why on the sign-in page, and signs out only by choosing to.** The auth port gains an
  optional `refusal()`, answered by the configured port from the same identity read as its guard, and read on the
  sign-in page only. The framework's `AccountRefused` says the account belongs to another site, warns before the click
  that signing out reaches other sites sharing the sign-in, and signs out on the click: in simulated mode through the
  app's sign-out route, in real mode through Clerk's client (below). Rejected: a
  separate refusal page reached from the protected layout, as the future task sketched, which reads the refusal on
  every protected request when every refused person already lands on the sign-in page; a distinct return value from
  `getCurrentUser`, which every caller would have to tell apart from null; and signing out automatically.
- **`refusal` is optional on the port.** Only a port that refuses people has one, and an app's stand-in `AuthPort`
  keeps compiling. The sign-in page calls `auth.refusal?.()`.
- **The home org is named by its org row, read through a lookup the port's builder hands it**
  (`orgNameForSlugs`, `packages/kit/src/db/org-lookup.ts`). The configured port is built where the database is
  (`real/index.ts`, `fake/simulated-auth.ts`), so `configured-auth.ts` still imports no database. It is read per
  `listMyOrgs` call, so a rename shows at once; the slug stands in when the row is missing. Rejected: a
  `homeOrgName` setting, a second copy of the name that drifts from the row; reading the database inside
  `configured-auth.ts`; and caching the name for the process.
- **The app's own grant is keyed on `userId` and, for what only the person at the keyboard may do, on a session**,
  after the round-one Fable reviewer found that every person credential reaches an app's rules. Under a fixed org source
  `getMember` gives an admin's API token or inbound email the same `userId`, so a grant made before the restricted
  denial would reach them too. The guide, the adopter reference and the test say so. Rejected: having the framework
  restrict app rules to sessions, which would break an app's token and email paths that are meant to act.
- **Real mode signs out through Clerk's client** (`RealAccountRefused`, `packages/kit/src/adapters/real/account-refused-form.tsx`),
  after both round-one reviewers found that the server-side revocation alone leaves the browser's short-lived session
  token, so the reload would land on the same refused screen. It ends this one session (`sessionId`) and returns to the
  page through Clerk's own `redirectUrl`, and does nothing (and says so) until Clerk has loaded and knows the session,
  since before then Clerk only queues the call and with no session id it would end every session on the device, as
  round two found. Its module is a form the conformance check `real-auth-provider` looks for. Rejected: making the
  server's sign-out tolerate a second, already-revoked call, which hides the symptom. The user menu's sign-out has the
  same gap and is recorded as `.claude/future-tasks/header-sign-out-stale-session-token.md`.
- **The sign-out route takes JSON only**, in both reference apps (`refuseNonJson`), and its callers send it. The route
  is older than this change, but a page on a sibling subdomain, the topology of a shared instance, could post a plain
  form to it with the session cookie and sign a person out of both products with no click. A JSON post from another
  origin needs a preflight, which fails. Rejected: an `Origin` check, which needs the app's public origin, which the
  server does not reliably know behind `SssbApp`.
- **A failed home-org name lookup falls back to the slug.** The lookup now runs on every protected page, and a display
  name must not turn a database hiccup into a failed page.

## The Migrator's ESM bundle defines `require` (2026-11-20, `fix/cdk-migrator-bundle`)

`SssbApp`'s Migrator crashed on load in Lambda with `Dynamic require of "events" is not supported`: esbuild inlines
`pg` (CommonJS) into the handler's ESM bundle, and its `require('events')` runs as the handler module loads, on either
transport, because the handler imports the `pg` transport statically.

- **A `createRequire` banner on the Migrator's bundle**, under its own import name (`__sssbCreateRequire`) so it cannot
  collide with a bundled module's. Rejected: `format: CJS`, which changes the deployed artifact's format for no gain
  today and would fail on any ES-module-only code the kit adds (top-level `await`, `import.meta`). Rejected: keeping
  `pg` out of the Data API path's bundle, which leaves the `pg` transport, `SssbApp`'s default, crashing; and esbuild
  without code splitting inlines a dynamic `import()` anyway, so a lazy import alone would only defer the crash to the
  first `pg` migrate.
- **The test loads every Node.js Lambda the synth staged in a child `node` process**, as Lambda's runtime loads it (an
  `.mjs` by import, a CommonJS `.js` by require), with the kit's installed AWS SDK v3 standing in for the runtime's.
  Rejected: `import()` inside Vitest, whose module runner supplies a `require`: the crashing bundle loaded cleanly
  under it.
- **Only the Migrator is a `NodejsFunction`.** The body-hash Lambda@Edge and the scheduled tick are plain ES modules
  shipped as written (`Code.fromAsset`), and the server is the deploy pipeline's zip; the test loads the first two as
  well. CDK's own provider functions are not loaded: they need SDK clients the kit may not install, which the test's
  stand-in for the runtime's SDK lacks.
- **A live first migrate is the only full proof**, a step in the `deploy-pipeline` cutover row.

## The Data API refuses a `"char"` result, and the emulator does too (2026-11-20, `fix/data-api-char-columns`)

On the Data API the Migrator failed on its first statement with `UnsupportedResultException: The result contains the
unsupported data type "CHAR"`. Kysely's Migrator first asks its introspector whether its own tables exist, and Kysely's
Postgres introspector selects `pg_class.relkind`, a one-byte `"char"`. The emulator returned it, so the contract run
passed.

- **The dialect supplies its own introspector** (`RdsDataIntrospector`, `packages/kit/src/adapters/real/rds-data-dialect.ts`):
  Kysely 0.29's `getTables` query with `relkind::text`, and its `getSchemas` unchanged. The contract suite holds it to
  Kysely's introspector on the same database. Rejected: a Kysely plugin rewriting `relkind` in Kysely's own query,
  which ties the fix to that query's node shape. Rejected: a migration provider or a Migrator that skips
  introspection, which Kysely's Migrator does not offer (it always checks for its tables). Rejected: casting in the
  driver, which cannot know a column's type before the Data API has refused it.
- **The emulator refuses a result whose columns include `"char"`, `char(n)` or an array of either**, whole, with or
  without rows, with the exception and message the Data API gave for `"char"` (`REFUSED_RESULT_TYPES`). AWS documents
  no list ("The Data API doesn't support all data types", its troubleshooting page), so the map is evidence, read
  strictly: `"char"` was refused live, for a result of no rows; `char(n)` is the same JDBC type (`CHAR`) in PgJDBC, on
  which the Data API is built, and the arrays carry those elements, so both are refused by inference (wrong if the
  error's "CHAR" is the type's own name upper-cased). The runbook's step 3 records what AWS does with each, and the map
  follows it. Rejected: refusing only `"char"`, which would let a `char(n)` column pass the contract run and fail live
  on the worse reading of the same evidence. Rejected: guessing further types (`name`, `void`), which the contract run
  reads through the Data API and nothing has seen refused. The emulator refuses after the statement has run, so a
  refused `RETURNING` keeps its write; whether AWS does is also step 3's to record.
- **Every result type the contract run reads through the Data API was listed**: `text`, `uuid`, `_text`,
  `timestamptz`, `name`, `bool`, `jsonb`, `int4`, `varchar`, `void`, `date`, `_date`, `int8`, `_int4`, `numeric`,
  `float8`, `bytea`, `bit`, `_uuid`, an enum and its array, and `bpchar` and `_bpchar` in the parity test only. SSSB's
  own catalog reads already cast (`rls-coverage.ts` reads `relkind::text`); the conformance suite's run on pglite only.
- **A known limit, Kysely's and now visible**: the Migrator's introspection returns one row per column of every table
  the role can see, three or four times a run, and on the Data API a response over 1 MiB is refused. Far beyond SSSB's
  apps (a few thousand columns, estimated), so recorded, not worked around.
- **The gate covers what the contract run sends**: the migrations, the isolation proofs and the owner pass, through the
  Data API. The framework's runtime queries return only its tables' columns, none of them `char`, and an app's own
  queries are the app's, which the changeset tells adopters.
- **The live proof is the `data-api` cutover row's smoke run**: the Migrator on an empty database, and the runbook's
  reads of the refused types (`docs/runbooks/data-api.md`, step 3).

## One wait for a paused cluster, and a typed error after it (2026-11-24, `fix/data-api-resume`)

safeinsights/sssb#183: a cold Data API request could spend most of the server's 30 seconds waiting for a paused cluster,
and a resume or a throttle the dialect did not wait out reached the app as an AWS error name.

- **What AWS says about each error, and so what is sent again.** `DatabaseResumingException`: "A request was cancelled
  because the Aurora Serverless DB instance was paused [...] Wait a few seconds and try again"
  ([ExecuteStatement](https://docs.aws.amazon.com/rdsdataservice/latest/APIReference/API_ExecuteStatement.html), read
  2026-11-24), so it did not run. `ThrottlingException` is in none of the error lists of ExecuteStatement,
  BeginTransaction and CommitTransaction, and neither the troubleshooting page nor the limitations page mentions
  throttling. The [SDK guide](https://docs.aws.amazon.com/sdkref/latest/guide/feature-retry-behavior.html) says in
  general that a throttled request was "actively rejected", but says nothing of whether this service's throttle
  precedes the statement. (An adopter reported, 2026-11-24, that its log showed the throttle while a cluster woke, as
  "The request was throttled because of insufficient resources on the database", and that its app also takes a
  `BadRequestException` saying "is resuming" as a resume. Nothing was run against AWS to check either.) A
  `BadRequestException` is only "an error in the call or in a SQL statement", deprecated; no page read ties it to a
  resume. `StatementTimeoutException`: the
  [timeouts page](https://docs.aws.amazon.com/AmazonRDS/latest/AuroraUserGuide/data-api-timeouts.html) says an operation over 45
  seconds is cancelled and its data not inserted, and warns that retrying one whose SDK call timed out "might insert
  duplicate data", so it is not sent again. A statement is therefore sent again after `DatabaseResumingException`
  alone, and only when it is the error itself: one found in a cause chain may belong to an earlier attempt under a
  later error. Rejected: retrying a throttled statement on the SDK guide's sentence, which a write would pay for if it
  is wrong.
- **`BeginTransaction` is sent again after a throttle or a `BadRequestException` that says resuming as well.** It runs no
  statement, so this needs no promise from AWS: at worst an empty transaction stays open until its three idle minutes
  end. `withTenant` and the describe step both open with one, so a request that starts with either is covered. Rejected:
  only while this process knows of a resume, which leaves a second cold process, whose first answer is the throttle, with
  an immediate failure. The cost is that a throttle for real load also waits, one probe a second for the process. It
  holds up only the calls that were throttled: a call not yet sent waits only once the database has said it is resuming.
- **In a transaction, only until a statement has succeeded in it.** A cluster with an open connection does not pause
  (AWS's auto-pause page), so a resume answered after that means the session, and the transaction's work, is gone:
  nothing is left to go on with, and a resend would at best fail. A transaction's first statement is still resent, since
  nothing documents that a begun transaction has reached the database. Commits and rollbacks are never sent again;
  CommitTransaction does not list the exception. A rollback answered with a resume
  counts as done, so it does not replace the error that caused it.
- **The wait polls with `SELECT 1`, not with the waiting call.** Safe to repeat after any failure, so a throttle during
  the poll is part of the resume, and a write is sent before it and after it, not during. It ends when nobody waits, so a
  wait that failed holds no later call. A probe that has not answered in 2 s is left behind and the next one sent (the SDK's
  client has no request timeout, and one dead connection would otherwise hold every call that joined, database up or not);
  if it answers late, that still ends the wait. Rejected: a request timeout on the SDK's client, which would cut off
  statements too. Rejected: the first caller's own command as the probe, which cannot go on past
  a throttle when it is a statement. Rejected: `BeginTransaction` as the probe, which leaves a transaction to roll back
  and, if it does not reach the database, reports a resume that has not happened.
- **After 1, 2 and 4 seconds, a probe every second.** The issue proposed keeping the 8 s step and polling after it. The
  measured resumes took 12 to 14 s, which fall inside that step and would still be seen at 15, so it is gone.
- **The default budget is 18 seconds per call.** The measured cold request took 26 s; the 12 to 14 s resume was seen at
  15 on the old schedule, so about 11 s went elsewhere. 18 leaves 12 under the server's 30 and covers AWS's
  "approximately 15 seconds". A Lambda's init (1.7 s there) is billed but comes before the invoke phase the timeout
  limits. Rejected: 25 s, to reach further into the 30 s or longer of a day's pause, which no budget inside the timeout
  covers, at the price of a Lambda timeout instead of an answer. Each call has its own deadline, so a call that joins
  late is not failed by one that joined early. The migrator waits 120 s: nobody is waiting on it and its Lambda has
  five minutes.
- **`DATABASE_RESUME_BUDGET_MS` sets it, checked at boot.** The app never builds the dialect, so a config option alone
  could not be reached. Rejected: a key in `params.database`, which would make every app's `config/params.ts` carry it
  (both hold the same keys) and the construct set it, for a number most deployments leave alone.
- **`DatabaseUnavailableError` is a port error (`@sssb/kit/ports/errors`),** beside the ones `withPortErrors` maps, with a
  `reason` in no vendor's words and AWS's error as its `cause`. Rejected: a kind on `RdsDataDatabaseError`, which no
  published subpath exports and whose `code` means a SQLSTATE. It replaces the thrown error for the two AWS names it
  adds, `DatabaseUnavailableException` and `ServiceUnavailableError`, as well as the resume, the throttle and the
  timeout, so an app that matched the thrown error's `name` (not its cause's) must change: hence the minor. Rejected: a
  flag saying whether the work may have run. One request makes many calls, so it could not speak for the request.
- **Both apps' `withPortErrors` answers it with a 503, `Retry-After: 5` and a logged warning.** That function is the
  app's, so an adopter applies it by hand (its own changeset). Five seconds because, after a resume, a client that asks
  again joins or starts a wait anyway.
- **`normalizeDatabaseError` is unchanged**, and the text of an error recognised as SQL (`ERROR:`, a SQLSTATE, or a
  Postgres message it knows) is never read for "is resuming": Postgres quotes row text in it.

## Avatar initials are the first and last letter-words (2026-11-24, `fix/avatar-initials`)

`safeinsights/sssb#182`: Mantine's `Avatar` `name` prop shows the first character of each of the first two words (the
first two characters of a one-word name), so `Ana (Bea) Cruz` showed `A(`. `UserMenu` and `PreviewRow` now pass the `Avatar` children from
`avatarInitials(name, fallback)` (`packages/kit/src/components/auth/initials.ts`).

- **The rule**: the first letter of the first and the last word that starts with a letter (`\p{L}`), uppercased; one
  such word gives one letter. Rejected: the first two letter-words (`AB`), which shows a middle name where a surname
  belongs and differs from the rule an adopter already uses. Rejected: Mantine's own rule with punctuation stripped, which
  would keep the first two words, not the last.
- **No letter-word falls back to the first letter, or digit, of the `fallback`**: the email in the user menu, the title
  in `PreviewRow` where a caller names none (a team called `3M` shows `3`, not an icon). With neither, the children are
  empty and `Avatar` draws its placeholder icon. Rejected: the email's first character whatever it is, which would show
  `.` or `_` for an address that opens with one.
- **Not exported.** `PreviewRow` is internal, `UserMenu` and `OrgSwitcher` are the screens that show initials, and an
  app's own avatar is one `Avatar` with its own children. An `exports` entry is a promise, and nothing asks for one; it
  takes an entry and a changeset of Kind `seam` the day an app's screen needs it. Rejected: exporting now.
- **A new `fallback` prop on `PreviewRow`** (optional, internal). Rejected: reading the email out of `subtitle`, a
  `ReactNode`.
- `ß` uppercases to `SS`, the language's own `toUpperCase`; a letter outside the BMP is kept whole (`Array.from`),
  which the unit test pins.

## Signing in with an enrolled second factor (2026-11-25, `feat/second-factor-sign-in`)

`safeinsights/sssb#186`: the real sign-in form met Clerk's `needs_second_factor` with a message that it was not built, so
an instance that requires a second factor could not use the form. What Clerk offers was read from `@clerk/nextjs` 7.10.0's types
and from clerk-js's source (clerk/javascript, `SignIn.ts`, read that day; clerk-js itself is loaded from Clerk, not
installed). Nothing here has run against a real instance (`auth-dev`).

- **Four kinds of code: authenticator app, text message, email, backup code.** The sent ones cost two calls that take no
  argument (`mfa.sendPhoneCode`, `mfa.sendEmailCode`), so they are in. Rejected: TOTP and backup codes alone, which would
  leave out an account whose only code is a sent one.
- **Passkeys and emailed links are left out.** A passkey is a WebAuthn ceremony with no code to type, and an emailed link
  needs a landing page that tells the waiting tab. An account that offers only those gets the unsupported message on
  the password step; one that also offers a code gets the code. `safeinsights/sssb#195` has them.
- **Device trust is the same step.** `needs_client_trust` is answered by the same `signIn.mfa` calls, so it shows the same
  step with a lead of its own. Rejected: the unsupported message, which would shut out every person on a new browser
  wherever an instance has the check on.
- **Every other status has a rule.** `needs_identifier` and `needs_first_factor` (Clerk did not take the password) are the
  generic error, as before. Anything else, a status a later Clerk adds included, is the unsupported message, which says to
  ask whoever manages the account: the generic error told people with the right password to check it. Only `complete`
  reaches `finalize`, on the password step and the code step alike.
- **Clerk's order, with backup codes last.** The issue says to preselect the first factor the provider reports. A backup
  code is spent by use, so it is never preselected while the account offers another. Rejected: the order of Clerk's own
  UI (a passkey, then an authenticator, then a phone: `determineStartingSignInSecondFactor` in clerk/javascript), which the
  issue did not ask for.
- **One choice per kind, naming Clerk's first number or address.** `sendPhoneCode` and `sendEmailCode` send to the first the
  attempt lists and take no id, so a second number could be shown but not used. Rejected: the older `prepareSecondFactor`,
  which takes an id but is not the signals API the form is written in.
- **The step opens by sending, then waits 30 seconds between sends of a kind.** Going to another factor and back inside that sends
  nothing. A send that failed has no wait. Clerk's own rate limit is what protects the number; the cooldown saves a
  person from pressing twice.
- **One error for a refused, expired or rate-limited code, a thrown call and a failed `finalize`**, with every choice and the way
  back still open. Rejected: telling them apart, as the password step does not either.
- **A `finalize` that fails after the code was accepted is retried without verifying again**: the code is spent, so verifying
  would refuse it for ever. Only once Clerk accepted the step's code, and only while the attempt is complete. Rejected:
  finalizing any complete attempt, which would let a refused code stand in for an accepted one.
- **The step keeps the attempt its password opened** and makes every call on it, never on the hook's `signIn`, which a client
  update replaces: another tab's sign-in, a code sent before the person went back, or the empty attempt a `finalize` that
  fails half-way leaves. Rejected: the hook's object with the attempt's id checked against it, which a review round showed
  verifying the spent code against the empty attempt. A password submitted before clerk-js has loaded holds the
  hook's placeholder instead, which follows the hook, so there that case is still open and the way out is back. There a dropped password also counts as taken, so the form acts on
  an attempt the client already held (no factor is skipped: Clerk verifies it). Recorded, with a session that a failed
  `finalize` leaves after the person goes back, as `safeinsights/sssb#198`.
- **A password or a sent code Clerk never answered is an error.** Where clerk-js takes the browser to be offline (or not a
  browser: its test includes the user agent, so some in-app browsers fail it) it drops a failed request and answers no
  error. So a call is taken when it answers no error and anything about the attempt changed: its id, its status, its
  verification object, or that object's status, strategy or expiry. A first
  password moves the status, so a build that stopped rebuilding the verification could not refuse it; a later one, at the
  same status, is told by the new attempt's id (which Clerk's server assigns; not seen live) or by the verification. A
  sent code moves neither. If it worked and the check missed it, the person reads that it could not be sent, and can still
  enter it: verifying does not ask the check. Rejected: the verification object alone, which made every
  sign-in depend on it. Rejected: `navigator.onLine`, which is only part of clerk-js's test.
- **The verification was read in the builds, not only the source.** `@clerk/nextjs` 7.10.0 loads clerk-js by major: `versionSelector` in
  `@clerk/shared` 4.45.1 answers `6`, its package version 6.43.1's major. From npm, `dist/clerk.browser.js` of 6.0.0,
  6.43.1 and 6.47.0 (npm's `latest` on 2026-11-25): in each, `SignIn.fromJSON` sets `id` and `status` and makes a
  new second-factor verification object from every response that has data, `_baseMutate` (which the password and the code calls go
  through) calls it, the hook's `secondFactorVerification` reads the resource's, `password` posts to the collection, and a
  failed request the browser test calls offline returns null with no error. Which 6.x Clerk serves is Clerk's to say.
- **The second click of a double click is ignored on the choices and the way back** (500 ms): the buttons move under the pointer when
  a factor is chosen, and the next one could send a text or drop the attempt. Rejected: every factor always listed, the
  chosen one included, which puts as many buttons as factors between the person and the field.
- **The step is a framework component that knows no vendor**, `SecondFactorStep`, with callbacks for sending and verifying, as
  `AccountRefused` is under its real form. That is what makes it a Ladle story and lets a client-side auth port
  (`safeinsights/sssb#102`) render it unchanged. It reads the catalog itself rather than take `labels`: twenty more
  required labels would break every adopter's sign-in page to say what the framework already says. It is not exported;
  nothing outside the kit renders it.
- **`mfaNotImplemented` is gone from `SignInLabels` and the catalog**, so an adopter's page drops one line. Rejected: keeping the key as
  the unsupported message, under a name that says the opposite.
- **No twin in the static demo or simulated mode.** Both sign in by picking a person, with no password for a second step to follow;
  a step there would accept anything and show a security check that checks nothing. The story is where it is seen.
  `safeinsights/sssb#102` wants demo twins for enrollment, which has state to show.
- **`axe-core` is a development dependency of the repository**, for the step's own accessibility test. The e2e sweep
  reaches only pages simulated mode serves, and this is not one. Colour contrast needs a layout engine and is not in it, so
  it was run once by hand in Chromium, on Mantine's default colours with a primary shade of 8: it found the code in Mantine's error red too pale, which
  the step now overrides.
- **Not done: the accept-invite form.** Its ticket sign-in for an existing account meets the same statuses and still ends in its generic
  error (`safeinsights/sssb#194`).

## Authorized parties for Clerk session tokens (2026-11-25, `feat/clerk-authorized-parties`)

`safeinsights/sssb#185`: a deployment could not name the origins whose Clerk session tokens it accepts, so any token
the instance signed passed, whatever its `azp` claim said. `CLERK_AUTHORIZED_PARTIES` now reaches Clerk's middleware as
`authorizedParties` (`packages/kit/src/adapters/real/clerk-authorized-parties.ts`, read in `clerk-proxy.ts`). JP's
standing rule for these sessions: decide, and record the rejected alternative.

- **What Clerk does with the list** (read in the installed @clerk/backend 3.29 and @clerk/nextjs 7.10).
  `assertAuthorizedPartiesClaim` (`@clerk/backend/dist/internal.js:795`) runs inside `verifyJwt` (`:1014`), after the
  signature check and before the expiry checks, on every session token `authenticateRequest` verifies: the cookie's
  (`:8303`), the one a refresh returns (`:8083`), and the one a handshake sets (`:7735`). With a non-empty list, a token whose `azp` is not exactly one of the strings is refused, and so is a token with
  no `azp` (`!azp`); unset, or `[]`, there is no check, and a token with no `azp` is accepted with a one-time warning
  that a later Clerk will refuse it (`:8307`). The comparison is `Array.includes` on strings: no origin parsing, case folding or
  slash trimming. A refusal is `token-invalid-authorized-parties`, which `handleSessionTokenError` (`:8350`) answers
  with signed-out and no handshake (only expiry-type reasons handshake), so a wrong list signs everyone out quietly rather
  than looping. `clerkMiddleware` spreads its options into `authenticateRequest`'s
  (`@clerk/nextjs/dist/esm/server/clerkMiddleware.js:79` and `:249`), so the list reaches every path.
  The test that drives Clerk's real middleware offline (`clerk-proxy.clerk.test.ts`) pins, for the session cookie, the
  refusal of an unlisted `azp`, of none and of the listed origin with a trailing slash, and the unset list accepting
  all three; and the refusal of a handshake's token (Clerk logs it and goes on with no session: signed out). Dropping
  `authorizedParties` from `withClerk`'s options turns those four tests red. The refresh path, which needs Clerk's API,
  is read, not tested (round-1 review asked for the handshake case).
- **One place verifies a Clerk session token: Clerk's middleware, in `withClerk`.** The auth adapter's `auth()` and
  `currentUser()` (`packages/kit/src/adapters/real/auth.ts`) read the middleware's verdict from the `x-clerk-auth-*`
  request headers it writes over any a client sent, check the token header's HMAC against the secret key
  (`assertTokenSignature`, `@clerk/nextjs/dist/esm/server/utils.js:122`), and decode the token without verifying it
  again (`getSessionAuthDataFromRequest`, `data/getAuthDataFromRequest.js:40`). Its other Clerk calls are Backend API calls
  with the secret key. So the list goes to the middleware alone. Machine tokens never reach Clerk (`withClerk` strips
  `Authorization`), so `azp` is about session tokens only.
- **An environment value, not `params.auth`.** The origins differ per deployment (staging, production, each preview,
  the CloudFront host that exists only once deployed), and `params.ts` holds one value per app. Clerk's other values
  (`CLERK_SECRET_KEY`, `CLERK_JWT_KEY`) are set in the server's environment by the operator, not by `SssbApp`. Rejected:
  **`params.auth.authorizedParties`**, which would need a per-environment shape `params.ts` does not have, a key in
  both apps' params, and `SssbApp` plumbing; and having `SssbApp` fill in its own distribution's host, which the
  server's environment cannot name without a dependency cycle (the distribution's origin is the server's URL).
- **Every entry must be exactly its own origin** (`new URL(entry).origin === entry`), `https`, or `http` for the
  loopback hosts `localhost`, `127.0.0.1` and `[::1]`; a wildcard, a duplicate and an empty entry are refused, and the error names each bad entry and,
  where it parses, the origin to write instead. Since Clerk compares strings, any other form would match nothing and
  sign everyone out. Rejected: **normalising** an entry (lower-casing, dropping a slash or path), which would hide that
  the value written is not what Clerk compares, and would accept a path that may mean someone listed a page rather than
  a site. Rejected: **`http` for `localhost` alone** (the first cut), which refused a developer serving `dev:real` on
  `127.0.0.1` or `[::1]`, whose `azp` Clerk would match (round-1 review); and **`http` for any `*.localhost`**, which
  no SSSB command serves.
- **An empty value fails, unlike `CLERK_JWT_KEY`'s.** An empty `CLERK_JWT_KEY` means unset, and unset costs a Clerk
  request at worst. An empty list turns a security check off (Clerk treats `[]` as no check), and an empty value usually
  comes from a template whose input went missing. So the only way to turn the check off is to unset the variable.
  Rejected: **treating `''` as unset**, which fails open on exactly that mistake.
- **Refused in two places, with the same function**: when `withClerk` loads (the first real request, as
  `CLERK_JWT_KEY`; `withAuthProxy` forgets a failed load, so every request fails until it is fixed), and in
  `assertRealEnv`, as a `CutoverPendingError` naming row `auth-dev`, so `sssb check-real-env` reports it before a
  deploy and `createRealPorts` at boot. Optional: not in `REQUIRED_ENV`, so the required-environment snapshot is
  unchanged.
- **No warning when real mode has no list.** `sssb doctor` reads the workspace and the conformance suite runs in unit
  tests; neither sees a deployment's environment, so neither can tell. `sssb check-real-env` can, but has no warning
  channel today; that is `safeinsights/sssb#192`. Rejected: **a log line on every real boot without the list**,
  noise for a deployment on an instance of its own, where the list adds little.
- **Documented in the adopting reference, not the app guide**: it is an optional per-deployment setting, not a rule
  every app follows. The cutover checklist's `auth-dev` row gains one sentence (a sibling change edits the same row).
- **`@sssb/kit` minor** (a new setting, as the brief for #185 asked), Action optional: nothing breaks for a deployment
  that does not set it.

## The authorization scan judges reads (2026-11-27, `fix/authz-scan-get`)

safeinsights/sssb#103. The design is ADR-0012's 2026-11-27 addendum; the calls it did not settle:

- **Every read handler is judged, deny by default.** Rejected: **the issue's trigger** (judge a GET only when it calls
  `orgIdForSlug`, the app's org resolver, or a tenant-scoped db call with an org id). It fails open on a helper in
  another module, which the framework cannot name in an adopter's tree; the showcase's service job poll read an org's
  jobs through such a helper and would have stayed unjudged.
- **"Reads nothing" is an analyser fact, not a gate kind.** A gate has to be named in an entry, so every adopter's
  health route would need an exemption for a property the scan can check by itself. Its test is lexical over the whole
  handler (nested functions, defaults and dead branches count): every name declared outside the handler must be on an
  allow-list (inert globals, a primitive `const` of the file, `NextResponse`, `next/navigation`'s `redirect`,
  `permanentRedirect` and `notFound`, SSSB's `appMode` and `isSimulated`). Then only inert values and the request are in
  reach, so calls on locals and parameters are allowed (`new URL(request.url).searchParams.get`). Rejected: **a check on
  call heads** (any call whose head is a global the file does not declare), the first version: review found it passed
  `fetch` to an upstream service, a `declare global` client, and an import in any argument but a bare one
  (`{ dockets: store }`). Rejected: **an object or array `const`** as inert: `const` fixes the binding, and the file
  can fill it (`cache[org] = await load(org)`). `fetch` is out: a probe of an upstream service authorizes or names an
  exemption. It excuses reads only; a mutation that reads nothing still authorizes, as before.
- **Any `authorize` call counts on a read**, not only `'read'`: the scan does not evaluate the action argument, and a
  read that checks a stronger action is correct.
- **OPTIONS is judged** with GET and HEAD, which closes an OPTIONS that reads: a preflight that builds its headers
  inline from literals (or primitive consts) reads nothing and passes; one that shares a headers object or reads
  `process.env` authorizes or names an exemption (safeinsights/sssb#220).
- **The showcase's three unauthorized reads authorize** rather than being exempted: the notification feed (`read
Notification`, self-only), the preferences (`read NotificationPref`, self-only) and the service job poll (`read Job`,
  its machine actor). Each subject's rule already granted the read; behaviour for a caller is unchanged.
- **`storage/[...key]/route.ts` is a framework exemption**, not the showcase's: it is the download twin of the
  framework's `storage-upload/route.ts`, and an app's exemption key cannot hold `[`, which the app file reads as a glob.
- **The check keeps its id**, `authz-mutations`, since an app's `optOut` names it; its title says "route
  handler", and its test "every handler reaches authorize(...), reads nothing, or passes its exemption's gate".
- **safeinsights/sssb#137 is not in this change.** It reorders five mutating `[id]` routes in the showcase so a person
  who may not act cannot tell an existing id from a missing one; the scan does not judge order, so it does not fall out
  of this fix.

## A bounded, fair scheduled tick (2026-11-27, `fix/bounded-drains`)

safeinsights/sssb#97: `runDueSchedules` and `runDueDeliveries` drained every due row of every tenant in one tick, one
tenant's list after another's, with no bound. A webhook POST may take 10 seconds (`WEBHOOK_TIMEOUT_MS`) and the server
that runs the cron route has 30 (`SssbApp`, `packages/cdk/src/sssb-app.js:526`), so three slow deliveries could end the tick, and a tenant listed late
waited behind every other tenant's backlog. Both drains now go through `packages/kit/src/db/drain-budget.ts`.

- **The unit is both rows and time, and it bounds what is STARTED.** A drain starts at most `maxItems` rows (100 by
  default) and none after its deadline on the wall clock. The time bound is what protects the server's limit; the row
  bound caps a tick's database work and lets a caller ask for less. Work already started always finishes: cutting a
  delivery off mid-POST would only turn it into an at-least-once resend. So the deadline leaves room for one more item
  after it. The deadline is also checked before each tenant's listing query, so a drain out of time lists no further
  tenant. Rejected: **rows alone**, which cannot keep a tick of slow endpoints under 30 seconds (three of them do not
  fit); **time alone**, which leaves a caller no way to ask for a small tick and lets a fast backlog run to its window.
- **The windows run from the tick's start: schedules may start for 8 seconds, deliveries until 16.** Deliveries get a
  window of their own, so a run of schedules cannot spend the whole tick; a delivery started at 16 seconds has 10 for its
  POST and about four for its claim, record and audit transactions, a listing query begun just before the deadline, and
  the response. A schedule's spawn is a few statements, unless the in-process runner runs the job inside `jobs.start`,
  which no window bounds (that runner already says such work belongs on CodeBuild). Rejected: **one shared deadline**,
  in which schedules first could leave deliveries nothing. The numbers are the kit's defaults, written beside the
  arithmetic in `drain-budget.ts`: the kit cannot read `@sssb/cdk`'s 30 seconds, so a change to the server's timeout has
  to change them too.
- **Configured as an argument, not a parameter.** `runScheduledTick({ budget })` takes any of `maxSchedules`,
  `maxDeliveries`, `schedulesWindowMs`, `deliveriesWindowMs`, each falling back to its default when left out or given as
  `undefined` (an unset environment value must not break the tick). Rejected: **a key in `config/params.ts`**, which
  every app must hold (`tests/tooling/app-scaffold.test.ts` fails a drift), so it would be a required change for every
  adopter, for a value that follows the server's limit, which SSSB's deployment fixes, rather than anything an app
  decides. An app whose server differs changes the one line of its cron route.
- **A drain called with no budget is unbounded, as before.** The tick always passes one. The Simulator's own controls
  (its clock and "run due" routes) call the drains directly, run no server limit, and expect a click to run what is due,
  so they pass none and keep the old behaviour, each tenant's rows oldest first. Rejected (the first cut): **defaults
  for every caller**, which bounded those routes too, measured their windows from each call so a slow first
  `db.ready()` could spend one, and dropped the new counts they do not read, so a click could leave work and say nothing.
- **Fair means round-robin per tenant, in a fresh uniform shuffle every tick, with no per-tenant cap.** A drain takes one
  row from each tenant in turn, so no tenant has a second turn while another with due work has had none, and one slow
  endpoint costs each other tenant at most a turn's wait per round. The tenants are put in a uniformly random order every
  tick (Fisher–Yates from id order, `random` injectable for tests), the same order for the listing and for the turns, so
  a tick that can serve only some of the tenants with due work serves each with the same chance. Nothing is stored.
  Rejected, each found wanting in review:
    - **Tenants in order of their oldest due row** (the first cut). Serving a tenant moves its head only to its next row,
      so two tenants with old backlogs a thousand rows deep came first every tick and kept a newer tenant out for hundreds
      of ticks (round 1, simulated).
    - **A random rotation of id order** (the second cut). The offset was drawn over all tenants, idle ones included, so a
      tenant's chance of going first depended on how many idle tenants sat just before it in id order: two busy tenants
      among ten split 1820 to 180 turns over 2000 ticks (round 2, simulated). A shuffle has no such bias.
    - **A per-tenant cap** on its own, which idles budget while one tenant has work and the rest none; **a stored cursor**,
      a framework migration for an order a shuffle gives without state; **weighting by time spent** (a tenant whose POSTs
      are slow gets fewer turns), more machinery than the issue needs.
- **Under a bound, a tenant's own listed rows are shuffled too.** A schedule whose spawn fails inside its transaction
  keeps its `next_run_at`, stays the tenant's oldest due row, and would take that tenant's first turn every tick,
  blocking its healthy schedules for good while the tenant gets one turn (round 2). Shuffled, it takes a turn only by
  chance. The rows shuffled are the ones listed, the tenant's oldest `maxItems + 1`, so a tenant with more stuck rows than
  that still never lists its healthy ones: safeinsights/sssb#215. With no bound the rows keep their oldest-first order,
  since every row runs (a consumer would otherwise see one job's status deliveries in either order). Rejected: **backing
  a failed schedule off**, a change to the schedule's retry behaviour that belongs with #215, not here.
- **The remainder is never touched, so it is never lost or run twice.** A row the drain does not start gets no claim, no
  lock and no write, and stays due; the next tick lists it again. Running twice is still prevented where it was: each
  drain's locked re-check of the row (two overlapping ticks included). A tick reports what it left as `deferred` and
  `stoppedBy` (`'items'`, `'time'` or null), for schedules and inside `deliveries`, which the route's JSON, the scheduled
  tick's log line, `pnpm tick` and the dev ticker show (the ticker speaks on a stopped tick even when it started
  nothing). `deferred` is a lower bound: each tenant is listed with a `LIMIT` of one more than `maxItems`, enough to tell
  a drain that stopped on its bound from one that ran out, and a listing the deadline cut short leaves later tenants
  uncounted.
- **The listing itself is still one query per tenant per drain**, as before: a tick with many tenants spends part of its
  windows listing. safeinsights/sssb#202.
- **The static demo's in-browser twins of the drains are unchanged**: no server and no time limit there.
- **Proofs.** `drain-budget.test.ts` pins the turns, both bounds, the listing cut, the shuffle's uniformity (idle tenants
  included), the cross-tick starvation case with deep backlogs, and stuck rows across tenants and within one; the
  schedules and webhooks tests each run a starvation case on the fake database (a busy tenant's backlog, a slow endpoint
  whose POSTs each take ten seconds of the tick's clock, and another tenant's single row still served in the same tick,
  with what was left served once in later ticks); `db.contract.test.ts` runs the bounded schedules drain on real
  Postgres under RLS. Removing the round-robin, the shuffle of tenants or of rows, or the deadline check turns tests red.

## An SSL mode for the pg transport (2026-11-27, `fix/pg-ssl-mode`)

`safeinsights/sssb#96`: neither the server's `pg` adapter nor the Migrator set TLS, so a connection was encrypted only
if `DATABASE_URL` asked for it (SssbApp's never did), and the URL the Migrator builds from the secret carried none. Now
both connect with one explicit mode, read by one function (`databaseSsl` in
`packages/kit/src/adapters/real/database-transport.ts`) and applied by `createRealDb`, whose `ssl` argument is required.

- **The default is `verify-full`**, and an unset or empty `DATABASE_SSL_MODE` means it: TLS, the chain checked
  (`rejectUnauthorized`) and the host checked against the certificate's names (Node's `checkServerIdentity`, given the
  host by `pg`). Empty is the default here, unlike `CLERK_AUTHORIZED_PARTIES`'s, because the default is the strict
  value: a template whose input went missing fails closed. Rejected: **`require`** as the default or a mode (TLS that
  accepts any certificate stops a passive listener, not an active one, and the RDS roots are at hand), **`prefer`**
  (falls back to plaintext), and **`verify-ca`** (trusts the CA and not the host, which on a public CA trusts anyone
  it issued). The modes are `verify-full` and `disable`, nothing between.
- **The roots are a file, `DATABASE_SSL_ROOT_CERT`** (an absolute path, libpq's `sslrootcert`): when set, its
  certificates are the only roots that one connection trusts (`ca`); unset, Node's own (its bundled roots and
  `NODE_EXTRA_CA_CERTS`), which suits a host whose certificate chains to a public root. Aurora's chain to Amazon RDS's
  roots, which Node does not trust. **How the CA reaches a Lambda:** the Lambda Node.js runtime from Node 20 carries
  the Amazon CA certificates, RDS's among them, at `/var/runtime/ca-cert.pem`, and no longer loads them (AWS Lambda's
  guide, "Using AWS Lambda with Amazon RDS"). `SssbApp` points `DATABASE_SSL_ROOT_CERT` at that file on both Lambdas,
  which run on `NODEJS_22_X`. Rejected: **`NODE_EXTRA_CA_CERTS`** pointing at the same file (widens every TLS
  connection the process makes, and AWS notes that loading the whole bundle at start slows a cold start), and
  **shipping the RDS bundle in `@sssb/kit`** (a CA file SSSB would have to track through AWS's rotations; the
  runtime's is AWS's to keep current). A Lambda built from a container image may not have that file: an adopter on one
  puts the RDS bundle in the image and sets the path to it.
- **Not a `config/params.ts` key.** `SssbApp` always builds Aurora, which always offers TLS, so there is no deployment
  of the construct that should choose anything but `verify-full` against the runtime's bundle; a key would be a choice
  with one right answer, in every app's params and `tests/tooling/app-scaffold.test.ts`'s same-keys rule. The
  variables are the override, for a deployment of the adopter's own (another Postgres host) and a local real-mode run;
  `SssbApp` sets them, as it sets `DATABASE_TRANSPORT`. Rejected: **an optional `params.database.ssl`**, which no
  `SssbApp` deployment could set to anything else safely.
- **The URL may not carry TLS of its own.** `pg` merges what it parses from the URL over the config it is given, so
  `?sslmode=disable` (or `no-verify`, or an `sslrootcert`) would silently replace the mode. `createRealDb` refuses a
  URL with any parameter named `ssl*` or `uselibpqcompat`, read as `pg-connection-string` reads it, and names the
  parameters, never the URL. Rejected: **stripping them**, which answers a URL that asked for something with something
  else, and **honouring the URL when the variable is unset**, which is the implicit default the issue is about. A
  `DATABASE_URL` of an adopter's own that sets `sslmode` fails at boot after the upgrade, with the fix in the message;
  the changeset says so.
- **Local and contract runs use `disable`.** `pnpm dev` is simulated (pglite, no `pg` at all), so it is untouched. The
  contract runner's embedded Postgres and CI's service container have no TLS, so `startContractServer` connects with
  `{ mode: 'disable' }` (`CONTRACT_SSL`); a `CONTRACT_DATABASE_URL` carrying `sslmode` is now refused like any other
  URL (a contract server that requires TLS would need a mode of its own, which nobody has asked for). TLS itself is
  proven by `packages/kit/src/adapters/real/db-tls.contract.test.ts`, which starts an embedded Postgres of its own
  with a certificate it makes with `openssl`, answering TCP only over TLS: `verify-full` migrates and serves
  (`pg_stat_ssl.ssl` is true), `disable` is refused, and an untrusted root or a host the certificate does not name is
  refused. Breaking the mode's verification turns two of its cases red.
- **The Data API is unaffected**: it speaks HTTPS through the AWS SDK, which checks AWS's certificate. `assertRealEnv`
  checks on `pg` only (row `db-tls`, a `CutoverPendingError`) the variables' shape and a `DATABASE_URL` that would
  override them, and reads no file, since the path SssbApp sets exists only on Lambda and `sssb check-real-env` runs
  anywhere; SssbApp sets neither variable on `data-api`.
- **Required environment unchanged** (both variables are optional), so no release snapshot moves. The changeset still
  files `minor`, Action required: a deployment of the adopter's own whose host has no TLS, or whose certificate chains
  to a root Node does not trust, breaks until it sets the variables.
- **Not done here: forcing TLS on the cluster** (`rds.force_ssl` in a cluster parameter group SssbApp would add). It
  is the server-side half, and it changes a stateful resource of every deployed stack; filed as
  `safeinsights/sssb#207`.
- **Refused as well, from review**: a root file holding no PEM certificate (Node takes an empty `ca` as none and
  trusts its own roots, so an empty or truncated bundle would quietly widen trust), and `NODE_PG_FORCE_NATIVE` (`pg`'s
  native client passes libpq only `sslmode` and file keys from the `ssl` option, so every mode would reach it as
  libpq's default, `prefer`). Rejected: **a warning when `disable` names a host that is not loopback** (a reviewer's
  suggestion): a compose network's `db` is not loopback either, and the docs and the cutover row already confine
  `disable` to a server with no TLS.

## The Clerk adapter: one read per render, the keyless fallback closed, a client sign-out (2026-11-27, `fix/clerk-adapter`)

safeinsights/sssb#200, #193 and #180, together because all three are SSSB's real Clerk adapter.

- **#200: a per-render memo, not a cross-request cache or session claims.** `getCurrentUser` and `listMyOrgs` share
  two reads (the account, the memberships) through React's `cache`, which gives each server render its own store and
  is a pass-through anywhere else. So reading the signed-in person costs a page render at most two Backend API calls
  (a page per 100 orgs more; other calls, such as a team's members, are not shared),
  and nothing outlives the request: a role change, a removal or a ban shows on the next one, with no bound to
  document beyond that. Writes the adapter makes (`updateProfile`, `setActiveOrg`) drop the person's reads, so the rest
  of the render sees them. Rejected: **a time-bounded cache per user**, which on a deployment of several server
  instances serves a stale org right after a switch (the switcher reloads the page; another instance answers it) and
  cannot be invalidated across instances; and **custom session claims** (the role and metadata in the token), which
  need a Clerk dashboard change per instance, SSSB's role lives on the membership rather than in Clerk's active-org
  claim, and the claims lag a switch until the token refreshes. Both need a live measurement first: filed as safeinsights/sssb#214.
  Route handlers are not memoized (React's `cache` has no store there), and read on each call. Proven
  with React's `cache` simulated in `auth.test.ts`, never in a real Next render.
- **#193: the adapter refuses to read a session while Clerk's keyless fallback can be reached.** Clerk decrypts the
  request data its middleware writes under a published key outside a production build (when no secret key is set, or,
  in keyless mode, after the real key fails) and then trusts the secret key that data names to check the token header.
  On a path the proxy skips, nothing overwrites a caller's headers, so anyone could be signed in. `clerk-keyless.ts`
  is asked before every `auth()` and `clerkClient()` in `auth.ts` (Clerk's client decrypts the same data and takes
  its API URL from it): outside `NODE_ENV=production` it requires `CLERK_SECRET_KEY` itself (with an encryption key
  alone, Clerk checks the token header against an empty key) and `NEXT_PUBLIC_CLERK_KEYLESS_DISABLED` `1` or `true`, a subset of what Clerk's `isTruthy` reads as set. Stricter
  than Clerk on purpose: it ignores Clerk's CI exemption and holds under `NODE_ENV=test`, so it copies none of Clerk's
  environment lists. The showcase's `dev:real` sets the variable. `clerk-keyless.clerk.test.ts` drives Clerk's real
  `auth()` with forged headers: signed in as Clerk ships, refused by the adapter, and refused by Clerk once the variable
  is set. Rejected: **only setting the variable in scripts**, which an adopter's own `next dev` would miss silently;
  **re-checking the token header's HMAC against `CLERK_SECRET_KEY` in the adapter**, which copies Clerk's header names
  and signature scheme; **a marker header from `withClerk`**, which needs a secret shared between the proxy and the
  route and breaks where the proxy runs apart from the server; and **guarding `withAuthProxy`**, which a skipped path
  never reaches. The matcher's dot rule stays (the guide says a page path has none); this closes the hole whatever the
  matcher skips.
- **#180: `RealUserMenu`, rendered by the server layout and handed to the client header glue.** The layout loads it by
  `import()` in real mode, as the sign-in page loads `RealSignInForm`, and passes it as a `userMenu` node; its props are
  plain data (`profileHref`, `signedOutHref`) because a function cannot cross from a server component. It signs out
  through Clerk's client by session id, and falls back to the sign-out route (the framework's `auth/signout`, which
  revokes the server-read session alone) until Clerk has loaded or if Clerk's sign-out fails, rather than signing
  nobody out as `RealAccountRefused` does: a menu has no place to say so. Added to the `real-auth-provider` check's forms.

## The secret scan reads the commits it is asked about, not every branch (2026-11-27, `fix/secret-scan-scope`)

`safeinsights/sssb#106`: `secret-scan` ran `gitleaks git` with no `--log-opts`, which gitleaks 8.30.1 turns into
`git log -p -U0 --full-history --all`, and the `fetch-depth: 0` checkout puts every branch of the remote in the clone.
One branch's secret-like string failed the scan on every other open pull request. The range is now picked by
`.github/scripts/secret-scan-range.sh` from the event, and the generator's workflow and root files carry both.

- **The range.** `pull_request`: `<base sha>..<head sha>` from the event payload, so a commit the pull request added and
  deleted again is still read. `push` (only `main` triggers `checks.yml`): `HEAD`, the pushed branch's full history, so
  what reaches `main` is scanned in full. Any other event exits non-zero with no output: a new trigger decides its range
  in review. Rejected: **a default of `HEAD`**, which would scan a `workflow_dispatch` or merge-queue run's whole
  history under a name that says it scanned the change; **no default**, which is the bug. Rejected: **the merge
  commit's parents (`HEAD^1..HEAD^2`)**, which `docs-only.sh` uses and which names the base tip at the time the run
  started rather than at the event; the issue's design reads the event's shas, and a base that moved on makes the range
  larger (the commits the branch merged in that the stale base does not reach), never smaller, so it fails toward
  scanning more. A re-run reads the same payload.
- **Quoting.** gitleaks splits `--log-opts` on spaces and warns about a value with quotes in it, so the script prints one
  space-free line and the step passes it as `--log-opts="$range"`, the shell removing the quotes. The step takes the range
  in a statement of its own (`range=$(...)`): a failed command substitution inside another command's arguments does not
  stop a `bash -e` step, and gitleaks would run with an empty value, which is `--all` again. `${range:?}` is the second
  guard. The shas arrive as environment variables, never interpolated into the script text, and the script accepts only
  a full 40 or 64 digit id that is a commit in the clone (a ref name, an option or a range would otherwise reach
  `git log` as one).
- **Scope of the copy.** A generated workspace's `checks.yml` had the same job, so the generator writes the same step and
  copies the script as it is (`ROOT_FILES`); a changeset for `@sssb/create` (Kind scaffold, optional: the old scan keeps
  working, with the old bug) says how an existing workspace takes it. `app-checks.yml` and `sssb ci` have no scan.
- **What is no longer scanned early.** A commit pushed straight to a branch that is not `main` (an `int-*` branch, say)
  used to fail every pull request's scan; now it is read when it reaches `main`, in the pull request into `main` and
  then the push. A pull request into that branch does not read it either: it is reachable from the base. With
  `--log-opts` set, gitleaks 8.30.1 drops its own `--full-history` and `--diff-filter=tuxdb` (debug output:
  `git log -p -U0 HEAD`, against `git log -p -U0 --full-history --all --diff-filter=tuxdb` without it); a pull request
  that deletes a file holding a secret already on its base still reports nothing, as before (throwaway repository).
- **Not done here.** The scan on a push to a branch other than `main` (none triggers it today), and gitleaks'
  stopword behaviour (named out of scope in the issue).

## Job retries with backoff, a new row per attempt (2026-11-27, `fix/job-retries`)

safeinsights/sssb#135: a job was tried once, and `failed` ended it for good, whether the handler threw, a build failed
or the in-process runner lost it. A kind may now opt in to retries. The issue listed its open questions in order; each
is answered here.

- **A retry is a new job row, not the same row.** The issue asked for the new-row sketch to be tried first, and it was
  kept. Framework migration `0019_job_attempts` gives `jobs` an `attempt` (from 1), a `retry_of` (the FIRST attempt's
  id, so every attempt points at one key) and a `run_after` (set only while a retry waits out its delay). `failed` stays
  terminal: `jobStatusMachine` is unchanged, and so is the idempotency `recordWebhookCompletion` stands on. A
  redelivered failure finds the row already `failed`, answers `idempotent`, and arms nothing more. Each attempt keeps its
  own timeline, and the first attempt's error is never overwritten by a later one. The cost is several rows for one piece
  of work in a job list; the views now carry `attempt` and `retryOf` so a screen can group them. Rejected: **the same
  row going `failed -> queued`**, or a new `retrying` status. That loosens the one rule the webhook's idempotency and the
  timeline's meaning rest on, and leaves a status a dashboard and a service poller would both have to learn.
- **Opt in per kind, default none, in the seam beside `jobNotify`.** The optional `jobRetry` export holds
  `Partial<Record<AppJobKind, JobRetry>>`, with `JobRetry = { attempts, delaysMs? }`. It is read through the seam's
  namespace, as `jobNotify` is, so an app without the export builds and runs every kind once.
    - An entry SSSB will not honour (`isJobRetry`: attempts not a whole number from 1 to `MAX_JOB_ATTEMPTS`, 10, or a
      delay that is negative or not finite) counts as absent. A typo must never become a hundred runs of a failing job.
    - The framework's own kinds never retry.
    - With no `delaysMs`, the delays are the webhook deliveries' backoff (`backoffDelayMs`), reusing what already exists.
      The last delay repeats when the list is shorter than the attempts.
- **Arming happens at the failure, in its transaction.** `recordJobStatus`, the one choke point every runner's failure
  goes through, inserts the next attempt in the SAME transaction that records `failed`. That covers a handler's throw
  (`runJobInProcess`), the in-process sweep's lost job, a build's failure webhook, and a start the drain could not make.
  The new row is queued, with `run_after` set to the failure plus the delay, and copies the kind, org, payload and
  requester. Its opening timeline entry reads `attempt N of M, after: <error>`, and the failed entry reads
  `retry armed: …`. So no failure can happen without its retry being durable, and none can arm twice.
    - The clock is the caller's (`extra.now`): the simulated runner passes the world clock and the sweep passes the tick's.
      That way a demo that moved its clock reaches a retry by moving it again.
    - Rejected: **arming in a separate step after the failure commits**, which a crash between the two would lose.
- **The scheduled tick starts the next attempt.** A retry cannot wait inside the invocation that failed. It gets a
  third drain, `runDueRetries`, built on #97's machinery: listed per tenant under `withTenant`, taken in fair turns, and
  bounded by its own window, so the tick's windows are now schedules 6 s, retries 10 s and deliveries 16 s, re-divided
  inside the same 30-second limit.
    - It claims a row the way the delivery drain claims a delivery: lock it, check it is still waiting and due, and clear
      `run_after`. Only after that commits does it call `jobs.start` with the attempt and the first attempt's id. From the
      claim on, the row is an ordinary queued job, so every runner treats it as it treats a submitted one.
    - A start that throws (StartBuild refused) records the attempt failed, which arms the next.
    - The tick's period is the floor under any delay; the guide says so where a kind sets one.
    - Rejected: **a timer in the process**, which a Lambda does not have; and **retrying inside the failing invocation**,
      which shares its limit and may be what died.
- **Idempotency is the handler's.** SSSB tells a handler `ctx.attempt` and `ctx.firstJobId`, the key it deduplicates its
  side effects on, and passes both to a CodeBuild build as `JOB_ATTEMPT` and `JOB_FIRST_ID`. The guide states the
  requirement.
    - Both context fields are optional in the type, though SSSB's runners always set them. A required field would break
      every adopter test that calls a handler with a hand-built context (the showcase's export test does).
    - A time-budgeted handler that returns having done part of its work has succeeded, and is not retried.
- **Lost jobs.** The in-process sweep leaves a waiting retry alone (`run_after` is set), since it is the tick's to start,
  not lost. A job the sweep fails as lost arms its retry like any other failure.
    - The simulated world loses no jobs and has no sweep.
    - CodeBuild has no lost-build detection at all: a build that dies without posting its webhook is never noticed, so it
      is never retried. Closing that gap is its own change: safeinsights/sssb#231.
- **Notifications are about the job's end.** `notifyJobTerminal` skips a failure that armed a retry: it checks for a
  later attempt of the same work, so every caller (the runners, the webhook route, the sweep) gets it without a
  parameter. `jobNotify`'s `failure` therefore means a failure with no attempts left. The payload gains `attempts` when
  the attempt is above 1, and the catalog says "did not finish after N attempts". Whether a retry writes an
  `audit_events` row is #156's question, left with it. The timeline is the record here.
- **The Simulator.**
    - "Run pending jobs" and the builder actor's pool skip a retry still waiting: an operator must not jump a backoff by a
      click.
    - The clock advance and run-due also run `runDueRetries` (`simulator-api.ts` and the showcase's two routes). Advancing
      past a delay is how a demo reaches a retry.
    - The static demo's twin gets the same map through `useDemoWorld({ jobRetry })`, plus a `jobOutcome` hook, the twin
      of a handler that throws, since it could only complete a job before.
- **safeinsights/sssb#215 is not covered.** A schedule whose spawn fails inside its transaction creates no job row, so
  there is nothing for a job retry to retry. What it needs is a policy for the schedule row itself (disable an
  unparseable spec, back off a transient failure), with its own question of who sees it. It stays open.
- **Proofs.** `db/job-retries.test.ts` runs every server runner through the issue's cases, each checking the rows, the
  timeline, the notification and, for CodeBuild, the redelivered webhook:
    - succeeds first time; fails then succeeds; fails every attempt; and, on the in-process runner, is lost then succeeds;
    - a kind that does not retry;
    - two drains racing one retry;
    - a start that throws;
    - the Simulator skipping a waiting retry.

    Removing the arming, the notifier's skip, the sweep's or run-pending's exclusion, the drain's under-lock re-check,
    the delay, or the first job id's hand-off each turns them red. `core/jobs.test.ts` covers the seam reader;
    `db.contract.test.ts` arms and drains a retry on real Postgres under RLS; `demo-static/world-job-retries.test.tsx`
    runs the twin through the same cases and holds its copy of the policy to core's answers.

- **What review changed** (two review rounds on Opus, then a check of the second round's fixes as a diff).
    - **A waiting retry is hidden from a service caller.** `listServiceJobs` lists a job a service may run, and a
      waiting retry is not one yet; the Simulator's service actor would otherwise have run every armed retry at once.
      `listServiceJobs` therefore leaves it out, and the twin's service driver too.
    - **Any hop out of `queued` clears `run_after`.** A path that reached the retry anyway (a caller that knew its id, a
      webhook) takes it out of the drain's list.
    - **A last attempt that could not start notifies.** A start that throws is recorded failed. Before review, the drain
      then told no one, even when that was the job's end. `runDueRetries` now takes an `onFailed`. The tick and the
      Simulator's clock and run-due controls pass `notifyRetryEnd`, which calls `notifyJobTerminal`, and that skips a
      failure that armed a further attempt.
    - **A delay over 30 days (`MAX_JOB_RETRY_DELAY_MS`) is refused.** A delay past JavaScript's date range would
      otherwise throw inside the failure's transaction and leave the job unrecordable. The twin's copy of the check
      carries the same cap.
    - **The twin honours the jobs-held knob** for a due retry: it is left queued for Run pending, as `fakeJobs.start`
      holds one on the server.
    - **The views' new fields are optional** (`JobView.attempt`, `.retryOf`, the same on `ServiceJobView`), so a story or
      test that builds a view by hand still compiles. The list functions always set them.
- **Limitations accepted.**
    - **A StartBuild that throws after the build really started** records that attempt failed and arms the next. The
      build's own `completed` webhook is then refused with a 409, `failed -> completed`, and the work may run twice.
      `submitJob` leaves a job queued when its start throws, but the drain cannot: on CodeBuild a queued job with no build
      is lost for good (safeinsights/sssb#231). A failure the next attempt repairs costs less.
    - **In a simulated world, a retry armed through the jobs webhook or the service status route uses the real clock.**
      Those routes pass no `now`. After the world clock has been moved forward, such a retry is due at once. The runners'
      own failures and the sweep use the world clock.
    - **The static demo's twin** delivers a webhook a retry enqueued during a clock advance at the next drain, not in the
      same advance, as the server's tick does.
    - **The showcase's static bundle has about 11 KB of its size budget left** after this change (`pnpm check:demo-size`
      passes with a warning).

## One answer for a missing id and a refused one (2026-11-27, `fix/id-existence-oracle`)

safeinsights/sssb#137. The showcase's mutating `[id]` routes looked the row up, answered 404 when it was missing, and
only then authorized, so a person in the active org who may not act got 403 for an id that exists and 404 for one that
does not: one bit of existence, against the routes' own comments.

- **Both of the issue's designs, each where it fits.** Where the subject's org is the active org the session resolves
  to (tickets, attachment confirm, webhook endpoints), `authorize` moves before the lookup: a refusal is the same 403
  for any id, and an allowed caller still gets 404 for a missing or foreign id. Where the subject's orgs come from the
  row (the two-sided escalation, cancel and respond), the lookup has to come first, and the refusal is rethrown as
  `NotFoundError`, the same status and body (`{ error: 'not found' }`, `withPortErrors`) as a missing row. Rejected:
  **mapping every refusal to 404**, which would tell a restricted member who can see the queue that a ticket they are
  looking at does not exist, where the reorder gives them an honest 403 that reveals nothing.
- **The class, not only the five routes.** Review found the same oracle in `POST /api/escalations`, on an org slug in
  the body: the responder org was resolved, and 404 `unknown responder org` returned, before `authorize`, so a person
  with no standing (refused the list that shows the targets) could learn which org slugs exist. It now authorizes once
  on the requester side before the responder is resolved (the create rule reads only that side), and again with both
  sides after. `service/jobs/[id]/status` moves its `authorize` before the lookup too; its only callers are service
  keys in their own org, which the framework's machine rule always grants, so nothing leaked there today, but it was
  the example that contradicted the rule. The guide's rule is stated for any lookup keyed by request input.
- **The escalation routes' missing row throws the same `NotFoundError` the refusal is rethrown as**, so one mapper
  (`withPortErrors`) writes both answers rather than two literals agreeing by hand.
- **A malformed id is still a 404 before `authorize`** (`requireUuidParam`), on every route: a refused caller gets 404
  for a non-uuid and 403 for a uuid, which tells them only the id's shape, which they wrote.
- **A responder-side member who may not decide gets 404 for an escalation they can see**, which is what the
  reorder was chosen to avoid for tickets. The issue's "Done when" requires it, and the dashboard shows that member no
  decide controls, so only a forced request meets it.
- **Rejected for escalations: authorizing the read first**, then the action after the lookup. It hides existence from
  anyone who may not read escalations, but a reader who may not decide would still get 403 for an existing id and 404
  for a missing one, which the issue's "Done when" rules out.
- **The rethrow sits in a `catch` that always throws**, so the authorization scan still counts the `authorize` call
  (a `catch` that returns would swallow it). It is written inline in each route: a helper in another module would not
  count.
- **A refused attempt is not audited.** The issue asked whether the audit trail should record one; no route records a
  refusal today, and doing so is a design of its own (an audit action per refusal, and who reads them).
- **The starter gains no `[id]` route.** Its Items slice has none, and adding one to demonstrate the rule would grow the
  scaffold every adopter deletes (`sssb remove-items`'s diffs with it). The rule goes in the app guide instead.
- **No conformance check.** The authorization scan proves a handler may reach `authorize`, not the order of calls, and
  it cannot tell which call is the row lookup in an app's own code, so an order check would be a guess about names.
  The guide says to pin the rule with a route test, as the showcase's routes now do.

## Two edges of real sign-in: before Clerk loads, and a session a failed finalize left (2026-11-27, `fix/sign-in-edges`)

safeinsights/sssb#198, in `packages/kit/src/adapters/real/sign-in-form.tsx`.

- **The password waits for `useClerk().loaded`**, and the button shows `loading` until then. `loaded` reads clerk-js
  itself (`IsomorphicClerk`), and Clerk's provider re-memoizes its context on every status change, so the form
  re-renders when clerk-js loads (@clerk/react 6.18.8, @clerk/shared 4.45.1). Rejected: **`useAuth().isLoaded`**,
  which reads Clerk's auth state rather than clerk-js itself; and **re-reading the attempt after load**, which depends
  on what `GET /client` returns after a reload, the issue's open question. A clerk-js that never loads leaves the
  button busy: there is nothing to sign in with then.
- **The form holds the session from the moment an attempt is complete** (`held`, `attempt.createdSessionId`, read
  before `finalize`, rather than later from an attempt a failed `finalize` may have changed). That covers both routes to a
  complete attempt: the password alone and an accepted code. While a session is held, Back from the step, or a
  "Sign out" button on the password form (the existing `auth.signOut` copy), signs it out with Clerk's `signOut`
  (`useClerk()`) by id, and only while `clerk.client.signedInSessions` still has it; one the client no longer holds is only forgotten. The
  password cannot be submitted while a session is held. Under the app router Clerk navigates with the router's `push`
  (@clerk/nextjs 7.10, `useAwaitablePush`; that `signOut`'s `redirectUrl` goes through it is clerk-js's, unread here),
  which keeps the form, so the form resets itself, its error included, once the sign-out answers and the client no longer
  holds the session; a sign-out that fails, or answers but leaves the session, shows the existing
  `refusedSignOutError` copy with the button still there. A finished sign-in clears `held` and keeps the form busy
  while the browser leaves. Rejected: **reading the session at Back time** (round-1 review: an emptied attempt signs
  nothing out); **gating on the form's own "code accepted" flag**, which misses the password-only route; and
  **retrying `finalize` instead**, which leaves no way to abandon a sign-in started on a shared computer.

## The LLM adapter has a deadline, and the provider's limits are a port error (2026-11-27, `fix/llm-timeout`)

`safeinsights/sssb#98`: `createRealLlm` built the SDK client with a key and nothing else. The SDK's timeout is ten minutes
per attempt and it retries twice, while the app server's function has 30 s (`packages/cdk/src/sssb-app.js`), so a slow
call ended as a killed invocation, and a provider 429 or 529 ended as the SDK's own error, a plain 500 in a route.

- **One deadline per port call, enforced by an abort signal.** `complete`, `stream` and `runToolLoop` each start a timer
  and pass its signal (and the same figure, rounded up to the integer the SDK wants, as the SDK's per-attempt `timeout`)
  to every SDK call they make; the SDK's `timeout` alone covers one attempt, which a retry restarts. A tool loop's
  deadline covers every turn **and the app's `execute`** between them, since a person waits through those as well:
  `execute` takes no signal and cannot be stopped, so the loop stops _waiting_ for it when the deadline passes (the
  tool runs on) and the call ends as `timed-out` on time; an `execute` that throws first surfaces as it threw, never as
  an LLM error. A stream's deadline starts when it is first iterated and ends when it is left, early exit included,
  which also aborts the request. Two places where an abort does not arrive as the SDK's `APIUserAbortError`, both
  mapped to `timed-out`: the platform's own `AbortError` when the deadline passes while a non-streaming body is being
  read, and a stream whose iteration the SDK ends quietly, with no error, when the deadline passes while the consumer is
  busy between chunks (the adapter awaits the stream's `done()` after the loop, which throws what ended it, so a cut-off answer
  never reads as a complete one: a deadline, a mid-stream overload and a dropped connection alike). Rejected: `AbortSignal.timeout`, which a fake clock does not drive.
- **25 s by default.** The function has 30 s and a route needs a few seconds to answer; a call still waiting at 25 s ends
  as an error the route turns into a 503, where one that waits to 30 s ends as a killed invocation.
  Exported as `LLM_DEFAULT_TIMEOUT_MS` from `core/llm-timeout.ts`, which also holds `llmTimeoutMs`, shared with the fake
  adapter so a bad value (`0`, `NaN`, `Infinity`, a string, more than 2^31 - 1 ms, which Node's timers fire after 1 ms)
  is a `RangeError` in both: a timer would read `0` as "now" and `Infinity` as "never".
- **The adapter retries, once, and the SDK does not.** The SDK's own retries are off (`maxRetries: 0`): it sleeps a
  provider's whole `Retry-After`, so a 429 that asks for 60 s idled the call to its deadline and ended as `timed-out`
  with the provider's figure lost. The adapter repeats a call the SDK's policy would have (408, 409, 429, 5xx, a dropped
  connection) plus a rate limit or overload however it arrived, never one marked `x-should-retry: false`, waiting the
  provider's `Retry-After-Ms` or `Retry-After`, else 0.5 s doubling to 8 s, **only when twice that wait is less than
  what is left of the deadline**, so the retry gets at least as long as the wait (a provider wait that only just fit was
  slept almost whole and then left the retry no time: found in review); otherwise it answers at once with `rate-limited` or `overloaded` and the provider's figure.
  A stream starts again only if it has delivered no text. One retry per request to the provider (a tool loop's turns each get one; the deadline bounds the total), because a second would spend most of a 25 s
  deadline on a provider that is not answering; `RealLlmOptions.maxRetries` changes it for an app that builds the adapter
  itself. Rejected: the SDK's retries with a signal (the loss above); a retry loop that keeps the last provider error
  and prefers it after a timeout, which would still idle the server for nothing.
- **A job's call may have longer, per request, not by default.** `timeoutMs` is an optional field of `LlmRequest` and
  `LlmToolLoopRequest`: the handler knows its work, the adapter cannot tell a job's call from a route's (both get the
  same `llm` from the registry), and the runner's own limit differs (the in-process runner runs inside the server's invocation and shares its limit, so there 25 s stays right:
  `packages/kit/src/adapters/real/jobs-in-process.ts:28-32` says work that may outrun it belongs on the CodeBuild runner). Rejected: a second port instance for jobs, which every
  adopter's job context would then have to wire; an environment variable, which would change `required-env.json` for a
  figure most deployments leave alone and could not differ between two calls of one process. An app that builds the
  adapter itself sets the default with `createRealLlm(key, { timeoutMs })`, as `apps/showcase/scripts/llm-record.ts`
  does (two minutes: nobody waits on a recording).
- **`LlmUnavailableError` is a port error (`@sssb/kit/ports/errors`),** the sibling of `DatabaseUnavailableError`: a
  `reason` in no vendor's words (`rate-limited` for a 429 or a `rate_limit_error`, `overloaded` for a 529 or an
  `overloaded_error`, which the provider also sends mid-stream on a 200 with no status, and `timed-out` for the deadline
  or the SDK's attempt timeout), the SDK's error as its `cause`, and a `retryAfterSeconds` that is the provider's `Retry-After-Ms` or `Retry-After`
  (whole seconds, clamped to 1 to 120; a date or nonsense is ignored) or 10. 10, not the database's 5: a rate limit or an
  overload does not clear in the seconds a resume takes. Every other provider error (400, 401, 500, a dropped
  connection) is returned as the SDK threw it: they are bugs or outages a retry does not mend, and a 503 for them would
  tell the client to ask again. Rejected: a status on the error (a vendor's number in the port), and a flag saying the
  work did not happen: a `timed-out` call may have been billed and a tool loop may have run some tools.
- **Both apps' `withPortErrors` answers it with a 503, `Retry-After: retryAfterSeconds`, `{ error: 'llm-unavailable',
reason }` and a logged warning,** the shape of the database's answer. That function is the app's, so an adopter applies
  it by hand (a scaffold changeset for `@sssb/create`). A job handler lets it propagate, which fails the job (`runJobInProcess` records the error message).
  A stream that has begun its response cannot change the status: the error ends the iteration, and the guide says so.
- **The fake adapter replays instantly, so it checks `timeoutMs` and nothing else.** It cannot rate-limit or time out
  without a fixture format for failures, which would be a feature of its own; the 503 mapping is proved with the error
  thrown by hand (`respond.test.ts`), and the adapter's mapping with the SDK's real error classes behind a stubbed
  `fetch` (`adapters/real/llm.test.ts`: no network, the SDK's retry and abort code runs).
- **A large `maxTokens` is no longer refused locally.** The SDK refused a non-streaming call whose `max_tokens` implies
  more than ten minutes, but only when it chose the timeout; passing one skips that check, so `complete` and
  `runToolLoop` with a large `maxTokens` are now sent, bounded by the deadline instead.
- **The kit changeset is Kind seam, Action required (a `minor`).** A call that took longer than 25 s used to succeed and now
  fails, so an app whose job runs on a runner without the server's 30 s limit (CodeBuild) breaks if it does nothing: its
  handler passes a longer `timeoutMs`. A request-path call, and a job the in-process runner runs inside the server's
  function, need nothing. (First written as optional; `.changeset/README.md`'s rule is that a change an adopter who does
  nothing breaks on is required.)
- **Not done here.** The `llm-key` cutover row still holds the live check; its verification list gains nothing, since a
  live 429 or a slow call is not something to provoke on purpose.

## The Data API emulator reads a plain literal's backslash as the Data API does (2026-11-27, `fix/emulator-backslash`)

`safeinsights/sssb#201`: an app's query with `ESCAPE '\'` and a parameter after it passed the contract run, and the real
Data API answered `syntax error at or near ":"` (seen live, 2026-11-24). Postgres, with `standard_conforming_strings` on,
reads `'\'` as a complete literal; the Data API finds `:name` parameters with a scanner of its own, and the error says a
`:` reached Postgres, so that scanner did not see the parameter as code.

- **What the emulator does.** Its parameter scan (`toPositional`) now reads SQL with `sqlSegments(sql, { dataApiReading:
true })`, in which a backslash escapes the next character in a plain `'…'` literal too, so `'\'` does not close and the
  literal runs on to the next quote. A `:name` in that stretch is left in the text; Postgres is handed a bare `:kp1` and
  answers `syntax error at or near ":"`, the message the live Data API gave; the emulator wraps it as `DatabaseErrorException`, as it does any database error. The
  dialect keeps Postgres's rules for `$n` (`rewritePlaceholders`): it rewrites the SQL the app wrote for node-postgres.
  A statement is refused only when a `:name` falls in the stretch where the two readings differ, which is exactly the
  evidence. The SQL text Postgres receives is otherwise unchanged.
- **Proven and inferred.** One live observation: a plain literal ending in a backslash, a parameter after it, that error
  (the issue records the error and the `ESCAPE '\'`, not the statement's full text). Inferred: that the Data API treats `\'` as an escaped quote in every plain
  literal (so the escaped-quote reading, and the way it shifts every later literal, follow from one rule); not known: a
  statement with no parameter after the literal, or only before it, which is not refused; `E'…'`, `--` and `$$` are
  assumed read as Postgres reads them (the runbook's step 2 checks the first two). The runbook's step 2 now ends with the
  live check, `a` (the observed shape) and `b` (the `E'\\'` spelling), and says which line each result corrects.
- **Rejected: rewriting `'\'` to `E'\\'` in the dialect.** It would make the statement work on both transports, but it
  means rewriting SQL the dialect cannot parse (a literal is one thing to the Data API's scanner and another to
  Postgres's, and the divergence is itself unconfirmed past one case), and an adopter who wrote `'\'` would never learn
  the statement is not portable. Rejected: **refusing every plain literal that ends in a backslash**, which is broader
  than the evidence: a parameterless statement may well be fine. Rejected: **refusing in the dialect**
  (`unsupportedStatement`) with a clearer message: the brief and the issue ask for the emulator's refusal, and a
  production refusal on an inferred rule is a decision for the owner; the emulator is test-only. The spellings both
  scanners read alike are `E'\\'` and `chr(92)` for one backslash (a plain `'\\'` is two, so it is no substitute for `ESCAPE`).
- **Nothing in the framework or the apps writes such a literal** (a search of `packages/kit`, `apps/*/src`, the fixture and
  the seed for a backslash in SQL; the showcase assistant's `escapeLike` escapes a value that is then bound as a parameter, not a literal in the SQL).

## A reads-only gate for public and inert reads (2026-11-27, `fix/authz-public-reads`)

safeinsights/sssb#220. The design and what it accepts are ADR-0012's later 2026-11-27 addendum; the calls it did not
settle:

- **One gate kind for all three shapes**, not one allowance each. A public feed, a preflight sharing a headers object
  and a handshake GET differ only in which names they read; a `reads-only` gate lists them, and the scan checks the
  rest of the handler reads nothing. Rejected: **a second key space for any gate outside `src/app/api`** (a `calls`
  gate proves only that one call is reached, not that a read outside `api/` does nothing else) and **app entries of
  any kind under a framework prefix** (a mutation there must keep the framework's gate).
- **Reads only, by the gate and by the lookup.** The gate never holds for a mutation, and `exemptionFor` skips a
  `reads-only` entry for a mutating verb, so a POST beside a reads-only GET under `webhooks/` is still judged by
  `withWebhookSecret`, and one outside `src/app/api` can match no exemption, as before.
- **An exact entry still wins over its prefix for a read.** A GET under a `reads-only` entry that is also wrapped by the
  prefix's guard is judged by the entry and fails if it names more; rejected: passing a read on either gate, which made
  a prefix's gate override every exact entry beneath it (an existing test caught it in the first draft).
- **`names` are identifiers**, not dotted names: an import's exported name (never a default import, whose local name the author picks), never a
  value of the route's own file (below). A namespace import is refused outright, since it names the whole module, and so is
  an aliased one (`import { headers as cors }`), as for every gate.
- **Narrowed in review.** The first draft let a listed declaration of the file excuse whatever it held (an alias of an
  import, a helper reading the database, a `declare`d `fetch`): the first fix had the scan read a listed `const` or
  function and count its names, and refuse an ambient, exported, mutable or import-equals binding. It allowed a reads-only file
  under `simulator/` too, which the issue did not ask for and whose 404-in-real guarantee such a read does not keep:
  `webhooks/` only. A listed name nobody reads is a problem. The second round found a listed `const` that the file
  fills elsewhere (`cache.set(…)` in a POST): a listed declaration used anywhere outside the read is now refused.
  The third found the same thing through a sibling destructured binding (`const { get, set } = …`). Three rounds of
  one shape meant following declarations of the file was the wrong tool. A fourth found a literal `const` filled
  through the handler itself (code of the file calling `GET()` and writing to what it returns). So no value of the
  route's own file can be listed at all, only imports; a shared headers object goes in a module. Rejected:
  **following a listed declaration of the file and checking every write to it**, which four rounds showed cannot be
  closed by syntax.
  Review also found route groups and parallel-route slots escaping path-keyed rules (`api/(g)/service/…`,
  `api/@s/service/…` past the `service/` gate), older than this change; the scan now matches by URL, and refuses an
  intercepting route, whose URL a path cannot tell. That can fail an app that passed, hence `minor`, Action required.
- **Not built: #221** (pages and metadata routes). It extends the scan to files it does not read today, a change of its
  own, in its own PR.

## Lost CodeBuild builds, and schedules that keep failing (2026-11-27, `fix/lost-builds-and-failing-schedules`)

Two fixes in one change. safeinsights/sssb#231: a CodeBuild job whose build died without posting its webhook stayed
queued for ever, and since #135 a kind that retries never retried it. safeinsights/sssb#215: a schedule whose spawn
failed inside its transaction stayed due and took a turn every tick.

- **The CodeBuild runner records each build, and judges a job by its build's state, not its age.** Migration
  `0020_job_runner_ref` adds `jobs.runner_ref`. `start` writes `starting` before it calls StartBuild, and the build's
  id once StartBuild returns. The sweep the tick already calls (`JobsPort.sweep`) asks BatchGetBuilds, at most 100 ids a
  call, about every job of the runner's still queued or running whose last status change is more than five minutes
  old (`CODEBUILD_LOST_AFTER_MS`, the tick's default period, so a webhook in flight is not taken for lost). Lost means:
    - **its build ended that long ago** with any status but IN_PROGRESS, the job still open. That includes SUCCEEDED:
      the job's result was never recorded, so a kind that retries runs again;
    - **CodeBuild has no record of the build** (`buildsNotFound`);
    - **CodeBuild refused its StartBuild** (a client fault: no permission, no such project, a limit), marked `refused`;
    - **it was left `starting` for an hour** (`CODEBUILD_STARTING_LOST_AFTER_MS`): StartBuild never returned, failed in
      a way that may have started a build, or the build id was never written. An hour, not five minutes, because with
      no id the sweep cannot ask CodeBuild, and a build that did start should get to report its own end first.

    A build still IN_PROGRESS is never judged, however long it runs: CodeBuild's own timeout ends it, and a later sweep
    sees the result. A lost job is failed through `recordJobStatus`, which arms a retry, and its end notifies as the jobs
    webhook route's does. A job whose webhook lands between the sweep's read and its write is already terminal, and the
    state machine refuses the failure.

    Rejected:
    - **An age limit alone**, as the in-process sweep uses. A CodeBuild build may wait in CodeBuild's own queue and run
      up to the project's timeout, so no one limit fits.
    - **An EventBridge rule on the build's state change.** It is the faster signal, but it needs infrastructure
      (`@sssb/cdk`) and a new route, where a sweep reuses the tick and needs one IAM action.

- **Failing the job is the registry's, handed in.** `createRealJobs(project, region, db, failLost)` imports no job
  module: the real ports load it while the adapter registry is still being evaluated, and `sssb check-real-env`
  bundles it as CommonJS, which the seam's handlers (reached through `recordJobStatus`) cannot be part of. The registry
  supplies `failLostJobFromRegistry`, built from lazy imports as the in-process runner's notifier is. A caller that
  builds the real ports itself without the hook gets a runner with no sweep, as before.
- **Jobs written before 0020 are never judged.** They have no `runner_ref`. Builds in flight at the deploy that brings
  this would otherwise be failed as never started.
- **What only a deployment can show.** The tests drive the runner against a fake CodeBuild client
  (`adapters/real/jobs.test.ts`), so these stay a cutover proof (row `job-runner`):
    - that the server's role may call `codebuild:BatchGetBuilds` (without it, each tick logs that the sweep could not
      read builds, and fails nothing);
    - the statuses and end times CodeBuild really reports;
    - how long a real webhook takes after its build ends.
- **A schedule's spawn failure is counted, and either backs the schedule off or turns it off.** Migration
  `0021_schedule_failures` adds `job_schedules.failure_count` and `last_error`. On a failure inside the spawn
  transaction, a transaction of its own (under the row lock, and only while the schedule is still enabled and due)
  counts it and keeps the message.
    - **A spec that does not parse can never spawn, so the schedule is DISABLED,** with a `schedule.disabled` audit event
      whose detail is the reason alone. The error, which echoes whatever the stored spec holds (an address or a token
      the audit log refuses), is the schedule's `last_error`, kept to 500 code points, never half a surrogate pair.
      Someone must fix the spec and enable it again. The Simulator's schedule view lists such a row with `spec: null`
      rather than failing on it.
    - **Any other failure may be passing (an insert the database refused for a moment), so the schedule BACKS OFF:**
      `next_run_at` moves to the failure plus the webhook deliveries' backoff for that many failures in a row (one
      minute, five, thirty, two hours, then six hours on). A schedule that fails every time therefore takes a bounded,
      shrinking share of its tenant's turns. It stops holding the oldest due slot, so the per-tenant listing (#97) reaches
      the healthy schedules behind it however many such rows the tenant holds.
    - **The next spawn that commits resets both columns.** A failure after the spawn committed (the audit write, the
      runner's start) is not a spawn failure, and is counted nowhere new.

    Rejected:
    - **Disabling after N failures of any kind**, which would turn off a schedule over an outage it would have outlived.
    - **A notification to the org's admins.** A schedule belongs to no person, and the audit event and the Simulator's
      schedule view (`failureCount`, `lastError`) are where an operator looks. Left open for an app that wants more.
    - **Leaving a backed-off schedule's phase unchanged.** A weekly or daily spec finds its next slot from the time it
      fired, so it keeps its phase. An interval spec counts from the backed-off time, a shift of at most the backoff,
      which is accepted.

- **Proofs.**
    - `adapters/real/jobs.test.ts` covers: a build that ended unreported, for each ended status; one still running; one
      that ended within the grace; one CodeBuild no longer knows; a start that never recorded a build, judged only after
      the hour; a StartBuild refused (judged after five minutes) beside one that may have started a build (left for the
      hour); a job a service caller or webhook moved to running; a job too recent to judge, one without a ref, and one
      already reported; a webhook racing the sweep; a sweep that cannot read builds; batches of 100; and a lost build of
      a kind that retries whose next attempt starts a new build and completes.
    - `real/index.test.ts` pins the registry handing the runner its database and handler; `adapters/fail-lost-job.test.ts`
      drives the registry's handler itself (fails, arms the retry, notifies; leaves a job that ended meanwhile).
    - `db/schedules.test.ts` covers: an unparseable spec turned off with its audit event; a failing insert backed off for
      one minute, then five, then cleared by a spawn that commits; a healthy schedule spawning beside more stuck ones than
      the listing takes, both disabled and backed off; a failure after the commit left uncounted; a long, many-byte error
      clipped with the audit still written and the world view listing the row; and an address-shaped spec whose audit
      carries the reason alone.
    - Removing the IN_PROGRESS skip, the webhook grace, the not-found or `starting` rules, the quiet filter, the batching,
      the build id's recording, the `running` status, the hour's grace, the `refused` marker, or the handler's notify or
      race check turns them red. So does removing the disabling, the backoff, its escalation, the reset on success, the
      failure policy itself, the clipping, the world view's null spec, or the audit's reason-only detail.
    - The failure recorder's re-check under the lock (a schedule another tick fired or turned off meanwhile) is argued
      here, not tested.
- **What review changed** (two review rounds on Opus, then a check of the second round's fixes as a diff).
    - **The Simulator's schedule list no longer throws** on a schedule whose spec does not parse: the very rows this
      change turns off. It shows them with `spec: null`.
    - **A job left `starting` gets an hour**, so a build whose id went unrecorded is not failed while it runs.
    - **A StartBuild CodeBuild refused is marked `refused`** and failed after five minutes, not the hour, since no build
      started.
    - **The `schedule.disabled` audit carries the reason alone**, so a spec holding an address or a token cannot get it
      refused.
    - **The registry's lost-job handler is its own module** (`adapters/fail-lost-job.ts`, lazy imports), tested as the
      runner calls it.
- **Limitations accepted.**
    - **If the `starting` write itself fails,** `submitJob` rejects before StartBuild and the job stays queued with no
      ref, never judged. That is the state a failed start left before this change, and the caller is told.
    - **The sweep has no bound of its own.** It runs at the tick's start, so a mass loss spends part of the drains'
      windows; the next tick carries on.

## `check-real-env` notices, and a bound on the feature-flag read (2026-11-27, `fix/real-env-notices`)

safeinsights/sssb#192 and #104, two small changes to the real adapters' edges.

- **#192: `realEnvNotices(env)` beside `assertRealEnv`, printed by `sssb check-real-env` after a pass.** Advisory lines
  returned by the framework, so the command's one reader of a deployment's environment stays the framework's, with
  `@sssb/tools` only printing them (a `notice:` each, to stdout, exit code unchanged). The framework's list holds two
  cases: `CLERK_AUTHORIZED_PARTIES` unset, and any variable that starts `CLERK_AUTHORI` (any case) and is not that name,
  the issue's second comment: such a variable looks like the setting and does nothing. Not in the list: `CLERK_JWT_KEY`,
  the issue's open question. Unset it costs Clerk API calls rather than leaves a check off, and what it costs is a
  measurement (cutover row `auth-dev`); it is one line to add if wanted. A notice is not printed after a failure, which
  is the whole answer then. `@sssb/tools` finds `realEnvNotices` by looking through the framework's exports by name at
  run time, and offers none for a framework without it: esbuild warns about any static mention of a missing export,
  `in` guard included (a test pins that no warning is printed). A notices function that throws prints a notice saying
  so and never fails the check. Rejected: **a `--strict` flag that fails on a notice**, which nobody asked for and
  which would make unset look unsupported; and **warning at boot**, where the server's log is nobody's checklist.
- **#104: `FLAG_TIMEOUT_MS` = one second, no retries.** Chosen against what a page can afford: the protected layout
  awaits a flag read before it renders, so a slow PostHog costs every authenticated page the bound, once. One second
  rather than the capture bound (two): a capture is awaited only to get the event out of a frozen Lambda, a flag read
  is on the way to the person's page. The client is given `featureFlagsRequestTimeoutMs` and
  `featureFlagsRequestMaxRetries: 0` (posthog-node 5.73 builds on @posthog/core 1.67's stateless client: three
  seconds and one retry after a delay, so six seconds and more per page in an outage; the issue's "ten seconds" is the
  stateful client's default, which this is not), so the request is aborted, and the adapter races
  the read against the same bound, so the page is held to it whatever the client does. Late answers and failures are
  dropped. Not measured against a live PostHog (cutover row `analytics`).

## The starter's e2e on a production build, and the destructive suite's budgets from CI's numbers (2026-11-27, `fix/e2e-prod-build`)

`safeinsights/sssb#109` and `safeinsights/sssb#100`. SSSB's reusable workflow sets `E2E_BUILD=1` on every e2e shard, and
only the showcase read it: the starter's shard ran `next dev`, so CI never ran `next build` for the app adopters get. And
the destructive project's budgets were still the ones sized for `next dev` on a CI runner.

- **The starter reads the flag** (`build:e2e`, `start:e2e`, and the `webServer` branch in its `playwright.config.ts`),
  as the showcase does, and a generated app inherits both through the template; nothing in `app-checks.yml` or
  `sssb ci` changes. Seen to fail: a server component that calls `useState`, on a route no spec visits, failed the
  suite under `E2E_BUILD=1` at `next build` ("You're importing a module that depends on `useState` into a React Server
  Component module") and passed it under `next dev` (4 passed). Rejected: **a shared Playwright preset** for the two
  configs, to state the branch once: jscpd reads only `src` (`.jscpd.json`), so the two copies trip no gate, the
  starter's config is copied into every adopter's tree, where a preset would be one more thing to pin, and the branch is
  three lines.
- **Measured on CI, not locally** (this machine's load average was 60 to 300 that day). A temporary reporter printed
  each test's duration and its four slowest waits; five runs of the destructive shard on PR #233 (one push and four
  reruns, 80 test runs, no retry, no failure): slowest test 16.0 to 16.3 s (`actors.spec.ts`, the autonomous drain,
  paced by the actors' 3 s timer), then 9.7 to 10.9 s (`simulator-snapshots.spec.ts`, save/restore/reset), every other
  under 9 s; the shard 90 to 115 s in all. Twenty earlier green runs of the shard, under the old budgets: 16 passed in
  1.5 to 2.0 min each, none flaky. Build and start: the showcase 26 to 39 s, the starter 28 s. The starter's shard, by Playwright's own total
  (server start included): 45.0 s on `next dev` (an earlier run of the same day), 34.9 s with the production build (its 4 tests in 6.4 s
  after a 28 s build, where under `next dev` they took 35 s compiling as they went).
- **The budgets** (`apps/showcase/tests/e2e/support/budgets.ts`, read by the config and the specs): on a production
  build a destructive test gets 60 s (3.7x the slowest) and an assertion 10 s (every wait over 2.1 s has a budget of its
  own but one, a tour resuming after a preset load, 2.3 s, now on the default through `coldRoute`; the slowest action, a
  click, took 6.1 s, inside the test's budget); the web server 180 s in both apps (4.6x the
  slowest build and start). Under `next dev` every budget is what it was (120 s, 15 s, 180 s for the presets test), since
  a loaded local machine has been measured near a CI runner's dev numbers (`docs/build-notes.md`, "A cold dev server at
  load ~250"). Removed: the nine `test.setTimeout(120_000)` calls, which only restated the project's dev budget and would
  have overridden the production one, and the three 90 s `page.goto` caps, which bound nothing a test's own budget does
  not. The six 60 s waits right after a navigation become `coldRoute(60_000)`, the project's assertion budget on a
  production build. Kept as they are, because they wait for the app's own work and are 5 to 13 times what it took: the
  actor polls (30 and 60 s; the actors back off to 15 s a tick after an error), the snapshot restore and preset waits
  (20 and 45 s), the job and mail waits (15 s), the `toPass` retries (45 s). Three of the actor polls (60 s) now equal
  the test's own budget, so a hang there reports as a test timeout rather than with the poll's message; that test took
  16 s.
- **Not done here:** the chromium project's budgets (60 s, 15 s) are still the dev ones on CI too; that is
  safeinsights/sssb#235. A per-spec world (#99, #161) is what would end the destructive suite's shared-state class of
  failure; the ten repeat runs above found none to file.

## A stream's failure after text is visible, and the replays can fail the same way (2026-11-27, `fix/stream-failure-visible`)

`safeinsights/sssb#145`: when a stream fails after some of its text was delivered, the consumer must be able to tell.
`safeinsights/sssb#98` (`fix/llm-timeout`) made the real adapter throw it (`await stream.done()` after the loop: the SDK's
iterator drops a failure that arrives while the consumer is busy between chunks); what was left is that nothing else could
fail, and nothing held the three to one behaviour.

- **The port already carries the marker: a thrown error, not an event.** The question was whether the stream type needs an
  end-of-stream marker; it does not. An `AsyncIterable<string>` that throws from `next()` is the marker, and the text
  already yielded stays yielded. Rejected: a terminal event in the chunk type, which would change `stream`'s type for every
  consumer to say what a `throw` says.
- **A fixture entry may `failure`: `{ reason }`** (`LlmFixtureEntry`, `packages/kit/src/adapters/fake/llm.ts`), with the
  reasons of `LlmUnavailableError`. `complete` throws before returning text; `stream` yields the entry's `response`, the
  partial answer, then throws; `runToolLoop` runs every recorded tool call live, then throws in place of the final answer.
  An entry matches as any other does, the default entry included. The static demo's `replayAssistant` throws the same error
  after the same tool calls. The fake can now also be built with its own fixtures directory (`createFakeLlm({ fixturesDir,
catchRequests })`), which the conformance check uses so it never touches an app's fixtures or `.data`; `fakeLlm` is
  `createFakeLlm()`. Rejected: a thrown error whatever the vendor, which would put a real adapter's error class in a fixture.
- **One conformance check, `llm-stream-failure`** (`checks.json`, unit runner, so it runs in both apps and the kit's fixture), three
  tests of one scenario (an answer that starts, then an overload): the fake's stream gives the partial text and throws, the
  demo's replay throws after its tools, and the real adapter, against a stubbed `fetch` and with its consumer busy between
  chunks, throws the same reason after delivering the same text and does not start the answer again. It holds the
  framework's adapters, so it passes in every app unless the kit regressed; it fails when `await stream.done()` is taken
  out of the real adapter (checked), which is what an adopter's own copy of the adapter would need to keep. The SDK refuses
  to build a client in a browser-like environment, which an app's Vitest environment may be, so the check takes `window`
  away for its one test and undoes it.
- **A failing entry that fails before any text sets `response` to `""`** (an empty answer is an answer here; `null` still
  means "to record", and `llm:record` now skips every entry with a `failure`, which is hand-authored: recording would
  replace its partial answer with a whole one and leave the failure on it). The tool loop's default entry accepts the
  same empty answer, found in review.
- **The showcase's own consumers say it too.** The static demo's pass 2 (the compose fixture's default entry, streamed in
  chunks) throws `LlmUnavailableError` after the same text when the entry has a `failure`, as the server's stream does;
  the demo replay finds a matched entry only when its `conversation` is not empty, as the fake does. The dashboard hid the
  failure once any text had arrived (`prev || assistantError`): it now keeps the streamed text and says the failure under
  it (`assistant-failed`, `role="alert"`), and still shows the failure as the answer when nothing arrived. Known and left (`safeinsights/sssb#241`):
  a default entry with a `conversation` is replayed by the fake with its tool calls but by the demo as its `response`
  alone, as before this change.
- **Not done.** The check proves the adapters, not an app's own consumer: whether a route or a screen shows the failure is
  its own test (the showcase's assistant route has one, `route.test.ts`). The port's docs and the guide say what a stream
  can throw and how to test the path.

## A world per e2e worker, and `workers` left at 1 on CI (2026-11-27, `fix/e2e-worker-worlds`)

`safeinsights/sssb#99`: every Playwright worker drove one server holding one `.data`, so `workers` could not be raised
without specs touching each other's state. Now, in the showcase, `E2E_BUILD=1 E2E_WORKERS=<n>` gives each worker a
server and a world of its own (`apps/showcase/tests/e2e/support/worlds.ts`, read by `playwright.config.ts` and by every
spec or helper that reads or writes its world on disk).

- **The design: a server per worker over one production build.** Worker 0 is the suite as it was (the config's first
  web server on the app's port, the app's `.data`), so one worker changes nothing. Worker `k` gets another
  `start:e2e` (`sssb serve-standalone`) of the same build, on a port in a per-checkout band (10000 to 19999, below the
  ports Linux hands out from 32768) and with
  `APP_DATA_DIR` at an emptied directory under the system's temp directory. The config lists those servers after the
  first; Playwright starts them in order, and every worker loads the config with `TEST_PARALLEL_INDEX` set, so
  `baseURL` and `worldPath(...)` follow the worker with no change to a spec's imports (`docs/build-notes.md`, "A world
  per Playwright worker, from the config alone"). Eleven files that named `.data` by a path relative to themselves
  now call `worldPath`.
- **Rejected: one server with a world per request** (a header or cookie keyed through `AsyncLocalStorage` instead of
  `APP_DATA_DIR`). It is the seam safeinsights/sssb#161 wants for a public demo, but every fake adapter, the pglite
  instance, the world clock and the Simulator's state would have to become per-world inside one process, and nothing
  short of that is safe. Rejected: **a worker-scoped fixture that starts each worker's server** (Playwright's documented
  pattern): it needs every spec to import `test` from a support module, for nothing the config cannot do on its own. Rejected: **a server per worker on `next dev`**: Next 16 allows one dev server per app directory
  (safeinsights/sssb#113's first attempt), and a `distDir` per worker would put a test-only concern in the app's config
  and pay a cold compile per worker. So the worlds need `E2E_BUILD`, and asking for more than one worker without it is
  an error that says so.
- **Measured on CI** (PR #245, temporary commits that set `E2E_WORKERS` on the e2e job and let the destructive shard use
  it, reverted): three runs at each count, every shard green, no flaky test.

    | workers                                                         | `e2e (showcase)`, 60 tests | `e2e (showcase-destructive)`, 16 tests | job (showcase / destructive) |
    | --------------------------------------------------------------- | -------------------------- | -------------------------------------- | ---------------------------- |
    | 1 (before: #233's last run; the destructive range over 20 runs) | 2.0 min                    | 1.5 to 2.0 min                         | 166 s / 165 s                |
    | 2                                                               | 1.2 to 1.4 min             | 1.1 to 1.3 min                         | 134 to 151 s / 104 to 123 s  |
    | 4                                                               | 1.3 to 1.7 min             | 1.1 to 1.2 min                         | 129 to 152 s / 109 to 129 s  |

    Four workers buy nothing over two on a four-CPU runner, where each worker brings a browser and a server. Locally, on
    a production build at three workers (load average 27 at the start): the showcase's 60 tests in 1.1 min and its 16
    destructive ones in 1.3 min, against 5.8 min for the destructive project alone under `next dev` (at load ~330).

- **`workers` stays 1 on CI, because it does not pay there.** A pull request waits on `lint-typecheck-unit` (6.3 to 9.6 min in these runs and #233's last) and on `adoption-probe` and `pack-and-consume` (4.4 to 5.6 min); the e2e shards finish inside
  3 min at any worker count, so more workers save runner time and no one's wait. When e2e becomes the slowest job, the
  switch is `E2E_WORKERS` on the e2e job, plus dropping `--workers=1` from `sssb ci e2e --project destructive` for an
  app whose config gives each worker a world (an adopter's app does not, so that flag must stay for them).
- **Guards, from review:** with more than one world the first server is never reused (a dev server or an earlier
  build adopted on the app's port would leave the others serving an older build); a worker past the last world
  (`--workers` above `E2E_WORKERS`) fails at once, naming `E2E_WORKERS`, rather than driving a port nothing listens on;
  and each world is emptied by its server's own `APP_DATA_DIR`, with no path in a shell command. A port in a worker's band that another
  program holds (this machine's Dropbox listens on 17600 and 17603) fails that server's start loudly, as a port taken in
  `@sssb/tools/ports`' own bands does.
- **The starter keeps one worker and no worlds**: its suite is four tests in under 30 s, and the guide's rule
  ("Playwright's `workers` stays 1") stays true for an adopter's app, which has no `worlds.ts`. Nothing that ships
  changes but a comment in `serve-standalone.js` (an empty changeset).

## The Data API's rollback keeps the work's error, and its resume probes are bounded (2026-11-27, `fix/data-api-rollback-and-probes`)

safeinsights/sssb#189 and #190, both left by the review of the resume wait (#183, "One wait for a paused cluster, and a typed
error after it" above, with its 18 s `DATABASE_RESUME_BUDGET_MS`).

- **#189: kept in the framework's own transactions, not in the dialect.** Kysely's `execute()` catches the work's error, awaits
  `driver.rollbackTransaction`, and rethrows the work's error; if the rollback throws, that replaces it. A controlled
  transaction's `rollback()` calls the same driver method with the same connection, and nothing tells the driver which
  caller it has, so a rule in `rollbackTransaction` (swallow a failure) would also hide a deliberate rollback's: the
  issue's open question. `transactionKeepingWorkError` (`packages/kit/src/db/with-tenant.ts`), which `runWithTenant`
  (both transports) and the Data API transport's `migrateToLatest` run their transactions through, sees the work's
  error, so it throws that when something else was thrown after it, and keeps the
  rollback's failure as a warning and as a non-enumerable `rollbackError` on the work's error when that is an object that
  takes one (a thrown string or a frozen error gets the warning alone). The rollback's error is never `cause`: the work's
  error may carry its own. A transaction opened on the raw handle (`getDb()`: the contract suite's proofs, which never throttle) keeps Kysely's
  behaviour, and a commit that fails is
  thrown as it was: nothing the work threw is there to keep. Rejected: **a Kysely subclass or a proxy of
  `TransactionBuilder`**, to catch the same on the raw handle: private fields, and the builder's methods each return
  another builder. Rejected: **swallowing every failed rollback**, which hides a deliberate one.
- **#190: a probe is aborted after three of its turns, and when the wait ends.** `RdsDataClientLike.send` takes the
  SDK's `{ abortSignal }`, which `RDSDataClient.send` accepts (the SDK's own request option, which closes the socket).
  A probe is sent every 3 s at the soonest (its 2 s turn plus the 1 s wait), so 6 s (`PROBE_ABORT_MS`) leaves at most
  three out, and a probe that is slow but answers inside it still ends the wait, as before. The wait aborts every probe
  still out when it ends, by an answer, or when its last caller gives up, at once. A rejection after an abort is ours and is read as nothing: it
  neither ends the wait nor counts as the database's answer. Rejected: **keeping at most a few in flight by not sending**,
  which would hold up a wait the probes in flight may never end. The SDK's pool size was not read; the bound does not
  depend on it.

## A dropped connection is `connection-lost`; the demo replays a default entry's conversation (2026-11-27, `fix/llm-replay-and-terminated`)

`safeinsights/sssb#230` and `safeinsights/sssb#241`, two leftovers of the `#98` and `#145` work.

- **`#230`: what the SDK 1.8.0 gives for a connection that drops** (probed against its real classes, with a stubbed
  `fetch` and no network): a streamed body that dies while it is read is a plain `AnthropicError('terminated')`, whose
  `cause` is undici's `TypeError('terminated')`, whose `cause` has `code: 'UND_ERR_SOCKET'`; a non-streaming body that
  dies reaches the caller as that bare `TypeError('terminated')`; `fetch` itself rejecting is an `APIConnectionError`
  (the one the adapter already repeated, and then passed on unmapped). `adapters/real/llm.test.ts` pins the first shape
  by asserting the thrown error's own classes and cause chain, so an SDK that changes it fails a test by name.
- **It is `LlmUnavailableError('connection-lost')`, and repeated before any text.** The provider is not answering, and may
  be soon: the same shape as a rate limit or an overload, so a route answers the 503 it already answers and a job
  fails with a typed cause. A new reason, not `timed-out` (the deadline did not pass, and a caller that tells the two
  apart may wait for one and not the other) and not `overloaded` (the provider said nothing). The reason union grows by
  one, so an exhaustive `switch` on `reason` in an app needs a case (a type error, never a runtime one): the changeset
  says so. `retryAfterSeconds` is the default 10.
- **Detection is by what the error carries, not by its class:** `isConnectionDrop` (`adapters/real/llm.ts`) is an
  `APIConnectionError`, or anything in a five-deep cause chain that is a `TypeError('terminated')` or has a code that
  is undici's (`UND_ERR_*`) or a transport's (`ECONNRESET`, `ECONNREFUSED`, `ECONNABORTED`, `EPIPE`, `ENOTFOUND`,
  `EAI_AGAIN`, `ENETUNREACH`, `EHOSTUNREACH`). Matching `AnthropicError` alone was rejected: the SDK also throws it for a
  request it refuses to send, which no retry mends. An error with no transport cause passes through as before.
  The check runs over what the provider's calls throw, never over what the app's tool throws: a tool loop's `execute`
  failures are tagged on the way out (`ToolFailure`) and unwrapped by the adapter's error mapping, because a database
  reset or a tool's own `fetch` that dropped carries the same codes and would otherwise be reported as the provider's
  outage (found in review; a test per shape). The demo replay's failing entry still fails when it has no answer to give.
- **The same rule retries and maps.** A call whose connection dropped is repeated once, as every other retryable failure,
  inside the deadline and only when the wait fits; a stream only when it had delivered no text (the consumer has the rest
  otherwise, so it ends in `connection-lost` after that text). A non-streaming call is repeated though its body had begun,
  as the SDK's own policy repeated a failed connection: it may be billed twice.
- **`#241`: the demo's `replayAssistant` chooses its answering entry as the fake's `lookupToolLoop` does:** the entry
  recorded for the question, else the default entry, whose `conversation` is replayed with its tools, or, with none, its
  `response` as a one-turn answer. Before, a default entry's conversation was answered by its `response` alone, so the
  demo ran none of the tools the server's replay runs. Answered, from the open question: an unrecorded question's tools
  do run live in the demo, as on the server, because a demo that skipped them would show a different world from the one
  the fixture describes. No committed fixture has such an entry today. Measured: the showcase's static bundle
  (`dist-demo/index.html`) is 849,822 bytes before and 849,860 after (+38), 10,140 bytes under its 860,000 budget.

## A reused pid does not keep a stale ticker marker alive, and the vendor ban reads one list one way (2026-11-27, `fix/ticker-marker-and-vendor-ban`)

`safeinsights/sssb#146` and `safeinsights/sssb#155`, two tooling leftovers.

- **`#146`: a marker is stale when the process now at its pid is not the one that wrote it, told by a start token.** A
  wrapper killed with SIGKILL leaves `dev-ticker.json`, and once the OS gives its pid to an unrelated process
  `process.kill(pid, 0)` says "alive", so both Playwright configs refused to load until the file was deleted by hand.
  The marker now carries `startToken`, the writer's own start as the kernel records it (`processStartToken`): on Linux the
  boot id and the start time in ticks since boot (`/proc/<pid>/stat`, field 22), elsewhere `ps -o lstart=` (macOS keeps it
  fixed per process), run with `TZ=UTC0` so two processes with other time zones read one string. A reader compares tokens
  for equality: another token at the pid is another process, and the marker is ignored and cleared. **First written as a
  date comparison** (`startedAt` against the start `ps` gives, plus a tolerance), and **dropped after review**: on Linux
  `ps` computes `lstart` from the kernel's boot time plus ticks, so a wall clock stepped forward after the process began
  (a paused guest resuming, an NTP step) moves every process's start later, past the marker's `startedAt`, and a LIVE
  ticker's marker was judged stale and deleted, the failure the marker exists to stop; and a `TZ` that libc and V8 read
  differently shifted it by hours. A token compared for equality has neither. Rejected: the issue's "did not start at
  `startedAt`", for the same clock reason and because a dev server writes its marker minutes after it began.
- **What cannot be judged is live, as before:** a marker with no token (written by an older version), a token that cannot
  be read now (no `/proc` and no `ps`, as on Windows, an unreadable pid, `ps` timing out), tokens of different kinds
  (another machine's, through a shared directory). A false "stale" would let an e2e run adopt a ticking dev server. A
  process never judges its own marker, so the Simulator's status poll in a dev server spawns no `ps`. **Only a marker
  proved stale by a token is cleared**; one whose process is gone is ignored and left, as before (a container's marker read
  from a host shows a gone or foreign pid, and deleting it would take its ticker's protection away). The clearing re-reads
  the file and removes it only if it is still the one judged, so a wrapper that wrote its own in between keeps it; one
  that writes between that re-read and the removal still loses it, microseconds wide, and its ticker restores it on its
  next start.
- **`#155`: the vendor ban's two halves read one list through one matcher.** The static half matched the list with the
  `ignore` package (gitignore semantics, case-insensitive), the declarationless half (`import()`, `require()`, a
  type-position `import('…')`) with a hand-written `isVendorSpecifier`, so a bare `pg` banned a local `./pg` and
  `some/dir/pg` in one half only, and `@CLERK/nextjs` was a vendor in one half only. The bare names in
  `vendorSdkPattern` are anchored (`/pg`, `/posthog-js`, `/posthog-node`, `/mailgun.js`: in gitignore a leading `/`
  anchors to the start, and `/pg` still bans what is under it, `pg/lib/x`), and the declarationless half is
  `matchesPatterns` over the same group, as the framework/app fence's already was. An app's own bare `sssb.vendors`
  entries are anchored in the rules (`anchorBare`) the same way, so `stripe` bans the package, not `./stripe`. Both
  halves are now case-insensitive. Seen in the tests: `posthog-node/lib` is a vendor in both halves (a name bans what is
  under it; the old declarationless reading agreed), a thing the issue's table did not list.
- **What a change of fence needs:** the preset is the rules' own list, `packages/eslint-plugin/src/probes.js` probes an
  app's vendors by naming the package itself (`stripe`), which the anchored entry still matches, so the probes needed no
  change and `sssb check-fences` passes (`tests/lint/check-fences.test.ts`, both apps and the scratch apps that weaken a
  fence). A negation entry (`!pg`) was already refused by the loader; anchoring would have turned one into a literal name
  had it got through. The parity table (`tests/lint/framework-fence.test.ts`) now has a vendor block: 27 specifiers,
  three files, import, `import()` and `require()` each, with the expected answer pinned, not only the agreement
  (mutation-checked: un-anchoring `/pg` fails it, un-anchoring an app's entries fails `check-fences.test.ts`).

## The ticker marker is written whole and cleared without a gap; a failing default fixture always fails typed (2026-11-27, `fix/marker-atomic-and-fake-failure`)

`safeinsights/sssb#258`, `#257` and `#249`: three leftovers of the `#146` and `#145` work.

- **`#258`: the marker is written to a name beside it and renamed onto it** (`writeTickerMarker`; `<file>.<pid>.<random>.tmp`),
  so a Playwright config that loads in that instant reads the marker that was there or the whole new one, never half of
  it (a half-written file read as "no marker", and the config passed over a ticking dev server). A process killed between
  the write and the rename leaves the `.tmp` file, which nothing reads. Pinned by standing inside the write
  (`tests/tooling/ticker-marker-atomic.test.ts`): `writeFileSync` is wrapped to write half of its data, look at the marker as
  a reader would, then write the rest; written straight onto the marker the reader sees half of a JSON document
  (checked by making the write direct). Rejected: a stress test with a child process writing in a loop and the parent
  reading, which can pass for a long time on the code it is meant to catch. Left as it was, and open in the issue: an
  unparseable marker (damaged by anything else) still reads as no marker, not as "a ticker may be starting".
- **`#257`: the stale marker is moved aside, and judged from the copy** (`clearStaleMarker`). Read-then-`rm` left a gap in
  which a wrapper's new marker could be written and then removed. A rename is atomic and takes whatever file is there at
  that instant: if it is the stale one it is deleted; if it is a newer one (written between the judgment and the move)
  it is put back with `link`, which fails rather than overwrite, so a still newer marker written meanwhile wins and the
  copy is dropped; a marker written after the move finds the name free and is never touched. Where a file system has no
  hard links the put-back is a copy that fails rather than overwrite. **What it costs, found in review and filed as
  `safeinsights/sssb#260`:** in that race a reader that looks while the newer marker is out of place sees none (a stress
  run of one writer and four clearers spinning found the marker absent most of the time, which no real use approaches: a
  clearer runs only after a marker was judged stale); a ticker that stops in that instant has its marker put back
  (fails safe: the config refuses until the process exits); and two clearers meeting a newer and a newer-still marker
  may leave the older. A write that fails now leaves no `.tmp` beside the marker. `clearStaleMarker` is exported, with a `hooks.afterClaim` seam, for its tests, which interleave a
  writer at each step. Not changed: `removeTickerMarker` (the owner removing its own, by pid) has the same read-then-remove
  shape, but only another wrapper's write into the same data directory in those microseconds could be lost, and the
  token logic cannot tell one live ticker from two. `ps`'s start is to the second on macOS, so two processes born in the
  same second share a token; a pid reused in the second it was released is not a case.
- **`#249`: a default entry with a `failure` (one with a `reason`; `{}` is none) fails typed whatever answer it has, and every method reads the same default entry,** in `complete`, `stream` and
  `runToolLoop`: `response: null` and no `conversation` (or an empty one) used to end in the plain "no default entry"
  `Error`, which hid the failure the person wrote the entry to see. A default entry with no answer and no failure still
  throws that error. (`response: null` is the recorder's "to record" marker and the recorder skips failing entries, so the
  fixture is not rewritten.)
## The visitor's origin and address: `publicOrigin` and `clientAddress` (2026-11-27, `fix/origin-helpers`)

safeinsights/sssb#131 and safeinsights/sssb#132. Behind `SssbApp`, Next's `request.url` names the server's bind
address and port (3000), never the visitor's host, and the first `X-Forwarded-For` entry is whatever the visitor wrote. Both issues
left a choice open; the maintainer's standing instruction is to decide and record.

- **One module, in the adapters directory: `@sssb/kit/adapters/edge-headers`.** It reads two settings from the
  server's environment, which only an adapters module may, and holds both helpers, since they rest on one promise:
  that every request crossed `SssbApp`'s viewer-request function. Rejected: **a `server-lib` module** taking its
  settings from the caller, which would hand every app the job of reading `PUBLIC_ORIGIN` and the trust switch right.
- **Both sources for the origin (#131's open question), configuration first.** `PUBLIC_ORIGIN` when set, in a request or
  outside one; behind `SssbApp`, `https://` and `x-forwarded-host`; anywhere else, `request.url`'s origin. Configuration
  wins over the header because a deployment served on two origins (its custom domain and `*.cloudfront.net`, both in
  `CLERK_AUTHORIZED_PARTIES`) should mail one. Outside a request with no `PUBLIC_ORIGIN`, and behind `SssbApp` on a
  request that never crossed the distribution (the scheduled tick invokes the server directly), it throws, naming the
  setting. "Crossed" needs proof (both reviews of round 1 found it): Next fills a missing `x-forwarded-host` from `Host`
  (`next/dist/server/base-server.js`), the Function URL's own on the tick's request, so the forwarded host is taken only
  beside a valid `x-sssb-viewer-address`, which nothing but the function writes, and only when it is not `Host`. Rejected: **the header alone**, which a job cannot read; **the setting alone**, which a first deploy on
  `*.cloudfront.net` cannot set (the server's environment cannot name the distribution's host without a dependency
  cycle, as the authorized-parties entry above found); and **`NEXT_PUBLIC_PUBLIC_ORIGIN`**: nothing on the client needs
  it, and a client bundle's value is fixed at build, not per deployment.
- **Forwarded headers are believed only when the deployment says so: `SSSB_EDGE=cloudfront`, set by `SssbApp`.**
  Without it (`pnpm dev`, `dev:real`, a host of the adopter's own) neither helper reads a forwarded header at all, so a
  client cannot choose the answer. Rejected: **believing them whenever `!isSimulated`**, which would trust headers any
  client writes on a real-mode server that is not behind `SssbApp`; and **believing them always**, the dev-mode hole
  #131's fallback would otherwise have. Any other value of `SSSB_EDGE` is refused, at boot by `assertRealEnv` (cutover
  row `domains-and-certs`) and on first use, rather than read as on or off; so is `SSSB_EDGE` off Lambda (no
  `AWS_LAMBDA_FUNCTION_NAME`), where a deployment's environment copied into `dev:real` would otherwise trust any client.
  Rejected: **letting an adopter set it behind a proxy of their own** (the first cut), a promise SSSB cannot check.
  The promise it does make is checked at synth: `SssbApp` fails a behavior of any distribution in its stack, an origin
  group's included, that reaches the server without the function. A distribution in another stack names the Function
  URL by an import, which the check does not follow; it would also need its own origin access grant.
- **The address comes from a header of SSSB's own, `x-sssb-viewer-address`, written by the CloudFront Function from
  `event.viewer.ip` (#132's open question).** CloudFront's docs say neither whether a viewer's own
  `CloudFront-Viewer-Address` is overwritten nor, by name, that `AllViewerExceptHostHeader` forwards it; and counting
  `X-Forwarded-For` from the right depends on how many entries the Function URL appends, which only a live request would
  show. The function already runs on every behavior that reaches the server (the synth test holds it) and already
  overwrites `x-forwarded-host`; writing one more header there rests on nothing undocumented. Rejected:
  **`CloudFront-Viewer-Address`**, and **the rightmost-minus-N `X-Forwarded-For` entry**, for those reasons. The
  helper returns `undefined`, never a guess, when the header is missing or is not one IP address.
- **A lint rule, `sssb/no-raw-request-origin`, not a conformance check.** It flags a visitor header named as a string
  in `.get`/`.has`/`.getAll` or a computed key (`X-Forwarded-For`, `X-Real-IP`, `CF-Connecting-IP`, `Forwarded`,
  `Host`, `CloudFront-Viewer-Address`, `x-sssb-viewer-address` and the other `X-Forwarded-*`, in any case), and the
  `origin`, `host`, `hostname` or `href` of `new URL(<x>.url)` or `<x>.nextUrl` (by member or destructuring),
  `new URL(path, <x>.url)` and `baseUrl: <x>.url`, in every module of an app's `src/` but its tests, and in the framework
  but the module itself. A header read counts only on something plainly a request's headers (`<x>.headers`,
  `headers()`, a variable named for headers), so `searchParams.get('host')` and `process.env['HOST']` pass. In the app's
  proxy alone, `new URL(path, request.url)` handed straight to a `redirect` or `rewrite` passes too: Next relativizes a
  same-origin redirect only when the proxy answers it (`next/dist/server/web/adapter.js`), so a route handler's would
  send the visitor to the server's bind address (round 2). A name held in a variable gets past, as any alias does. Path
  and search parameters stay allowed. Rejected: **a conformance check**, which would re-implement the same syntax match at
  test time; the lint preset is where the other syntax fences are, and `sssb check-fences` probes it.
- **Live proof is a cutover row, not this change's.** Both issues ask for it; no SSSB session deploys. The
  `domains-and-certs` row now names the proof: forged headers through the distribution's domain, and what the server
  and the helpers see.
- **Every reader moved.** The showcase's invite and preset routes, and the kit's own Simulator host
  (`simulatorApi`'s preset load, which arrived with `feat/simulator-host-snapshots` while this was in review and which
  the rule flagged), build their links on `publicOrigin`. `clerk-proxy.ts` hands Clerk `request.url` unchanged: Clerk
  derives its own URL from `x-forwarded-host` and `x-forwarded-proto` (`@clerk/backend` 3.29, `deriveUrlFromHeaders`).
- **Accepted, not fixed.** A real-mode server off `SssbApp` with no `PUBLIC_ORIGIN` builds links on `request.url`'s
  origin, the bind address, as before this change: Next names it `localhost` either way, so the helper cannot tell a
  local `dev:real` from a host of the adopter's own, and SSSB deploys only through `SssbApp`. The adopting reference
  tells such a host to set `PUBLIC_ORIGIN`. And in `next dev`, `X-Forwarded-Proto` still flips `request.url`'s scheme
  (Next reads it), so a peer on the developer's network can make `publicOrigin` say `https://localhost:<port>`: one bit,
  on a developer's machine.

## The Simulator host serves Snapshots, presets and tours (2026-11-27, `feat/simulator-host-snapshots`)

`safeinsights/sssb#127`: `simulatorApi` serves `reset`, `snapshots` (+ `restore`, `delete`), `flags`, `agreements`
(+ `bump`) and `presets`, and `SimulatorHost` wires the Snapshots and Tours tabs, so a generated app's `pnpm dev` has
them. Decisions the issue left open:

- **`flags` carries the feature flags, in the panel's shape** (`{ flags: [{ flag, enabled }] }`), and `events` will
  not (`safeinsights/sssb#128` asked which). The Snapshots tab owns the knobs, so its own GET answers them and opening
  it fetches no Events payload. Rejected: **the showcase's split** (its `flags` GET answers a `{ name: boolean }`
  record no client reads, and the tab takes its list from `events`), which ties the Snapshots tab to the Events tab's
  route and would be the one path whose shape differs between the two.
- **The Snapshots tab is fetched when it opens and after each of its own actions, never polled**, as the showcase's
  glue does: the tab's own actions refetch it or reload the page, and a change made elsewhere (an agreement edited on an
  app's page) shows the next time it opens. Rejected: **adding it to the open-tab poll**, which reads every tenant's
  agreements every four seconds (`EXPANDED_POLL_MS`) for a list that rarely moves while the tab is open.
- **A snapshot's name is judged by the snapshot store, not the route**: a missing or non-string name is a 400, and a
  name outside the world-start pattern, or one that `reset` or a registered preset already means, is the store's 403,
  as the showcase's routes answer. Rejected: **checking the pattern in the route first** (a 400), which would answer a
  different status from the showcase's for the same request and leave two places that say what a name may be.
- **A preset's links point at `request.url`**, as the showcase's route did (`applyDemoPreset`'s `baseUrl`). On
  `pnpm dev` that is the server the browser called. If a public-origin helper lands (`safeinsights/sssb#131`), this
  call is one of its readers.
- **No `tours` or `presets` registration is needed for the tab to be right**: an app with none gets no Tours tab and
  no presets section (both are the seam's off-switches already), and a reset is the one world start every host has.

## Teams are writable inside their tenant, and an exempt table declares its writes (2026-11-27, `feat/org-write-rls`)

`safeinsights/sssb#124`: `app_user` held `SELECT` only on `organizations`, so a route that created, renamed or deleted
a team failed with `permission denied`, and the coverage check could only hold an exempt table to `SELECT`-only.

- **The writes are tenant-scoped by row-level security; the read stays open.** Migration 0018 grants `INSERT`,
  `UPDATE` and `DELETE` (as column grants, next item), enables RLS on `organizations`, and adds one policy per command: `SELECT` is `USING (true)`
  (callers are resolved before a tenant context exists, and a request joins another team of its own tenant), and each
  write compares `tenant_id` with `app.current_tenant`, in `WITH CHECK` for `INSERT` and `UPDATE` and in `USING` for
  `UPDATE` and `DELETE`. Rejected: **the issue's proposal, the grant with no row-level security**, leaving who may write
  to `authorize(...)`. A team is not a hostile boundary, but the tenant is, and with no policy a request in one tenant
  could rename or delete every other tenant's teams through the sanctioned `withTenant`, which is the cross-tenant
  write the coverage check exists to refuse on every other table. With the policies, `authorize(...)` decides only
  which person may write which team of their own tenant.
- **Column grants: `INSERT (tenant_id, slug, name)`, `UPDATE (name)`, `DELETE`.** A request names a new team's
  tenant, slug and name, and renames it by its name. The slug is how the auth provider and the inbound mail address
  (`<org-slug>+<handler>@`) name a team, and the id is what every other table holds, so neither is a request's to set
  or change. Rejected: **table-level `INSERT, UPDATE`**, which round-1 review showed let a request change a team's
  slug or mint an id another tenant's deleted team once had.
- **A new team's slug may not be one another tenant's team holds** (a `NOT EXISTS` in the INSERT policy). Inbound
  mail resolves the slug across every tenant and refuses two matches, so without it one tenant could silence another
  team's mail by taking its slug (round-1 Fable review). It is a policy, not a constraint: two tenants creating the
  same new slug at once can both pass, a slug freed by a delete is free to any tenant, and the owner bypasses it.
  Rejected here: **a global unique index on `slug`**, whose migration fails on any database already holding one slug
  in two tenants; the real fix, resolving the tenant from the recipient, is `safeinsights/sssb#211`.
- **ENABLE, not FORCE.** FORCE would hold the table's owner to the write policies too, and the owner seeds
  teams with no tenant context (`packages/kit/src/db/seed.ts`). An app's routes do not write as the owner: `getDb()`
  is banned in an app's `src` bar the exceptions it names, and `withTenant` switches to `app_user`. Rejected: **FORCE with
  an owner-only policy**, which would need the owner's role name in a framework migration, which differs per
  deployment. A dedicated non-owner app role (the cutover checklist's `db-role-not-superuser`) is held to the
  policies, which is the safer side: its raw reads are unchanged (`USING (true)`), and it had no write before.
- **`TRUNCATE` is not granted, and cannot be declared**: it ignores row-level security, so it would empty every
  tenant's teams.
- **The coverage check: an exempt entry declares `writes`, and a declared write is proved, not trusted.**
  `RLS_EXEMPT` entries became `{ reason, writes? }`, `writes` drawn from `INSERT`, `UPDATE`, `DELETE`. A table with no
  declaration is still held to `SELECT`-only; a declared write must be held (else a stale declaration), on a table with
  RLS enabled, admitted by some permissive policy, and every permissive policy admitting it (its command's or `ALL`)
  must read the tenant setting in each expression that command evaluates (an absent one admits every row). The
  pinned list carries the declared writes (`public.organizations (DELETE, INSERT, UPDATE)`), so a new declaration is
  a two-file edit with `SECURITY.md`, as a new exemption already was. Rejected: **a declaration that only silences the
  `SELECT`-only failure**, which would let a later `FOR ALL USING (true)` policy, or a disabled RLS, open every
  tenant's teams with the gate green. A declared write also fails when `app_user` holds the owner's privileges (a
  member of the owning role), which skip every policy that is not forced (round-1 review). The policy text is read as
  the tenant tables' is (it mentions the setting), with the same limit: a policy that mentions it and filters nothing
  passes; the behavioural proofs are what show 0018 isolates, and `safeinsights/sssb#212` would read the predicate.
- **The composite uniqueness constraint is taken**: `organizations_tenant_id_id_unique` over `(tenant_id, id)`, so an
  app table can declare `FOREIGN KEY (tenant_id, org_id) REFERENCES organizations (tenant_id, id)` and Postgres refuses
  a row whose team is another tenant's. It costs one index on a small table and rejects nothing the primary key
  accepts. SSSB's own tables keep their plain `org_id` references, so another tenant can still hold a team's id and
  block its deletion; moving them is `safeinsights/sssb#213`.
- **A `DELETE` succeeds only for a team nothing references**: every framework table that names an org holds a plain
  foreign key with no cascade, and the audit trail is append-only, so a request cannot delete a team with history.
  That is the intended posture, not a gap: an app that retires teams records that in a table of its own.

## The upload target's PUT form (2026-11-27, `feat/storage-put-upload`, `safeinsights/sssb#134`)

`UploadTarget` becomes `PostUploadTarget | PutUploadTarget`, `STORAGE_UPLOAD_TARGET` gains `put`, and the showcase
takes a PUT end to end (mint, browser, the fake's endpoint, confirm). What was decided, and what was rejected:

- **A union with `method` optional on the POST form.** A POST target keeps its shape exactly (`{ url, fields }`, and the
  real adapter now also says `method: 'POST'`), so a browser written to it, an app's own storage adapter and a target
  stored as JSON keep working; `method: 'PUT'` is the discriminant and a PUT has `headers`, not `fields`. The cost is
  a compile break for server code that reads `.fields`: filed as Action `required` (a `minor`) in the changeset.
  Rejected: **a second method** (`createPutTarget`), which makes the caller guess the store's form, when the
  deployment's setting is what knows it; and **`fields` kept on the PUT form** (empty), which a browser that ignores
  `method` would then POST without error.
- **The size is signed into the URL, and the app's `head` check is the backstop.** The issue's two candidates: signing
  the exact `Content-Length`, or staging under another key, `head` and `copy`. R2 could not be measured (no live store,
  and nothing in CI calls one), so the choice does not rest on R2 honouring a signed length. What was verified is the
  SDK's side, locally: the presigner signs `content-length;content-type;host` once told to (`signableHeaders`; by default
  it signs `content-length;host` and not the content type), and it must not carry the checksum the SDK's default settings add (`x-amz-checksum-crc32=AAAAAA==`, the
  checksum of an empty body, which no real upload matches). So `UploadConstraints.sizeBytes` is the client's exact size,
  the port says plainly that a PUT's ceiling is held by the store only where it honours a signed length, and the
  showcase's confirm route reads `head` and deletes an object over the ceiling (it read the whole object with `get`
  before). Rejected: **staging plus `copy` as the port's mechanism**, which moves a two-step flow into every app whether
  or not its store honours a signed length, and stores the bytes first; it remains the app's answer on a store that
  ignores the length, and the cutover row asks which R2 is.
- **`sizeBytes` is optional on the type, refused by a PUT mint when absent.** Optional so a POST store's callers and an
  app's own adapter compile unchanged; an adapter that mints a PUT throws a plain `Error` naming it, never mints a URL
  that signs no length. The showcase's mint route now requires `sizeBytes` (400 `invalid-size`), since its client
  always sent it.
- **The setting picks the form, and the default client changes for `put` only.** `createS3Storage({ uploadTarget: 'put' })`
  defaults `requestChecksumCalculation` to `WHEN_REQUIRED` on a client it builds; a client the caller built is used as
  it is, and a signed URL that carries a checksum makes `createUploadTarget` throw, naming the setting, instead of
  minting a URL every upload would fail on. Rejected: **a presign-only client cloned from the given one's config**
  (the SDK's resolved config does not survive being passed to a new client: it failed in a probe), and **stripping the
  checksum with a middleware** (the presigner added it after, in a probe).
- **The fake serves both forms, chosen by `createFakeStorage({ uploadTarget })`.** `fakeStorage` stays POST, so no app's
  simulated mode changes; the PUT form is signed in the URL's query, with a `PUT` marker and the size in the signed
  string so a POST signature never verifies as a PUT or back. The showcase's `/api/storage-upload` gained a `PUT` that
  answers as S3 would, approximately: 403 for a changed key, size, type or signature, 411 with no length, 400 for a
  body that is not as long as it declared. Not done: **a Simulator switch to run the showcase on the PUT form**; the
  browser's PUT branch is unit-tested (`send-to-upload-target.test.ts`) but no e2e runs it.
- **The `head` check is a moment, not a seal (round-1 review).** On a store that ignores a signed length, a second PUT to
  the same URL inside its 15 minutes can replace the object after confirm. The showcase does not close that (it would
  stage under another key and `copy` with `ifMatch` at confirm, so the URL never addresses the live object); the port's
  comment says so and names the staging answer, and it is filed as an issue to do once R2's behaviour is measured.
  Confirm of a row that is already `ready` now returns idempotently before reading storage, because it would otherwise
  reach the delete and remove a good object (a later, lower ceiling does the same).

## The webhook secret's variable, and a Standard Webhooks verifier (2026-11-27, `feat/webhook-verifier`)

Issues `safeinsights/sssb#121` and `safeinsights/sssb#122`, built as one change: both come from the same migrated
future task (service-auth flexibility), touch the same module family, the same lint exemption list and the same
adopter-reference section. Rejected: **two PRs**, which would have raced each other on those files for no review gain.

- **`withWebhookSecret(handler, { secretEnv })`, a name, not a value.** An app may not read `process.env` outside
  `adapters/real/` (the guide), so a value would have to come from somewhere the app cannot reach; the name is what the
  issue asked for. It defaults to `WEBHOOK_SECRET`, which stays in `REQUIRED_ENV` and the required-environment snapshot
  (the cron route and the jobs webhook use it), so the snapshot is unchanged and the changeset is a `patch`. A custom
  name is not added to `assertRealEnv`: the framework cannot see which names an app's routes pass, so the adopter
  reference says it is the app's own cutover row. **The name is checked** (`[A-Z_][A-Z0-9_]*`, never `NEXT_PUBLIC_*`,
  which Next inlines into the browser bundle) when the wrapper is built, so a typo fails as the route module loads, not
  as a 401 in production. Rejected: **accepting any string**, which turns `'partner-secret'` into a route that refuses
  everything with no error.
- **The Standard Webhooks verifier ships in the kit.** It is not vendor code: Standard Webhooks is an open
  specification, verified with `node:crypto` and no SDK, so the vendor-code tests in `docs/development-approach.md` do
  not govern it. It is a member of a class SSSB already teaches (the verified machine caller), and the default auth
  vendor's own webhooks are Svix-signed (`@clerk/backend` 3.29's `webhooks` module verifies `svix-id`,
  `svix-timestamp` and `svix-signature`), so the first product that syncs users from Clerk needs it. Rejected: **a recipe**, which every such app would hand-roll, and hand-rolled HMAC checks are where the
  constant-time compare and the replay window get dropped.
- **`node:crypto`, not the pure-TS HMAC in `@sssb/kit/core/webhook-hmac`.** That one exists for the static demo, which
  never receives a webhook, and keys the HMAC with a string's UTF-8 bytes, while a Standard Webhooks key is the
  base64-decoded bytes of the `whsec_` secret. The verifier is server-only, as `webhook.ts` already is.
- **The replay store keys on the sender, the id AND the timestamp.** A replay is the same signed message sent again,
  and that carries the same timestamp. A sender's retry is re-signed with a new timestamp (its schedule runs for hours,
  past any window), so it passes and reaches the handler, which the adopter reference tells to dedupe by `webhook.id`,
  the idempotency key the specification names. Rejected: **keying on the id alone**, which answers a legitimate retry
  401 (after a 2xx that the sender never saw, say) and leaves the sender retrying until it disables the endpoint. The
  sender (the sorted `secretEnv` names) is in the key so that two senders' ids never collide, and one sender cannot
  claim keys another will use (round-2 review). A claim lasts until the signature stops verifying
  (`max(now, timestamp) + tolerance`, as Mailgun's guard) plus a minute, because a shared store judges expiry by its
  own clock, after its own latency (round-2 review). The freshness check and the in-process claim use one clock reading
  taken after the body has arrived, and the headers are judged before the body is read (round-1 review: a body sent
  slowly let a replay past a claim pruned by a later clock). A claim is released when the handler throws or answers
  5xx, so the sender's resend of that message is processed; the cost is that a captured copy of a failing message can
  run the handler again inside the window, which handler idempotency covers.
- **The default store is per process; a shared one is a follow-up.** `SssbApp` runs the server on Lambda, where every
  concurrent execution environment has its own memory, so in a deployment the default guard holds per environment and
  handler idempotency is the defence across them. `replayStore` (two functions) lets an app pass a shared store, and
  `safeinsights/sssb#205` is the kit shipping one over a framework table, for Mailgun's guard too. Rejected: **only
  documenting the limit**, as Mailgun's guard does, when an interface of two functions lets an app close it now; and
  **building the table here**, a framework migration with its own RLS and contract-suite proofs, outside these issues.
- **`secretEnv` has no default here.** Each sender has its own secret, and two routes falling back to one default name
  would silently share it. It takes one name or several, and each value may hold several whitespace-separated
  secrets, so a rotation is "add the new one beside the old". A secret that is not base64 (after an optional `whsec_`)
  matches nothing, and neither does a key under 16 bytes (round-1 review: `changeme` is valid base64 for a six-byte
  key). The specification recommends 24 to 64 bytes; 16 is the floor below which a value is guessable, and every
  sender following the specification is above it. Rejected: **no minimum**, the first cut. `toleranceMs` must be
  positive and finite, checked when the wrapper is built (round 1: `NaN` turned the freshness check off).
- **Svix's `svix-*` headers are read when no `webhook-*` header is present**, as Svix's own libraries do. One header of
  a family selects it, so the two are never mixed.
- **An id may contain a dot.** `{id}.{timestamp}.{body}` lets digits move across a dot, and the same signature then
  covers another (id, timestamp, body). The moved timestamp must be fresh, so it takes a body that begins with a current
  Unix time and a dot (which a Standard Webhooks payload, a JSON object, never does) or an id that ends with a dot and a
  current Unix time (and the re-parsed body is then not JSON). Rejected: **refusing dotted ids**, which the
  specification allows and which would lock out such a sender with no workaround, for a forgery that needs a sender's
  ids to end in a timestamp and yields a body no JSON handler accepts.
- **The wrapper is the kit's, as `withWebhookSecret` is**, not app-side as the showcase's Mailgun wrapper is, and the
  `webhooks/` exemption names it beside the other two (`packages/kit/test-fixture/api/webhooks/wharf-signals/route.ts`
  demonstrates the gate).

## The Simulator host serves Events, Messages, inbound mail, Hooks and Errors (2026-11-27, `feat/simulator-host-subsystem-tabs`)

`safeinsights/sssb#128`: `simulatorApi` serves `events`, `audit`, `messages`, `inbound`, `inbound/compose`, `webhooks`,
`webhooks/fail`, `webhooks/run-due` and `error-scenario`, and `SimulatorHost` wires the tabs, so a generated app's
`pnpm dev` has every framework tab but the ones `safeinsights/sssb#152` owns (an app's own tabs, the dev ticker).
Decisions the issue left open:

- **`events` carries no feature flags**; the Snapshots tab reads them from `flags`, as the stage before this decided.
  Rejected: **the reference app's payload**, `{ events, flags }`, which made the Snapshots tab fetch the Events tab's
  route; its glue moves onto the host with `safeinsights/sssb#129`.
- **`inbound/compose` takes mail in through `intakeInboundEmail`**, the function the real inbound webhook calls (the
  reference app's `api/webhooks/email` route), addressed with `formatInboundRecipient` on the demo domain. So it
  reaches the app's handlers through `@sssb/kit/inbound-email/handlers` and no other way, and a handler the app does
  not register is intake's to judge (kept as `unmatched`), never an error of the route's. Rejected: **calling the
  handler from the registry directly**, a second way in that would skip intake's filing, status and fault isolation.
- **The Mail tab shows inbound mail only when the app registers an inbound handler.** An empty registration is the
  off switch for a capability; with no handler, nothing the form sends can reach the app. Rejected: **always showing
  the compose form**, whose every message a starter would file as `unmatched` under a handler name it never had (the
  form's default, `note`, is no app's: the reference app registers `support` and `feedback`).
- **A failed Errors scenario leaves the tab as it was**: `ErrorsApp` now catches the promise it is handed. The
  reference app's glue rejects it too when its server has stopped, and nothing caught that either.

## The showcase runs on the kit's Simulator host (2026-11-27, `feat/simulator-host-showcase`)

`safeinsights/sssb#129`: the showcase mounts `api/simulator/[...path]/route.ts` and renders SSSB's `SimulatorHost` from
its locale layout, and its 873-line `simulator-glue.tsx`, 17 of its 21 `api/simulator/` route directories and two
helper modules are gone. The issue asked for this once `safeinsights/sssb#127`, `#128` and `#152` served every path the
glue called; `#152` (the dev ticker and an app's own tabs) is undecided and unowned, so this lands without it, by the
manager's call, and leaves `#152`'s question open:

- **What stays the showcase's**: the server half of the dev ticker (`api/simulator/ticker`, whose policy builds on
  `@sssb/tools`, which the kit may not import), the routes the Actors tab's drivers call (`actors/*`,
  `service-token`, `webhook-secret`), the actor pages, and a short glue that hands the host the Actors tab and keeps the
  panel out of the actor frames. Next routes each static segment before the catch-all, so those route files win.
- **The ticker's client control moved into the host**, shown only where the app's own `ticker` route answers (the
  catch-all answers 404 there, and the host then stops asking, as the glue did). That moves no policy: the server half
  is still the app's, so `#152`'s three options for it stand. Rejected: **keeping the control in the showcase's glue**,
  which would have to own the Jobs tab, and with it the whole panel again.
- **`SimulatorHost` takes `extraTabs`** (the panel's own `SimulatorExtraTab[]`), and an app's tab content reads the
  world's jobs with `useSimulatorWorld()`, from the same subpath. Both are provisional public surface until `#152`
  decides how an app's tabs reach the host, and say so where they are declared. They are named exports of subpaths
  already published (`@sssb/kit/components/simulator/simulator-host` and `.../simulator-panel`), so the `exports` map
  does not change. Rejected: **a render-function prop** handed the host's state, which cannot call hooks (the Actors tab
  needs translations), and **a hook passed as a prop**, which breaks the rules of hooks the React Compiler checks.
- **The mail-link check moved into the kit** (`packages/kit/src/components/simulator/mail-link.ts`, not published), with
  its tests, and the host's link handler uses it; the showcase's copy and its `server-redirect` helper (`sameOriginPath`
  on a body's `redirectTo`, which the host does inline) are deleted.
- **The route tests that only asserted the real-mode 404** are covered by the kit host's dispatch tests; the ones with
  more (jobs held, run-pending, mail seen for a person and an invite, the viewpoint's remembered path) have kit
  equivalents in `packages/kit/src/server-lib/simulator-api.test.ts`.
- **jscpd, re-measured as the issue asked** (2026-11-27, `pnpm jscpd` with the repository's `.jscpd.json`): 41 clones,
  654 duplicated lines (1.40%) on this branch, against 50 clones and 758 lines (1.57%) on `int-platform` before it.
  Nine fewer clones in all, which counts the showcase-and-starter pairs `safeinsights/sssb#114` tracks among them.

## Main (0.9.1) into int-fixes: where the job retries' Simulator call went (2026-11-28, `merge/main-into-int-fixes`)

Main moved the Simulator's clock and run-due routes out of the showcase into the kit's host (`simulator-api.ts`, served by
each app's `api/simulator/[...path]` route, safeinsights/sssb#129) while int-fixes added due job retries to those routes
(safeinsights/sssb#135; the entry above, "Job retries with backoff, a new row per attempt", names them). The merge takes the deletion: both
routes are gone, and the host's `runDueAtWorldNow`, which its `clock` and `schedules/run-due` handlers share, runs due
schedules, then due retries, then due deliveries, as the two routes did. `simulator-api.test.ts` proves it through the
host: run-due alone leaves a retry that is not yet due, and moving the clock past its backoff starts it (red with the call
taken out). The static twin's clock runs its own retry drain, which main did not touch.

The other conflicts: the migrations registry and the family fence list main's `0018_organizations_write` (unchanged)
with int-fixes' 0019 to 0021; the attachment confirm route authorizes before its lookup (int-fixes, safeinsights/sssb#137)
and then takes main's pending check, `head` and size ceiling; the export count is 148 (145 at the merge base, one added
by int-fixes, two by main), and the internal-module count 99, as `public-surface.test.ts` computes it.

**A database that ran int-fixes' 0019 to 0021 before 0018 cannot take 0018.** The migrator runs the two sequences
(framework, app) unordered against each other, but in order within each (`packages/kit/src/db/migrate.ts`, "migrations
out of order within their sequence"), so 0018 after 0019 is refused, loudly, at the first query. Every released database
is fine: 0.9.1's has 0018 and takes 0019 to 0021 after it, and an older one takes all four in order. What is refused is a
world, local or deployed, built from int-fixes before this merge: this checkout's own e2e world failed exactly so until
it was wiped (CLAUDE.md's rule after a migration change). Nothing in the code changes: 0019 to 0021 already come after 0018, which is right for every released database.
Such a world is wiped; whether a deployment runs int-fixes, and so must be kept, is for its owner to say.
