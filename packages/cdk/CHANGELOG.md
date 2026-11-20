# @sssb/cdk

## 0.6.0

### Patch Changes

- dd8e783: ### `SssbApp` sets the auth settings from `params.auth`

    **Kind.** operator

    **Action.** optional

    **What changed.** `SssbApp` reads an optional `params.auth`, the `AuthTenancyParams` type, and sets the server's
    `AUTH_TENANCY`, `AUTH_TENANT_SLUG`, `AUTH_TENANT_METADATA_KEY`, `AUTH_ORG_SOURCE`, `AUTH_HOME_ORG_SLUG` and
    `AUTH_DEFAULT_ROLE` from it. It validates them at synth: an unknown key or choice, a malformed slug, a choice without its
    slug, a slug or role its choice does not use, a fixed org source without a single tenancy, or a default role other than
    `'none'` or `'restricted'` fails `cdk synth`.
    Left out, it sets nothing, and the framework keeps its defaults.

    **To adopt.** For one tenant per deployment, add `auth: { tenancy: 'single', tenantSlug }` to the params your infra
    passes to `SssbApp`. For an identity provider used without organizations, add `orgSource: 'fixed', homeOrgSlug` to that (and
    `defaultRole: 'restricted'` if not `'none'`). The entry "Two auth settings: where the tenant comes from, and where orgs
    come from" says what each does.

- e93d7ed: ### Shipped comments describe no particular adopter

    **Kind.** none

    **Action.** none

    **What changed.** Two comments in shipped source, one in the CDK construct and one in the generator's template, now speak of adopters in general. No behaviour changes.

- @sssb/tools@0.6.0

## 0.5.0

### Patch Changes

- Updated dependencies [9d56c29]
- Updated dependencies [9d56c29]
    - @sssb/tools@0.5.0

## 0.4.0

### Minor Changes

- 3867cc8: ### An app that stores no files needs no S3 bucket

    **Kind.** operator

    **Action.** required

    **What changed.** The storage port is one of SSSB's optional ports, with the switch `STORAGE_PROVIDER` (`s3` or
    `none`). With `none` the port is absent: real mode no longer requires `STORAGE_BUCKET`, never loads the S3 SDK, and a
    call through the port (or a job handler's) throws an error naming the switch. `AWS_REGION` is now required only by
    what calls AWS: storage on `s3`, `JOBS_RUNNER=codebuild` and `DATABASE_TRANSPORT=data-api`. An unset switch is `s3`, so
    a deployment that sets nothing requires exactly what it did. `SssbApp` sets the switch from `params.ports.storage`, and
    with `none` builds no storage bucket, sets no `STORAGE_BUCKET` and grants the server no S3 access; with `s3` or left
    out, the bucket keeps its logical id. `SssbApp`'s `storageBucket` is therefore `Bucket | undefined`.
    `required-env.json` lists `STORAGE_PROVIDER`'s choices, and `AWS_REGION` under `JOBS_RUNNER`'s `codebuild`.

    **To adopt.** Add `storage` to the `ports` in `apps/<app>/config/params.ts`: `'s3'` if your app stores files
    (uploads, attachments, job artifacts), else `'none'`. Infra code that reads `app.storageBucket` handles `undefined`
    (TypeScript now says where). Before switching a deployed stack to `none`, copy out what its bucket holds: a
    `production: true` deployment retains the bucket outside the stack, and any other deletes it with its objects. A
    deployment that does not use `SssbApp` sets `STORAGE_PROVIDER` itself.

    **Now deletable.** A placeholder `STORAGE_BUCKET`, and a bucket created only so that real mode would start.

- 587112b: ### Object storage on any S3-compatible store: `STORAGE_PROVIDER=s3-compatible`

    **Kind.** operator

    **Action.** optional

    **What changed.** The storage port has a third choice beside `s3` and `none`: `s3-compatible`, for Cloudflare R2, MinIO
    and Backblaze B2, through the same S3 adapter. It is a choice of its own, never inferred from `s3` reading an endpoint.
    It requires `STORAGE_BUCKET`, `STORAGE_ENDPOINT`, `STORAGE_REGION`, `STORAGE_ACCESS_KEY_ID`,
    `STORAGE_SECRET_ACCESS_KEY` and `STORAGE_UPLOAD_TARGET` (`post` if the store accepts a presigned POST, which
    `createUploadTarget` is, or `none` if it does not, as Cloudflare documents for R2: `createUploadTarget` then fails with
    an error that names the setting, and every other method works), and fails at boot naming each one missing. It reads
    `STORAGE_FORCE_PATH_STYLE` (`true` or `false`) when set, which MinIO needs. It does not use `AWS_REGION` or the AWS
    key pair, which Lambda reserves. `SssbApp` accepts `params.ports.storage: 's3-compatible'`, builds no storage bucket
    and grants no S3 access for it. `required-env.json` lists the choice, so this is a `minor`; an app that keeps `s3`,
    `none` or no choice requires exactly what it did and keeps its bucket's logical id. Three cutover rows are new:
    `storage-compatible-store`, `storage-compatible-credentials` and `storage-compatible-live`.

    **To adopt.** Nothing, unless you want it. To use R2, MinIO or B2: set `ports: { storage: 's3-compatible' }` in
    `apps/<app>/config/params.ts`, add the six settings to the server's environment from your infra (`app.server`; the
    key pair kept out of the repository), and work the three cutover rows. Switching a deployed stack from `s3` takes its bucket
    out of the stack (retained in production, deleted elsewhere), as `none` does: copy the objects first. A store without
    presigned POST cannot take a browser upload through `createUploadTarget` yet.

    **Now deletable.** A hand-written storage adapter, or a copy of `createS3Storage` with an endpoint, that only pointed
    SSSB's storage port at another S3-compatible store.

