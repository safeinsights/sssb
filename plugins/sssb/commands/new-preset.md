---
description: Add a demo preset (a named starting world every host can load) registered through the app-config seam
argument-hint: <the world the preset starts from>
---

Add a demo preset for: $ARGUMENTS

**The app** is the directory the workspace root `package.json` lists in `sssb.apps` (with more than one, the one
the request names, or ask). Paths below are relative to that directory; run `pnpm` scripts from the workspace root.
SSSB's reference app is cited by URL, where `<ref>` is the commit your project's Claude Code settings pin the `sssb`
marketplace to (in SSSB's own repository, read its local showcase app instead).

A demo preset is a named starting world: the seed plus a script of operations. Every host replays it its own way:
the server through the same code the product runs (`@sssb/kit/server-lib/demo-presets`), the single-file `file://`
demo through its in-memory twin (`@sssb/kit/demo-static/world`). A tour can start from it. In a generated app the
only Simulator is the static demo's, so a preset loads from **Simulator → Snapshots → Start from a preset** there
(`pnpm build:demo-static`); `pnpm dev` has no Simulator (the server panel is SSSB's reference app's), and the
server replay is exercised by the conformance suite instead (step 8). The contract and every operation kind's rules
are in `@sssb/kit/core/presets`; the reference app's presets are the worked examples
(`https://github.com/safeinsights/sssb/tree/<ref>/apps/showcase/src/app-config/presets`).

1. **Register.** One file per preset: create `src/app-config/presets/<id>.ts`, exporting a `DemoPreset`
   (`@sssb/kit/core/presets`), and list it. The app was generated with an empty `presets` array in
   `src/app-config/presets.ts`; with your first preset, move the list into its own module as the reference app
   does (`https://github.com/safeinsights/sssb/blob/<ref>/apps/showcase/src/app-config/presets/list.ts`): create
   `src/app-config/presets/list.ts` exporting `presets`, and replace the array in `src/app-config/presets.ts` with
   `export { presets } from './presets/list'`. The static demo's Playwright spec (step 8) imports that list module,
   never `src/app-config/presets.ts`: once the app registers an operation kind, that file imports the kind's
   definition, which calls the kit at runtime, and a spec reaches the kit only through `@sssb/kit/testing/e2e`
   (`sssb check-e2e` fails it, and Node cannot load the kit's TypeScript anyway). For the same reason a preset file
   takes only TYPES from the kit, and, since the static demo bundles it, imports nothing server-only. The array's
   order is the order the Snapshots tab lists them, and a base may sit anywhere in it. A script fragment you want to
   reuse by hand rather than through `extends` is a plain `PresetOperation[]` constant (the reference app's
   `https://github.com/safeinsights/sssb/blob/<ref>/apps/showcase/src/app-config/presets/morning-tickets.ts`).
    - **`id`** is a world-start name: lowercase letters, digits and hyphens, starting with a letter or digit, 40
      characters at most. It is the Snapshots row's testid (`preset-load-<id>`) and the name a tour's `snapshot`
      resolves. Never `reset` (the seeded world, no script). Unique in the registry, and it cannot collide with a
      saved snapshot: resolution is `reset`, then a preset, then a saved snapshot, and saving a snapshot under a
      preset's id is refused, so one name never means two worlds.
2. **Copy.** `titleKey` and `summaryKey` are FULLY-QUALIFIED keys into the APP catalog, in the `presets` namespace
   (`presets.<id>Title`, `presets.<id>Summary`), in BOTH `messages/en.json` and `messages/es.json` (key-identical;
   the namespace must be listed in `APP_NAMESPACES` in `src/app-config/messages.ts`). The summary is the row's
   second line: say what is different about this world, in one sentence. Typed content inside operations (an
   email's subject and body) is simulated DATA, not UI copy: it stays in one language, like the seed.
3. **Build on a base (optional).** `extends: '<other preset id>'` replays that preset first: single inheritance, and
   the base may itself extend another. `operations` is optional, so a preset that differs from its base by
   viewpoint alone omits it. An unknown base or a cycle fails the gate. The base's operations come first, your own
   last, and an operation number in a gate message counts in that expanded list.
4. **Script the world.** `operations` is an ordered list of `{ op, as?, ...args }`. Every step that acts as someone
   or in a team names them explicitly (never "whoever is signed in", because nobody is yet; `flag` and
   `actor.hold` are world-wide and name no one), and the gate holds it to what the product itself would allow, so a
   preset can only describe a world someone could have clicked together. People and teams are the app's seed's
   (`src/seed/index.ts`). SSSB's kinds:
    - `{ op: 'invite', by: '<person id>', org: '<org slug>', email: '<address>', role: 'member' }`: `by` (a seed
      person who manages `org`) invites `email` as `role`: the invite, its email unread in the invitee's inbox, the
      audit row and the admins' notification. The role must be one an invite may grant (not `admin`), and an
      address can be invited once across the expanded script and must not already be a person.
    - `{ op: 'inbound', as: '<name>', org: '<org slug>', handler: '<handler>', from: '<seed person email>', subject: '…', body: '…' }`:
      an email to `<org>+<handler>@…` through the real intake and the handler the app registers in
      `src/app-config/inbound-email.ts`. `from` must be a seed person; whether that person may author into the team
      stays the handler's call, so an email the handler refuses is a legitimate thing to show.
    - `{ op: 'flag', flag: '<flag id>', enabled: true }`: a Snapshots feature flag, SSSB's (`demo-banner`,
      `jobs-held`) or one the app registers in `src/app-config/simulator.ts`.
    - `{ op: 'actor.hold', actor: '<actor id>', held: true }`: see step 7.
    - An app's own kind is used the same way. A kind that does not exist yet is `/sssb:new-preset-operation`; do not
      rebuild it here.
5. **Name what a later step needs.** A step that creates something may say `as: 'refund'`, and a later step whose
   kind `consumes` that name takes it as an argument. Never write an id into a preset: a real uuid on the server
   and the twin's id in the static world differ, so the script holds names and each host keeps its own name-to-id
   map for one replay. A name is bound once and may only be consumed by a LATER step; only a step that creates a row
   can be named (`inbound` when the handler handled it, an app kind that returns `{ ref }`).
6. **Pick the viewpoint.** `viewpoint: '<person id>'` (a seed person's id) is who the browser that LOADS the preset
   sits down as once the world is ready, not state captured in the preset. The viewpoint is a per-browser cookie and
   the world is shared, so a second browser watching the same server keeps its own person across a load. A child
   overrides its base's viewpoint and otherwise inherits it. Omit it to leave the viewpoint where the host's reset
   leaves it; the server then answers the welcome page rather than the dashboard.
7. **Hold an actor.** `actor.hold` holds (or, with `held: false`, releases) ONE registered Simulator actor
   (`src/app-config/actors.ts`; a generated app registers none, and `/sssb:new-actor` adds one): it keeps its
   schedule and does nothing on its own, a manual Step still works, and the others keep running. An app may also
   register a world-wide switch, as the reference app's `actors-held` flag holds EVERY actor; an actor is then held
   if either applies. Every load resets the world first, so a hold is exactly the expanded script's last word per
   actor and never survives into the next preset; a child can release what its base held.
8. **What the build enforces, and how to read it.** Three layers, none of which you edit for a new preset:
    - `presetProblems` (`@sssb/kit/core/presets`), run by the conformance suite's `demo-presets` check
      (`@sssb/kit/testing`), which the app runs from `src/sssb.conformance.test.ts`, against a world derived from the
      seed and the registries, never hand-listed. A problem reads
      `preset "<id>" operation <n> (<kind>): <sentence>`: the number is in the expanded script, base first, so a
      base's own problem repeats under every preset that extends it. It fails an unknown kind, a bad argument shape
      (one sentence per issue, naming the path), a name bound twice or consumed before it is bound, and an unknown
      viewpoint; its other cases fail a title or summary key missing from either catalog.
    - The same check REPLAYS every registered preset through the server path against the app's real seed and
      handlers, and asserts every invite is pending, every hold set and the viewpoint signed in. A throw here
      (`unknown preset operation`, `no earlier operation is named`, `created nothing to name`) is a half that cannot
      do what its definition allows, not a preset to loosen.
    - The static demo's spec loads EVERY registered preset from `file://` and waits for the "Preset loaded" notice;
      a replay step the static half cannot perform settles false and the notice never comes. No unit test can see the
      static halves, which is why this loop exists. The app was generated without presets, so its
      `tests/demo-static/static-shell.spec.ts` has no such loop yet: with your first preset, add the reference app's
      (`https://github.com/safeinsights/sssb/blob/<ref>/apps/showcase/tests/demo-static/static-shell.spec.ts`, the
      `for (const preset of presets)` loop at its end), importing `presets` from the list module, `src/app-config/presets/list.ts` (two levels up from
      the spec).
      It asserts on SSSB's whole load notice and on the absence of the failure notice (both name the preset), through
      two helpers the generated `tests/catalog.ts` lacks (it exports only `welcome`). Add them there. The reference's
      `simulatorNotice` reads SSSB's catalog by a path inside SSSB's repository; yours reads the installed kit's,
      as a file (a spec may not import the kit):

        ```ts
        /** A fully-qualified key (`namespace.key`, as a preset's `titleKey` names it) in this app's catalog. */
        export function appMessage(locale: string, key: string): string {
            const file = path.resolve(__dirname, `../messages/${locale}.json`)
            const catalog = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>
            const value = key
                .split('.')
                .reduce<unknown>((node, part) => (node as Record<string, unknown> | undefined)?.[part], catalog)
            if (typeof value !== 'string') throw new Error(`the ${locale} catalog has no string at ${key}`)
            return value
        }

        /** A Simulator notice from SSSB's catalog, with its `{name}` filled in. */
        export function simulatorNotice(locale: string, key: string, name: string): string {
            const file = require.resolve(`@sssb/kit/i18n/messages/${locale}.json`)
            const catalog = JSON.parse(readFileSync(file, 'utf8')) as { simulator: Record<string, string> }
            const template = catalog.simulator[key]
            if (typeof template !== 'string') throw new Error(`SSSB's ${locale} catalog has no simulator.${key}`)
            return template.replace('{name}', name)
        }
        ```

    Fix the PRESET to fit the rule. A rule that seems wrong is the kind's `check`, in one place, never a per-preset
    exception.

9. **Start a tour from it (optional).** Set `snapshot: '<id>'` on the `TourDefinition` in `src/app-config/tours.ts`;
   it works on every host, where a saved snapshot's name does not. The tour's first step should say what the preset
   already set up. The rest is `/sssb:new-tour`.
10. **Verify.**
    - Fast loop: `pnpm exec vitest run apps/<app>/src/sssb.conformance.test.ts` (the conformance suite: its
      `demo-presets` check replays every preset, and its i18n checks hold the copy). Run the whole file: a `-t`
      filter that skips its other checks fails it by design.
    - Assert what the preset VISIBLY did in the static demo, in a load test beside the loop (load it from the
      Snapshots tab as the loop does, then check the screen), and run both with
      `pnpm build:demo-static && pnpm e2e:demo-static`. A server-side e2e spec that loads a preset needs the server
      Simulator's Snapshots tab, which a generated app does not have; once the app has the reference's server
      Simulator, model it on the reference's `presets:` test in
      `https://github.com/safeinsights/sssb/blob/<ref>/apps/showcase/tests/e2e/destructive/simulator-snapshots.spec.ts`
      (it resets the world, so it runs on its own; it leans on that app's spec helpers, which you would copy too).
    - Finish with `pnpm check:demo-size` and `pnpm verify`.
