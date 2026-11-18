---
description: Verify, run a subagent branch review against the house rules, fix findings, then open the PR
---

**The app** is the directory the workspace root `package.json` lists in `sssb.apps` (every one of them, when it lists
several). Paths below are relative to an app's directory.

1. From the workspace root, run `pnpm verify`. If anything fails, fix it and re-run until green. If Playwright
   complains about a missing browser, run `pnpm exec playwright install chromium` once, then retry.
2. Spawn a read-only review subagent on the full branch diff against the base branch. Give it this checklist, and
   the SSSB app guide as the rules it holds the diff to: `.claude/sssb-guide.md` at the workspace root, which the
   project's CLAUDE.md imports (in SSSB's own repository, CLAUDE.md imports the guide's source):
    - App-guide violations: vendor SDK imports (static or `import()`) outside `src/adapters/real/` (if any);
      `process.env` reads outside it and the guide's other named places; a framework import that is not a
      published `@sssb/kit/…` subpath; a framework union or registry edited instead of registered through
      `src/app-config/`; tenant queries not routed through `db.withTenant()` (a raw `getDb()` anywhere in `src`, or a
      new entry in the app's `lint-exceptions.mjs` (if any)); a mutating route without `authorize(...)`; hard-coded UI
      strings; logic in a route file instead of a router-agnostic screen.
    - Dead or speculative code.
    - Copy-paste that should be a shared function or component.
    - `messages/en.json` vs `messages/es.json` drift (missing keys, mismatched placeholders).
    - Tests that assert nothing (empty bodies, missing expect, tautological assertions).
    - Quiet weakening of quality configs: new `eslint-disable` comments, knip or jscpd ignores, a raised demo-size
      budget, loosened thresholds, a conformance opt-out: flag any without a written justification.
3. Triage the findings: fix confirmed ones and re-run `pnpm verify` until green again. For anything dismissed, note
   a one-line reason.
4. Done when `pnpm verify` is green, every finding is either fixed or dismissed with a reason, commits are
   conventional, and a PR is open against the base branch whose description summarizes the change AND the review
   outcome (including dismissals).
