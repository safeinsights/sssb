# @sssb/tools

## 0.7.0

No changes in this release.

## 0.6.1

No changes in this release.

## 0.6.0

No changes in this release.

## 0.5.0

### Minor Changes

- 9d56c29: ### Lint fences and `sssb` checks that let a form through

    **Kind.** seam

    **Action.** required

    **What changed.**

    - A new app-side fence, `sssb/no-path-into-kit`, in the preset and in `sssb check-fences`' probes. An import,
      `import()`, `require` or type import that reaches `@sssb/kit` by a path into the package
      (`../node_modules/@sssb/kit/src/...`, an absolute path, a `file:` URL, the app's `@/` alias, a symbolic link), or any path through `node_modules`, fails
      lint. The kit ships its source, so such a path reached any internal past the exports map. A stylesheet or worker
      imported as `../node_modules/<package>/...` gets the same finding: import it by the package's name.
    - An app's `sssb.vendors` entry must be a package name (`stripe`, `@stripe/stripe-js`) or one subpath of it
      (`firebase/app`), either followed by `/*`, or a whole scope (`@stripe/*`), in lower case. Any other gitignore
      pattern (`@stripe/**`, `stripe-*`, `stripe/`) banned an import declaration and let `import()` through; it now fails
      the lint config, naming the entry. `sssb check-fences` lints a probe per entry through both vendor rules.
    - The import fences match a bare specifier cut at a resource query or hash too (`pg?raw`), and read more forms of a
      specifier: a template literal, a type `import('...')`, `import x = require(...)`, Vitest's `vi.mock` and
      `vi.importActual` family, `require.resolve`. A vendor or a path into the kit written one of those ways now fails
      lint where it passed.
    - `sssb check-e2e` fails a spec, or a module it imports, that names an `@sssb/kit` subpath as a string esbuild
      cannot follow (a plain `require` of a variable, say), not only beside `createRequire`. An object key, a type, and a
      kit `.md` or `.json` file named in code pass.
    - `sssb ci lint-typecheck-unit` holds doctor to every app it fans out over, as a bare `sssb doctor` does.
    - `secretGrantProblems` and `dataApiShapeProblems` (`@sssb/tools/assembly-checks`) read grants from
      `AWS::IAM::RolePolicy`, `UserPolicy` and `GroupPolicy`, from users' and groups' inline and AWS-managed policies,
      and from a Secrets Manager resource policy on the cluster's secret, and fail any other `AWS::IAM::*` type that
      could carry a grant. A `?` in a granted resource is a wildcard. A stack built on `SssbApp` alone is unaffected.

    **To adopt.** Run `pnpm lint` and `pnpm verify`. Import the framework by a published `@sssb/kit/...` subpath and any
    package by its name. Rewrite a `sssb.vendors` entry the lint config refuses in one of the accepted shapes. If your
    own infra fails an assembly check, the message names the resource that grants too much.

### Patch Changes

- 9d56c29: ### Deployment and tooling fixes from the 0.4.0 baseline review

    **Kind.** operator

    **Action.** optional

    **What changed.**

    - The CodeBuild jobs runner passes the job's org to the build as `JOB_ORG_ID` (empty for none). Job payloads go to
      CodeBuild as plaintext, readable in its console and in CloudTrail: never put a secret or personal data in one.
    - The PostHog adapter's `capture` waits for the event to be sent, for at most two seconds, so an event is not lost
      when a Lambda freezes after its response. A slow or failed send is logged, never thrown.
    - Mailgun inbound: a token is remembered until its signature goes stale, which closes a replay window when the
      sender's clock runs ahead. The new `forgetMailgunToken` (`@sssb/kit/service-auth/mailgun`) lets a route forget a
      token whose handler failed, so the provider's retry is processed.
    - The migrator encodes the database name in its connection URL. Migration 0015's role error says SSSB.
    - Data API transport: a date before year 1 or after 9999 is accepted; an array of a type node-postgres has no
      parser for (an `enum[]`) comes back as Postgres text, as on `pg`; a string constant continued on the next line is
      read as one string.
    - `parseDbKeysetCursor` answers `invalid` for a cursor at year 0000, which the database cannot hold, so the route's 400 replaces a 500. A failed webhook enqueue after a job status commits
      is logged and no longer fails the caller. An outbound webhook's response body is cancelled once its status is read.
    - A relative `APP_DATA_DIR` works: fake storage refused every key under one. A fake analytics flag named like an `Object.prototype` member
      answers its default.
    - In a linked git worktree anywhere (a `.git` file that points into `worktrees/`), not only under
      `.claude/worktrees/`, an app's ports are derived per checkout; a checkout that is itself a worktree of a bare
      repository now gets derived ports too. `pnpm exec sssb port` prints them. Ladle's derived ports start at 61001.
    - `createTicker(...).stop()` resolves to the ticker's status, as its type said. `sssb serve-standalone` forwards
      SIGINT, SIGTERM and SIGHUP to the server and fails when the server dies on a signal.
    - The static demo: notification emails escape their copy; a held job's webhook goes to the job's own org; an actor
      completing a job emits what the server emits; Exit during a tour step stays exited; reset reseeds schedules from
      the world clock.

    **To adopt.** Nothing is required. A CodeBuild buildspec can read `JOB_ORG_ID`. An inbound-email route can call
    `forgetMailgunToken(token)` when its handler throws or answers a 5xx, as SSSB's reference app does.

## 0.4.0

### Patch Changes

- a6e849e: ### The reusable workflow takes a `docs-only` fast path

    **Kind.** scaffold

    **Action.** optional

    **What changed.** SSSB's reusable workflow (`.github/workflows/app-checks.yml`) takes a boolean input, `docs-only`,
    false by default. With `true`, the `contract`, `e2e`, `demo-static` and `synth` jobs still run and report success
    under their usual names, but run only a step saying they skipped, and `contract` starts no Postgres. Lint, typecheck,
    the unit tests, `discover` and `all-checks` are unchanged. A caller that does not set it runs exactly what it did.

    **To adopt.** Nothing, to keep the full run on every pull request. To skip the expensive jobs on a change your own CI
    has judged harmless (one that touches only documentation, say), pass `docs-only:` as an expression your workflow
    computes, after raising the workflow pin to this release, e.g. `docs-only: ${{ needs.changes.outputs.docs-only == 'true' }}`. Compute it
    against the pull request's merge commit, never let a failed computation read as `true`, and never set it on a push to
    your default branch.

## 0.3.0

### Minor Changes

- e214c18: ### Machine callers send their credential in its own header, which CloudFront passes through

    **Kind.** operator

    **Action.** optional

    **What changed.** `withWebhookSecret` (`@sssb/kit/service-auth/webhook`) reads the shared secret from
    `x-sssb-webhook-secret`, and `verifyServiceCaller` (`@sssb/kit/service-auth/verify`) reads a service token from
    `x-sssb-service-token`, each exported as a constant (`WEBHOOK_SECRET_HEADER`, `SERVICE_TOKEN_HEADER`). The header wins
    when present; `Authorization: Bearer …` is still accepted when it is absent. The reason: `SssbApp`'s CloudFront signs
    every request it passes to the server's Function URL, and its signature replaces the `Authorization` header, so a
    credential sent there through the public host never reached the route and every such call answered 401. `pnpm tick`
    and `SssbApp`'s scheduled tick send the new header.

    **To adopt.** Every caller of your webhook and service routes that goes through your deployment's public host (a
    scheduler, a build's completion callback, a service) sends `x-sssb-webhook-secret: <secret>` or
    `x-sssb-service-token: <jwt>` instead of `Authorization: Bearer …`. A caller that reaches the server another way may
    keep `Authorization`, but the header works everywhere.

    **Now deletable.** A workaround that delivered a webhook secret or service token around CloudFront because
    `Authorization` never arrived.

### Patch Changes

- b28bc3b: ### SSSB's adoption guide is short, with a reference beside it

    **Kind.** none

    **Action.** none

    **What changed.** SSSB's `docs/adopting.md` is now a short guide in the order you act: generate, first boot, take out
    the starter's content, a first entity, deploy and cut over, upgrade by release. Everything else it held is in
    `docs/adopting-reference.md`. `sssb remove-items`, when it refuses, now points at the reference's "To remove the Items
    slice" for the steps by hand. A new workspace's `README.md` links both, the guide's "Upgrading by release" for
    the steps and the reference's "Upgrading, step by step" for why each is there.

- 641ddba: ### `sssb doctor` reports your own GitHub settings and plugin install

    **Kind.** none

    **Action.** none

    **What changed.** `sssb doctor` now also reports, without ever failing or changing anything, the settings only you can
    make. When `gh` is signed in: whether `sssb / all-checks` is a required check on your repository's default branch (a
    ruleset or branch protection), whether private vulnerability reporting is on, and, for a private repository in an
    organization, whether its Actions policy lets it call SSSB's reusable workflow. Locally: whether the Claude Code plugin
    your `.claude/settings.json` enables is installed (`claude plugin install <plugin> --scope project`). It makes
    read-only GitHub requests through `gh`; a `gh` that is missing, signed out or offline, or a setting your account may not
    read, gives "not checked" and the reason. None of it runs when `CI` is set.

    **To adopt.** Nothing to do. After you upgrade, a local `pnpm exec sssb doctor` prints up to four more lines (`github:`
    and `claude plugin:`), each `ok`, or `report` with what to change: the report never changes the exit code. Run
    `gh auth login` first if you want the GitHub lines; in CI doctor prints one line saying it skipped them.

