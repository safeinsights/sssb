---
'@sssb/kit': patch
---

### The scheduled tick lists only the tenants with work due

**Kind.** none

**Action.** none

**What changed.** Each of the tick's drains used to list every tenant's due rows on every tick, each tenant in a
transaction of its own: four RDS Data API calls a tenant a drain, whether or not anything was due. Measured on 1,000
tenants against the Data API emulator, that is about 4,000 calls a drain. Now a drain run by the tick lists only the
tenants whose due hint has come, and raises the hint of a tenant it finds with nothing due. With nothing due anywhere,
that is one call a drain. A tenant is still listed at least once a day, and a drain that cannot read the hints lists
every tenant, as before. Calling `runDueSchedules`, `runDueRetries` or `runDueDeliveries` directly (the Simulator's
controls do) lists every tenant unless the budget passes `dueHints: true`.
