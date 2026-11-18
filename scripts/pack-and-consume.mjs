// PACK AND CONSUME (ADR-0014 part 7, rule 5, steps P2 and P12): proves the framework the way an adopter gets
// it. Packs @sssb/kit, @sssb/tools, @sssb/eslint-plugin, @sssb/cdk and @sssb/create, generates workspaces OUTSIDE this
// repository with the PACKED generator (extracted from its tarball, run under plain Node, `--sssb <tarball dir>`), so
// they install the TARBALLS (never `workspace:`), and runs each workspace's checks. The tarballs it packs, flat in one
// directory, are also what a release candidate attaches (ADR-0014 P7: checks.yml keeps them as the run's artifact).
// Two shapes:
//
//   pnpm pack-and-consume [--shape pages|generated] [--dir <path>] [--skip-build-and-e2e] [--update-lockfile]
//
//   pages      (shape 1) the Pages-shaped multi-app workspace below, built on the generator's output, and this
//              script's own checks over it. CI's `pack-and-consume` job.
//   generated  (shape 2) the generator's output and NOTHING else: not one file of it is edited (the run fails if one
//              changed), and the workspace's OWN gates run: `pnpm verify`, the unit tests and `pnpm test:contract` (on
//              embedded Postgres) held to the conformance suite, the reusable workflow's `sssb ci lint-typecheck-unit`
//              and `sssb ci synth`, `pnpm knip` and `pnpm jscpd` (the workspace's own CI job), then that the workflow's
//              pin, the plugin marketplace's in `.claude/settings.json` and the packed kit's release stamp are one
//              commit, which holds the plugin, and that `sssb doctor` says they match. CI's `adoption-probe`
//              job, a required check. A failure here is the generator's to fix, never this script's.
//   (neither)  both, the pages shape first.
//
// Inside this repo every tool reaches the framework through workspace links and per-app aliases, which
// hide exactly what an adopter hits: a file the package does not ship, an @types package only this
// repo's root declares, a seam that only an alias resolves. Here nothing resolves the seam but pnpm's
// link of the app's own `@sssb/app-config` into its own copy of the framework.
//
// The pages shape, laid out like the first adopter's (safeinsights/pages). The generator writes the workspace with
// its first app (`--slug console`); the second app is the generator's app for `--slug ledger`, generated beside it and
// moved in, with the root's app lists (`sssb.apps`, the two Vitest configs' APPS) extended as an adopter adding an app
// extends them. Everything else below is the shape's own code and this script's instruments, never a fix to the
// generator's output:
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
// Any gap between that and what an adopter should need is a named workaround
// (scripts/pack-and-consume/workarounds.mjs), tied to the step that removes it. P12's six (the tsconfig, the seam
// package, the root's tools, allowBuilds, the ESLint configs, dedupePeerDependents) left with the generator, which
// writes each of them.
//
// Both shapes install from ONE committed lockfile seed (scripts/pack-and-consume/consumer-lock.yaml), written from the
// pages shape: the generated shape's importers (the root, apps/console, apps/console/infra) are a subset of it, so its
// resolution is the seed's too, and a third-party release cannot turn either check red on a PR that did not cause it.
//
// The workspaces are left in place after a run, so a failure can be inspected; the next run wipes them.

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
    cdkPackProblems,
    checkE2eFailProblems,
    checkE2eOkProblems,
    createPackageProblems,
    createPackEnv,
    expectedConformanceTests,
    generatedPinProblems,
    heldUnitScripts,
    lockfileFromSeed,
    seedFromLockfile,
    seedMachinePathProblems,
    GENERATED_VERIFY_GATES,
    templateAppProblems,
    verifyGateProblems,
    STRICT_FLAGS,
    conformanceProblems,
    tarballIntegrities,
    lockfileMoves,
    lockfileProblems,
    packagesBeyondSeed,
    seamPeerProblems,
    shippedFileProblems,
    pluginManifestProblems,
    pluginShippedFileProblems,
    toolsManifestProblems,
    toolsShippedFileProblems,
    tscErrors,
    undeclaredImports,
} from './pack-and-consume/checks.mjs'
import { WORKAROUNDS, unusedWorkarounds } from './pack-and-consume/workarounds.mjs'

const REPO = path.resolve(import.meta.dirname, '..')

// ---- arguments ------------------------------------------------------------------------------------

const VALUE_ARGS = new Set(['--dir', '--shape'])
const KNOWN_ARGS = new Set([...VALUE_ARGS, '--skip-build-and-e2e', '--update-lockfile'])
const args = process.argv.slice(2)
for (const [i, arg] of args.entries()) {
    if (!VALUE_ARGS.has(args[i - 1] ?? '') && !KNOWN_ARGS.has(arg)) fail(`unknown argument ${arg}`)
}
/** @param {string} flag */
function valueOf(flag) {
    const at = args.indexOf(flag)
    if (at < 0) return null
    const value = args[at + 1]
    if (!value || value.startsWith('--')) fail(`${flag} needs a value`)
    return /** @type {string} */ (value)
}
const SKIP_BUILD_AND_E2E = args.includes('--skip-build-and-e2e')
// Resolve afresh and write the result back as the committed seed (scripts/pack-and-consume/consumer-lock.yaml).
const UPDATE_LOCKFILE = args.includes('--update-lockfile')
const SHAPE = valueOf('--shape')
if (SHAPE !== null && SHAPE !== 'pages' && SHAPE !== 'generated') fail(`--shape ${SHAPE}: expected pages or generated`)
const RUN_PAGES = SHAPE !== 'generated'
const RUN_GENERATED = SHAPE !== 'pages'
// The seed is the pages shape's resolution (a superset of the generated shape's importers).
if (UPDATE_LOCKFILE && !RUN_PAGES)
    fail('--update-lockfile writes the seed from the pages shape: drop --shape generated')

