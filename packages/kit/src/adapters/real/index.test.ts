import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DATABASE_TRANSPORTS } from './database-transport'
import { OPTIONAL_PORTS } from './optional-ports'

/**
 * The RDS Data API transport is OPT-IN (ADR-0002, addendum 2026-11-16): a `pg` deployment must never load
 * its SDK, so the transport sits behind a dynamic import in createRealPorts. These tests watch the module
 * loads themselves — a counter in each mock factory, which runs only when the module is actually imported —
 * rather than trusting the import statement to say so. The data-api case proves the counters can move: it
 * must see both modules load.
 *
 * The other real adapters are stubbed: they are not what is being tested, and constructing them would
 * reach for vendor SDKs this test has no reason to load. `./db` is the real one (a pg Pool connects
 * lazily, so building it is offline).
 */
const loaded = vi.hoisted(() => ({
    rdsDataSdk: 0,
    dataApiTransport: 0,
    llm: 0,
    email: 0,
    codebuild: 0,
    inProcess: 0,
    storage: 0,
}))

vi.mock('./auth', () => ({ realAuth: {} }))
vi.mock('./analytics', () => ({ createRealAnalytics: () => ({}) }))

const COMMON_ENV = {
    NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: 'pk',
    CLERK_SECRET_KEY: 'sk',
    STORAGE_BUCKET: 'bucket',
    AWS_REGION: 'us-east-1',
    JOBS_CODEBUILD_PROJECT: 'jobs',
    WEBHOOK_SECRET: 'secret',
    ANTHROPIC_API_KEY: 'key',
    MAILGUN_DOMAIN: 'mg.example.com',
    MAILGUN_API_KEY: 'key',
    EMAIL_FROM: 'app@example.com',
    MAILGUN_WEBHOOK_SIGNING_KEY: 'key',
}
const DATA_API_ENV = {
    DATABASE_CLUSTER_ARN: 'arn:aws:rds:us-east-1:000000000000:cluster:c',
    DATABASE_SECRET_ARN: 'arn:aws:secretsmanager:us-east-1:000000000000:secret:s',
    DATABASE_NAME: 'app',
}

/** What the registry hands createRealPorts: an in-process runner that says what it was built with. */
const HOOKS = { inProcessJobs: async (ports: object) => ({ start: async () => {}, kind: 'in-process', ports }) }

function stubEnv(env: Record<string, string | undefined>): void {
    for (const [name, value] of Object.entries(env)) vi.stubEnv(name, value)
}

beforeEach(() => {
    vi.resetModules()
    for (const name of Object.keys(loaded) as (keyof typeof loaded)[]) loaded[name] = 0
    // Registered per test, not hoisted: a hoisted factory is cached across resetModules, so it would
    // count only the FIRST load in this file and every later "never loads" would pass vacuously.
    vi.doMock('@aws-sdk/client-rds-data', async (importOriginal) => {
        loaded.rdsDataSdk += 1
        return importOriginal()
    })
    vi.doMock('./db-data-api', async (importOriginal) => {
        loaded.dataApiTransport += 1
        return importOriginal()
    })
    // The optional ports' adapters, stubbed (their SDKs are not what is tested here), each counting its own loads.
    vi.doMock('./llm', () => {
        loaded.llm += 1
        return { createRealLlm: () => ({ kind: 'anthropic' }) }
    })
    vi.doMock('./email', () => {
        loaded.email += 1
        return { createRealEmail: () => ({ kind: 'mailgun' }) }
    })
    vi.doMock('./jobs', () => {
        loaded.codebuild += 1
        return { createRealJobs: () => ({ kind: 'codebuild' }) }
    })
    vi.doMock('./storage', () => {
        loaded.storage += 1
        return { createRealStorage: () => ({ kind: 's3' }) }
    })
    // The registry builds the in-process runner; this module must never load it (a counter that stays 0).
    vi.doMock('./jobs-in-process', () => {
        loaded.inProcess += 1
        return { createInProcessJobs: () => ({}) }
    })
    stubEnv({ ...COMMON_ENV, DATABASE_TRANSPORT: undefined, DATABASE_URL: undefined })
    stubEnv(Object.fromEntries(Object.keys(DATA_API_ENV).map((name) => [name, undefined])))
    stubEnv(Object.fromEntries(Object.values(OPTIONAL_PORTS).map(({ variable }) => [variable, undefined])))
})

