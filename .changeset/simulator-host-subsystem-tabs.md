---
'@sssb/kit': patch
---

### The Simulator's Events, Messages, inbound mail, Hooks and Errors tabs on an app's own `pnpm dev`

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
