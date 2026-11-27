---
'@sssb/kit': patch
---

### The Simulator host takes an app's own tabs, and shows the dev ticker where the app serves it

**Kind.** seam

**Action.** optional

**What changed.** `SimulatorHost` (`@sssb/kit/components/simulator/simulator-host`) takes `extraTabs`, the panel's own
`SimulatorExtraTab[]`, and exports `useSimulatorWorld()`, which an app's tab content calls to read the world's jobs
(polled while that tab is open). Both are provisional until safeinsights/sssb#152 decides how an app's tabs reach the
host, and may change shape then. The Jobs tab's dev ticker control now shows on the host wherever the app's own
`src/app/api/simulator/ticker/route.ts` answers; where it answers 404, as SSSB's catch-all does, there is no ticker,
as before.

**To adopt.** Nothing, unless your app registers its own Simulator tab (`@sssb/app-config/simulator` `tabs`) and kept
a glue of its own to show it: you can now pass the tab to `SimulatorHost` as `extraTabs` from your locale layout
instead, as SSSB's reference app does (in SSSB's repository at this release:
`apps/showcase/src/app/[locale]/simulator-glue.tsx`).

**Now deletable.** A Simulator glue that re-implements the panel's fetching, polling and notices only to add an app's
own tab or the dev ticker control, with every `api/simulator/<path>/route.ts` it called that SSSB's catch-all now
serves; keep the routes your own tab's pages call and the ticker route.
