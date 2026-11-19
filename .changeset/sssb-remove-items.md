---
'@sssb/tools': patch
'@sssb/create': patch
---

### `sssb remove-items` takes the starter's Items slice out in one step

**Kind.** scaffold

**Action.** optional

**What changed.** The first thing every adopter does is take out the starter's example Items slice by hand, over about fifteen files. `pnpm exec sssb remove-items` does it: the card, the route, the query, the ability, the `items` catalog namespace, the dashboard's glue and the static demo's card, the specs that name it, and the paging proofs; the Simulator's e2e spec stays, so the app still has one for `sssb check-e2e`. The migrations are the one thing it will not guess at. A database records each migration it runs, and the migrator refuses to start when a recorded one is gone from the code, so without `--drop-migrations` the command leaves `1001_items`, `1002_items_keyset_index`, `ItemsTable` and the `items` RLS proofs registered; with it, they go too, and the app is left with `AppSubjectType = never`, an empty `appMigrations`, an empty proofs body and `AppTables = Record<never, never>`. `--dry-run` lists what it would do. It computes every edit first and refuses, naming each file and changing nothing, when one is not what the starter wrote. The generated README now points at it, and `@sssb/tools` ships the two diffs it applies (`src/remove-items/*.patch`).

**To adopt.** Nothing, if your app already removed Items. In a workspace you have just generated, run `pnpm exec sssb remove-items --dry-run --drop-migrations`, then without `--dry-run`, delete `apps/<app>/.data`, and number your first table `1001_<name>`. Where a database has already run the migrations, run it without `--drop-migrations`. An app that edited the Items files or has its own migrations after `1002` is refused by design: finish by hand from `docs/adopting.md`, "To remove the Items slice".

**Now deletable.** A hand sweep over the Items slice's files.
