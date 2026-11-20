# Tell adopters where their data can live, and what each choice guarantees

**Priority:** P2 · **Status:** resolved 2026-11-19
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

## Resolution (2026-11-19)

`docs/adopting-reference.md` has a section, "Where your data lives, and what SSSB guarantees for it", after "Building
your product", with the three arrangements: Postgres (what the proof suite and its coverage check prove, the role
precondition, which Postgres), SSSB on Postgres with the app's data elsewhere (what is and is not proven, the fake's
tables reported isolated on pglite and on real Postgres alike, and what to do: say so in the app's docs, name the
fake's tables and their proofs as the fake's), and another database for SSSB itself (not yet; the isolation an adapter
will declare is described in words, since `db-postgres-family-groundwork.md` has not put it in code). The recipe's "In
your own tables" bullet points at it. The adopter guide is unchanged. Rejected: a link from the guide (it would make
the guide longer), and naming `DbPort.isolation` before the groundwork lands.