/** Marks a directory as this script's, so a re-run wipes only what an earlier run made. */
const MARKER = '.sssb-pack-and-consume'
const dirArg = valueOf('--dir')
const BASE_ARG = path.resolve(dirArg ?? path.join(tmpdir(), 'sssb-pack-and-consume'))
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
/** The pages shape's workspace. */
const WS = path.join(BASE, 'workspace')
/** The generated shape's workspace: the generator's output, untouched. */
const GEN = path.join(BASE, 'generated')
/** Every packed tarball, side by side: the directory the generator's `--sssb` takes. */
const TARBALLS = path.join(BASE, 'tarballs')
/** The packed @sssb/create, extracted: the generator both shapes run. */
const CREATE = path.join(BASE, 'create')
/** Where the pages shape's second app is generated before it is moved in. */
const LEDGER_SOURCE = path.join(BASE, 'ledger-source')
const REPORTS = path.join(BASE, 'reports')
const LOCK_SEED = path.join(REPO, 'scripts/pack-and-consume/consumer-lock.yaml')
/**
 * The generator writes the tarballs' ABSOLUTE paths (each app's and the root's `file:` specifiers, and the
 * pnpm-workspace.yaml `overrides` that pnpm copies into the lockfile), and this run's directory differs between
 * machines; each tarball's file name carries the fixed group's version, which every release candidate moves
 * (`sssb-kit-0.2.0-rc.0.tgz`). The seed holds a token for each (checks.mjs' SEED_TARBALLS and SEED_VERSION), swapped
 * for TARBALLS and the version just packed when it is copied in and back when it is written, so the seed's specifiers
 * and overrides match the workspace's exactly, on any machine and at any version, and pnpm keeps its resolution.
 */
/** The fixed group's version, as every packed manifest holds it. */
let PACKED_VERSION = ''
const seedRun = () => ({ tarballs: TARBALLS, version: PACKED_VERSION })
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
        fail(`${path.relative(BASE, file)}: expected one occurrence of ${JSON.stringify(from)}, found ${count}`)
    writeFileSync(
        file,
        text.replace(from, () => to),
    )
}

/**
 * Runs the PACKED generator, extracted from its tarball, under plain Node, from this run's directory: the template it
 * writes from is the one packed into it (outside SSSB's repository it has no checkout to fall back on), and every
 * @sssb package comes from the tarballs beside it.
 * @param {string} target
 * @param {string[]} flags
 */
function generate(target, flags) {
    rmSync(target, { recursive: true, force: true })
    run('node', [path.join(CREATE, 'package/bin/create.js'), target, ...flags, '--sssb', TARBALLS, '--yes'], {
        cwd: BASE,
    })
    if (!existsSync(path.join(target, 'pnpm-workspace.yaml'))) fail(`the generator wrote no workspace at ${target}`)
}

/**
 * The committed seed, its tarball token swapped for this run's tarball directory, as the workspace's pnpm-lock.yaml:
 * pnpm keeps every resolution in it whose specifier still matches and resolves only what changed (the tarballs, whose
 * content changes with every build, or a range this repo moved), as an adopter's committed lockfile does.
 * @param {string} dir
 */
function seedLockfile(dir) {
    if (!existsSync(LOCK_SEED)) fail(`no lockfile seed at ${LOCK_SEED}: run with --update-lockfile to make one`)
    write(path.join(dir, 'pnpm-lock.yaml'), seedText())
}

/** The seed as it was copied in, to measure how far an install's resolution moved from it. */
const seedText = () => lockfileFromSeed(readFileSync(LOCK_SEED, 'utf8'), seedRun())

/**
 * The seed an installed workspace's lockfile makes, refused if it would hold a path into this run's directory: run on
 * every install, so a change that would make the seed machine-specific fails the PR that makes it, not the next
 * refresh.
 * @param {string} lockText
 */
function seedOf(lockText) {
    const seed = seedFromLockfile(lockText, seedRun())
    const problems = seedMachinePathProblems(seed, BASE)
    if (problems.length > 0) fail(`the lockfile's seed would be machine-specific:\n  ${problems.join('\n  ')}`)
    return seed
}

/**
 * After an install: the integrity pnpm recorded for each SSSB package is the tarball's just packed, not one an earlier
 * lockfile or the store cache remembered; and no @sssb resolution came from anywhere but a tarball or the app's link.
 * @param {string} dir
 */
function checkInstalledTarballs(dir) {
    const lockText = readFileSync(path.join(dir, 'pnpm-lock.yaml'), 'utf8')
    for (const [name, file] of Object.entries(tarballs)) {
        const packed = `sha512-${createHash('sha512').update(readFileSync(file)).digest('base64')}`
        const locked = tarballIntegrities(lockText, name)
        if (locked.length !== 1 || locked[0] !== packed) {
            fail(
                `${path.relative(BASE, dir)}: the lockfile's ${name} integrity (${locked.join(', ') || 'none'}) is not the tarball just packed (${packed})`,
            )
        }
    }
    const { problems, seen } = lockfileProblems(lockText)
    console.log(`lockfile @sssb entries:\n  ${[...new Set(seen)].join('\n  ')}`)
    if (!seen.some((entry) => entry.startsWith('packages: @sssb/kit@file:')))
        problems.push('the lockfile has no @sssb/kit from the tarball')
    if (problems.length > 0)
        fail(`the lockfile resolves SSSB from somewhere other than the tarball:\n  ${problems.join('\n  ')}`)
    return lockText
}

