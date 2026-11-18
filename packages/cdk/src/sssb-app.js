// @ts-check
import { existsSync, readFileSync, realpathSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
// A namespace import, never a default one: aws-cdk-lib is CommonJS, and a loader that compiles this file to
// CommonJS (tsx, under an app whose infra has no `"type": "module"`) hands it `module.exports` with no `default`.
import * as cdk from 'aws-cdk-lib'
import { Construct } from 'constructs'
import { failClosedEnvironmentProblems, migratorBundleProblems } from '@sssb/tools/assembly-checks'
import { kitDirOf, kitVersionOf, resolveAppsKit } from '@sssb/tools/kit'

const { aws_budgets, aws_cloudfront, aws_cloudfront_origins, aws_cloudwatch, aws_ec2, aws_lambda } = cdk
const { aws_lambda_nodejs, aws_rds, aws_s3 } = cdk

const HERE = path.dirname(fileURLToPath(import.meta.url))

/** This package's own version: the one `@sssb/kit` version the construct was released with (rule 4). */
const OWN_VERSION = /** @type {{ version: string }} */ (
    JSON.parse(readFileSync(path.join(HERE, '../package.json'), 'utf8'))
).version

const TRANSPORTS = /** @type {const} */ (['pg', 'data-api'])

/**
 * The framework's migration registry and the migrator entry, as paths inside the `@sssb/kit` an app resolves.
 * They are not published subpaths a resolver could ask for by name, so they are named here; the version check
 * below is what makes naming them safe, since this construct is released with that one layout.
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
 * The app's own migrations, by the names its registry gives them (the keys Kysely records), read from the
 * app seam's migration index rather than guessed from file names.
 * @param {string} index
 * @returns {string[]}
 */
function seamMigrationNames(index) {
    return [...readFileSync(index, 'utf8').matchAll(/['"](\d+_[^'"]+)['"]\s*:/g)].map(
        (match) => /** @type {string} */ (match[1]),
    )
}

/**
 * The framework's migrator for one app, resolved from the app's directory, never from this package (rule 4):
 * the entry esbuild bundles, the app's seam it aliases, and what the bundle must then contain.
 * @param {string} appDir
 */
function resolveMigrator(appDir) {
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
    const lockFile = lockFileAbove(appDir)
    const projectRoot = path.dirname(lockFile)
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
            migrations: seamMigrationNames(seamIndex),
        },
    }
}

/**
 * A function's final environment as it will be deployed: the rendered CloudFormation, escape-hatch overrides
 * included, with every token the stack can resolve resolved.
 * @param {cdk.aws_lambda.Function} fn
 * @returns {Record<string, unknown>}
 */
function finalEnvironment(fn) {
    const cfn = /** @type {any} */ (fn.node.defaultChild)
    if (typeof cfn?._toCloudFormation !== 'function') {
        throw new Error(`SssbApp: cannot render ${fn.node.path}'s CloudFormation to check its environment`)
    }
    const rendered = cdk.Stack.of(fn).resolve(cfn._toCloudFormation())
    const resource = /** @type {{ Properties?: { Environment?: { Variables?: Record<string, unknown> } } }} */ (
        Object.values(rendered.Resources ?? {})[0] ?? {}
    )
    return resource.Properties?.Environment?.Variables ?? {}
}

/**
 * The code esbuild staged for a NodejsFunction during this synth, or `undefined` when there is none.
 * @param {cdk.aws_lambda.Function} fn
 * @returns {string | undefined}
 */
function stagedBundle(fn) {
    const stage = /** @type {{ absoluteStagedPath?: unknown } | undefined} */ (
        fn.node.tryFindChild('Code')?.node.tryFindChild('Stage')
    )
    const dir = stage?.absoluteStagedPath
    if (typeof dir !== 'string') return undefined
    const file = ['index.mjs', 'index.js'].map((name) => path.join(dir, name)).find((name) => existsSync(name))
    return file === undefined ? undefined : readFileSync(file, 'utf8')
}

