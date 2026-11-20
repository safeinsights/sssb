# Named adapters: an app's own adapter for a kit port

**Priority:** P3 · **Status:** open, recorded design. Build when an adopter needs a provider SSSB does not ship and no
protocol choice covers it; an LLM other than Anthropic is the likeliest first.
**Decided in:** ADR-0015, second addendum (2026-11-19), point 1: an app registers its adapter under a name, and a
deployment selects it by that name. The rest of this brief is proposed design, drawn from sections 3 and 4 and the
first addendum; decide each part and record it in `docs/decision-log.md`.

## Proposed shape

- **The adapter:** the app writes it in its own `apps/<app>/src/adapters/real/`, and a deployment selects it as it
  selects one of SSSB's: `LLM_PROVIDER=openai`.
- **Registration, split for boot safety**, because the registry is still being evaluated when the real ports are built,
  and `sssb check-real-env` bundles them as CommonJS:
    - `@sssb/app-config/adapter-env`, data only: each named adapter's settings, each mapped to its cutover row
      (`{ llm: { openai: { OPENAI_API_KEY: 'llm-openai' } } }`);
    - `@sssb/app-config/adapters`, the factories (`{ llm: { openai: { create } } }`), which the registry imports with
      `import()` and hands to `createRealPorts` as hooks;
    - for auth only, `@sssb/app-config/auth-proxy` (`auth-provider-bundle.md`).
- **The factory signature is settled once, for every port, before any app writes one:** `create(ports)` with the ports
  already built, plus the job runner's notifier and lazy loading.
- **A name may not be one of SSSB's own choices for the port**, and boot fails if it is, so a name never means two
  adapters.
- **`SssbApp` must accept the names.** `portsEnvironment` (`packages/cdk/src/optional-ports.js`) refuses any choice
  outside its fixed list, so `LLM_PROVIDER=openai` fails at synth today. `SssbApp` is plain JavaScript and does not load
  an app's TypeScript. Options:
    - `params.ports` accepts a name the app also lists in a plain-data form the construct can read;
    - or the construct passes an unknown name through and leaves the check to boot.

    Decide.

- **A graph check** (esbuild's metafile, as `sssb check-real-env` builds it) fails when an app adapter's module graph
  reaches `@sssb/kit/adapters/index`, since that would deadlock boot.
- **A port contract suite**, `@sssb/kit/testing/ports`, run two ways:
    - against SSSB's fakes in SSSB's CI;
    - against each named adapter in a runner of its own (`apps/<app>/tests/ports/`). It needs the vendor's credentials,
      so it fails without them unless opted out by name.

    `sssb doctor` checks the app runs it for each named adapter, reading `adapter-env` through esbuild, since doctor
    evaluates no app TypeScript today.

- **Versioning:** once apps write adapters, a port change can break them. Decide how such a change is released, as part
  of this task, not before.

## Start with

The LLM port, whose suite has substance and whose adapter needs no other port. Then analytics (its switch first,
`posthog` by default, `none` a no-op: a breaking change) and jobs.

## Done when, for the first port

- An app registers a named LLM adapter, and a deployment selects it by name, through `SssbApp` too.
- Simulated mode and every other choice load none of it (a module-load test).
- The contract suite runs against SSSB's fake.
- A scratch adapter in a pack-and-consume shape proves an adopter's workspace can do it.
- Every new gate has been seen red.
