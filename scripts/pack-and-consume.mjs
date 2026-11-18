// PACK AND CONSUME (ADR-0014 part 7, rule 5, step P2): proves the framework the way an adopter gets
// it. Packs @sssb/kit, @sssb/tools and @sssb/eslint-plugin, builds an adopter-shaped pnpm workspace OUTSIDE this repository from copies
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
//                  tests with the conformance suite (@sssb/kit/testing) run from the tarball, its contract
//                  suite (@sssb/kit/testing/contract) on embedded Postgres, the migrator bundle, `next build`,
//                  e2e, the static demo, its size and its e2e. It owns an
//                  adapter (src/adapters/real/), a seam module that imports through its `@/` alias, and an e2e spec
//                  that imports `@sssb/kit/testing/e2e` and an app domain module, which `sssb check-e2e` must pass,
//                  Playwright must load (`--list`, even with `--skip-build-and-e2e`), and whose negatives (specs
//                  reaching the framework's source, dropped in for one run, which Playwright cannot list) check-e2e
//                  must fail, naming the kit file.
//                  Each app lints with its own eslint.config.mjs (the plugin's preset), from the workspace root
//                  and from the app, and passes `sssb check-fences`; the console has a lint-exceptions.mjs entry.
//   apps/ledger    a second app with a different seam (its own slug and an extra migration, imported
//                  through `@/`): typecheck, unit + conformance, contract, and the migrator bundle, which must
//                  hold its own migrations and not the console's.
//   packages/gate  a sibling package that does not use the framework at all, only @sssb/tools' scratch-directory
//                  helper (ADR-0014 part 3: the helpers that touch no seam are any workspace package's).
//   packages/seamless  the NEGATIVE fixture: it takes @sssb/kit without linking a seam, and must fail
//                  loudly rather than run on another app's seam (ADR-0014 part 5). It joins the workspace only
//                  after the verify (a second install), because `sssb doctor` walks every package: the verify's
//                  doctor runs green without it, and with it doctor must NAME it.
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
    checkE2eFailProblems,
    checkE2eOkProblems,
    expectedConformanceTests,
    STRICT_FLAGS,
    conformanceProblems,
    tarballIntegrities,
    lockfileMoves,
    lockfileProblems,
    seamPeerProblems,
    shippedFileProblems,
    pluginManifestProblems,
    pluginShippedFileProblems,
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
 * @param {{ app: string, slug: string, tarball: string, toolsTarball: string, pluginTarball: string }} options
 */
