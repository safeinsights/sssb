---
'@sssb/create': patch
---

### The starter's Simulator spec resets the world through the panel

**Kind.** scaffold

**Action.** optional

**What changed.** The starter's `tests/e2e/simulator.spec.ts` gains a test that holds every job with the
`jobs-held` flag from the Snapshots tab, sees the Jobs tab say so, then resets the world from the same tab and sees
the flag back where the seed has it. Its route file's comment names the Snapshots tab beside People, Mail and Jobs.

**To adopt.** Nothing is needed for the tab itself: it arrives with `@sssb/kit` on the route file and `SimulatorHost`
you already mount. To keep the gate, copy the new test and its two helpers (`stampDocument`, `waitForReload`) from the
starter's `tests/e2e/simulator.spec.ts` at this release. Reset, presets and tours now run on your `pnpm dev`, so a
tour or preset written with `/sssb:new-tour` or `/sssb:new-preset` can be watched there as well as in the static demo.

**Now deletable.** A Simulator glue component of the app's own, kept beside SSSB's host only to reach reset,
snapshots, flags, agreements, presets or tours on `pnpm dev`, with the per-path `api/simulator/<path>/route.ts` files
it called (`reset`, `snapshots`, `flags`, `agreements`, `presets`); an app that registers its own tabs (Actors) or
uses Events, Messages, Hooks or Errors still keeps its glue until SSSB's host serves those.
