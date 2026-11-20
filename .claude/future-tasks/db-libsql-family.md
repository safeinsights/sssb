# A libsql (Turso) database family

**Priority:** P3 · **Status:** open, recorded design; blocked on `db-postgres-family-groundwork.md`, and built when an
adopter needs it
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