function scaffoldApp({ app, slug, tarball, toolsTarball, pluginTarball }) {
    const dir = path.join(WS, 'apps', app)
    copyTracked('apps/starter', dir)

    // The manifest: the framework and the tools from the tarballs, the seam as a link to the app's own src/app-config.
    const manifest = readJson(path.join(dir, 'package.json'))
    manifest.name = app
    manifest.dependencies['@sssb/kit'] = `file:${path.relative(dir, tarball)}`
    manifest.dependencies['@sssb/app-config'] = 'link:./src/app-config'
    if (!manifest.devDependencies?.['@sssb/tools']) fail('apps/starter does not take @sssb/tools as a devDependency')
    manifest.devDependencies['@sssb/tools'] = `file:${path.relative(dir, toolsTarball)}`
    // The lint fences, as an adopter's app takes them: the plugin from its tarball, ESLint beside it, and the app's own
    // eslint.config.mjs composing the preset (ADR-0014 part 4). ESLint 10 uses each file's nearest config, so the app's
    // files get it whether ESLint runs here or from the workspace root.
    applyWorkaround('eslint-configs-written')
    manifest.devDependencies['@sssb/eslint-plugin'] = `file:${path.relative(dir, pluginTarball)}`
    manifest.devDependencies.eslint = rangeOf('eslint')
    writeJson(path.join(dir, 'package.json'), manifest)
    write(
        path.join(dir, 'eslint.config.mjs'),
        `import sssb from '@sssb/eslint-plugin'

export default [...(await sssb.configs.app({ root: import.meta.dirname }))]
`,
    )

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

    // tests/contract stays: the starter's contract test calls @sssb/kit/testing/contract, which the tarball ships, and
    // the `contract tests` step runs it as an adopter would (vitest.contract.config.ts below).

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
    // An app-owned lint exception (#51's lint-exceptions.mjs), as safeinsights/pages has one: the module it names may
    // take the raw db handle, and `sssb check-fences` proves a sibling beside it may not.
    write(
        path.join(dir, 'src/domain/maintenance.ts'),
        `import type { DbPort } from '@sssb/kit/ports/db'

/** Runs as the system across every tenant, so it takes the raw handle: lint-exceptions.mjs names it. */
export const systemHandle = (db: DbPort) => db.getDb()
`,
    )
    write(
        path.join(dir, 'lint-exceptions.mjs'),
        `export default {
    'sssb/no-raw-db-handle': [{ file: 'src/domain/maintenance.ts', reason: 'runs as the system across every tenant' }],
}
`,
    )

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

    // An e2e spec that imports @sssb/kit/testing/e2e and an app domain module (ADR-0014 part 7), so `sssb check-e2e`
    // has the case it exists for, and Playwright loads the compiled entry under Node. It takes no page, so it needs no
    // server, but it runs with the rest of the suite in the e2e step.
    write(
        path.join(dir, CONSOLE_E2E_SPEC),
        `import { createHmac } from 'node:crypto'
import { expect, test } from '@playwright/test'
import { verifyWebhookSignature, WEBHOOK_REPLAY_TOLERANCE_MS } from '@sssb/kit/testing/e2e'
import { consoleServiceOrgs } from '@/domain/service-orgs'

// The framework reaches a spec only through @sssb/kit/testing/e2e, compiled and seam-free (ADR-0014 part 2); the app's
// own modules come in as usual. The signature is computed here, with node:crypto, and checked by the framework.
test('the e2e entry verifies a webhook signature computed in the spec', () => {
    const body = JSON.stringify({ serviceOrgs: consoleServiceOrgs })
    const secret = 'console-e2e-secret'
    const t = 1_700_000_000
    const v1 = createHmac('sha256', secret).update(\`\${t}.\${body}\`).digest('hex')
    const opts = { toleranceMs: WEBHOOK_REPLAY_TOLERANCE_MS, now: new Date(t * 1000) }
    expect(verifyWebhookSignature(body, \`t=\${t},v1=\${v1}\`, secret, opts)).toEqual({ ok: true })
    expect(verifyWebhookSignature(\`\${body} \`, \`t=\${t},v1=\${v1}\`, secret, opts)).toEqual({ ok: false, reason: 'signature' })
})
`,
    )
}

