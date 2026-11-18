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
   (`https://github.com/safeinsights/sssb/blob/<ref>/apps/showcase/tests/e2e/a11y.spec.ts`, which uses
   `@axe-core/playwright`, an app dev dependency you add): every route under `src/app/[locale]`, both locales, signed
   in where the route is protected. Fix any violations first: axe findings are never "noise". If Playwright complains
   about a missing browser, run `pnpm exec playwright install chromium` once, then retry.
2. With `pnpm dev` up, go beyond axe using Playwright or browser tools:
    - Keyboard-only pass across sign-in → dashboard → team switch and the app's own flows: tab order matches visual
      order, focus is visible at every stop, no traps, Escape closes the user menu and the team switcher.
    - Focus management after a team switch and after form submits: focus must not silently reset to `body`.
    - Semantics: one `h1` per page, no skipped heading levels, landmarks present, tables (the app's own and the
      Simulator panel's tabs) have real headers, async feedback (sent, saved, failed) is announced through
      `aria-live` or `role=status`.
    - Contrast judgment on EVERY tenant theme the seed defines (`src/seed/index.ts`) and BOTH locales. SSSB's theme
      uses `primaryShade: 8` because shade 6 failed WCAG; an app that overrides the theme re-checks it.
3. Done when the axe spec is green and you've produced a ranked findings list (WCAG criterion, page, suggested fix).
   Apply one-line fixes directly; list larger ones instead of fixing them. No new `eslint-disable` comments.