### Patch Changes

- Updated dependencies [a6e849e]
    - @sssb/tools@0.4.0

## 0.3.0

### Minor Changes

- 5165838: ### `SssbApp` takes request bodies through CloudFront, and pins the server's `HOSTNAME`

    **Kind.** operator

    **Action.** required

    **What changed.** A deployed app answered 403 to every `POST`, `PUT` and `PATCH`: its Function URL sits behind
    CloudFront's origin access control, and Lambda refuses a request there whose body hash (`x-amz-content-sha256`) is
    missing, which CloudFront never adds. `SssbApp` now runs a Lambda@Edge function on the default behavior's origin
    request that sets that hash from the body, so request bodies up to 1 MB reach the server, and a larger one answers 413.
    The server's environment also sets `HOSTNAME=0.0.0.0`, where Next's standalone server listens: with `127.0.0.1`,
    requests through the auth provider's proxy fail. Lambda@Edge lives in us-east-1 only, so an environment-agnostic stack
    now deploys to us-east-1 only (elsewhere CloudFront refuses the function and the deploy rolls back), and a stack with
    an explicit region outside us-east-1 gets the function in a second stack in us-east-1, `edge-<region>-…`, carrying the
    stack's tags.

    **To adopt.** Upgrade and run `cdk diff`. It shows, for the stack: a new `BodyHash` function with its role and a
    version, the distribution's default behavior gaining a `LambdaFunctionAssociations` entry (`origin-request`,
    `IncludeBody`), and `HOSTNAME` added to the `Server` function's environment; no stateful resource changes. A stack with
    an explicit region outside us-east-1 also gets a cross-region reader custom resource, and a new stack in us-east-1:
    run `cdk bootstrap aws://<account>/us-east-1` first. `cdk deploy` with no stack name then refuses (the app has two
    stacks): name your stack, which deploys the us-east-1 one first, or pass `--all`; `--exclusively` skips it. An
    environment-agnostic stack deployed outside us-east-1 must take an explicit `env` before upgrading. A teardown can now
    fail on the edge function while CloudFront drops its replicas (up to a few hours): delete the stack again then. Leave
    `HOSTNAME` out of your deploy pipeline's `run.sh`.

    **Now deletable.** A Lambda@Edge function of your own that sets `x-amz-content-sha256` on the distribution's default
    behavior, with its role and the escape-hatch override (`LambdaFunctionAssociations`) that attaches it: keeping the
    override replaces `SssbApp`'s association with yours. An `export HOSTNAME=0.0.0.0` in your `run.sh`.

