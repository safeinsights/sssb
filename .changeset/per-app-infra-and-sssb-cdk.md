---
'@sssb/cdk': minor
---

### Each app's deployment lives in the app, on the `SssbApp` construct

**Kind.** scaffold

**Action.** required

**What changed.** The root `infra/` is gone. Each app has its own `apps/<app>/infra/` (`app.ts`, `cdk.json`,
`lib/tags.ts`, a `package.json` named `<app>-infra`), and the stack is built by `SssbApp` from the new
`@sssb/cdk` package, a construct composed inside a stack of the app's own. `SssbApp` resolves the migrator from the
app's `@sssb/kit`, passes the app's seam to esbuild explicitly, and fails `cdk synth` unless the server's final
environment is fail-closed and the migrator's bundle carries the app's migrations, among other checks.

**To adopt.** Copy `apps/starter/infra/` into `apps/<your-app>/infra/`, rename its package to `<your-app>-infra`,
and carry over any edits you made to the old root `infra/` (your tags in `lib/tags.ts`; your own constructs beside
`new SssbApp(stack, 'Default', { appDir, slug, params, environment, production })` in `app.ts`). Keep the id
`Default`: it keeps every logical id the old stack had. In `pnpm-workspace.yaml` list `apps/*/infra` instead of
`infra`, ignore `apps/*/infra/cdk.out/`, and run `pnpm --filter './apps/*/infra' --fail-if-no-match synth` where
CI ran the old synth. The workspace root must install `esbuild`; the construct bundles locally.

**Now deletable.** A root `infra/` whose `stack.ts` and `check-shapes.ts` are copies of SSSB's, and any
`init-app` rewrite of paths in them.
