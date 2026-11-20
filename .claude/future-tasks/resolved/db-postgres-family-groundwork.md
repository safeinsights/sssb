# The Postgres family: groundwork for more than one database

**Priority:** P2 · **Status:** open, accepted to build now
**Decided in:** ADR-0015, second addendum (2026-11-19), point 3. Read it, and the first addendum's "Datastores" section,
before starting. Details below marked "proposed" are yours to decide and record in `docs/decision-log.md`.

## Why

SSSB's logic should stay generic over the database, with what is specific to one engine owned by that engine's
family, so a second engine (libsql first: `db-libsql-family.md`) is a contained addition rather than surgery. This task
makes Postgres the first family. It changes nothing for anyone on Postgres: same migrations, same SQL, same proofs.

## What is engine-specific today (measured 2026-11-19; re-measure before starting)

- **Runtime data logic, about ten spots:**
    - `jsonb()` (`packages/kit/src/db/jsonb.ts`), called from `packages/kit/src/db/audit.ts`,
      `packages/kit/src/db/notifications.ts` and `packages/kit/src/db/webhooks.ts` (twice);
    - `forUpdate()` row locks in `packages/kit/src/db/jobs.ts`, `packages/kit/src/db/schedules.ts` and
      `packages/kit/src/db/webhooks.ts`;
    - a raw `now()` in `packages/kit/src/db/jobs.ts`;
    - a raw `sql` ordering in `packages/kit/src/db/keyset.ts`;
    - `set_config` in `packages/kit/src/db/with-tenant.ts`.
- **Tooling that reads Postgres's own catalogs:**
    - `pg_roles` and `pg_auth_members` in `packages/kit/src/db/app-roles.ts`;
    - the migrator's lock in `packages/kit/src/db/migrate.ts`;
    - the conformance suite's schema reads in `packages/kit/src/testing/conformance/db.ts`;
    - the contract server in `packages/kit/src/adapters/real/contract-postgres.ts`.
- **Transports:**
    - pglite: `packages/kit/src/adapters/fake/db.ts`, `pglite-dialect.ts`;
    - node-postgres: `packages/kit/src/adapters/real/db.ts`, `db-port.ts`;
    - the RDS Data API: `db-data-api.ts` and the `rds-data-*` modules.

    All three implement `withTenant` through `runWithTenant`.

- **Migrations:** the 13 framework migrations in `packages/kit/src/db/migrations/`.
- **Proofs, in two halves:**
    - the framework's: `packages/kit/src/db/rls-proofs.ts`, `rls-proof-runner.ts`, `rls-coverage.ts`, `owner-pass.ts`;
    - each app's own, through its seam (`apps/<app>/src/app-config/db/rls-proofs.ts`): Postgres-specific itself, since it
      writes `SET LOCAL ROLE` and `set_config`.

    The conformance suite's `rls-pglite` check (`packages/kit/src/testing/conformance/db.ts`) and the contract runner
    (`packages/kit/src/testing/contract.ts`) load both lazily on purpose: collecting a test must not reach the seam.
    The conformance check also opens pglite itself; it never builds a `DbPort`.

## What to build

1. **A family module** (proposed: `packages/kit/src/db/family.ts`, internal) exporting the Postgres family:
    - its dialect helpers (JSON encoding, a row lock, the current time);
    - its isolation;
    - its `withTenant` mechanism;
    - **loaders**, not values, for its migrations and its proof runner, so nothing is imported at collection.

    Reference today's modules rather than moving them: moving `packages/kit/src/db/migrations/` falsifies every doc that
    cites it.

2. **The runtime spots call the family's helpers**, not Postgres SQL.
3. **A fence, seen red first.** A test, or a rule in `@sssb/eslint-plugin`, fails when a module under `packages/kit/src`
   writes engine-specific SQL (a raw `sql` template, `forUpdate`, `jsonb`) without being one of the Postgres family's
   modules. Exempt by exact path: the family's modules, migrations, proofs and transports, and the catalog-reading
   tooling listed above. Break it with one raw `sql` in `db/jobs.ts`, watch it fail, restore.
