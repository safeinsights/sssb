---
description: Add a simulated counterparty (Simulator actor) registered through the app-config seam
argument-hint: <counterparty, and what it does>
---

Add a Simulator actor for: $ARGUMENTS

**The app** is the directory the workspace root `package.json` lists in `sssb.apps` (with more than one, the one
the request names, or ask). Paths below are relative to that directory; run `pnpm` scripts from the workspace root.
SSSB's reference app is cited by URL, where `<ref>` is the commit your project's Claude Code settings pin the `sssb`
marketplace to (in SSSB's own repository, read its local showcase app instead).

Actors are simulated external counterparties for dev and the demo. The actor _runtime_ (shell, iframe hosting,
`@sssb/kit/components/simulator/actor-runtime`) is the framework's; each actor is app content:

1. **Register** in `src/app-config/actors.ts`: add `{ id, titleKey, descriptionKey }` to `actors` and widen
   `ActorId` (the app generated with none, so it is `never`). The keys resolve in the APP catalog's `actors`
   namespace (`messages/en.json` and `messages/es.json`, and `APP_NAMESPACES` in `src/app-config/messages.ts`): the
   host glue translates them and hands the panel finished strings, so an actor you invent never needs a key in
   SSSB's catalog. The reference app's
   `https://github.com/safeinsights/sssb/blob/<ref>/apps/showcase/src/app-config/actors.ts` registers two.
2. **Driver**: the actor's behaviour (what it polls, which buttons it exposes, which service or API calls it makes)
   lives in the app's actor route. If the app has none yet, create `src/app/[locale]/simulator/actors/[actor]/page.tsx`,
   create `src/app/[locale]/simulator/actors/[actor]/actor-host.tsx` and create
   `src/app/[locale]/simulator/actors/[actor]/drivers.ts`, starting from the reference app's
   (`https://github.com/safeinsights/sssb/tree/<ref>/apps/showcase/src/app/[locale]/simulator/actors/[actor]`), where
   `bundle-analyzer` (a service-token job runner) and `partner-desk` (a completion-webhook deliverer) are the two
   shapes. **Then wire the driver in, in BOTH hosts: neither is generic, and both fail silently.** Each picks its
   driver by actor id, and an unrecognised id falls through to the builder shape rather than erroring: the actor
   host branches on the id inside its `tick` callback (the live app), and the static demo, `src/demo-static/app.tsx`,
   does the same with a ternary over its tick functions. No gate catches a missing branch: typecheck, lint, knip and
   the unit suite all stay green while your new actor quietly runs someone else's behaviour.
3. **Org coupling**: if the actor impersonates a service bound to an org, that slug is app config (the reference
   app's `analyzerOrgSlug`) and must match an org in the app's seed (`src/seed/index.ts`). Over `/api/service/*` it is
   a MACHINE actor (`abilityActorFromService`, handed to handlers as `ctx.actor`): a mutating service route calls
   `authorize(actor, …)`, and the only framework grant is Job read/update in its own org. Anything else it needs is a
   line in `appMachineAbilityRules` (`src/app-config/abilities.ts`).
4. **Static twin**: the in-memory driver shapes are the framework's (`builderTick`, `serviceTick` in
   `@sssb/kit/components/simulator/actor-runtime`). An actor over the jobs subsystem needs no new twin, just a scoped
   factory call and a tick wired into `actorSlots` in `src/demo-static/app.tsx`, so the `file://` demo can step the
   same story. A driver over a surface SSSB doesn't own is a new twin beside it.
5. **Holds**: nothing to wire. Both hosts ask the world whether THIS actor is held before every autonomous tick (the
   `actors-held` flag for all of them, a demo preset's `{ op: 'actor.hold', actor: '<id>', held: true }` for one).
   The preset gate checks `actor` against the `actors` list you registered in step 1.
6. Exercise it from the Simulator's Actors tab (each registered actor becomes a card and a slot, titled from your
   registration's keys) and cover the flow in an e2e spec under `tests/e2e/`, in the style of the reference app's
   `https://github.com/safeinsights/sssb/blob/<ref>/apps/showcase/tests/e2e/destructive/actors.spec.ts`. Finish with
   `pnpm verify`.
