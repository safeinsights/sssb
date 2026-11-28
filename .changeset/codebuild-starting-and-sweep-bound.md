---
'@sssb/kit': patch
---

### A CodeBuild job is marked from its first write, and the tick's sweep is bounded

**Kind.** none

**Action.** none

**What changed.** Two fixes to what the CodeBuild runner's lost-build sweep left open.

- **A CodeBuild job carries its `starting` mark from its first write.** It used to be written just before StartBuild,
  as a write of its own. If that write failed, the job stayed queued with no mark, and the sweep never judged it. The
  jobs port now says what a job's row starts as (`JobsPort.startingRef`, optional), and the row is written with it:
  `submitJob`, a schedule's spawn and a retry's claim all do.
- **The tick's sweep for lost jobs has a bound of its own.** It is given a budget, a window of the tick's first two
  seconds and at most 100 jobs failed (`JobsPort.sweep(now, budget)`, the budget optional). Both runners' sweeps take
  tenants in a fresh random order and stop when the budget is spent, so a sweep that finds many lost jobs leaves the
  drains their windows. The CodeBuild runner's sweep fails each lost job as soon as it finds it, so time spent asking
  CodeBuild never throws away what it found. `runScheduledTick`'s budget takes `maxSweep` and `sweepWindowMs`, both
  optional, and throws a `RangeError` for one that is not a usable bound (`NaN`, or a `maxSweep` below 1), as it does
  for the drains' fields.
