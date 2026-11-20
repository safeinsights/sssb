import type * as cdk from 'aws-cdk-lib'
import { Construct } from 'constructs'

/**
 * The database an app's slug names: the slug with each dash as an underscore, since Aurora PostgreSQL's database
 * name may hold only letters, digits and underscores (`acme-corp` → `acme_corp`; `showcase` stays `showcase`). Throws
 * for a string that is not a slug, one over 63 characters, or one whose name the engine reserves (`user`, `select`,
 * `rdsadmin`, …). An adopter's own infra that does not use `SssbApp` names its database with this too.
 */
export declare function databaseNameFor(slug: string): string

/** How the app reaches Postgres: the app's `params.database.transport` (ADR-0002, addendum 2026-11-16). */
export type DatabaseTransport = 'pg' | 'data-api'

/**
 * Which of SSSB's optional ports the app uses: the app's `params.ports`. The construct sets each one given as the
 * server's switch (`LLM_PROVIDER`, `EMAIL_PROVIDER`, `INBOUND_EMAIL_PROVIDER`, `JOBS_RUNNER`, `STORAGE_PROVIDER`); a
 * port left out keeps the framework's default (the first choice of each). `none` makes the port absent: its settings
 * are not required, and a call through it fails naming the switch. `jobs: 'in-process'` runs each job's handler in the
 * server, with no CodeBuild project. `storage: 's3'` (or left out) builds the storage bucket; `'s3-compatible'` (Cloudflare R2,
 * MinIO, Backblaze B2) and `'none'` build none and grant no S3 access: the deployment sets the compatible store's
 * `STORAGE_*` settings on the server itself (`app.server`).
 */
export interface OptionalPorts {
    readonly llm?: 'anthropic' | 'none'
    readonly email?: 'mailgun' | 'none'
    readonly inboundEmail?: 'mailgun' | 'none'
    readonly jobs?: 'codebuild' | 'in-process' | 'none'
    readonly storage?: 's3' | 's3-compatible' | 'none'
}

/**
 * How the auth adapter places a signed-in person: the app's `params.auth`. The construct sets `AUTH_TENANCY` and the
 * settings each tenancy reads; left out, the framework takes multi-tenant auth with the `tenantSlug` metadata key.
 * `single` places every user the identity provider signs in in `tenantSlug` and `homeOrgSlug`, with role `none`, which
 * grants nothing a membership would; on a provider instance shared with another product, its users all sign in.
 */
export type AuthTenancyParams =
    | { readonly tenancy?: 'multi'; readonly tenantMetadataKey?: string }
    | {
          readonly tenancy: 'single'
          readonly tenantSlug: string
          readonly homeOrgSlug: string
          readonly tenantMetadataKey?: string
      }

/** The scheduled tick: what runs the app's scheduled work (its cron route) in the deployment. */
export interface ScheduledTickProps {
    /**
     * The secret the server's `WEBHOOK_SECRET` holds, a plain string, which the tick sends to the cron route. The
     * construct never puts its value in an environment: the tick's function reads it on each run.
     */
    readonly webhookSecret: cdk.aws_secretsmanager.ISecret
    /** How often the tick runs, in whole minutes: 5 minutes when left out. */
    readonly every?: cdk.Duration
}

