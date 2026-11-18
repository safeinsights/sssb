---
'@sssb/kit': minor
---

### The app guide gains the cutover rule and the dev loop

**Kind.** seam

**Action.** required

**What changed.** SSSB's app guide (`@sssb/kit/guide.md`) now also says what SSSB's own agent guide said only to its
maintainers and an app author needs: anything needing real credentials is a row in the workspace's cutover checklist,
never a blocker; scheduled work runs in dev only when something ticks it (`pnpm tick`, `DEV_TICK_SECONDS`), and the
cron route stays behind `withWebhookSecret`; a linked worktree derives the app's ports per checkout
(`pnpm exec sssb port`); and the workflow (`pnpm verify` before finishing, `pnpm lint:fix`, conventional commits).
`sssb doctor` fails until the workspace's copy is refreshed.

**To adopt.** Run `pnpm exec sssb guide` from your app and commit the diff of `.claude/sssb-guide.md`.

**Now deletable.** Those rules copied by hand from SSSB's `CLAUDE.md` into your own.
