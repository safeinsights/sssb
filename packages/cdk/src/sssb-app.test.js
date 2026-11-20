// @ts-check
// SssbApp, synthesized for real: both network shapes for every app in this repository that has an `infra/`
// (what `infra/check-shapes.ts` did for the root stack, jpslav/keel#49 and #54), the production fail-closed
// environment (moved here from packages/kit's production-guard test, which read the old stack's source), and
// each synth assertion the construct makes, seen to FAIL on the thing it guards. Offline, like synth: nothing
// is deployed and no credentials are read.
import { Buffer } from 'node:buffer'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath, pathToFileURL } from 'node:url'
import vm from 'node:vm'
import * as cdk from 'aws-cdk-lib'
import { Template } from 'aws-cdk-lib/assertions'
import { afterAll, describe, expect, it } from 'vitest'
import { makeTestTmpDir } from '../../../tests/support/tmp-dir'
import { dataApiShapeProblems, lambdaBundles, lambdaFunction, secretGrantProblems } from '@sssb/tools/assembly-checks'
import { kitDirOf } from '@sssb/tools/kit'
import { handler as bodyHashHandler } from './assets/body-hash/index.mjs'
import { FORWARDED_HOST_SOURCE } from './forwarded-host.js'
import { databaseNameFor, SssbApp } from './index.js'
import { AUTH_ORG_SOURCE_CHOICES, AUTH_TENANCY_CHOICES, FIXED_ORG_ROLES } from './auth-tenancy.js'
import { PORT_SWITCHES } from './optional-ports.js'
import { HSTS_MAX_AGE_SECONDS, MANAGED_SECURITY_HEADERS_POLICY_ID, toolsVersionProblem } from './sssb-app.js'

/** @typedef {import('@sssb/tools/assembly-checks').Resources} Resources */
/** @typedef {'pg' | 'data-api'} Transport */

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const OWN_VERSION = JSON.parse(readFileSync(path.join(REPO, 'packages/cdk/package.json'), 'utf8')).version

/** Every app here with a deployment of its own: discovered, so an app added or ejected is covered. */
const APPS = readdirSync(path.join(REPO, 'apps')).filter((app) =>
    existsSync(path.join(REPO, 'apps', app, 'infra/package.json')),
)

/**
 * One SssbApp in a stack of its own, in an assembly directory this test owns. `configure` runs after the
 * construct and before synth, as an adopter's own code would. `region` gives the stack an explicit one; left out,
 * the stack is environment-agnostic, as the starter's is until cutover.
 * @param {{
 *   appDir: string, slug: string, transport: Transport, bundle?: boolean, production?: boolean, region?: string,
 *   configure?: (app: SssbApp) => void,
 *   ports?: import('./index.d.ts').OptionalPorts,
 *   auth?: import('./index.d.ts').AuthTenancyParams,
 *   scheduledTick?: (stack: cdk.Stack) => import('./index.d.ts').ScheduledTickProps,
 * }} options
 */
function synthesize({
    appDir,
    slug,
    transport,
    bundle = true,
    production = false,
    region,
    configure,
    ports,
    auth,
    scheduledTick,
}) {
    const outdir = makeTestTmpDir('sssb-cdk-')
    const context = bundle ? {} : { 'aws:cdk:bundling-stacks': [] }
    const app = new cdk.App({ outdir, context })
    const stack = new cdk.Stack(app, `ShapeCheck-${transport}`, region === undefined ? {} : { env: { region } })
    const construct = new SssbApp(stack, 'Default', {
        appDir,
        slug,
        params: { database: { transport }, ...(ports && { ports }), ...(auth && { auth }) },
        environment: production ? 'Production' : 'Staging',
        production,
        ...(scheduledTick && { scheduledTick: scheduledTick(stack) }),
    })
    configure?.(construct)
    const assembly = app.synth()
    const all = /** @type {Resources} */ (Template.fromStack(stack).toJSON()['Resources'])
    return { all, assembly: assembly.directory, stacks: assembly.stacks }
}

/**
 * What is wrong with how viewers reach the distribution, or nothing: no behavior takes plain HTTP, and every behavior
 * whose origin is the server's Function URL runs the forwarded-host CloudFront Function on the viewer request, that
 * function being `FORWARDED_HOST_SOURCE` on the JS 2.0 runtime.
 * @param {Resources} all
 * @returns {string[]}
 */
function viewerProblems(all) {
    /** @type {string[]} */
    const problems = []
    const distributions = Object.values(all).filter((r) => r.Type === 'AWS::CloudFront::Distribution')
    if (distributions.length !== 1) return [`one distribution, not ${distributions.length}`]
    const config = /** @type {any} */ (distributions[0]?.Properties)?.DistributionConfig
    const behaviors = [config?.DefaultCacheBehavior, ...(config?.CacheBehaviors ?? [])]
    for (const b of behaviors) {
        if (!['redirect-to-https', 'https-only'].includes(b?.ViewerProtocolPolicy)) {
            problems.push(`${b?.PathPattern ?? 'the default behavior'} takes plain HTTP (${b?.ViewerProtocolPolicy})`)
        }
    }
    const serverOrigins = new Set(
        (config?.Origins ?? [])
            .filter((/** @type {any} */ o) => JSON.stringify(o.DomainName ?? null).includes('ServerFunctionUrl'))
            .map((/** @type {any} */ o) => o.Id),
    )
    const appBehaviors = behaviors.filter((b) => serverOrigins.has(b?.TargetOriginId))
    if (appBehaviors.length === 0) problems.push('a behavior reaches the server')
    const functions = Object.entries(all).filter(([, r]) => r.Type === 'AWS::CloudFront::Function')
    const forwardedHost = functions.find(
        ([, r]) => /** @type {any} */ (r.Properties)?.FunctionCode === FORWARDED_HOST_SOURCE,
    )
    if (forwardedHost === undefined) return [...problems, 'the forwarded-host function is deployed as its source']
    const [id, fn] = forwardedHost
    if (/** @type {any} */ (fn.Properties)?.FunctionConfig?.Runtime !== 'cloudfront-js-2.0') {
        problems.push('the forwarded-host function runs on cloudfront-js-2.0')
    }
    const arn = JSON.stringify({ 'Fn::GetAtt': [id, 'FunctionARN'] })
    for (const b of appBehaviors) {
        const viewerRequest = (b?.FunctionAssociations ?? []).filter(
            (/** @type {any} */ a) => a.EventType === 'viewer-request',
        )
        if (viewerRequest.length !== 1 || JSON.stringify(viewerRequest[0].FunctionARN) !== arn) {
            problems.push(
                `${b?.PathPattern ?? 'the default behavior'} runs the forwarded-host function on the viewer request`,
            )
        }
    }
    return problems
}

/**
 * What is wrong with the distribution's response headers, or nothing: each of the three behaviors the construct builds
 * carries the one response headers policy `expected` names. By default that is AWS's managed SecurityHeadersPolicy, and
 * the template holds no custom policy. With `includeSubdomains`, it is the one custom policy the template holds: the
 * managed policy's headers (HSTS a year, never preload; nosniff, always sent; strict-origin-when-cross-origin; SAMEORIGIN;
 * no CSP), with HSTS's includeSubDomains. With `ownPolicyId`, it is the adopter's, and the template holds none.
 * @param {Resources} all
 * @param {{ ownPolicyId?: string, includeSubdomains?: boolean }} [expected]
 * @returns {string[]}
 */
function securityHeadersProblems(all, { ownPolicyId, includeSubdomains = false } = {}) {
    /** @type {string[]} */
    const problems = []
    const distributions = Object.values(all).filter((r) => r.Type === 'AWS::CloudFront::Distribution')
    if (distributions.length !== 1) return [`one distribution, not ${distributions.length}`]
    const config = /** @type {any} */ (distributions[0]?.Properties)?.DistributionConfig
    const behaviors = [config?.DefaultCacheBehavior, ...(config?.CacheBehaviors ?? [])]
    if (behaviors.length !== 3) problems.push(`the construct builds three behaviors, not ${behaviors.length}`)
    const policies = Object.entries(all).filter(([, r]) => r.Type === 'AWS::CloudFront::ResponseHeadersPolicy')
    /** @type {unknown} */
    let expectedId
    if (ownPolicyId !== undefined || !includeSubdomains) {
        if (policies.length !== 0) problems.push(`no custom response headers policy, not ${policies.length}`)
        expectedId = ownPolicyId ?? MANAGED_SECURITY_HEADERS_POLICY_ID
    } else {
        if (policies.length !== 1) return [...problems, `one custom response headers policy, not ${policies.length}`]
        const [id, policy] = /** @type {[string, any]} */ (policies[0])
        expectedId = { Ref: id }
        const security = policy.Properties?.ResponseHeadersPolicyConfig?.SecurityHeadersConfig ?? {}
        const hsts = security.StrictTransportSecurity
        if (
            hsts?.AccessControlMaxAgeSec !== HSTS_MAX_AGE_SECONDS ||
            hsts?.IncludeSubdomains !== true ||
            hsts?.Preload !== false ||
            hsts?.Override !== false
        ) {
            problems.push(
                `HSTS max-age=${HSTS_MAX_AGE_SECONDS}; includeSubDomains, no preload, yielding (got ${JSON.stringify(hsts)})`,
            )
        }
        if (security.ContentTypeOptions?.Override !== true)
            problems.push('X-Content-Type-Options: nosniff, always sent')
        if (
            security.ReferrerPolicy?.ReferrerPolicy !== 'strict-origin-when-cross-origin' ||
            security.ReferrerPolicy?.Override !== false
        ) {
            problems.push('Referrer-Policy: strict-origin-when-cross-origin, yielding')
        }
        if (security.FrameOptions?.FrameOption !== 'SAMEORIGIN' || security.FrameOptions?.Override !== false) {
            problems.push('X-Frame-Options: SAMEORIGIN, yielding')
        }
        if (security.ContentSecurityPolicy !== undefined) problems.push('no Content-Security-Policy')
        if (security.XSSProtection !== undefined) problems.push('no X-XSS-Protection')
        const config = policy.Properties?.ResponseHeadersPolicyConfig ?? {}
        const beyond = Object.keys(config).filter((k) => !['Name', 'Comment', 'SecurityHeadersConfig'].includes(k))
        if (beyond.length > 0) problems.push(`security headers and nothing else (also ${beyond.join(', ')})`)
    }
    for (const b of behaviors) {
        if (JSON.stringify(b?.ResponseHeadersPolicyId) !== JSON.stringify(expectedId)) {
            problems.push(`${b?.PathPattern ?? 'the default behavior'} carries the response headers policy`)
        }
    }
    return problems
}

/**
 * Who an IAM role's trust policy lets assume it, sorted, failing closed. An `Allow` statement that grants
 * `sts:AssumeRole` (IAM action names ignore case), with at most `sts:TagSession` and `sts:SetSourceIdentity` beside it,
 * to an object of principals, gives each `Principal.Service` (a string or a list) as the service's name and any other
 * kind of principal as `<kind>:<value>`. Any other `Allow` statement (another action such as
 * `sts:AssumeRoleWithWebIdentity`, a wildcard, `NotAction`, `NotPrincipal`, `Principal: '*'`) is given whole, as
 * `statement:<json>`, so a test that expects services alone fails on it. `Deny` statements only narrow, and are left out.
 * @param {any} role a role's `Properties`
 * @returns {string[]}
 */
