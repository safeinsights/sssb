# @sssb/create

## 0.7.0

### Minor Changes

- 8909e3c: ### `withPortErrors` answers a database that is unavailable for now with a 503

    **Kind.** scaffold

    **Action.** optional

    **What changed.** The starter's `src/app/api/respond.ts` maps `DatabaseUnavailableError` to a 503 with `Retry-After`,
    instead of rethrowing it as a 500.

    **To adopt.** In your `withPortErrors`, before the final `throw error`, importing `DatabaseUnavailableError` from
    `@sssb/kit/ports/errors`:

    ```ts
    if (error instanceof DatabaseUnavailableError) {
        console.warn(`database unavailable (${error.reason}): ${error.message}`)
        return Response.json(
            { error: 'database-unavailable', reason: error.reason },
            { status: 503, headers: { 'retry-after': String(error.retryAfterSeconds) } },
        )
    }
    ```

## 0.6.1

### Patch Changes

- 7990d2d: ### The starter's sign-in page tells a refused person why, and its sign-out takes JSON only

    **Kind.** scaffold

    **Action.** optional

    **What changed.**

    - `src/app/[locale]/signin/page.tsx` asks the auth port whether the signed-in person is refused. If they are, it shows
      the refused-account screen instead of the sign-in form: `RealAccountRefused` in real mode, and a new
      `refused-glue.tsx` in simulated mode.
    - `src/app/api/auth/signout/route.ts` now refuses a request that is not JSON (`refuseNonJson`, 415). A page on a sibling
      subdomain, which the browser sends the session cookie with, could otherwise sign a person out with no click. The
      header's sign-out and the new glue send `content-type: application/json`.
    - `page.test.tsx` and `route.test.ts` pin both.

    **To adopt.** Copy the sign-in page's refusal branch if you run a single tenancy. Copy the sign-out route's
    `refuseNonJson` check, and the JSON header on every caller of that route, whatever your settings.

## 0.6.0

### Minor Changes

