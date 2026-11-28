---
'@sssb/kit': minor
---

### Framework migration 0022: due hints, so the tick lists only tenants with work due

**Kind.** migration

**Action.** none

**What changed.** Framework migration `0022_due_hints` adds two owner-only tables, `due_hints` and `due_hint_events`,
which say per tenant when each of the scheduled tick's drains may next find work, one `SECURITY DEFINER` trigger
function, `sssb_note_due`, and triggers on `job_schedules`, `webhook_deliveries` and `jobs`. A write that makes work
due (a schedule written or moved earlier or re-enabled, a webhook delivery enqueued or put back to failed, a retry
armed) now also appends one row to `due_hint_events`. That append waits on no other transaction and takes no lock
another write needs, so a tenant's writes do not serialize on each other or deadlock because of it, and the tick never
waits on a tenant's open transaction. `app_user` can reach neither table nor the function: the migration revokes
every grant on them but the owner's, including any your migrations' default privileges would give a role `app_user` is
a member of, and refuses to finish if `app_user` can still read, write or reference either table or call the function. The migrator applies it on its next run, after
any app migrations a database has already run, which the order-independence rule allows. It backfills nothing: the
first tick after it lists every tenant once, as 0.10.0 did, plus a next-due query for a tenant with nothing due, and
records their hints.