function rolePrincipals(role) {
    /** @param {unknown} value @returns {unknown[]} */
    const asList = (value) => (value === undefined ? [] : Array.isArray(value) ? value : [value])
    const sessionActions = ['sts:assumerole', 'sts:tagsession', 'sts:setsourceidentity']
    /** @type {string[]} */
    const principals = []
    for (const statement of asList(role?.AssumeRolePolicyDocument?.Statement)) {
        const s = /** @type {any} */ (statement)
        if (s?.Effect === 'Deny') continue
        const actions = asList(s?.Action).map((action) => String(action).toLowerCase())
        const plainGrant =
            s?.Effect === 'Allow' &&
            s.NotAction === undefined &&
            s.NotPrincipal === undefined &&
            s.Principal !== null &&
            typeof s.Principal === 'object' &&
            !Array.isArray(s.Principal) &&
            actions.some((action) => action === 'sts:assumerole') &&
            actions.every((action) => sessionActions.some((allowed) => allowed === action))
        if (!plainGrant) {
            principals.push(`statement:${JSON.stringify(s)}`)
            continue
        }
        for (const [kind, value] of Object.entries(s.Principal)) {
            for (const v of asList(value))
                principals.push(kind === 'Service' ? String(v) : `${kind}:${JSON.stringify(v)}`)
        }
    }
    return principals.sort()
}

/** Who may assume a Lambda@Edge function's role: Lambda and Lambda@Edge, both (CloudFront's guide), and nobody else. */
const EDGE_ROLE_PRINCIPALS = ['edgelambda.amazonaws.com', 'lambda.amazonaws.com']

/** The body-hash function's source, as the construct deploys it. */
const BODY_HASH_SOURCE = readFileSync(path.join(REPO, 'packages/cdk/src/assets/body-hash/index.mjs'), 'utf8')

/**
 * What is wrong with how the distribution reaches the server's Function URL, or nothing: the default behavior's
 * origin is the Function URL behind an origin access control that signs every request, and its origin request runs
 * the body-hash function, given the body, from a version in this stack that Lambda@Edge may assume the role of and
 * that is destroyed with the stack.
 * @param {Resources} all
 * @param {string} assembly
 * @returns {string[]}
 */
function functionUrlOriginProblems(all, assembly) {
    /** @type {string[]} */
    const problems = []
    /** @param {string} type */
    const ofType = (type) => Object.entries(all).filter(([, r]) => r.Type === type)
    const distributions = ofType('AWS::CloudFront::Distribution')
    if (distributions.length !== 1) return [`one distribution, not ${distributions.length}`]
    const config = /** @type {any} */ (distributions[0]?.[1].Properties)?.DistributionConfig
    const behavior = config?.DefaultCacheBehavior
    const origin = (config?.Origins ?? []).find((/** @type {any} */ o) => o.Id === behavior?.TargetOriginId)
    const [serverUrl] = ofType('AWS::Lambda::Url').filter(([, r]) =>
        JSON.stringify(r.Properties?.['TargetFunctionArn']).includes('"Server'),
    )
    if (serverUrl?.[1].Properties?.['AuthType'] !== 'AWS_IAM') problems.push("the server's Function URL takes AWS_IAM")
    if (!JSON.stringify(origin?.DomainName ?? null).includes(serverUrl?.[0] ?? '-')) {
        problems.push("the default behavior's origin is the server's Function URL")
    }
    const oacId = origin?.OriginAccessControlId?.['Fn::GetAtt']?.[0]
    const oac = /** @type {any} */ (oacId === undefined ? undefined : all[oacId])?.Properties?.OriginAccessControlConfig
    if (oac?.OriginAccessControlOriginType !== 'lambda' || oac?.SigningBehavior !== 'always') {
        problems.push('that origin is behind an origin access control that signs every request')
    }
    // Only this distribution may invoke the server: every permission on it is CloudFront's, for this distribution.
    const serverPermissions = ofType('AWS::Lambda::Permission').filter(([, r]) =>
        JSON.stringify(r.Properties?.['FunctionName']).includes('"Server'),
    )
    const distributionId = distributions[0]?.[0]
    if (
        serverPermissions.length === 0 ||
        !serverPermissions.every(
            ([, r]) =>
                r.Properties?.['Principal'] === 'cloudfront.amazonaws.com' &&
                JSON.stringify(r.Properties?.['SourceArn']).includes(`"${distributionId}"`),
        )
    ) {
        problems.push('every permission to invoke the server is CloudFront’s, for this distribution alone')
    }
    const associations = /** @type {any[]} */ (behavior?.LambdaFunctionAssociations ?? [])
    const originRequest = associations.filter((a) => a.EventType === 'origin-request')
    if (originRequest.length !== 1) return [...problems, 'the default behavior runs one origin-request function']
    if (originRequest[0].IncludeBody !== true) problems.push('the origin-request function is given the body')
    const versionId = originRequest[0].LambdaFunctionARN?.Ref
    const version = versionId === undefined ? undefined : all[versionId]
    if (version?.Type !== 'AWS::Lambda::Version') return [...problems, 'it runs a version of a function in this stack']
    if (/** @type {any} */ (version).DeletionPolicy !== 'Delete')
        problems.push('that version is destroyed with the stack, not retained')
    const functionId = /** @type {any} */ (version.Properties)?.FunctionName?.Ref
    const code = lambdaBundles(all, assembly).get(functionId)
    if (code !== BODY_HASH_SOURCE) problems.push('the version is of the body-hash function, src/assets/body-hash')
    const fn = /** @type {any} */ (all[functionId])?.Properties
    if (fn?.Handler !== 'index.handler') problems.push("the body-hash function's handler is index.handler")
    // Lambda@Edge runs x86_64 only, and a Node runtime the guide lists.
    if (JSON.stringify(fn?.Architectures) !== '["x86_64"]' || fn?.Runtime !== 'nodejs22.x') {
        problems.push('the body-hash function is x86_64 on nodejs22.x')
    }
    const role = /** @type {any} */ (all[fn?.Role?.['Fn::GetAtt']?.[0]])?.Properties
    if (JSON.stringify(rolePrincipals(role)) !== JSON.stringify(EDGE_ROLE_PRINCIPALS)) {
        problems.push(
            `Lambda and Lambda@Edge, and nobody else, may assume the function's role (${rolePrincipals(role)})`,
        )
    }
    if ((fn?.Environment ?? fn?.VpcConfig ?? fn?.Layers) !== undefined) {
        problems.push('the body-hash function has no environment, VPC or layers (Lambda@Edge allows none)')
    }
    return problems
}

/** @param {Resources} all @param {string} type */
const count = (all, type) => Object.values(all).filter((r) => r.Type === type).length

/** The variables each transport requires, from the framework the app itself resolves (its boot check's list). */
/** @param {string} appDir @returns {Promise<Record<Transport, Record<string, string>>>} */
async function databaseEnvOf(appDir) {
    const file = path.join(kitDirOf(appDir), 'src/adapters/real/database-transport.ts')
    return (await import(pathToFileURL(file).href)).DATABASE_ENV
}

/**
 * The optional ports' switches, from the framework the app itself resolves (its boot check's list).
 * @param {string} appDir
 * @returns {Promise<Record<string, { variable: string, default: string, env: Record<string, Record<string, string>> }>>}
 */
async function optionalPortsOf(appDir) {
    const file = path.join(kitDirOf(appDir), 'src/adapters/real/optional-ports.ts')
    return (await import(pathToFileURL(file).href)).OPTIONAL_PORTS
}

