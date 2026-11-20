# Tell adopters where their data can live, and what each choice guarantees

**Priority:** P2 · **Status:** open, accepted to write now (docs only)
**Decided in:** ADR-0015, first addendum ("Datastores: tiers") and second addendum (2026-11-19).

## Why

An app can already keep its own data outside Postgres, through a port it owns (`docs/recipes/app-owned-adapter.md`),
while SSSB's own tables stay in Postgres. Nothing says what SSSB then guarantees, and one part of it misleads: the
app's fake for that store keeps its state in the app's own Postgres tables (the recipe's "In your own tables"), so the
row-level-security proofs report those tables isolated in the simulated world while the real store promises nothing
of the kind.

## What to write

A section in `docs/adopting-reference.md` (the guide, `docs/adopting.md`, links to it at most), in the reference's own
voice:

- **Postgres, the default**: tenant isolation for SSSB's tables and the app's, proven by the RLS suite on pglite and real
  Postgres, with every reachable table held to a policy (ADR-0004).
- **SSSB on Postgres, the app's data elsewhere**: what SSSB still proves (its own tables), what it does not (the app's
  store), and the simulated-world caveat above, with what to do about it: say so in the app's own docs, and keep the
  fake's tables named as the fake's.
- **Another database for SSSB itself**: not yet; point at ADR-0015 for the family design. Name the isolation an adapter
  declares only once `db-postgres-family-groundwork.md` has put the declaration in the code; until then, describe the
  arrangements in words, never as values an app can set.

## Done when

- The section reads true against the code: the doc-path gate passes, and every claim has been checked against the file
  it describes (run the `claim-check` skill).
- The adopter guide's own length is unchanged or shorter.
