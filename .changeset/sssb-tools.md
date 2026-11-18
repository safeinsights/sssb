---
'@sssb/tools': minor
---

### `@sssb/tools`: the `sssb` CLI, the presets and the tsconfig base

**Kind.** scaffold

**Action.** required

**What changed.** The repository's scripts became `@sssb/tools`: the `sssb` CLI (`port`, `launch-json`,
`check-demo-size`, `serve-standalone`, `e2e-profile`, `check-tmpdir-leak`, `check-real-env`, `check-doc-paths`,
`guide`, `tick`, `dev-tick`, `ci`), the Next, Vite and Vitest presets, a tsconfig base at the framework's ES2022
floor, and helpers (`@sssb/tools/ports`, `/testing/tmp-dir`, `/ticker-marker`, `/assembly-checks`, `/doc-paths`,
`/kit`). The starter's configs and scripts use them, and the copies under `scripts/` are gone.

**To adopt.** Add `@sssb/tools` to the devDependencies of each app, of the workspace root, and of an `infra` package
that runs the assembly checks. In each app:

- `tsconfig.json`: `"extends": "@sssb/tools/tsconfig.base.json"`, keeping the app's own `paths` and `include`. Its
  `lib` is ES2022; raise it in the app if the app's code needs a newer one.
- `next.config.ts`: `export default withSssb({ typedRoutes: true }, { appDir: __dirname })` from `@sssb/tools/next`,
  in place of `createNextIntlPlugin('…/packages/kit/src/i18n/request.ts')`, `transpilePackages: ['@sssb/kit']`,
  `output`, `serverExternalPackages`, `agentRules` and `experimental.agentUpgrade`.
- `vite.demo.config.ts`: `export default staticDemoConfig({ appDir: __dirname })` from `@sssb/tools/vite`.
- The app's Vitest project: `await appTestProject({ appDir })` from `@sssb/tools/vitest`, in a config whose default
  export is an async function.
- `package.json`: declare the app's port slot, `"sssb": { "port": "starter" }`, and use `next dev --port "$(sssb port)"`,
  `sssb dev-tick <slot> -- next dev …`, `sssb tick <slot>`, `sssb serve-standalone`, `sssb check-real-env` and
  `sssb check-demo-size <bytes>`.
- `playwright.config.ts`: `originFor` from `@sssb/tools/ports` and `assertNoLiveDevTicker` from
  `@sssb/tools/ticker-marker`.
- Tests: `makeTestTmpDir` and `makeTestTmpDirAsync` from `@sssb/tools/testing/tmp-dir`.

At the workspace root, `prepare` runs `sssb launch-json` (the browser pane's configurations become `<app>-dev`), and
`test:unit`, `test:coverage` and `test:contract` run through `sssb check-tmpdir-leak vitest run …`.

**Now deletable.** Copies of SSSB's scripts kept in the app's repository: a ports module and a port-printing script, a
launch-config writer, a demo-size check, a standalone server runner, an e2e profiler, a temp-directory leak wrapper,
a Mantine CSS pruning plugin for Vite, the tick and ticker scripts, and a `dev:real` preflight run through tsx; and,
in each app, the next-intl request path into the framework's source and the Vite aliases for `@sssb/kit` and
`@sssb/app-config`.