describe.each(APPS)('the %s app, synthesized through SssbApp', (name) => {
    const appDir = path.join(REPO, 'apps', name)

    it("sets the auth tenancy its params declare, with the framework's choices", async () => {
        const { APP_SLUG } = await import(pathToFileURL(path.join(appDir, 'config/app.ts')).href)
        const kitTenancy = path.join(kitDirOf(appDir), 'src/adapters/auth-tenancy.ts')
        const kit = await import(pathToFileURL(kitTenancy).href)
        expect(kit.AUTH_TENANCY_CHOICES).toEqual(AUTH_TENANCY_CHOICES)
        expect(kit.AUTH_ORG_SOURCE_CHOICES).toEqual(AUTH_ORG_SOURCE_CHOICES)
        expect(kit.FIXED_ORG_ROLES).toEqual(FIXED_ORG_ROLES)
        const auth = /** @type {const} */ ({
            tenancy: 'single',
            tenantSlug: 'harbor',
            tenantMetadataKey: 'siteSlug',
            orgSource: 'fixed',
            homeOrgSlug: 'depot',
            defaultRole: 'restricted',
        })
        const { all } = synthesize({ appDir, slug: APP_SLUG, transport: 'pg', bundle: false, auth })
        const env = {
            AUTH_TENANCY: 'single',
            AUTH_TENANT_SLUG: 'harbor',
            AUTH_TENANT_METADATA_KEY: 'siteSlug',
            AUTH_ORG_SOURCE: 'fixed',
            AUTH_HOME_ORG_SLUG: 'depot',
            AUTH_DEFAULT_ROLE: 'restricted',
        }
        expect(lambdaFunction(all, 'Server').env).toMatchObject(env)
        // What the server is handed, the framework reads as given.
        expect(kit.authSettings(env)).toEqual({
            tenancy: { kind: 'single', tenantSlug: 'harbor' },
            orgSource: { kind: 'fixed', homeOrgSlug: 'depot', role: 'restricted' },
            tenantMetadataKey: 'siteSlug',
        })
        // Left out, it sets nothing: the framework's default, multi-tenant auth.
        const plain = synthesize({ appDir, slug: APP_SLUG, transport: 'pg', bundle: false })
        expect(Object.keys(lambdaFunction(plain.all, 'Server').env).filter((name) => name.startsWith('AUTH_'))).toEqual(
            [],
        )
    })

    it("sets the switch of each optional port its params declare, with the framework's names and choices", async () => {
        const { APP_SLUG } = await import(pathToFileURL(path.join(appDir, 'config/app.ts')).href)
        const { params } = await import(pathToFileURL(path.join(appDir, 'config/params.ts')).href)
        const OPTIONAL_PORTS = await optionalPortsOf(appDir)
        // The construct's table is the framework's: the same ports, switches and choices, its default listed first.
        expect(
            Object.fromEntries(
                Object.entries(OPTIONAL_PORTS).map(([port, { variable, default: fallback, env }]) => [
                    port,
                    { variable, choices: [fallback, ...Object.keys(env).filter((choice) => choice !== fallback)] },
                ]),
            ),
        ).toEqual(PORT_SWITCHES)
        expect(Object.keys(params.ports).sort()).toEqual(Object.keys(OPTIONAL_PORTS).sort())
        const { all } = synthesize({ appDir, slug: APP_SLUG, transport: 'pg', bundle: false, ports: params.ports })
        const server = lambdaFunction(all, 'Server')
        for (const [port, choice] of Object.entries(params.ports)) {
            const { variable } = /** @type {{ variable: string }} */ (OPTIONAL_PORTS[port])
            expect(server.env[variable], `params.ports.${port} reaches the server as ${variable}`).toBe(choice)
        }
    })

    describe.each(/** @type {Transport[]} */ (['pg', 'data-api']))('on the %s shape', (transport) => {
        it('matches the runtime contract, grants nothing wider than the cluster, and fails closed', async () => {
            const { APP_SLUG } = await import(pathToFileURL(path.join(appDir, 'config/app.ts')).href)
            const DATABASE_ENV = await databaseEnvOf(appDir)
            const { all, assembly } = synthesize({ appDir, slug: APP_SLUG, transport })
            const server = lambdaFunction(all, 'Server')
            const migrator = lambdaFunction(all, 'Migrator')
            const cluster = Object.values(all).find((r) => r.Type === 'AWS::RDS::DBCluster')?.Properties ?? {}

            expect(server.env['DATABASE_TRANSPORT']).toBe(transport)
            expect(migrator.env['DATABASE_TRANSPORT']).toBe(transport)
            for (const variable of Object.keys(DATABASE_ENV[transport])) {
                expect(server.env, `the server sets ${variable}, which the runtime requires`).toHaveProperty([variable])
            }
            expect(secretGrantProblems(all)).toEqual([])
            // Encrypted at rest, on both shapes. An Aurora instance takes its encryption from its cluster.
            const clusters = Object.values(all).filter((r) => r.Type === 'AWS::RDS::DBCluster')
            expect(clusters.length).toBeGreaterThan(0)
            expect(clusters.every((r) => r.Properties?.['StorageEncrypted'] === true)).toBe(true)

            // What each bundled Lambda really contains (the migrator's own expectations are the construct's
            // synth assertion, which `synthesize` has already passed).
            const bundles = lambdaBundles(all, assembly)
            expect([...bundles.keys()].some((id) => id.startsWith('Migrator'))).toBe(true)
            for (const [id, code] of bundles) {
                expect(code.includes('test-fixture'), `${id}'s bundle holds code from a test fixture`).toBe(false)
            }

            // Next's standalone server listens where the Web Adapter calls it (the construct's comment says why).
            expect(server.env['HOSTNAME']).toBe('0.0.0.0')
            expect(functionUrlOriginProblems(all, assembly)).toEqual([])
            expect(viewerProblems(all)).toEqual([])
            expect(securityHeadersProblems(all)).toEqual([])

            // The production fail-closed guard (packages/kit/src/adapters/index.ts) is irrelevant only while
            // every deployed environment pins APP_MODE=real and sets neither opt-in.
            expect(server.env['APP_MODE']).toBe('real')
            for (const [id, r] of Object.entries(all)) {
                if (r.Type !== 'AWS::Lambda::Function') continue
                const env = JSON.stringify(r.Properties?.['Environment'] ?? {})
                expect(env, `${id} sets DEMO_MODE`).not.toContain('DEMO_MODE')
                expect(env, `${id} sets E2E_BUILD`).not.toContain('E2E_BUILD')
            }

            if (transport === 'data-api') {
                for (const variable of Object.keys(DATABASE_ENV['data-api'])) {
                    expect(migrator.env, `the migrator sets ${variable}`).toHaveProperty([variable])
                }
                expect(server.env).not.toHaveProperty(['DATABASE_URL'])
                expect(migrator.env).not.toHaveProperty(['DATABASE_URL'])
                expect(server.inVpc || migrator.inVpc).toBe(false)
                expect(cluster['EnableHttpEndpoint']).toBe(true)
                expect(count(all, 'AWS::EC2::NatGateway')).toBe(0)
                expect(count(all, 'AWS::EC2::InternetGateway')).toBe(0)
                expect(dataApiShapeProblems(all)).toEqual([])
            } else {
                expect(migrator.env).toHaveProperty(['DB_SECRET_ARN'])
                expect(server.inVpc && migrator.inVpc).toBe(true)
                expect(cluster).not.toHaveProperty(['EnableHttpEndpoint'])
                expect(count(all, 'AWS::EC2::NatGateway')).toBe(1)
            }
        })
    })
})

