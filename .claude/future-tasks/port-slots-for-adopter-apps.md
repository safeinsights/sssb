# Port slots are SSSB's two apps' slots, so a workspace with two apps of its own shares one

**Priority:** P2 · **Status:** open
**Found by:** the independent review of ADR-0014 P4 (`feat/sssb-tools`), 2026-11-18.

## What happens

`packages/tools/src/ports.js` knows four port services: `showcase` (3000), `starter` (3100), `ladle` and `contractPg`.
An app declares which one it binds in its package.json (`"sssb": { "port": "starter" }`), and the starter, which is
the template, declares `starter`. An adopter whose workspace holds two apps of their own, both made from the starter,
has both on `starter`: `sssb port` prints 3100 in each, so their dev servers collide, and with Playwright's
`reuseExistingServer` outside CI the second app's e2e run adopts the first app's server, the wrong app and world (the
failure the per-checkout ports exist to prevent, `docs/build-notes.md`). The tick commands accept only the same slot
names. It behaved the same before P4 (`scripts/ports.mjs` had the same closed list); Pages, the first adopter, has one
app, so nobody has hit it.

## Design

Let an app declare a slot of its own, with its default port: `"sssb": { "port": { "name": "ledger", "default": 3300 } }`
beside today's string form. `portForRoot` takes the declaration instead of looking a name up in the table (its env var
`LEDGER_PORT`, the default in a main checkout, and a derived port in a linked worktree from a band the four built-in
slots do not use, keyed on the name as well as the checkout path so two custom slots in one worktree differ).
`originFor` in a Playwright config needs the same declaration, so it reads the app's package.json from the working
directory (Playwright runs from the app) when given no argument. `sssb doctor` (P5) fails when two apps in a workspace
declare the same slot. Pin: two apps on distinct custom slots get distinct ports in a main checkout and in a worktree;
two on one slot fail doctor.
