# @sssb/cdk

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

- ### Each app's deployment lives in the app, on the `SssbApp` construct

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

- 1bf4396: ### A production stack keeps its database secret

    **Kind.** operator

    **Action.** optional

    **What changed.** `SssbApp` retained the Aurora cluster, its writer, its subnet group and both buckets when
    `production` is true, but the cluster's generated master secret (`DbSecret…`) kept `DeletionPolicy: Delete` and
    `UpdateReplacePolicy: Delete`. Deleting or replacing a production stack therefore kept the database and deleted the only
    credentials to it. The secret now takes the same policy as the cluster: `Retain` for both in production, `Delete` for
    both otherwise. Its logical id (`DbSecretCF6D79B0`) is unchanged, and the stateful snapshot is too. No KMS key or
    rotation schedule exists to retain beside it: the cluster and the secret use the account's AWS-managed keys, and the
    buckets S3's own.

    **To adopt.** Nothing breaks if you do nothing. Take `@sssb/cdk` and run `cdk diff` against a production stack: the only
    change is the two policy attributes on the secret, which CloudFormation applies without touching the secret, its value
    or the cluster (a policy attribute is not a property, so there is no replacement). A non-production stack's template is
    byte-identical to before. After you take it, deleting a production stack leaves the secret behind with the cluster, as
    it has always left the cluster: delete the secret by hand (Secrets Manager, `aws secretsmanager delete-secret`) when you
    also delete the retained database for good, since a retained secret keeps costing its monthly charge.

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

- 8e5fd17: ### A dashed slug names a database Aurora accepts

    **Kind.** none

    **Action.** none

    **What changed.** `SssbApp` names the app's database from its slug with each dash as an underscore (`acme-corp`
    becomes `acme_corp`): the cluster's default database, the server's `DATABASE_NAME` or `DATABASE_URL`, and the
    migrator's `DATABASE_NAME`, which the framework's migrate handler now prefers to the secret's `dbname` on `pg`. Aurora
    PostgreSQL's database names allow no dash, so an app with a dashed slug synthesized and then failed at deploy. A slug
    with no dash names the same database as before, so no existing deployment's database changes. A slug whose name the
    engine reserves (`user`, `select`) or that runs past 63 characters is refused at synth.
    `databaseNameFor(slug)`, exported from `@sssb/cdk`, gives the same name to infra that does not use the construct.

- ### The VPC's `Name` tags change in place on the first deploy on `SssbApp`

    **Kind.** operator

    **Action.** optional

    **What changed.** With the stack's resources now inside the `SssbApp` construct (id `Default`), every logical id is
    unchanged, but CDK's `Name` tag on the VPC, its subnets, route tables, gateways and elastic IP now carries the
    construct path (`<Stack>/Default/Vpc…` instead of `<Stack>/Vpc…`). The first deploy updates those tags in place;
    nothing is replaced.

    **To adopt.** Before that deploy, point anything that finds these resources by their `Name` tag (a
    `Vpc.fromLookup` by `Name`, a cost report, a script) at the new value, `<Stack>/Default/Vpc…`. A deployment that
    nothing looks up by tag needs no change.

- Updated dependencies [03a2ae1]
- Updated dependencies [dca7aa4]
- Updated dependencies [7cd28e2]
- Updated dependencies [e574680]
- Updated dependencies [846d11d]
- Updated dependencies [835e887]
- Updated dependencies [7a1c762]
- Updated dependencies [3dd44f2]
- Updated dependencies [362056f]
- Updated dependencies [38bf6d3]
- Updated dependencies [daa8637]
- Updated dependencies [df41bde]
- Updated dependencies
- Updated dependencies [ff2c4d8]
    - @sssb/tools@0.2.0

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

### Patch Changes

- @sssb/tools@0.2.0-rc.2

## 0.2.0-rc.1

### Patch Changes

- Updated dependencies [7a1c762]
- Updated dependencies [3dd44f2]
    - @sssb/tools@0.2.0-rc.1

## 0.2.0-rc.0

### Minor Changes

- ### Each app's deployment lives in the app, on the `SssbApp` construct

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

- 8e5fd17: ### A dashed slug names a database Aurora accepts

    **Kind.** none

    **Action.** none

    **What changed.** `SssbApp` names the app's database from its slug with each dash as an underscore (`acme-corp`
    becomes `acme_corp`): the cluster's default database, the server's `DATABASE_NAME` or `DATABASE_URL`, and the
    migrator's `DATABASE_NAME`, which the framework's migrate handler now prefers to the secret's `dbname` on `pg`. Aurora
    PostgreSQL's database names allow no dash, so an app with a dashed slug synthesized and then failed at deploy. A slug
    with no dash names the same database as before, so no existing deployment's database changes. A slug whose name the
    engine reserves (`user`, `select`) or that runs past 63 characters is refused at synth.
    `databaseNameFor(slug)`, exported from `@sssb/cdk`, gives the same name to infra that does not use the construct.

- ### The VPC's `Name` tags change in place on the first deploy on `SssbApp`

    **Kind.** operator

    **Action.** optional

    **What changed.** With the stack's resources now inside the `SssbApp` construct (id `Default`), every logical id is
    unchanged, but CDK's `Name` tag on the VPC, its subnets, route tables, gateways and elastic IP now carries the
    construct path (`<Stack>/Default/Vpc…` instead of `<Stack>/Vpc…`). The first deploy updates those tags in place;
    nothing is replaced.

    **To adopt.** Before that deploy, point anything that finds these resources by their `Name` tag (a
    `Vpc.fromLookup` by `Name`, a cost report, a script) at the new value, `<Stack>/Default/Vpc…`. A deployment that
    nothing looks up by tag needs no change.

- Updated dependencies [e574680]
- Updated dependencies [846d11d]
- Updated dependencies [835e887]
- Updated dependencies [362056f]
- Updated dependencies [38bf6d3]
- Updated dependencies [daa8637]
- Updated dependencies [df41bde]
- Updated dependencies
- Updated dependencies [ff2c4d8]
    - @sssb/tools@0.2.0-rc.0
