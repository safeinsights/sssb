/** One resource of a synthesized CloudFormation template. */
export type Resource = { Type: string; Properties?: Record<string, unknown> }

/** A synthesized template's `Resources`, keyed by logical id. */
export type Resources = Record<string, Resource>

/** A Lambda function as the checks read it: its logical id, whether it runs in a VPC, and its environment. */
export type LambdaFunction = { id: string; inVpc: boolean; env: Record<string, unknown> }

/** What a migrator bundle must carry, see `migratorBundleProblems`. */
export type MigratorBundleExpectation = {
    /** The bundle's text, or `undefined` when no bundle was staged for the migrator. */
    code: string | undefined
    /** Module paths the bundle must name as esbuild path comments (`// <path>` on a line of its own). */
    sources: readonly string[]
    /** Migration names the bundle must carry, each as a quoted string (the keys Kysely records). */
    migrations: readonly string[]
}

/**
 * The staged code (`index.mjs` or `index.js`) of each Lambda whose asset has one, keyed by logical id, read
 * from the synthesized assembly directory. A Lambda whose asset has neither is left out.
 */
export declare function lambdaBundles(resources: Resources, assemblyDir: string): Map<string, string>

/**
 * The first Lambda function whose logical id starts with `namePrefix`, ignoring CDK's own provider
 * functions. Throws when there is none, so a renamed function fails loudly rather than skipping its checks.
 */
export declare function lambdaFunction(resources: Resources, namePrefix: string): LambdaFunction

/**
 * Problems with a migrator bundle: missing, minified (names none of the `sources`), lacking one of the
 * app's `migrations`, or holding code from a `test-fixture` directory. Empty means it passes.
 */
export declare function migratorBundleProblems(expected: MigratorBundleExpectation): string[]

/**
 * Problems with a function's final environment that break the production fail-closed contract:
 * `APP_MODE` must be exactly `'real'`, and neither `DEMO_MODE` nor `E2E_BUILD` may be present at all,
 * whatever their value.
 */
export declare function failClosedEnvironmentProblems(env: Record<string, unknown>): string[]

/**
 * Problems with Secrets Manager and managed-policy grants: every Secrets Manager grant names only the
 * cluster's own secret, and no role attaches an AWS-managed policy the check cannot read. Needs the one
 * `AWS::RDS::DBCluster` in the template; runs on every database shape.
 */
export declare function secretGrantProblems(resources: Resources): string[]

/**
 * Problems with the Data API shape's access paths: a role is granted `rds-data:ExecuteStatement`, every
 * statement that can grant an `rds-data` action is scoped to the cluster alone, the Secrets Manager checks
 * of `secretGrantProblems`, and the database security group admits no inbound traffic.
 */
export declare function dataApiShapeProblems(resources: Resources): string[]
