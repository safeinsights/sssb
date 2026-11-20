# Simulator on an app's `pnpm dev`, stage 5: the showcase onto the kit's host

**Priority:** P2 · **Status:** open — after stages 2 to 4
**Found by:** adoption follow-up 6, stage 1 (2026-11-18).

## Why it waits

Stage 1 (`@sssb/kit/server-lib/simulator-api`, `@sssb/kit/components/simulator/simulator-host`) serves three of the
panel's tabs, and the showcase uses every tab, its Actors tab and the dev ticker included. Moving it now would mean
mounting the kit's catch-all beside 23 of its own route files and keeping its 867-line
`apps/showcase/src/app/[locale]/simulator-glue.tsx` anyway, so stage 1 left the showcase alone. Until this stage lands
the kit's host has one consumer, the starter (and every generated app), and the showcase's glue is a second copy of
its People, Mail and Jobs wiring.

## The work

Once stages 2 to 4 (`simulator-host-stage-2-world-state.md`, `simulator-host-stage-3-subsystem-tabs.md`,
`simulator-host-stage-4-ticker-and-app-tabs.md`) serve every path the showcase's glue calls:

- Mount `api/simulator/[...path]/route.ts` in the showcase and render `SimulatorHost` from its locale layout.
- Delete `apps/showcase/src/app/[locale]/simulator-glue.tsx` and the 33 route files under
  `apps/showcase/src/app/api/simulator/`, moving each route's tests to `simulator-api.test.ts` against the fixture seam
  (the kit's tests never use the showcase's vocabulary).
- The showcase's Simulator e2e specs (the `simulator-` ones in `apps/showcase/tests/e2e/` and its `destructive/`) run
  unchanged: same paths, same test ids. They are the proof.
- Re-measure jscpd: the Simulator glue was part of the showcase-and-starter clone pairs `route-glue-duplication.md`
  counts.

## For an adopter that copied the glue

An adopter may carry Simulator glue of its own, copied from the showcase (`docs/adoption-review-2026-11.md`, item 6: "optional: delete its own glue"). Once its tabs are all served, it can mount the catch-all and delete
its copy; each stage's changeset says which tabs that release added.
