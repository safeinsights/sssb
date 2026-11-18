---
description: Screenshot every screen in both locales and tenant themes, then critique against design heuristics
---

**The app** is the directory the workspace root `package.json` lists in `sssb.apps` (with more than one, the one
the request names, or ask). Paths below are relative to that directory.

1. With `pnpm dev` running, drive the app with Playwright or browser tools. Screenshot every route under
   `src/app/[locale]` (the app's axe spec, if it has one, lists them): en + es; for protected pages, every tenant
   theme the seed defines (`src/seed/index.ts`; sign in as an admin person and use the team switcher, since tenants
   can differ in primary color AND radius). Save screenshots to the session scratchpad, never into the repository.
2. Also capture a 375px mobile width for the welcome page, sign-in and the dashboard, and the static demo
   (`pnpm build:demo-static`) where it differs from the server.
3. Critique each screenshot against: Mantine spacing-scale consistency, visual hierarchy (one clear primary action
   per screen), Spanish strings (~25% longer) overflowing buttons and labels, truncation and wrapping of long user
   data, empty states, loading states, theme tokens actually applied (no hard-coded colors).
4. Done when you've produced a ranked findings report (screen, locale/theme, issue, suggested fix) citing screenshot
   paths. Review only: do not change code unless asked.
