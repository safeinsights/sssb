---
'@sssb/create': minor
---

### The starter's Simulator spec checks every tab its server serves

**Kind.** scaffold

**Action.** required

**What changed.** The starter's `tests/e2e/simulator.spec.ts` now expects the Mail, Messages, Events, Jobs, Hooks,
Errors and Snapshots tabs (and no Actors or Tours tab), and asks the Errors tab for the server's scrubbed event. Its
route file's comment names every framework tab.

**To adopt.** The tabs arrive with `@sssb/kit` on the route file and `SimulatorHost` you already mount, and with them
your app's own `tests/e2e/simulator.spec.ts`, as the generator wrote it, fails on its line expecting no Hooks tab:
`await expect(page.getByTestId('simulator-tab-hooks')).toHaveCount(0)`. Delete that line, or replace the spec's first
test with the starter's at this release.

**Now deletable.** A Simulator glue of the app's own, with its `api/simulator/<path>/route.ts` files, kept only to
reach Events, Messages, inbound mail, Hooks or Errors on `pnpm dev`; one that registers its own tabs (Actors) or drives
the dev ticker still keeps its glue for those.