describe('the synth assertions fail', () => {
    const appDir = path.join(REPO, 'apps', /** @type {string} */ (APPS[0]))
    const slug = /** @type {string} */ (
        /export const APP_SLUG = '([^']+)'/.exec(readFileSync(path.join(appDir, 'config/app.ts'), 'utf8'))?.[1]
    )
    /** @param {(app: SssbApp) => void} configure */
    const withServer = (configure) => () => synthesize({ appDir, slug, transport: 'pg', bundle: false, configure })
    /** @param {Partial<import('./index.d.ts').SssbAppProps>} props */
    const construct = (props) => () =>
        new SssbApp(new cdk.Stack(new cdk.App()), 'Default', {
            appDir,
            slug,
            params: { database: { transport: 'pg' } },
            environment: 'Staging',
            production: false,
            ...props,
        })

    /**
     * A scratch app beside the repository's own framework: its `@sssb/kit` is a link to packages/kit, or a copy of
     * its manifest at `version` with the source linked in.
     * @param {{ version?: string }} [options]
     */
    function scratchApp({ version } = {}) {
        const scratch = makeTestTmpDir('sssb-cdk-app-')
        const kit = path.join(scratch, 'node_modules/@sssb/kit')
        mkdirSync(path.dirname(kit), { recursive: true })
        if (version === undefined) {
            symlinkSync(path.join(REPO, 'packages/kit'), kit)
        } else {
            mkdirSync(kit)
            const manifest = JSON.parse(readFileSync(path.join(REPO, 'packages/kit/package.json'), 'utf8'))
            writeFileSync(path.join(kit, 'package.json'), JSON.stringify({ ...manifest, version }))
            symlinkSync(path.join(REPO, 'packages/kit/src'), path.join(kit, 'src'))
        }
        writeFileSync(path.join(scratch, 'package.json'), JSON.stringify({ name: 'scratch', private: true }))
        mkdirSync(path.join(scratch, 'src/app-config/db/migrations'), { recursive: true })
        writeFileSync(path.join(scratch, 'src/app-config/db/migrations/index.ts'), 'export const appMigrations = {}\n')
        return scratch
    }

    it('when the server is given a bypass, by its API or by an escape hatch', () => {
        expect(withServer((app) => app.server.addEnvironment('DEMO_MODE', '1'))).toThrow(/DEMO_MODE is set/)
        expect(
            withServer((app) => {
                const cfn = /** @type {cdk.CfnResource} */ (app.server.node.defaultChild)
                cfn.addPropertyOverride('Environment.Variables.E2E_BUILD', '0')
            }),
        ).toThrow(/E2E_BUILD is set/)
    })

    it('when the server does not come up in real mode', () => {
        expect(withServer((app) => app.server.addEnvironment('APP_MODE', 'simulated'))).toThrow(
            /APP_MODE is "simulated"/,
        )
        expect(
            withServer((app) => {
                const cfn = /** @type {cdk.CfnResource} */ (app.server.node.defaultChild)
                cfn.addPropertyDeletionOverride('Environment')
            }),
        ).toThrow(/APP_MODE is undefined/)
    })

    it("when the migrator's staged bundle lacks one of the app's migrations", () => {
        let removed = ''
        const tamper = (/** @type {SssbApp} */ app) => {
            const stage = /** @type {{ absoluteStagedPath: string }} */ (
                /** @type {unknown} */ (app.migrator.node.findChild('Code').node.findChild('Stage'))
            )
            const file = path.join(stage.absoluteStagedPath, 'index.mjs')
            const code = readFileSync(file, 'utf8')
            removed = /** @type {string} */ (code.match(/"(1\d{3}_[a-z0-9_]+)"/)?.[1])
            writeFileSync(file, code.replaceAll(`"${removed}"`, '"gone"'))
        }
        try {
            expect(() => synthesize({ appDir, slug, transport: 'pg', configure: tamper })).toThrow(
                /the migrator bundle is wrong: .*carries the app's migration/,
            )
            expect(removed).toMatch(/^1\d{3}_/)
        } finally {
            // CDK caches a staged bundle by its inputs for the rest of the process: never hand the tampered
            // one to a later synth.
            cdk.AssetStaging.clearAssetHashCache()
        }
    })

    it('when this synth bundled the stack but staged no migrator bundle', () => {
        const drop = (/** @type {SssbApp} */ app) => {
            const stage = /** @type {{ absoluteStagedPath: string }} */ (
                /** @type {unknown} */ (app.migrator.node.findChild('Code').node.findChild('Stage'))
            )
            rmSync(path.join(stage.absoluteStagedPath, 'index.mjs'))
        }
        try {
            expect(() => synthesize({ appDir, slug, transport: 'pg', configure: drop })).toThrow(
                /the migrator bundle is wrong: the migrator is not bundled by this synth/,
            )
        } finally {
            cdk.AssetStaging.clearAssetHashCache()
        }
    })

    it('when the migrator is given a bypass', () => {
        expect(withServer((app) => app.migrator.addEnvironment('E2E_BUILD', '1'))).toThrow(
            /the migrator's environment sets E2E_BUILD/,
        )
    })

    it('when production is not a boolean', () => {
        expect(construct({ production: /** @type {any} */ ('true') })).toThrow(/production must be true or false/)
        expect(construct({ production: /** @type {any} */ (undefined) })).toThrow(/production must be true or false/)
    })

    it('when the migrator deploys code other than the bundle this synth staged', () => {
        const swap = (/** @type {SssbApp} */ app) => {
            const cfn = /** @type {cdk.CfnResource} */ (app.migrator.node.defaultChild)
            cfn.addPropertyOverride('Code.S3Key', 'elsewhere.zip')
        }
        expect(() => synthesize({ appDir, slug, transport: 'pg', configure: swap })).toThrow(
            /the migrator bundle is wrong: it deploys .*elsewhere\.zip.*, not the bundle this synth staged/,
        )
    })

    // @sssb/tools is cdk's peer, so pnpm only warns when the copy beside it is another release. SssbApp's own refusal is
    // sssb-app-tools-version.test.js.
    it('names both versions when @sssb/tools is not its own version, and nothing when they match', () => {
        expect(toolsVersionProblem('0.0.0-other', '0.2.0-rc.2')).toBe(
            "SssbApp: this @sssb/cdk is 0.2.0-rc.2, but the @sssb/tools beside it is 0.0.0-other. SSSB's packages are " +
                'released in lockstep: depend on @sssb/tools 0.2.0-rc.2 in the package that takes @sssb/cdk (its peer), ' +
                'then run pnpm install.',
        )
        // This repository's @sssb/tools, beside this @sssb/cdk: one release.
        const tools = JSON.parse(readFileSync(path.join(REPO, 'packages/tools/package.json'), 'utf8')).version
        expect(toolsVersionProblem(tools)).toBeNull()
    })

    it("when the app's @sssb/kit is not the construct's version", () => {
        expect(construct({ appDir: scratchApp({ version: '0.0.0-other' }), slug: 'scratch' })).toThrow(
            new RegExp(
                `resolves @sssb/kit 0\\.0\\.0-other .*but this @sssb/cdk is ${OWN_VERSION.replaceAll('.', '\\.')}`,
            ),
        )
    })

    it('when the app links a seam other than the one the migrator is bundled with', () => {
        const scratch = scratchApp()
        mkdirSync(path.join(scratch, 'elsewhere'))
        symlinkSync(path.join(scratch, 'elsewhere'), path.join(scratch, 'node_modules/@sssb/app-config'))
        expect(construct({ appDir: scratch, slug: 'scratch' })).toThrow(
            /links @sssb\/app-config to .*elsewhere, not to its src\/app-config/,
        )
    })

    it("when the slug is not the app's own", () => {
        expect(construct({ slug: `${slug}-other` })).toThrow(
            new RegExp(`slug is "${slug}-other", but .*config/app\\.ts declares APP_SLUG "${slug}"`),
        )
    })

    it('when the seam registers its migrations under no literal key', () => {
        const scratch = scratchApp()
        const migrations = path.join(scratch, 'src/app-config/db/migrations')
        writeFileSync(path.join(migrations, '1001_things.ts'), 'export async function up() {}\n')
        writeFileSync(
            path.join(migrations, 'index.ts'),
            "import * as m1001 from './1001_things'\n" +
                "// '1001_things': m1001, (a comment is not a registration)\n" +
                "export const appMigrations = { [[1001, 'things'].join('_')]: m1001 }\n",
        )
        expect(construct({ appDir: scratch, slug: 'scratch' })).toThrow(
            /registers none of 1001_things\.ts under a literal key/,
        )
    })

    it('when the app has no migration index, or no lock file above it', () => {
        const scratch = scratchApp()
        expect(construct({ appDir: scratch, slug: 'scratch' })).toThrow(/no lock file \(.*\) at or above/)
        rmSync(path.join(scratch, 'src/app-config/db/migrations/index.ts'))
        expect(construct({ appDir: scratch, slug: 'scratch' })).toThrow(/has no migration index at/)
    })

    it('when the project root installs no esbuild to bundle with', () => {
        // The framework copied INTO the scratch project, so that the root is all that is missing.
        const scratch = makeTestTmpDir('sssb-cdk-app-')
        const kit = path.join(scratch, 'node_modules/@sssb/kit')
        cpSync(path.join(REPO, 'packages/kit'), kit, {
            recursive: true,
            filter: (source) => !source.includes(`${path.sep}node_modules`),
        })
        mkdirSync(path.join(scratch, 'src/app-config/db/migrations'), { recursive: true })
        writeFileSync(path.join(scratch, 'src/app-config/db/migrations/index.ts'), 'export const appMigrations = {}\n')
        writeFileSync(path.join(scratch, 'package.json'), JSON.stringify({ name: 'scratch', private: true }))
        writeFileSync(path.join(scratch, 'pnpm-lock.yaml'), "lockfileVersion: '9.0'\n")
        expect(construct({ appDir: scratch, slug: 'scratch' })).toThrow(/no esbuild at .*, the project root/)
    })

    it('when the framework is installed outside the project root', () => {
        const scratch = scratchApp()
        writeFileSync(path.join(scratch, 'pnpm-lock.yaml'), "lockfileVersion: '9.0'\n")
        expect(construct({ appDir: scratch, slug: 'scratch' })).toThrow(/is outside the project root/)
    })

    it('when the params name no transport it builds', () => {
        expect(construct({ params: { database: { transport: /** @type {any} */ ('mysql') } } })).toThrow(
            /params\.database\.transport must be pg or data-api/,
        )
    })

    it('when the params name an optional port, or a choice, the framework does not know', () => {
        /** @param {unknown} ports */
        const withPorts = (ports) =>
            construct({ params: { database: { transport: 'pg' }, ports: /** @type {any} */ (ports) } })
        expect(withPorts({ llms: 'none' })).toThrow(/params\.ports\.llms is not an optional port/)
        expect(withPorts({ jobs: 'lambda' })).toThrow(
            /params\.ports\.jobs must be codebuild, in-process, none \(got "lambda"\)/,
        )
        expect(withPorts({ storage: 'gcs' })).toThrow(
            /params\.ports\.storage must be s3, s3-compatible, none \(got "gcs"\)/,
        )
        expect(withPorts('none')).toThrow(/params\.ports must be an object/)
        expect(withPorts({ llm: 'none', jobs: 'in-process' })).not.toThrow()
    })

    it('when the params name an auth tenancy the framework would refuse at boot', () => {
        /** @param {unknown} auth */
        const withAuth = (auth) =>
            construct({ params: { database: { transport: 'pg' }, auth: /** @type {any} */ (auth) } })
        expect(withAuth({ tenancy: 'one' })).toThrow(/params\.auth\.tenancy must be multi or single/)
        expect(withAuth({ orgSource: 'none' })).toThrow(/params\.auth\.orgSource must be provider or fixed/)
        expect(withAuth({ tenancy: 'single' })).toThrow(/needs params\.auth\.tenantSlug, a slug/)
        expect(withAuth({ tenancy: 'single', tenantSlug: 'Harbor' })).toThrow(/needs params\.auth\.tenantSlug, a slug/)
        const single = /** @type {const} */ ({ tenancy: 'single', tenantSlug: 'harbor' })
        expect(withAuth({ ...single, orgSource: 'fixed' })).toThrow(/needs params\.auth\.homeOrgSlug, a slug/)
        expect(withAuth({ orgSource: 'fixed', homeOrgSlug: 'depot' })).toThrow(
            /orgSource 'fixed' needs tenancy 'single'/,
        )
        expect(withAuth({ tenantSlug: 'harbor' })).toThrow(/need tenancy 'single'/)
        expect(withAuth({ homeOrgSlug: 'depot' })).toThrow(/need orgSource 'fixed'/)
        // The single mode first written set the home org with the tenancy; it now names the org source too.
        expect(withAuth({ tenancy: 'single', tenantSlug: 'harbor', homeOrgSlug: 'depot' })).toThrow(
            /need orgSource 'fixed'/,
        )
        expect(withAuth({ defaultRole: 'none' })).toThrow(/need orgSource 'fixed'/)
        expect(withAuth({ ...single, orgSource: 'fixed', homeOrgSlug: 'depot', defaultRole: 'member' })).toThrow(
            /defaultRole must be none or restricted/,
        )
        expect(withAuth({ tennancy: 'single' })).toThrow(/params\.auth has no tennancy/)
        expect(withAuth({ tenantMetadataKey: 'a.b' })).toThrow(/plain identifier/)
        expect(withAuth({ tenancy: 'single', tenantSlug: 'harbor' })).not.toThrow()
        expect(withAuth({ ...single, orgSource: 'fixed', homeOrgSlug: 'depot' })).not.toThrow()
    })

    it('when the scheduled tick is given no secret, or a rate EventBridge cannot run', () => {
        expect(construct({ scheduledTick: /** @type {any} */ ({}) })).toThrow(/scheduledTick\.webhookSecret must be/)
        expect(
            construct({
                scheduledTick: {
                    webhookSecret: /** @type {any} */ ({ secretArn: 'arn:aws:secretsmanager:::secret:s-abcdef' }),
                },
            }),
        ).toThrow(/scheduledTick\.webhookSecret must be/)
        /** @param {cdk.Duration} every */
        const every = (every) => () =>
            synthesize({
                appDir,
                slug,
                transport: 'pg',
                bundle: false,
                scheduledTick: (stack) => ({ webhookSecret: new cdk.aws_secretsmanager.Secret(stack, 'Tick'), every }),
            })
        expect(every(cdk.Duration.seconds(90))).toThrow(/scheduledTick\.every must be a whole number of minutes/)
        expect(every(cdk.Duration.seconds(30))).toThrow(/scheduledTick\.every must be a whole number of minutes/)
    })
})

/** The IAM statements attached to the role of the function whose logical id starts with `prefix`. */
/** @param {Resources} all @param {string} prefix */
function statementsOf(all, prefix) {
    const [fnId, fn] = /** @type {[string, any]} */ (
        Object.entries(all).find(([id, r]) => r.Type === 'AWS::Lambda::Function' && id.startsWith(prefix))
    )
    const roleId = fn.Properties.Role['Fn::GetAtt'][0]
    expect(roleId, `${fnId}'s role`).toBeTruthy()
    return Object.values(all)
        .filter((r) => r.Type === 'AWS::IAM::Policy')
        .filter((r) => JSON.stringify(r.Properties?.['Roles']).includes(`"Ref":"${roleId}"`))
        .flatMap((r) => /** @type {any} */ (r.Properties ?? {})['PolicyDocument'].Statement)
}

describe('the storage port', () => {
    const appDir = path.join(REPO, 'apps', /** @type {string} */ (APPS[0]))
    const slug = /** @type {string} */ (
        /export const APP_SLUG = '([^']+)'/.exec(readFileSync(path.join(appDir, 'config/app.ts'), 'utf8'))?.[1]
    )
    /** SssbApp's stateful logical ids, as release-snapshots/stateful-logical-ids.json holds them for one shape. */
    /** @param {string} shape @returns {Record<string, string>} */
    const snapshotted = (shape) =>
        JSON.parse(readFileSync(path.join(REPO, 'packages/cdk/release-snapshots/stateful-logical-ids.json'), 'utf8'))[
            shape
        ]
    const STORAGE_BUCKET_ID = 'StorageBucket19DB2FF8'
    /** @param {Resources} all */
    const buckets = (all) => Object.keys(all).filter((id) => all[id]?.Type === 'AWS::S3::Bucket')
    /** The server's statements that name an S3 action. @param {Resources} all */
    const serverS3 = (all) => statementsOf(all, 'Server').filter((st) => JSON.stringify(st.Action).includes('"s3:'))

    describe.each(
        /** @type {[Transport, boolean][]} */ ([
            ['pg', false],
            ['pg', true],
            ['data-api', false],
            ['data-api', true],
        ]),
    )('on the %s shape with production %s', (transport, production) => {
        const shape = `${transport}${production ? ', production' : ''}`

        it.each([
            ['left out', undefined],
            ['s3', { storage: 's3' }],
        ])(
            'storage %s builds the bucket under its snapshotted id, names it to the server and grants it',
            (_label, ports) => {
                const { all } = synthesize({
                    appDir,
                    slug,
                    transport,
                    bundle: false,
                    production,
                    ...(ports && { ports: /** @type {any} */ (ports) }),
                })
                expect(snapshotted(shape)).toHaveProperty([STORAGE_BUCKET_ID], 'AWS::S3::Bucket')
                expect(buckets(all).sort()).toEqual(['AssetsBucket5CB76180', STORAGE_BUCKET_ID])
                const server = lambdaFunction(all, 'Server')
                expect(JSON.stringify(server.env['STORAGE_BUCKET'])).toContain(STORAGE_BUCKET_ID)
                expect(serverS3(all).length).toBeGreaterThan(0)
            },
        )

        it.each(['none', 's3-compatible'])(
            'storage %s builds no bucket, sets no STORAGE_BUCKET, grants the server no S3, and keeps every other stateful id',
            (choice) => {
                const { all } = synthesize({
                    appDir,
                    slug,
                    transport,
                    bundle: false,
                    production,
                    ports: { storage: /** @type {any} */ (choice) },
                })
                const server = lambdaFunction(all, 'Server')
                expect(server.env['STORAGE_PROVIDER']).toBe(choice)
                // Only the switch: the compatible store's own settings (endpoint, keys) are the deployment's to add.
                expect(Object.keys(server.env).filter((name) => name.startsWith('STORAGE_'))).toEqual([
                    'STORAGE_PROVIDER',
                ])
                expect(buckets(all)).toEqual(['AssetsBucket5CB76180'])
                expect(serverS3(all)).toEqual([])
                for (const [id, type] of Object.entries(snapshotted(shape))) {
                    if (id !== STORAGE_BUCKET_ID) expect(all[id]?.Type, id).toBe(type)
                }
            },
        )
    })
})

