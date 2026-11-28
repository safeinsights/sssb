---
description: Add a scripted Simulator walkthrough (tour) registered through the app-config seam
argument-hint: <the story the tour tells>
---

Write a Simulator tour for: $ARGUMENTS

**The app** is the directory the workspace root `package.json` lists in `sssb.apps` (with more than one, the one
the request names, or ask). Paths below are relative to that directory; run `pnpm` scripts from the workspace root.
SSSB's reference app is cited by URL, where `<ref>` is the commit your project's Claude Code settings pin the `sssb`
marketplace to (in SSSB's own repository, read its local showcase app instead).

A tour is a scripted walkthrough: a ghost cursor drives the REAL screens while a bar narrates, so the single-file
demo (`pnpm build:demo-static` builds it) can be watched instead of read about. The _engine_ is the framework's
(`@sssb/kit/demo-static/tour/contracts` and `@sssb/kit/demo-static/tour/use-tours`, with the Simulator's Tours tab);
each tour is app content. A tour runs from the Tours tab on both of a generated app's Simulators: on its own `pnpm dev`
(SSSB's host) and in the static demo.

1. **Register** in `src/app-config/tours.ts`: add a `TourDefinition` (`@sssb/kit/demo-static/tour/contracts`) with
   `id`, `titleKey`, `summaryKey`, usually `snapshot: 'reset'` or the id of a demo preset (`presets` in
   `src/app-config/presets.ts`, written with `/sssb:new-preset`) when the story should open mid-shift. Both work on
   every host. A saved snapshot's name does not: snapshots are saved on a server, through the Snapshots tab on
   `pnpm dev`; the static demo's Snapshots tab saves none, and such a tour fails the `file://` walkthrough gate. Then its
   steps. An app with no tours renders no Tours tab at all, so an empty `tours` is a real off-switch.
2. **Narration** goes in the APP catalog (`messages/en.json` and `messages/es.json`, a `tours` namespace listed in
   `APP_NAMESPACES` in `src/app-config/messages.ts`), referenced by FULLY-QUALIFIED key (`tours.myTourStep1`). Both
   locales, key-identical (the conformance suite holds it). `<b>` works (next-intl rich text): bold the one term per
   step that matters. Typed content (an email subject the tour types) is simulated DATA, not UI copy: it stays in
   one language, like the seed.
3. **Pacing is the craft**, and these rules make a tour watchable rather than a screencast:
    - **Every submission goes in `advance`**, never in `script`: the world changes when the viewer presses Next.
      Form-filling and typing go in `script`, and the narration says "read it, then press Next to send it".
    - **One idea per step**, 1 to 3 sentences, 8 to 20 steps. An aftermath (the row appearing, the delivery
      landing) gets its OWN step.
    - **Navigate by clicking real nav**, so a viewer learns how they would get there themselves.
    - **`spotlight` at most one target per step.** It lights after the step's script finishes, so it can point at
      something the script had to go and reveal.
    - End with "everything you just watched is yours to click now".
4. **Drive targets**: reuse the `data-testid` already on the element; those are role-named and stable. Add
   `data-tour="…"` ONLY where nothing stable exists, naming the ROLE, not the styling (a testid that carries a row
   id differs between the server and the static twin). The Simulator's own controls are driven with
   `['panel', tab]`, which expands the panel if collapsed and is idempotent.
5. **Assert as you go**: `['expect', sel]` and `['expectText', sel, text]` turn the tour into a test. Put one after
   every beat that produced something.
6. **Reload safety** (the server host only, the Simulator on `pnpm dev`): a snapshot restore, a feature-flag flip and a
   person switch all reload the page there. The engine resumes from a
   sessionStorage marker written at the `advance` boundary, so anything that reloads belongs in `advance`, and
   anything in a `script` must be safe to re-run. Writing tours this way from the start costs nothing in the static
   demo.
7. **The gate**: a static-demo spec that runs EVERY registered tour to its last step from `file://` and fails unless
   the end-of-run report is `data-misses="0"`. The app was generated without one, because it had no tours: with
   your first, create `tests/demo-static/tours.spec.ts` from the reference app's
   (`https://github.com/safeinsights/sssb/blob/<ref>/apps/showcase/tests/demo-static/tours.spec.ts`). It iterates the
   registry, so it needs no editing for later tours. Run it with `pnpm build:demo-static && pnpm e2e:demo-static`.
8. **Watch it yourself** at presentation speed (in the static demo, Simulator → Tours → Start, Fast off) before
   calling it done. A tour
   that passes CI can still be unreadable; the fast run proves the selectors, your eyes prove the story. Then check
   the demo size budget (`pnpm check:demo-size`) and finish with `pnpm verify`.
