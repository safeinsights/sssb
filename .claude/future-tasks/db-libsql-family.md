# A libsql (Turso) database family

**Priority:** P3 · **Status:** open, recorded design; its groundwork is built
(`resolved/db-postgres-family-groundwork.md`), and it is built when an adopter needs it
**Decided in:** ADR-0015, the libsql worked example, the first addendum's tier 3 and the second addendum's point 3
(2026-11-19). Read all three.

## The shape

A second family beside Postgres, in the slot the groundwork makes:

- **Transports:** a local libsql file under `.data/` as the hermetic fake (not in-memory: the Simulator's reset,
  snapshots and presets copy the files under `.data/`, `packages/kit/src/adapters/fake/simulator-admin.ts`), and Turso
  remote for real.
- **Migrations:** the framework's migrations in SQLite DDL (UUIDs, timestamps and JSON as text; SSSB already treats dates
  as strings).
- **Isolation, declared:**
    - `database-per-tenant`: `withTenant` opens that tenant's database, each tenant's credential scoped to its own;
    - or `single-tenant`: boot refuses a second tenant.
- **A control database** for the framework's reads before a tenant is known: tenant and org lookup, service keys, the
  inbound mail's recipient, the scheduled tick's walk over every tenant in `runDueSchedules`. Migrations fan out
  across every tenant's database.
- **Row locks:** none, since SQLite serializes writes per database. Claiming a job, a schedule or a webhook delivery is
  re-proved under that model.
- **Proofs:** a tenant's handle cannot address another tenant's database, run by the conformance suite for an app
  that declares this family.
- **Drift guard:** a test that the two families' migrations produce the same tables and columns, by migrating each and
  comparing what each database reports about itself. `DB` (`packages/kit/src/db/schema.ts`) is written by hand, kept in
  lockstep with the migrations by its header's own account, so nothing generates it to compare; either compare the
  introspected schemas with each other and with `DB`, or bring in the codegen the header mentions first.
- **Its shape is the second addendum's:** the framework keeps `Kysely<DB>` and its logic, with this family's dialect
  helpers, rather than moving every framework store behind repository ports, which the first addendum's tier 3 had
  proposed.

## What the adopter takes on

Its own migrations and queries in SQLite, and its own infrastructure: `SssbApp` builds Aurora and does not provision
Turso.

## Done when

- The framework's whole unit suite and the conformance suite pass on the libsql fake.
- The family's isolation proofs pass, and have been seen to fail with a cross-tenant handle.
- The schema drift test is green, and has been seen red with one family missing a column.
- A cutover row names the live checks against Turso.

## Left by the groundwork (2026-11-19)

The Postgres family is `packages/kit/src/db/family.ts`; this family is a second object of its `DbFamily` shape. What
the groundwork did not do, and this task does:

- Choose the family: today `family` is Postgres. A proposal is in `docs/decision-log.md` ("The Postgres family's
  groundwork"): the app declares it in its `package.json`'s `sssb` block, doctor prints it, the conformance suite holds
  it to `DbPort.isolation`.
- Add this family's arrangements to `DbIsolation` (`packages/kit/src/ports/db.ts`), which is `'rls'` alone.
- Engine knowledge that is not SQL, so the fence (`tests/lint/db-family-fence.test.ts`) does not see it:
  `packages/kit/src/db/audit.ts` refuses a detail string holding a NUL or an unpaired surrogate because Postgres's
  `jsonb` cannot store one.
- The suites still open pglite themselves (`packages/kit/src/testing/conformance/db.ts`), and the contract runner
  starts a Postgres; each needs this family's hermetic database instead.