- 3dc7b50: ### A generated app's port slot is its own, so it never says `starter`

    **Kind.** scaffold

    **Action.** optional

    **What changed.** `pnpm create @sssb` now gives the app a port slot named for its slug, at port 3700:
    `"sssb": { "port": { "name": "<slug>", "default": 3700 } }`, or `sssb-app` for a slug a slot cannot be named for. Its
    override is `<SLUG>_PORT`. The app's `dev` and `tick` scripts (`sssb dev-tick`, `sssb tick`) and its
    `playwright.config.ts` (`originForApp(__dirname)`) name no slot and read the declaration. Before, the app declared
    SSSB's built-in `starter` slot (port 3100, `STARTER_PORT`) and named it in all three. The app guide's example now shows
    a slot of the app's own. The generated README, `CLAUDE.md` and CI workflow name `pnpm exec sssb pin` where they say to
    raise SSSB's pins. In `@sssb/tools`, `sssb tick`'s usage and `sssb port`'s refusal of an app with no declaration
    lead with the app's own slot rather than SSSB's built-in ones.

    **To adopt.** Nothing is required: `"sssb": { "port": "starter" }` keeps working, on the same port. To give your app a
    slot of its own, as a new workspace's has:

    ```json
    "sssb": { "port": { "name": "<your app>", "default": 3700 } }
    ```

    in the app's `package.json` (any port from 1024 to 49151 outside SSSB's own: 3000, 3100, 3200-3599, 5439-5639,
    20000-29999, 61000-61199). Then, in its scripts, `sssb dev-tick starter -- …` becomes `sssb dev-tick -- …` and
    `sssb tick starter` becomes `sssb tick`; in `playwright.config.ts`, `originFor('starter')` becomes
    `originForApp(__dirname)`, imported from `@sssb/tools/ports`. The app's local port then moves to the default you chose,
    and its override from `STARTER_PORT` to `<YOUR_APP>_PORT`. A second app in the workspace must not take the same port.
    Refresh the app guide's copy as after any upgrade (`pnpm exec sssb guide`).

    **Now deletable.** A `starter` in an app's scripts and Playwright config, once the app declares a slot of its own.

