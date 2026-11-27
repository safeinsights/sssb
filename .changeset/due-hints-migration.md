---
'@sssb/kit': minor
---

### Framework migration 0022: due hints, so the tick lists only tenants with work due

**Kind.** migration

**Action.** none

**What changed.** Framework migration `0022_due_hints` adds an owner-only table, `due_hints`, which says per tenant
when each of the scheduled tick's drains may next find work. It also adds one `SECURITY DEFINER` trigger function,
`sssb_note_due`, and triggers on `job_schedules`, `webhook_deliveries` and `jobs` that keep the table current.
`app_user` has no privilege on the table or the function. The migrator applies it on its next run, after any app
migrations a database has already run, which the order-independence rule allows. The first tick after it lists every
tenant once, as before, and records their hints.
