# ADR-0010 — Observability: Sentry errors + PostHog analytics

- Status: Accepted
- Approver: JP Slavinsky
- Date: 2026-08-01

## Context

Error tracking and product analytics are different jobs, and the tools that do both do one of them
noticeably worse. Sentry's error tracking — stack grouping, release association, source maps, the
on-call workflow around an issue — is the mature option and has no product analytics. PostHog's product
analytics and feature flags are the mature option there, and its error tracking is younger than Sentry's.

There is a second, structural difference between the two that decides how each is wired. Error tracking
is **instrumentation**: it has to be installed before the app's own code runs, wrap the framework's error
boundaries, and see failures the app never catches. Analytics is **something the app calls**: a `capture`
here, a flag read there. Those are not the same shape, and forcing both behind a port would mean either a
port nobody can implement or instrumentation that misses the errors it exists to catch.

## Decision

**Sentry for error tracking, wired as instrumentation.** `@sentry/nextjs`, the app's
`instrumentation.ts` / `instrumentation-client.ts`, and `withSentryConfig` in its `next.config.ts`. It is
**inert without a DSN**, so a hermetic dev run initializes nothing and phones nowhere — and because it is
inert, an app can leave it out entirely: `apps/showcase` wires it, `apps/starter` deliberately does not,
which is what keeps "opt-in" true rather than assumed.

Event scrubbing is deliberately **not** in the vendor's hands:
`packages/keel/src/observability/scrub.ts` is pure TypeScript that strips cookies, authorization and
API-key headers, query strings, and user email/IP before anything leaves the process. Being pure means it
unit-tests without the SDK, which matters because it is the one piece here whose failure is a data
incident rather than a missing graph.

**PostHog for product analytics and feature flags, strictly behind the `analytics` port** (`capture`,
`isFlagEnabled`). The real adapter is enabled in staging and production only; the no-op fake runs
everywhere else, so nothing in dev, demo or E2E emits telemetry.

**A health endpoint plus basic CloudWatch alarms** (server errors, throttles) in the CDK stack — the
floor below both vendors, and the thing that still works when a vendor is down.

Both are cutover items (`errors`, `analytics` in `docs/cutover-checklist.md`), and the Sentry
organization and project names are placeholders in the app's `config/params.ts`. No account, DSN or
project name for any real organization appears in this repo.

## Consequences

- Two vendors, each doing only the job it is best at, and neither of them keyed until cutover.
- The asymmetry is the point and worth stating so it does not look like an oversight: **Sentry is
  instrumentation, PostHog is a port.** The vendor-SDK lint (`@sentry/*` and `posthog-*` only inside
  `packages/keel/src/adapters/`) covers both wherever it can reach, so "not a port" does not mean "not
  fenced". It cannot reach everywhere, and the exception is worth naming rather than discovering: an
  app's `next.config.ts` imports `withSentryConfig` directly, because a build-time config must, and it
  sits outside the fence's `apps/*/src/**` glob by construction — the same class of exception ADR-0012
  records for the two call sites that reach keel by file path. Everything at request time goes through
  `keel/adapters/sentry/*`.
- Feature flags arriving through the analytics port means the simulated world can drive them without a
  vendor: the Simulator's flag registry is the same seam, so a flag is demonstrable before anyone has a
  PostHog project.
- Scrubbing is code this repo owns and must keep current. A new sensitive header is a change here, not a
  vendor setting.

## Addendum (2026-11-17): an explicit data-collection baseline for `@sentry/nextjs` 11

Sentry v11 removed `sendDefaultPii` and replaced it with `dataCollection`, one switch per category, and
flipped the default: an unset `dataCollection` resolves every category to "collect"
(`resolveDataCollectionOptions` in `@sentry/core` 11.12), which means user info and IP, cookies, HTTP request and
response bodies, database query data, queue arguments, and GenAI and MCP inputs and outputs. v10 with
`sendDefaultPii` unset, which is what this repo ran, mapped to a narrower set (`defaultPiiToCollectionOptions(false)`
in `@sentry/core` 10.78): no user info, no bodies, no database query data, no GenAI or MCP content, and cookies,
headers and query parameters filtered by a short denylist. v11 also installs default integrations that v10 did not
(on Node: `Aws`, `AwsLambdaWeb`, `Dataloader`, `Knex`, `Neon` and others; on the Next.js server, `NextjsUseCache`),
and some of them attach metadata, such as Secrets Manager ARNs and cache keys or tags, that no `dataCollection` key
covers. The framework's two `Sentry.init` calls (`packages/kit/src/adapters/sentry/init.ts` and `client.ts`) set
none of this, so taking the bump as it came would have sent Sentry more than v10 did, from a multi-tenant
framework. `scrubEvent` would have caught little of it: it strips cookies, query strings, three headers and the
user's email and IP from error events only, and `beforeSend` never sees spans.

Decision: both init calls spread one constant, `SENTRY_V10_BASELINE` in
`packages/kit/src/adapters/sentry/baseline.ts`. It holds collection **at or below** v10:

- **Every `dataCollection` key is set.** The values are Sentry's "keep the v10 default behavior" block from the v11
  migration guide, plus `mcp` (11.12 resolves an omitted `mcp` to "collect"), `stackFrameVariables: false` and
  `frameContextLines: 5`. The block is stricter than 10.78's own mapping on `cookies` and `graphQL`, and so is
  `httpBodies: []` in practice: 10.78's Node HTTP integration attached incoming request bodies to error events
  whatever `sendDefaultPii` said (`maxRequestBodySize` defaulted to `"medium"`), while 11.12 gates them on
  `httpBodies`.
- **`attachStacktrace: false`**, v10's default. v11 turned it on, which adds a stack trace with source context to
  `captureMessage` events.
- **`integrations` keeps only the default integrations 10.78 installed**, by name, plus two renamed successors
  (`EventFilters`, `WorkerThreads`). It is an allowlist, so a default that a later 11.x adds is dropped until
  someone decides otherwise.
- **`scrubEvent` also cuts the query and fragment off `request.url`**, because 11.x's edge init builds that URL
  with its query.

Three tests pin it. `baseline.test.ts` checks, through both init functions, the whole `dataCollection` object
against a literal written in the test, plus `attachStacktrace` and the integration filter.
`default-integrations.test.ts` runs the filter over the installed SDK's real default lists for Node, edge and the
browser, and names exactly what it drops. `scrub.test.ts` covers the URL.

Consequences:

- Collecting more than v10 did is a privacy decision taken here, with these tests and this ADR changed together,
  never something a dependency bump does by default. A Sentry bump that adds or renames a default integration
  fails `default-integrations.test.ts`.
- What is left is v10-level span data: request URLs (including query parameters outside the denylist) and headers
  on spans, as v10 sent them. `scrubEvent` stays the last pass on error events, and it is still the place a new
  sensitive field gets added.
- The baseline is framework code, so an adopter inherits it. The kit has no per-app seam for widening it: an app
  that wants more (request bodies on its own routes, say) changes `baseline.ts` in its fork and owns that decision.
