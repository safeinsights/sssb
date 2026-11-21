---
'@sssb/kit': patch
---

### A fixed org source names its home org by the org row

**Kind.** none

**Action.** none

**What changed.** Under a fixed org source, the org switcher (`listMyOrgs`) showed the home org's slug. It now shows
the org row's name, read per call, and still shows the slug when the row is missing.