- a92c52a: ### A job kind can opt out of completion notifications

    **Kind.** seam

    **Action.** optional

    **What changed.** Every app job kind notified its team's admins when a job ended, on every runner (the simulated one, the in-process one and its sweep, and the CodeBuild webhook), which for a kind a schedule runs every hour is a notification, a `listMembers` call and an email attempt a day for nothing. The seam's `jobs` module may now export `jobNotify`, saying per kind when its end is notified: `'always'` (today's behaviour, and the default), `'failure'` (only a failed job, a lost one the sweep fails included) or `'never'`. A run a kind refuses makes no `listMembers` call, no in-app notification and no email attempt, on every runner. The static demo's `useDemoWorld` takes the same map as its `jobNotify` option. `JobNotify` is a type of `@sssb/kit/core/jobs`. The app guide and `/sssb:new-job` say so.

    **To adopt.** Nothing, unless you want it: an app with no `jobNotify` export behaves as before. To silence a routine kind, export the map from `src/app-config/jobs.ts`:

    ```ts
    import type { JobNotify } from '@sssb/kit/core/jobs'

    export const jobNotify: Partial<Record<AppJobKind, JobNotify>> = {
        'sweep-items': 'failure',
    }
    ```

    If the static demo starts that kind, pass the same map to `useDemoWorld({ jobNotify })`, from a module both import (the seam's `jobs` module imports every server handler, which the demo's bundle cannot carry).

    **Now deletable.** A local patch or filter that keeps a routine job's end from notifying (an edited kind allowlist, a wrapper around `notifyJobTerminal`).

- 91ecfc0: ### A job records who started it, and its end reaches them when the team has no admin

    **Kind.** migration

    **Action.** optional

    **What changed.** Framework migration `0017_job_requester` adds a nullable `requested_by` column to `jobs`.
    `submitJob` (`@sssb/kit/db/jobs`) takes an optional `requestedBy`, the submitting person's user id. A job's end still
    notifies its team's active admins; when the team has none, it now notifies the person who submitted it, while the auth
    port still gives them standing in the org. A fixed org source (`AUTH_ORG_SOURCE=fixed`) lists no members, so there a
    job's end reaches only its requester. SSSB's rules let neither of that source's roles submit a `Job`, so such a job is
    one the app's own rules let the person start. A job submitted without `requestedBy`, a scheduled run among them, still
    reaches no one when the team has no admin.

    The app guide and `/sssb:new-job` say so.

    **To adopt.** Run your migrations, as every release asks. Pass `requestedBy: user.id` to `submitJob` wherever a person
    submits a job:

    ```ts
    await submitJob(db, jobs, { tenantId, orgId, kind, payload, requestedBy: user.id })
    ```

### Patch Changes

- e93d7ed: ### Shipped comments describe no particular adopter

    **Kind.** none

    **Action.** none

    **What changed.** Two comments in shipped source, one in the CDK construct and one in the generator's template, now speak of adopters in general. No behaviour changes.

- dd8e783: ### The starter declares its auth settings, and authorizes its reads

    **Kind.** scaffold

    **Action.** optional

    **What changed.**

    - The starter's `config/params.ts` has an `auth` entry, `tenancy: 'multi'` and `orgSource: 'provider'`. Its comment
      says what `'single'` and `'fixed'` do, and what a shared identity provider means for them.
    - Its items GET (`src/app/api/items/route.ts`) now authorizes the read, with `authorize(…, 'read', …)` on the `Item`
      subject, as its writes always did. So a person placed in the org without standing (the role `none`) reads nothing
      there. `src/app/api/items/route.test.ts` pins it: a restricted member reads, and `none` is refused.

    **To adopt.** Add the same `auth` entry to your own `config/params.ts` if you want the choices written down; leaving it
    out keeps the defaults. Add the same `authorize(…, 'read', …)` call to each of your own org-scoped reads. That matters
    before you turn a fixed org source on: the entry "A `none` role, and reads that authorize" says why.

## 0.5.0

### Patch Changes

- 9d56c29: ### The plugin's commands describe the Simulator a generated app has

    **Kind.** none

    **Action.** none

    **What changed.** The plugin's commands no longer say a generated app has no Simulator on `pnpm dev`. Since 0.3.0 it
    has SSSB's host there, with the People, Mail and Jobs tabs; it has no Hooks, Snapshots or Tours tab and takes no
    app-registered tab (Actors), which remain the static demo's or a reference-style glue of your own. Raise the plugin
    pin with the release.

- 9d56c29: ### Starter and generated-workflow fixes to apply by hand

    **Kind.** scaffold

    **Action.** optional

    **What changed.** A workspace generated from this release has these; an existing one applies them by hand, reading
    each file in SSSB's repository at this release (`apps/starter`).

    - `src/app/[locale]/signin/page.tsx` and `signin/picker-glue.tsx` take their `returnTo` through `sameOriginPath`
      (the entry "`sameOriginPath` is published"): the old check was an open redirect. The picker glue's `onPick` also
      returns its fetch and resolves `false` on a refusal, which needs this release's `PeoplePicker`.
    - `src/proxy.ts`: the matcher's excluded prefixes end at a slash (`api(?:/|$)`, `_next/`, `_vercel/`) and the API
      branch matches `/api` or `/api/...`, so a page named like `/apiary` reaches the proxy and the auth provider's
      middleware.
    - `src/app/api/respond.ts` gains `readJsonObject` and `refuseNonJson`. `POST /api/items` and `POST /api/auth/org`
      answer 400, not 500, on a body that is not a JSON object or a field of the wrong type, and `POST /api/auth/org`
      answers 401 to a signed-out caller before it reads the body. `POST /api/auth/dev-signin` (simulated mode only)
      answers 415 to a request that is not `application/json`, so another site's page cannot sign a developer in, and
      400 to a body that is not a JSON object or whose `personId` is not a non-empty string.
    - The Items card keeps the typed title and shows `items.addError` (new, in both catalogs) when a create fails. It
      takes three files: `src/components/items-card.tsx`, the message key, and
      `src/app/[locale]/(protected)/dashboard/dashboard-glue.tsx`, whose `onAdd` must reject on a response that is not
      ok; without that the card still clears the draft.
    - `playwright.demo.config.ts` forbids `test.only` on CI.
    - The generated `.github/workflows/checks.yml`: its secret-scan job checks the gitleaks download's sha256 before
      running it, and its own checkouts set `persist-credentials: false`. SSSB's reusable workflow (`app-checks.yml`)
      does the same on every job, which reaches a workspace when it raises its workflow pin; its jobs take no steps of
      yours, so nothing of yours loses the token.

    **To adopt.** Copy the changed lines from the named files. For the secret scan, copy the download, `sha256sum -c -`
    and `tar -xzf` lines from SSSB's `.github/workflows/checks.yml`. `sssb remove-items` still takes the Items slice out
    of an app generated from this release.

## 0.4.0

### Patch Changes

- 3867cc8: ### The starter declares that it stores no files

    **Kind.** scaffold

    **Action.** optional

    **What changed.** The starter's `config/params.ts` `ports` entry has `storage: 'none'`, since the starter stores no
    files. A workspace generated from now on deploys with no storage bucket and needs no `STORAGE_BUCKET`.

    **To adopt.** Add `storage` to the `ports` in your own `config/params.ts`: `'s3'` if your app stores files, else
    `'none'` (the entry "An app that stores no files needs no S3 bucket" says what each does to a deployed stack).

- 99fb466: ### The starter's layout mounts the auth provider in real mode

    **Kind.** none

    **Action.** none

    **What changed.** The starter's `src/app/[locale]/layout.tsx` rendered SSSB's real sign-in form without the provider
    its hooks need, so real-mode sign-in in a generated app failed to render. It now mounts `RealAuthProviders` in real
    mode, loaded with `import()` so that simulated mode and `pnpm dev` load none of it.

    **To adopt.** The entry "The conformance suite checks that real-mode sign-in has its provider" gives the change to
    make in your own layout, and its check tells you whether you need it.

## 0.3.0

### Minor Changes

- 474eec5: ### A generated app's proxy runs through `withAuthProxy`

    **Kind.** scaffold

    **Action.** required

    **What changed.** The starter's `src/proxy.ts` wraps its locale routing in `withAuthProxy` from
    `@sssb/kit/adapters/proxy`, and its matcher now also sends it every `/api` route (passed through untouched), so real
    mode's sign-in works in a generated app. A new `src/proxy.test.ts` checks which paths reach the proxy and what it does
    with a page and an API route.

    **To adopt.** Make your `src/proxy.ts` the one the kit changeset "Real-mode sign-in: `withAuthProxy` runs Clerk's
    middleware around your proxy" shows, and copy the starter's `src/proxy.test.ts` if you want the gate.

### Patch Changes

- b28bc3b: ### SSSB's adoption guide is short, with a reference beside it

    **Kind.** none

    **Action.** none

    **What changed.** SSSB's `docs/adopting.md` is now a short guide in the order you act: generate, first boot, take out
    the starter's content, a first entity, deploy and cut over, upgrade by release. Everything else it held is in
    `docs/adopting-reference.md`. `sssb remove-items`, when it refuses, now points at the reference's "To remove the Items
    slice" for the steps by hand. A new workspace's `README.md` links both, the guide's "Upgrading by release" for
    the steps and the reference's "Upgrading, step by step" for why each is there.

- 667eae6: ### The generated workspace installs without the eslint 10 peer warning

    **Kind.** scaffold

    **Action.** optional

    **What changed.** The first `pnpm install` of a generated workspace printed "Issues with peer dependencies found", because `eslint-plugin-react` and `eslint-plugin-jsx-a11y`, which `@sssb/eslint-plugin`'s preset loads, declare eslint 9 as their highest peer while the preset and the workspace run eslint 10. No release of either lists eslint 10 yet. The generated `pnpm-workspace.yaml` now carries a `peerDependencyRules.allowedVersions` entry for exactly those two plugins, with a comment that says why and when to delete it.

    **To adopt.** Nothing breaks if you do nothing; the warning is the only symptom. To silence it in an existing workspace, add this to `pnpm-workspace.yaml`, then delete it once `pnpm peers check` shows both plugins declare eslint 10:

    ```yaml
    peerDependencyRules:
        allowedVersions:
            'eslint-plugin-react>eslint': '10'
            'eslint-plugin-jsx-a11y>eslint': '10'
    ```

    **Now deletable.** Nothing.

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

- 9940da2: ### `sssb remove-items` takes the starter's Items slice out in one step

    **Kind.** scaffold

    **Action.** optional

    **What changed.** The first thing every adopter does is take out the starter's example Items slice by hand, over about fifteen files. `pnpm exec sssb remove-items` does it: the card, the route, the query, the ability, the `items` catalog namespace, the dashboard's glue and the static demo's card, the specs that name it, and the paging proofs; the Simulator's e2e spec stays, so the app still has one for `sssb check-e2e`. The migrations are the one thing it will not guess at. A database records each migration it runs, and the migrator refuses to start when a recorded one is gone from the code, so without `--drop-migrations` the command leaves `1001_items`, `1002_items_keyset_index`, `ItemsTable` and the `items` RLS proofs registered; with it, they go too, and the app is left with `AppSubjectType = never`, an empty `appMigrations`, an empty proofs body and `AppTables = Record<never, never>`. `--dry-run` lists what it would do. It computes every edit first and refuses, naming each file and changing nothing, when one is not what the starter wrote. The starter's proxy test now uses `/projects` for its sample paths, so nothing is left to name Items. The generated README now points at it, and `@sssb/tools` ships the two diffs it applies (`src/remove-items/*.patch`).

    **To adopt.** Nothing, if your app already removed Items. In a workspace you have just generated, run `pnpm exec sssb remove-items --dry-run --drop-migrations`, then without `--dry-run`, delete `apps/<app>/.data`, and number your first table `1001_<name>`. Where a database has already run the migrations, run it without `--drop-migrations`. An app that edited the Items files or has its own migrations after `1002` is refused by design: finish by hand from SSSB's `docs/adopting-reference.md`, "To remove the Items slice".

    **Now deletable.** A hand sweep over the Items slice's files.

- fca2628: ### The starter declares the optional ports it uses

    **Kind.** scaffold

    **Action.** optional

    **What changed.** The starter's `config/params.ts` has a `ports` entry: `llm: 'none'`, `email: 'mailgun'`,
    `inboundEmail: 'none'` and `jobs: 'in-process'`, since the starter makes no model call, has no inbound email route and
    no jobs webhook route. A workspace generated from now on deploys without an Anthropic key, an inbound signing key or a
    CodeBuild project.

    **To adopt.** Copy the `ports` entry into your own `config/params.ts`, beside `database`, and set each port to what
    your app uses (the entry "Real mode requires only the optional ports your app uses" lists the values).

- 667eae6: ### The starter's items list pages, as the app guide requires

    **Kind.** scaffold

    **Action.** optional

    **What changed.** The starter's `GET /api/items` returned every row, which broke the guide's rule that a list that can grow pages through `@sssb/kit/db/keyset` and made the example an adopter copies the wrong one. It now answers one page: it parses `?cursor=` with `parseDbKeysetCursor` and answers 400 `{ "error": "invalid-cursor" }` when it is `invalid`, clamps `?limit=` on the server, and orders by the primitive's fixed `created_at`, `id`, newest first. The response gains `nextCursor`. The query moves to `src/domain/db/items.ts` (`listItems`), migration `1002_items_keyset_index` adds the index the walk needs, the items card shows "Show older items" while a next page exists, and `src/app-config/db/rls-proofs.ts` proves a cursor from another team or tenant cannot widen a page.

    **To adopt.** Nothing breaks if you do nothing; a route that never reads a cursor still works. To page a list of your own, copy the pattern: the route in `src/app/api/items/route.ts`, the query in `src/domain/db/items.ts`, the index migration (a separate migration for a table that already exists, or the index in the create migration for a new one), and the proofs at the end of `src/app-config/db/rls-proofs.ts`. The card and the dashboard glue show the "load more" side.

    **Now deletable.** A hand-rolled `LIMIT`/`OFFSET` or an unbounded `.execute()` behind a list route.

- c650c05: ### A generated app has the Simulator on its own `pnpm dev`

    **Kind.** scaffold

    **Action.** optional

    **What changed.** The starter mounts SSSB's Simulator server host with `src/app/api/simulator/[...path]/route.ts` and renders the panel from `src/app/[locale]/layout.tsx` in simulated mode, so a generated app's `pnpm dev` (and its simulated builds) has the People, Mail and Jobs tabs, the world clock included. Until now the panel was only in its static demo. A new e2e spec, `tests/e2e/simulator.spec.ts`, signs in through the panel and opens its tabs.

    **To adopt.** Copy the route file and the `SimulatorChrome` component and its use from the starter's `src/app/[locale]/layout.tsx` (the kit changeset "The Simulator's People, Mail and Jobs tabs on an app's own `pnpm dev`" shows both), and the spec if you want the gate.

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
