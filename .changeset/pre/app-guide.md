---
'@sssb/kit': minor
'@sssb/tools': minor
---

### The app guide ships in `@sssb/kit`

**Kind.** seam

**Action.** required

**What changed.** `@sssb/kit` ships the app guide, the rules an agent follows in your app (the seam, vendor SDKs only
in adapters, `db.withTenant()`, `authorize(...)`, i18n, router-agnostic screens, hermetic dev, migrations, the
conformance and contract tests), at the published subpath `@sssb/kit/guide.md`. `sssb guide` copies it into your
repository under a hash stamp, and `sssb doctor` now fails while that copy is missing or stale. The doc-paths gate
gained `sssb.docPaths.relativeTo`, which reads a doc's citations against a directory instead of the workspace root.

**To adopt.** From any app, run `pnpm exec sssb guide`; it writes `.claude/sssb-guide.md` at the workspace root.
Commit it, and import it from your own `CLAUDE.md` with a line holding `@.claude/sssb-guide.md`. The guide cites paths
relative to an app (`src/app-config/`, `config/params.ts`), so if your `sssb.docPaths.include` reaches `.claude`, map
the copy to your app in the root `package.json`: `"relativeTo": { ".claude/sssb-guide.md": "apps/<app>" }` inside
`sssb.docPaths`. After each upgrade, run `pnpm exec sssb guide` again and review the diff before you commit it.

**Now deletable.** Rules copied by hand from SSSB's `CLAUDE.md` into your own: the seam, vendor and `process.env`
fences, tenancy, authorization, i18n, migration numbering and the test conventions the guide now states.
