# Simulator on an app's `pnpm dev`, stage 3: the subsystem tabs (Events, Messages, inbound mail, Hooks, Errors)

**Priority:** P2 · **Status:** open
**Found by:** adoption follow-up 6, stage 1 (2026-11-18). Read `simulator-host-stage-2-world-state.md` first for what
stage 1 built.

## The work

Serve the read-mostly subsystem routes from `@sssb/kit/server-lib/simulator-api` and wire their tabs in
`@sssb/kit/components/simulator/simulator-host`. Every call below is already the kit's; the showcase's routes are
thin wrappers over it.

| Path                                                          | Showcase route today                                 | Tab                     |
| ------------------------------------------------------------- | ---------------------------------------------------- | ----------------------- |
| GET `events`                                                  | `apps/showcase/src/app/api/simulator/events`         | Events                  |
| GET `audit`                                                   | `apps/showcase/src/app/api/simulator/audit`          | Events (beneath events) |
| GET `messages`                                                | `apps/showcase/src/app/api/simulator/messages`       | Messages (SMS)          |
| GET `inbound`, POST `inbound/compose`                         | `apps/showcase/src/app/api/simulator/inbound`        | Mail (compose inbound)  |
| GET `webhooks`, POST `webhooks/fail`, POST `webhooks/run-due` | `apps/showcase/src/app/api/simulator/webhooks`       | Hooks                   |
| GET `error-scenario`                                          | `apps/showcase/src/app/api/simulator/error-scenario` | Errors                  |

Notes for whoever builds it:

- `inbound/compose` runs the app's registered inbound handlers (`@sssb/kit/inbound-email/handlers`), so it is the one
  path here that executes app code. It is still the simulated world's own inbound path, as Mailgun's would be; check
  that it reaches the handlers the same way the real webhook does, through the registry, never a second way in.
- The Events tab's feature flags ride on the `events` payload in the showcase because Snapshots shows them; settle
  whether `flags` (stage 2) or `events` carries them before both stages ship.
- A tab appears only when the host passes its props (`SimulatorPanel`), so each tab can land on its own.

## Done when

Every framework tab but those stage 4 owns is on the starter's `pnpm dev`, each path covered in
`simulator-api.test.ts` against the fixture seam.
