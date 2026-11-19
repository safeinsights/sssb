# A generated app still says `starter`: give `@sssb/tools` a neutral port service

**Priority:** P3 · **Status:** open
**Found by:** ADR-0014 P12 (`feat/sssb-create`), 2026-11-18, building `@sssb/create`.

## What happens

`@sssb/create` renames the app's identity (its slug, package names, display name, session cookie and titles) and
nothing else, so the app it writes keeps the starter's port service in four places: `"sssb": { "port": "starter" }`
in its package.json, `originFor('starter')` in `playwright.config.ts`, and its `tick` and `dev` scripts
(`sssb tick starter`, `sssb dev-tick starter -- …`). Its port override is `STARTER_PORT`. All of it works:
`packages/tools/src/ports.js` names port bands, not apps, and says an app keeps the slot it was generated with when
it is renamed. But an adopter's app called `ledger` reads `starter` in its own scripts, and `docs/adopting.md`
spends a paragraph explaining why. `tests/tooling/create-generate.test.ts` allows exactly those four forms of the
word in the generated app.

Renaming the slot in the generator was rejected in P12: the declaration and the Playwright config agree only
because both spell the same literal, so a rewrite is two more files on the generator's rename surface, and a
half-applied one gives two servers on two ports, the wrong-app adoption the per-checkout ports exist to prevent.

## Design

A port service whose name says "this app", not "SSSB's second reference app": for example `app`, with the env var
`APP_PORT`, the starter's default port (3100) and its derived band. Both the starter and so every generated app
declare it; the showcase keeps `showcase`. `originFor()` and `sssb tick` / `sssb dev-tick` with no service argument
read the declaration from the app's package.json (as `sssb port` already does), so the app's scripts and Playwright
config name no service at all and nothing is left for the generator to rename. Keep `starter` as an alias for a
release, so a workspace generated before the change keeps working, and say so in a changeset ("Scaffold changes to
apply by hand").

Overlapped `resolved/port-slots-for-adopter-apps.md`, now built: an app can declare a slot of its own
(`{ "name": …, "default": … }`), read by every command, so the generator could write one in place of `starter`. Pin: the survivor check in
`tests/tooling/create-generate.test.ts` allows no `starter` in the generated app; the starter's dev server, e2e and
tick still bind its old port in a main checkout and its derived one in a worktree.
