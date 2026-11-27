---
'@sssb/kit': minor
---

### A request can create, rename and delete teams in its own tenant

**Kind.** migration

**Action.** optional

**What changed.** Framework migration `0018_organizations_write` grants `app_user` `INSERT`, `UPDATE` and `DELETE` on
`organizations`, behind row-level security that confines each write to the request's tenant: reads stay open across
tenants, as before, an `UPDATE` cannot move a team to another tenant, and `TRUNCATE` is not granted. It also adds a
unique constraint over `(tenant_id, id)`, so an app table can pin its team to its own tenant with a composite foreign
key. Before this, a route that wrote a team inside `withTenant` failed with `permission denied`.

**To adopt.** Nothing to do for the migration: it runs with the others. A route that creates, renames or deletes a
team writes it inside `db.withTenant(tenantId, ...)`, after `authorize(...)` on its own subject. To keep a table's team
in its own tenant, declare `FOREIGN KEY (tenant_id, org_id) REFERENCES organizations (tenant_id, id)` in a new
migration of yours. If a database role other than the table owner writes `organizations` outside `withTenant` (a sync
through a raw handle on a separate application role you granted writes yourself), that write is now held to the tenant
policies: run it inside `withTenant` for the team's tenant, or as the owner.

**Now deletable.** A raw-client exception (an entry in `lint-exceptions.mjs`) that exists only so a route can write
`organizations` as the table owner.
