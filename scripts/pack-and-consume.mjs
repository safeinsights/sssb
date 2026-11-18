// PACK AND CONSUME (ADR-0014 part 7, rule 5, step P2): proves the framework the way an adopter gets
// it. Packs @sssb/kit and @sssb/tools, builds an adopter-shaped pnpm workspace OUTSIDE this repository from copies
// of apps/starter, installs the TARBALLS there (never `workspace:`), and runs that workspace's verify.
//
//   pnpm pack-and-consume [--dir <path>] [--skip-build-and-e2e]
//
// Inside this repo every tool reaches the framework through workspace links and per-app aliases, which
// hide exactly what an adopter hits: a file the package does not ship, an @types package only this
// repo's root declares, a seam that only an alias resolves. Here nothing resolves the seam but pnpm's
// link of the app's own `@sssb/app-config` into its own copy of the framework.
//
// The workspace, laid out like the first adopter's (safeinsights/pages):
//   apps/console   the full verify: typecheck at the ES2022 floor and with the strict-flag set on, unit
//                  tests with the framework's seam-conformance suites run from the tarball, the
//                  migrator bundle, `next build`, e2e, the static demo, its size and its e2e. It owns an
//                  adapter (src/adapters/real/), and a seam module that imports through its `@/` alias.
//   apps/ledger    a second app with a different seam (its own slug and an extra migration, imported
//                  through `@/`): typecheck, unit + conformance, and the migrator bundle, which must
//                  hold its own migrations and not the console's.
//   packages/gate  a sibling package that does not use the framework at all, only @sssb/tools' scratch-directory
//                  helper (ADR-0014 part 3: the helpers that touch no seam are any workspace package's).
//   packages/seamless  the NEGATIVE fixture: it takes @sssb/kit without linking a seam, and must fail
//                  loudly rather than run on another app's seam (ADR-0014 part 5).
//
// Today's gaps between that and what an adopter should need are named workarounds
// (scripts/pack-and-consume/workarounds.mjs), each tied to the step that removes it.
//
// The workspace is left in place after a run, so a failure can be inspected; the next run wipes it.

import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
    cpSync,
    existsSync,
    mkdirSync,
    readdirSync,
    readFileSync,
    realpathSync,
    rmSync,
    statSync,
    writeFileSync,
    appendFileSync,
} from 'node:fs'
import { builtinModules, createRequire } from 'node:module'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
    CONFORMANCE_SUITES,
    STRICT_FLAGS,
    conformanceProblems,
    tarballIntegrities,
    lockfileMoves,
    lockfileProblems,
    seamPeerProblems,
    shippedFileProblems,
    toolsManifestProblems,
    toolsShippedFileProblems,
    tscErrors,
    undeclaredImports,
} from './pack-and-consume/checks.mjs'
import { WORKAROUNDS, unusedWorkarounds, applyWorkaround } from './pack-and-consume/workarounds.mjs'

const REPO = path.resolve(import.meta.dirname, '..')

// ---- arguments ------------------------------------------------------------------------------------

const KNOWN_ARGS = new Set(['--dir', '--skip-build-and-e2e', '--update-lockfile'])
const args = process.argv.slice(2)
for (const [i, arg] of args.entries()) {
    if (args[i - 1] !== '--dir' && !KNOWN_ARGS.has(arg)) fail(`unknown argument ${arg}`)
}
const dirArg = args.indexOf('--dir')
if (dirArg >= 0 && (!args[dirArg + 1] || args[dirArg + 1].startsWith('--'))) fail('--dir needs a directory')
const SKIP_BUILD_AND_E2E = args.includes('--skip-build-and-e2e')
// Resolve afresh and write the result back as the committed seed (scripts/pack-and-consume/consumer-lock.yaml).
const UPDATE_LOCKFILE = args.includes('--update-lockfile')

/** Marks a directory as this script's, so a re-run wipes only what an earlier run made. */
const MARKER = '.sssb-pack-and-consume'
const BASE_ARG = path.resolve(dirArg >= 0 ? args[dirArg + 1] : path.join(tmpdir(), 'sssb-pack-and-consume'))
if (BASE_ARG === REPO || BASE_ARG.startsWith(REPO + path.sep) || REPO.startsWith(BASE_ARG + path.sep)) {
    fail(`--dir must be outside this repository (${REPO}): inside it, pnpm would find SSSB's workspace`)
}
if (existsSync(BASE_ARG) && readdirSync(BASE_ARG).length > 0 && !existsSync(path.join(BASE_ARG, MARKER))) {
    fail(`--dir ${BASE_ARG} is not empty and was not made by this script; it wipes its directory, so give it its own`)
}
mkdirSync(BASE_ARG, { recursive: true })
writeFileSync(path.join(BASE_ARG, MARKER), '')
// realpath: on macOS the temp directories sit under /var and /tmp, symlinks to /private/…, and a workspace
// whose module graph resolves under two spellings loads two copies of `next/headers` (the adoption
// probe's lesson).
const BASE = realpathSync(BASE_ARG)
const WS = path.join(BASE, 'workspace')
const TARBALLS = path.join(BASE, 'tarballs')
const REPORTS = path.join(BASE, 'reports')
const LOCK_SEED = path.join(REPO, 'scripts/pack-and-consume/consumer-lock.yaml')
// Node, TypeScript and pnpm all look UP the tree (node_modules, @types, a workspace root), so a parent
// directory holding any of these would lend the consumer what it did not install.
for (let dir = path.dirname(BASE); dir !== path.dirname(dir); dir = path.dirname(dir)) {
    for (const name of ['node_modules', 'package.json', 'pnpm-workspace.yaml']) {
        if (existsSync(path.join(dir, name)))
            fail(`--dir ${BASE} sits under ${path.join(dir, name)}, which the consumer would resolve through`)
    }
}

// ---- running things -------------------------------------------------------------------------------

/**
 * The environment every command in the consumer runs with. Run through `pnpm pack-and-consume`, PATH
 * starts with this repo's node_modules/.bin, so a binary the consumer forgot to install would silently
 * run from SSSB's workspace instead; and pnpm's npm_* variables carry this repo's config. Both are
 * stripped, so the consumer stands on what it installed.
 */