describe('the scheduled tick', () => {
    const appDir = path.join(REPO, 'apps', /** @type {string} */ (APPS[0]))
    const slug = /** @type {string} */ (
        /export const APP_SLUG = '([^']+)'/.exec(readFileSync(path.join(appDir, 'config/app.ts'), 'utf8'))?.[1]
    )
    const SECRET_ARN = 'arn:aws:secretsmanager:us-east-1:111111111111:secret:app-webhook-AbCdEf'

    /** @param {Transport} transport @param {cdk.Duration} [every] */
    function withTick(transport, every) {
        return synthesize({
            appDir,
            slug,
            transport,
            bundle: false,
            scheduledTick: (stack) => ({
                webhookSecret: cdk.aws_secretsmanager.Secret.fromSecretCompleteArn(stack, 'WebhookSecret', SECRET_ARN),
                ...(every && { every }),
            }),
        })
    }

    it('is not there unless asked for: the default deployment has no schedule and no tick function', () => {
        const { all } = synthesize({ appDir, slug, transport: 'pg', bundle: false })
        expect(count(all, 'AWS::Events::Rule')).toBe(0)
        expect(Object.keys(all).some((id) => id.startsWith('ScheduledTick'))).toBe(false)
    })

    it.each(/** @type {Transport[]} */ (['pg', 'data-api']))(
        'on %s: a rate rule runs a function outside the VPC that may read the one secret and invoke the server alone',
        (transport) => {
            const { all } = withTick(transport)
            const rules = Object.values(all).filter((r) => r.Type === 'AWS::Events::Rule')
            expect(rules).toHaveLength(1)
            expect(rules[0]?.Properties?.['ScheduleExpression']).toBe('rate(5 minutes)')
            const target = /** @type {any} */ (rules[0]?.Properties ?? {})['Targets'][0]
            expect(target.RetryPolicy).toEqual({ MaximumRetryAttempts: 0 })
            // And Lambda's own retries of an asynchronous invocation, which EventBridge's policy does not reach.
            const invokeConfigs = Object.values(all).filter((r) => r.Type === 'AWS::Lambda::EventInvokeConfig')
            expect(invokeConfigs).toHaveLength(1)
            expect(invokeConfigs[0]?.Properties?.['MaximumRetryAttempts']).toBe(0)

            const tick = lambdaFunction(all, 'ScheduledTick')
            const server = lambdaFunction(all, 'Server')
            expect(JSON.stringify(target.Arn)).toContain(tick.id)
            expect(JSON.stringify(invokeConfigs[0]?.Properties?.['FunctionName'])).toContain(tick.id)
            const alarm = Object.entries(all).find(([id]) => id.startsWith('ScheduledTickErrorsAlarm'))?.[1]
            expect(alarm?.Properties?.['MetricName']).toBe('Errors')
            expect(JSON.stringify(alarm?.Properties?.['Dimensions'])).toContain(tick.id)
            expect(tick.inVpc).toBe(false)
            expect(tick.env['SERVER_FUNCTION_NAME']).toEqual({ Ref: server.id })
            expect(tick.env['WEBHOOK_SECRET_ARN']).toBe(SECRET_ARN)
            expect(JSON.stringify(tick.env['SERVER_HOST'])).toContain('FunctionUrl')

            const statements = statementsOf(all, 'ScheduledTick')
            const actions = statements.flatMap((st) => [st.Action].flat())
            expect(actions.sort()).toEqual(
                ['lambda:InvokeFunction', 'secretsmanager:DescribeSecret', 'secretsmanager:GetSecretValue'].sort(),
            )
            for (const st of statements) {
                const resources = JSON.stringify(st.Resource)
                if ([st.Action].flat().some((a) => a.startsWith('secretsmanager:'))) {
                    expect(resources).toBe(JSON.stringify(SECRET_ARN))
                } else {
                    // The server's ARN, and its versions and aliases (`<arn>:*`, what `grantInvoke` grants): no other.
                    expect(st.Resource).toEqual([
                        { 'Fn::GetAtt': [server.id, 'Arn'] },
                        { 'Fn::Join': ['', [{ 'Fn::GetAtt': [server.id, 'Arn'] }, ':*']] },
                    ])
                }
            }
            // The construct never puts the secret's value in an environment: the function reads it when it runs.
            expect(server.env).not.toHaveProperty(['WEBHOOK_SECRET'])
            expect(JSON.stringify(all)).not.toContain('resolve:secretsmanager:' + SECRET_ARN)
        },
    )

    it('runs at the rate it is given', () => {
        const { all } = withTick('pg', cdk.Duration.minutes(1))
        const rule = Object.values(all).find((r) => r.Type === 'AWS::Events::Rule')
        expect(rule?.Properties?.['ScheduleExpression']).toBe('rate(1 minute)')
    })
})

describe('a stack whose synthesizer prefixes its asset keys', () => {
    it("passes: the migrator's deployed code is compared with the key the synthesizer gave it", () => {
        const appDir = path.join(REPO, 'apps', /** @type {string} */ (APPS[0]))
        const slug = /export const APP_SLUG = '([^']+)'/.exec(readFileSync(path.join(appDir, 'config/app.ts'), 'utf8'))
        const app = new cdk.App({ outdir: makeTestTmpDir('sssb-cdk-') })
        const stack = new cdk.Stack(app, 'Prefixed', {
            synthesizer: new cdk.DefaultStackSynthesizer({ bucketPrefix: 'apps/' }),
        })
        new SssbApp(stack, 'Default', {
            appDir,
            slug: /** @type {string} */ (slug?.[1]),
            params: { database: { transport: 'pg' } },
            environment: 'Staging',
            production: false,
        })
        const migrator = lambdaFunction(
            /** @type {Resources} */ (Template.fromStack(stack).toJSON()['Resources']),
            'Migrator',
        )
        expect(migrator.id).toMatch(/^Migrator/)
    })
})

describe('a production deployment', () => {
    /**
     * A bare SssbApp of the first app, as production or not, in a stack of its own.
     * @param {Transport} transport @param {boolean} production
     */
    function templateOf(transport, production) {
        const appDir = path.join(REPO, 'apps', /** @type {string} */ (APPS[0]))
        const slug = /export const APP_SLUG = '([^']+)'/.exec(readFileSync(path.join(appDir, 'config/app.ts'), 'utf8'))
        const outdir = makeTestTmpDir('sssb-cdk-')
        const app = new cdk.App({ outdir, context: { 'aws:cdk:bundling-stacks': [] } })
        const stack = new cdk.Stack(app, production ? 'Production' : 'Staging')
        new SssbApp(stack, 'Default', {
            appDir,
            slug: /** @type {string} */ (slug?.[1]),
            params: { database: { transport } },
            environment: production ? 'Production' : 'Staging',
            production,
        })
        const template = /** @type {{ Resources: Record<string, any> }} */ (Template.fromStack(stack).toJSON())
        return (/** @type {string} */ type) => Object.entries(template.Resources).filter(([, r]) => r.Type === type)
    }

    /**
     * The one `[logical id, resource]` of a type: a template with none or two is a failure, not a pass.
     * @param {[string, any][]} entries
     * @returns {[string, any]}
     */
    function only(entries) {
        expect(entries).toHaveLength(1)
        return /** @type {[string, any]} */ (entries[0])
    }

    it('keeps its data: the database and both buckets are retained, and the writer stays warm', () => {
        const ofType = templateOf('pg', true)
        const [, cluster] = only(ofType('AWS::RDS::DBCluster'))
        expect(cluster.DeletionPolicy).toBe('Retain')
        expect(cluster.Properties.ServerlessV2ScalingConfiguration.MinCapacity).toBe(1)
        const buckets = ofType('AWS::S3::Bucket')
        expect(buckets).toHaveLength(2)
        expect(buckets.every(([, b]) => b.DeletionPolicy === 'Retain')).toBe(true)
        expect(ofType('Custom::S3AutoDeleteObjects')).toHaveLength(0)
    })

    it.each(/** @type {Transport[]} */ (['pg', 'data-api']))(
        'keeps the credentials to the data it keeps: the %s database secret is retained in production only',
        (transport) => {
            // The cluster's removalPolicy does not reach its generated master secret; without its own policy it is
            // Delete, and deleting a production stack would keep the database and drop the only credentials to it.
            const [prodId, prod] = only(templateOf(transport, true)('AWS::SecretsManager::Secret'))
            expect(prod.DeletionPolicy).toBe('Retain')
            expect(prod.UpdateReplacePolicy).toBe('Retain')
            // The logical id is what CloudFormation knows the secret by: a new one would replace it (and its password).
            expect(prodId).toBe('DbSecretCF6D79B0')
            // A non-production stack still goes away whole, secret included.
            const [devId, dev] = only(templateOf(transport, false)('AWS::SecretsManager::Secret'))
            expect(devId).toBe(prodId)
            expect(dev.DeletionPolicy).toBe('Delete')
            expect(dev.UpdateReplacePolicy).toBe('Delete')
        },
    )

    it.each(/** @type {Transport[]} */ (['pg', 'data-api']))(
        'has no other holder of what the retained data needs on the %s shape: no KMS key, no rotation schedule',
        (transport) => {
            // The cluster and the secret use the account's AWS-managed keys and the buckets S3's own, so there is no
            // customer key to retain, and the secret is never rotated. One added later is a decision: retain it in
            // production too.
            for (const type of ['AWS::KMS::Key', 'AWS::SecretsManager::RotationSchedule']) {
                expect(templateOf(transport, true)(type), type).toHaveLength(0)
            }
        },
    )
})

