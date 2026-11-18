---
'@sssb/tools': patch
'@sssb/create': patch
---

### `sssb doctor` works from a workspace's root, with no `--app`

**Kind.** scaffold

**Action.** optional

**What changed.** `sssb doctor` with no `--app` failed at the root of a generated workspace ("does not resolve
@sssb/kit"), because that root takes no framework, though the generated files, the guide and the README all tell
people to run `pnpm exec sssb doctor`. Doctor checks the whole workspace from any of its apps, so with no `--app` it now
starts from the working directory when that resolves `@sssb/kit` (an app, as before), and at a workspace root that does
not, from the workspace's first app (`sssb.apps`, else `apps/*`), saying so in its first line. An explicit `--app` is
never replaced. The generated root script is now `sssb:doctor`: `sssb doctor`.

**To adopt.** Nothing is required: the `--app apps/<name>` form still works. In a workspace generated before this,
`"sssb:doctor": "sssb doctor --app apps/<name>"` in the root `package.json` may become `"sssb:doctor": "sssb doctor"`, so
the script, `pnpm exec sssb doctor` and the documentation agree.

**Now deletable.** An `--app` argument you added to `sssb doctor` only to get it to run from the root.