/** The console's spec that reaches the framework through @sssb/kit/testing/e2e, relative to the app. */
const CONSOLE_E2E_SPEC = 'tests/e2e/kit-entry.spec.ts'

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
function scaffold(
    /** @type {string} */ tarball,
    /** @type {string} */ toolsTarball,
    /** @type {string} */ pluginTarball,
) {
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
                '@eslint/js',
                'esbuild',
                'eslint',
                'happy-dom',
                'postcss',
                'tsx',
                'typescript',
                'typescript-eslint',
                'vite',
                'vitest',
            ].map((name) => [name, rangeOf(name)]),
        ),
    })
    // The root's own @sssb/tools, from the tarball: its Vitest config uses the preset, as Pages' root config would.
    const rootManifest = readJson(path.join(WS, 'package.json'))
    rootManifest.devDependencies['@sssb/tools'] = `file:${path.relative(WS, toolsTarball)}`
    writeJson(path.join(WS, 'package.json'), rootManifest)

    // The workspace root's own lint config, for what no app's config covers: the root's files and packages/*. Each
    // app's own eslint.config.mjs lints the app's files, wherever ESLint is started (ESLint 10 takes each file's nearest
    // config). The raw typescript-eslint configs and an explicit tsconfigRootDir, because typescript-eslint's
    // \`configs\` getter records each config file that reads it and its parser refuses to guess between two.
    write(
        path.join(WS, 'eslint.config.mjs'),
        `import js from '@eslint/js'
import tseslint from 'typescript-eslint'

export default [
    { ignores: ['**/node_modules/**', '**/.next/**', '**/dist-demo/**'] },
    js.configs.recommended,
    ...tseslint.plugin.configs['flat/recommended'],
    {
        languageOptions: {
            parserOptions: { tsconfigRootDir: import.meta.dirname },
            globals: { process: 'readonly', console: 'readonly' },
        },
    },
]
`,
    )

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

    shapeConsole(scaffoldApp({ app: 'console', slug: 'console', tarball, toolsTarball, pluginTarball }))
    shapeLedger(scaffoldApp({ app: 'ledger', slug: 'ledger', tarball, toolsTarball, pluginTarball }))

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

    // The negative fixture (packages/seamless) is not written here: it joins after the verify (addSeamless).

    // Vitest from the workspace root, as Pages runs it: a project per app from @sssb/tools' preset, which passes
    // each app's own seam explicitly, as every SSSB builder does (the migrator bundle below, tsc and next build
    // resolve it through the link alone). The framework's conformance suite is reached the way an adopter reaches
    // it: each app's own src/sssb.conformance.test.ts (copied with the starter) calls @sssb/kit/testing, so the
    // preset's ordinary `src/**` include runs it, and Vitest's default exclude, node_modules and all, stays in force
    // (ADR-0014 part 3).
    write(
        path.join(WS, 'vitest.config.ts'),
        `import { fileURLToPath } from 'node:url'
import { appTestProject } from '@sssb/tools/vitest'
import { defineConfig, type ViteUserConfig } from 'vitest/config'

const at = (relative: string) => fileURLToPath(new URL(relative, import.meta.url))

const app = (name: string) => appTestProject({ appDir: at(\`./apps/\${name}\`) })

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

    // The contract config, as an adopter would write one: the same preset project per app, narrowed to the app's
    // tests/contract (each calls @sssb/kit/testing/contract), in Node, one file at a time because every app's embedded
    // Postgres takes the one port. The unit config above never reaches tests/contract.
    write(
        path.join(WS, 'vitest.contract.config.ts'),
        `import { fileURLToPath } from 'node:url'
import { appTestProject } from '@sssb/tools/vitest'
import { defineConfig, type ViteUserConfig } from 'vitest/config'

const at = (relative: string) => fileURLToPath(new URL(relative, import.meta.url))

const contract = async (name: string) => {
    const project = await appTestProject({ appDir: at(\`./apps/\${name}\`) })
    return { ...project, test: { ...project.test, environment: 'node', include: ['tests/contract/**/*.test.ts'] } }
}

export default defineConfig(
    async (): Promise<ViteUserConfig> => ({
        test: { fileParallelism: false, projects: [await contract('console'), await contract('ledger')] },
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
        `the packed @sssb/kit ships ${shipped.length} files, no test among them, and the conformance suite's data`,
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
    // Each app's conformance file, held to every check the PACKED registry names: the suite as an adopter gets it.
    /** @type {Record<string, string>} */
    const conformanceFiles = {}
    for (const app of ['console', 'ledger'])
        conformanceFiles[app] = path.join(appDir(app), 'src/sssb.conformance.test.ts')
    const expected = expectedConformanceTests(
        readJson(path.join(kitOf(appDir('console')).kit, 'src/testing/checks.json')),
    )
    // The app tests this job's claims rest on must have run too, not merely the suite as a whole.
    const required = {
        console: ['src/seam-identity.test.ts', 'src/adapters/fake/object-store.test.ts'].map((f) =>
            path.join(appDir('console'), f),
        ),
        ledger: ['src/seam-identity.test.ts'].map((f) => path.join(appDir('ledger'), f)),
    }
    const problems = conformanceProblems(readJson(report), conformanceFiles, expected, required)
    if (problems.length > 0)
        fail(`the conformance suite did not run and pass in full from the tarball:\n  ${problems.join('\n  ')}`)
    console.log(`conformance: all ${expected.length} checks' tests ran and passed in each app, from @sssb/kit/testing`)
}

/**
 * Each app's contract suite (`tests/contract`, which calls `@sssb/kit/testing/contract`) RUN from the tarball, under
 * the consumer's own contract config, on an embedded Postgres of its own (`embedded-postgres`, the starter's
 * devDependency and the framework's optional peer) on a free port; CONTRACT_DATABASE_URL is blanked so a developer's
 * server is never used. Held, like the unit suite, to every contract test the PACKED registry names.
 */
function contractTests() {
    mkdirSync(REPORTS, { recursive: true })
    const report = path.join(REPORTS, 'vitest-contract.json')
    rmSync(report, { force: true })
    run(
        'pnpm',
        [
            'exec',
            'vitest',
            'run',
            '--config',
            'vitest.contract.config.ts',
            '--reporter=default',
            '--reporter=json',
            `--outputFile.json=${report}`,
        ],
        { cwd: WS, env: consumerEnv({ CONTRACT_PG_PORT: String(contractPort), CONTRACT_DATABASE_URL: '' }) },
    )
    /** @type {Record<string, string>} */
    const contractFiles = {}
    for (const app of ['console', 'ledger'])
        contractFiles[app] = path.join(appDir(app), 'tests/contract/rls-contract.test.ts')
    const expected = expectedConformanceTests(
        readJson(path.join(kitOf(appDir('console')).kit, 'src/testing/checks.json')),
        'contract',
    )
    const problems = conformanceProblems(readJson(report), contractFiles, expected)
    if (problems.length > 0)
        fail(`the contract suite did not run and pass in full from the tarball:\n  ${problems.join('\n  ')}`)
    console.log(
        `contract: all ${expected.length} contract tests ran and passed in each app on embedded Postgres, from @sssb/kit/testing/contract`,
    )
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

/**
 * `sssb doctor` and `sssb check-e2e` in each app, as its verify runs them (ADR-0014 part 7): from the tarball, so
 * doctor must NOT find itself in in-repo mode here, and it walks a workspace whose every importer links its own seam.
 * In the console, check-e2e must have checked the spec that reaches the framework through `@sssb/kit/testing/e2e`,
 * resolved through the installed exports map to the compiled entry; and then, with two specs dropped in that reach the
 * framework's source (one directly, one through an app module), it must fail. Here that source is TypeScript under
 * node_modules, which Node will not load, so Playwright cannot list the console's config at all: check-e2e fails the
 * config with Playwright's error, naming the kit file it reaches.
 */
function doctorAndCheckE2e() {
    for (const app of ['console', 'ledger']) {
        const doctor = run('pnpm', ['run', 'sssb:doctor'], { cwd: appDir(app), capture: true })
        console.log(doctor.stdout)
        if (doctor.stdout.includes('in-repo mode'))
            fail(`${app}: sssb doctor took the tarball's kit for this repo's own`)
        const checked = run('pnpm', ['run', 'check:e2e'], { cwd: appDir(app), capture: true })
        console.log(checked.stdout)
        if (app !== 'console') continue
        const okProblems = checkE2eOkProblems(checked, CONSOLE_E2E_SPEC)
        if (okProblems.length > 0) fail(`console: sssb check-e2e:\n  ${okProblems.join('\n  ')}`)
    }

    const kitFile = '@sssb/kit:src/core/webhook-signing.ts'
    const probes = {
        'tests/e2e/reaches-kit-source.spec.ts':
            "import { WEBHOOK_SIGNATURE_HEADER } from '@sssb/kit/core/webhook-signing'\nconsole.log(WEBHOOK_SIGNATURE_HEADER)\n",
        'tests/e2e/reaches-kit-through-app.spec.ts':
            "import { probeHeader } from '@/domain/e2e-probe'\nconsole.log(probeHeader)\n",
        'src/domain/e2e-probe.ts':
            "export { WEBHOOK_SIGNATURE_HEADER as probeHeader } from '@sssb/kit/core/webhook-signing'\n",
    }
    for (const [file, text] of Object.entries(probes)) write(path.join(appDir('console'), file), text)
    let probed
    try {
        probed = run('pnpm', ['exec', 'sssb', 'check-e2e'], {
            cwd: appDir('console'),
            capture: true,
            allowFailure: true,
        })
    } finally {
        for (const file of Object.keys(probes)) rmSync(path.join(appDir('console'), file))
    }
    const failProblems = checkE2eFailProblems(probed, { config: 'playwright.config.ts', kitFile })
    if (failProblems.length > 0) {
        console.error(`${probed.stdout}\n${probed.stderr}`)
        fail(`console: sssb check-e2e with specs reaching the framework's source:\n  ${failProblems.join('\n  ')}`)
    }
    console.log(
        `sssb check-e2e failed the config whose specs reach ${kitFile}, as it must:\n  ${probed.stdout
            .split('\n')
            .filter((line) => /^FAIL|^ {10}/.test(line))
            .join('\n  ')}`,
    )
}

/**
 * Playwright itself loads every console spec, the one importing `@sssb/kit/testing/e2e` and an app module included:
 * `--list` loads each file under Node, as a run does, without starting the dev server or a browser. So the spec
 * check-e2e passes is proven loadable even when `--skip-build-and-e2e` skips the run.
 */
function playwrightLoadsSpecs() {
    const listed = run('pnpm', ['exec', 'playwright', 'test', '--list', '--reporter=list'], {
        cwd: appDir('console'),
        env: consumerEnv({ CI: '1' }),
        capture: true,
    })
    console.log(listed.stdout)
    if (!listed.stdout.includes(`${path.basename(CONSOLE_E2E_SPEC)}:`))
        fail(`playwright test --list did not list ${CONSOLE_E2E_SPEC}`)
}

/** THE NEGATIVE FIXTURE: an importer of @sssb/kit that links no seam, joining the workspace after the verify. */
function addSeamless() {
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
    run('pnpm', ['install', '--no-frozen-lockfile'], { cwd: WS })
}

/**
 * The lint fences, the way an adopter runs them (ADR-0014 part 4): `eslint .` from the workspace root, where ESLint 10
 * lints each app's files with the app's own config, and from each app; then `sssb check-fences` in each app, which
 * compares every source file's effective config with the preset's and probes each fence and the console's
 * lint-exceptions.mjs entry. Last, a fence is seen to REPORT from the root: a vendor import written into the console's
 * domain, linted from the workspace root, must come back as sssb/no-vendor-import.
 */
function lint() {
    run('pnpm', ['exec', 'eslint', '.'], { cwd: WS })
    for (const app of ['console', 'ledger']) {
        run('pnpm', ['exec', 'eslint', '.'], { cwd: appDir(app) })
        run('pnpm', ['exec', 'sssb', 'check-fences'], { cwd: appDir(app) })
    }
    const probe = path.join(appDir('console'), 'src/domain/fence-probe.ts')
    write(probe, "import { S3Client } from '@aws-sdk/client-s3'\nexport const client = S3Client\n")
    try {
        const linted = run('pnpm', ['exec', 'eslint', '--format', 'json', path.relative(WS, probe)], {
            cwd: WS,
            capture: true,
            allowFailure: true,
        })
        const [result] = JSON.parse(linted.stdout)
        const rules = (result?.messages ?? []).map((/** @type {{ ruleId: string }} */ m) => m.ruleId)
        if (!rules.includes('sssb/no-vendor-import')) {
            fail(
                `linted from the workspace root, the console's vendor import was not reported (got: ${rules.join(', ') || 'nothing'})`,
            )
        }
        console.log(
            "from the workspace root, the console's own config reported its vendor import (sssb/no-vendor-import)",
        )
    } finally {
        rmSync(probe, { force: true })
    }
}

function negativeFixture() {
    addSeamless()
    // Doctor, run from an APP, walks the whole workspace and names the importer that slipped (ADR-0014 part 5).
    const doctor = run('pnpm', ['exec', 'sssb', 'doctor'], {
        cwd: appDir('console'),
        capture: true,
        allowFailure: true,
    })
    const named = doctor.stdout
        .split('\n')
        .find((line) => /^\s+- packages\/seamless: takes @sssb\/kit but declares no seam link/.test(line))
    if (doctor.status !== 1 || named === undefined) {
        console.error(`${doctor.stdout}\n${doctor.stderr}`)
        fail(`sssb doctor did not name the seamless importer (exit ${doctor.status})`)
    }
    console.log(`sssb doctor named the seamless importer, from apps/console:\n  ${named.trim()}`)

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

/**
 * `@sssb/kit/testing/e2e` is the one entry Node loads directly (Playwright does not transform `node_modules`), so
 * it ships compiled and seam-free (ADR-0014 part 2). Plain Node, no tsx, loads it from the package that has NO
 * seam, and the verifier it exports checks a signature.
 */
function e2eEntryUnderNode() {
    const script = [
        "const e2e = await import('@sssb/kit/testing/e2e')",
        "const result = e2e.verifyWebhookSignature('{}', 't=1,v1=00', 'k', { toleranceMs: e2e.WEBHOOK_REPLAY_TOLERANCE_MS, now: new Date(1000) })",
        "if (result.ok || result.reason !== 'signature') throw new Error('unexpected verdict ' + JSON.stringify(result))",
        "console.log(import.meta.resolve('@sssb/kit/testing/e2e'))",
    ].join('\n')
    const result = run('node', ['--input-type=module', '-e', script], {
        cwd: path.join(WS, 'packages/seamless'),
        capture: true,
        allowFailure: true,
    })
    if (result.status !== 0) {
        fail(`plain Node could not load @sssb/kit/testing/e2e without a seam:\n${result.stdout}\n${result.stderr}`)
    }
    if (!/\/dist\/testing\/e2e\.js$/.test(result.stdout.trim())) {
        fail(`@sssb/kit/testing/e2e resolved to ${result.stdout.trim()}, not the compiled dist/testing/e2e.js`)
    }
    console.log(`plain Node, no seam: @sssb/kit/testing/e2e -> ${result.stdout.trim()}`)
}

// ---- the run --------------------------------------------------------------------------------------

const started = Date.now()
const port = await freePort()
// The consumer's contract suites' embedded Postgres: a free port, never the per-checkout one this repo's own uses.
const contractPort = await freePort()
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
/** @type {string} */
let pluginTarball = ''
step('pack @sssb/kit, @sssb/tools and @sssb/eslint-plugin', () => {
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

    // @sssb/eslint-plugin: JavaScript ESLint loads directly, with no dependency on any SSSB package, and ESLint a peer.
    pluginTarball = pack('packages/eslint-plugin')
    const pluginFiles = run('tar', ['-tzf', pluginTarball], { cwd: BASE, capture: true })
        .stdout.split('\n')
        .filter(Boolean)
        .map((file) => file.replace(/^package\//, ''))
    const pluginProblems = [
        ...pluginManifestProblems(packedManifest(pluginTarball)),
        ...pluginShippedFileProblems(pluginFiles),
    ]
    if (pluginProblems.length > 0)
        fail(`the packed @sssb/eslint-plugin is not what it must be:\n  ${pluginProblems.join('\n  ')}`)
    console.log(
        `${path.basename(pluginTarball)}: ${pluginFiles.length} files, ${Math.round(statSync(pluginTarball).size / 1024)} KB; JavaScript and declarations only, no SSSB dependency`,
    )
})
step('scaffold the consumer workspace', () => scaffold(tarball, toolsTarball, pluginTarball))
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
        ['@sssb/eslint-plugin', pluginTarball],
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
step('unit tests and the conformance suite, from the workspace root', unitTests)
step('contract tests on embedded Postgres, from the workspace root', contractTests)
step('migrator bundles, with no alias and no tsconfig', migratorBundles)
step('sssb doctor and sssb check-e2e, in each app', doctorAndCheckE2e)
step('Playwright loads every console spec (--list: no server, no browser)', playwrightLoadsSpecs)
step('negative fixture: an importer with no seam, which sssb doctor names', negativeFixture)
step('the compiled e2e entry loads under plain Node, with no seam', e2eEntryUnderNode)
step('the dev:real preflight, through esbuild from each app', realEnvPreflight)
step('lint from the workspace root and from each app, and sssb check-fences', lint)
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