describe("the server's Function URL behind CloudFront", () => {
    const appDir = path.join(REPO, 'apps', /** @type {string} */ (APPS[0]))
    const slug = /** @type {string} */ (
        /export const APP_SLUG = '([^']+)'/.exec(readFileSync(path.join(appDir, 'config/app.ts'), 'utf8'))?.[1]
    )

    it.each(
        /** @type {[Transport, boolean][]} */ ([
            ['pg', false],
            ['pg', true],
            ['data-api', false],
            ['data-api', true],
        ]),
    )(
        'takes a request body on the %s shape (production: %s): the origin request adds its hash',
        (transport, production) => {
            const { all, assembly } = synthesize({ appDir, slug, transport, production, bundle: false })
            expect(functionUrlOriginProblems(all, assembly)).toEqual([])
            expect(viewerProblems(all)).toEqual([])
            expect(securityHeadersProblems(all)).toEqual([])
            expect(lambdaFunction(all, 'Server').env['HOSTNAME']).toBe('0.0.0.0')
        },
    )

    it('refuses a body-hash role that anyone but Lambda and Lambda@Edge may assume, by any action', () => {
        /** @param {(role: cdk.aws_iam.Role) => void} widen */
        const problemsWith = (widen) => {
            const { all, assembly } = synthesize({
                appDir,
                slug,
                transport: 'data-api',
                bundle: false,
                configure: (app) => {
                    const role = app.node
                        .findAll()
                        .find((c) => c instanceof cdk.aws_iam.Role && c.node.path.endsWith('/BodyHash/ServiceRole'))
                    expect(role).toBeDefined()
                    widen(/** @type {cdk.aws_iam.Role} */ (role))
                },
            })
            return functionUrlOriginProblems(all, assembly)
        }
        /** @param {cdk.aws_iam.PolicyStatementProps} statement */
        const adding = (statement) => (/** @type {cdk.aws_iam.Role} */ role) =>
            role.assumeRolePolicy?.addStatements(new cdk.aws_iam.PolicyStatement(statement))
        const wider = [
            adding({ actions: ['sts:AssumeRole'], principals: [new cdk.aws_iam.AccountRootPrincipal()] }),
            // Web-identity (OIDC) trust, as CDK writes it, with another action than sts:AssumeRole.
            adding({
                actions: ['sts:AssumeRoleWithWebIdentity'],
                principals: [new cdk.aws_iam.FederatedPrincipal('arn:aws:iam::123456789012:oidc-provider/example')],
            }),
            adding({ actions: ['sts:*'], principals: [new cdk.aws_iam.AnyPrincipal()] }),
        ]
        for (const widen of wider) {
            const problems = problemsWith(widen)
            expect(problems).toHaveLength(1)
            expect(
                problems[0]?.startsWith("Lambda and Lambda@Edge, and nobody else, may assume the function's role"),
            ).toBe(true)
        }
    })

    it('refuses a permission that lets anyone else invoke the server', () => {
        const { all, assembly } = synthesize({
            appDir,
            slug,
            transport: 'data-api',
            bundle: false,
            configure: (app) =>
                app.server.addPermission('Anyone', {
                    principal: new cdk.aws_iam.AnyPrincipal(),
                    action: 'lambda:InvokeFunctionUrl',
                }),
        })
        expect(functionUrlOriginProblems(all, assembly)).toEqual([
            'every permission to invoke the server is CloudFront’s, for this distribution alone',
        ])
    })

    it('gives each SssbApp in a stack outside us-east-1 its own edge stack', () => {
        const outdir = makeTestTmpDir('sssb-cdk-')
        const app = new cdk.App({ outdir, context: { 'aws:cdk:bundling-stacks': [] } })
        const stack = new cdk.Stack(app, 'TwoApps', { env: { region: 'eu-west-1' } })
        for (const id of ['Default', 'Second']) {
            new SssbApp(stack, id, {
                appDir,
                slug,
                params: { database: { transport: 'data-api' } },
                environment: 'Staging',
                production: false,
            })
        }
        const stacks = app.synth().stacks
        expect(stacks.filter((s) => s.environment.region === 'us-east-1')).toHaveLength(2)
    })

    /**
     * The edge stack of one SssbApp in `region`, tagged by `tag` after it is built, as an adopter's code would tag it.
     * @param {string} region
     * @param {(app: cdk.App, stack: cdk.Stack) => void} tag
     * @param {Record<string, unknown>} [context]
     */
    function edgeStackOf(region, tag, context = {}) {
        const outdir = makeTestTmpDir('sssb-cdk-')
        const app = new cdk.App({ outdir, context: { 'aws:cdk:bundling-stacks': [], ...context } })
        const stack = new cdk.Stack(app, 'Shared', { env: { account: '123456789012', region } })
        new SssbApp(stack, 'Default', {
            appDir,
            slug,
            params: { database: { transport: 'data-api' } },
            environment: 'Staging',
            production: false,
        })
        tag(app, stack)
        const edge = app.synth().stacks.filter((s) => s.environment.region === 'us-east-1')
        expect(edge).toHaveLength(1)
        const artifact = /** @type {cdk.cx_api.CloudFormationStackArtifact} */ (edge[0])
        /** @param {any} r */
        const tagsOf = (r) =>
            Object.fromEntries((r.Properties?.Tags ?? []).map((/** @type {any} */ t) => [t.Key, t.Value]))
        const edgeResources = Object.values(/** @type {Resources} */ (artifact.template.Resources))
        const parent = /** @type {Resources} */ (Template.fromStack(stack).toJSON()['Resources'])
        const server = tagsOf(parent[lambdaFunction(parent, 'Server').id])
        return {
            artifact,
            server,
            fn: tagsOf(edgeResources.find((r) => r.Type === 'AWS::Lambda::Function')),
            role: tagsOf(edgeResources.find((r) => r.Type === 'AWS::IAM::Role')),
        }
    }

    it("deploys the edge stack under the parent stack's tags, and one per region the app is deployed to", () => {
        // One stack id, synthesized once per region it is deployed to, as one app's staging and production would be in
        // a single account.
        const west = edgeStackOf('eu-west-1', (_, stack) => cdk.Tags.of(stack).add('Owner', 'team-west'))
        const oregon = edgeStackOf('us-west-2', (_, stack) => cdk.Tags.of(stack).add('Owner', 'team-oregon'))
        expect([west.artifact.tags, oregon.artifact.tags]).toEqual([{ Owner: 'team-west' }, { Owner: 'team-oregon' }])
        expect([west.fn, west.role]).toEqual([{ Owner: 'team-west' }, { Owner: 'team-west' }])
        expect(west.artifact.stackName).not.toBe(oregon.artifact.stackName)
    })

    it("gives the edge function the server's tags however they were set", () => {
        // explicitStackTags (cdk init's default) tags resources and not the stack.
        const explicit = edgeStackOf('eu-west-1', (_, stack) => cdk.Tags.of(stack).add('Owner', 'team'), {
            '@aws-cdk/core:explicitStackTags': true,
        })
        expect([explicit.server, explicit.fn, explicit.role]).toEqual([
            { Owner: 'team' },
            { Owner: 'team' },
            { Owner: 'team' },
        ])
        // The stack overrides the app's value, and removes a tag the app sets: the edge function follows the server.
        const layered = edgeStackOf('eu-west-1', (app, stack) => {
            cdk.Tags.of(app).add('Env', 'default')
            cdk.Tags.of(app).add('Gone', 'yes')
            cdk.Tags.of(stack).add('Env', 'staging')
            cdk.Tags.of(stack).remove('Gone')
        })
        expect(layered.server).toEqual({ Env: 'staging' })
        expect([layered.fn, layered.role, layered.artifact.tags]).toEqual([
            { Env: 'staging' },
            { Env: 'staging' },
            { Env: 'staging' },
        ])
    })

    it('keeps the function at one construct path whether the stack names us-east-1 or no region', () => {
        const ids = (/** @type {string | undefined} */ region) =>
            Object.entries(synthesize({ appDir, slug, transport: 'data-api', bundle: false, region }).all)
                .filter(([, r]) => r.Type === 'AWS::Lambda::Function' || r.Type === 'AWS::IAM::Role')
                .map(([id]) => id)
                .filter((id) => id.startsWith('BodyHash'))
        expect(ids('us-east-1')).toEqual(ids(undefined))
        expect(ids(undefined)).toHaveLength(2)
    })

    it('keeps the function in a us-east-1 stack, and in a us-east-1 stack of its own when the stack is elsewhere', () => {
        const east = synthesize({ appDir, slug, transport: 'data-api', bundle: false, region: 'us-east-1' })
        expect(east.stacks.map((s) => s.environment.region)).toEqual(['us-east-1'])
        expect(functionUrlOriginProblems(east.all, east.assembly)).toEqual([])

        const west = synthesize({ appDir, slug, transport: 'data-api', bundle: false, region: 'eu-west-1' })
        const edge = west.stacks.filter((s) => s.environment.region === 'us-east-1')
        expect(edge).toHaveLength(1)
        const edgeResources = /** @type {Resources} */ (edge[0]?.template.Resources)
        const fns = Object.entries(edgeResources).filter(([, r]) => r.Type === 'AWS::Lambda::Function')
        expect(fns).toHaveLength(1)
        expect(lambdaBundles(edgeResources, west.assembly).get(/** @type {string} */ (fns[0]?.[0]))).toBe(
            BODY_HASH_SOURCE,
        )
        const edgeFn = /** @type {any} */ (fns[0]?.[1].Properties)
        expect([edgeFn.Handler, edgeFn.Runtime, edgeFn.Architectures, edgeFn.Environment]).toEqual([
            'index.handler',
            'nodejs22.x',
            ['x86_64'],
            undefined,
        ])
        const versions = Object.values(edgeResources).filter((r) => r.Type === 'AWS::Lambda::Version')
        expect(versions.map((r) => /** @type {any} */ (r).DeletionPolicy)).toEqual(['Delete'])
        const edgeRoles = Object.values(edgeResources).filter((r) => r.Type === 'AWS::IAM::Role')
        expect(edgeRoles).toHaveLength(1)
        expect(rolePrincipals(edgeRoles[0]?.Properties)).toEqual(EDGE_ROLE_PRINCIPALS)
        const distribution = /** @type {any} */ (
            Object.values(west.all).find((r) => r.Type === 'AWS::CloudFront::Distribution')
        )
        const behavior = distribution?.Properties?.DistributionConfig?.DefaultCacheBehavior
        expect(behavior.LambdaFunctionAssociations).toEqual([
            {
                EventType: 'origin-request',
                IncludeBody: true,
                LambdaFunctionARN: { 'Fn::GetAtt': [expect.stringMatching(/^BodyHashArnReader/), 'FunctionArn'] },
            },
        ])
    })
})

