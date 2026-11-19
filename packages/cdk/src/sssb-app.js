// @ts-check
import { existsSync, readdirSync, readFileSync, realpathSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
// A namespace import, never a default one: aws-cdk-lib is CommonJS, and a loader that compiles this file to
// CommonJS (tsx, under an app whose infra has no `"type": "module"`) hands it `module.exports` with no `default`.
import * as cdk from 'aws-cdk-lib'
import { Construct } from 'constructs'
import { failClosedEnvironmentProblems, migratorBundleProblems } from '@sssb/tools/assembly-checks'
import { kitDirOf, kitVersionOf, resolveAppsKit } from '@sssb/tools/kit'
import { databaseNameFor, SLUG } from './database-name.js'
import { FORWARDED_HOST_SOURCE } from './forwarded-host.js'

const { aws_budgets, aws_cloudfront, aws_cloudfront_origins, aws_cloudwatch, aws_ec2, aws_lambda } = cdk
const { aws_lambda_nodejs, aws_rds, aws_s3 } = cdk

const HERE = path.dirname(fileURLToPath(import.meta.url))

/** This package's own version: the one `@sssb/kit` version the construct was released with (rule 4). */
const OWN_VERSION = /** @type {{ version: string }} */ (
    JSON.parse(readFileSync(path.join(HERE, '../package.json'), 'utf8'))
).version

/**
 * The version of the `@sssb/tools` this package runs its checks with: its peer, so the adopter's own copy, which pnpm
 * only warns about when it is another release. Read from this package's own resolution.
 */
const TOOLS_VERSION = /** @type {{ version: string }} */ (
    JSON.parse(readFileSync(createRequire(import.meta.url).resolve('@sssb/tools/package.json'), 'utf8'))
).version

/**
 * The problem with running this `@sssb/cdk` beside `@sssb/tools` at `tools`, or null: the two are released in lockstep,
 * and the construct's deploy-time checks are that release's. A peer at another version is only a pnpm warning.
 * @param {string} tools
 * @param {string} [own]
 */
export function toolsVersionProblem(tools, own = OWN_VERSION) {
    if (tools === own) return null
    return (
        `SssbApp: this @sssb/cdk is ${own}, but the @sssb/tools beside it is ${tools}. SSSB's packages are released in ` +
        `lockstep: depend on @sssb/tools ${own} in the package that takes @sssb/cdk (its peer), then run pnpm install.`
    )
}

const TRANSPORTS = /** @type {const} */ (['pg', 'data-api'])

/**
 * The migrator entry, a published subpath of `@sssb/kit` (its `exports` map), resolved through that map from the
 * app; and the framework's migration registry, which is not published, so it is named by its path inside the
 * package. The version check below is what makes naming that path safe: this construct is released with that one
 * layout.
 */
const KIT_MIGRATOR = 'adapters/real/migrate-handler'
const KIT_MIGRATIONS_INDEX = 'src/db/migrations/index.ts'

/** Where the app's seam lives, and its migration index, relative to the app's directory. */
const SEAM_DIR = 'src/app-config'
const SEAM_MIGRATIONS_INDEX = 'db/migrations/index.ts'

const LOCK_FILES = ['pnpm-lock.yaml', 'yarn.lock', 'package-lock.json', 'bun.lockb', 'bun.lock']

/**
 * The lock file nearest above the app: its directory is the root esbuild runs from, and so the base of the
 * path comments the bundle check reads.
 * @param {string} appDir
 * @returns {string}
 */
function lockFileAbove(appDir) {
    for (let dir = appDir; ; dir = path.dirname(dir)) {
        const found = LOCK_FILES.map((name) => path.join(dir, name)).find((file) => existsSync(file))
        if (found) return found
        if (path.dirname(dir) === dir) {
            throw new Error(`SssbApp: no lock file (${LOCK_FILES.join(', ')}) at or above ${appDir}`)
        }
    }
}

/**
 * A path as esbuild writes it in a bundle's per-module comment: relative to the root it runs from, with
 * forward slashes.
 * @param {string} root
 * @param {string} file
 */
const asBundleComment = (root, file) => path.relative(root, realpathSync(file)).split(path.sep).join('/')

/**
 * The app's own migrations, by the names the bundle must carry (the keys Kysely records): the literal keys of the
 * seam's migration index, comments left out. An index with migration files beside it but no literal key (keys
 * computed, or another registry re-exported) would make the check expect nothing, so it is refused instead.
 * @param {string} index
 * @returns {string[]}
 */
function seamMigrationNames(index) {
    const source = readFileSync(index, 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/(^|[^:'"])\/\/.*$/gm, '$1')
    const keys = [...source.matchAll(/['"](\d+_[^'"]+)['"]\s*:/g)].map((match) => /** @type {string} */ (match[1]))
    const files = readdirSync(path.dirname(index)).filter((file) => /^\d+_[^.]+\.(?:ts|mts|js|mjs)$/.test(file))
    if (keys.length === 0 && files.length > 0) {
        throw new Error(
            `SssbApp: ${index} registers none of ${files.join(', ')} under a literal key. Register each migration ` +
                "as `'1001_name': m1001`, so the migrator's bundle can be checked for it.",
        )
    }
    return [...new Set(keys)].sort()
}

/**
 * The app's slug as its `config/app.ts` declares it (`export const APP_SLUG = '…'`), or `undefined` for an app
 * laid out otherwise. Read as text: this package is JavaScript and loads no TypeScript.
 * @param {string} appDir
 * @returns {string | undefined}
 */
function declaredSlug(appDir) {
    const file = path.join(appDir, 'config/app.ts')
    if (!existsSync(file)) return undefined
    return /export const APP_SLUG = ['"]([^'"]+)['"]/.exec(readFileSync(file, 'utf8'))?.[1]
}

/**
 * The framework's migrator for one app, resolved from the app's directory, never from this package (rule 4):
 * the entry esbuild bundles, the app's seam it aliases, and what the bundle must then contain.
 * @param {string} appDir
 */
function resolveMigrator(appDir) {
    const tools = toolsVersionProblem(TOOLS_VERSION)
    if (tools !== null) throw new Error(tools)
    const kitDir = kitDirOf(appDir)
    const kitVersion = kitVersionOf(appDir)
    if (kitVersion !== OWN_VERSION) {
        throw new Error(
            `SssbApp: ${appDir} resolves @sssb/kit ${kitVersion} (${kitDir}), but this @sssb/cdk is ` +
                `${OWN_VERSION}. SSSB's packages are released in lockstep: install the matching versions.`,
        )
    }
    const entry = resolveAppsKit(appDir, KIT_MIGRATOR)
    const seamDir = path.join(appDir, SEAM_DIR)
    const seamIndex = path.join(seamDir, SEAM_MIGRATIONS_INDEX)
    if (!existsSync(seamIndex)) {
        throw new Error(`SssbApp: ${appDir} has no migration index at ${path.join(SEAM_DIR, SEAM_MIGRATIONS_INDEX)}`)
    }
    const migrations = seamMigrationNames(seamIndex)
    // An app that links its seam as a package (an adopter's, ADR-0014 part 1) must link THIS directory: the
    // server's build resolves the link, and the migrator would otherwise bundle a different seam from the one the
    // server runs on.
    const linked = path.join(appDir, 'node_modules/@sssb/app-config')
    if (existsSync(linked) && realpathSync(linked) !== realpathSync(seamDir)) {
        throw new Error(
            `SssbApp: ${appDir} links @sssb/app-config to ${realpathSync(linked)}, not to its ${SEAM_DIR}, ` +
                'which is the seam the migrator is bundled with. Declare the seam as the workspace package in ' +
                '`src/app-config` (`"@sssb/app-config": "workspace:<name>-app-config@*"`; a `file:` dependency ' +
                'installs a copy).',
        )
    }
    const lockFile = lockFileAbove(appDir)
    const projectRoot = path.dirname(lockFile)
    // esbuild runs from the project root and CDK refuses an entry outside it; say why, rather than CDK's error.
    const relativeEntry = path.relative(projectRoot, entry)
    if (relativeEntry === '..' || relativeEntry.startsWith(`..${path.sep}`) || path.isAbsolute(relativeEntry)) {
        throw new Error(
            `SssbApp: the @sssb/kit ${appDir} resolves (${kitDir}) is outside the project root ${projectRoot}, ` +
                'where the migrator is bundled from. Install the framework into the project rather than linking a ' +
                'checkout from elsewhere.',
        )
    }
    // CDK bundles with an esbuild its own `require` finds, run from the project root (`pnpm exec esbuild`,
    // `npx --no-install`), else with an `esbuild` on PATH, else in Docker, where the seam alias and the path
    // comments the check reads, both host paths, would name nothing. The first is the one a project installs, so
    // the construct requires it at the project root, and refuses a global esbuild CDK would accept.
    if (!existsSync(path.join(projectRoot, 'node_modules/esbuild/package.json'))) {
        throw new Error(
            `SssbApp: no esbuild at ${projectRoot}, the project root the migrator is bundled from. Add esbuild to ` +
                "that package's devDependencies: the construct bundles locally, never in CDK's Docker fallback.",
        )
    }
    return {
        entry,
        seamDir: realpathSync(seamDir),
        lockFile,
        projectRoot,
        expected: {
            sources: [
                asBundleComment(projectRoot, path.join(kitDir, KIT_MIGRATIONS_INDEX)),
                asBundleComment(projectRoot, seamIndex),
            ],
            migrations,
        },
    }
}

/**
 * A function's properties as they will be deployed: the rendered CloudFormation, escape-hatch overrides included,
 * with every token the stack can resolve resolved.
 * @param {cdk.aws_lambda.Function} fn
 * @returns {{ Environment?: { Variables?: Record<string, unknown> }, Code?: { S3Bucket?: unknown, S3Key?: unknown } }}
 */
function renderedProperties(fn) {
    const cfn = /** @type {any} */ (fn.node.defaultChild)
    if (typeof cfn?._toCloudFormation !== 'function') {
        throw new Error(`SssbApp: cannot render ${fn.node.path}'s CloudFormation to check it`)
    }
    const rendered = cdk.Stack.of(fn).resolve(cfn._toCloudFormation())
    return Object.values(rendered.Resources ?? {})[0]?.Properties ?? {}
}

/**
 * The code esbuild staged for a NodejsFunction during this synth, and problems with what it deploys: a `Code`
 * other than the asset this synth staged (an escape-hatch override would deploy something the bundle check never
 * read). Compared with the asset's own bucket and key, as the stack's synthesizer assigned them, so a bucket
 * prefix or a legacy synthesizer's parameters compare equal.
 * @param {cdk.aws_lambda.Function} fn
 * @returns {{ code: string | undefined, problems: string[] }}
 */
function stagedBundle(fn) {
    const asset = /** @type {cdk.aws_s3_assets.Asset | undefined} */ (fn.node.tryFindChild('Code'))
    const stage = /** @type {{ absoluteStagedPath?: unknown } | undefined} */ (asset?.node.tryFindChild('Stage'))
    const dir = stage?.absoluteStagedPath
    if (asset === undefined || typeof dir !== 'string') return { code: undefined, problems: [] }
    const file = ['index.mjs', 'index.js'].map((name) => path.join(dir, name)).find((name) => existsSync(name))
    const stack = cdk.Stack.of(fn)
    const staged = JSON.stringify(stack.resolve({ S3Bucket: asset.s3BucketName, S3Key: asset.s3ObjectKey }))
    const deployed = renderedProperties(fn).Code
    const problems =
        // The whole `Code`: an override that adds `ZipFile` or `ImageUri` beside the staged key is caught too.
        JSON.stringify(deployed) === staged
            ? []
            : [`it deploys ${JSON.stringify(deployed)}, not the bundle this synth staged (${staged})`]
    return { code: file === undefined ? undefined : readFileSync(file, 'utf8'), problems }
}

export { databaseNameFor } from './database-name.js'

/** After every tag aspect: CDK's own run at `AspectPriority.MUTATING` (200) or the default (500). */
const MIRROR_PRIORITY = 900

/**
 * Makes `manager` hold exactly `wanted`, over any tag an aspect set or will set: a higher priority wins, and CDK's
 * `Tags.of(...).add` and `.remove` default to 100 and 200 (a caller who passes more than 10 000 is not followed).
 * @param {cdk.TagManager} manager
 * @param {Record<string, string>} wanted
 */
function mirrorTags(manager, wanted) {
    const priority = 10_000
    for (const key of Object.keys(manager.tagValues())) if (!(key in wanted)) manager.removeTag(key, priority)
    for (const [key, value] of Object.entries(wanted)) manager.setTag(key, value, priority)
}

/**
 * An SSSB app's deployment (ADR-0001, ADR-0014 part 8): the Next standalone server in one Lambda behind the
 * AWS Lambda Web Adapter, its Function URL behind CloudFront with static assets from S3, the framework's
 * migrator bundled with the app's own migrations, and Aurora PostgreSQL Serverless v2. A construct, not a
 * stack: the adopter composes it inside a stack of their own, beside their own constructs.
 *
 * The Function URL answers only the distribution, through an origin access control, and a Lambda@Edge function on
 * the origin request adds the body's hash a request with a body needs (ADR-0001, addendum 2026-11-19). Lambda@Edge
 * lives in us-east-1: an environment-agnostic stack deploys to us-east-1 only, and a stack with an explicit region
 * elsewhere gets the function in a us-east-1 stack of its own.
 *
 * TWO NETWORK SHAPES, chosen by `params.database.transport` (ADR-0001 and ADR-0002, addenda 2026-11-16).
 * Decide before the first deploy: on an existing stack a switch does not replace anything, it FAILS (the new
 * subnets' CIDRs overlap the old ones) and rolls back, so changing shape means a new stack and a restore from a
 * snapshot.
 * - `pg` (default): both Lambdas run inside the VPC and reach Aurora over a socket; one NAT gateway carries
 *   their egress to the hosted auth/email/LLM services.
 * - `data-api` (opt-in): only the database lives in the VPC, in isolated subnets with no NAT. Both Lambdas run
 *   outside it and reach Aurora through the RDS Data API, authorised by IAM alone.
 *
 * AT SYNTH it asserts, and `cdk synth` fails otherwise. At construction:
 * - the `@sssb/kit` the app resolves is this construct's own version, installed under the project root (the lock
 *   file's directory), which also installs esbuild;
 * - the slug is lowercase letters, digits and dashes, and is the `APP_SLUG` the app's `config/app.ts` declares
 *   (where it has one); `environment` is a non-empty name, `production` is a boolean and the transport is `pg` or
 *   `data-api`;
 * - the app has a lock file at or above it and a migration index at `src/app-config/db/migrations/index.ts`;
 * - a linked `@sssb/app-config` is the app's own `src/app-config`, whose migration index registers its migrations
 *   under literal keys.
 * Then, as a validation over the rendered template, overrides included:
 * - the server's final environment is fail-closed: `APP_MODE` is `real`, and neither `DEMO_MODE` nor `E2E_BUILD`
 *   is present; the migrator carries neither switch either;
 * - the migrator deploys the bundle this synth staged, and that bundle carries the app's own migrations, built
 *   from the app's seam and no test fixture (when this synth bundles the stack at all: `cdk deploy --exclusively
 *   OtherStack` skips it).
 *
 * The migrator is bundled LOCALLY, by the esbuild the project root installs, never in CDK's Docker fallback: the
 * seam alias and the bundle's path comments the check reads are paths on the machine running the synth.
 *
 * Gates before any deploy (docs/cutover-checklist.md): `cloud-accounts` and `recurring-cost` (Aurora, NAT
 * gateway, CloudFront must be approved).
 */
export class SssbApp extends Construct {
    /**
     * @param {Construct} scope
     * @param {string} id
     * @param {import('./index.d.ts').SssbAppProps} props
     */
    constructor(scope, id, props) {
        super(scope, id)

        // Real, so that the project root, the entry and the seam are all spelled the same way: esbuild and CDK
        // compare them, and the entry comes back from the resolver as a real path.
        const appDir = realpathSync(path.resolve(props.appDir))
        const slug = props.slug
        if (!SLUG.test(slug ?? '')) {
            throw new Error(`SssbApp: slug must be lowercase letters, digits and dashes (got "${String(slug)}")`)
        }
        // The database the migrator migrates and the server reads, named from the slug (databaseNameFor).
        const databaseName = databaseNameFor(slug)
        // The slug names the database the migrator migrates and the server reads, so it must be this app's: a
        // root infra/ composing several apps could otherwise pair one app's directory with another's slug.
        const declared = declaredSlug(appDir)
        if (declared !== undefined && declared !== slug) {
            throw new Error(`SssbApp: slug is "${slug}", but ${appDir}/config/app.ts declares APP_SLUG "${declared}"`)
        }
        const transport = props.params?.database?.transport
        if (!TRANSPORTS.includes(/** @type {any} */ (transport))) {
            throw new Error(
                `SssbApp: params.database.transport must be ${TRANSPORTS.join(' or ')} (got "${String(transport)}")`,
            )
        }
        if (typeof props.environment !== 'string' || props.environment === '') {
            throw new Error('SssbApp: environment must name the deployment (e.g. Staging, Production)')
        }
        // A boolean, never inferred: a JavaScript caller that left it out would otherwise get the destructive
        // non-production defaults (a database destroyed with the stack, buckets that empty themselves).
        if (typeof props.production !== 'boolean') {
            throw new Error(`SssbApp: production must be true or false (got ${JSON.stringify(props.production)})`)
        }
        const isProd = props.production
        const dataApi = transport === 'data-api'
        const removalPolicy = isProd ? cdk.RemovalPolicy.RETAIN : cdk.RemovalPolicy.DESTROY
        const migratorSource = resolveMigrator(appDir)

        // ---- networking -------------------------------------------------------------------
        // pg: one NAT gateway so the in-VPC Lambdas can reach the hosted auth/email/LLM services —
        // recurring cost, gated by cutover row `recurring-cost`. data-api: nothing but the database is in
        // the VPC, so it needs no route out at all — isolated subnets, no NAT, no public subnets. (Should the
        // secret later get rotation, its rotation Lambda lands in these subnets and needs a Secrets
        // Manager interface endpoint, having no other way to reach the service.)
        const vpc = new aws_ec2.Vpc(
            this,
            'Vpc',
            dataApi
                ? {
                      maxAzs: 2,
                      natGateways: 0,
                      subnetConfiguration: [
                          { name: 'Database', subnetType: aws_ec2.SubnetType.PRIVATE_ISOLATED, cidrMask: 24 },
                      ],
                  }
                : { maxAzs: 2, natGateways: 1 },
        )
        const dbSubnetType = dataApi ? aws_ec2.SubnetType.PRIVATE_ISOLATED : aws_ec2.SubnetType.PRIVATE_WITH_EGRESS
        // Where the Lambdas run: inside the VPC for pg, outside any VPC for the Data API.
        const lambdaNetwork = dataApi ? {} : { vpc, vpcSubnets: { subnetType: aws_ec2.SubnetType.PRIVATE_WITH_EGRESS } }

        // ---- database ---------------------------------------------------------------------
        const db = new aws_rds.DatabaseCluster(this, 'Db', {
            engine: aws_rds.DatabaseClusterEngine.auroraPostgres({
                version: aws_rds.AuroraPostgresEngineVersion.VER_16_10,
            }),
            writer: aws_rds.ClusterInstance.serverlessV2('writer'),
            serverlessV2MinCapacity: isProd ? 1 : 0,
            serverlessV2MaxCapacity: 2,
            vpc,
            vpcSubnets: { subnetType: dbSubnetType },
            // The HTTPS endpoint the data-api transport calls. Left unset for pg, which needs no second way
            // in — unset rather than `false`, so the pg cluster synthesizes exactly as it did before.
            ...(dataApi && { enableDataApi: true }),
            defaultDatabaseName: databaseName,
            storageEncrypted: true,
            removalPolicy,
        })
        const secret = /** @type {cdk.aws_secretsmanager.ISecret} */ (db.secret)
        // The cluster's `removalPolicy` does not reach its generated master secret, which CDK synthesizes with
        // `DeletionPolicy: Delete` whatever the cluster does. In production the stack would then keep the database
        // and delete the only credentials to it, so the secret gets the cluster's policy. The logical id is
        // unchanged (a new one would replace the secret, and with it the password the cluster was created with).
        // `db.secret` is not the secret: it is the SecretTargetAttachment that CDK returns from `secret.attach`, so the
        // policy goes on the underlying `AWS::SecretsManager::Secret`, found in the cluster's subtree. Nothing else
        // holds the credentials: no KMS key (the cluster and the secret name none, so they use the account's AWS-managed
        // keys; the buckets use S3's), no rotation schedule, and the attachment names a secret and a cluster
        // and nothing else, the username and password being the secret's own `GenerateSecretString`.
        const generatedSecrets = db.node.findAll().filter((c) => c instanceof cdk.aws_secretsmanager.CfnSecret)
        if (generatedSecrets.length !== 1) {
            throw new Error(
                `SssbApp: expected the database cluster to own one generated secret, found ${generatedSecrets.length}`,
            )
        }
        const [generatedSecret] = /** @type {cdk.aws_secretsmanager.CfnSecret[]} */ (generatedSecrets)
        generatedSecret?.applyRemovalPolicy(removalPolicy)

        // ---- buckets ----------------------------------------------------------------------
        // CDN-served build assets — written by the deploy pipeline only.
        const assetsBucket = new aws_s3.Bucket(this, 'AssetsBucket', {
            blockPublicAccess: aws_s3.BlockPublicAccess.BLOCK_ALL,
            enforceSSL: true,
            removalPolicy,
            autoDeleteObjects: !isProd,
        })
        // App object storage (StoragePort) — private, NEVER behind CloudFront: sharing the CDN
        // bucket would make app-stored objects publicly fetchable and let the app overwrite
        // served JS.
        const storageBucket = new aws_s3.Bucket(this, 'StorageBucket', {
            blockPublicAccess: aws_s3.BlockPublicAccess.BLOCK_ALL,
            enforceSSL: true,
            encryption: aws_s3.BucketEncryption.S3_MANAGED,
            removalPolicy,
            autoDeleteObjects: !isProd,
        })

        // The database half of each Lambda's environment (the framework's real adapters read it at boot).
        // data-api builds no DATABASE_URL at all: the credential stays in Secrets Manager, where the Data
        // API reads it, so the `db-credential-not-in-env` concern does not arise on that path.
        /** @type {Record<string, string>} */
        const databaseEnv = dataApi
            ? {
                  DATABASE_TRANSPORT: 'data-api',
                  DATABASE_CLUSTER_ARN: db.clusterArn,
                  DATABASE_SECRET_ARN: secret.secretArn,
                  DATABASE_NAME: databaseName,
              }
            : {
                  DATABASE_TRANSPORT: 'pg',
                  // DRAFT: built via CFN dynamic references so the server
                  // can actually boot; revisit with the shared secrets constructs at cutover
                  // (env-var exposure vs runtime secret fetch).
                  DATABASE_URL: `postgres://${secret.secretValueFromJson('username').unsafeUnwrap()}:${secret
                      .secretValueFromJson('password')
                      .unsafeUnwrap()}@${db.clusterEndpoint.socketAddress}/${databaseName}`,
              }

        // pg: read the secret and open the database port to the function's security group. data-api: the
        // RDS Data API actions on THIS cluster and read on its secret, nothing else; IAM is the whole
        // boundary on that path, so it is scoped to the one cluster (cutover row `data-api-access`).
        /** @param {cdk.aws_lambda.Function} fn */
        const grantDatabase = (fn) => {
            if (dataApi) {
                db.grantDataApiAccess(fn)
            } else {
                secret.grantRead(fn)
                db.connections.allowDefaultPortFrom(fn)
            }
        }

        // ---- app server lambda (web adapter) -----------------------------------------------
        // Code ships as the standalone build zip uploaded by your deploy pipeline — the placeholder asset
        // keeps synth honest until then.
        const server = new aws_lambda.Function(this, 'Server', {
            runtime: aws_lambda.Runtime.NODEJS_22_X,
            architecture: aws_lambda.Architecture.X86_64,
            code: aws_lambda.Code.fromAsset(path.join(HERE, 'assets/placeholder-lambda')),
            handler: 'run.sh',
            memorySize: 1769, // 1 vCPU-second per second — the sweet spot for SSR cold starts
            timeout: cdk.Duration.seconds(30),
            ...lambdaNetwork,
            layers: [
                aws_lambda.LayerVersion.fromLayerVersionArn(
                    this,
                    'WebAdapterLayer',
                    // AWS-published public layer
                    `arn:aws:lambda:${cdk.Stack.of(this).region}:753240598075:layer:LambdaAdapterLayerX86:24`,
                ),
            ],
            environment: {
                AWS_LAMBDA_EXEC_WRAPPER: '/opt/bootstrap',
                PORT: '3000',
                // Where Next's standalone server listens: its server.js takes HOSTNAME, or 0.0.0.0 when it is unset
                // (next/dist/build/utils.js). Pinned to that default: the Web Adapter calls the server on 127.0.0.1,
                // so an inherited HOSTNAME naming another address would leave it nothing to call, and with 127.0.0.1
                // itself Next names itself `localhost` to the proxy but `127.0.0.1` when it routes, so a rewrite the
                // proxy makes (Clerk's, on every request) looks external and Next fetches it over the network (pages,
                // 2026-11-18). No wider than that: on pg the server's security group admits nothing, and on data-api
                // it is in no VPC. A run.sh that exports HOSTNAME overrides this; the deploy pipeline's must not.
                HOSTNAME: '0.0.0.0',
                APP_MODE: 'real',
                NEXT_TELEMETRY_DISABLED: '1',
                ...databaseEnv,
                STORAGE_BUCKET: storageBucket.bucketName,
            },
        })
        grantDatabase(server)
        storageBucket.grantReadWrite(server)

        // AWS_IAM, not NONE. A Function URL with NONE answers anyone on the internet who has the URL,
        // and putting CloudFront in front of it does not change that — the origin stays directly
        // reachable, so any WAF, geo restriction, rate limit or response-headers policy attached to
        // the distribution later is bypassable by calling the origin instead. Paired with the origin
        // access control below, the distribution is the only caller that can sign a request.
        const functionUrl = server.addFunctionUrl({ authType: aws_lambda.FunctionUrlAuthType.AWS_IAM })

        // ---- migrator ----------------------------------------------------------------------
        // The framework's migration registry composed with the app's ≥1001 set through the seam. The entry
        // is the `@sssb/kit` the APP resolves, and the seam is passed explicitly as an esbuild alias: the
        // fallback, the nearest tsconfig's `@sssb/app-config/*` mapping, is in SSSB's own repository its test
        // fixture's, which once shipped the fixture's migrations and none of the app's (jpslav/keel#54).
        const migrator = new aws_lambda_nodejs.NodejsFunction(this, 'Migrator', {
            runtime: aws_lambda.Runtime.NODEJS_22_X,
            entry: migratorSource.entry,
            projectRoot: migratorSource.projectRoot,
            depsLockFilePath: migratorSource.lockFile,
            handler: 'handler',
            timeout: cdk.Duration.minutes(5),
            ...lambdaNetwork,
            // pg: the handler builds its own connection string from the secret. data-api: the same
            // variables as the server (the handler follows DATABASE_TRANSPORT too).
            // On pg it gets the database's name too: the framework's handler prefers it to the secret's `dbname`,
            // which the synthesized secret does not carry (only the cluster's secret attachment would add it, at deploy).
            environment: dataApi
                ? databaseEnv
                : { DATABASE_TRANSPORT: 'pg', DB_SECRET_ARN: secret.secretArn, DATABASE_NAME: databaseName },
            bundling: {
                format: aws_lambda_nodejs.OutputFormat.ESM,
                // pg's optional native/cloudflare shims must stay external or esbuild chokes
                externalModules: ['@aws-sdk/*', 'pg-native', 'cloudflare:sockets'],
                esbuildArgs: { '--alias:@sssb/app-config': migratorSource.seamDir },
            },
        })
        grantDatabase(migrator)

        // ---- the request body's hash (Lambda@Edge) ------------------------------------------
        // Lambda takes no unsigned payload behind origin access control: a request with a body must carry its
        // SHA-256 in `x-amz-content-sha256`, which CloudFront does not compute, so without this every POST, PUT and
        // PATCH would answer 403. An origin-request function hashes the body CloudFront hands it (read-only: what is
        // hashed is what is forwarded), then CloudFront signs the request, header included. CloudFront hands an
        // origin request at most 1 MB of body; past that the function answers 413 rather than a hash that would not
        // match. ADR-0001, addendum 2026-11-19, says why this and not a Function URL open to the internet.
        // Lambda@Edge lives in us-east-1. A stack whose region is us-east-1, or unknown until deploy (an
        // environment-agnostic stack, as the starter's is until cutover), keeps the function in the stack; so the
        // latter deploys to us-east-1 alone: elsewhere CloudFront refuses the association and the deploy rolls back,
        // after the database is created. A stack with an explicit region elsewhere gets CDK's EdgeFunction, which puts
        // the function in a us-east-1 stack of its own (that region bootstrapped too).
        const stack = cdk.Stack.of(this)
        /** @type {cdk.aws_lambda.FunctionProps} */
        const bodyHashProps = {
            runtime: aws_lambda.Runtime.NODEJS_22_X,
            architecture: aws_lambda.Architecture.X86_64,
            code: aws_lambda.Code.fromAsset(path.join(HERE, 'assets/body-hash')),
            handler: 'index.handler',
            memorySize: 128,
            timeout: cdk.Duration.seconds(5),
            description: `${slug}: SHA-256 of each request body, for the server's Function URL (Lambda@Edge)`,
            // Destroyed, not CDK's default of retained: the version's id carries a hash of the code, so a retained
            // one would pile up with every change and outlive every teardown. CloudFront's replicas keep a version
            // from being deleted for up to a few hours after the distribution lets go of it, so the cleanup after
            // an update that replaces the code can fail to delete the old one (a failed cleanup leaves it behind and
            // fails nothing), and deleting the stack fails until the replicas are gone (docs/runbooks/deploy.md).
            currentVersionOptions: { removalPolicy: cdk.RemovalPolicy.DESTROY },
        }
        /** @type {cdk.aws_lambda.IVersion} */
        let bodyHash
        if (cdk.Token.isUnresolved(stack.region) || stack.region === 'us-east-1') {
            // In the stack, whether its region is us-east-1 or unknown until deploy: one construct path for both, so
            // naming the region later does not replace the function. The distribution adds Lambda@Edge to the role's
            // trust, as it does for every function it runs at the edge.
            bodyHash = new aws_lambda.Function(this, 'BodyHash', bodyHashProps).currentVersion
        } else {
            // A us-east-1 stack per SssbApp and per region it serves. CDK's default is one per parent stack path, in
            // which a second SssbApp's `BodyHash` would collide with the first's, and which deployments of one stack
            // to two regions of an account would share.
            const edgeFunction = new aws_cloudfront.experimental.EdgeFunction(this, 'BodyHash', {
                ...bodyHashProps,
                stackId: `edge-${stack.region}-${this.node.addr}`,
            })
            // That stack is the app's too, so it carries the app's tags: CDK copies the parent's into it when it is
            // created, before any `Tags.of(...)` has applied (they are aspects, applied at synth). So, last, each of
            // its resources is given exactly the tags the server function ended with, and the stack exactly the
            // parent stack's, whatever scope or filter set them (`explicitStackTags` tags resources only).
            const edgeStack = cdk.Stack.of(edgeFunction.lambda)
            const serverTags = /** @type {cdk.CfnResource & cdk.ITaggable} */ (server.node.defaultChild).tags
            cdk.Aspects.of(edgeStack).add(
                {
                    visit: (node) => {
                        if (node === edgeStack) mirrorTags(edgeStack.tags, stack.tags.tagValues())
                        else if (node instanceof cdk.CfnResource && cdk.TagManager.isTaggable(node)) {
                            mirrorTags(node.tags, serverTags.tagValues())
                        }
                    },
                },
                { priority: MIRROR_PRIORITY },
            )
            bodyHash = edgeFunction
        }

        // ---- the host the viewer asked for (CloudFront Function) ------------------------------
        // CloudFront sends the Function URL its own Host (it signs for it), so the app would build its redirects,
        // absolute links and Clerk's URLs on the Function URL's host, or on whatever `X-Forwarded-Host` a viewer
        // sent. This viewer-request function sets it, and its port, from the request CloudFront received
        // (src/forwarded-host.js). A viewer-request CloudFront Function beside an origin-request Lambda@Edge is a
        // combination CloudFront allows on one behavior.
        const forwardedHost = new aws_cloudfront.Function(this, 'ForwardedHost', {
            runtime: aws_cloudfront.FunctionRuntime.JS_2_0,
            code: aws_cloudfront.FunctionCode.fromInline(FORWARDED_HOST_SOURCE),
            comment: `${slug}: x-forwarded-host and x-forwarded-port from the viewer's request`,
        })

        // ---- cloudfront ---------------------------------------------------------------------
        // First deploys ride *.cloudfront.net; custom domains + certs are cutover row
        // `domains-and-certs`. Every behavior redirects plain HTTP to HTTPS.
        const distribution = new aws_cloudfront.Distribution(this, 'Distribution', {
            defaultBehavior: {
                // withOriginAccessControl, not the plain constructor: it creates the OAC and grants
                // this distribution — and only this distribution — permission to invoke the URL.
                origin: aws_cloudfront_origins.FunctionUrlOrigin.withOriginAccessControl(functionUrl),
                viewerProtocolPolicy: aws_cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
                allowedMethods: aws_cloudfront.AllowedMethods.ALLOW_ALL,
                cachePolicy: aws_cloudfront.CachePolicy.CACHING_DISABLED,
                originRequestPolicy: aws_cloudfront.OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER,
                functionAssociations: [
                    { function: forwardedHost, eventType: aws_cloudfront.FunctionEventType.VIEWER_REQUEST },
                ],
                edgeLambdas: [
                    {
                        functionVersion: bodyHash,
                        eventType: aws_cloudfront.LambdaEdgeEventType.ORIGIN_REQUEST,
                        includeBody: true,
                    },
                ],
            },
            additionalBehaviors: {
                '/_next/static/*': {
                    origin: aws_cloudfront_origins.S3BucketOrigin.withOriginAccessControl(assetsBucket),
                    viewerProtocolPolicy: aws_cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
                    cachePolicy: aws_cloudfront.CachePolicy.CACHING_OPTIMIZED,
                },
                '/assets/*': {
                    origin: aws_cloudfront_origins.S3BucketOrigin.withOriginAccessControl(assetsBucket),
                    viewerProtocolPolicy: aws_cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
                    cachePolicy: aws_cloudfront.CachePolicy.CACHING_OPTIMIZED,
                },
            },
        })

        // ---- scheduled-work tick (cutover `scheduled-tick`) ------------------------------
        // The scheduled-jobs due-scan is driven by an EventBridge Scheduler schedule
        // POSTing `/api/webhooks/cron` on a fixed cadence with `Authorization: Bearer $WEBHOOK_SECRET`
        // (the same shared secret as `job-runner`). It is NOT authored here on purpose: the only
        // clean primitive for "POST an arbitrary HTTPS URL with an auth header" is an EventBridge API
        // Destination + Connection, which depends on the WEBHOOK_SECRET Secrets Manager resource that
        // lands with `job-runner` — authoring it half-wired would break `cdk synth`. It rides that
        // secret; see the `scheduled-tick` cutover row for the schedule + connection + verification.

        // ---- basic alarms ---------------------------------------------------------------------
        // Draft thresholds; replaced by the shared monitoring constructs at cutover.
        new aws_cloudwatch.Alarm(this, 'ServerErrorsAlarm', {
            metric: server.metricErrors({ period: cdk.Duration.minutes(5) }),
            threshold: 5,
            evaluationPeriods: 1,
            treatMissingData: aws_cloudwatch.TreatMissingData.NOT_BREACHING,
        })
        new aws_cloudwatch.Alarm(this, 'ServerThrottlesAlarm', {
            metric: server.metricThrottles({ period: cdk.Duration.minutes(5) }),
            threshold: 1,
            evaluationPeriods: 1,
            treatMissingData: aws_cloudwatch.TreatMissingData.NOT_BREACHING,
        })

        // ---- budget guard -------------------------------------------------------------------
        new aws_budgets.CfnBudget(this, 'Budget', {
            budget: {
                budgetName: `${slug}-${props.environment.toLowerCase()}`,
                budgetType: 'COST',
                timeUnit: 'MONTHLY',
                budgetLimit: { amount: 50, unit: 'USD' },
            },
            notificationsWithSubscribers: [
                {
                    notification: {
                        notificationType: 'ACTUAL',
                        comparisonOperator: 'GREATER_THAN',
                        threshold: 80,
                    },
                    // cutover `cloud-accounts`: replace with a real alert address from config/params.ts
                    subscribers: [{ subscriptionType: 'EMAIL', address: 'PLACEHOLDER_BUDGET_ALERT_EMAIL' }],
                },
            ],
        })

        new cdk.CfnOutput(this, 'DistributionDomain', { value: distribution.distributionDomainName })
        new cdk.CfnOutput(this, 'FunctionUrl', { value: functionUrl.url })
        new cdk.CfnOutput(this, 'DbSecretArn', { value: secret.secretArn })
        new cdk.CfnOutput(this, 'DatabaseTransport', { value: transport })

        // ---- the synth assertions ---------------------------------------------------------
        // Validations run inside `app.synth()`, after every construct has had its say, so they read the
        // environment and the bundle as they will be deployed, not as this constructor left them.
        this.node.addValidation({
            validate: () => {
                const environment = renderedProperties(server).Environment?.Variables ?? {}
                const problems = failClosedEnvironmentProblems(environment).map(
                    (problem) => `the server is not fail-closed: ${problem}`,
                )
                // The migrator runs no adapters, but the same switches have no business on it either.
                const migratorEnvironment = renderedProperties(migrator).Environment?.Variables ?? {}
                for (const name of ['DEMO_MODE', 'E2E_BUILD']) {
                    if (name in migratorEnvironment) problems.push(`the migrator's environment sets ${name}`)
                }
                if (cdk.Stack.of(this).bundlingRequired) {
                    const bundle = stagedBundle(migrator)
                    problems.push(
                        ...[
                            ...bundle.problems,
                            ...migratorBundleProblems({ code: bundle.code, ...migratorSource.expected }),
                        ].map((problem) => `the migrator bundle is wrong: ${problem}`),
                    )
                }
                return problems
            },
        })

        this.vpc = vpc
        this.cluster = db
        this.server = server
        this.functionUrl = functionUrl
        this.migrator = migrator
        this.distribution = distribution
        this.forwardedHost = forwardedHost
        this.assetsBucket = assetsBucket
        this.storageBucket = storageBucket
        this.databaseTransport = transport
    }
}
