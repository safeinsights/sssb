# Port slots are SSSB's two apps' slots, so a workspace with two apps of its own shares one

**Priority:** P2 · **Status:** resolved 2026-11-18
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

## Resolution (2026-11-18, `feat/app-declared-port-slots`)

Built as designed, with these specifics (the choices and what they beat are in `docs/decision-log.md`, "An app declares
a port slot of its own"):

- `packages/tools/src/ports.js`: `parsePortDeclaration` checks a declaration (a built-in's name, or `{ name, default }`),
  `readPortDeclaration(appDir)` reads and checks the one in an app's package.json. `portForRoot`, `portFor` and
  `originFor` take either form; `portFor()` and `originFor()` with no argument read the app around the working directory
  (the nearest package.json that declares a port, up to the checkout root), and `originForApp(__dirname)` names an
  app for a Playwright config, which knip and `playwright test -c` load from the workspace root.
  A custom slot's override is `<NAME>_PORT` (`-` as `_`), its main-checkout port its `default`, and its worktree port
  `20000 + sha1(root, name) % 10000`.
- `sssb port`, `serve-standalone`, `launch-json`, `tick` and `dev-tick` read the app's declaration (`app-port.js`);
  `tick` and `dev-tick` accept the app's own slot by name, or with no argument.
- An app on a slot of its own may not name `showcase` or `starter`, which the scripts and config it copied from the
  starter do: `portFor`, `sssb port`, `serve-standalone`, `tick` and `dev-tick` refuse (`foreignAppSlotProblem`), since
  its dev server would bind its slot while its ticker and e2e run used the first app's port.
- `sssb doctor` fails an invalid declaration, two apps on one slot, and two slots with one default
  (`portSlotProblems`, `packages/tools/src/commands/doctor-checks.js`).
- Pinned in `tests/tooling/ports.test.ts`, `tools-cli.test.ts`, `tick.test.ts` and `tools-doctor.test.ts`. Each of
  these was seen red when broken, then restored: the doctor check disabled, its same-slot and same-default branches
  one at a time, the foreign-slot refusal, the name in a derived port, the reserved-band check on a default, the
  nearest-declaring-package walk, and `originForApp`'s symlink resolution.
- The pages shape of `pnpm pack-and-consume` (two apps made from the starter) gives its ledger a slot of its own, as
  `docs/adopting.md` tells an adopter to; it could not be run where this was built, so CI is its first run.
- The design's example default, 3300, lies inside the built-in showcase and starter derived band (3200-3599), so the
  declaration refuses it; the examples now use 3700.
- Not done: `neutral-app-port-service.md` (a neutral built-in slot for the starter) still stands, and can now be built
  on a slot the generator writes.