- b6a652f: ### The root's Vitest configs read `sssb.apps`, and `sssb doctor` reports a knip config gap

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

- b6a652f: ### `sssb add-app <slug>` writes a second app into your workspace

    **Kind.** none

    **Action.** none

    **What changed.** `pnpm exec sssb add-app <slug>` writes a new app under `apps/<slug>/` from SSSB's starter, renamed as
    `pnpm create @sssb` renames your first app (its slug, session cookie, package names, seam package and display name,
    `--name "<Name>"`), taking each `@sssb` package as your first app takes it, on a port slot of its own (named for the
    slug, its default the first free one from 3700 up; `--slot <name>` and `--port <port>` choose them), with scripts and a
    Playwright config that read that slot, and names it in the root's `sssb.apps`. It prints what is left to you: the
    root's `dev`, `tick` and `start` scripts and the CI workflow's `synth`, which name one app on purpose. The starter comes
    from the `@sssb/create` installed at the workspace root, which exports the code as `@sssb/create/add-app`; no SSSB
    package depends on another, so the command says how to install it when it is missing.

    **To adopt.** Nothing to do. For a second app: `pnpm add -D -w @sssb/create@<your @sssb version>`, then
    `pnpm exec sssb add-app <slug>`, `pnpm install` and `pnpm exec sssb doctor`, which names anything the workspace still
    needs (a Vitest config that keeps its own list of apps, the new app's `knip.json` entries, a root `@sssb/create` knip
    would call unused: remove it once your apps are written). `pnpm jscpd` fails while the new app is still the starter;
    make the apps your own, or ignore `apps/<slug>/src/**` in `.jscpd.json` until you have.

