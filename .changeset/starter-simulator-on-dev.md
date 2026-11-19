---
'@sssb/create': patch
---

### A generated app has the Simulator on its own `pnpm dev`

**Kind.** scaffold

**Action.** optional

**What changed.** The starter mounts SSSB's Simulator server host with `src/app/api/simulator/[...path]/route.ts` and renders the panel from `src/app/[locale]/layout.tsx` in simulated mode, so a generated app's `pnpm dev` (and its simulated builds) has the People, Mail and Jobs tabs, the world clock included. Until now the panel was only in its static demo. A new e2e spec, `tests/e2e/simulator.spec.ts`, signs in through the panel and opens its tabs.

**To adopt.** Copy the route file and the `SimulatorChrome` component and its use from the starter's `src/app/[locale]/layout.tsx` (the kit changeset "The Simulator's People, Mail and Jobs tabs on an app's own `pnpm dev`" shows both), and the spec if you want the gate.
