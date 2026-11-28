---
description: Add a demo-preset operation kind (definition + server half + static half) through the app-config seam
argument-hint: <noun.verb kind, and what it does> [--from <SSSB kind>]
---

Add a demo-preset operation kind for: $ARGUMENTS

**The app** is the directory the workspace root `package.json` lists in `sssb.apps` (with more than one, the one
the request names, or ask). Paths below are relative to that directory; run `pnpm` scripts from the workspace root.
SSSB's reference app is cited by URL, where `<ref>` is the commit your project's Claude Code settings pin the `sssb`
marketplace to (in SSSB's own repository, read its local showcase app instead).

A demo preset (`@sssb/kit/core/presets`) is the seed plus a script of world operations that every host replays: the
server through the same code the product runs, the `file://` demo through its in-memory twin. SSSB ships four
kinds: `invite`, `inbound`, `flag`, `actor.hold`. An app adds its own (the reference app's `ticket.assign` is the
worked example, `https://github.com/safeinsights/sssb/tree/<ref>/apps/showcase/src/app-config/presets/operations/ticket-assign`),
and an app kind with SSSB's kind NAME replaces SSSB's.

Every kind is **three files that never import each other's halves**, in one new directory (create
`src/app-config/presets/operations/<kind>/`):

| File            | Holds                                                              | Imported by                                     |
| --------------- | ------------------------------------------------------------------ | ----------------------------------------------- |
| `definition.ts` | args type + Standard Schema (Valibot) + `check` + `consumes`: PURE | `src/app-config/presets.ts` (both hosts, tests) |
| `server.ts`     | the server half: `ServerPresetOperationHandler<Args>`              | `src/app-config/preset-operations.ts` ONLY      |
| `static.ts`     | the static half (a factory over the composition root's rows)       | the static composition root ONLY                |

**The hard rule: never import a server half from anything the static demo bundles.** `server.ts` reaches
`@sssb/kit/adapters/index`, which starts with `import 'server-only'`, and through it pglite; the static demo is one
single-file bundle, and either of those inside it stops it loading from `file://`. That is why the server half
registers on its own server-only seam module and never on `src/app-config/presets.ts`. After building, check:
`grep -c pglite apps/<app>/dist-demo/index.html` must print 0.

1. **Name the kind** `<noun>.<verb>` in the app's vocabulary. Decide what it EXPLICITLY names: an actor (`by`, a
   seed person) and a team (`org`), always; never "whoever is signed in", because a preset replays before anyone
   is. If it acts on something an earlier step created, it takes a NAME, not an id (step 4).
2. **The definition**: create `src/app-config/presets/operations/<kind>/definition.ts`, copying the reference app's
   (`https://github.com/safeinsights/sssb/blob/<ref>/apps/showcase/src/app-config/presets/operations/ticket-assign/definition.ts`):
    - export the args interface and `export type <Kind>Operation = PresetOperationOf<'<kind>', <Args>>`;
    - `args`: the SHAPE, as a Valibot `v.strictObject(...)`, so a misspelled argument fails the gate rather than
      being dropped (any Standard Schema library works; it must validate synchronously). Types only: a value the
      product would refuse is a rule, not a shape. A generated app does not depend on Valibot (the kit uses it but
      does not re-export it), so add it to the app first: `pnpm --filter <app> add valibot`;
    - `check(args, world, earlier)`: the rules the product's route would enforce, as plain sentences. Ask the SAME
      question the route's `authorize(...)` asks, through `defineAbilitiesFor` (`@sssb/kit/core/abilities`), as the
      explicit actor acting in the explicit team. `world` is derived from the seed by the conformance suite; a field
      it lacks is a request to SSSB, never a hand-listed value;
    - `consumes(args)`: every argument that is a NAME from an earlier step's `as`.
3. **Register the definition** in `src/app-config/presets.ts`: add it to `appPresetOperations` and its operation
   type to the `AppPresetOperation` union (the app generated with `never`).
4. **Named results.** A step may say `as: 'refund'`; the id of what it created is bound to that name for the rest
   of the replay. A half that creates something returns `{ ref: id }` (return nothing or `{}` otherwise); a half
   that consumes a name calls `ctx.refs.resolve(name)`. The gate requires every consumed name to be bound by an
   EARLIER step, and each name to be bound once.
