// @ts-check
// Checks over a synthesized CloudFormation assembly: pure functions over the template's `Resources` and over
// the Lambda bundles staged on disk, so an adopter whose infra does not use SSSB's construct can run them on
// their own assembly. This package never imports `@sssb/kit` and has no dependency on aws-cdk-lib.
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'

/** @typedef {import('./assembly-checks.d.ts').Resources} Resources */
/** @typedef {import('./assembly-checks.d.ts').Resource} Resource */
/** @typedef {{ Effect?: unknown, Action?: unknown, NotAction?: unknown, Resource?: unknown }} Statement */

/**
 * The code staged for each Lambda whose asset has an `index.mjs` or `index.js`, keyed by logical id. For
 * a NodejsFunction that is what esbuild produced during the synth, with the tsconfig the stack passed, not a
 * re-creation of it. CDK's own provider handler ships a ready-made `index.js`, and is read like any other. A
 * placeholder asset with neither is left out.
 * @type {import('./assembly-checks.d.ts').lambdaBundles}
 */
export function lambdaBundles(resources, assemblyDir) {
    /** @type {Map<string, string>} */
    const found = new Map()
    for (const [id, r] of Object.entries(resources)) {
        if (r.Type !== 'AWS::Lambda::Function') continue
        const key = /** @type {{ S3Key?: unknown } | undefined} */ (r.Properties?.Code)?.S3Key
        if (typeof key !== 'string') continue
        const staged = path.join(assemblyDir, `asset.${key.replace(/\.zip$/, '')}`)
        const entry = ['index.mjs', 'index.js'].map((file) => path.join(staged, file)).find((file) => existsSync(file))
        if (entry) found.set(id, readFileSync(entry, 'utf8'))
    }
    return found
}

/** @type {import('./assembly-checks.d.ts').lambdaFunction} */
export function lambdaFunction(resources, namePrefix) {
    const found = Object.entries(resources).find(
        ([id, r]) => r.Type === 'AWS::Lambda::Function' && id.startsWith(namePrefix) && !id.includes('Provider'),
    )
    if (!found) throw new Error(`no ${namePrefix} function in the synthesized stack`)
    const props = found[1].Properties ?? {}
    const variables = /** @type {{ Variables?: Record<string, unknown> } | undefined} */ (props.Environment)?.Variables
    return { id: found[0], inVpc: props.VpcConfig !== undefined, env: variables ?? {} }
}

/**
 * Requiring the path comments makes the check fail CLOSED: a minified bundle carries no such comments, and
 * so fails here instead of passing every check that reads them.
 * @type {import('./assembly-checks.d.ts').migratorBundleProblems}
 */
export function migratorBundleProblems({ code, sources, migrations }) {
    if (code === undefined) return ['the migrator is not bundled by this synth']
    /** @type {string[]} */
    const problems = []
    if (code.includes('test-fixture')) problems.push('the migrator’s bundle holds code from a test-fixture directory')
    for (const source of sources) {
        if (!code.includes(`// ${source}\n`)) {
            problems.push(`the migrator's bundle names ${source} (an unminified bundle, built from the app's seam)`)
        }
    }
    for (const name of migrations) {
        if (!code.includes(`"${name}"`)) problems.push(`the migrator's bundle carries the app's migration ${name}`)
    }
    return problems
}

/**
 * The server must come up in `real` mode and carry no switch that turns on simulated or e2e behaviour. The
 * absence of the other two is judged by presence, not value: `DEMO_MODE: 'false'` is still a switch a later
 * change could flip.
 * @type {import('./assembly-checks.d.ts').failClosedEnvironmentProblems}
 */
export function failClosedEnvironmentProblems(env) {
    /** @type {string[]} */
    const problems = []
    if (env.APP_MODE !== 'real') problems.push(`APP_MODE is ${JSON.stringify(env.APP_MODE)}, not 'real'`)
    for (const name of ['DEMO_MODE', 'E2E_BUILD']) {
        if (name in env) problems.push(`${name} is set in the final environment`)
    }
    return problems
}

