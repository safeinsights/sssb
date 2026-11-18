// @ts-check
// SssbApp, synthesized for real: both network shapes for every app in this repository that has an `infra/`
// (what `infra/check-shapes.ts` did for the root stack, jpslav/keel#49 and #54), the production fail-closed
// environment (moved here from packages/kit's production-guard test, which read the old stack's source), and
// each synth assertion the construct makes, seen to FAIL on the thing it guards. Offline, like synth: nothing
// is deployed and no credentials are read.
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import * as cdk from 'aws-cdk-lib'
import { Template } from 'aws-cdk-lib/assertions'
import { describe, expect, it } from 'vitest'
import { makeTestTmpDir } from '../../../tests/support/tmp-dir'
import { dataApiShapeProblems, lambdaBundles, lambdaFunction, secretGrantProblems } from '@sssb/tools/assembly-checks'
import { kitDirOf } from '@sssb/tools/kit'
import { SssbApp } from './index.js'

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
 * construct and before synth, as an adopter's own code would.
 * @param {{ appDir: string, slug: string, transport: Transport, bundle?: boolean, configure?: (app: SssbApp) => void }} options
 */
function synthesize({ appDir, slug, transport, bundle = true, configure }) {
    const outdir = makeTestTmpDir('sssb-cdk-')
    const context = bundle ? {} : { 'aws:cdk:bundling-stacks': [] }
    const app = new cdk.App({ outdir, context })
    const stack = new cdk.Stack(app, `ShapeCheck-${transport}`)
    const construct = new SssbApp(stack, 'Default', {
        appDir,
        slug,
        params: { database: { transport } },
        environment: 'Staging',
        production: false,
    })
    configure?.(construct)
    const assembly = app.synth()
    const all = /** @type {Resources} */ (Template.fromStack(stack).toJSON().Resources)
    return { all, assembly: assembly.directory }
}

/** @param {Resources} all @param {string} type */
const count = (all, type) => Object.values(all).filter((r) => r.Type === type).length

/** The variables each transport requires, from the framework the app itself resolves (its boot check's list). */
/** @param {string} appDir @returns {Promise<Record<Transport, Record<string, string>>>} */
async function databaseEnvOf(appDir) {
    const file = path.join(kitDirOf(appDir), 'src/adapters/real/database-transport.ts')
    return (await import(pathToFileURL(file).href)).DATABASE_ENV
}

describe.each(APPS)('the %s app, synthesized through SssbApp', (name) => {
    const appDir = path.join(REPO, 'apps', name)

    describe.each(/** @type {Transport[]} */ (['pg', 'data-api']))('on the %s shape', (transport) => {
        it('matches the runtime contract, grants nothing wider than the cluster, and fails closed', async () => {
            const { APP_SLUG } = await import(pathToFileURL(path.join(appDir, 'config/app.ts')).href)
            const DATABASE_ENV = await databaseEnvOf(appDir)
            const { all, assembly } = synthesize({ appDir, slug: APP_SLUG, transport })
            const server = lambdaFunction(all, 'Server')
            const migrator = lambdaFunction(all, 'Migrator')
            const cluster = Object.values(all).find((r) => r.Type === 'AWS::RDS::DBCluster')?.Properties ?? {}

            expect(server.env.DATABASE_TRANSPORT).toBe(transport)
            expect(migrator.env.DATABASE_TRANSPORT).toBe(transport)
            for (const variable of Object.keys(DATABASE_ENV[transport])) {
                expect(server.env, `the server sets ${variable}, which the runtime requires`).toHaveProperty([variable])
            }
            expect(secretGrantProblems(all)).toEqual([])
            // Encrypted at rest, on both shapes. An Aurora instance takes its encryption from its cluster.
            const clusters = Object.values(all).filter((r) => r.Type === 'AWS::RDS::DBCluster')
            expect(clusters.length).toBeGreaterThan(0)
            expect(clusters.every((r) => r.Properties?.StorageEncrypted === true)).toBe(true)

            // What each bundled Lambda really contains (the migrator's own expectations are the construct's
            // synth assertion, which `synthesize` has already passed).
            const bundles = lambdaBundles(all, assembly)
            expect([...bundles.keys()].some((id) => id.startsWith('Migrator'))).toBe(true)
            for (const [id, code] of bundles) {
                expect(code.includes('test-fixture'), `${id}'s bundle holds code from a test fixture`).toBe(false)
            }

            // The production fail-closed guard (packages/kit/src/adapters/index.ts) is irrelevant only while
            // every deployed environment pins APP_MODE=real and sets neither opt-in.
            expect(server.env.APP_MODE).toBe('real')
            for (const [id, r] of Object.entries(all)) {
                if (r.Type !== 'AWS::Lambda::Function') continue
                const env = JSON.stringify(r.Properties?.Environment ?? {})
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
                expect(cluster.EnableHttpEndpoint).toBe(true)
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
            /** @type {Resources} */ (Template.fromStack(stack).toJSON().Resources),
            'Migrator',
        )
        expect(migrator.id).toMatch(/^Migrator/)
    })
})

describe('a production deployment', () => {
    it('keeps its data: the database and both buckets are retained, and the writer stays warm', () => {
        const appDir = path.join(REPO, 'apps', /** @type {string} */ (APPS[0]))
        const slug = /export const APP_SLUG = '([^']+)'/.exec(readFileSync(path.join(appDir, 'config/app.ts'), 'utf8'))
        const outdir = makeTestTmpDir('sssb-cdk-')
        const app = new cdk.App({ outdir, context: { 'aws:cdk:bundling-stacks': [] } })
        const stack = new cdk.Stack(app, 'Production')
        new SssbApp(stack, 'Default', {
            appDir,
            slug: /** @type {string} */ (slug?.[1]),
            params: { database: { transport: 'pg' } },
            environment: 'Production',
            production: true,
        })
        const template = /** @type {{ Resources: Record<string, any> }} */ (Template.fromStack(stack).toJSON())
        const ofType = (/** @type {string} */ type) => Object.values(template.Resources).filter((r) => r.Type === type)
        const [cluster] = ofType('AWS::RDS::DBCluster')
        expect(cluster.DeletionPolicy).toBe('Retain')
        expect(cluster.Properties.ServerlessV2ScalingConfiguration.MinCapacity).toBe(1)
        const buckets = ofType('AWS::S3::Bucket')
        expect(buckets).toHaveLength(2)
        expect(buckets.every((b) => b.DeletionPolicy === 'Retain')).toBe(true)
        expect(ofType('Custom::S3AutoDeleteObjects')).toHaveLength(0)
    })
})

describe('a synth that does not bundle this stack', () => {
    it('still checks the environment, and skips only the bundle it did not build', () => {
        const appDir = path.join(REPO, 'apps', /** @type {string} */ (APPS[0]))
        const slug = /export const APP_SLUG = '([^']+)'/.exec(readFileSync(path.join(appDir, 'config/app.ts'), 'utf8'))
        const { all } = synthesize({ appDir, slug: /** @type {string} */ (slug?.[1]), transport: 'pg', bundle: false })
        expect(lambdaFunction(all, 'Server').env.APP_MODE).toBe('real')
    })
})
