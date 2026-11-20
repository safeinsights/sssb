# A libsql (Turso) database family

**Priority:** P3 · **Status:** open, recorded design; blocked on `db-postgres-family-groundwork.md`, and built when an
adopter needs it
**Decided in:** ADR-0015, the libsql worked example, the first addendum's tier 3 and the second addendum's point 3
(2026-11-19). Read all three.

## The shape

A second family beside Postgres, in the slot the groundwork makes:

- **Transports:** a local libsql file or in-memory database as the hermetic fake, and Turso remote for real.
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
- **Drift guard:** a test that both families' migrations produce the same `DB` schema type
  (`packages/kit/src/db/schema.ts`).

## What the adopter takes on

Its own migrations and queries in SQLite, and its own infrastructure: `SssbApp` builds Aurora and does not provision
Turso.

## Done when

- The framework's whole unit suite and the conformance suite pass on the libsql fake.
- The family's isolation proofs pass, and have been seen to fail with a cross-tenant handle.
- The schema-type drift test is green and seen red.
- A cutover row names the live checks against Turso.
