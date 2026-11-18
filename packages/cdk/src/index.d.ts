import type * as cdk from 'aws-cdk-lib'
import { Construct } from 'constructs'

/** How the app reaches Postgres: the app's `params.database.transport` (ADR-0002, addendum 2026-11-16). */
export type DatabaseTransport = 'pg' | 'data-api'

export interface SssbAppProps {
    /**
     * The app's directory: the one whose `package.json` depends on `@sssb/kit` and whose `src/app-config` is
     * its seam. An app's `infra/app.ts` passes its parent. The construct resolves the framework from here and
     * never from its own location (ADR-0014, rule 4).
     */
    readonly appDir: string
    /** The app's slug (`config/app.ts`'s `APP_SLUG`): the database's name and the budget's prefix. */
    readonly slug: string
    /** The app's deployment params (`config/params.ts`); the construct reads `database.transport`. */
    readonly params: { readonly database: { readonly transport: DatabaseTransport } }
    /** The deployment's name, as the app's own policy spells it (`Staging`, `Production`). */
    readonly environment: string
    /** A production deployment: the database keeps a warm writer and the data stores are retained. */
    readonly production: boolean
}

/**
 * An SSSB app's deployment: the Next standalone server on Lambda behind the Web Adapter and CloudFront, the
 * framework's migrator bundled with the app's own migrations, and Aurora PostgreSQL Serverless v2, in one of
 * two network shapes. Composed inside the adopter's own stack. `cdk synth` fails unless the app's `@sssb/kit`
 * is this construct's version, the server's final environment is fail-closed, and the migrator bundle carries
 * the app's migrations.
 */
export declare class SssbApp extends Construct {
    constructor(scope: Construct, id: string, props: SssbAppProps)
    readonly vpc: cdk.aws_ec2.Vpc
    readonly cluster: cdk.aws_rds.DatabaseCluster
    readonly server: cdk.aws_lambda.Function
    readonly functionUrl: cdk.aws_lambda.FunctionUrl
    readonly migrator: cdk.aws_lambda_nodejs.NodejsFunction
    readonly distribution: cdk.aws_cloudfront.Distribution
    readonly assetsBucket: cdk.aws_s3.Bucket
    readonly storageBucket: cdk.aws_s3.Bucket
    readonly databaseTransport: DatabaseTransport
}
