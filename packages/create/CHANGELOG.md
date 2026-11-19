# @sssb/create

## 0.2.0

### Minor Changes

- ddadf65: ### `@sssb/tools` is a peer of `@sssb/cdk`, so tarballs install with no `overrides`

    **Kind.** scaffold

    **Action.** required

    **What changed.** `@sssb/cdk` takes `@sssb/tools` as a peer at its own version instead of depending on it, so no SSSB
    package depends on another. A release candidate's tarballs now install by URL as the notes say with pnpm 11's default
    `blockExoticSubdeps` on and no `overrides`: before, the notes' `overrides` made pnpm refuse `@sssb/tools` as an exotic
    subdependency (`ERR_PNPM_EXOTIC_SUBDEP`), and without them pnpm looked for it on npm. The release notes' install
    lines and `pnpm create @sssb --sssb <dir>` no longer write `overrides`, and the starter's `infra/package.json` declares
    `@sssb/tools` beside `@sssb/cdk`. `SssbApp` refuses to synth beside an `@sssb/tools` that is not its own version
    (pnpm only warns about a peer at another version).

    **To adopt.** In every package that depends on `@sssb/cdk` (each app's `infra/package.json`), add `@sssb/tools` at the
    same release (the same tarball URL, or `file:` path, as your other packages use for it). Then delete the `@sssb/*`
    entries from `overrides` in `pnpm-workspace.yaml` (the whole block if nothing else is in it) and any
    `blockExoticSubdeps: false` you set for SSSB's tarballs, run `pnpm install`, and commit the lockfile.

    **Now deletable.** A `blockExoticSubdeps: false` setting kept only for SSSB's tarballs, and `overrides` that map
    `@sssb/*` packages to their tarballs.

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

### Patch Changes

- 471e150: ### A generated workspace's README links SSSB's adoption guide, and the generated app stops calling itself a template

    **Kind.** none

    **Action.** none

    **What changed.** The `README.md` that `@sssb/create` writes now links SSSB's adoption guide (`docs/adopting.md`) and
    its reference app, both at the commit the workspace pins, says why the app sits under `apps/`, names the `UPDATE-ME`
    tags in `infra/lib/tags.ts` to replace before a deploy (they were `TEMPLATE-UPDATE-ME`), and points its "Upgrading
    SSSB" section at each release's "Upgrading to this release" commands and the guide's "Upgrading by release". The next steps the generator prints end by saying that
    `pnpm dev` runs the app. The generated app's welcome subtitle and comments no longer call it a template. The app
    guide says where to read its two worked examples, the first migration and the items route, once you have removed
    them, and the `scheduled-tick` cutover row no longer mentions two example apps.

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

- 79b0e06: ### `@sssb/create`: a new app workspace in one command

    **Kind.** scaffold

    **Action.** optional

    **What changed.** `pnpm create @sssb <dir>` (`npm create @sssb <dir> -- …`) writes a new SSSB app workspace: the
    starter under `apps/<slug>/`, its `infra/` included, renamed to the app's slug and display name; the workspace's
    config on SSSB's presets (Vitest, the tsconfig base, the ESLint plugin) with its own knip, jscpd, gitleaks, Prettier,
    commitlint and husky setup; the seam a workspace package (`<slug>-app-config`) the app takes as `@sssb/app-config`, with an
    `exports` map covering every seam module the framework imports; `allowBuilds`, `dedupePeerDependents: false` and `sssb.apps`; the owner files from `--repo` and
    `--owner`; `docs/cutover-checklist.md` with the framework's rows; `.claude/sssb-guide.md`, the app guide as `sssb guide` writes
    it; and `.github/workflows/checks.yml`, which calls SSSB's reusable workflow pinned to a commit. Its `pnpm verify` runs
    what that CI runs, but the secret scan. `--sssb <dir>` depends on packed tarballs instead of published versions.
    The starter's comments and one static-demo test title no longer name SSSB's showcase, "the starter", paths into
    SSSB's `spikes/`, build notes or decision log, or the framework's paths in SSSB's repository unqualified, so they read
    true in the generated workspace. They still cite SSSB's ADRs by number.

    **To adopt.** Nothing for an existing workspace; the starter's reworded comments are yours to take or leave. A new
    one starts with `pnpm create @sssb <dir> --repo <owner/name> --owner <@handle>`, then `git init`, `pnpm install` and
    `pnpm verify`, and requires the check `sssb / all-checks` on its default branch.

- 80e311a: ### The starter typechecks its `infra/`

    **Kind.** scaffold

    **Action.** optional

    **What changed.** The starter's `infra/` has a `tsconfig.json` of its own (it extends the app's, takes Node's types
    and includes `infra/**/*.ts`), and the app's `typecheck` script runs it after the app's own program:
    `next typegen && tsc --noEmit && tsc --noEmit -p infra`. The deployment's code was checked only by `synth` before; it
    stays out of the app's program, so `next build` does not typecheck the CDK's declarations.

    **To adopt.** Copy the starter's `infra/tsconfig.json` into each `apps/<app>/infra/`, and append
    `&& tsc --noEmit -p infra` to each app's `typecheck` script. A workspace whose root `typecheck` fans out over
    `apps/*` reaches it with no other change.