- 1780691: ### `sssb pin` raises both of your pins to the release commit

    **Kind.** none

    **Action.** none

    **What changed.** A new command, `pnpm exec sssb pin`, reads the release commit the installed `@sssb/kit` records
    (`dist/release.json`) and writes it into your two pins on SSSB's repository: the reusable workflow's `uses:` line in
    `.github/workflows/*.yml` and the `ref` of the plugin marketplace in `.claude/settings.json`. It prints each pin it
    changed and the commit it replaced, changes nothing in a pin that is already current, and edits only that text, so the
    formatting of both files is kept; a version in the `uses:` line's comment (`# @sssb/create 0.2.0`, `# v0.2.0`) moves
    with it, and a comment of your own stays. It refuses, writing nothing, when there is no commit to read (SSSB's own
    repository, or a kit packed by hand) or a file is not the shape it edits: no workflow calls SSSB's reusable workflow,
    or `.claude/settings.json` is not JSON or declares no marketplace from SSSB's repository. A workspace with no
    `.claude/settings.json` has the workflow pin raised alone. "Upgrading to this release" in the notes and `sssb doctor`'s
    report of a pin that differs now name it.

    **To adopt.** Nothing is required. At your next upgrade, after you install the new packages, run `pnpm exec sssb pin` in place of
    editing the `uses:` line and the marketplace's `ref` by hand, read the diff of the two files, and commit it with the
    package versions. Each person then runs `claude plugin marketplace update sssb` and
    `claude plugin update sssb@sssb --scope project`, as before.

    **Now deletable.** Nothing in your code. The two hand edits the release notes asked of you on every upgrade, and any
    script of your own that copies the release commit into those two files.

- 9940da2: ### `sssb remove-items` takes the starter's Items slice out in one step

    **Kind.** scaffold

    **Action.** optional

    **What changed.** The first thing every adopter does is take out the starter's example Items slice by hand, over about fifteen files. `pnpm exec sssb remove-items` does it: the card, the route, the query, the ability, the `items` catalog namespace, the dashboard's glue and the static demo's card, the specs that name it, and the paging proofs; the Simulator's e2e spec stays, so the app still has one for `sssb check-e2e`. The migrations are the one thing it will not guess at. A database records each migration it runs, and the migrator refuses to start when a recorded one is gone from the code, so without `--drop-migrations` the command leaves `1001_items`, `1002_items_keyset_index`, `ItemsTable` and the `items` RLS proofs registered; with it, they go too, and the app is left with `AppSubjectType = never`, an empty `appMigrations`, an empty proofs body and `AppTables = Record<never, never>`. `--dry-run` lists what it would do. It computes every edit first and refuses, naming each file and changing nothing, when one is not what the starter wrote. The starter's proxy test now uses `/projects` for its sample paths, so nothing is left to name Items. The generated README now points at it, and `@sssb/tools` ships the two diffs it applies (`src/remove-items/*.patch`).

    **To adopt.** Nothing, if your app already removed Items. In a workspace you have just generated, run `pnpm exec sssb remove-items --dry-run --drop-migrations`, then without `--dry-run`, delete `apps/<app>/.data`, and number your first table `1001_<name>`. Where a database has already run the migrations, run it without `--drop-migrations`. An app that edited the Items files or has its own migrations after `1002` is refused by design: finish by hand from SSSB's `docs/adopting-reference.md`, "To remove the Items slice".

    **Now deletable.** A hand sweep over the Items slice's files.

## 0.2.0

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

