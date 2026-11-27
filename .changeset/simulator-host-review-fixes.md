---
'@sssb/create': patch
'@sssb/kit': patch
'@sssb/cdk': patch
---

### Corrections from the release review

**Kind.** none

**Action.** none

**What changed.** SSSB's plugin commands `/sssb:new-actor` and `/sssb:a11y-review` now describe the `pnpm dev`
Simulator panel as this release builds it: `SimulatorHost` takes an app's own tabs (`extraTabs`), and a generated
app's panel has every framework tab but Actors, and Tours until the app registers one. The starter's Simulator route
comment names Tours. A comment in `@sssb/cdk`'s viewer-request function no longer says `clientAddress` reads
`X-Forwarded-For`. Two client races in the Simulator host that this release added, never released, are fixed: a poll
of the dev ticker no longer overwrites a start or stop, and the Snapshots tab's refreshes no longer land out of order.