/**
 * The permission documents a resource carries: a policy's, a managed policy's, or a role's inline ones.
 * @param {Resource} resource
 * @returns {unknown[]}
 */
function policyDocuments(resource) {
    if (resource.Type === 'AWS::IAM::Policy' || resource.Type === 'AWS::IAM::ManagedPolicy') {
        return [resource.Properties?.PolicyDocument]
    }
    if (resource.Type === 'AWS::IAM::Role') {
        const inline = /** @type {{ PolicyDocument?: unknown }[] | undefined} */ (resource.Properties?.Policies) ?? []
        return inline.map((policy) => policy.PolicyDocument)
    }
    return []
}

/**
 * Whether an IAM action pattern can name one of `service`'s actions. IAM matches `*` and `?` anywhere in
 * an action, so `*`, `rds-data:*` and `rds*:Execute*` all reach `rds-data:ExecuteStatement`.
 * @param {string} action
 * @param {string} service
 */
function reaches(action, service) {
    const prefix = action.includes(':') ? action.slice(0, action.indexOf(':')) : action
    const pattern = prefix
        .replace(/[.+^${}()|[\]\\]/g, '\\$&')
        .replace(/\*/g, '.*')
        .replace(/\?/g, '.')
    return new RegExp(`^${pattern}$`, 'i').test(service)
}

/**
 * Every Allow statement in the stack's IAM policies, managed policies and roles' inline policies that can
 * grant one of `service`'s actions (`rds-data`, `secretsmanager`): by naming one, by a wildcard that
 * reaches one (`*` reaches every service), or by `NotAction`, which grants everything it does not name.
 * Roles' trust policies grant nothing and are not read.
 * @param {Resources} all
 * @param {string} service
 * @returns {Statement[]}
 */
function grantsOf(all, service) {
    return Object.values(all)
        .flatMap(policyDocuments)
        .flatMap(
            (document) =>
                /** @type {Statement[]} */ (
                    /** @type {{ Statement?: unknown[] } | undefined} */ (document)?.Statement ?? []
                ),
        )
        .filter((s) => s.Effect !== 'Deny')
        .filter((s) => {
            if (s.NotAction !== undefined) return true
            const actions = Array.isArray(s.Action) ? s.Action : [s.Action]
            return actions.some((action) => typeof action === 'string' && reaches(action, service))
        })
}

/**
 * The AWS-managed policies a role may attach: the check cannot read their contents, so it allows only the
 * two Lambda execution policies CDK attaches (logs, and network interfaces on `pg`), which grant neither
 * service. A managed policy defined in the stack is read like any other (grantsOf).
 */
const KNOWN_AWS_POLICIES = ['service-role/AWSLambdaBasicExecutionRole', 'service-role/AWSLambdaVPCAccessExecutionRole']

/**
 * @param {Resources} all
 * @returns {string[]}
 */
function unreadablePolicies(all) {
    const inStack = new Set(
        Object.entries(all)
            .filter(([, r]) => r.Type === 'AWS::IAM::ManagedPolicy')
            .map(([id]) => id),
    )
    return Object.entries(all)
        .filter(([, r]) => r.Type === 'AWS::IAM::Role')
        .flatMap(([id, r]) =>
            /** @type {unknown[] | undefined} */ ((r.Properties?.ManagedPolicyArns) ?? [])
                .filter((arn) => {
                    const text = JSON.stringify(arn)
                    const ref = /** @type {{ Ref?: string }} */ (arn).Ref
                    if (ref !== undefined && inStack.has(ref)) return false
                    return !KNOWN_AWS_POLICIES.some((name) =>
                        new RegExp(`:iam::aws:policy/${name}"[\\]}]*$`).test(text),
                    )
                })
                .map((arn) => `${id}: ${JSON.stringify(arn)}`),
        )
}

/**
 * The cluster's own secret: the attachment CDK makes for the cluster, and the secret it attaches.
 * @param {Resources} all
 * @param {string} clusterId
 * @returns {string[]}
 */