/** @param {string} app */
const appDir = (app) => path.join(WS, 'apps', app)

/**
 * The pages shape's instruments in one app (none of them a fix to what the generator wrote): the strict-flag config
 * the strict typecheck runs, every published @sssb/kit module in the app's type program, and a test proving the
 * framework the app installed reads the app's own seam.
 * @param {string} app the app's slug, which is its directory's name
 */
function instrumentApp(app) {
    const dir = appDir(app)
    writeJson(path.join(dir, 'tsconfig.strict.json'), {
        extends: './tsconfig.json',
        compilerOptions: Object.fromEntries(STRICT_FLAGS.map((flag) => [flag, true])),
    })
    const slug = /export const APP_SLUG = '([^']+)'/.exec(readFileSync(path.join(dir, 'config/app.ts'), 'utf8'))?.[1]
    if (slug !== app) fail(`apps/${app}: the generator wrote APP_SLUG ${slug}, not ${app}`)

    // The WHOLE public surface, in the app's type program. A consumer typechecks only the framework
    // modules it reaches, and the starter reaches a fraction of them; an adopter may import any published
    // subpath, so every `exports` key (the JSON catalogs aside) is re-exported here, type-only, and both
    // typechecks cover each one against this app's seam. Nothing imports this file, so no bundle sees it.
    const surface = Object.keys(KIT_MANIFEST.exports)
        // Data files have no types to import: the catalogs (`.json`) and the app guide (`guide.md`).
        .filter((key) => key !== './package.json' && !key.endsWith('.json') && !key.endsWith('.md'))
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

/**
 * Builds the pages shape under WS, on the generator's output: the workspace and its first app as `@sssb/create`
 * writes them, the second app as it writes one, then the shape's own code and this script's instruments.
 */