function consumerEnv(extra = {}) {
    /** @type {Record<string, string>} */
    const env = {}
    for (const [key, value] of Object.entries(process.env)) {
        if (value === undefined) continue
        if (/^npm_/i.test(key) || key === 'NODE_PATH' || key === 'INIT_CWD' || key === 'PNPM_SCRIPT_SRC_DIR') continue
        env[key] = value
    }
    env.PATH = (process.env.PATH ?? '')
        .split(path.delimiter)
        .filter((entry) => entry && !path.resolve(entry).startsWith(REPO))
        .join(path.delimiter)
    env.NEXT_TELEMETRY_DISABLED = '1'
    return { ...env, ...extra }
}

/**
 * @param {string} command
 * @param {string[]} commandArgs
 * @param {{ cwd: string, env?: Record<string, string | undefined>, capture?: boolean, allowFailure?: boolean, quiet?: boolean }} options
 */
function run(command, commandArgs, { cwd, env, capture = false, allowFailure = false, quiet = false }) {
    if (!quiet) console.log(`\n$ (${path.relative(BASE, cwd) || '.'}) ${command} ${commandArgs.join(' ')}`)
    const result = spawnSync(command, commandArgs, {
        cwd,
        env: env ?? consumerEnv(),
        stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
        encoding: 'utf8',
        maxBuffer: 256 * 1024 * 1024,
    })
    if (result.error) fail(`${command} could not start: ${result.error.message}`)
    if (result.status !== 0 && !allowFailure) {
        if (capture) console.error(`${result.stdout}\n${result.stderr}`)
        fail(`${command} ${commandArgs.join(' ')} exited ${result.status}`)
    }
    return { status: result.status ?? 1, stdout: result.stdout ?? '', stderr: result.stderr ?? '' }
}

/** @param {string} message */
function fail(message) {
    console.error(`\npack-and-consume: FAILED: ${message}`)
    process.exit(1)
}

/** @type {{ step: string, seconds: number }[]} */
const timings = []

/**
 * @param {string} name
 * @param {() => void} body
 */
function step(name, body) {
    console.log(`\n==== ${name}`)
    const started = Date.now()
    body()
    const seconds = Math.round((Date.now() - started) / 100) / 10
    timings.push({ step: name, seconds })
    console.log(`==== ${name}: ok (${seconds}s)`)
}

/** A port nobody is listening on, for the console's dev server: never the fixed :3100 another checkout may hold. */
async function freePort() {
    return new Promise((resolve, reject) => {
        const server = createServer()
        server.once('error', reject)
        server.listen(0, '127.0.0.1', () => {
            const address = server.address()
            server.close(() => resolve(typeof address === 'object' && address ? address.port : 0))
        })
    })
}

// ---- writing the workspace ------------------------------------------------------------------------

/**
 * @param {string} file
 * @param {string} content
 */
function write(file, content) {
    mkdirSync(path.dirname(file), { recursive: true })
    writeFileSync(file, content)
}

/** @param {string} file */
const readJson = (file) => JSON.parse(readFileSync(file, 'utf8'))

/**
 * @param {string} file
 * @param {unknown} value
 */
const writeJson = (file, value) => write(file, `${JSON.stringify(value, null, 4)}\n`)

/**
 * Replaces exactly one occurrence, and fails if the text is not there: a starter that drifted from what
 * this script expects must stop the run, not leave the copy unpatched.
 * @param {string} file
 * @param {string} from
 * @param {string} to
 */
function replaceOnce(file, from, to) {
    const text = readFileSync(file, 'utf8')
    const count = text.split(from).length - 1
    if (count !== 1)
        fail(`${path.relative(WS, file)}: expected one occurrence of ${JSON.stringify(from)}, found ${count}`)
    writeFileSync(file, text.replace(from, to))
}

const ROOT_MANIFEST = readJson(path.join(REPO, 'package.json'))

/** This repo's version range for a dependency, so the consumer installs what SSSB is tested with. */
function rangeOf(/** @type {string} */ name) {
    const range =
        ROOT_MANIFEST.devDependencies?.[name] ??
        ROOT_MANIFEST.dependencies?.[name] ??
        readJson(path.join(REPO, 'apps/starter/package.json')).devDependencies?.[name]
    if (!range) fail(`no version range for ${name} in this repo's manifests`)
    return range
}

/**
 * Copies the files git would see under a repo directory (tracked, plus untracked ones not ignored), and
 * nothing else: a developer's ignored `.env.local`, build output or local state must not reach the
 * consumer and make a local run differ from CI's clean checkout. A file deleted in the working tree is
 * skipped; an edited or new one is copied as it is on disk, so uncommitted work is what gets tested.
 * @param {string} from repo-relative directory
 * @param {string} to
 */
function copyTracked(from, to) {
    // Tracked files, plus new ones not yet added (a moved or added starter file), never the ignored.
    const listed = run('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard', '--', from], {
        cwd: REPO,
        env: process.env,
        capture: true,
        quiet: true,
    })
    const files = listed.stdout.split('\0').filter(Boolean)
    if (files.length === 0) fail(`git tracks no files under ${from}`)
    for (const file of files) {
        const source = path.join(REPO, file)
        if (!existsSync(source)) continue
        const target = path.join(to, path.relative(path.join(REPO, from), source))
        mkdirSync(path.dirname(target), { recursive: true })
        cpSync(source, target)
    }
}

/**
 * One app, copied from apps/starter and turned into what an adopter's app looks like: the framework and the tools
 * from their tarballs, the seam as a linked package, and no alias, path or include that reaches into this repo.
 * @param {{ app: string, slug: string, tarball: string, toolsTarball: string }} options
 */
