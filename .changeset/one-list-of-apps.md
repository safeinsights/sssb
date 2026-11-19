---
'@sssb/tools': patch
'@sssb/create': patch
---

### The root's Vitest configs read `sssb.apps`, and `sssb doctor` reports a knip config gap

**Kind.** scaffold

**Action.** optional

**What changed.** `@sssb/tools/vitest` exports `workspaceAppProjects({ root, options? })`: an `appTestProject` for each
app the root package.json's `sssb.apps` names (else every `apps/<name>`), in that order, with `options(appDir)` passed
to each. The two Vitest configs `@sssb/create` writes call it instead of keeping an `APPS` list, so `sssb.apps` is the
one list of a workspace's apps. `sssb doctor` reports (never fails) an app, or an app's seam package, that the root's
knip config (`knip.json`, `knip.jsonc`, `.knip.json` or `.knip.jsonc`) gives no workspace of its own, and a root
`@sssb/create` that knip would call unused.

**To adopt.** Optional: a workspace that keeps its `APPS` lists keeps working, and `sssb doctor` still fails a config
that stops running an app's conformance suite. To read `sssb.apps` instead, in `vitest.config.ts`:

```ts
import { workspaceAppProjects } from '@sssb/tools/vitest'

// in place of: projects: await Promise.all(APPS.map((app) => appTestProject({ appDir: at(`./apps/${app}`) })))
projects: await workspaceAppProjects({ root: at('.') }),
```

and in `vitest.contract.config.ts`, the same projects narrowed to the contract tests:

```ts
projects: (await workspaceAppProjects({ root: at('.') })).map((project) => ({
    ...project,
    test: { ...project.test, environment: 'node', include: ['tests/contract/**/*.test.ts'] },
})),
```

then delete the `APPS` constant from both. Options an app's project took (`env`, `alias`, `testTimeout`) go in
`options: (appDir) => ({ … })`.

**Now deletable.** An `APPS` list in a root Vitest config that repeats the apps `sssb.apps` already names.