- 03a2ae1: ### An app can declare a port slot of its own, and `sssb doctor` fails two apps on one slot

    **Kind.** seam

    **Action.** optional

    **What changed.** A workspace with two apps made from the starter had both on the `starter` slot, so both dev servers
    bound one port, and under Playwright's `reuseExistingServer` the second app's e2e run adopted the first app's server and
    tested the wrong app. An app now declares a slot of its own in its `package.json`, beside the string form, which works
    as before: `"sssb": { "port": { "name": "ledger", "default": 3700 } }`. The name is lowercase words joined by `-`; the
    default is an integer from 1024 to 49151 that no SSSB service's port holds (3000, 3100, 3200-3599, 5439-5639,
    20000-29999, 61000-61199). The override is `LEDGER_PORT` (`<NAME>_PORT`, `-` as `_`), and a linked worktree derives the
    port from 20000-29999, keyed on the name as well as the checkout. `sssb port`, `sssb tick`, `sssb dev-tick`,
    `sssb serve-standalone` and `sssb launch-json` read the declaration; `originForApp(__dirname)` from
    `@sssb/tools/ports` reads it for a Playwright config, and `originFor()` and `portFor()` called with no argument read it from the app
    the working directory is in. `sssb doctor` now fails an invalid
    declaration, two apps on one slot, and two slots with one default.

    **To adopt.** A workspace with one app needs nothing. A workspace with a second app declares its slot in that app's
    `package.json` (above) in place of `"port": "starter"`, and in the app: its `playwright.config.ts` calls `originForApp(__dirname)`
    instead of `originFor('starter')`, its `dev` script is `sssb dev-tick -- next dev …` (no `starter`
    before the `--`) and a `tick` script is `sssb tick` (no `starter`; the commands refuse `starter` and `showcase` in an
    app that declares a slot of its own, rather than quietly use the other app's port), and a contract test's `portFor('contractPg')` stays.
    Run `pnpm exec sssb doctor`: it fails while two apps share a slot.

    **Now deletable.** A hand-set `STARTER_PORT` or a `--port` literal in the second app's scripts that kept its dev server
    off the first app's port.

- dca7aa4: ### `sssb guide` works from a workspace's root, with no `--app`

    **Kind.** none

    **Action.** none

    **What changed.** `sssb guide` with no `--app` failed at the root of a generated workspace ("does not resolve
    @sssb/kit"), because that root takes no framework, though the generated `README.md` and `CLAUDE.md` tell people to run
    `pnpm exec sssb guide` without saying from where. As `sssb doctor` already does, it now uses the working directory
    when that resolves `@sssb/kit` (an app, as before), and at a workspace root that does not, the workspace's first app
    (`sssb.apps`, else `apps/*`), saying so. The copy is written to the workspace root's `.claude/sssb-guide.md` either
    way. An explicit `--app` is never replaced, and on a release before this one `--app apps/<name>` is what works from
    the root.

- 7cd28e2: ### SSSB's packages are on npm, and a release is a plain version

    **Kind.** scaffold

    **Action.** optional

    **What changed.** `@sssb/kit`, `@sssb/tools`, `@sssb/eslint-plugin`, `@sssb/cdk` and `@sssb/create` are public, and
    SSSB's release flow publishes them to npm with provenance at one version. Release candidates (`-rc.N` tarballs on a
    GitHub prerelease) end here: this release's notes carry every change since the first candidate, and later releases are
    plain `0.x.y` versions on npm only. `pnpm create @sssb` now fetches the generator from npm, and the workspace it writes
    depends on each package at `^` its version.

    **To adopt.** In each workspace package that depends on an `@sssb/*` package by a release-candidate tarball URL (or a
    `file:` path), replace the URL with the version, and drop any `overrides` you kept for them:

    ```json
    {
        "@sssb/kit": "^0.2.0",
        "@sssb/tools": "^0.2.0"
    }
    ```

    Then `pnpm install`, commit the lockfile, and run `pnpm exec sssb doctor`: it reports a workflow or plugin marketplace
    pin that is not this release's commit, and you move each pin it names. Staying on a candidate's tarballs keeps working,
    but no later release ships as tarballs.

    **Now deletable.** Tarball URLs copied from a prerelease's notes, the `sha512` checks made against them, and any
    `overrides` or `file:` paths that pointed `@sssb/*` at a downloaded tarball.

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