function scaffoldApp({ app, slug, tarball, toolsTarball }) {
    const dir = path.join(WS, 'apps', app)
    copyTracked('apps/starter', dir)

    // The manifest: the framework and the tools from the tarballs, the seam as a link to the app's own src/app-config.
    const manifest = readJson(path.join(dir, 'package.json'))
    manifest.name = app
    manifest.dependencies['@sssb/kit'] = `file:${path.relative(dir, tarball)}`
    manifest.dependencies['@sssb/app-config'] = 'link:./src/app-config'
    if (!manifest.devDependencies?.['@sssb/tools']) fail('apps/starter does not take @sssb/tools as a devDependency')
    manifest.devDependencies['@sssb/tools'] = `file:${path.relative(dir, toolsTarball)}`
    writeJson(path.join(dir, 'package.json'), manifest)

    // The seam package (ADR-0014 part 1, option C). Its exports cover every seam module the framework
    // imports: the flat `.ts` modules by pattern, the one directory module by name. The app's own module
    // `type` is copied in, because a nested package.json resets it for everything below.
    applyWorkaround('seam-package-written')
    /** @type {Record<string, unknown>} */
    const seam = {
        name: '@sssb/app-config',
        private: true,
        exports: { './db/migrations': './db/migrations/index.ts', './*': './*.ts' },
    }
    if (manifest.type) seam.type = manifest.type
    writeJson(path.join(dir, 'src/app-config/package.json'), seam)

    // The starter's tsconfig as the template ships it: it extends @sssb/tools' base, which carries the compiler
    // contract and part 2's ES2022 floor. Only what reaches into THIS repo comes out: the `paths` that send the
    // framework and the seam to source (inside this repo resolution goes through aliases, ADR-0014 part 1) and the
    // include of packages/kit/src that makes the starter the framework's falsifier. The app's own `@/` stays.
    applyWorkaround('in-repo-tsconfig-stripped')
    const tsconfig = readJson(path.join(dir, 'tsconfig.json'))
    if (tsconfig.extends !== '@sssb/tools/tsconfig.base.json')
        fail(`apps/starter/tsconfig.json extends ${tsconfig.extends}, not @sssb/tools/tsconfig.base.json`)
    tsconfig.compilerOptions.paths = { '@/*': tsconfig.compilerOptions.paths['@/*'] }
    /** @param {string} entry */
    const ownEntry = (entry) => !entry.startsWith('../')
    tsconfig.include = tsconfig.include.filter(ownEntry)
    tsconfig.exclude = tsconfig.exclude.filter(ownEntry)
    writeJson(path.join(dir, 'tsconfig.json'), tsconfig)
    writeJson(path.join(dir, 'tsconfig.strict.json'), {
        extends: './tsconfig.json',
        compilerOptions: Object.fromEntries(STRICT_FLAGS.map((flag) => [flag, true])),
    })

    replaceOnce(
        path.join(dir, 'config/app.ts'),
        "export const APP_SLUG = 'starter'",
        `export const APP_SLUG = '${slug}'`,
    )

    // The real-Postgres contract test runs through this repo's tests/support harness, which no package
    // ships yet. It is not part of this job's verify (CI's contract job runs it for both apps in-repo).
    applyWorkaround('contract-test-dropped')
    rmSync(path.join(dir, 'tests/contract'), { recursive: true })

    // The WHOLE public surface, in the app's type program. A consumer typechecks only the framework
    // modules it reaches, and the starter reaches a fraction of them; an adopter may import any published
    // subpath, so every `exports` key (the JSON catalogs aside) is re-exported here, type-only, and both
    // typechecks cover each one against this app's seam. Nothing imports this file, so no bundle sees it.
    const surface = Object.keys(KIT_MANIFEST.exports)
        .filter((key) => key !== './package.json' && !key.endsWith('.json'))
        .map((key, i) => `export type * as m${i} from '@sssb/kit/${key.slice(2)}'`)
    if (surface.length < 100)
        fail(`the framework's exports map lists only ${surface.length} modules; expected its whole public surface`)
    write(
        path.join(dir, 'src/sssb-surface.ts'),
        `// Every published @sssb/kit module, so the typecheck covers the whole public surface (scripts/pack-and-consume.mjs).\n${surface.join('\n')}\n`,
    )

    // Each app proves, from its own code, that the framework it reaches reads ITS seam: the slug the
    // framework builds its webhook headers from when the module loads. (Which migrations it composes is
    // the migrator-bundle step's to prove; the registry is not a published subpath.)
    write(
        path.join(dir, 'src/seam-identity.test.ts'),
        `import { WEBHOOK_SIGNATURE_HEADER } from '@sssb/kit/core/webhook-signing'
import { expect, test } from 'vitest'

test("the framework this app installed reads this app's seam", () => {
    expect(WEBHOOK_SIGNATURE_HEADER).toBe('x-${slug}-signature')
})
`,
    )
    return dir
}

/** The app migrations each app's seam registers, and those it must never see. */
const OWN_MIGRATIONS = { console: ['1001_items'], ledger: ['1001_items', '1002_ledger_marker'] }
const FOREIGN_MIGRATIONS = {
    console: ['1002_ledger_marker', '1001_dockets'],
    ledger: ['1001_dockets'],
}

