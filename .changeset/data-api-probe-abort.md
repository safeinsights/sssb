---
'@sssb/kit': patch
---

### The Data API's resume probes that do not answer are aborted

**Kind.** none

**Action.** none

**What changed.** While a paused cluster resumes, the Data API transport probes it with `SELECT 1` and, when a probe has
not answered in two seconds, sends the next one and leaves the first behind. A probe that never answered held a socket of
the AWS SDK's client for as long as it lived, and one was added about every three seconds, so a long wait could fill the
client's socket pool and queue the app's own calls behind them. A probe is now aborted six seconds after it was sent (a
late answer inside that still ends the wait), and every probe still out is aborted when the wait ends, so at most three
are in flight. `RdsDataClientLike.send` (`@sssb/kit/adapters/real/index`'s dialect, used by the contract suite's own
client) takes the SDK's `{ abortSignal }` option, which `RDSDataClient` already accepts.