function scaffold() {
    generate(WS, ['--slug', 'console', '--name', 'Console'])

    // The second app: the generator makes a workspace with one app, so the ledger is the app it generates for
    // `--slug ledger`, moved in beside the console. The root lists its apps in three places (`sssb.apps`, which
    // `sssb ci` and `sssb doctor` read, and each Vitest config's APPS), extended as an adopter adding an app extends
    // them; everything else the generator wrote at the root already covers every apps/* and packages/*.
    generate(LEDGER_SOURCE, ['--slug', 'ledger', '--name', 'Ledger'])
    cpSync(path.join(LEDGER_SOURCE, 'apps/ledger'), appDir('ledger'), { recursive: true })
    rmSync(LEDGER_SOURCE, { recursive: true, force: true })
    const root = readJson(path.join(WS, 'package.json'))
    if (JSON.stringify(root.sssb?.apps) !== JSON.stringify(['apps/console']))
        fail(`the generated root's sssb.apps is ${JSON.stringify(root.sssb?.apps)}, not ["apps/console"]`)
    root.sssb.apps = ['apps/console', 'apps/ledger']
    writeJson(path.join(WS, 'package.json'), root)
    for (const config of ['vitest.config.ts', 'vitest.contract.config.ts'])
        replaceOnce(path.join(WS, config), "const APPS = ['console']", "const APPS = ['console', 'ledger']")
    // ...and the sibling package's tests join the root's Vitest run, as Pages' packages/gate does.
    replaceOnce(
        path.join(WS, 'vitest.config.ts'),
        'projects: await Promise.all(APPS.map((app) => appTestProject({ appDir: at(`./apps/${app}`) }))),',
        `projects: [
            ...(await Promise.all(APPS.map((app) => appTestProject({ appDir: at(\`./apps/\${app}\`) })))),
            { test: { name: 'gate', root: at('./packages/gate'), environment: 'node' } },
        ],`,
    )

    // Every @sssb package is routed to an address nothing listens on, so an install that asked the
    // registry for one, the seam above all, fails instead of passing on whatever the registry answered.
    write(path.join(WS, '.npmrc'), '@sssb:registry=http://127.0.0.1:9/\n')

    // The committed lockfile seed, as an adopter commits theirs: so a third-party release cannot turn this check red
    // on a PR that did not cause it. --update-lockfile resolves afresh instead.
    if (!UPDATE_LOCKFILE) seedLockfile(WS)

    for (const app of ['console', 'ledger']) instrumentApp(app)
    shapeConsole(appDir('console'))
    shapeLedger(appDir('ledger'))

    // A sibling package that does not use the framework (Pages' packages/gate), only @sssb/tools' helper.
    writeJson(path.join(WS, 'packages/gate/package.json'), {
        name: 'gate',
        private: true,
        type: 'module',
        scripts: { typecheck: 'tsc --noEmit' },
        devDependencies: {
            '@sssb/tools': `file:${path.relative(path.join(WS, 'packages/gate'), tarballs['@sssb/tools'])}`,
        },
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

/** The real directory of the @sssb/kit an app resolves, and the real directory its seam link points at. */
function kitOf(/** @type {string} */ dir) {
    const kit = realpathSync(path.join(dir, 'node_modules/@sssb/kit'))
    const seamLink = path.join(path.dirname(kit), 'app-config')
    return { kit, seam: existsSync(seamLink) ? realpathSync(seamLink) : null }
}

/** @param {string} lock the installed workspace's lockfile */
function checkSeamLinks(lock, /** @type {string[]} */ apps) {
    const { seen } = lockfileProblems(lock)
    const missing = apps.filter(
        (app) => !seen.includes(`snapshots: @sssb/app-config -> link:apps/${app}/src/app-config`),
    )
    if (missing.length > 0) fail(`no @sssb/kit snapshot in the lockfile links the seam of: ${missing.join(', ')}`)
}

function checkLayout() {
    checkSeamLinks(readFileSync(path.join(WS, 'pnpm-lock.yaml'), 'utf8'), ['console', 'ledger'])

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
    // The app guide the tarball ships (ADR-0014 P7), copied as an adopter copies it, once for the workspace: doctor
    // fails an adopter's app whose copy is missing or stale, and this workspace is an adopter's.
    run('pnpm', ['exec', 'sssb', 'guide'], { cwd: appDir('console') })
    const guideCheck = run('pnpm', ['exec', 'sssb', 'guide', '--check'], { cwd: appDir('ledger'), capture: true })
    console.log(guideCheck.stdout.trim())
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
        dependencies: {
            '@sssb/kit': `file:${path.relative(path.join(WS, 'packages/seamless'), tarballs['@sssb/kit'])}`,
        },
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

// ---- the generated shape (shape 2) ----------------------------------------------------------------

/** The generated workspace's app, the generator's `--slug`: the seed's own (see LOCK_SEED), so its resolution holds. */
const GEN_APP = 'console'
/**
 * Its display name. The apostrophe and the ampersand are deliberate, and so is one of each character a display name may
 * hold only with care (`#`, `;`, `%`, `=`, `_`, `~`): the generator writes the name into TypeScript, JSON, HTML,
 * markdown and ICU messages, each quoted its own way, and the workspace's lint, typecheck and e2e read every one.
 */
const GEN_NAME = "Harbor & O'Neill C# Console; 50% = data_lab ~ v1"
/**
 * The gates this shape runs as steps of their own, in both modes, as CI runs them rather than as verify says it does:
 * the unit and contract runs held to every conformance test the packed registry names, synth through the reusable
 * workflow's `sssb ci synth` with the generated workflow's selector, knip and jscpd as the generated workflow's own job
 * runs them. A verify script can name a gate and still run nothing (verifyGateProblems refuses the common forms, not
 * every one). `--skip-build-and-e2e` leaves them out of its script-by-script verify, which would run them twice.
 */
const OWN_STEP_GATES = new Set(['unit tests', 'contract tests', 'synth', 'jscpd', 'knip'])

/** @param {string} dir */
const fileHashes = (dir) =>
    new Map(
        filesUnder(dir).map((file) => [
            path.relative(dir, file),
            createHash('sha256').update(readFileSync(file)).digest('hex'),
        ]),
    )

/** Every file the generator wrote, with its hash: none may change before the run ends. */
let generatedFiles = new Map()

function generateWorkspace() {
    generate(GEN, [
        '--slug',
        GEN_APP,
        '--name',
        GEN_NAME,
        '--repo',
        'harbor-org/console',
        '--owner',
        '@harbor-org/devs',
    ])
    generatedFiles = fileHashes(GEN)
    console.log(`the packed generator wrote ${generatedFiles.size} files`)
}

/**
 * The seed, then `pnpm install`, as an adopter installs a workspace whose lockfile is committed. No `.npmrc` guard as in
 * the pages shape: that would be a file the generator did not write, and the generated pnpm-workspace.yaml's
 * `overrides` already send every @sssb package to its tarball, which the lockfile check below holds.
 */
function installGenerated() {
    seedLockfile(GEN)
    run('pnpm', ['install', '--no-frozen-lockfile'], { cwd: GEN })
    const lockText = checkInstalledTarballs(GEN)
    seedOf(lockText)
    checkSeamLinks(lockText, [GEN_APP])
    // The seed's importers are a superset of this workspace's (the pages shape's second app and sibling package go,
    // and pnpm moves some `optional` flags with them), so what says the resolution left the seed is a package version
    // the seed does not hold.
    const beyond = packagesBeyondSeed(seedText(), lockText)
    if (beyond.length > 0) {
        notice(
            `the generated workspace resolved ${beyond.length} package version(s) its seed does not hold (${beyond.slice(0, 5).join(', ')}): refresh the seed with \`pnpm pack-and-consume --update-lockfile\` and commit scripts/pack-and-consume/consumer-lock.yaml`,
        )
    }
}

/** The environment the generated workspace's checks run with: its own ports, and never a developer's database. */
const generatedEnv = () =>
    consumerEnv({
        STARTER_PORT: String(generatedPort),
        CI: process.env.CI ?? '1',
        CONTRACT_PG_PORT: String(generatedContractPort),
        CONTRACT_DATABASE_URL: '',
    })

/**
 * How the generated verify meets each gate `sssb / all-checks` holds (checks.mjs' GENERATED_VERIFY_GATES), read from
 * the generated root package.json before anything runs it: the generated required check must not go green with a gate
 * dropped from verify, so a verify that leaves one out fails here, naming it.
 */
function verifyComposition() {
    const scripts = readJson(path.join(GEN, 'package.json')).scripts ?? {}
    const { problems, runBy } = verifyGateProblems(scripts)
    if (problems.length > 0)
        fail(`the generated workspace's verify does not hold what sssb / all-checks holds:\n  ${problems.join('\n  ')}`)
    console.log(
        `verify runs every gate: ${[...runBy].map(([gate, script]) => (gate === script ? gate : `${gate} (${script})`)).join(', ')}`,
    )
    verifyRunBy = runBy
    return runBy
}

/** Which script the generated verify meets each gate with (verifyComposition), for the steps that hold them. */
let verifyRunBy = new Map()

/**
 * The workspace's own `pnpm verify`. With --skip-build-and-e2e, the part of it before e2e and the static demo, gate by
 * gate through the script verify runs it with, less the gates this shape runs as steps of their own (OWN_STEP_GATES).
 */
function verifyGenerated() {
    const runBy = verifyComposition()
    const env = generatedEnv()
    if (!SKIP_BUILD_AND_E2E) {
        const withDeps = process.env.CI ? ['--with-deps'] : []
        run('pnpm', ['exec', 'playwright', 'install', ...withDeps, 'chromium'], {
            cwd: path.join(GEN, 'apps', GEN_APP),
        })
        run('pnpm', ['verify'], { cwd: GEN, env })
        return
    }
    const ran = new Set()
    for (const { gate, e2e } of GENERATED_VERIFY_GATES) {
        const script = /** @type {string} */ (runBy.get(gate))
        if (e2e || OWN_STEP_GATES.has(gate) || ran.has(script)) continue
        // A gate verify runs inline, not through a script of its own, cannot be run alone without running verify whole.
        if (script === 'verify') {
            console.log(`--skip-build-and-e2e: ${gate} runs inline in verify, so it was NOT run here`)
            continue
        }
        ran.add(script)
        run('pnpm', ['run', script], { cwd: GEN, env })
    }
    console.log('\n--skip-build-and-e2e: the generated verify ran WITHOUT its e2e and static demo')
}

/**
 * A root script of the generated workspace run with Vitest's JSON report (options after the script name reach Vitest,
 * through `sssb check-tmpdir-leak`), and the app's conformance file held to every test the PACKED registry names for
 * the runner: an exit code alone would pass a run that filtered the suite out or skipped it.
 * @param {string} script
 * @param {'unit' | 'contract'} runner
 * @param {string} file the app's conformance file, relative to the app
 */
function heldRun(script, runner, file) {
    mkdirSync(REPORTS, { recursive: true })
    const report = path.join(REPORTS, `generated-${runner}.json`)
    rmSync(report, { force: true })
    run('pnpm', ['run', script, '--reporter=default', '--reporter=json', `--outputFile.json=${report}`], {
        cwd: GEN,
        env: generatedEnv(),
    })
    const dir = path.join(GEN, 'apps', GEN_APP)
    const expected = expectedConformanceTests(readJson(path.join(kitOf(dir).kit, 'src/testing/checks.json')), runner)
    const problems = conformanceProblems(readJson(report), { [GEN_APP]: path.join(dir, file) }, expected)
    if (problems.length > 0)
        fail(
            `the generated workspace's ${script} did not run the ${runner} checks in full:\n  ${problems.join('\n  ')}`,
        )
    return expected.length
}

/**
 * The unit run, held to every unit conformance test the PACKED registry names: through each script that runs it on the
 * way to a green (heldUnitScripts: the one verify reaches for the gate, the one `sssb ci lint-typecheck-unit` runs).
 */
function unitGenerated() {
    const scripts = heldUnitScripts(readJson(path.join(GEN, 'package.json')).scripts ?? {}, verifyRunBy)
    if (scripts.length === 0) fail('no script of the generated workspace runs its unit tests')
    for (const script of scripts) {
        const count = heldRun(script, 'unit', 'src/sssb.conformance.test.ts')
        console.log(
            `conformance: pnpm ${script} ran all ${count} checks' tests, and they passed, from @sssb/kit/testing`,
        )
    }
}

/**
 * The synth job as the reusable workflow runs it, `sssb ci synth --filter <selector>`, with the selector the generated
 * workflow passes it: every infra package it matches must have a synth script, and one must match.
 */
function synthGenerated() {
    const selector = /^ +synth: (\S+)$/m.exec(readFileSync(path.join(GEN, '.github/workflows/checks.yml'), 'utf8'))?.[1]
    if (!selector) fail("the generated workflow passes SSSB's reusable workflow no synth selector")
    run('pnpm', ['exec', 'sssb', 'ci', 'synth', '--filter', /** @type {string} */ (selector)], { cwd: GEN })
}

/** `pnpm test:contract` on an embedded Postgres, held to every contract test the PACKED registry names. */
function contractGenerated() {
    const count = heldRun('test:contract', 'contract', 'tests/contract/rls-contract.test.ts')
    console.log(`contract: all ${count} contract tests ran and passed, on embedded Postgres`)
}

/**
 * THE PINS (ADR-0014 part 5, P13): the generated `.claude/settings.json` pins SSSB's marketplace to the commit the
 * generated workflow pins the reusable workflow to; the packed kit's release stamp names that commit; `sssb doctor`'s
 * pin report says they match; and the plugin is at that commit (its manifest and the marketplace's, in this checkout:
 * locally that is the packing commit, so the plugin must be committed before packing, as the starter must be for the
 * generator's template).
 */
function pinsGenerated() {
    const plugin = readJson(path.join(REPO, 'plugins/sssb/.claude-plugin/plugin.json')).name
    const doctor = run('pnpm', ['exec', 'sssb', 'doctor', '--app', path.join('apps', GEN_APP)], {
        cwd: GEN,
        env: generatedEnv(),
        capture: true,
    })
    const { commit, problems } = generatedPinProblems({
        workflow: readFileSync(path.join(GEN, '.github/workflows/checks.yml'), 'utf8'),
        settings: readFileSync(path.join(GEN, '.claude/settings.json'), 'utf8'),
        stamp: KIT_STAMP,
        plugin,
        doctorOutput: doctor.stdout,
    })
    if (commit !== null) {
        for (const file of ['.claude-plugin/marketplace.json', 'plugins/sssb/.claude-plugin/plugin.json']) {
            const at = run('git', ['cat-file', '-e', `${commit}:${file}`], {
                cwd: REPO,
                env: process.env,
                capture: true,
                allowFailure: true,
                quiet: true,
            })
            if (at.status !== 0)
                problems.push(`${file} is not in commit ${commit}, which the generated settings pin the marketplace to`)
        }
    }
    if (problems.length > 0) fail(`the generated pins do not agree:\n  ${problems.join('\n  ')}`)
    console.log(
        `the workflow, the plugin marketplace and @sssb/kit's release stamp all name ${commit}, doctor says so, and the plugin is there`,
    )
}

/** No file the generator wrote was changed by anything the run did: the workspace was checked as generated. */
function generatedUntouched() {
    const changed = []
    for (const [file, hash] of generatedFiles) {
        const full = path.join(GEN, file)
        if (!existsSync(full)) changed.push(`${file} (removed)`)
        else if (createHash('sha256').update(readFileSync(full)).digest('hex') !== hash) changed.push(file)
    }
    if (changed.length > 0) {
        fail(
            `files the generator wrote were changed during the run (a tool rewrote them, so the generator must write them that way):\n  ${changed.join('\n  ')}`,
        )
    }
    console.log(`all ${generatedFiles.size} files the generator wrote are as it wrote them`)
}

/**
 * THE SEAM SURVIVES pnpm's partial installs: `pnpm add`, `remove` and `update` in the app, as an author runs them,
 * each followed by `sssb doctor` and the lockfile's seam link. A `link:` seam passed a fresh install and was unlinked by
 * the first of these (ADR-0014's 2026-11-18 addendum). Last, because each rewrites the app's package.json and lockfile.
 */
function partialInstallsKeepSeam() {
    const steps = /** @type {const} */ ([
        ['pnpm add', ['--filter', GEN_APP, 'add', 'ms@2.1.3']],
        ['pnpm remove', ['--filter', GEN_APP, 'remove', 'ms']],
        ['pnpm update', ['--filter', GEN_APP, 'update', 'zod']],
    ])
    for (const [what, args] of steps) {
        run('pnpm', [...args], { cwd: GEN })
        const doctor = run('pnpm', ['exec', 'sssb', 'doctor', '--app', path.join('apps', GEN_APP)], {
            cwd: GEN,
            env: generatedEnv(),
            capture: true,
            allowFailure: true,
        })
        if (doctor.status !== 0) fail(`after ${what}, sssb doctor fails:\n${doctor.stdout}${doctor.stderr}`)
        checkSeamLinks(readFileSync(path.join(GEN, 'pnpm-lock.yaml'), 'utf8'), [GEN_APP])
        console.log(`after ${what}: sssb doctor passes, and the lockfile links the seam`)
    }
}

/** @param {string} note */
function notice(note) {
    console.log(process.env.GITHUB_ACTIONS ? `::notice title=pack and consume::${note}` : `NOTE: ${note}`)
}

// ---- the run --------------------------------------------------------------------------------------

const started = Date.now()
const port = await freePort()
// The consumer's contract suites' embedded Postgres: a free port, never the per-checkout one this repo's own uses.
const contractPort = await freePort()
const generatedPort = await freePort()
const generatedContractPort = await freePort()
console.log(
    `pack and consume (${[RUN_PAGES && 'pages', RUN_GENERATED && 'generated'].filter(Boolean).join(' and ')}): ${BASE}`,
)

/** The PACKED manifest, as the consumer installs it. @type {{ name?: string, exports: Record<string, string>, dependencies?: Record<string, string>, peerDependencies?: Record<string, string>, peerDependenciesMeta?: Record<string, unknown> }} */
let KIT_MANIFEST = { exports: {} }
/** The tarball of every @sssb package a workspace installs, by package name. @type {Record<string, string>} */
const tarballs = {}
/** The packed @sssb/kit's release stamp (`dist/release.json`), null when it has none. @type {string | null} */
let KIT_STAMP = null
/**
 * Packs one workspace package into TARBALLS, beside the others, and returns the tarball's path.
 * @param {string} dir repo-relative package directory
 * @param {Record<string, string>} [env] added to this process's environment for the pack
 */
function pack(dir, env = {}) {
    const before = new Set(readdirSync(TARBALLS))
    run('pnpm', ['pack', '--pack-destination', TARBALLS], {
        cwd: path.join(REPO, dir),
        env: { ...process.env, ...env },
    })
    const packed = readdirSync(TARBALLS).filter((name) => name.endsWith('.tgz') && !before.has(name))
    if (packed.length !== 1) fail(`${dir}: expected one new tarball, found ${packed.join(', ') || 'none'}`)
    return path.join(TARBALLS, /** @type {string} */ (packed[0]))
}
/** @param {string} file */
const packedManifest = (file) =>
    JSON.parse(run('tar', ['-xzOf', file, 'package/package.json'], { cwd: BASE, capture: true }).stdout)
/** @param {string} file */
const packedFiles = (file) =>
    run('tar', ['-tzf', file], { cwd: BASE, capture: true })
        .stdout.split('\n')
        .filter(Boolean)
        .map((entry) => entry.replace(/^package\//, ''))

step('pack every @sssb package, and extract @sssb/create', () => {
    rmSync(TARBALLS, { recursive: true, force: true })
    mkdirSync(TARBALLS, { recursive: true })
    // Its prepack stamps the commit it is packed from (dist/release.json, ADR-0014 P13) and refuses shipped sources
    // that differ from it, under the generator's switch (createPackEnv): the stamp and the generator's pin are one commit.
    const kit = pack('packages/kit', createPackEnv(process.env))
    tarballs['@sssb/kit'] = kit
    KIT_STAMP = packedFiles(kit).includes('dist/release.json')
        ? run('tar', ['-xzOf', kit, 'package/dist/release.json'], { cwd: BASE, capture: true }).stdout
        : null
    const manifest = packedManifest(kit)
    KIT_MANIFEST = manifest
    PACKED_VERSION = String(manifest.version)
    const problems = seamPeerProblems(manifest)
    if (problems.length > 0) fail(`the packed manifest breaks the seam pin:\n  ${problems.join('\n  ')}`)
    console.log(
        `${path.basename(kit)}: ${Math.round(statSync(kit).size / 1024)} KB; the seam is an optional peer in peerDependenciesMeta only`,
    )

    // @sssb/tools: JavaScript Node loads directly, with no dependency on any SSSB package (ADR-0014 rule 4, part 2).
    const tools = pack('packages/tools')
    tarballs['@sssb/tools'] = tools
    const files = packedFiles(tools)
    const toolsProblems = [...toolsManifestProblems(packedManifest(tools)), ...toolsShippedFileProblems(files)]
    if (toolsProblems.length > 0)
        fail(`the packed @sssb/tools is not what it must be:\n  ${toolsProblems.join('\n  ')}`)
    console.log(
        `${path.basename(tools)}: ${files.length} files, ${Math.round(statSync(tools).size / 1024)} KB; JavaScript and declarations only, no SSSB dependency`,
    )

    // @sssb/eslint-plugin: JavaScript ESLint loads directly, with no dependency on any SSSB package, and ESLint a peer.
    const plugin = pack('packages/eslint-plugin')
    tarballs['@sssb/eslint-plugin'] = plugin
    const pluginFiles = packedFiles(plugin)
    const pluginProblems = [
        ...pluginManifestProblems(packedManifest(plugin)),
        ...pluginShippedFileProblems(pluginFiles),
    ]
    if (pluginProblems.length > 0)
        fail(`the packed @sssb/eslint-plugin is not what it must be:\n  ${pluginProblems.join('\n  ')}`)
    console.log(
        `${path.basename(plugin)}: ${pluginFiles.length} files, ${Math.round(statSync(plugin).size / 1024)} KB; JavaScript and declarations only, no SSSB dependency`,
    )

    // @sssb/cdk: each generated app's infra/ takes it, and each app's synth runs it. Its packed shape is checked here.
    const cdk = pack('packages/cdk')
    tarballs['@sssb/cdk'] = cdk
    const cdkFiles = packedFiles(cdk)
    const cdkProblems = cdkPackProblems(packedManifest(cdk), cdkFiles)
    if (cdkProblems.length > 0) fail(`the packed @sssb/cdk is not what it must be:\n  ${cdkProblems.join('\n  ')}`)
    console.log(
        `${path.basename(cdk)}: ${cdkFiles.length} files, ${Math.round(statSync(cdk).size / 1024)} KB; JavaScript and declarations, no dependency on the framework`,
    )

    // @sssb/create: the generator, with the template its prepack built from this checkout packed into it, and no
    // dependency at all. Its postpack removes the template from the working tree again. Its prepack refuses a pin
    // GitHub does not hold, and a template that is not the pinned commit's, but on a push to SSSB's own repository
    // (createPackEnv): only there are the tarballs a release candidate may attach.
    const create = pack('packages/create', createPackEnv(process.env))
    const createFiles = packedFiles(create)
    // The template's app, file for file, is what git tracks under apps/starter: an allowlist, so no local state of
    // this checkout (whatever its name) and no missing file reaches an adopter.
    const tracked = run('git', ['ls-files', '-z', '--', 'apps/starter'], { cwd: REPO, env: process.env, capture: true })
        .stdout.split('\0')
        .filter(Boolean)
        .map((file) => file.slice('apps/starter/'.length))
    if (tracked.length === 0) fail('git tracks no file under apps/starter: the template has nothing to compare with')
    const createProblems = [
        ...createPackageProblems(packedManifest(create), createFiles),
        ...templateAppProblems(createFiles, tracked),
    ]
    if (createProblems.length > 0)
        fail(`the packed @sssb/create is not what it must be:\n  ${createProblems.join('\n  ')}`)
    if (existsSync(path.join(REPO, 'packages/create/template')))
        fail("@sssb/create's postpack left packages/create/template in the working tree")
    rmSync(CREATE, { recursive: true, force: true })
    mkdirSync(CREATE, { recursive: true })
    run('tar', ['-xzf', create, '-C', CREATE], { cwd: BASE })
    console.log(
        `${path.basename(create)}: ${createFiles.length} files, ${Math.round(statSync(create).size / 1024)} KB, its template among them; no dependencies; extracted to ${path.relative(BASE, CREATE)}/`,
    )

    // EVERY released package, here, at PR time: a release candidate attaches one tarball per `@sssb/*` package, flat
    // as TARBALLS holds them, and refuses to go on without one, after its tag exists (release.mjs `candidate`). So a
    // package added to packages/ fails this job until it is packed (and its shape checked) above.
    const packed = new Set([...Object.keys(tarballs), '@sssb/create'])
    // One version for the set (the fixed group), which the seed's version token stands for.
    const versions = [...Object.values(tarballs), create].map(
        (file) => `${path.basename(file)}: ${packedManifest(file).version}`,
    )
    const strays = versions.filter((entry) => !entry.endsWith(`: ${PACKED_VERSION}`))
    if (strays.length > 0) fail(`the packed set is not at one version (${PACKED_VERSION}):\n  ${strays.join('\n  ')}`)
    const released = readdirSync(path.join(REPO, 'packages'), { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && existsSync(path.join(REPO, 'packages', entry.name, 'package.json')))
        .map((entry) => readJson(path.join(REPO, 'packages', entry.name, 'package.json')).name)
        .filter((name) => typeof name === 'string' && name.startsWith('@sssb/'))
    const unpacked = released.filter((name) => !packed.has(name))
    if (unpacked.length > 0) {
        fail(
            `packages/ holds ${unpacked.join(', ')}, which this step does not pack; a release candidate needs every one`,
        )
    }
})

if (RUN_PAGES) {
    step('pages: generate the workspace (two apps) and shape it', scaffold)
    step('pages: install the tarballs', () => {
        run('pnpm', ['install', '--no-frozen-lockfile'], { cwd: WS })
        const lock = path.join(WS, 'pnpm-lock.yaml')
        const lockText = checkInstalledTarballs(WS)
        const seed = seedOf(lockText)
        if (UPDATE_LOCKFILE) {
            writeFileSync(LOCK_SEED, seed)
            console.log(`wrote the resolution back to ${path.relative(REPO, LOCK_SEED)}: commit it`)
            return
        }
        // Anything else that moved means the seed is behind this repo's ranges or the framework's
        // dependencies. Not a failure (a Dependabot PR cannot refresh the seed), a prompt.
        const { added, removed } = lockfileMoves(seedText(), readFileSync(lock, 'utf8'))
        if (added + removed > 0) {
            notice(
                `the consumer's resolution moved from its seed (${added} lines added, ${removed} removed): refresh it with \`pnpm pack-and-consume --update-lockfile\` and commit scripts/pack-and-consume/consumer-lock.yaml`,
            )
        }
    })
    step('pages: layout: seam links, one instance per app', checkLayout)
    step('pages: the packed package ships and imports only what it declares', checkDeclaredImports)
    step('pages: typecheck at the ES2022 floor', typecheck)
    step('pages: typecheck with the strict-flag set', typecheckStrict)
    step('pages: unit tests and the conformance suite, from the workspace root', unitTests)
    step('pages: contract tests on embedded Postgres, from the workspace root', contractTests)
    step('pages: migrator bundles, with no alias and no tsconfig', migratorBundles)
    step('pages: sssb doctor and sssb check-e2e, in each app', doctorAndCheckE2e)
    step('pages: Playwright loads every console spec (--list: no server, no browser)', playwrightLoadsSpecs)
    step('pages: negative fixture: an importer with no seam, which sssb doctor names', negativeFixture)
    step('pages: the compiled e2e entry loads under plain Node, with no seam', e2eEntryUnderNode)
    step('pages: the dev:real preflight, through esbuild from each app', realEnvPreflight)
    step('pages: lint from the workspace root and from each app, and sssb check-fences', lint)
    if (SKIP_BUILD_AND_E2E) {
        console.log('\n--skip-build-and-e2e: next build, e2e and the static demo were NOT run')
    } else {
        step('pages: next build (console)', nextBuild)
        step('pages: e2e (console)', () => e2e(port))
        step('pages: static demo: build, size, e2e (console)', staticDemo)
    }
}

if (RUN_GENERATED) {
    step('generated: run the packed generator', generateWorkspace)
    step('generated: install the tarballs', installGenerated)
    step(`generated: pnpm verify${SKIP_BUILD_AND_E2E ? ' (without e2e and the static demo)' : ''}`, verifyGenerated)
    step('generated: the unit tests, held to every conformance test, through each script that runs them', unitGenerated)
    step('generated: pnpm test:contract, on embedded Postgres', contractGenerated)
    step('generated: sssb ci lint-typecheck-unit (the reusable workflow’s job)', () =>
        run('pnpm', ['exec', 'sssb', 'ci', 'lint-typecheck-unit'], { cwd: GEN }),
    )
    // As CI runs them, in both modes: verify naming them is not verify running them (OWN_STEP_GATES).
    step('generated: sssb ci synth (the reusable workflow’s job, offline)', synthGenerated)
    step('generated: pnpm knip (the workspace’s own job)', () => run('pnpm', ['knip'], { cwd: GEN }))
    step('generated: pnpm jscpd (the workspace’s own job)', () => run('pnpm', ['jscpd'], { cwd: GEN }))
    step('generated: the workflow and plugin pins are the kit’s release commit, and the plugin is there', pinsGenerated)
    step('generated: every file the generator wrote is unchanged', generatedUntouched)
    step('generated: pnpm add, remove and update keep the seam linked (sssb doctor)', partialInstallsKeepSeam)
}

const stale = unusedWorkarounds()
if (stale.length > 0) fail(`registered workarounds no site applies (remove them): ${stale.join(', ')}`)

const total = Math.round((Date.now() - started) / 1000)
const workarounds = Object.entries(WORKAROUNDS)
const summary = [
    `## pack and consume: ${[RUN_PAGES && 'the pages shape', RUN_GENERATED && 'the generated shape'].filter(Boolean).join(' and ')}`,
    '',
    `Green in ${total}s${SKIP_BUILD_AND_E2E ? ' (build and e2e SKIPPED)' : ''}.`,
    '',
    '| step | seconds |',
    '| --- | --- |',
    ...timings.map((t) => `| ${t.step} | ${t.seconds} |`),
    '',
    "### Workarounds (today's gaps, each removed by a later step of ADR-0014)",
    '',
    ...(workarounds.length === 0
        ? ['None.']
        : [
              '| id | removed by | what |',
              '| --- | --- | --- |',
              ...workarounds.map(([id, w]) => `| \`${id}\` | ${w.removedBy} | ${w.what} |`),
          ]),
    '',
].join('\n')
console.log(`\n${summary}`)
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary)