describe("the distribution's security headers", () => {
    const appDir = path.join(REPO, 'apps', /** @type {string} */ (APPS[0]))
    const slug = /** @type {string} */ (
        /export const APP_SLUG = '([^']+)'/.exec(readFileSync(path.join(appDir, 'config/app.ts'), 'utf8'))?.[1]
    )
    /**
     * The template of an SssbApp given `props`; `ownPolicy` passes an imported policy of the adopter's.
     * @param {Partial<import('./index.d.ts').SssbAppProps>} props
     * @param {boolean} [ownPolicy]
     */
    const templateWith = (props, ownPolicy = false) => {
        const app = new cdk.App({ outdir: makeTestTmpDir('sssb-cdk-'), context: { 'aws:cdk:bundling-stacks': [] } })
        const stack = new cdk.Stack(app, 'Headers')
        new SssbApp(stack, 'Default', {
            appDir,
            slug,
            params: { database: { transport: 'data-api' } },
            environment: 'Staging',
            production: false,
            ...props,
            ...(ownPolicy
                ? {
                      responseHeadersPolicy: cdk.aws_cloudfront.ResponseHeadersPolicy.fromResponseHeadersPolicyId(
                          stack,
                          'Own',
                          'own-policy-id',
                      ),
                  }
                : {}),
        })
        return /** @type {Resources} */ (Template.fromStack(stack).toJSON()['Resources'])
    }

    it("are AWS's managed policy by default, a custom one only when the adopter asks for includeSubDomains", () => {
        expect(securityHeadersProblems(templateWith({}))).toEqual([])
        expect(securityHeadersProblems(templateWith({ hstsIncludeSubdomains: false }))).toEqual([])
        expect(
            securityHeadersProblems(templateWith({ hstsIncludeSubdomains: true }), { includeSubdomains: true }),
        ).toEqual([])
    })

    it("are the adopter's own policy, on each behavior, when one is passed", () => {
        expect(securityHeadersProblems(templateWith({}, true), { ownPolicyId: 'own-policy-id' })).toEqual([])
        // A null includeSubDomains is left out, so it is no conflict with the adopter's policy.
        const withNull = templateWith({ hstsIncludeSubdomains: /** @type {any} */ (null) }, true)
        expect(securityHeadersProblems(withNull, { ownPolicyId: 'own-policy-id' })).toEqual([])
    })

    it("are exposed, for a behavior the adopter adds, as the construct's responseHeadersPolicy", () => {
        const app = new cdk.App({ outdir: makeTestTmpDir('sssb-cdk-'), context: { 'aws:cdk:bundling-stacks': [] } })
        const stack = new cdk.Stack(app, 'Extra')
        const sssb = new SssbApp(stack, 'Default', {
            appDir,
            slug,
            params: { database: { transport: 'data-api' } },
            environment: 'Staging',
            production: false,
        })
        sssb.distribution.addBehavior(
            '/extra/*',
            cdk.aws_cloudfront_origins.S3BucketOrigin.withOriginAccessControl(sssb.assetsBucket),
            {
                viewerProtocolPolicy: cdk.aws_cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
                responseHeadersPolicy: sssb.responseHeadersPolicy,
            },
        )
        const all = /** @type {Resources} */ (Template.fromStack(stack).toJSON()['Resources'])
        const config = /** @type {any} */ (
            Object.values(all).find((r) => r.Type === 'AWS::CloudFront::Distribution')?.Properties
        )?.DistributionConfig
        const extra = (config?.CacheBehaviors ?? []).find((/** @type {any} */ b) => b.PathPattern === '/extra/*')
        expect(extra?.ResponseHeadersPolicyId).toBe(MANAGED_SECURITY_HEADERS_POLICY_ID)
    })

    it('take a null as left out', () => {
        const none = /** @type {any} */ (null)
        expect(
            securityHeadersProblems(templateWith({ responseHeadersPolicy: none, hstsIncludeSubdomains: none })),
        ).toEqual([])
        // A null policy is no policy of the adopter's, so includeSubDomains beside it is SSSB's to build.
        const all = templateWith({ responseHeadersPolicy: none, hstsIncludeSubdomains: true })
        expect(securityHeadersProblems(all, { includeSubdomains: true })).toEqual([])
    })

    it('refuse an includeSubDomains that is not a boolean, or one beside a policy of the adopter’s', () => {
        expect(() => templateWith({ hstsIncludeSubdomains: /** @type {any} */ ('yes') })).toThrow(
            /hstsIncludeSubdomains must be true or false/,
        )
        expect(() => templateWith({ hstsIncludeSubdomains: false }, true)).toThrow(
            /with responseHeadersPolicy, set Strict-Transport-Security in that policy/,
        )
        for (const notAPolicy of ['own-policy-id', false]) {
            expect(() => templateWith({ responseHeadersPolicy: /** @type {any} */ (notAPolicy) })).toThrow(
                /responseHeadersPolicy must be a response headers policy/,
            )
        }
    })
})

describe("the forwarded-host function's name", () => {
    const appDir = path.join(REPO, 'apps', /** @type {string} */ (APPS[0]))
    /**
     * The function's name as the template gives it, in a stack of the given name.
     * @param {string} stackName
     * @param {string} slug
     */
    function nameIn(stackName, slug) {
        const app = new cdk.App({ outdir: makeTestTmpDir('sssb-cdk-'), context: { 'aws:cdk:bundling-stacks': [] } })
        // One construct path, as one infra/app.ts deployed as two environments under two stack names would give.
        const stack = new cdk.Stack(app, 'Shared', { stackName })
        new SssbApp(stack, 'Default', {
            appDir,
            slug,
            params: { database: { transport: 'data-api' } },
            environment: 'Staging',
            production: false,
            // The custom response headers policy, whose name is account-wide too.
            hstsIncludeSubdomains: true,
        })
        const all = Object.values(/** @type {Resources} */ (Template.fromStack(stack).toJSON()['Resources']))
        const fns = all.filter((r) => r.Type === 'AWS::CloudFront::Function')
        const policies = all.filter((r) => r.Type === 'AWS::CloudFront::ResponseHeadersPolicy')
        expect([fns.length, policies.length]).toEqual([1, 1])
        policyNames.push(/** @type {any} */ (policies[0])?.Properties?.ResponseHeadersPolicyConfig?.Name)
        return /** @type {any} */ (fns[0])?.Properties?.Name
    }
    /** @type {unknown[]} */
    const policyNames = []

    it("differs between two stack names in one account and region, and stays within CloudFront's 64 characters", () => {
        const slug = /** @type {string} */ (
            /export const APP_SLUG = '([^']+)'/.exec(readFileSync(path.join(appDir, 'config/app.ts'), 'utf8'))?.[1]
        )
        const staging = nameIn('app-staging', slug)
        const production = nameIn('app-production', slug)
        expect(staging).not.toEqual(production)
        // The response headers policy's name is account-wide too, and keyed the same way: CDK's default carries the
        // stack name but not the region, so one stack name deployed to two regions of an account would collide.
        expect(policyNames).toHaveLength(2)
        expect(policyNames[0]).not.toEqual(policyNames[1])
        expect(/** @type {any} */ (policyNames[0])?.['Fn::Join']?.[1]?.[0]).toEqual({ Ref: 'AWS::Region' })
        // The region is a pseudo-parameter until deploy: the rest of the name is literal.
        const [joiner, [region, ...rest]] = staging['Fn::Join']
        expect(region).toEqual({ Ref: 'AWS::Region' })
        const literal = rest.join(joiner)
        expect(literal).toMatch(/^[A-Za-z0-9_-]+$/)
        expect('ap-southeast-5'.length + joiner.length + literal.length).toBeLessThanOrEqual(64)
    })
})

describe('the forwarded-host function', () => {
    /** The function as CloudFront's JS runtime loads it: a script defining `handler`, run alone. */
    const handler = /** @type {(event: any) => any} */ (vm.runInNewContext(`${FORWARDED_HOST_SOURCE}\nhandler`, {}))
    /** @param {Record<string, { value: string, multiValue?: { value: string }[] }>} headers */
    const request = (headers) => handler({ request: { method: 'GET', uri: '/en', querystring: {}, headers } }).headers

    it('overwrites a forged x-forwarded-host and port with the host CloudFront received and 443', () => {
        const headers = request({
            host: { value: 'app.example.org' },
            'x-forwarded-host': { value: 'evil.example', multiValue: [{ value: 'evil.example' }, { value: 'b' }] },
            'x-forwarded-port': { value: '8443' },
            forwarded: { value: 'host=evil.example;proto=http' },
            cookie: { value: 'a=1' },
        })
        expect(headers['x-forwarded-host']).toEqual({ value: 'app.example.org' })
        expect(headers['x-forwarded-port']).toEqual({ value: '443' })
        expect(headers).not.toHaveProperty(['forwarded'])
        // Everything else goes on as the viewer sent it.
        expect(headers['host']).toEqual({ value: 'app.example.org' })
        expect(headers['cookie']).toEqual({ value: 'a=1' })
    })

    it('lowercases the host and drops any port the Host carried', () => {
        expect(request({ host: { value: 'App.Example.ORG:8443' } })['x-forwarded-host']).toEqual({
            value: 'app.example.org',
        })
    })

    it('sets them on a request that carried none, and drops a forged host when there is no Host to take', () => {
        expect(request({ host: { value: 'd111.cloudfront.net' } })['x-forwarded-host']).toEqual({
            value: 'd111.cloudfront.net',
        })
        expect(request({ 'x-forwarded-host': { value: 'evil.example' } })).not.toHaveProperty(['x-forwarded-host'])
    })
})

describe('the body-hash function', () => {
    /**
     * An origin-request event carrying `body`.
     * @param {{ inputTruncated?: boolean, encoding?: string, data?: string } | undefined} body
     * @param {Record<string, { key?: string, value: string }[]>} [headers]
     */
    const event = (body, headers = {}) => ({
        Records: [{ cf: { request: { method: 'POST', uri: '/api/items', headers, ...(body && { body }) } } }],
    })
    /** @param {string | Buffer} bytes */
    const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex')

    it('sets the SHA-256 of the body CloudFront hands over, in place of whatever the viewer sent', async () => {
        const payload = Buffer.from('{"name":"ünïcode ✓"}\n\u0000binary', 'utf8')
        const forged = { 'x-amz-content-sha256': [{ key: 'X-Amz-Content-Sha256', value: 'UNSIGNED-PAYLOAD' }] }
        const result = /** @type {any} */ (
            await bodyHashHandler(event({ encoding: 'base64', data: payload.toString('base64') }, forged))
        )
        expect(result.headers['x-amz-content-sha256']).toEqual([
            { key: 'x-amz-content-sha256', value: sha256(payload) },
        ])
        // The body itself goes on untouched: what was hashed is what Lambda receives.
        expect(result.body).toEqual({ encoding: 'base64', data: payload.toString('base64') })
        expect(result.uri).toBe('/api/items')
    })

    it('hashes a text body as UTF-8, and a request with no body as the empty string', async () => {
        const text = /** @type {any} */ (await bodyHashHandler(event({ encoding: 'text', data: 'a=1&b=é' })))
        expect(text.headers['x-amz-content-sha256'][0].value).toBe(sha256(Buffer.from('a=1&b=é', 'utf8')))
        const empty = /** @type {any} */ (await bodyHashHandler(event(undefined)))
        expect(empty.headers['x-amz-content-sha256'][0].value).toBe(sha256(''))
        const blank = /** @type {any} */ (await bodyHashHandler(event({ encoding: 'base64', data: '' })))
        expect(blank.headers['x-amz-content-sha256'][0].value).toBe(sha256(''))
    })

    it('answers 413 for a body CloudFront truncated, rather than a hash of part of it', async () => {
        const result = /** @type {any} */ (
            await bodyHashHandler(event({ inputTruncated: true, encoding: 'base64', data: 'AAAA' }))
        )
        expect(result.status).toBe('413')
        expect(result).not.toHaveProperty(['uri'])
    })
})

