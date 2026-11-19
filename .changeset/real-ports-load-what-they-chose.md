---
'@sssb/kit': patch
---

### A deployment loads `pg` and PostHog only when it uses them

**Kind.** none

**Action.** none

**What changed.** The real ports load the `pg` driver only for the `pg` transport (`DATABASE_TRANSPORT=pg`, the default) and PostHog only when
`POSTHOG_KEY` is set, as the Data API transport and the optional ports already did; a Data API deployment no longer
loads `pg`. Nothing to set or change.