export interface SssbAppProps {
    /**
     * The app's directory: the one whose `package.json` depends on `@sssb/kit` and whose `src/app-config` is
     * its seam. An app's `infra/app.ts` passes its parent. The construct resolves the framework from here and
     * never from its own location (ADR-0014, rule 4).
     */
    readonly appDir: string
    /**
     * The app's slug (`config/app.ts`'s `APP_SLUG`): the budget's prefix, and the database's name with each dash as an
     * underscore (`databaseNameFor`).
     */
    readonly slug: string
    /** The app's deployment params (`config/params.ts`); the construct reads `database.transport` and `ports`. */
    readonly params: {
        readonly database: { readonly transport: DatabaseTransport }
        readonly ports?: OptionalPorts
        readonly auth?: AuthTenancyParams
    }
    /** The deployment's name, as the app's own policy spells it (`Staging`, `Production`). */
    readonly environment: string
    /** A production deployment: the database keeps a warm writer and the data stores are retained. */
    readonly production: boolean
    /**
     * Send `Strict-Transport-Security` with `includeSubDomains` (default false). It binds every subdomain of the host
     * the app is served on to HTTPS for the header's year, so set it only when all of them serve HTTPS. It needs a
     * custom response headers policy, one of the account's 20, where the default is AWS's managed
     * SecurityHeadersPolicy, which takes none. Not allowed beside `responseHeadersPolicy`, which sets its own.
     */
    readonly hstsIncludeSubdomains?: boolean
    /**
     * A response headers policy of your own, on the three behaviors this construct builds in place of SSSB's (AWS's
     * managed SecurityHeadersPolicy). It replaces all of it: HSTS, nosniff, the referrer policy and frame options come
     * from your policy or not at all. A behavior you add to the distribution yourself gets no policy unless you give
     * it one: the construct exposes the policy in use as `responseHeadersPolicy`.
     */
    readonly responseHeadersPolicy?: cdk.interfaces.aws_cloudfront.IResponseHeadersPolicyRef
    /**
     * Run the app's scheduled work: an EventBridge rule that POSTs the app's cron route with the webhook secret, by
     * invoking the server directly. Left out, nothing in the deployment ticks it.
     */
    readonly scheduledTick?: ScheduledTickProps
}

/**
 * An SSSB app's deployment: the Next standalone server on Lambda behind the Web Adapter and CloudFront, the
 * framework's migrator bundled with the app's own migrations, and Aurora PostgreSQL Serverless v2, in one of
 * two network shapes. Composed inside the adopter's own stack. Its Lambda@Edge function (the request body's hash)
 * lives in us-east-1: an environment-agnostic stack deploys there only; give the stack an explicit region to deploy
 * elsewhere, and the function gets a us-east-1 stack of its own. `cdk synth` fails unless, among other checks
 * (`sssb-app.js` lists them all), the app's `@sssb/kit` is this construct's version, the server's final
 * environment is fail-closed, and the migrator deploys the bundle this synth staged, carrying the app's
 * migrations.
 */
export declare class SssbApp extends Construct {
    constructor(scope: Construct, id: string, props: SssbAppProps)
    readonly vpc: cdk.aws_ec2.Vpc
    readonly cluster: cdk.aws_rds.DatabaseCluster
    readonly server: cdk.aws_lambda.Function
    readonly functionUrl: cdk.aws_lambda.FunctionUrl
    readonly migrator: cdk.aws_lambda_nodejs.NodejsFunction
    readonly distribution: cdk.aws_cloudfront.Distribution
    /**
     * The viewer-request CloudFront Function that gives the server the host the viewer asked for
     * (`x-forwarded-host`, `x-forwarded-port`), overwriting what the viewer sent. Associate it with any behavior of
     * your own that reaches the server.
     */
    readonly forwardedHost: cdk.aws_cloudfront.Function
    /**
     * The response headers policy on the three behaviors this construct builds: AWS's managed SecurityHeadersPolicy,
     * the one `hstsIncludeSubdomains` builds, or the one passed as `responseHeadersPolicy`. Give it to any behavior
     * you add.
     */
    readonly responseHeadersPolicy: cdk.interfaces.aws_cloudfront.IResponseHeadersPolicyRef
    readonly assetsBucket: cdk.aws_s3.Bucket
    /** The app's object storage, the `storage` port's bucket: none unless `params.ports.storage` is `s3` or left out. */
    readonly storageBucket: cdk.aws_s3.Bucket | undefined
    readonly databaseTransport: DatabaseTransport
    /** The scheduled tick's function, when `scheduledTick` is given. */
    readonly scheduledTick: cdk.aws_lambda.Function | undefined
}
