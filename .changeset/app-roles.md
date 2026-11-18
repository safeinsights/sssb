---
'@sssb/kit': minor
---

### An app names the cluster-wide roles its migrations create: `appRoles`

**Kind.** seam

**Action.** required

**What changed.** An app whose migrations create a role of their own (beside the framework's `app_user`) now names it
in an optional `appRoles` export of its `@sssb/app-config/db/migrations` module. The contract suite's owner pass grants a
later owner ADMIN on exactly those roles, as it does on `app_user`, so a migration that alters such a role passes on
every pass, not only the first. A new conformance check, `app-roles`, fails a role the migrations create that
`appRoles` does not name, and a name no migration creates. An app that creates no role changes nothing.

**To adopt.** If your migrations create a role, export its name beside `appMigrations`, from the module
`@sssb/app-config/db/migrations` resolves to (`src/app-config/db/migrations.ts`, or `migrations/index.ts`):

```ts
export const appRoles = ['app_maintainer'] as const
```

Create the role only where it does not exist yet, as an ordinary role (the owner pass refuses one that is a superuser
or has BYPASSRLS, REPLICATION or CREATEROLE):

```sql
DO $$ BEGIN
    IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'app_maintainer') THEN
        CREATE ROLE app_maintainer NOLOGIN;
    END IF;
END $$
```

Then make a migration that only warned when it lacked ADMIN on its role fail again: the owner pass now gives a later
owner that ADMIN, so a failure there is real.

**Now deletable.** A migration that catches `permission denied` on its own role and warns instead of failing, to get
past the contract suite's second owner pass.
