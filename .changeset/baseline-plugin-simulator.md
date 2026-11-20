---
'@sssb/create': patch
---

### The plugin's commands describe the Simulator a generated app has

**Kind.** none

**Action.** none

**What changed.** The plugin's commands no longer say a generated app has no Simulator on `pnpm dev`. Since 0.3.0 it
has SSSB's host there, with the People, Mail and Jobs tabs; it has no Hooks, Snapshots or Tours tab and takes no
app-registered tab (Actors), which remain the static demo's or a reference-style glue of your own. Raise the plugin
pin with the release.
