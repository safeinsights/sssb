---
'@sssb/tools': minor
'@sssb/eslint-plugin': minor
---

### `sssb check-fences`: the fences as the app's config composes them

**Kind.** seam

**Action.** required

**What changed.** `sssb check-fences`, run from the app, fails when the app's composed lint config has switched off or
narrowed one of SSSB's fences: a rule turned off or down for some files, an `ignores` or a nested config file that
drops a directory, a processor or another parser, a changed vendor list, an exception wider than its file, or a fence
finding in the app's own files that an `eslint-disable`, an inline `/* eslint */` comment or a suppressions file lets
through. It compares every source file's effective config with the preset's and lints probe files through the app's
config. Typed linting (`parserOptions.project` or `projectService`) cannot pass it yet: the probe files are outside the
TypeScript project.

**To adopt.** Run `pnpm exec sssb check-fences` from each app in the app's lint or verify script, and fix what it names:
an exception goes in `lint-exceptions.mjs`, an app vendor in `package.json`'s `sssb.vendors`.

**Now deletable.** A hand-kept list of which ESLint blocks re-list SSSB's patterns, and any review checklist item that
asks whether an app's config still enforces the vendor, `process.env` or tenancy bans.
