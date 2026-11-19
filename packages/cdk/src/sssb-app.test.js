// @ts-check
// SssbApp, synthesized for real: both network shapes for every app in this repository that has an `infra/`
// (what `infra/check-shapes.ts` did for the root stack, jpslav/keel#49 and #54), the production fail-closed
// environment (moved here from packages/kit's production-guard test, which read the old stack's source), and
// each synth assertion the construct makes, seen to FAIL on the thing it guards. Offline, like synth: nothing
// is deployed and no credentials are read.
import { Buffer } from 'node:buffer'
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
import { PORT_SWITCHES } from './optional-ports.js'
import { toolsVersionProblem } from './sssb-app.js'

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
    scheduledTick,
}) {
    const outdir = makeTestTmpDir('sssb-cdk-')
    const context = bundle ? {} : { 'aws:cdk:bundling-stacks': [] }
    const app = new cdk.App({ outdir, context })
    const stack = new cdk.Stack(app, `ShapeCheck-${transport}`, region === undefined ? {} : { env: { region } })
    const construct = new SssbApp(stack, 'Default', {
        appDir,
        slug,
        params: { database: { transport }, ...(ports && { ports }) },
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
    const trusted = JSON.stringify(role?.AssumeRolePolicyDocument ?? null)
    if (!trusted.includes('edgelambda.amazonaws.com')) problems.push("Lambda@Edge may assume the function's role")
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
        expect(withPorts('none')).toThrow(/params\.ports must be an object/)
        expect(withPorts({ llm: 'none', jobs: 'in-process' })).not.toThrow()
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
            expect(lambdaFunction(all, 'Server').env['HOSTNAME']).toBe('0.0.0.0')
        },
    )

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
        expect(JSON.stringify(Object.values(edgeResources).find((r) => r.Type === 'AWS::IAM::Role'))).toContain(
            'edgelambda.amazonaws.com',
        )
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
        })
        const fns = Object.values(/** @type {Resources} */ (Template.fromStack(stack).toJSON()['Resources'])).filter(
            (r) => r.Type === 'AWS::CloudFront::Function',
        )
        expect(fns).toHaveLength(1)
        return /** @type {any} */ (fns[0])?.Properties?.Name
    }

    it("differs between two stack names in one account and region, and stays within CloudFront's 64 characters", () => {
        const slug = /** @type {string} */ (
            /export const APP_SLUG = '([^']+)'/.exec(readFileSync(path.join(appDir, 'config/app.ts'), 'utf8'))?.[1]
        )
        const staging = nameIn('app-staging', slug)
        const production = nameIn('app-production', slug)
        expect(staging).not.toEqual(production)
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