4. **The port declares its isolation.** `DbPort` gains a read-only `isolation`, `'rls'` for every Postgres transport and
   the fake. `DbPort` has test doubles that a required member breaks:
    - the showcase's `apps/showcase/src/domain/db/tickets.test.ts`;
    - the kit's `packages/kit/src/db/audit.test.ts`;
    - an adopter's own, possibly.

    Decide: required (update the doubles; `minor` changeset, with "To adopt" saying so) or optional (no break, but a
    declaration that can be missing, so decide what an absent one means).

5. **The suites reach the proofs through the family's loader** instead of by path. Keep the check named `rls-pglite`:
   apps opt out by that name, and renaming it breaks them. Choosing a family from the app's declaration comes with the
   second family; until then there is one. Say in the family's header that an app's own proof half belongs to its
   family too, since an app on another database writes its proofs for that database.
6. **Say it where adopters read it.** `docs/adopting-reference.md` names the isolation an app gets
   (`adopter-reference-data-tiers.md` writes that section; coordinate). If `sssb doctor` should print it, design how it
   reads the declaration without booting the adapter registry, which doctor never does.

## Done when

- The SQL sent is unchanged: compare `.compile()` of each touched query before and after, in a test or a recorded
  check.
- Every gate is green: `pnpm verify`, and `pnpm test:contract` (real Postgres and the Data API emulator).
- The fence has been seen red and then green.
- `DbPort.isolation` exists, its doubles are handled, and the suites load the proofs through the family.
- A changeset matches the port decision, with "To adopt" for pages.

## Not in scope

- libsql, or any second family;
- moving files for tidiness;
- the reads made before a tenant is known (`db-libsql-family.md` covers those).

## Resolved (2026-11-19, `feat/db-postgres-family`)

- **The family, in two halves:** the runtime half `packages/kit/src/db/family.ts` (`DbFamily`, exported as `family`):
  `json`, `lockRow`, `currentTime` and `keysetSlice`, `isolation: 'rls'`, `runWithTenant`. The suite half
  `packages/kit/src/db/family-suite.ts` (`familySuite`): loaders for `migrations`, `migrator` and `proofs`, kept off the
  request path so no server build takes in the proofs. Its header says an app's own proof half belongs to its family.
  `family` is Postgres until a second one.
- **The runtime spots:** `audit.ts`, `notifications.ts`, `webhooks.ts` (twice) call `family.json`; `jobs.ts`,
  `schedules.ts`, `webhooks.ts` lock with `.$call(family.lockRow)`; `jobs.ts` writes `family.currentTime()`;
  `keyset.ts` reads its page through `family.keysetSlice` and imports nothing of Kysely's raw SQL. The three
  transports and the proof runner's port run `family.runWithTenant`.
- **The fence:** `tests/lint/db-family-fence.test.ts`, seen red with one raw `sql` in `db/jobs.ts` (and with a
  `forUpdate` in `db/schedules.ts` and a `jsonb` import in `db/notifications.ts`), then green. Its staleness check
  caught one exemption I had listed and the code did not need (`adapters/real/contract-data-api.ts`). Its guard on the
  runtime half's imports was seen red with a proofs loader put back into `family.ts`, and its guard on the suite half's
  importers with an `import('./family-suite')` in `db/jobs.ts`.
- **The port:** `DbPort.isolation`, required, of type `DbIsolation` (`'rls'`). Doubles updated: the showcase's
  `tickets.test.ts` (two) and `export-tickets.test.ts`, the kit's `audit.test.ts`, and the proof runner's own port.
  Changeset `db-port-declares-isolation.md`, `minor`, seam, required.
- **The suites:** the conformance suite's `rls-pglite`, `app-roles` and `migration-order` checks and the contract
  runner reach the migrations, the migrator and the proofs through the suite half's loaders. `rls-pglite` keeps its
  name.
- **SQL unchanged:** `packages/kit/src/db/family.test.ts` compares each helper's compiled query with the inline form
  it replaced; the distinct statements pglite received across the kit's db tests, the conformance suites and both
  apps' route and domain tests (407) were recorded before the change and at its final commit, and were identical.
- **Doctor and the adopter reference:** doctor prints nothing yet (decision log). `docs/adopting-reference.md`
  ("Another database for SSSB itself", written by `adopter-reference-data-tiers.md`, also resolved) names
  `DbPort.isolation`, and its count of internal modules is 77.
- Decisions: `docs/decision-log.md`, "The Postgres family's groundwork". What is left for a second family:
  `db-libsql-family.md`, "Left by the groundwork".