5. **The server half**: create `src/app-config/presets/operations/<kind>/server.ts`, copying the reference app's
   `server.ts` beside its definition (its `@app/seed` import is `@/seed` in a generated app, which has no `@app/*`
   alias; the same goes for its `static.ts`): resolve the team with `resolvePresetOrg`
   (`@sssb/kit/server-lib/preset-operations`), look the row up ORG-SCOPED the way the route does, then call the
   **same named domain operation the route calls**. If the route still holds that logic inline, first extract its post-authorize body into a function
   (create `src/domain/<operation>.ts`; the reference app's `applyTicketChanges`,
   `https://github.com/safeinsights/sssb/blob/<ref>/apps/showcase/src/domain/ticket-changes.ts`, is the pattern): an
   operation both callers call, not an event one of them posts. The route keeps parsing, validation, session,
   resolution and `authorize(...)`. Throw `NotFoundError` for anything the world does not have. Register it in
   `appPresetOperationHandlers` in `src/app-config/preset-operations.ts`.
6. **The static half**: create `src/app-config/presets/operations/<kind>/static.ts`, copying the reference app's
   `static.ts`: a factory taking this render's rows and setter, returning a `StaticPresetOperationHandler<Args>`
   (`@sssb/kit/demo-static/contracts`). Call the static twin of the same domain operation (extract it from the card's
   inline handler if needed; the reference app's is
   `https://github.com/safeinsights/sssb/blob/<ref>/apps/showcase/src/demo-static/ticket-changes.ts`), passing the
   explicit actor, and route the audit and notification through `ctx.recordAudit(entry, scope)` and
   `ctx.notifyMemberOf`; never `world.logAudit`, which writes as the signed-in person. Return `false` when the world
   cannot perform the step. Register it in `src/demo-static/app.tsx` under
   `useDemoWorld({ presetOperations: { … } })`.
7. **Use it** in a preset (`/sssb:new-preset`), and update that preset's summary copy in BOTH catalogs.
8. **Gates**: `pnpm exec vitest run apps/<app>/src/sssb.conformance.test.ts` (the conformance suite, whose
   `demo-presets` check holds definitions to server halves and replays every preset on the server; run the whole
   file, since a `-t` filter that skips its other checks fails it by design); the static demo's spec loads every
   registered preset from `file://` and waits for its "Preset loaded" notice, so a missing static half fails there
   (`/sssb:new-preset` step 8 says how to add that loop, and why it imports the preset list module rather than
   `src/app-config/presets.ts`, which now imports your definition). Assert the kind's visible effect in the static
   demo's preset load test, and, if you want the server's too, in a spec that loads it from the Snapshots tab on
   `pnpm dev` (`/sssb:new-preset` step 10). Then `pnpm check:demo-size` and `pnpm verify`.

## `--from <SSSB kind>`: replace one of SSSB's kinds

To make a preset follow YOUR version of `invite` (a customized invite flow), register an app kind with SSSB's name.
Start from SSSB's own three parts and keep the name:

- **Definition**: copy SSSB's from the installed kit's source for `@sssb/kit/core/presets`, where the four are
  module-private functions, `() => ({ ... })`, so SSSB's own stay out of the static demo (`inviteOperation`,
  `inboundOperation`, `flagOperation`, `actorHoldOperation`; none is exported, so copy rather than import). Put the
  object one returns into your kind's `definition.ts` as an exported constant, keeping `kind` identical,
  and register it in `appPresetOperations`. If your version keeps SSSB's argument shape, leave `AppPresetOperation`
  alone (SSSB's `FrameworkPresetOperation` already types that name); if it changes the shape, add yours to the
  union. Change the rules to match your route.
- **Server half**: copy SSSB's from `@sssb/kit/server-lib/preset-operations` into your `server.ts`, or WRAP it
  (`frameworkPresetOperationHandlers.<kind>(args, ctx)` is published there), and register it under SSSB's kind name
  in `src/app-config/preset-operations.ts`.
- **Static half**: SSSB's lives inside `@sssb/kit/demo-static/world` (it touches world state no app half can
  reach), so wrap it instead of copying it: `ctx.framework.<kind>(args, ctx)` runs SSSB's twin, and your half adds
  what your version does differently. Register it under SSSB's kind name in `presetOperations`.

SSSB's own test fixture shows a wrapping replacement (`flag`):
`https://github.com/safeinsights/sssb/blob/<ref>/packages/kit/test-fixture/app-config/preset-operations.ts`.