/** The console: an app-owned adapter, and a seam module that imports through the app's `@/` alias. */
function shapeConsole(/** @type {string} */ dir) {
    const manifest = readJson(path.join(dir, 'package.json'))
    manifest.dependencies['@aws-sdk/client-s3'] = readJson(path.join(REPO, 'packages/kit/package.json')).dependencies[
        '@aws-sdk/client-s3'
    ]
    writeJson(path.join(dir, 'package.json'), manifest)

    // docs/recipes/app-owned-adapter.md's layout, as safeinsights/pages' console has it for S3.
    write(
        path.join(dir, 'src/ports/object-store.ts'),
        `/** An app-owned port: SSSB has no port for this vendor (docs/recipes/app-owned-adapter.md). */
export interface ObjectStorePort {
    put(key: string, body: string): Promise<void>
    get(key: string): Promise<string | null>
}
`,
    )
    write(
        path.join(dir, 'src/adapters/fake/object-store.ts'),
        `import type { ObjectStorePort } from '@/ports/object-store'

/** In memory, pinned on globalThis so a dev-server reload keeps it. */
const store: Map<string, string> = ((globalThis as { __consoleObjects?: Map<string, string> }).__consoleObjects ??= new Map())

export const fakeObjectStore: ObjectStorePort = {
    async put(key, body) {
        store.set(key, body)
    },
    async get(key) {
        return store.get(key) ?? null
    },
}
`,
    )
    write(
        path.join(dir, 'src/adapters/real/object-store.ts'),
        `import { GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3'
import type { ObjectStorePort } from '@/ports/object-store'

/** AUTHORED, never run: the vendor SDK is imported here and nowhere else in the app. */
export function createRealObjectStore(bucket: string, region: string): ObjectStorePort {
    const client = new S3Client({ region })
    return {
        async put(key, body) {
            await client.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: body }))
        },
        async get(key) {
            const object = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }))
            return (await object.Body?.transformToString()) ?? null
        },
    }
}
`,
    )
    write(
        path.join(dir, 'src/adapters/real/index.ts'),
        `import { CutoverPendingError } from '@sssb/kit/ports/errors'
import type { ObjectStorePort } from '@/ports/object-store'
import { createRealObjectStore } from './object-store'

const REQUIRED_ENV: Record<string, string> = { CONSOLE_BUCKET: 'console-bucket', AWS_REGION: 'cloud-accounts' }

export function createRealAppPorts(): { objectStore: ObjectStorePort } {
    const missing = Object.keys(REQUIRED_ENV).filter((name) => !process.env[name])
    if (missing.length > 0) {
        const rows = [...new Set(missing.map((name) => REQUIRED_ENV[name] ?? name))]
        throw new CutoverPendingError(rows, \`Missing env: \${missing.join(', ')}\`)
    }
    return { objectStore: createRealObjectStore(process.env['CONSOLE_BUCKET'] as string, process.env['AWS_REGION'] as string) }
}
`,
    )
    write(
        path.join(dir, 'src/adapters/index.ts'),
        `import { isSimulated } from '@sssb/kit/adapters/index'
import type { ObjectStorePort } from '@/ports/object-store'
import { fakeObjectStore } from './fake/object-store'

const real = isSimulated ? null : (await import('./real/index')).createRealAppPorts()

export const objectStore: ObjectStorePort = real?.objectStore ?? fakeObjectStore
`,
    )
    write(
        path.join(dir, 'src/adapters/fake/object-store.test.ts'),
        `import { expect, test } from 'vitest'
import { fakeObjectStore } from './object-store'

test('the fake object store keeps what it is given', async () => {
    await fakeObjectStore.put('a', 'b')
    expect(await fakeObjectStore.get('a')).toBe('b')
    expect(await fakeObjectStore.get('missing')).toBeNull()
})
`,
    )
    // A route that serves through the registry, so `next build` compiles the app-owned adapter, its
    // dynamic import of real/ and the vendor SDK against the packed framework. (A unit test cannot load
    // the registry: SSSB's adapters import `server-only`, which throws outside a server component.)
    write(
        path.join(dir, 'src/app/api/objects/route.ts'),
        `import { auth } from '@sssb/kit/adapters/index'
import { objectStore } from '@/adapters'
import { withPortErrors } from '../respond'

export async function GET(): Promise<Response> {
    return withPortErrors(async () => {
        const user = await auth.requireUser()
        return Response.json({ value: await objectStore.get(user.tenantSlug) })
    })
}
`,
    )

    // A seam module that imports through the app's `@/` alias, as the showcase's jobs.ts does: the
    // framework reaches the seam through pnpm's link, and the seam reaches the app through its alias.
    write(
        path.join(dir, 'src/domain/service-orgs.ts'),
        `/** The orgs a dedicated service actor serves. None in this app. */
export const consoleServiceOrgs: readonly string[] = []
`,
    )
    const jobs = path.join(dir, 'src/app-config/jobs.ts')
    replaceOnce(
        jobs,
        "import { digestEmailHandler } from '@sssb/kit/jobs/digest-email'\n",
        "import { digestEmailHandler } from '@sssb/kit/jobs/digest-email'\nimport { consoleServiceOrgs } from '@/domain/service-orgs'\n",
    )
    replaceOnce(
        jobs,
        'export const serviceManagedOrgSlugs: readonly string[] = []',
        'export const serviceManagedOrgSlugs: readonly string[] = consoleServiceOrgs',
    )
}

/** The ledger: a different seam, whose extra migration comes in through the app's `@/` alias. */
function shapeLedger(/** @type {string} */ dir) {
    write(
        path.join(dir, 'src/db/1002_ledger_marker.ts'),
        `import { type Kysely, sql } from 'kysely'

/** The ledger's own migration: nothing but a marker the migrator bundle must carry and the console's must not. */
export async function up(db: Kysely<unknown>): Promise<void> {
    await sql\`COMMENT ON TABLE items IS 'ledger'\`.execute(db)
}
`,
    )
    const index = path.join(dir, 'src/app-config/db/migrations/index.ts')
    replaceOnce(
        index,
        "import * as m1001 from './1001_items'\n",
        "import * as m1002 from '@/db/1002_ledger_marker'\nimport * as m1001 from './1001_items'\n",
    )
    replaceOnce(index, "    '1001_items': m1001,\n", "    '1001_items': m1001,\n    '1002_ledger_marker': m1002,\n")
}

