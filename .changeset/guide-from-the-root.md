---
'@sssb/tools': patch
---

### `sssb guide` works from a workspace's root, with no `--app`

**Kind.** none

**Action.** none

**What changed.** `sssb guide` with no `--app` failed at the root of a generated workspace ("does not resolve
@sssb/kit"), because that root takes no framework, though the generated `README.md` and `CLAUDE.md` tell people to run
`pnpm exec sssb guide` without saying from where. As `sssb doctor` already does, it now uses the working directory
when that resolves `@sssb/kit` (an app, as before), and at a workspace root that does not, the workspace's first app
(`sssb.apps`, else `apps/*`), saying so. The copy is written to the workspace root's `.claude/sssb-guide.md` either
way. An explicit `--app` is never replaced, and on a release before this one `--app apps/<name>` is what works from
the root.