- e70d0d7: ### `SssbApp` sends HSTS and safe security headers

    **Kind.** operator

    **Action.** required

    **What changed.** The three behaviors `SssbApp` builds (the app's pages, `/_next/static/*` and `/assets/*`) now carry
    AWS's managed SecurityHeadersPolicy:

    - `Strict-Transport-Security: max-age=31536000`;
    - `X-Content-Type-Options: nosniff`;
    - `Referrer-Policy: strict-origin-when-cross-origin`;
    - `X-Frame-Options: SAMEORIGIN`;
    - the legacy `X-XSS-Protection: 1; mode=block`.

    Each yields to a header your app sends itself, except nosniff, which is always sent. A managed policy takes none of
    your account's 20 custom response headers policies.

    `hstsIncludeSubdomains: true` adds `includeSubDomains` to HSTS. It builds a custom policy with the same headers (one of
    the 20). Pass `responseHeadersPolicy` to use a policy of your own on those behaviors instead; it replaces the whole
    set. The policy in use is exposed as `responseHeadersPolicy`: give it to any behavior you add yourself, which gets
    none otherwise.

    **To adopt.** Upgrade and run `cdk diff`. It shows `ResponseHeadersPolicyId` set on the distribution's default
    behavior and on `/_next/static/*` and `/assets/*`, and, with `hstsIncludeSubdomains: true`, a new `SecurityHeaders`
    response headers policy. No stateful resource changes. Before deploying, check three things:

    - **Framing.** If another site frames your app, send a CSP `frame-ancestors` naming it from the app, or pass a policy
      of your own. `SAMEORIGIN` refuses other sites' frames.
    - **Content types.** Your deploy pipeline must upload the static files with their real `Content-Type`, since `nosniff`
      makes a browser refuse a script stored as anything else.
    - **Your own policy.** If you already attach one by escape hatch (`ResponseHeadersPolicyId` overrides on the
      distribution), either pass it as `responseHeadersPolicy` and delete the overrides, or delete both and take SSSB's.
      If you keep the overrides, they replace SSSB's policy behavior by behavior.

    **Now deletable.** A response headers policy of your own that adds only HSTS, nosniff, a referrer policy and frame
    options, and the escape-hatch overrides that attach it.

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

- fca2628: ### Real mode requires only the optional ports your app uses

    **Kind.** operator

    **Action.** optional

    **What changed.** Each of SSSB's optional ports has a switch the server reads at boot: `LLM_PROVIDER` (`anthropic`
    or `none`), `EMAIL_PROVIDER` (`mailgun` or `none`), `INBOUND_EMAIL_PROVIDER` (`mailgun` or `none`) and `JOBS_RUNNER`
    (`codebuild`, `in-process` or `none`). A port switched to `none` is absent: real mode no longer requires its settings
    (`ANTHROPIC_API_KEY`; `MAILGUN_DOMAIN`, `MAILGUN_API_KEY`, `EMAIL_FROM`; `MAILGUN_WEBHOOK_SIGNING_KEY`;
    `JOBS_CODEBUILD_PROJECT`), never loads its SDK, and a call through it throws an error naming the switch. An unset
    switch is its first value, so a deployment that sets none requires exactly what it did. `SssbApp` sets the switches
    from a new, optional `params.ports` (`llm`, `email`, `inboundEmail`, `jobs`), and refuses a port or a value it does not
    know. `required-env.json` now also lists what each choice requires.

    **To adopt.** Add `ports` to `apps/<app>/config/params.ts`, beside `database`, with `none` for each port your app
    does not use, e.g. `ports: { llm: 'none', email: 'none', inboundEmail: 'none', jobs: 'in-process' }`; `SssbApp`
    already receives `params`. A deployment that does not use `SssbApp` sets the variables itself. Then delete the
    placeholder values you set for the ports you switched off.

    **Now deletable.** Placeholder values (`unused`, `unused-by-<app>`) set for `ANTHROPIC_API_KEY`, the Mailgun
    variables, `EMAIL_FROM` or `JOBS_CODEBUILD_PROJECT` only so that real mode would start.