/** Builds the whole workspace under WS. */
function scaffold(/** @type {string} */ tarball, /** @type {string} */ toolsTarball) {
    rmSync(WS, { recursive: true, force: true })
    mkdirSync(WS, { recursive: true })

    // The workspace root's own tools, picked by hand from this repo's manifests (P12: @sssb/create writes them).
    applyWorkaround('root-devdeps-picked')
    writeJson(path.join(WS, 'package.json'), {
        name: 'consumer-workspace',
        private: true,
        type: 'module',
        packageManager: ROOT_MANIFEST.packageManager,
        engines: ROOT_MANIFEST.engines,
        devDependencies: Object.fromEntries(
            [
                '@testing-library/jest-dom',
                '@types/node',
                '@types/react',
                '@types/react-dom',
                '@vitejs/plugin-react',
                'esbuild',
                'happy-dom',
                'postcss',
                'tsx',
                'typescript',
                'vite',
                'vitest',
            ].map((name) => [name, rangeOf(name)]),
        ),
    })
    // The root's own @sssb/tools, from the tarball: its Vitest config uses the preset, as Pages' root config would.
    const rootManifest = readJson(path.join(WS, 'package.json'))
    rootManifest.devDependencies['@sssb/tools'] = `file:${path.relative(WS, toolsTarball)}`
    writeJson(path.join(WS, 'package.json'), rootManifest)

    // allowBuilds as this repo grants them; the rest is what an adopter's workspace sets (ADR-0014 part 5).
    applyWorkaround('allow-builds-copied')
    const repoWorkspace = readFileSync(path.join(REPO, 'pnpm-workspace.yaml'), 'utf8')
    const allowBuilds = /^allowBuilds:\n((?:[ #].*\n|\n)*?)(?=^\S)/m.exec(repoWorkspace)?.[0]
    if (!allowBuilds) fail("could not read allowBuilds from this repo's pnpm-workspace.yaml")
    applyWorkaround('dedupe-peer-dependents-written')
    write(
        path.join(WS, 'pnpm-workspace.yaml'),
        `packages:
    - apps/*
    - packages/*

${allowBuilds}
# Each importer of @sssb/kit gets an instance of its own, with its own seam, or none (ADR-0014 part 5).
dedupePeerDependents: false

# The house supply-chain guard Pages inherited: only versions published two days ago or more.
minimumReleaseAge: 2880
`,
    )
    // Every @sssb package is routed to an address nothing listens on, so an install that asked the
    // registry for one, the seam above all, fails instead of passing on whatever the registry answered.
    write(path.join(WS, '.npmrc'), '@sssb:registry=http://127.0.0.1:9/\n')

    // The committed lockfile seed, as an adopter commits theirs: pnpm keeps every resolution in it whose
    // specifier still matches and resolves only what changed (the tarball, whose file name changes with a
    // release's version, or a range this repo moved). So a third-party release cannot turn this check red
    // on a PR that did not cause it.
    if (!UPDATE_LOCKFILE) {
        if (!existsSync(LOCK_SEED)) fail(`no lockfile seed at ${LOCK_SEED}: run with --update-lockfile to make one`)
        cpSync(LOCK_SEED, path.join(WS, 'pnpm-lock.yaml'))
    }

    shapeConsole(scaffoldApp({ app: 'console', slug: 'console', tarball, toolsTarball }))
    shapeLedger(scaffoldApp({ app: 'ledger', slug: 'ledger', tarball, toolsTarball }))

    // A sibling package that does not use the framework (Pages' packages/gate), only @sssb/tools' helper.
    writeJson(path.join(WS, 'packages/gate/package.json'), {
        name: 'gate',
        private: true,
        type: 'module',
        scripts: { typecheck: 'tsc --noEmit' },
        devDependencies: { '@sssb/tools': `file:${path.relative(path.join(WS, 'packages/gate'), toolsTarball)}` },
    })
    writeJson(path.join(WS, 'packages/gate/tsconfig.json'), {
        compilerOptions: {
            target: 'ES2022',
            lib: ['es2022'],
            module: 'esnext',
            moduleResolution: 'bundler',
            strict: true,
            noEmit: true,
            skipLibCheck: true,
            types: [],
        },
        include: ['src/**/*.ts'],
        exclude: ['src/**/*.test.ts'],
    })
    write(
        path.join(WS, 'packages/gate/src/index.ts'),
        `/** A package beside the apps that has nothing to do with SSSB. */
export const allow = (path: string): boolean => !path.startsWith('/private/')
`,
    )
    write(
        path.join(WS, 'packages/gate/src/index.test.ts'),
        `import { makeTestTmpDir } from '@sssb/tools/testing/tmp-dir'
import { existsSync } from 'node:fs'
import { expect, test } from 'vitest'
import { allow } from './index'

test('the gate keeps private paths out', () => {
    expect(allow('/public/a')).toBe(true)
    expect(allow('/private/a')).toBe(false)
})

test("@sssb/tools' scratch-directory helper works in a package that has no @sssb/kit", () => {
    expect(existsSync(makeTestTmpDir('gate-'))).toBe(true)
})
`,
    )

    // THE NEGATIVE FIXTURE: an importer of @sssb/kit that links no seam.
    writeJson(path.join(WS, 'packages/seamless/package.json'), {
        name: 'seamless',
        private: true,
        type: 'module',
        dependencies: { '@sssb/kit': `file:${path.relative(path.join(WS, 'packages/seamless'), tarball)}` },
    })
    write(
        path.join(WS, 'packages/seamless/src/main.ts'),
        `import { WEBHOOK_SIGNATURE_HEADER } from '@sssb/kit/core/webhook-signing'

// With no seam of its own this must not load. If it prints, it ran on another app's seam.
console.log(WEBHOOK_SIGNATURE_HEADER)
`,
    )

    // Vitest from the workspace root, as Pages runs it: a project per app from @sssb/tools' preset, which passes
    // each app's own seam explicitly, as every SSSB builder does (the migrator bundle below, tsc and next build
    // resolve it through the link alone).
    applyWorkaround('conformance-by-include')
    write(
        path.join(WS, 'vitest.config.ts'),
        `import { fileURLToPath } from 'node:url'
import { appTestProject } from '@sssb/tools/vitest'
import { defineConfig, type ViteUserConfig } from 'vitest/config'

const at = (relative: string) => fileURLToPath(new URL(relative, import.meta.url))

// The framework's seam-conformance suites, run from each app's own copy of the package. Vitest's default
// exclude drops node_modules, so each app project sets its own (ADR-0014 part 3; P5 replaces this).
const CONFORMANCE = ${JSON.stringify(CONFORMANCE_SUITES.map((suite) => `node_modules/@sssb/kit/${suite}`))}

const app = async (name: string) => {
    const project = await appTestProject({ appDir: at(\`./apps/\${name}\`), include: CONFORMANCE })
    return {
        ...project,
        test: {
            ...project.test,
            exclude: ['**/.next/**', '**/dist-demo/**', 'node_modules/@sssb/kit/node_modules/**'],
        },
    }
}

export default defineConfig(
    async (): Promise<ViteUserConfig> => ({
        test: {
            projects: [
                await app('console'),
                await app('ledger'),
                { test: { name: 'gate', root: at('./packages/gate'), environment: 'node' } },
            ],
        },
    }),
)
`,
    )

    // The migrator, bundled the way CDK's NodejsFunction bundles it: esbuild, with NO seam alias and NO
    // tsconfig. The entry is the framework's published subpath, resolved from the app's own directory.
    write(
        path.join(WS, 'bundle-migrator.mjs'),
        `import { createRequire } from 'node:module'
import path from 'node:path'
import { build } from 'esbuild'

const appDir = path.resolve(process.argv[2])
const outfile = path.resolve(process.argv[3])
const entry = createRequire(path.join(appDir, 'package.json')).resolve('@sssb/kit/adapters/real/migrate-handler')
await build({
    entryPoints: [entry],
    bundle: true,
    platform: 'node',
    target: 'node22',
    format: 'esm',
    outfile,
    external: ['@aws-sdk/*', 'pg-native', 'cloudflare:sockets'],
    logLevel: 'warning',
})
console.log(\`bundled \${entry} -> \${outfile}\`)
`,
    )
}

// ---- the checks -----------------------------------------------------------------------------------

/** @param {string} app */
const appDir = (app) => path.join(WS, 'apps', app)

/** The real directory of the @sssb/kit an app resolves, and the real directory its seam link points at. */
function kitOf(/** @type {string} */ dir) {
    const kit = realpathSync(path.join(dir, 'node_modules/@sssb/kit'))
    const seamLink = path.join(path.dirname(kit), 'app-config')
    return { kit, seam: existsSync(seamLink) ? realpathSync(seamLink) : null }
}

function checkLayout() {
    const lock = readFileSync(path.join(WS, 'pnpm-lock.yaml'), 'utf8')
    const { problems, seen } = lockfileProblems(lock)
    console.log(`lockfile @sssb entries:\n  ${[...new Set(seen)].join('\n  ')}`)
    if (!seen.some((entry) => entry.startsWith('packages: @sssb/kit@file:')))
        problems.push('the lockfile has no @sssb/kit from the tarball')
    for (const app of ['console', 'ledger']) {
        if (!seen.includes(`snapshots: @sssb/app-config -> link:apps/${app}/src/app-config`)) {
            problems.push(`no @sssb/kit snapshot in the lockfile links ${app}'s seam`)
        }
    }
    if (problems.length > 0)
        fail(`the lockfile resolves SSSB from somewhere other than the tarball:\n  ${problems.join('\n  ')}`)

    // Each app's copy of the framework has its OWN seam linked into it (the peerDependenciesMeta pin),
    // and the two apps hold two instances.
    const kits = new Map()
    for (const app of ['console', 'ledger']) {
        const { kit, seam } = kitOf(appDir(app))
        const own = realpathSync(path.join(appDir(app), 'src/app-config'))
        console.log(
            `${app}: @sssb/kit at ${path.relative(WS, kit)}; its seam -> ${seam ? path.relative(WS, seam) : 'NOT LINKED'}`,
        )
        if (seam !== own)
            fail(`${app}'s @sssb/kit has ${seam ? `the seam ${seam}` : 'no seam'} linked, not the app's own ${own}`)
        // An installed copy in this workspace's virtual store, never a link back to the repo's source.
        if (!kit.startsWith(path.join(WS, 'node_modules', '.pnpm') + path.sep)) {
            fail(`${app}'s @sssb/kit is not a copy installed in this workspace's virtual store: ${kit}`)
        }
        kits.set(app, kit)
    }
    if (kits.get('console') === kits.get('ledger'))
        fail("both apps resolve ONE @sssb/kit instance, so one of them runs on the other's seam")

    // @sssb/tools is the tarball's copy, installed here, in every package that takes it.
    for (const dir of [appDir('console'), appDir('ledger'), path.join(WS, 'packages/gate'), WS]) {
        const tools = realpathSync(path.join(dir, 'node_modules/@sssb/tools'))
        if (!tools.startsWith(path.join(WS, 'node_modules', '.pnpm') + path.sep))
            fail(
                `${path.relative(WS, dir) || 'the root'}'s @sssb/tools is not a copy installed in this workspace: ${tools}`,
            )
    }
}

/**
 * The `dev:real` preflight from the tarball, in each app: `sssb check-real-env` bundles the framework's real
 * adapters with esbuild (Node refuses its TypeScript under node_modules, ADR-0014 part 2), reached from the app's own
 * directory (rule 4), and runs the bundle. With no cutover variables set it must name the missing ones and exit 1.
 */
function realEnvPreflight() {
    for (const app of ['console', 'ledger']) {
        const result = run('pnpm', ['exec', 'sssb', 'check-real-env'], {
            cwd: appDir(app),
            env: consumerEnv({ APP_MODE: 'real' }),
            capture: true,
            allowFailure: true,
        })
        const output = `${result.stdout}\n${result.stderr}`
        if (
            result.status !== 1 ||
            !output.includes('dev:real is not available yet') ||
            !output.includes('Missing env')
        ) {
            console.error(output)
            fail(`${app}: the dev:real preflight did not name the missing cutover items (exit ${result.status})`)
        }
        console.log(`${app}: the dev:real preflight bundled the framework from the app and named the missing items`)
    }
}

/**
 * The packed package ships only what an adopter needs (`shippedFileProblems`), and every package its shipped
 * source imports is declared in the packed manifest: an undeclared one resolves here only through pnpm's
 * hoist, so it fails.
 */
function checkDeclaredImports() {
    const kit = kitOf(appDir('console')).kit
    // pnpm links the package's dependencies' bins into its own node_modules/.bin on install; that is not shipped.
    const shipped = filesUnder(kit)
        .map((file) => path.relative(kit, file).split(path.sep).join('/'))
        .filter((file) => !file.startsWith('node_modules/'))
    const shippedProblems = shippedFileProblems(shipped)
    if (shippedProblems.length > 0)
        fail(`the packed @sssb/kit ships what its files allowlist should keep out:\n  ${shippedProblems.join('\n  ')}`)
    console.log(
        `the packed @sssb/kit ships ${shipped.length} files, of which the tests are the ${CONFORMANCE_SUITES.length} conformance suites`,
    )
    const sources = filesUnder(path.join(kit, 'src'))
        .filter((file) => /\.[cm]?[jt]sx?$/.test(file))
        .map((file) => ({ file: path.relative(kit, file), text: readFileSync(file, 'utf8') }))
    // The consumer's own TypeScript parses each file, as the compiler would read its imports.
    const ts = createRequire(path.join(WS, 'package.json'))('typescript')
    /** @param {string} text */
    const specifiersOf = (text) =>
        ts.preProcessFile(text, true, true).importedFiles.map((/** @type {{ fileName: string }} */ f) => f.fileName)
    const found = undeclaredImports(sources, KIT_MANIFEST, builtinModules, specifiersOf)
    const unexpected = [...found].map(([name, files]) => `${name} (${[...new Set(files)].join(', ')})`)
    if (unexpected.length > 0) {
        fail(
            `@sssb/kit's source imports packages its manifest does not declare; they resolve here only through pnpm's hoist:\n  ${unexpected.join('\n  ')}`,
        )
    }
    console.log('the shipped source under src/ imports only what @sssb/kit declares')
}

function typecheck() {
    for (const app of ['console', 'ledger']) {
        run('pnpm', ['exec', 'next', 'typegen'], { cwd: appDir(app) })
        const floor = run(
            'pnpm',
            ['exec', 'tsc', '--noEmit', '--incremental', 'false', '--pretty', 'false', '-p', 'tsconfig.json'],
            { cwd: appDir(app), capture: true, allowFailure: true },
        )
        const errors = tscErrors(floor.stdout + floor.stderr)
        if (floor.status !== 0 || errors.length > 0) {
            console.error(errors.map((e) => e.text).join('\n') || floor.stdout + floor.stderr)
            fail(`${app}: typecheck at the ES2022 floor failed with ${errors.length} error(s)`)
        }
        console.log(`${app}: typecheck at the ES2022 floor: clean`)
    }
    run('pnpm', ['--dir', 'packages/gate', 'run', 'typecheck'], { cwd: WS })
}

/**
 * ADR-0014 part 2's promise, from the tarball: the app compiles with every strict flag on, and so does
 * every file of @sssb/kit it reaches, so an adopter who turns one on cannot break SSSB. In-repo, the same
 * set is packages/kit/tsconfig.strict.json, which `pnpm typecheck` runs.
 */
function typecheckStrict() {
    for (const app of ['console', 'ledger']) {
        const result = run(
            'pnpm',
            ['exec', 'tsc', '--noEmit', '--incremental', 'false', '--pretty', 'false', '-p', 'tsconfig.strict.json'],
            { cwd: appDir(app), capture: true, allowFailure: true },
        )
        const errors = tscErrors(result.stdout + result.stderr)
        const appErrors = errors.filter((e) => e.owner === 'app')
        const kitErrors = errors.filter((e) => e.owner === 'kit')
        console.log(
            `${app}: strict flags (${STRICT_FLAGS.join(', ')}): ${appErrors.length} error(s) in the app, ${kitErrors.length} in @sssb/kit`,
        )
        if (result.status !== 0 && errors.length === 0) {
            console.error(result.stdout + result.stderr)
            fail(`${app}: the strict typecheck failed without reporting an error this script can read`)
        }
        if (appErrors.length > 0) {
            console.error(appErrors.map((e) => e.text).join('\n'))
            fail(`${app}: the app's own code fails the strict-flag set`)
        }
        if (kitErrors.length > 0) {
            console.error(kitErrors.map((e) => e.text).join('\n'))
            fail(`${app}: @sssb/kit's own source fails the strict-flag set`)
        }
    }
}

function unitTests() {
    mkdirSync(REPORTS, { recursive: true })
    const report = path.join(REPORTS, 'vitest.json')
    rmSync(report, { force: true })
    run('pnpm', ['exec', 'vitest', 'run', '--reporter=default', '--reporter=json', `--outputFile.json=${report}`], {
        cwd: WS,
    })
    /** @type {Record<string, string[]>} */
    const kitDirs = {}
    for (const app of ['console', 'ledger'])
        kitDirs[app] = [path.join(appDir(app), 'node_modules/@sssb/kit'), kitOf(appDir(app)).kit]
    // The app tests this job's claims rest on must have run too, not merely the suite as a whole.
    const required = {
        console: ['src/seam-identity.test.ts', 'src/adapters/fake/object-store.test.ts'].map((f) =>
            path.join(appDir('console'), f),
        ),
        ledger: ['src/seam-identity.test.ts'].map((f) => path.join(appDir('ledger'), f)),
    }
    const problems = conformanceProblems(readJson(report), kitDirs, required)
    if (problems.length > 0)
        fail(`the seam-conformance suites did not all run from the tarball:\n  ${problems.join('\n  ')}`)
    console.log(`seam-conformance: ${CONFORMANCE_SUITES.length} suites ran and passed from each app's own @sssb/kit`)
}

function migratorBundles() {
    for (const [app, own] of Object.entries(OWN_MIGRATIONS)) {
        const out = path.join(REPORTS, `migrator-${app}.mjs`)
        run('node', ['bundle-migrator.mjs', appDir(app), out], { cwd: WS })
        const code = readFileSync(out, 'utf8')
        for (const name of own)
            if (!code.includes(`"${name}"`)) fail(`${app}'s migrator bundle does not carry its migration ${name}`)
        for (const name of FOREIGN_MIGRATIONS[/** @type {keyof typeof FOREIGN_MIGRATIONS} */ (app)]) {
            if (code.includes(name)) fail(`${app}'s migrator bundle carries ${name}, which is not its migration`)
        }
        if (code.includes('test-fixture')) fail(`${app}'s migrator bundle holds code from the framework's test fixture`)
        console.log(`${app}: the migrator bundle holds ${own.join(', ')} and no other app's`)
    }
}

/** @param {string} dir */
function filesUnder(dir) {
    /** @type {string[]} */
    const out = []
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name)
        if (entry.isDirectory()) out.push(...filesUnder(full))
        else out.push(full)
    }
    return out
}

function nextBuild() {
    // E2E_BUILD: the framework's adapters fail closed in a production build unless told this one is for e2e.
    run('pnpm', ['run', 'build'], { cwd: appDir('console'), env: consumerEnv({ E2E_BUILD: '1' }) })
    const standalone = path.join(appDir('console'), '.next/standalone')
    if (!existsSync(standalone)) fail('next build produced no .next/standalone')
    const source = filesUnder(standalone).filter((file) => /\.tsx?$/.test(file) && !file.endsWith('.d.ts'))
    if (source.length > 0) fail(`the standalone server ships TypeScript source:\n  ${source.slice(0, 10).join('\n  ')}`)
}

/** @param {number} port */
function e2e(port) {
    // The consumer's own Playwright, as its lockfile seed pins it, which need not be this repo's version.
    // On CI the browser's OS libraries come with it; locally they are the developer's.
    const withDeps = process.env.CI ? ['--with-deps'] : []
    run('pnpm', ['exec', 'playwright', 'install', ...withDeps, 'chromium'], { cwd: appDir('console') })
    // CI=1 locally too: Playwright then never reuses a server some other checkout left on the port.
    run('pnpm', ['run', 'test:e2e'], {
        cwd: appDir('console'),
        env: consumerEnv({ STARTER_PORT: String(port), CI: process.env.CI ?? '1' }),
    })
}

function staticDemo() {
    run('pnpm', ['run', 'build:demo-static'], { cwd: appDir('console') })
    run('pnpm', ['run', 'check:demo-size'], { cwd: appDir('console') })
    run('pnpm', ['run', 'e2e:demo-static'], { cwd: appDir('console') })
}

function negativeFixture() {
    const result = run('pnpm', ['exec', 'tsx', 'src/main.ts'], {
        cwd: path.join(WS, 'packages/seamless'),
        capture: true,
        allowFailure: true,
    })
    const output = `${result.stdout}\n${result.stderr}`
    if (result.status === 0) {
        fail(
            `the seamless package RAN, printing ${JSON.stringify(result.stdout.trim())}: it took another app's seam instead of failing (ADR-0014 part 5)`,
        )
    }
    if (!/Cannot find (package|module) '@sssb\/app-config/.test(output)) {
        console.error(output)
        fail(
            'the seamless package failed, but not because it has no seam: the failure this fixture exists to show is missing',
        )
    }
    console.log(
        `the seamless package failed loudly, as it must:\n  ${output
            .split('\n')
            .find((line) => line.includes('@sssb/app-config'))
            ?.trim()}`,
    )
}

// ---- the run --------------------------------------------------------------------------------------

const started = Date.now()
const port = await freePort()
console.log(`pack and consume: ${BASE}`)

/** @type {string} */
let tarball = ''
/** The PACKED manifest, as the consumer installs it. @type {{ name?: string, exports: Record<string, string>, dependencies?: Record<string, string>, peerDependencies?: Record<string, string>, peerDependenciesMeta?: Record<string, unknown> }} */
let KIT_MANIFEST = { exports: {} }
/**
 * Packs one workspace package into its own directory under TARBALLS and returns the tarball's path.
 * @param {string} dir repo-relative package directory
 */
function pack(dir) {
    const out = path.join(TARBALLS, path.basename(dir))
    mkdirSync(out, { recursive: true })
    run('pnpm', ['pack', '--pack-destination', out], { cwd: path.join(REPO, dir), env: process.env })
    const packed = readdirSync(out).filter((name) => name.endsWith('.tgz'))
    if (packed.length !== 1) fail(`${dir}: expected one tarball, found ${packed.join(', ') || 'none'}`)
    return path.join(out, /** @type {string} */ (packed[0]))
}
/** @param {string} file */
const packedManifest = (file) =>
    JSON.parse(run('tar', ['-xzOf', file, 'package/package.json'], { cwd: BASE, capture: true }).stdout)

/** @type {string} */
let toolsTarball = ''
step('pack @sssb/kit and @sssb/tools', () => {
    rmSync(TARBALLS, { recursive: true, force: true })
    tarball = pack('packages/kit')
    const manifest = packedManifest(tarball)
    KIT_MANIFEST = manifest
    const problems = seamPeerProblems(manifest)
    if (problems.length > 0) fail(`the packed manifest breaks the seam pin:\n  ${problems.join('\n  ')}`)
    console.log(
        `${path.basename(tarball)}: ${Math.round(statSync(tarball).size / 1024)} KB; the seam is an optional peer in peerDependenciesMeta only`,
    )

    // @sssb/tools: JavaScript Node loads directly, with no dependency on any SSSB package (ADR-0014 rule 4, part 2).
    toolsTarball = pack('packages/tools')
    const files = run('tar', ['-tzf', toolsTarball], { cwd: BASE, capture: true })
        .stdout.split('\n')
        .filter(Boolean)
        .map((file) => file.replace(/^package\//, ''))
    const toolsProblems = [...toolsManifestProblems(packedManifest(toolsTarball)), ...toolsShippedFileProblems(files)]
    if (toolsProblems.length > 0)
        fail(`the packed @sssb/tools is not what it must be:\n  ${toolsProblems.join('\n  ')}`)
    console.log(
        `${path.basename(toolsTarball)}: ${files.length} files, ${Math.round(statSync(toolsTarball).size / 1024)} KB; JavaScript and declarations only, no SSSB dependency`,
    )
})
step('scaffold the consumer workspace', () => scaffold(tarball, toolsTarball))
step('install the tarball', () => {
    run('pnpm', ['install', '--no-frozen-lockfile'], { cwd: WS })
    const lock = path.join(WS, 'pnpm-lock.yaml')
    if (UPDATE_LOCKFILE) {
        cpSync(lock, LOCK_SEED)
        console.log(`wrote the resolution back to ${path.relative(REPO, LOCK_SEED)}: commit it`)
        return
    }
    // The installed framework is the tarball this run packed, not one an earlier lockfile or the store
    // cache remembered: pnpm records the tarball's sha512, and it must be this file's.
    const lockText = readFileSync(lock, 'utf8')
    for (const [name, file] of [
        ['@sssb/kit', tarball],
        ['@sssb/tools', toolsTarball],
    ]) {
        const packed = `sha512-${createHash('sha512').update(readFileSync(file)).digest('base64')}`
        const locked = tarballIntegrities(lockText, name)
        if (locked.length !== 1 || locked[0] !== packed) {
            fail(
                `the lockfile's ${name} integrity (${locked.join(', ') || 'none'}) is not the tarball just packed (${packed})`,
            )
        }
    }
    // Anything else that moved means the seed is behind this repo's ranges or the framework's
    // dependencies. Not a failure (a Dependabot PR cannot refresh the seed), a prompt.
    const { added, removed } = lockfileMoves(readFileSync(LOCK_SEED, 'utf8'), lockText)
    if (added + removed > 0) {
        const note = `the consumer's resolution moved from its seed (${added} lines added, ${removed} removed): refresh it with \`pnpm pack-and-consume --update-lockfile\` and commit scripts/pack-and-consume/consumer-lock.yaml`
        console.log(process.env.GITHUB_ACTIONS ? `::notice title=pack and consume::${note}` : `NOTE: ${note}`)
    }
})
step('layout: lockfile, seam links, one instance per app', checkLayout)
step('the packed package ships and imports only what it declares', checkDeclaredImports)
step('typecheck at the ES2022 floor', typecheck)
step('typecheck with the strict-flag set', typecheckStrict)
step('unit tests and seam conformance, from the workspace root', unitTests)
step('migrator bundles, with no alias and no tsconfig', migratorBundles)
step('negative fixture: an importer with no seam', negativeFixture)
step('the dev:real preflight, through esbuild from each app', realEnvPreflight)
if (SKIP_BUILD_AND_E2E) {
    console.log('\n--skip-build-and-e2e: next build, e2e and the static demo were NOT run')
} else {
    step('next build (console)', nextBuild)
    step('e2e (console)', () => e2e(port))
    step('static demo: build, size, e2e (console)', staticDemo)
}

const stale = unusedWorkarounds()
if (stale.length > 0) fail(`registered workarounds no site applies (remove them): ${stale.join(', ')}`)

const total = Math.round((Date.now() - started) / 1000)
const summary = [
    '## pack and consume',
    '',
    `Green in ${total}s${SKIP_BUILD_AND_E2E ? ' (build and e2e SKIPPED)' : ''}.`,
    '',
    '| step | seconds |',
    '| --- | --- |',
    ...timings.map((t) => `| ${t.step} | ${t.seconds} |`),
    '',
    "### Workarounds (today's gaps, each removed by a later step of ADR-0014)",
    '',
    '| id | removed by | what |',
    '| --- | --- | --- |',
    ...Object.entries(WORKAROUNDS).map(([id, w]) => `| \`${id}\` | ${w.removedBy} | ${w.what} |`),
    '',
].join('\n')
console.log(`\n${summary}`)
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary)