afterEach(() => {
    vi.unstubAllEnvs()
})

describe('the database transport is chosen by DATABASE_TRANSPORT, and the Data API is opt-in', () => {
    it.each([
        ['unset', undefined],
        ['pg', 'pg'],
    ])('a pg deployment (DATABASE_TRANSPORT %s) never loads the RDS Data SDK', async (_label, transport) => {
        stubEnv({ DATABASE_TRANSPORT: transport, DATABASE_URL: 'postgres://u:p@localhost:5432/app' })
        const { createRealPorts } = await import('./index')
        const ports = await createRealPorts(HOOKS)
        expect(loaded).toMatchObject({ rdsDataSdk: 0, dataApiTransport: 0 })
        await ports.db.getDb().destroy()
    })

    it('DATABASE_TRANSPORT=data-api loads it, and needs no DATABASE_URL', async () => {
        stubEnv({ DATABASE_TRANSPORT: 'data-api', ...DATA_API_ENV })
        const { createRealPorts } = await import('./index')
        const ports = await createRealPorts(HOOKS)
        expect(loaded.dataApiTransport).toBe(1)
        expect(loaded.rdsDataSdk).toBeGreaterThan(0)
        expect(typeof ports.db.withTenant).toBe('function')
    })

    it('an unknown transport fails instead of falling back to pg', async () => {
        stubEnv({ DATABASE_TRANSPORT: 'mysql', DATABASE_URL: 'postgres://u:p@localhost:5432/app' })
        const { createRealPorts } = await import('./index')
        await expect(createRealPorts(HOOKS)).rejects.toThrow(/DATABASE_TRANSPORT must be one of pg, data-api/)
    })

    it("each transport requires its own variables, and names its own cutover row when they're missing", async () => {
        const { assertRealEnv } = await import('./index')
        // From the same module registry as ./index (beforeEach resets it), or instanceof compares two classes.
        const { CutoverPendingError } = await import('../../ports/errors')
        stubEnv({ DATABASE_TRANSPORT: 'data-api', DATABASE_CLUSTER_ARN: DATA_API_ENV.DATABASE_CLUSTER_ARN })
        expect(() => assertRealEnv()).toThrow(CutoverPendingError)
        expect(() => assertRealEnv()).toThrow(/data-api.*DATABASE_SECRET_ARN, DATABASE_NAME/s)
        expect(() => assertRealEnv()).not.toThrow(/DATABASE_URL/)

        stubEnv({ DATABASE_TRANSPORT: 'pg' })
        expect(() => assertRealEnv()).toThrow(/cloud-accounts.*DATABASE_URL/s)
    })

    it('the Data API transport requires AWS_REGION even when no optional port calls AWS; pg does not', async () => {
        const { assertRealEnv } = await import('./index')
        const awsFree = { JOBS_RUNNER: 'in-process', STORAGE_PROVIDER: 'none', AWS_REGION: undefined }
        stubEnv({ DATABASE_TRANSPORT: 'data-api', ...DATA_API_ENV, ...awsFree })
        expect(() => assertRealEnv()).toThrow(/cloud-accounts.*Missing env: AWS_REGION\. /s)
        stubEnv({ DATABASE_TRANSPORT: 'pg', DATABASE_URL: 'postgres://u:p@localhost:5432/app' })
        expect(() => assertRealEnv()).not.toThrow()
    })
})

