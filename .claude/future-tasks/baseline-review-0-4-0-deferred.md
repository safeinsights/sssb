# Deferred from the baseline review of 0.4.0

The review of 2026-11-20 (decision log, "Baseline review of 0.4.0") fixed what it could demonstrate. These it found
and left, because each needs a decision between real alternatives. One section each; take them separately.

## Database TLS on the `pg` transport

Neither the server's real adapter (`packages/kit/src/adapters/real/db.ts`) nor the migrator
(`packages/kit/src/adapters/real/migrate-handler.ts`) sets an SSL mode. The server's TLS is whatever `DATABASE_URL`
asks for; the migrator builds its URL from the secret and cannot carry one, so a cluster that forces SSL refuses
it. Proposed: one deployment parameter both read (an SSL mode beside the transport in `apps/<app>/config/params.ts`), set by
`SssbApp`. The cutover row `db-role-not-superuser` names the gap until then.

## A timeout and error mapping for the LLM adapter

`packages/kit/src/adapters/real/llm.ts` sets no timeout: the SDK's default is ten minutes and the server gets thirty
seconds, so a slow call ends as a killed invocation. A vendor 429 or 529 is a plain 500. Needs: where the timeout
lives (a job in CodeBuild may want longer than a request), and which port error a rate limit maps to.

## A bound per tick on webhook and schedule drains

`runDueDeliveries` and `runDueSchedules` drain every due row of every tenant in one tick, in sequence, ten seconds a
delivery. One org with a slow endpoint can push the tick past a Lambda timeout and starve later tenants. Needs a
per-tick and per-tenant budget, and an order that is fair across tenants.

## The static demo does not re-theme on a tenant switch

Each app's `apps/<app>/src/demo-static/main.tsx` themes by the first tenant; the server layout themes by the signed-in one.
Proposed: `DemoShell` renders the theme provider itself from `world.tenant`, kit-side, one place. It changes the apps' static composition root; the starter's `demo-static/app.tsx` is in the `sssb remove-items` diffs, its `main.tsx` is not.

## A feature-flag read has no short bound

The PostHog adapter's `capture` is bounded at two seconds. A flag read uses the client's own
`featureFlagsRequestTimeoutMs`, ten seconds by default with retries, and the protected layout awaits one on every
render. Decide the bound and set it.

## The service actor's completion notifies no one

`apps/showcase/src/app/api/service/jobs/[id]/status/route.ts` records a terminal status and enqueues the webhook; it
never calls `notifyJobTerminal`, which the builder's webhook route and the in-process runner do. The static demo now
matches the server. Whether a service actor's completion should notify is a product question for the showcase.

## Smaller ones

- `service_keys` has independent foreign keys to tenants and organizations, so a mis-minted row could pair an org
  with another tenant; only the privileged owner writes it. A composite key would close it, with a migration.
- `POST /api/agreements/accept` can be repeated without limit, each adding an acceptance row and an audit event.
- The duplication gate (`.jscpd.json`) and the coverage report read TypeScript only; `@sssb/tools`, `@sssb/create`,
  `@sssb/eslint-plugin` and `@sssb/cdk` are JavaScript. Measure the widened pattern before adopting it.
- The ticker's marker is keyed on a pid; a wrapper killed with SIGKILL leaves it, and a reused pid then refuses e2e
  until the file is deleted. The marker already records when it started.
- `release-dry-run` is not a required check on `main` or the integration branches, so a PR can merge with it red and
  then block the next release. `integration` and `int-*` have no pull-request rule. Both are repository settings,
  JP's to change.
- The authorization scan refuses two correct shapes (ADR-0012, 2026-11-20 addendum): `Promise.all(...).then(f)`, and
  an un-awaited sync `forEach` on a receiver whose head is an import.
- The default model ids in `packages/kit/src/core/llm-models.ts` are older than the current models; raising them
  means re-recording the LLM fixtures (`/record-fixtures`).
- A stream error after partial assistant text leaves the truncated answer with no sign it failed.
