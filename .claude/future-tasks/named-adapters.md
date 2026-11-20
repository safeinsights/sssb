# Named adapters: an app's own adapter for a kit port

**Priority:** P3 · **Status:** open, recorded design; build when an adopter needs a provider SSSB does not ship for a
port with no protocol choice (an LLM other than Anthropic is the likeliest first)
**Decided in:** ADR-0015, sections 3 and 4 and the first addendum (the mechanism), and the second addendum (2026-11-19),
point 1 (named rather than `app`) and point 2 (ports designed against two implementations).

## The shape, decided

- The app writes its adapter in its own `apps/<app>/src/adapters/real/` and registers it under a name it chooses:
  `llm: { openai: { create, env } }`. A deployment selects it as it selects one of SSSB's: `LLM_PROVIDER=openai`.
- A name may not be one of SSSB's own choices for the port; boot fails when it is.
- Registration is split for boot safety, as the first addendum says: `@sssb/app-config/adapter-env` (data only: each
  named adapter's settings, each with its cutover row), `@sssb/app-config/adapters` (the factories, imported by the
  registry with `import()` and handed to `createRealPorts` as hooks), and, for auth only, `@sssb/app-config/auth-proxy`.
- The factory's full signature is settled once, for every port, before any app writes one: `create(ports)` with the
  ports already built, the job runner's notifier and lazy loading, the auth middleware.
- A graph check (esbuild's metafile, as `sssb check-real-env` builds it) fails when an app adapter's module graph
  reaches `@sssb/kit/adapters/index`, since that would deadlock boot.
- A port contract suite, `@sssb/kit/testing/ports`, run against SSSB's fakes in SSSB's CI and against the app's adapter
  in a runner of its own (`apps/<app>/tests/ports/`, needing the vendor's credentials, failing without them unless opted out by
  name). `sssb doctor` checks the app runs it for each named adapter, reading `adapter-env`.

## Start with

The LLM port, whose suite has substance and whose adapter needs no other port. Then analytics (its switch first,
`posthog` by default, `none` a no-op: a breaking change) and jobs.

## Done when, for the first port

- An app registers a named LLM adapter, and a deployment selects it by name.
- Simulated mode and every other choice load none of it (a module-load test).
- The contract suite runs against SSSB's fake.
- A scratch adapter in a pack-and-consume shape proves an adopter's workspace can do it.
- Every new gate has been seen red.