describe('the optional ports follow their switches, and a port switched off is absent', () => {
    const PG = { DATABASE_TRANSPORT: 'pg', DATABASE_URL: 'postgres://u:p@localhost:5432/app' }
    const ALL_OFF = Object.fromEntries(Object.values(OPTIONAL_PORTS).map(({ variable }) => [variable, 'none']))
    const OPTIONAL_SETTINGS = ['ANTHROPIC_API_KEY', 'MAILGUN_DOMAIN', 'MAILGUN_API_KEY', 'EMAIL_FROM']
    const OPTIONAL_SETTINGS_ALL = [
        ...OPTIONAL_SETTINGS,
        'MAILGUN_WEBHOOK_SIGNING_KEY',
        'JOBS_CODEBUILD_PROJECT',
        'STORAGE_BUCKET',
        'AWS_REGION',
    ]

    it('unset switches are the defaults: every optional port is on, as before the switches', async () => {
        stubEnv(PG)
        const { createRealPorts } = await import('./index')
        const ports = await createRealPorts(HOOKS)
        expect(loaded).toMatchObject({ llm: 1, email: 1, codebuild: 1, inProcess: 0, storage: 1 })
        expect([ports.llm, ports.email, ports.jobs, ports.storage]).toEqual([
            { kind: 'anthropic' },
            { kind: 'mailgun' },
            { kind: 'codebuild' },
            { kind: 's3' },
        ])
        await ports.db.getDb().destroy()
    })

    it('every port off: none of their settings is required, no adapter loads, and each call names its switch', async () => {
        stubEnv({ ...PG, ...ALL_OFF })
        stubEnv(Object.fromEntries(OPTIONAL_SETTINGS_ALL.map((name) => [name, undefined])))
        const { createRealPorts } = await import('./index')
        const { AbsentPortError } = await import('./absent')
        const ports = await createRealPorts(HOOKS)
        expect(loaded).toMatchObject({ llm: 0, email: 0, codebuild: 0, inProcess: 0, storage: 0 })
        const job = { id: 'j', kind: 'k', tenantId: 't', orgId: null, payload: {} }
        const message = { to: 'a@example.com', subject: 's', html: 'h', text: 't' }
        await expect(ports.llm.complete({ messages: [] } as never)).rejects.toThrow(AbsentPortError)
        await expect(ports.llm.complete({ messages: [] } as never)).rejects.toThrow(/LLM_PROVIDER=none/)
        expect(() => ports.llm.stream({ messages: [] } as never)).toThrow(/the llm port is absent.*LLM_PROVIDER/)
        await expect(ports.llm.runToolLoop({} as never)).rejects.toThrow(/LLM_PROVIDER=none/)
        await expect(ports.email.send(message)).rejects.toThrow(/the email port is absent.*EMAIL_PROVIDER=none/)
        await expect(ports.jobs.start(job)).rejects.toThrow(/the jobs port is absent.*JOBS_RUNNER=none.*job-runner/)
        // Every storage method, each named so a missing one is the failure's own line.
        const storageCalls: Record<keyof typeof ports.storage, () => Promise<unknown>> = {
            put: () => ports.storage.put('k', 'body', 'text/plain'),
            get: () => ports.storage.get('k'),
            getSignedDownloadUrl: () => ports.storage.getSignedDownloadUrl('k'),
            createUploadTarget: () => ports.storage.createUploadTarget('k', { contentType: 'text/plain', maxBytes: 1 }),
            list: () => ports.storage.list(''),
            delete: () => ports.storage.delete(['k']),
            copy: () => ports.storage.copy('a', 'b'),
            head: () => ports.storage.head('k'),
        }
        for (const [method, call] of Object.entries(storageCalls)) {
            await expect(call(), method).rejects.toThrow(AbsentPortError)
            await expect(call(), method).rejects.toThrow(/the storage port is absent.*STORAGE_PROVIDER=none/)
        }
        await ports.db.getDb().destroy()
    })

    it('JOBS_RUNNER=in-process needs no CodeBuild project and never loads the CodeBuild runner', async () => {
        stubEnv({ ...PG, JOBS_RUNNER: 'in-process', JOBS_CODEBUILD_PROJECT: undefined })
        const { createRealPorts } = await import('./index')
        const ports = await createRealPorts(HOOKS)
        // The registry's hook built it, with the deployment's own ports; this module loaded no runner of its own.
        expect(loaded).toMatchObject({ codebuild: 0, inProcess: 0 })
        expect(ports.jobs).toMatchObject({ kind: 'in-process' })
        const given = (ports.jobs as unknown as { ports: Record<string, unknown> }).ports
        expect(given['db']).toBe(ports.db)
        expect(given['storage']).toBe(ports.storage)
        expect(given['email']).toBe(ports.email)
        expect(given['llm']).toBe(ports.llm)
        expect(given['auth']).toBe(ports.auth)
        await ports.db.getDb().destroy()
    })

    it("JOBS_RUNNER=in-process without the registry's hook fails at boot, naming what is missing", async () => {
        stubEnv({ ...PG, JOBS_RUNNER: 'in-process' })
        const { createRealPorts } = await import('./index')
        await expect(createRealPorts()).rejects.toThrow(/JOBS_RUNNER=in-process needs the adapter registry/)
    })

    it('takes no hooks at all for the other runners, as it did before', async () => {
        stubEnv(PG)
        const { createRealPorts } = await import('./index')
        const ports = await createRealPorts()
        expect(ports.jobs).toEqual({ kind: 'codebuild' })
        await ports.db.getDb().destroy()
    })

    it('a switch with an unknown value fails at boot instead of falling back', async () => {
        const { assertRealEnv } = await import('./index')
        for (const [variable, value] of [
            ['LLM_PROVIDER', 'openai'],
            ['EMAIL_PROVIDER', 'off'],
            ['INBOUND_EMAIL_PROVIDER', 'ses'],
            ['JOBS_RUNNER', 'lambda'],
            ['STORAGE_PROVIDER', 'gcs'],
        ] as const) {
            stubEnv({ ...PG, [variable]: value })
            expect(() => assertRealEnv(), variable).toThrow(
                new RegExp(`${variable} must be one of .* \\(got "${value}"\\)`),
            )
            stubEnv({ [variable]: undefined })
        }
    })

    it('a port switched on still requires its settings, naming its cutover row', async () => {
        const { assertRealEnv } = await import('./index')
        stubEnv({ ...PG, ...ALL_OFF, EMAIL_PROVIDER: 'mailgun', MAILGUN_API_KEY: undefined })
        expect(() => assertRealEnv()).toThrow(/email-outbound.*Missing env: MAILGUN_API_KEY\. /s)
        stubEnv({ EMAIL_PROVIDER: 'none', STORAGE_PROVIDER: 's3', STORAGE_BUCKET: undefined, AWS_REGION: undefined })
        expect(() => assertRealEnv()).toThrow(/cloud-accounts.*Missing env: STORAGE_BUCKET, AWS_REGION\. /s)
    })
})

