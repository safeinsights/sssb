---
'@sssb/kit': patch
---

### A feature-flag read waits for PostHog one second at most

**Kind.** none

**Action.** none

**What changed.** The protected layout awaits a feature-flag read on every authenticated render, and the PostHog
adapter had no bound of its own on it: the client's was ten seconds with one retry, so a slow PostHog could hold every
page for twenty seconds or more. A flag read now waits `FLAG_TIMEOUT_MS` (one second), with no retry, and answers the
default the caller passed when PostHog fails or outruns it, as it already did on a failure. Capturing events is
unchanged (two seconds).