/**
 * An SSSB app's deployment (ADR-0001, ADR-0014 part 8): the Next standalone server in one Lambda behind the
 * AWS Lambda Web Adapter, its Function URL behind CloudFront with static assets from S3, the framework's
 * migrator bundled with the app's own migrations, and Aurora PostgreSQL Serverless v2. A construct, not a
 * stack: the adopter composes it inside a stack of their own, beside their own constructs.
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
 * AT SYNTH it asserts, and `cdk synth` fails otherwise:
 * - that the `@sssb/kit` the app resolves is this construct's own version (at construction);
 * - that the server's final environment is fail-closed: `APP_MODE` is `real`, and neither `DEMO_MODE` nor
 *   `E2E_BUILD` is present, overrides included;
 * - that the migrator's bundle carries the app's own migrations, built from the app's seam and no test
 *   fixture (when this synth bundles the stack at all: `cdk deploy OtherStack` skips it).
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

        const appDir = path.resolve(props.appDir)
        const slug = props.slug
        if (!/^[a-z][a-z0-9-]*$/.test(slug ?? '')) {
            throw new Error(`SssbApp: slug must be lowercase letters, digits and dashes (got "${String(slug)}")`)
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
        const isProd = props.production === true
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
            defaultDatabaseName: slug,
            storageEncrypted: true,
            removalPolicy,
        })
        const secret = /** @type {cdk.aws_secretsmanager.ISecret} */ (db.secret)

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
                  DATABASE_NAME: slug,
              }
            : {
                  DATABASE_TRANSPORT: 'pg',
                  // DRAFT: built via CFN dynamic references so the server
                  // can actually boot; revisit with the shared secrets constructs at cutover
                  // (env-var exposure vs runtime secret fetch).
                  DATABASE_URL: `postgres://${secret.secretValueFromJson('username').unsafeUnwrap()}:${secret
                      .secretValueFromJson('password')
                      .unsafeUnwrap()}@${db.clusterEndpoint.socketAddress}/${slug}`,
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
            environment: dataApi ? databaseEnv : { DATABASE_TRANSPORT: 'pg', DB_SECRET_ARN: secret.secretArn },
            bundling: {
                format: aws_lambda_nodejs.OutputFormat.ESM,
                // pg's optional native/cloudflare shims must stay external or esbuild chokes
                externalModules: ['@aws-sdk/*', 'pg-native', 'cloudflare:sockets'],
                esbuildArgs: { '--alias:@sssb/app-config': migratorSource.seamDir },
            },
        })
        grantDatabase(migrator)

        // ---- cloudfront ---------------------------------------------------------------------
        // First deploys ride *.cloudfront.net; custom domains + certs are cutover row
        // `domains-and-certs`.
        const distribution = new aws_cloudfront.Distribution(this, 'Distribution', {
            defaultBehavior: {
                // withOriginAccessControl, not the plain constructor: it creates the OAC and grants
                // this distribution — and only this distribution — permission to invoke the URL.
                origin: aws_cloudfront_origins.FunctionUrlOrigin.withOriginAccessControl(functionUrl),
                viewerProtocolPolicy: aws_cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
                allowedMethods: aws_cloudfront.AllowedMethods.ALLOW_ALL,
                cachePolicy: aws_cloudfront.CachePolicy.CACHING_DISABLED,
                originRequestPolicy: aws_cloudfront.OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER,
            },
            additionalBehaviors: {
                '/_next/static/*': {
                    origin: aws_cloudfront_origins.S3BucketOrigin.withOriginAccessControl(assetsBucket),
                    cachePolicy: aws_cloudfront.CachePolicy.CACHING_OPTIMIZED,
                },
                '/assets/*': {
                    origin: aws_cloudfront_origins.S3BucketOrigin.withOriginAccessControl(assetsBucket),
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
                const problems = failClosedEnvironmentProblems(finalEnvironment(server)).map(
                    (problem) => `the server is not fail-closed: ${problem}`,
                )
                if (cdk.Stack.of(this).bundlingRequired) {
                    problems.push(
                        ...migratorBundleProblems({ code: stagedBundle(migrator), ...migratorSource.expected }).map(
                            (problem) => `the migrator bundle is wrong: ${problem}`,
                        ),
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
        this.assetsBucket = assetsBucket
        this.storageBucket = storageBucket
        this.databaseTransport = transport
    }
}
