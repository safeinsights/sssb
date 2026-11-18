# @sssb/tools

## 0.2.0-rc.2

No changes in this release.

## 0.2.0-rc.1

### Minor Changes

- 3dd44f2: ### `sssb doctor` requires pnpm's default `nodeLinker`, and never hangs on a Vitest listing

    **Kind.** seam

    **Action.** required

    **What changed.** `sssb doctor` now fails first, and checks nothing else, when pnpm installed the workspace with a
    `nodeLinker` other than `isolated` (pnpm's default): `pnp` or `hoisted`, set in `pnpm-workspace.yaml`, a
    `pnpm_config_node_linker` environment variable or a `--config.node-linker` flag. It fails the same way while
    Plug'n'Play's `.pnp.cjs` is left at the workspace root, which `pnpm run` keeps loading after the setting is gone. SSSB
    gives each app its own `@sssb/kit` linked to its own seam, which `hoisted` cannot (one copy serves every app); under
    `pnp`, `pnpm run` resolves through Plug'n'Play's `.pnp.cjs`, where Vitest's listing never finishes. Before, under `pnp`
    doctor passed when run directly and hung when run as `pnpm sssb:doctor`; under `hoisted` it failed without naming the
    cause. Separately, each `vitest list` doctor runs is stopped after 120 seconds, with every process it started (on macOS
    and Linux; on Windows only Vitest's own process), and reported as a problem, and once one listing runs out of time
    doctor does not wait on the rest; `SSSB_DOCTOR_VITEST_TIMEOUT` (seconds) changes the limit.

    **To adopt.** If `pnpm sssb:doctor` reports the installed layout, remove `nodeLinker` from `pnpm-workspace.yaml`, delete
    `.pnp.cjs` at the workspace root if it is there, run `pnpm install`, and run doctor again. Nothing to do on pnpm's
    default layout.

### Patch Changes

- 7a1c762: ### `sssb doctor` works from a workspace's root, with no `--app`

    **Kind.** scaffold

    **Action.** optional

    **What changed.** `sssb doctor` with no `--app` failed at the root of a generated workspace ("does not resolve
    @sssb/kit"), because that root takes no framework, though the generated files, the README among them, tell
    people to run `pnpm exec sssb doctor`. Doctor checks the whole workspace from any of its apps, so with no `--app` it now
    starts from the working directory when that resolves `@sssb/kit` (an app, as before), and at a workspace root that does
    not, from the workspace's first app (`sssb.apps`, else `apps/*`), saying so in its first line. An explicit `--app` is
    never replaced. The generated root script is now `sssb:doctor`: `sssb doctor`.

    **To adopt.** Nothing is required: the `--app apps/<name>` form still works. In a workspace generated before this,
    `"sssb:doctor": "sssb doctor --app apps/<name>"` in the root `package.json` may become `"sssb:doctor": "sssb doctor"`, so
    the script, `pnpm exec sssb doctor` and the documentation agree.

    **Now deletable.** An `--app` argument you added to `sssb doctor` only to get it to run from the root.

## 0.2.0-rc.0

### Minor Changes

- e574680: ### The app guide ships in `@sssb/kit`

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

- 835e887: ### The conformance suite, `sssb doctor` and `sssb check-e2e`

    **Kind.** seam

    **Action.** required

    **What changed.** The framework's checks that must hold for every app now ship as a suite the app calls from its own
    tree: `@sssb/kit/testing` (the authorization scan of the app's routes, i18n partition and parity, the pglite RLS
    proofs, migration order, demo presets, the seam map) and `@sssb/kit/testing/contract` (the same proofs on real
    Postgres as a non-superuser owner and as a superuser, and over the RDS Data API through its emulator). The kit no
    longer ships its seam-conformance test files. `sssb doctor`, one run for every app of the workspace, fails unless
    each singleton peer has one copy, every importer of `@sssb/kit` links its own seam, the `@sssb/*` packages share one
    version, the Vitest config a bare `vitest` would load for each app runs every unit check, and some config runs every
    contract check. It reports, without failing, any other Vitest config that runs an app's tests without the checks, a
    bare `vitest` from an app's directory that would not run its suite when the root's run is the main one, the narrowing
    flags the package.json scripts pass to vitest, and which script runs each contract config, since it cannot
    see what CI runs. Playwright specs may reach the framework only through `@sssb/kit/testing/e2e`, which ships compiled
    and seam-free, and `sssb check-e2e`, asking Playwright which files each config loads, fails a spec that reaches any
    other framework file.

    **To adopt.** In each app:

    - Add `src/sssb.conformance.test.ts` holding
      `conformanceSuite({ appDir: path.resolve(import.meta.dirname, '..'), optOut: {} })`, with `conformanceSuite` from
      `@sssb/kit/testing`. A check is left out only by name, with a reason: `optOut: { '<check id>': '<why>' }`; the ids
      are in `@sssb/kit/testing/checks.json`.
    - Make `tests/contract/rls-contract.test.ts` call `contractSuite({ port: portFor('contractPg'), optOut: {} })`, with
      `contractSuite` from `@sssb/kit/testing/contract` and `portFor` from `@sssb/tools/ports`, and add
      `embedded-postgres` to the app's devDependencies for local runs (CI can set `CONTRACT_DATABASE_URL` instead). Keep
      `test:contract` in CI: doctor proves the contract checks would run, not that CI runs them.
    - An authorization exemption of the app's own goes in `authz-exemptions.mjs` at the app's root, each entry with a
      `reason` and a `mustMatch` gate; one that matches no mutating route in the app, overlaps a framework entry, or is a prefix
      nested in another of the app's prefixes, fails.
    - In Playwright specs, import webhook-signature helpers from `@sssb/kit/testing/e2e`, not `@sssb/kit/core/…`, and
      read app constants from modules that import nothing from SSSB but types.
    - Run `sssb doctor` (once, from the workspace root) and `sssb check-e2e` (in each app) in verify and in CI, and read
      doctor's reports: if CI runs a Vitest config other than the one doctor holds to the checks, they do not run there.

    **Now deletable.** A Vitest `include` that reaches the framework's test files under `node_modules`, with the default
    `exclude` overridden to let them run; a copied real-Postgres contract harness (a `defineContractSuite` and its server
    helper); and a hand-run `readlink -f` comparison of the app's and the framework's React, Next or Mantine copies.

- 38bf6d3: ### SSSB's CI checks as a reusable workflow an app's CI calls

    **Kind.** scaffold

    **Action.** optional

    **What changed.** `.github/workflows/app-checks.yml` in `safeinsights/sssb` runs SSSB's checks for an app workspace:
    lint, typecheck and unit tests with `sssb check-fences` and `sssb check-e2e` in each app and one `sssb doctor` run, the
    contract tests on a Postgres service, the e2e
    shards, each app's static demo, an optional CDK synth, and `all-checks`, which fails unless every one of them ran and
    passed. Each step is a `pnpm exec sssb ci <job>` command, and `sssb ci` gains the jobs it runs (`lint-typecheck-unit`,
    `contract`, `matrix`, `synth`) and an `--apps` list.

    **To adopt.** In the app's own workflow, beside its own jobs and triggers, add a job

    ```yaml
    sssb:
        uses: safeinsights/sssb/.github/workflows/app-checks.yml@<full commit SHA>
        permissions:
            contents: read
        with:
            synth: ./apps/console/infra
    ```

    never with `secrets: inherit`, and require the check `sssb / all-checks`. The workspace root needs `@sssb/tools` and
    the scripts `lint`, `typecheck`, `test:unit` (or `test:coverage`) and `test:contract`; each app needs a Playwright
    config, a `test:e2e` script (and a `chromium` project beside a `destructive` one) and the scripts `build:demo-static`,
    `check:demo-size` and `e2e:demo-static`. The organization must allow public reusable workflows, and the repository's
    Actions settings must allow them.

    **Now deletable.** A copy of SSSB's `checks.yml` jobs in the app's workflow: the contract job with its Postgres
    service, the e2e shard discovery and matrix, the static-demo job, and the infra synth step.

- daa8637: ### The seam is a workspace package, so `pnpm add` keeps it linked

    **Kind.** seam

    **Action.** required

    **What changed.** An app's seam declared as `"@sssb/app-config": "link:./src/app-config"` is unlinked from the app's
    `@sssb/kit` by the next partial install for the app, `pnpm add <pkg>`, `pnpm remove <pkg>` or `pnpm update <pkg>`,
    whether run from the root with `--filter` or in the app's directory: `sssb doctor` then fails ("runs on a seam not its
    own") and typecheck fails inside the kit, and `pnpm install` does not bring it back. The seam is now a workspace
    package with a name of its own, which the app takes under the name the framework imports, and pnpm keeps that linked.
    `sssb doctor` fails an app that still declares its seam as a `link:`, even while it is linked, and says what to
    change; it also fails an app whose declared seam is another app's, and one whose `workspace:` seam names no workspace
    package, or more than one (an adopter who skips step 1 sees this).
    The conformance suite's `seam-map` check holds the seam's `package.json` to the name the app declares it by. A
    workspace `pnpm create @sssb` writes has the new form, and the plugin's commands say `pnpm --filter <app> add <pkg>`
    again.

    **To adopt.** For each app (`apps/<app>`, whose `package.json` name is `<name>`):

    1. In `pnpm-workspace.yaml`, add the seams to `packages`: `- apps/*/src/app-config`, or each app's
       `apps/<app>/src/app-config`.
    2. In `apps/<app>/src/app-config/package.json`, change `"name": "@sssb/app-config"` to `"name": "<name>-app-config"`
       (any name no other package of the workspace has; leave `exports` and `type` as they are).
    3. In `apps/<app>/package.json`, change `"@sssb/app-config": "link:./src/app-config"` to
       `"@sssb/app-config": "workspace:<name>-app-config@*"`.
    4. Run `pnpm install` and commit `pnpm-lock.yaml`, then `pnpm sssb:doctor` (or
       `pnpm exec sssb doctor --app apps/<app>`). This also repairs a seam a
       `pnpm add` already unlinked; no clean install is needed.
    5. If your `knip.json` lists `src/app-config/**` among an app's entries, knip now counts those files as the seam's own
       workspace: move them to `"apps/<app>/src/app-config": { "entry": ["**/*.ts"] }`.

    **Now deletable.** Any rule or note telling authors to edit `package.json` by hand instead of running `pnpm add`, to
    restore `pnpm-lock.yaml` after one, or to delete every `node_modules` and the lockfile to relink the seam.

- df41bde: ### `sssb check-fences`: the fences as the app's config composes them

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

- ### `@sssb/tools`: the `sssb` CLI, the presets and the tsconfig base

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

### Patch Changes

- 846d11d: ### Linear-time trims, and complete escaping

    **Kind.** none

    **Action.** none

    **What changed.** Trims that used regexes taking time quadratic in a long run of one character now use loops or an
    index, with the same results: the doc-path engine (`@sssb/tools/doc-paths`, `sssb check-doc-paths`) on trailing
    slashes, quotes and `,;)`; `sssb doctor` on trailing slashes in `pnpm-workspace.yaml` globs; `@sssb/create` on a git
    remote's trailing slashes; and `@sssb/eslint-plugin`'s package-edge rule on a specifier's `?query` or `#hash`.
    `contractDatabaseName` (`@sssb/kit/testing`) trims its underscores by a loop too. `sssb doctor` still fills only the
    first `*` of a tsconfig `paths` target, as TypeScript's resolver does, without `String#replace`. The app preset of
    `@sssb/eslint-plugin` also escapes a backslash when it turns a name into a glob; no app can reach that case today (an
    app directory whose name holds a backslash cannot load its `lint-exceptions.mjs`, the only place the name is used).

- 362056f: ### The plugin enabled at the workflow's commit, and `sssb doctor` reporting both pins

    **Kind.** scaffold

    **Action.** optional

    **What changed.** `@sssb/kit` names the commit it was released from in `dist/release.json`, and `sssb doctor` reports
    (never fails) when the commit your `.github/workflows/*.yml` pins SSSB's reusable workflow at, or the one your
    `.claude/settings.json` pins SSSB's plugin marketplace at, is not that commit, naming both, and when no plugin is
    enabled from that marketplace (naming the ones that are). A workspace
    `pnpm create @sssb` writes now has a `.claude/settings.json` that declares SSSB's marketplace (`sssb`) pinned to the
    workflow's commit and enables its plugin (`sssb@sssb`: the app-author commands as `/sssb:<command>`, and the
    `doc-steward` agent), and a `CLAUDE.md` that imports `.claude/sssb-guide.md`.

    **To adopt.** In an existing workspace, write `.claude/settings.json`:
    `{ "extraKnownMarketplaces": { "sssb": { "source": { "source": "github", "repo": "safeinsights/sssb", "ref": "<the
commit your workflow pins>" } } }, "enabledPlugins": { "sssb@sssb": true } }`. A commit `ref` needs Claude Code 2.1.324
    or later. Each person runs `claude plugin install sssb@sssb --scope project` once per clone, after trusting the folder.
    Keep a line holding `@.claude/sssb-guide.md` in your `CLAUDE.md`. On each upgrade, raise the marketplace's `ref` with
    the workflow's pin.

    **Now deletable.** Copies of SSSB's app-author commands and `doc-steward` agent kept in your own `.claude/commands/`
    and `.claude/agents/`.

- ff2c4d8: ### `@sssb/tools/testing/tmp-dir` cleans up every file under `isolate: false`

    **Kind.** seam

    **Action.** optional

    **What changed.** With Vitest's `isolate: false`, `makeTestTmpDir` and `makeTestTmpDirAsync` removed only the first
    test file's scratch directories in each worker, so `sssb check-tmpdir-leak` failed for every later file that made
    one. A new setup module, `@sssb/tools/testing/tmp-dir-setup`, registers each file's cleanup before the file's code, so
    every file's directories are removed after the file's own `afterAll` hooks. `appTestProject` from
    `@sssb/tools/vitest` adds it to the app's `setupFiles`. Without it, the helper removes every file's directories except each worker's last file's, and says once that the setup module is missing. A new `removeTestTmpDir(dir)` removes one directory
    the helper made, and its marker, at once.

    **To adopt.** Nothing, for an app project built with `appTestProject`. Any other Vitest project that sets
    `isolate: false` adds `'@sssb/tools/testing/tmp-dir-setup'` to its `test.setupFiles`.
