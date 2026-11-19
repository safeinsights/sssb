# Simulator on an app's `pnpm dev`, stage 4: the dev ticker and the app's own tabs (Actors)

**Priority:** P3 · **Status:** open — two design questions before code
**Found by:** adoption follow-up 6, stage 1 (2026-11-18). Read `simulator-host-stage-2-world-state.md` first for what
stage 1 built.

## The dev ticker control

The Jobs tab's Start/Stop ticker (`apps/showcase/src/app/api/simulator/ticker`) is served only by a simulated
`next dev` (`isSimulatedDevServer`). Its policy module, `apps/showcase/src/app/api/simulator/ticker/dev-ticker.ts`,
builds on `@sssb/tools/ticker`, `@sssb/tools/ticker-marker` and `@sssb/tools/ports` (`portFor('showcase')`, the origin
it ticks). Stage 1 left it out because the kit cannot take it as written:

- `@sssb/kit` has no dependency on `@sssb/tools` today, and the tools reach the kit only through
  `packages/tools/src/kit.js`. Either the kit takes `@sssb/tools` as a dependency (a decision about the package graph),
  or the app passes a ticker control in (the route file would then build one with `@sssb/tools`, and stop being one
  line), or the policy moves into `@sssb/tools` and the kit's route asks for it by a seam module.
- The origin must be the port the dev server was started on, never one taken from the request (the dev secret goes to
  it as a bearer). The showcase names its slot; a generated app would read its own declaration
  (`.claude/future-tasks/resolved/neutral-app-port-service.md` is related).
- It keeps the ticker route's JSON-only rule and its second gate (`isSimulatedDevServer`), and imports its module only
  after both.

## The app's own tabs

`@sssb/app-config/simulator` lets an app register tabs (the showcase's Actors). Their content is app-built (ADR-0006),
so the kit's host cannot render it unaided. Options: `SimulatorHost` takes the app's tabs as a prop the app's layout
builds; or the app keeps a glue of its own when it registers tabs. Actors also needs `[locale]/simulator/actors/[actor]`
pages, the host's suppression of the panel inside those frames (the showcase checks the pathname), and the routes
`actors/artifact`, `actors/builds`, `actors/held`, `service-token` and `webhook-secret`
(`apps/showcase/src/app/api/simulator/`), which the actor drivers call.

## Done when

The starter's Jobs tab offers the ticker on `pnpm dev`, and an app that registers a tab can show it through the kit's
host, or the decision log says why it keeps its own glue.
