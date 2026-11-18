# infra/ — this app's CDK app (DRAFT)

This app's deployment, per ADR-0001 and ADR-0014 (D8): one stack holding SSSB's `SssbApp` construct
(`@sssb/cdk`, `packages/cdk` in SSSB's repository). The construct builds the Next standalone server in one
Lambda via the AWS Lambda Web Adapter, its Function URL behind CloudFront, static assets from S3, the
framework's migrator bundled with this app's own migrations, Aurora PostgreSQL Serverless v2 (min-capacity 0
outside production), alarms and a budget. `app.ts` instantiates it with `..` as the app's directory and the
app's own `config/params.ts`; `lib/tags.ts` is your organisation's tagging, applied to the whole stack.

This is a **draft you are meant to take over**, not a finished deployment. It exists so the hosting
decision is written down in runnable form rather than as prose, and so `pnpm synth` here proves the shape
compiles offline before anyone has an AWS account. The stack in `app.ts` is yours: add your own constructs
beside `SssbApp`. The construct reads only the app's directory and params, so this directory can also move
into an infrastructure repository or a root `infra/` that composes several apps; give each `SssbApp` an id of
its own there.

## Status: authored — cutover

- `pnpm synth` in this directory is the verification bar: green, offline, zero credentials
  (environment-agnostic stack, no lookups). CI runs it for every app.
- **Nothing here deploys until** (see `docs/cutover-checklist.md`): `cloud-accounts` fills
  `../config/params.ts` · `recurring-cost` — Aurora, the NAT gateway (on the `pg` shape), and CloudFront need
  explicit approval. Not a checklist row, but do it first: if your organisation ships its own CDK construct
  library, replace `lib/tags.ts` with it.

## Two network shapes — decide before the first deploy

`params.database.transport` in the app's `config/params.ts` picks one (ADR-0001 and ADR-0002, addenda
2026-11-16). On an existing stack a switch does not replace anything: it fails on overlapping subnet
CIDRs and rolls back. Changing shape later means a new stack and a snapshot restore.

- **`pg` (default):** both Lambdas inside the VPC, reaching Aurora over a socket. One NAT gateway carries
  their egress.
- **`data-api` (opt-in):**
    - only the cluster lives in the VPC, in isolated subnets with no NAT gateway;
    - both Lambdas run outside it and reach Aurora through the RDS Data API, authorised by IAM alone;
    - the function configuration holds no database credential.

    Cutover rows `data-api` (the transport, proven live by `docs/runbooks/data-api.md`) and
    `data-api-access` (this shape, deployed) close it.

## What synth asserts

`cdk synth` fails unless all three hold, for the shape the params choose:

- the `@sssb/kit` this app resolves is the construct's own version (SSSB's packages are released in
  lockstep);
- the server's final environment, escape-hatch overrides included, sets `APP_MODE=real` and has neither
  `DEMO_MODE` nor `E2E_BUILD`, so fake adapters cannot serve a deployment;
- the migrator's bundle, as esbuild staged it during this synth, carries every one of this app's migrations
  by its registry's names, names the framework's and the app's migration registries in esbuild's path
  comments (so a minified bundle fails instead of passing unread), and holds no code from a test fixture. The
  construct resolves the migrator from this app's `@sssb/kit` and passes the seam to esbuild explicitly
  (`--alias:@sssb/app-config=<app>/src/app-config`): in SSSB's own repository the nearest tsconfig points that
  alias at SSSB's test fixture, and a migrator bundled with it would ship the fixture's migrations instead of
  the app's.

SSSB's own repository also synthesizes both shapes for every app and checks the way in (`packages/cdk`'s
test): each statement that can grant a Secrets Manager action names the cluster's own secret alone, each that
can grant an `rds-data` action names the cluster alone, no role attaches an AWS-managed policy beyond the two
Lambda execution policies, every database cluster is encrypted at rest, and on `data-api` the database's
security group admits nothing.

## Deploys — checks in CI, deploys in your own pipeline

`.github/workflows/checks.yml` runs checks only; there is deliberately no GitHub Actions CD here,
because the deploy pipeline is the piece most tied to an organisation's accounts and approval gates.
The shape this stack assumes: a pipeline that uploads the standalone build zip the `Server` function
expects (the construct's placeholder asset is a `run.sh` that execs `node server.js`) and invokes the
`Migrator` before shifting traffic. Cutover row `deploy-pipeline` is where that gets built.

Nothing in this directory may depend on app source beyond `config/app.ts` and `config/params.ts`, which is
what makes moving it mechanical. It is not covered by `pnpm typecheck` — `synth` verifies it.
