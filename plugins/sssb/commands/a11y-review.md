---
description: Run the axe sweep, then review keyboard navigation and semantics beyond what axe can see
---

**The app** is the directory the workspace root `package.json` lists in `sssb.apps` (with more than one, the one
the request names, or ask). Paths below are relative to that directory. SSSB's reference app is cited by URL, where
`<ref>` is the commit your project's Claude Code settings pin the `sssb` marketplace to (in SSSB's own repository,
read its local showcase app instead).

1. **The axe sweep.** If the app has an axe spec under `tests/e2e/`, run it from the app's directory with
   `pnpm --filter <app> exec playwright test a11y` (the positional argument is a filter, not a path, so it runs from
   the app that owns the Playwright config). If it has none, write one first, modelled on the reference app's
   (`https://github.com/safeinsights/sssb/blob/<ref>/apps/showcase/tests/e2e/a11y.spec.ts`): every route under
   `src/app/[locale]`, both locales, signed in where the route is protected. It uses `@axe-core/playwright`, which a
   generated app does not have: add it to the app's `devDependencies` the way **Adding a package** (below)
   says. It also imports that app's own spec helpers
   (`https://github.com/safeinsights/sssb/tree/<ref>/apps/showcase/tests/e2e/support`: `signInAs`,
   `openSimulatorPanel`), which a generated app lacks: sign in through the people picker as
   `tests/e2e/items.spec.ts` does, and drop the reference's Simulator-panel pass, since `pnpm dev` has no panel in a
   generated app. Fix any violations first: axe findings are never "noise". If Playwright complains about a missing
   browser, run `pnpm --filter <app> exec playwright install chromium` once, then retry.
2. With `pnpm dev` up, go beyond axe using Playwright or browser tools:
    - Keyboard-only pass across sign-in → dashboard → team switch and the app's own flows: tab order matches visual
      order, focus is visible at every stop, no traps, Escape closes the user menu and the team switcher.
    - Focus management after a team switch and after form submits: focus must not silently reset to `body`.
    - Semantics: one `h1` per page, no skipped heading levels, landmarks present, the app's tables have real
      headers, async feedback (sent, saved, failed) is announced through `aria-live` or `role=status`. A generated
      app's only Simulator panel is the static demo's (`pnpm build:demo-static`): check its tabs' tables there.
    - Contrast judgment on EVERY tenant theme the seed defines (`src/seed/index.ts`) and BOTH locales. SSSB's theme
      uses `primaryShade: 8` because shade 6 failed WCAG; an app that overrides the theme re-checks it.
3. Done when the axe spec is green and you've produced a ranked findings list (WCAG criterion, page, suggested fix).
   Apply one-line fixes directly; list larger ones instead of fixing them. No new `eslint-disable` comments.

## Adding a package

In a generated workspace, add a dependency by hand, never with `pnpm add` (nor `pnpm --filter <app> add`): in a
workspace that is already installed, it re-resolves SSSB's kit without the app's seam, and `pnpm sssb:doctor` then
fails "has no seam linked" while typecheck fails inside `@sssb/kit`.

1. Write the package into the app's `package.json` under `dependencies` (`devDependencies` for a tool only the tests
   use), by its exact npm name, with a caret range on its latest release: `pnpm view <package> version` prints it
   (say `1.5.0`), and the entry is `"<package>": "^1.5.0"`. If the package is already a dependency elsewhere in the
   workspace, use the range written there.
2. From the workspace root, `pnpm install`, then `pnpm sssb:doctor`. If the install refuses the release as too new
   (the workspace's `minimumReleaseAge` holds back anything published in the last two days), take the newest older
   one `pnpm view <package> time` lists and install again.

If you already ran `pnpm add`, keep the `package.json` it edited and undo only the lockfile:
`git checkout HEAD -- pnpm-lock.yaml`, then `pnpm install` and `pnpm sssb:doctor`. Both ways leave the rest of the
dependency tree as it was.