- fca2628: ### Jobs and scheduled work without CodeBuild: the in-process runner and `SssbApp`'s scheduled tick

    **Kind.** operator

    **Action.** optional

    **What changed.** `JOBS_RUNNER=in-process` (`params.ports.jobs: 'in-process'`) runs each job's registered handler in
    the server, from the request or the scheduled tick that started it, records its terminal status and, for one of the app's own job kinds,
    notifies its org's admins before that call returns: no CodeBuild project and no jobs webhook route. A job shares that invocation's time limit (30
    seconds on `SssbApp`); longer work stays on `codebuild`. `SssbApp` takes a new option, `scheduledTick: { webhookSecret,
every? }`: an EventBridge rule (every five minutes unless `every` says otherwise) runs a function that reads that
    secret and invokes the server directly with a POST of `/api/webhooks/cron`, the route behind `withWebhookSecret` that
    `pnpm tick` calls in development. It goes through neither CloudFront nor the Function URL. Without the option nothing
    changes in your stack.

    **To adopt.** To run jobs without CodeBuild, set `jobs: 'in-process'` in `params.ports`. To run your scheduled work,
    pass the secret your server's `WEBHOOK_SECRET` holds (a plain string secret):

    ```ts
    new SssbApp(stack, 'Default', { ...props, scheduledTick: { webhookSecret } })
    ```

    The construct grants its function read on that secret and invoke on the server; getting the value into the server's
    `WEBHOOK_SECRET` stays yours. Close the `scheduled-tick` cutover row with its proof after the first deploy.

    **Now deletable.** A ticker of your own (an EventBridge rule and a Lambda that POSTs a route of yours with the webhook
    secret) whose route only does what a registered job kind and a `job_schedules` row would; and a route of your own that
    runs scheduled work in the server because SSSB's real jobs port started every job as a CodeBuild build.

### Patch Changes

- edfac82: ### `SssbApp` tells the app the host the viewer asked for, and redirects plain HTTP everywhere

    **Kind.** operator

    **Action.** optional

    **What changed.** CloudFront sends the server's Function URL its own `Host`, and forwarded a viewer's
    `X-Forwarded-Host` as sent, so what reads that header in a deployed app (Clerk's request URL, Next's server-action origin
    check, next-intl's domain redirects) saw the Function URL's host, or one the viewer chose. `SssbApp` now runs a
    viewer-request CloudFront Function on the default behavior that sets `x-forwarded-host` from the `Host` CloudFront
    received (lowercased, any port dropped) and `x-forwarded-port` to 443, overwriting what the viewer sent, and drops a
    viewer's `Forwarded`. Next's own `request.url` names the server's own address (`localhost` and its port), not the viewer's host. It is exposed as `forwardedHost`: associate it with any behavior of your own
    that reaches the server. The `/_next/static/*` and `/assets/*` behaviors now redirect HTTP to HTTPS, as the default
    behavior already did.

    **To adopt.** Upgrade and run `cdk diff`. It shows a new `ForwardedHost` CloudFront Function, the distribution's
    default behavior gaining a `FunctionAssociations` entry (`viewer-request`), and `ViewerProtocolPolicy` on the two static
    behaviors changing from `allow-all` to `redirect-to-https`. No stateful resource changes. If you added a behavior of
    your own that reaches the server, associate `forwardedHost` with it on `viewer-request`.

    **Now deletable.** A CloudFront Function of your own that sets `x-forwarded-host` from the viewer's `Host`, and the
    escape-hatch override (`FunctionAssociations` on the default behavior) that attaches it: keeping the override replaces
    `SssbApp`'s association with yours.

- Updated dependencies [b28bc3b]
- Updated dependencies [641ddba]
- Updated dependencies [e214c18]
- Updated dependencies [3dc7b50]
- Updated dependencies [b6a652f]
- Updated dependencies [b6a652f]
- Updated dependencies [1780691]
- Updated dependencies [9940da2]
    - @sssb/tools@0.3.0

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
