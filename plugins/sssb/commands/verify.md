---
description: Run the full verification gate (typecheck, lint, unit, e2e) and fix what fails
---

From the workspace root, run `pnpm verify`. If anything fails, fix it and re-run until green. If Playwright
complains about a missing browser, run `pnpm exec playwright install chromium` once, then retry. Report what failed
and what you changed.

A generated workspace's `pnpm verify` runs the contract tests (the real-Postgres RLS proofs) too; SSSB's own
repository's does not. **If you touched a migration or anything under an app's `src/app-config/db/`, make sure
`pnpm test:contract` ran**, and after renumbering or renaming a migration, wipe the app's local `.data/` first.
