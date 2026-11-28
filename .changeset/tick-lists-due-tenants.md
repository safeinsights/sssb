---
'@sssb/kit': patch
---

### The scheduled tick lists only the tenants with work due

**Kind.** none

**Action.** none

**What changed.** Each of the tick's drains used to list every tenant's due rows on every tick, each tenant in a
transaction of its own: four RDS Data API calls a tenant a drain, whether or not anything was due. Measured on 1,000
tenants against the Data API emulator, that is about 4,000 calls a drain. Now a drain run by the tick lists only the
tenants whose due hint has come, or that have had work made due since, and then sets the hints of the tenants it
listed, in one statement for every 200 tenants, and clears the record of work made due that their listing accounted for, a bounded statement at a time while the drain's window lasts. With nothing due anywhere,
that is the hint read alone: one statement, in a transaction that bounds it (four RDS Data API calls a drain). A tenant is still listed at least once a day, and a drain that cannot read the hints lists
every tenant, as before. Calling `runDueSchedules`, `runDueRetries` or `runDueDeliveries` directly (the Simulator's
controls do) lists every tenant unless the budget passes `dueHints: true`. The listing share stays: a drain still lists
for at most half of what is left of its window before it runs what it listed, so a tick with more tenants due than
that half can list still serves a fresh random set of them.
