# Simulator on an app's `pnpm dev`, stage 2: world state (Snapshots, presets, tours)

**Priority:** P2 · **Status:** open
**Found by:** adoption follow-up 6, stage 1 (2026-11-18, `docs/decision-log.md`, "The Simulator on a generated app's
`pnpm dev`, stage 1").

## What stage 1 left

Stage 1 put SSSB's server host behind one catch-all route: `@sssb/kit/server-lib/simulator-api` answers
`/api/simulator/*` for People, Mail and Jobs with the world clock, and `@sssb/kit/components/simulator/simulator-host`
is the panel client that calls it. A generated app mounts both (`apps/starter/src/app/api/simulator/[...path]/route.ts`
and the starter's locale layout). The panel shows only the tabs its host passes.

So on a generated app's `pnpm dev` there is no way to reset the world, save or restore a snapshot, flip a feature flag,
bump an agreement, load a demo preset, or run a tour. A preset or tour written with `/sssb:new-preset` or
`/sssb:new-tour` is still watchable only in the static demo.

## The work

Serve the showcase's world-state routes from `simulatorApi`, wire the Snapshots tab and tours in `SimulatorHost`:

| Path                                     | Showcase route today                                    | Kit call                                       |
| ---------------------------------------- | ------------------------------------------------------- | ---------------------------------------------- |
| POST `reset`                             | `apps/showcase/src/app/api/simulator/reset`             | `resetWorld` (`adapters/fake/simulator-admin`) |
| GET, POST `snapshots`                    | `apps/showcase/src/app/api/simulator/snapshots`         | the snapshot store in `simulator-admin`        |
| POST `snapshots/restore`                 | `apps/showcase/src/app/api/simulator/snapshots/restore` | same                                           |
| POST `snapshots/delete`                  | `apps/showcase/src/app/api/simulator/snapshots/delete`  | same                                           |
| GET, POST `flags`                        | `apps/showcase/src/app/api/simulator/flags`             | `KNOWN_FLAGS`, `readFlags`, `setFlag`          |
| GET `agreements`, POST `agreements/bump` | `apps/showcase/src/app/api/simulator/agreements`        | `adapters/fake/agreements`                     |
| POST `presets`                           | `apps/showcase/src/app/api/simulator/presets`           | `applyDemoPreset` (`server-lib/demo-presets`)  |

On the client: the reset, restore and preset handlers reload the page and leave a one-navigation marker so the next
mount confirms what happened (the showcase's `POST_NOTICE_KEY` in `apps/showcase/src/app/[locale]/simulator-glue.tsx`),
and `useTours` (`@sssb/kit/demo-static/tour/use-tours`) needs exactly those three to start a tour's world
(`resolveWorldStart`, `@sssb/kit/core/presets`). Bring them over together: tours without presets cannot start.

Every new POST keeps stage 1's JSON-only rule. A flag toggle reloads the page (the demo banner is server output).

## Done when

- The starter's `pnpm dev` panel has Snapshots (reset, save, restore, delete, flags, agreements) and, when the app
  registers any, Tours.
- `simulator-api.test.ts` covers each new path against the fixture seam (`busy-harbor` is the fixture's preset).
- The starter's e2e spec resets the world through the panel; the adoption probe runs it.
- `.claude/future-tasks/starter-starting-points.md` and the README's Simulator paragraph say what is still missing.
