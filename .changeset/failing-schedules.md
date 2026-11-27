---
'@sssb/kit': patch
---

### A schedule that keeps failing backs off, and one that cannot parse turns off

**Kind.** none

**Action.** none

**What changed.** A schedule whose spawn failed inside its transaction stayed due and failed again on every tick,
taking one of its tenant's turns each time. Now one whose spec no longer parses is disabled at its first such failure,
with a `schedule.disabled` audit event saying why. Any other such failure backs the schedule off on the webhook
deliveries' backoff (one minute, then five, thirty, two hours, then six hours), and the next spawn that commits clears
it. The schedule keeps the count and the latest error (`failureCount`, `lastError` in the Simulator's schedule view).