function databaseSecretIds(all, clusterId) {
    return Object.entries(all)
        .filter(
            ([, r]) =>
                r.Type === 'AWS::SecretsManager::SecretTargetAttachment' &&
                JSON.stringify(r.Properties?.TargetId) === JSON.stringify({ Ref: clusterId }),
        )
        .flatMap(([id, r]) => {
            const secret = /** @type {{ Ref?: string } | undefined} */ (r.Properties?.SecretId)?.Ref
            return secret ? [id, secret] : [id]
        })
}

/**
 * Whether every resource `statement` grants refers to one of `ids`, and none is a wildcard.
 * @param {Statement} statement
 * @param {readonly string[]} ids
 */
function namesOnly(statement, ids) {
    const granted = Array.isArray(statement.Resource) ? statement.Resource : [statement.Resource ?? '*']
    return granted.every((resource) => {
        const text = JSON.stringify(resource)
        return !text.includes('*') && ids.some((id) => text.includes(`"Ref":"${id}"`))
    })
}

/**
 * The template's database cluster, by logical id. Throws when there is none: every check that reasons about
 * "the cluster's own" anything is meaningless without one.
 * @param {Resources} all
 * @returns {[string, Resource]}
 */
function clusterOf(all) {
    const found = Object.entries(all).find(([, r]) => r.Type === 'AWS::RDS::DBCluster')
    if (!found) throw new Error('no AWS::RDS::DBCluster in the synthesized stack')
    return found
}

/** @type {import('./assembly-checks.d.ts').secretGrantProblems} */
export function secretGrantProblems(resources) {
    const [clusterId] = clusterOf(resources)
    /** @type {string[]} */
    const problems = []
    // The database secret is read by name, on every shape: never a wildcard, never another secret.
    const secretIds = databaseSecretIds(resources, clusterId)
    const secretGrants = grantsOf(resources, 'secretsmanager')
    if (!(secretIds.length > 0 && secretGrants.length > 0 && secretGrants.every((s) => namesOnly(s, secretIds)))) {
        problems.push('every Secrets Manager grant names the cluster’s own secret alone')
    }
    const unreadable = unreadablePolicies(resources)
    if (unreadable.length > 0) {
        problems.push(`no role attaches an AWS-managed policy the check cannot read: ${unreadable.join('; ')}`)
    }
    return problems
}

/** @type {import('./assembly-checks.d.ts').dataApiShapeProblems} */
export function dataApiShapeProblems(resources) {
    const [clusterId, cluster] = clusterOf(resources)
    /** @type {string[]} */
    const problems = secretGrantProblems(resources)
    // Every statement that can grant a Data API action (see grantsOf) names this cluster, and nothing
    // wider: the grant plus the secret is the whole way in on this shape.
    const dataApiGrants = grantsOf(resources, 'rds-data')
    if (!dataApiGrants.some((s) => JSON.stringify(s.Action).includes('rds-data:ExecuteStatement'))) {
        problems.push('a role is granted rds-data:ExecuteStatement')
    }
    if (!dataApiGrants.every((s) => namesOnly(s, [clusterId]))) {
        problems.push('every rds-data grant is scoped to this cluster alone')
    }
    // Nothing reaches the database over the network on this shape: its security group admits nobody.
    const dbGroups = JSON.stringify(cluster.Properties?.VpcSecurityGroupIds ?? [])
    const ingress = Object.entries(resources).filter(
        ([id, r]) =>
            (r.Type === 'AWS::EC2::SecurityGroupIngress' &&
                dbGroups.includes(JSON.stringify(r.Properties?.GroupId ?? null))) ||
            (r.Type === 'AWS::EC2::SecurityGroup' &&
                dbGroups.includes(`"${id}"`) &&
                /** @type {unknown[] | undefined} */ ((r.Properties?.SecurityGroupIngress) ?? []).length > 0),
    )
    if (ingress.length > 0) problems.push('the database security group admits no inbound traffic')
    return problems
}
