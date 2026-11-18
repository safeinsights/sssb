import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import * as cdk from 'aws-cdk-lib'
import { Template } from 'aws-cdk-lib/assertions'
// The generic checks live in `@sssb/tools`, so an adopter whose infra does not use this stack's construct can
// run the same ones over their own synthesized assembly (ADR-0014 part 8). What stays here is about THIS stack.
import {
    dataApiShapeProblems,
    failClosedEnvironmentProblems,
    lambdaBundles,
    lambdaFunction,
    migratorBundleProblems,
    secretGrantProblems,
    type Resources,
} from '@sssb/tools/assembly-checks'
// The runtime's own list of what each transport requires — the contract this stack must satisfy. Read
// from the module that enforces it at boot, by path (infra resolves nothing through the `@sssb/kit` alias),
// so renaming a variable on either side fails here instead of at the first deploy.
import { DATABASE_ENV } from '../packages/kit/src/adapters/real/database-transport'
import { APP_TSCONFIG, AppStack } from './stack'

/**
 * BOTH network shapes, synthesized and checked — `pnpm synth` runs this after `cdk synth`, and CI runs
 * `pnpm synth`. `cdk synth` alone builds only the shape the app's params choose (`pg` by default), so
 * without this the opt-in `data-api` shape, its grants and its environment would never be built by any
 * gate. Offline, like synth: nothing is deployed and no credentials are read.
 */

type Transport = keyof typeof DATABASE_ENV

const problems: string[] = []
const check = (ok: boolean, message: string) => {
    if (!ok) problems.push(message)
}

/**
 * A shape's template, and the directory its synth staged assets in (bundles included). The directory is
 * this check's own, never `CDK_OUTDIR`, so removing it afterwards cannot touch a real `cdk.out`.
 */
function synthesize(transport: Transport): { all: Resources; assembly: string } {
    const outdir = mkdtempSync(path.join(tmpdir(), 'sssb-shape-check-'))
    const app = new cdk.App({ outdir, context: { environment: 'Staging' } })
    const stack = new AppStack(app, `ShapeCheck-${transport}`, { databaseTransport: transport })
    const all = Template.fromStack(stack).toJSON().Resources as Resources
    return { all, assembly: app.synth().directory }
}

/** The app's directory, relative to the repo root: where esbuild's path comments place its modules. */
const APP_DIR = path.relative(path.join(__dirname, '..'), path.dirname(APP_TSCONFIG))

/**
 * The app's own migrations, by the names its registry gives them (the keys Kysely records), read from the
 * app seam's migration index rather than guessed from file names.
 */
const APP_MIGRATIONS = [
    ...readFileSync(path.join(path.dirname(APP_TSCONFIG), 'src/app-config/db/migrations/index.ts'), 'utf8').matchAll(
        /['"](\d+_[^'"]+)['"]\s*:/g,
    ),
].map((match) => match[1]!)

/**
 * The sources a migrator bundle must name, as esbuild's per-module path comments: the framework's
 * registry and the app's. Requiring them makes the checks fail CLOSED: a minified bundle carries no such
 * comments, and so fails here instead of passing every check that reads them.
 */
const MIGRATOR_SOURCES = ['packages/kit/src/db/migrations/index.ts', `${APP_DIR}/src/app-config/db/migrations/index.ts`]

const count = (all: Resources, type: string) => Object.values(all).filter((r) => r.Type === type).length

for (const transport of ['pg', 'data-api'] as const) {
    // A check from `@sssb/tools` returns the problems it found; each is reported under this shape.
    const problem = (found: string[], what = 'the synthesized stack') => {
        for (const message of found) problems.push(`[${transport}] ${what}: ${message}`)
    }
    const { all, assembly } = synthesize(transport)
    const label = (what: string) => `[${transport}] ${what}`
    const cluster = Object.values(all).find((r) => r.Type === 'AWS::RDS::DBCluster')?.Properties ?? {}
    const server = lambdaFunction(all, 'Server')
    const migrator = lambdaFunction(all, 'Migrator')

    check(server.env.DATABASE_TRANSPORT === transport, label('the server says which transport it runs'))
    check(migrator.env.DATABASE_TRANSPORT === transport, label('the migrator says which transport it runs'))

    // The database secret is read by name, on both shapes, and no role attaches a managed policy the check
    // cannot read. On data-api these are also part of dataApiShapeProblems, which repeats them harmlessly.
    problem(secretGrantProblems(all))

    // The server comes up fail-closed, on both shapes: `real` mode, no demo or e2e switch.
    problem(failClosedEnvironmentProblems(server.env), 'the server’s environment')

    // Encrypted at rest, on both shapes. An Aurora instance takes its encryption from its cluster, so the
    // cluster is what is checked.
    const clusters = Object.values(all).filter((r) => r.Type === 'AWS::RDS::DBCluster')
    check(
        clusters.length > 0 && clusters.every((r) => r.Properties?.StorageEncrypted === true),
        label('every database cluster is encrypted at rest (StorageEncrypted)'),
    )

    // What each bundled Lambda really contains. The tsconfig it is built with decides where
    // `@sssb/app-config/*` resolves: to the app's seam, never to SSSB's test fixture.
    const built = lambdaBundles(all, assembly)
    for (const [id, code] of built) {
        check(!code.includes('test-fixture'), label(`${id}'s bundle holds no code from packages/kit/test-fixture`))
    }
    problem(
        migratorBundleProblems({
            code: [...built].find(([id]) => id.startsWith('Migrator'))?.[1],
            sources: MIGRATOR_SOURCES,
            migrations: APP_MIGRATIONS,
        }),
    )
    rmSync(assembly, { recursive: true, force: true })

    if (transport === 'data-api') {
        for (const name of Object.keys(DATABASE_ENV['data-api'])) {
            check(name in server.env, label(`the server sets ${name}, which the runtime requires`))
            check(name in migrator.env, label(`the migrator sets ${name}, which it requires`))
        }
        check(!('DATABASE_URL' in server.env), label('no DATABASE_URL: the credential stays in Secrets Manager'))
        check(!('DATABASE_URL' in migrator.env), label('no DATABASE_URL on the migrator either'))
        check(!server.inVpc && !migrator.inVpc, label('both Lambdas run outside the VPC'))
        check(cluster.EnableHttpEndpoint === true, label('the cluster has the Data API enabled'))
        check(count(all, 'AWS::EC2::NatGateway') === 0, label('no NAT gateway'))
        check(count(all, 'AWS::EC2::InternetGateway') === 0, label('no internet gateway'))
        // The Data API grants, the secret and the database security group: see dataApiShapeProblems.
        problem(dataApiShapeProblems(all))
    } else {
        for (const name of Object.keys(DATABASE_ENV.pg)) {
            check(name in server.env, label(`the server sets ${name}, which the runtime requires`))
        }
        check('DB_SECRET_ARN' in migrator.env, label('the migrator gets the secret it builds its connection from'))
        check(server.inVpc && migrator.inVpc, label('both Lambdas run inside the VPC'))
        check(!('EnableHttpEndpoint' in cluster), label('the pg cluster leaves the Data API unset, as before'))
        check(count(all, 'AWS::EC2::NatGateway') === 1, label('one NAT gateway for the Lambdas’ egress'))
    }
}

if (problems.length > 0) {
    console.error(`infra shape check failed:\n  ${problems.join('\n  ')}`)
    process.exit(1)
}
console.log('infra shape check: both network shapes match the runtime contract')