/**
 * The environment a real deployment must set, held to a committed snapshot (ADR-0014 part 10): a new required
 * variable is breaking, filed as a `minor` changeset, and `.github/scripts/require-changeset.sh` fails a PR that
 * changes the snapshot without one. Read from what `assertRealEnv` refuses on an empty environment, so the snapshot is
 * what a deployment meets at boot (`REQUIRED_ENV`, `DATABASE_ENV` and the optional ports' settings) and nothing is
 * exported to be tested: per transport with every optional port at its default, and, under `ports`, what each choice
 * of each optional port's switch adds to a deployment that switches every other one off. A plain JSON file compared
 * with `toEqual`, never a Vitest snapshot, which `vitest -u` would rewrite.
 */
describe('the required environment', () => {
    const SNAPSHOT = path.resolve(
        path.dirname(fileURLToPath(import.meta.url)),
        '../../../release-snapshots/required-env.json',
    )
    const COMMENT =
        'The environment variables a real deployment must set (assertRealEnv), per DATABASE_TRANSPORT with every ' +
        "optional port at its default, and under 'ports' what each choice of an optional port's switch requires, from " +
        "packages/kit/src/adapters/real/index.test.ts. A new one breaks every deployment that lacks it: change this file only with a 'minor' " +
        'changeset (ADR-0014 part 10; .github/scripts/require-changeset.sh).'

    /** The variables `assertRealEnv` names as missing when nothing at all is set but the transport and `switches`. */
    async function requiredOn(transport: string, switches: Record<string, string> = {}): Promise<string[]> {
        const { assertRealEnv } = await import('./index')
        for (const name of Object.keys(process.env)) vi.stubEnv(name, undefined)
        vi.stubEnv('DATABASE_TRANSPORT', transport)
        stubEnv(switches)
        let message = ''
        try {
            assertRealEnv()
        } catch (error) {
            message = (error as Error).message
        }
        vi.unstubAllEnvs()
        const missing = /Missing env: ([A-Z0-9_, ]+)\. /.exec(message)?.[1]
        if (missing === undefined) throw new Error(`assertRealEnv on an empty environment said: "${message}"`)
        return missing.split(', ').sort()
    }

    /** What each choice of each optional port's switch requires beyond a deployment with every such port off. */
    async function requiredByPorts(): Promise<Record<string, Record<string, string[]>>> {
        const allOff = Object.fromEntries(Object.values(OPTIONAL_PORTS).map(({ variable }) => [variable, 'none']))
        const baseline = new Set(await requiredOn('pg', allOff))
        const result: Record<string, Record<string, string[]>> = {}
        for (const { variable, env } of Object.values(OPTIONAL_PORTS)) {
            result[variable] = {}
            for (const choice of Object.keys(env)) {
                const required = await requiredOn('pg', { ...allOff, [variable]: choice })
                result[variable][choice] = required.filter((name) => !baseline.has(name))
            }
        }
        return result
    }

    it('is the committed snapshot: a change is a minor changeset', async () => {
        const actual: Record<string, unknown> = { $comment: COMMENT }
        for (const transport of DATABASE_TRANSPORTS) actual[transport] = await requiredOn(transport)
        actual['ports'] = await requiredByPorts()
        const committed: unknown = JSON.parse(readFileSync(SNAPSHOT, 'utf8'))
        expect(
            actual,
            `${path.basename(SNAPSHOT)} differs from what assertRealEnv requires. If the change is meant, every ` +
                "deployment without it stops booting: write this into the file and add a 'minor' changeset that says " +
                `so (Kind operator, Action required):\n${JSON.stringify(actual, null, 4)}\n`,
        ).toEqual(committed)
    })

    // `createRealPorts` reads its variables through `need(name)`, which throws when one is missing: a name read there
    // and not required by `assertRealEnv` would stop a deployment from booting while the snapshot above stayed green.
    it('covers every variable the real ports need', async () => {
        const source = readFileSync(path.join(import.meta.dirname, 'index.ts'), 'utf8')
        const needed = [...source.matchAll(/\bneed\(\s*'([A-Z0-9_]+)'\s*\)/g)].flatMap((m) => m[1] ?? [])
        expect(needed.length).toBeGreaterThan(0)
        expect(source).not.toMatch(/\bneed\(\s*[^'\s)]/) // a name not written as a literal could not be checked here
        const required = new Set<string>()
        for (const transport of DATABASE_TRANSPORTS) for (const name of await requiredOn(transport)) required.add(name)
        expect(needed.filter((name) => !required.has(name))).toEqual([])
    })
})

/**
 * `sssb check-real-env` (the `dev:real` preflight) bundles this module as CommonJS, every dynamic import's target
 * included, and CommonJS refuses the adapter registry's top-level await. So nothing this module can load may reach the
 * registry: not the notification modules, and not the app's job handlers (`@sssb/app-config/jobs`), which may import
 * anything an app module may. Read from esbuild's own account of what it bundled, with the fixture as the seam.
 */
describe('the real ports, as the dev:real preflight bundles them', () => {
    it("reach neither the adapter registry, the server's libraries, nor the app's job handlers", async () => {
        const { build } = await import('esbuild')
        const here = import.meta.dirname
        const result = await build({
            entryPoints: [path.join(here, 'index.ts')],
            bundle: true,
            write: false,
            platform: 'node',
            format: 'cjs',
            metafile: true,
            logLevel: 'silent',
            packages: 'external',
            alias: { '@sssb/app-config': path.resolve(here, '../../../test-fixture/app-config') },
        })
        const reached = [
            ...Object.keys(result.metafile.inputs),
            ...Object.values(result.metafile.outputs).flatMap((output) => output.imports.map((i) => i.path)),
        ]
        expect(reached.some((file) => file.endsWith(path.join('adapters', 'real', 'index.ts')))).toBe(true)
        expect(
            reached.filter((file) => /adapters[\\/]index\.ts$|server-lib[\\/]|app-config[\\/]jobs/.test(file)),
        ).toEqual([])
    })
})

/**
 * What a deployment loads as the real ports load, before it has chosen anything: the vendor SDKs `adapters/real/index`
 * reaches by static imports alone. None of the SDKs a choice brings (a database transport's, PostHog's, an optional
 * port's, named in `CHOSEN`) may be among them; Clerk's must be, which shows the walk saw the auth adapter. Those
 * load only when chosen (dynamic imports), storage's S3 SDK among them; auth (Clerk) serves every deployment.
 * And the Data API transport, once chosen, loads no `pg`. Read from esbuild's account of the bundle, following static
 * edges only.
 */
describe('the vendor SDKs the real ports load before anything is chosen', () => {
    /** The packages `entry` reaches by static imports alone (dynamic ones are not followed). */
    async function staticPackages(entry: string): Promise<string[]> {
        const { build } = await import('esbuild')
        const here = import.meta.dirname
        const result = await build({
            entryPoints: [path.join(here, entry)],
            bundle: true,
            write: false,
            platform: 'node',
            format: 'esm',
            metafile: true,
            logLevel: 'silent',
            packages: 'external',
            alias: { '@sssb/app-config': path.resolve(here, '../../../test-fixture/app-config') },
        })
        const inputs = result.metafile.inputs
        const start = Object.keys(inputs).find((file) => file.endsWith(path.join('adapters', 'real', entry)))
        if (start === undefined) throw new Error(`esbuild did not bundle ${entry}`)
        const seen = new Set([start])
        const packages = new Set<string>()
        const queue = [start]
        while (queue.length > 0) {
            for (const edge of inputs[queue.shift() as string]?.imports ?? []) {
                if (edge.kind === 'dynamic-import') continue
                if (edge.external) packages.add(edge.path)
                else if (!seen.has(edge.path)) {
                    seen.add(edge.path)
                    queue.push(edge.path)
                }
            }
        }
        return [...packages].sort()
    }

    // The SDK of each choice a deployment makes: never loaded until it makes it.
    const CHOSEN =
        /^(pg|posthog-node|@aws-sdk\/client-rds-data|@anthropic-ai\/sdk|mailgun\.js|@aws-sdk\/client-codebuild|@aws-sdk\/client-s3|@aws-sdk\/s3-request-presigner|@aws-sdk\/s3-presigned-post)(\/|$)/

    it('include none that a choice brings', async () => {
        const packages = await staticPackages('index.ts')
        expect(packages.some((name) => name.startsWith('@clerk/'))).toBe(true) // the walk saw the auth adapter
        expect(packages.filter((name) => CHOSEN.test(name))).toEqual([])
    })

    it('and the Data API transport, once chosen, loads no pg', async () => {
        const packages = await staticPackages('db-data-api.ts')
        expect(packages).toContain('@aws-sdk/client-rds-data')
        expect(packages.filter((name) => /^pg(\/|$)/.test(name))).toEqual([])
    })
})
