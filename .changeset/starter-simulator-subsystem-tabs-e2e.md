---
'@sssb/create': patch
---

### The starter's Simulator spec checks every tab its server serves

**Kind.** scaffold

**Action.** optional

**What changed.** The starter's `tests/e2e/simulator.spec.ts` now expects the Mail, Messages, Events, Jobs, Hooks,
Errors and Snapshots tabs (and no Actors or Tours tab), and asks the Errors tab for the server's scrubbed event. Its
route file's comment names every framework tab.

**To adopt.** The tabs arrive with `@sssb/kit` on the route file and `SimulatorHost` you already mount. If you copied
the starter's spec, it now fails on its old line expecting no Hooks tab
(`expect(page.getByTestId('simulator-tab-hooks')).toHaveCount(0)`): delete that line, or copy the spec's first test
from the starter at this release.

**Now deletable.** A Simulator glue of the app's own, with its `api/simulator/<path>/route.ts` files, kept only to
reach Events, Messages, inbound mail, Hooks or Errors on `pnpm dev`; one that registers its own tabs (Actors) or drives
the dev ticker still keeps its glue for those.