describe('a synth that does not bundle this stack', () => {
    it('still checks the environment, and skips only the bundle it did not build', () => {
        const appDir = path.join(REPO, 'apps', /** @type {string} */ (APPS[0]))
        const slug = /export const APP_SLUG = '([^']+)'/.exec(readFileSync(path.join(appDir, 'config/app.ts'), 'utf8'))
        const { all } = synthesize({ appDir, slug: /** @type {string} */ (slug?.[1]), transport: 'pg', bundle: false })
        expect(lambdaFunction(all, 'Server').env['APP_MODE']).toBe('real')
    })
})

/** What Aurora PostgreSQL accepts as a database name: letters, digits and underscores, from a letter, up to 63. */
const AURORA_DATABASE_NAME = /^[A-Za-z][A-Za-z0-9_]{0,62}$/

describe('the database name', () => {
    it('is the slug with each dash as an underscore, and a slug with no dash unchanged', () => {
        expect(databaseNameFor('showcase')).toBe('showcase')
        expect(databaseNameFor('starter')).toBe('starter')
        expect(databaseNameFor('acme-corp')).toBe('acme_corp')
        expect(databaseNameFor('a-b-2')).toBe('a_b_2')
        expect(databaseNameFor('a'.repeat(63))).toBe('a'.repeat(63))
    })

    it('is always a name Aurora accepts, and two slugs never share one', () => {
        const slugs = [
            'acme',
            'acme-corp',
            'acme-corp-2',
            'acme2',
            'a',
            'a-b',
            'ab',
            'x'.repeat(63),
            'x-'.repeat(31) + 'x',
        ]
        const names = slugs.map(databaseNameFor)
        for (const name of names) expect(name).toMatch(AURORA_DATABASE_NAME)
        expect(new Set(names).size).toBe(slugs.length)
    })

    it('refuses what is not a slug, or is too long for a database name', () => {
        for (const bad of ['Acme', 'acme_corp', '-acme', '1acme', '', 'acme corp']) {
            expect(() => databaseNameFor(bad), bad).toThrow(/slug must be lowercase letters, digits and dashes/)
        }
        expect(() => databaseNameFor('a'.repeat(64))).toThrow(/at most 63/)
    })

    it('refuses a slug whose database name Aurora reserves', () => {
        for (const reserved of [
            'user',
            'select',
            'order',
            'table',
            'postgres',
            'rdsadmin',
            'template1',
            'current-user',
        ]) {
            expect(() => databaseNameFor(reserved), reserved).toThrow(/a word Aurora PostgreSQL reserves/)
        }
    })

    // A scratch app inside this repository, so the construct finds the repository's lock file, esbuild and framework
    // above it, as an app under apps/ does: not a makeTestTmpDir directory, which has no lock file above it and so no
    // project root (the construct refuses such an app). afterAll removes it, a failed run included. Its slug has a
    // dash, which a slug may have and Aurora's names may not.
    const scratch = path.join(REPO, 'node_modules/.cache', `sssb-cdk-dashed-${process.pid}`, 'my-app')
    afterAll(() => rmSync(path.dirname(scratch), { recursive: true, force: true }))

    it.each(/** @type {const} */ (['pg', 'data-api']))(
        'is what a dashed-slug app synthesizes over %s: the cluster, the server and the migrator agree',
        (transport) => {
            mkdirSync(path.join(scratch, 'config'), { recursive: true })
            mkdirSync(path.join(scratch, 'src/app-config/db/migrations'), { recursive: true })
            writeFileSync(path.join(scratch, 'package.json'), JSON.stringify({ name: 'my-app', private: true }))
            writeFileSync(path.join(scratch, 'config/app.ts'), "export const APP_SLUG = 'my-app'\n")
            writeFileSync(
                path.join(scratch, 'src/app-config/db/migrations/index.ts'),
                'export const appMigrations = {}\n',
            )

            const { all } = synthesize({ appDir: scratch, slug: 'my-app', transport, bundle: false })
            const cluster = Object.values(all).find((r) => r.Type === 'AWS::RDS::DBCluster')
            expect(cluster?.Properties?.['DatabaseName']).toBe('my_app')
            expect(cluster?.Properties?.['DatabaseName']).toMatch(AURORA_DATABASE_NAME)
            const server = lambdaFunction(all, 'Server')
            if (transport === 'pg') {
                // The URL's database is the last segment of a CloudFormation join.
                expect(JSON.stringify(server.env['DATABASE_URL'])).toMatch(/"\/my_app"\]\]\}$/)
            } else {
                expect(server.env['DATABASE_NAME']).toBe('my_app')
            }
            // On both transports the migrator is told the name, not left to a secret field the template cannot show.
            expect(lambdaFunction(all, 'Migrator').env['DATABASE_NAME']).toBe('my_app')
        },
    )

    // The apps in this tree: SSSB's own (no dash, so the name is the slug and nothing is renamed), or, in an adopter's
    // tree, an app whose slug may have a dash (`acme-corp`).
    it.each(APPS)("names apps/%s's database from its slug, and an undashed slug's database the slug itself", (app) => {
        const appDir = path.join(REPO, 'apps', app)
        const slug = /** @type {string} */ (
            /export const APP_SLUG = '([^']+)'/.exec(readFileSync(path.join(appDir, 'config/app.ts'), 'utf8'))?.[1]
        )
        const { all } = synthesize({ appDir, slug, transport: 'pg', bundle: false })
        const cluster = Object.values(all).find((r) => r.Type === 'AWS::RDS::DBCluster')
        expect(cluster?.Properties?.['DatabaseName']).toBe(databaseNameFor(slug))
        if (!slug.includes('-')) expect(cluster?.Properties?.['DatabaseName']).toBe(slug)
    })
})

/**
 * Each Node.js Lambda `SssbApp` builds in this synth, loaded the way Lambda's Node runtime loads it: the handler's
 * module, found by Lambda's extension order and imported or required as Lambda would, must evaluate and export its
 * handler. A module that throws as it loads fails every invocation, and nothing else here runs a bundle: the Migrator's
 * once threw `Dynamic require of "events" is not supported` on every deploy, from the `pg` esbuild inlined into its ESM
 * bundle. Lambda's runtime provides the AWS SDK v3, which the bundles leave external; here the kit's installed copy
 * stands in for it, linked beside each staged copy. Two differences remain: the Node is this one, not the function's
 * runtime version, and the SDK is only the clients the kit installs. So CDK's own provider functions (logical ids
 * starting `Custom`), which need clients the kit may not have, are not loaded. Nothing is invoked.
 * @param {Resources} all
 * @param {string} assembly
 * @param {string} sdkDir the directory holding `@aws-sdk/*` packages
 * @returns {{ loaded: string[], problems: string[] }}
 */
function lambdaLoadProblems(all, assembly, sdkDir) {
    /** @type {string[]} */
    const loaded = []
    /** @type {string[]} */
    const problems = []
    for (const [id, r] of Object.entries(all)) {
        const props = /** @type {any} */ (r.Properties ?? {})
        if (r.Type !== 'AWS::Lambda::Function' || !String(props.Runtime ?? '').startsWith('nodejs')) continue
        if (id.startsWith('Custom')) continue
        const key = props.Code?.S3Key
        const handler = String(props.Handler ?? '')
        const dot = handler.lastIndexOf('.')
        if (typeof key !== 'string' || dot <= 0) continue
        const [file, exported] = [handler.slice(0, dot), handler.slice(dot + 1)]
        const staged = path.join(assembly, `asset.${key.replace(/\.zip$/, '')}`)
        const entry = ['.js', '.mjs', '.cjs']
            .map((ext) => `${file}${ext}`)
            .find((name) => existsSync(path.join(staged, name)))
        // A handler that is no module of the asset (the server's, run by the Web Adapter's run.sh) is not Node's to load.
        if (entry === undefined) continue
        const copy = makeTestTmpDir('sssb-lambda-load-')
        cpSync(staged, copy, { recursive: true })
        mkdirSync(path.join(copy, 'node_modules'), { recursive: true })
        symlinkSync(sdkDir, path.join(copy, 'node_modules/@aws-sdk'), 'dir')
        // In a child `node`, never this process: Vitest runs an `import()` through its own module runner, which
        // supplies a `require` that Lambda's Node does not, and the Migrator's crash loaded cleanly under it.
        const url = pathToFileURL(path.join(copy, entry)).href
        // As Lambda's Node runtime loads a handler: by import an `.mjs`, or a `.js` beside a package.json whose type is
        // `module`; by require any other.
        const manifest = path.join(copy, 'package.json')
        const esm =
            entry.endsWith('.mjs') ||
            (entry.endsWith('.js') &&
                existsSync(manifest) &&
                JSON.parse(readFileSync(manifest, 'utf8')).type === 'module')
        const load = esm
            ? `await import(${JSON.stringify(url)})`
            : `(await import('node:module')).createRequire(${JSON.stringify(url)})(${JSON.stringify(path.join(copy, entry))})`
        const script =
            `const m = ${load};` +
            `if (typeof m[${JSON.stringify(exported)}] !== 'function') { console.error('exports no function'); process.exit(3) }` +
            // Lambda freezes after init, so a handle a module opens as it loads (a timer, a socket) never ends a load
            // there; here it would keep the child alive, so the child exits, and a hang is cut short.
            'process.exit(0)'
        const run = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
            encoding: 'utf8',
            env: {},
            timeout: 60_000,
        })
        if (run.status === 0) loaded.push(id)
        else {
            const reason =
                run.error?.message ??
                run.stderr.split('\n').find((line) => /Error|exports no function/.test(line)) ??
                run.stderr
            problems.push(`${id}: ${entry} does not load: ${reason.trim()}`)
        }
    }
    return { loaded, problems }
}

describe('every Node.js Lambda SssbApp builds loads in Node', () => {
    describe.each(APPS)('%s', (name) => {
        const appDir = path.join(REPO, 'apps', name)
        const slug = /** @type {string} */ (
            /export const APP_SLUG = '([^']+)'/.exec(readFileSync(path.join(appDir, 'config/app.ts'), 'utf8'))?.[1]
        )
        const sdkDir = path.join(kitDirOf(appDir), 'node_modules/@aws-sdk')

        it.each(/** @type {Transport[]} */ (['pg', 'data-api']))(
            'on the %s shape',
            async (transport) => {
                const { all, assembly } = synthesize({
                    appDir,
                    slug,
                    transport,
                    scheduledTick: (stack) => ({ webhookSecret: new cdk.aws_secretsmanager.Secret(stack, 'Tick') }),
                })
                const { loaded, problems } = lambdaLoadProblems(all, assembly, sdkDir)
                expect(problems).toEqual([])
                // Each Node.js function SssbApp builds was found and loaded, not skipped.
                for (const prefix of ['Migrator', 'BodyHash', 'ScheduledTick']) {
                    expect(
                        loaded.some((id) => id.startsWith(prefix)),
                        `${prefix} loaded`,
                    ).toBe(true)
                }
            },
            120_000,
        )
    })
})
