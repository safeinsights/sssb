# The Postgres family: groundwork for more than one database

**Priority:** P2 · **Status:** open, accepted to build now
**Decided in:** ADR-0015, second addendum (2026-11-19), point 3. Read it, and the first addendum's "Datastores" section,
before starting.

## Why

SSSB's logic should stay generic over the database, with what is specific to one engine owned by that engine's
family, so a second engine (libsql first: `db-libsql-family.md`) is a contained addition rather than surgery. This task
makes Postgres the first family. It changes nothing for anyone on Postgres: same migrations, same SQL, same proofs.

## What is engine-specific today (measured 2026-11-19; re-measure before starting)

- **Runtime logic, about ten spots:** `jsonb()` (`packages/kit/src/db/jsonb.ts`) called from
  `packages/kit/src/db/audit.ts`, `packages/kit/src/db/notifications.ts` and `packages/kit/src/db/webhooks.ts` (twice);
  `forUpdate()` row locks in `packages/kit/src/db/jobs.ts`, `packages/kit/src/db/schedules.ts` and
  `packages/kit/src/db/webhooks.ts`; a raw `now()` in `packages/kit/src/db/jobs.ts`; a raw `sql` ordering in
  `packages/kit/src/db/keyset.ts`; and `set_config` in `packages/kit/src/db/with-tenant.ts`.
- **Migrations:** the 13 framework migrations in `packages/kit/src/db/migrations/` (DDL, `uuid`, `timestamptz`, `jsonb`,
  row-level-security policies, grants, `DO` blocks).
- **Proofs:** `packages/kit/src/db/rls-proofs.ts`, `rls-proof-runner.ts`, `rls-coverage.ts`, `owner-pass.ts`, run by the
  conformance suite's `rls-pglite` check (`packages/kit/src/testing/conformance/db.ts`) and the contract runner
  (`packages/kit/src/testing/contract.ts`).
- **Transports:** pglite (`packages/kit/src/adapters/fake/db.ts`, `pglite-dialect.ts`), node-postgres
  (`packages/kit/src/adapters/real/db.ts`, `db-port.ts`), the RDS Data API (`db-data-api.ts` and the `rds-data-*`
  modules). All three implement `withTenant` through `runWithTenant`.

## What to build

1. **A family object.** One module (say `packages/kit/src/db/family.ts`, internal) exporting the Postgres family:
   its dialect helpers (JSON encoding, a row lock, the current time), its framework migrations, its proof runner, its
   `withTenant` mechanism and its isolation. Prefer referencing today's modules over moving them: moving
   `packages/kit/src/db/migrations/` touches every doc that cites it, and the doc-path gate will list them.
2. **The runtime spots call the family's helpers**, not Postgres SQL.
3. **A fence, seen red first:** a test (or a rule in `@sssb/eslint-plugin`) that fails when a runtime module under
   `packages/kit/src` outside the family writes engine-specific SQL (a raw `sql` template, `forUpdate`, `jsonb`), with
   the family's modules, migrations and proofs exempt by name. Break it with one raw `sql` in `db/jobs.ts`, watch it
   fail, restore.
4. **The port declares its isolation.** `DbPort` gains a read-only `isolation` (`'rls'` for every Postgres transport and
   the fake). Adding a member to a published port interface breaks an app's own implementation or test double of it, so
   check whether any app implements `DbPort` (the showcase, the starter, pages) and file the changeset to match.
5. **Proofs are the family's.** The conformance suite and the contract runner get the proofs through the family rather
   than importing the RLS runner by path, so a second family brings its own and the suites run whichever the app's
   adapter declares.
6. **Say it where adopters read it.** `docs/adopting-reference.md` names the isolation an app gets. If `sssb doctor`
   should print it, design how it reads the declaration without booting the adapter registry, which doctor never does.

## Done when

- Every gate is green with no change to SQL sent, migrations or proofs (the contract runner on real Postgres and the
  Data API emulator included: `pnpm test:contract`).
- The fence has been seen red and green.
- `DbPort.isolation` exists and the suites run the family's proofs.
- A changeset files `@sssb/kit` `minor` if the port change can break an app's code, else `patch`, with "To adopt" for
  pages.

## Not in scope

libsql, any second family, moving files for tidiness, and the tenant-before-known reads (`db-libsql-family.md` covers
those).
