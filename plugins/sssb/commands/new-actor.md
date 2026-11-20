---
description: Add a simulated counterparty (Simulator actor) registered through the app-config seam
argument-hint: <counterparty, and what it does>
---

Add a Simulator actor for: $ARGUMENTS

**The app** is the directory the workspace root `package.json` lists in `sssb.apps` (with more than one, the one
the request names, or ask). Paths below are relative to that directory; run `pnpm` scripts from the workspace root.
SSSB's reference app is cited by URL, where `<ref>` is the commit your project's Claude Code settings pin the `sssb`
marketplace to (in SSSB's own repository, read its local showcase app instead).

Actors are simulated external counterparties for dev and the demo: each is a tick loop on a card in the Simulator's
Actors tab. The runtime (`ActorShell`, `ActorsApp`, and the job-runner shapes `builderTick` and `serviceTick`; step 3 names
each one's subpath) is the framework's; each actor is app content.

**What a generated app has.** A workspace `pnpm create @sssb` generated has two Simulator panels. On `pnpm dev` its
locale layout mounts SSSB's `SimulatorHost` (`@sssb/kit/components/simulator/simulator-host`), served by its
`src/app/api/simulator/[...path]/route.ts`: People, Mail, and Jobs with the world clock, and no Actors tab (the host
takes no app-registered tab). Its static demo's `src/demo-static/app.tsx` hands the framework's `DemoShell` an empty
`extraTabs`, so that panel shows SSSB's own tabs and no Actors tab either. And `src/app-config/actors.ts` registers no
actor, typed so that it cannot (`ActorId` is `never`, the list `readonly { id: string }[]`). So steps 1 to 5 add the
actor where a panel takes an app's tab, the static demo. The server host is the last section, and it applies only once
the app's `pnpm dev` panel takes app tabs, which SSSB's host does not yet: the reference app has its own glue for it.

1. **Register** in `src/app-config/actors.ts`. The generated list's type has no room for an actor's copy, and the
   kit exports no actor-definition type, so replace both declarations with the reference app's shape
   (`https://github.com/safeinsights/sssb/blob/<ref>/apps/showcase/src/app-config/actors.ts`): an `as const` list of
   `{ id, titleKey, descriptionKey }`, and `export type ActorId = (typeof actors)[number]['id']`. Keep the file
   pure TypeScript: both hosts and the conformance suite import it. The keys resolve in an APP `actors` namespace:
   add `actors` to `APP_NAMESPACES` (`src/app-config/messages.ts`) and the keys to BOTH `messages/en.json` and
   `messages/es.json`, so an actor you invent never needs a key in SSSB's catalog.
2. **The tab.** Export `tabs` from `src/app-config/simulator.ts` (the generated file exports none):
   `[{ id: 'actors', labelKey: 'actorsTab', keepMounted: true }]`, typed like the reference's `AppSimulatorTab`
   (`https://github.com/safeinsights/sssb/blob/<ref>/apps/showcase/src/app-config/simulator.ts`). `actorsTab` is in
   SSSB's `simulator` namespace; `keepMounted` runs the actors from page load, not from the first time the tab opens.
3. **The tick, in the static composition root** `src/demo-static/app.tsx`, modelled on the reference's
   (`https://github.com/safeinsights/sssb/blob/<ref>/apps/showcase/src/demo-static/app.tsx`, from `serviceTickFn`
   to `extraTabs`), with `tSimulator = useTranslations('simulator')` and `tActors = useTranslations('actors')`:
    - **A tick per actor**, `(log: ActorLog) => Promise<void>`, with `ActorLog`, `builderTick` and `serviceTick` from
      `@sssb/kit/components/simulator/actor-runtime`. Over the jobs subsystem, use the framework's shapes:
      `builderTick(world.builderDriver(serviceManagedOrgSlugs, log), log, tSimulator)` completes queued jobs as a
      build service would (`serviceManagedOrgSlugs` is in `src/app-config/jobs.ts`), and `serviceTick` over
      `world.serviceDriver(...)` claims one team's jobs, keeping a `ServiceMemory` ref you clear in
      `useDemoWorld({ onReset })`. An actor over anything else is your own tick over this file's rows: a driver over
      a surface SSSB doesn't own is a new twin beside it.
    - **The slots**: map `actors` to `ActorSlot` (`@sssb/kit/components/simulator/actors-app`), titled with
      `tActors(titleKey)`, whose `node` is an `ActorShell` (`@sssb/kit/components/simulator/actor-shell`) with
      `key={id}`, `actor={id}`, `inline`, `startPaused={false}`, `held={() => world.actorHolds[id] ?? false}` and
      `tick` set to the tick for THAT id (`actor`, `startPaused` and `tick` are required).
    - **The tab's content**: map `tabs` to `SimulatorExtraTab` (`@sssb/kit/components/simulator/simulator-panel`),
      labelled `tSimulator(tab.labelKey)`, with `ActorsApp` (`@sssb/kit/components/simulator/actors-app`) as its
      content (`world={{ held: world.jobsHeld, counts: world.jobCounts }}`), and pass it to `DemoShell` instead of
      `[]`.

    **Pick each actor's tick by id, exhaustively.** The reference picks with a ternary, so an unrecognised id falls
    through to the other actor's behaviour; typecheck, lint, knip and the unit suite all stay green while a new actor
    quietly runs someone else's tick. Key the ticks by id instead (a `Record<ActorId, …>`, or a `switch` over
    `ActorId` with no default), so a registered actor without a tick is a type error.

4. **Holds.** The `held` callback makes a demo preset's `{ op: 'actor.hold', actor: '<id>', held: true }` hold this
   actor; the conformance suite checks `actor` against the list from step 1. The reference app also registers an app
   flag that holds every actor at once (`actors-held`, among its Simulator `flags`, read by its `held` callback); a
   generated app registers no flags, so add one only if you want that switch.
5. **Exercise it** in the static demo: `pnpm build:demo-static`, open the app's `dist-demo/index.html`, then
   Simulator → Actors, one card per registered actor (testid `actor-card-<id>`). Cover it in a spec under
   `tests/demo-static/`, beside `tests/demo-static/static-shell.spec.ts` (whose panel steps it can copy): open the
   panel, click `simulator-tab-actors`, and assert the card and what its tick visibly did (`actor-log-entry` rows
   in the card). Run it with `pnpm build:demo-static && pnpm e2e:demo-static`. The runtime adds to the single-file
   demo, so run `pnpm check:demo-size` too, then finish with `pnpm verify`.

**The server host, only once the app's `pnpm dev` panel takes app tabs.** On `pnpm dev` an actor runs in a page the
server panel embeds, driving the app's real HTTP surfaces. A generated app's `SimulatorHost` has no Actors tab and no
actor routes. The reference app's server Simulator is its own panel glue
(`https://github.com/safeinsights/sssb/blob/<ref>/apps/showcase/src/app/[locale]/simulator-glue.tsx`, mounted from
its locale layout in place of `SimulatorHost`), the `/api/simulator/*` routes the panel and the actor pages call
(`https://github.com/safeinsights/sssb/tree/<ref>/apps/showcase/src/app/api/simulator`) and, for a service-shaped
actor, the `/api/service/*` routes
(`https://github.com/safeinsights/sssb/tree/<ref>/apps/showcase/src/app/api/service`). Adding it means porting that
glue, which replaces the layout's `SimulatorHost` mount, and each route it calls that SSSB's catch-all
`src/app/api/simulator/[...path]/route.ts` does not answer (a route file of the app's own beside the catch-all wins for
its path). That is its own piece of work and not this command's. Once the app has it:

- **The actor page**: create `src/app/[locale]/simulator/actors/[actor]/` from the reference's
  (`https://github.com/safeinsights/sssb/tree/<ref>/apps/showcase/src/app/[locale]/simulator/actors/[actor]`: a page,
  an actor host and the drivers; `bundle-analyzer` is a service-token job runner, `partner-desk` a completion-webhook
  deliverer). Its drivers call `/api/simulator/service-token`, `/api/simulator/actors/artifact`,
  `/api/simulator/actors/builds`, `/api/simulator/actors/held` and `/api/simulator/webhook-secret`, so those routes
  come with it. Pick the driver by id exhaustively here too.
- **Org coupling**: an actor that impersonates a service bound to an org takes that slug from app config (the
  reference's `analyzerOrgSlug`), and it must match an org in the app's seed (`src/seed/index.ts`). Over
  `/api/service/*` it is a MACHINE actor (`abilityActorFromService`, handed to handlers as `ctx.actor`): a mutating
  service route calls `authorize(actor, …)`, and the only framework grant is Job read/update in its own org. Anything
  else it needs is a line in `appMachineAbilityRules` (`src/app-config/abilities.ts`).
- **An e2e spec** under `tests/e2e/`. The reference's
  (`https://github.com/safeinsights/sssb/blob/<ref>/apps/showcase/tests/e2e/destructive/actors.spec.ts`) leans on its
  own spec helpers (`https://github.com/safeinsights/sssb/tree/<ref>/apps/showcase/tests/e2e/support`: `signInAs`,
  `openSimulatorPanel`, `setWorldFlag`), which a generated app does not have: copy the ones you use, or drive the
  page directly as `tests/e2e/items.spec.ts` does.
