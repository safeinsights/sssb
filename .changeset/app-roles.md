---
'@sssb/kit': minor
---

### An app names the cluster-wide roles its migrations create: `appRoles`

**Kind.** seam

**Action.** required

**What changed.** An app whose migrations create a role of their own (beside the framework's `app_user`) now names it
in an optional `appRoles` export of its `@sssb/app-config/db/migrations` module. The contract suite's owner pass grants a
later owner ADMIN on exactly those roles, as it does on `app_user`, so a migration that alters such a role passes on
every pass, not only the first. It grants on an ordinary role only: it refuses, before granting anything, a named role
that can log in, has CREATEDB, CREATEROLE, SUPERUSER, BYPASSRLS or REPLICATION, holds a privilege on a server parameter
(`pg_parameter_acl`), owns a database or tablespace, or is a member, at any depth, of any role but `app_user` and the
app's other named roles (ADMIN lets the owner grant itself SET on the role and act as it and as all of those), and it
fails when the owner's own migrations leave a named role more than ordinary. It holds `app_user`, on which every later
owner gets ADMIN too, to the same attributes, privileges and ownerships, before granting and after the migrations:
`app_user` may be a member of the app's named roles and of other roles ordinary in shape (another app's, on a shared
server), never of a `pg_*` or `rds_*` role or one with any of those attributes, privileges or ownerships. A new conformance check, `app-roles`, fails a role the
migrations create that `appRoles` does not name, a name no migration creates, and a named role or `app_user` the
migrations leave more than ordinary, on pglite in the unit run. The owner pass's teardown now also revokes what
its owner granted (`DROP OWNED BY`), so a migration that grants a role TO `app_user` no longer leaves the owner behind,
and an owner it cannot drop fails the pass instead of staying on the server. An app that creates no role changes
nothing.

**To adopt.** If your migrations create a role, export its name beside `appMigrations`, from the module
`@sssb/app-config/db/migrations` resolves to (`src/app-config/db/migrations.ts`, or `migrations/index.ts`):

```ts
export const appRoles = ['app_maintainer'] as const
```

Create the role only where it does not exist yet, as an ordinary role, and keep it one in every later migration:
NOLOGIN, no other attribute, no privilege on a server parameter, no database or tablespace of its own, and no membership
but `app_user` and your other named roles (granting it TO `app_user` is fine):

```sql
DO $$ BEGIN
    IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'app_maintainer') THEN
        CREATE ROLE app_maintainer NOLOGIN;
    END IF;
END $$
```

Leave `app_user` ordinary as well: never change its attributes, give it no parameter privilege, database or tablespace, and grant
it only your named roles.

Then make a migration that only warned when it lacked ADMIN on its role fail again: the owner pass now gives a later
owner that ADMIN, so a failure there is real.

**Now deletable.** A migration that catches `permission denied` on its own role and warns instead of failing, to get
past the contract suite's second owner pass.