## 0.2.0-rc.2

### Minor Changes

- ddadf65: ### `@sssb/tools` is a peer of `@sssb/cdk`, so tarballs install with no `overrides`

    **Kind.** scaffold

    **Action.** required

    **What changed.** `@sssb/cdk` takes `@sssb/tools` as a peer at its own version instead of depending on it, so no SSSB
    package depends on another. A release candidate's tarballs now install by URL as the notes say with pnpm 11's default
    `blockExoticSubdeps` on and no `overrides`: before, the notes' `overrides` made pnpm refuse `@sssb/tools` as an exotic
    subdependency (`ERR_PNPM_EXOTIC_SUBDEP`), and without them pnpm looked for it on npm. The release notes' install
    lines and `pnpm create @sssb --sssb <dir>` no longer write `overrides`, and the starter's `infra/package.json` declares
    `@sssb/tools` beside `@sssb/cdk`. `SssbApp` refuses to synth beside an `@sssb/tools` that is not its own version
    (pnpm only warns about a peer at another version).

    **To adopt.** In every package that depends on `@sssb/cdk` (each app's `infra/package.json`), add `@sssb/tools` at the
    same release (the same tarball URL, or `file:` path, as your other packages use for it). Then delete the `@sssb/*`
    entries from `overrides` in `pnpm-workspace.yaml` (the whole block if nothing else is in it) and any
    `blockExoticSubdeps: false` you set for SSSB's tarballs, run `pnpm install`, and commit the lockfile.

    **Now deletable.** A `blockExoticSubdeps: false` setting kept only for SSSB's tarballs, and `overrides` that map
    `@sssb/*` packages to their tarballs.

## 0.2.0-rc.1

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

- 79b0e06: ### `@sssb/create`: a new app workspace in one command

    **Kind.** scaffold

    **Action.** optional

    **What changed.** `pnpm create @sssb <dir>` (`npm create @sssb <dir> -- …`) writes a new SSSB app workspace: the
    starter under `apps/<slug>/`, its `infra/` included, renamed to the app's slug and display name; the workspace's
    config on SSSB's presets (Vitest, the tsconfig base, the ESLint plugin) with its own knip, jscpd, gitleaks, Prettier,
    commitlint and husky setup; the seam a workspace package (`<slug>-app-config`) the app takes as `@sssb/app-config`, with an
    `exports` map covering every seam module the framework imports; `allowBuilds`, `dedupePeerDependents: false` and `sssb.apps`; the owner files from `--repo` and
    `--owner`; `docs/cutover-checklist.md` with the framework's rows; `.claude/sssb-guide.md`, the app guide as `sssb guide` writes
    it; and `.github/workflows/checks.yml`, which calls SSSB's reusable workflow pinned to a commit. Its `pnpm verify` runs
    what that CI runs, but the secret scan. `--sssb <dir>` depends on packed tarballs instead of published versions.
    The starter's comments and one static-demo test title no longer name SSSB's showcase, "the starter", paths into
    SSSB's `spikes/`, build notes or decision log, or the framework's paths in SSSB's repository unqualified, so they read
    true in the generated workspace. They still cite SSSB's ADRs by number.

    **To adopt.** Nothing for an existing workspace; the starter's reworded comments are yours to take or leave. A new
    one starts with `pnpm create @sssb <dir> --repo <owner/name> --owner <@handle>`, then `git init`, `pnpm install` and
    `pnpm verify`, and requires the check `sssb / all-checks` on its default branch.

- 80e311a: ### The starter typechecks its `infra/`

    **Kind.** scaffold

    **Action.** optional

    **What changed.** The starter's `infra/` has a `tsconfig.json` of its own (it extends the app's, takes Node's types
    and includes `infra/**/*.ts`), and the app's `typecheck` script runs it after the app's own program:
    `next typegen && tsc --noEmit && tsc --noEmit -p infra`. The deployment's code was checked only by `synth` before; it
    stays out of the app's program, so `next build` does not typecheck the CDK's declarations.

    **To adopt.** Copy the starter's `infra/tsconfig.json` into each `apps/<app>/infra/`, and append
    `&& tsc --noEmit -p infra` to each app's `typecheck` script. A workspace whose root `typecheck` fans out over
    `apps/*` reaches it with no other change.
