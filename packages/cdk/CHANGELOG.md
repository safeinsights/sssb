# @sssb/cdk

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
