# A Simulator start/stop control for the dev ticker

**Priority:** P2 · **Status:** open
**Found by:** JP, 2026-11-17, while reviewing `pnpm tick` and the opt-in `DEV_TICK_SECONDS` ticker: can the Simulator
start the ticking clock from its UI?

## What exists

`packages/tools/src/tick/ticker.js` (`@sssb/tools/ticker`) is the ticker as an object: `createTicker({ origin, markerFile })` returns `start(seconds)`,
`stop()` and `status()` (`{ running, seconds, ticks, lastTickAt, lastError }`). It reads no environment and wires no
process, so it can be driven from anywhere. Today its only user is `sssb dev-tick` (`packages/tools/src/tick/dev-tick.js`), which is the policy for
`pnpm dev`: start it only when `DEV_TICK_SECONDS` is set, refuse under `E2E_BUILD` and `DEMO_MODE`, and leave a marker
(`packages/tools/src/tick/ticker-marker.js`, `@sssb/tools/ticker-marker`) that both apps' playwright configs refuse to load past, because Playwright adopts a dev
server already on its port. `docs/decision-log.md` ("`pnpm tick`, and a dev ticker that is opt-in") records why it is off
by default.

## What is wanted

A Start / Stop control, with an interval field and the status line, in the showcase's Simulator panel (the Jobs tab is
where "advance the clock and run what is due" already lives), so a presenter can have the scheduler tick without a
terminal.

## Design, so it is not re-derived

- **The ticker has to live in the server process**, because a browser tab closing must not stop it and the static demo
  has no server. A route handler in the app (a `ticker` route beside `apps/showcase/src/app/api/simulator/flags/route.ts`, GET for
  `status()`, POST `{ action: 'start' | 'stop', seconds }`) owns one module-level `createTicker` for the dev server. The origin it
  ticks is the server's own (`http://localhost:<port>`), so it goes through the real route and the real
  `withWebhookSecret` guard like every other caller; no new way into `runScheduledTick`.
- **`tickOnce` reads the secret from `.data`**, the same file the server writes, so the in-process ticker needs no new
  secret path. It could call `runScheduledTick` directly instead of over HTTP; do not, unless the marker and the guard
  story below are kept: going through the route is what keeps "the route is the only door" true.
- **Mutating route, so it must call `authorize(...)`** (the build-time scan, the conformance suite's
  `authz-mutations` check in `packages/kit/src/authz/app-exemptions.ts`); gate it like the other Simulator routes, and 404 outside a
  simulated world, which is how `apps/showcase/src/app/api/simulator/flags/route.ts` already refuses real mode.
- **Policy stays the control's, not the module's.** Off by default (nothing starts it until someone clicks). Never under
  e2e: the e2e suites click through the Simulator, so the control must be absent or inert when the app is built with
  `E2E_BUILD`, and a test must pin that. Never in the static demo: its Simulator is the browser twin
  (`@sssb/kit/demo-static/*`), which has no server; the control is a server-only affordance and the twin must not render
  it (or must tick its own world clock, which is a different feature).
- **The marker must follow the server's ticker**, not the wrapper's: call `createTicker` with `markerFile` so a ticker
  started from the UI also keeps `pnpm test:e2e` from adopting that server. Its pid is the dev server's.
- **Two sources of ticking** (the `DEV_TICK_SECONDS` wrapper and the UI) must not run at once. The marker (pid and interval) shows
  that one is live; the control should read it and refuse to start a second.
- **Copy through next-intl** in both catalogs (kit's Simulator namespace), per the no-hard-coded-strings rule.

## Where it lands

The Simulator panel is in `packages/kit` (`packages/kit/src/components/simulator`), which the P3 step of ADR-0014 was
editing when this was written: start after that lands, or the change collides. The route and the module-level ticker
are app code (`apps/*/src/app/api`), so the starter, which has no Simulator panel, needs none of this.
