// PACK AND CONSUME (ADR-0014 part 7, rule 5, step P2): proves the framework the way an adopter gets
// it. Packs @sssb/kit, builds an adopter-shaped pnpm workspace OUTSIDE this repository from copies of
// apps/starter, installs the TARBALL there (never `workspace:`), and runs that workspace's verify.
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
//   packages/gate  a sibling package that does not use the framework at all.
//   packages/seamless  the NEGATIVE fixture: it takes @sssb/kit without linking a seam, and must fail
//                  loudly rather than run on another app's seam (ADR-0014 part 5).
//
// Today's gaps between that and what an adopter should need are named workarounds
// (scripts/pack-and-consume/workarounds.mjs), each tied to the step that removes it.
//
// The workspace is left in place after a run, so a failure can be inspected; the next run wipes it.

import { spawnSync } from 'node:child_process'
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
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
    CONFORMANCE_SUITES,
    STRICT_FLAGS,
    conformanceProblems,
    lockfileProblems,
    seamPeerProblems,
    tscErrors,
} from './pack-and-consume/checks.mjs'
import { WORKAROUNDS, unusedWorkarounds, applyWorkaround } from './pack-and-consume/workarounds.mjs'

const REPO = path.resolve(import.meta.dirname, '..')

/**
 * Errors inside @sssb/kit's own source under the strict-flag set, per app, measured from the tarball.
 * The workaround `strict-flags-kit-baseline` (removed by P3, which makes the framework compile under the
 * set): a count above this fails, and so does a count below it, so the number is lowered as P3's work
 * lands instead of leaving room for new errors.
 */
const STRICT_KIT_ERROR_BASELINE = 116

// ---- arguments ------------------------------------------------------------------------------------

const args = process.argv.slice(2)
const dirArg = args.indexOf('--dir')
// realpath: on macOS os.tmpdir() is under /var, a symlink to /private/var, and a workspace whose module
// graph resolves under two spellings loads two copies of `next/headers` (the adoption probe's lesson).
const BASE = path.resolve(dirArg >= 0 ? args[dirArg + 1] : path.join(realpathSync(tmpdir()), 'sssb-pack-and-consume'))
const SKIP_BUILD_AND_E2E = args.includes('--skip-build-and-e2e')
const WS = path.join(BASE, 'workspace')
const TARBALLS = path.join(BASE, 'tarballs')
const REPORTS = path.join(BASE, 'reports')

if (BASE === REPO || BASE.startsWith(REPO + path.sep)) {
    fail(`--dir must be outside this repository (${REPO}): inside it, pnpm would find SSSB's workspace`)
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
 * @param {{ cwd: string, env?: Record<string, string>, capture?: boolean, allowFailure?: boolean }} options
 */
function run(command, commandArgs, { cwd, env, capture = false, allowFailure = false }) {
    console.log(`\n$ (${path.relative(BASE, cwd) || '.'}) ${command} ${commandArgs.join(' ')}`)
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

/** Directories of a copied app that are build output or local state, never source. */
const NOT_SOURCE = new Set([
    'node_modules',
    '.next',
    'dist-demo',
    'playwright-report',
    'test-results',
    '.data',
    'tsconfig.tsbuildinfo',
    'next-env.d.ts',
])

/**
 * One app, copied from apps/starter and turned into what an adopter's app looks like: the framework from
 * the tarball, the seam as a linked package, and no alias, path or include that reaches into this repo.
 * @param {{ app: string, slug: string, tarball: string }} options
 */
function scaffoldApp({ app, slug, tarball }) {
    const dir = path.join(WS, 'apps', app)
    cpSync(path.join(REPO, 'apps/starter'), dir, {
        recursive: true,
        filter: (source) => !NOT_SOURCE.has(path.basename(source)),
    })

    // The manifest: the framework from the tarball, the seam as a link to the app's own src/app-config.
    const manifest = readJson(path.join(dir, 'package.json'))
    manifest.name = app
    manifest.dependencies['@sssb/kit'] = `file:${path.relative(dir, tarball)}`
    manifest.dependencies['@sssb/app-config'] = 'link:./src/app-config'
    applyWorkaround('types-pg')
    manifest.devDependencies['@types/pg'] = rangeOf('@types/pg')
    writeJson(path.join(dir, 'package.json'), manifest)

    // The seam package (ADR-0014 part 1, option C). Its exports cover every seam module the framework
    // imports: the flat `.ts` modules by pattern, the one directory module by name. The app's own module
    // `type` is copied in, because a nested package.json resets it for everything below.
    /** @type {Record<string, unknown>} */
    const seam = {
        name: '@sssb/app-config',
        private: true,
        exports: { './db/migrations': './db/migrations/index.ts', './*': './*.ts' },
    }
    if (manifest.type) seam.type = manifest.type
    writeJson(path.join(dir, 'src/app-config/package.json'), seam)

    // A tsconfig of the app's own, at part 2's floor (ES2022 target and lib), with no `paths` but the
    // app's `@/` and nothing included from outside the app. The starter's extends this repo's root and
    // includes packages/kit/src, which is exactly what a consumer cannot do.
    writeJson(path.join(dir, 'tsconfig.json'), {
        compilerOptions: {
            target: 'ES2022',
            lib: ['dom', 'dom.iterable', 'es2022'],
            allowJs: true,
            skipLibCheck: true,
            strict: true,
            noEmit: true,
            esModuleInterop: true,
            module: 'esnext',
            moduleResolution: 'bundler',
            resolveJsonModule: true,
            isolatedModules: true,
            jsx: 'react-jsx',
            plugins: [{ name: 'next' }],
            paths: { '@/*': ['./src/*'] },
        },
        include: [
            'next-env.d.ts',
            'src/**/*.ts',
            'src/**/*.tsx',
            'tests/**/*.ts',
            '.next/types/**/*.ts',
            '.next/dev/types/**/*.ts',
            '*.ts',
            'config/**/*.ts',
        ],
        exclude: ['node_modules'],
    })
    writeJson(path.join(dir, 'tsconfig.strict.json'), {
        extends: './tsconfig.json',
        compilerOptions: Object.fromEntries(STRICT_FLAGS.map((flag) => [flag, true])),
    })

    applyWorkaround('next-intl-request-path')
    replaceOnce(
        path.join(dir, 'next.config.ts'),
        "createNextIntlPlugin('../../packages/kit/src/i18n/request.ts')",
        "createNextIntlPlugin('./node_modules/@sssb/kit/src/i18n/request.ts')",
    )

    // The static demo resolves the framework and the seam like every other tool: through the package and
    // its link. Only the app's own `@` alias stays.
    const vite = path.join(dir, 'vite.demo.config.ts')
    replaceOnce(vite, "            '@sssb/app-config': path.resolve(__dirname, 'src/app-config'),\n", '')
    replaceOnce(vite, "            '@sssb/kit': path.resolve(__dirname, '../../packages/kit/src'),\n", '')

    replaceOnce(
        path.join(dir, 'config/app.ts'),
        "export const APP_SLUG = 'starter'",
        `export const APP_SLUG = '${slug}'`,
    )

    // The real-Postgres contract test runs through this repo's tests/support harness, which no package
    // ships yet. It is not part of this job's verify (CI's contract job runs it for both apps in-repo).
    applyWorkaround('contract-test-dropped')
    rmSync(path.join(dir, 'tests/contract'), { recursive: true })

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
function scaffold(/** @type {string} */ tarball) {
    rmSync(WS, { recursive: true, force: true })
    mkdirSync(WS, { recursive: true })

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

    // allowBuilds as this repo grants them; the rest is what an adopter's workspace sets (ADR-0014 part 5).
    applyWorkaround('allow-builds-copied')
    const repoWorkspace = readFileSync(path.join(REPO, 'pnpm-workspace.yaml'), 'utf8')
    const allowBuilds = /^allowBuilds:\n((?:[ #].*\n|\n)*?)(?=^\S)/m.exec(repoWorkspace)?.[0]
    if (!allowBuilds) fail("could not read allowBuilds from this repo's pnpm-workspace.yaml")
    write(
        path.join(WS, 'pnpm-workspace.yaml'),
        `packages:
    - apps/*
    - packages/*

${allowBuilds}
# Each importer of @sssb/kit gets an instance of its own, with its own seam, or none (ADR-0014 part 5).
dedupePeerDependents: false
`,
    )
    // Every @sssb package is routed to an address nothing listens on, so an install that asked the
    // registry for one, the seam above all, fails instead of passing on whatever the registry answered.
    write(path.join(WS, '.npmrc'), '@sssb:registry=http://127.0.0.1:9/\n')

    applyWorkaround('vitest-setup-copied')
    write(path.join(WS, 'vitest.setup.ts'), "import '@testing-library/jest-dom/vitest'\n")

    // The repo-relative helpers the starter still imports, copied to the same relative places.
    applyWorkaround('prune-plugin-copied')
    cpSync(path.join(REPO, 'scripts/vite-prune-mantine-css.ts'), path.join(WS, 'scripts/vite-prune-mantine-css.ts'))
    applyWorkaround('ports-copied')
    cpSync(path.join(REPO, 'scripts/ports.mjs'), path.join(WS, 'scripts/ports.mjs'))
    cpSync(path.join(REPO, 'scripts/print-port.mjs'), path.join(WS, 'scripts/print-port.mjs'))
    applyWorkaround('check-demo-size-copied')
    cpSync(path.join(REPO, 'scripts/check-demo-size.mjs'), path.join(WS, 'scripts/check-demo-size.mjs'))
    applyWorkaround('tmp-dir-helper-copied')
    cpSync(path.join(REPO, 'tests/support/tmp-dir.ts'), path.join(WS, 'tests/support/tmp-dir.ts'))
    cpSync(path.join(REPO, 'tests/support/tmp-dir-marker.mjs'), path.join(WS, 'tests/support/tmp-dir-marker.mjs'))

    shapeConsole(scaffoldApp({ app: 'console', slug: 'console', tarball }))
    shapeLedger(scaffoldApp({ app: 'ledger', slug: 'ledger', tarball }))

    // A sibling package that does not use the framework (Pages' packages/gate).
    writeJson(path.join(WS, 'packages/gate/package.json'), {
        name: 'gate',
        private: true,
        type: 'module',
        scripts: { typecheck: 'tsc --noEmit' },
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
        `import { expect, test } from 'vitest'
import { allow } from './index'

test('the gate keeps private paths out', () => {
    expect(allow('/public/a')).toBe(true)
    expect(allow('/private/a')).toBe(false)
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

    // Vitest from the workspace root, as Pages runs it: a project per app, each with only its own `@`
    // alias, and nothing pointing the seam anywhere.
    applyWorkaround('conformance-by-include')
    write(
        path.join(WS, 'vitest.config.ts'),
        `import { fileURLToPath } from 'node:url'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vitest/config'

const at = (relative: string) => fileURLToPath(new URL(relative, import.meta.url))

// The framework's seam-conformance suites, run from each app's own copy of the package. Vitest's default
// exclude drops node_modules, so each app project sets its own (ADR-0014 part 3; P5 replaces this).
const CONFORMANCE = ${JSON.stringify(CONFORMANCE_SUITES.map((suite) => `node_modules/@sssb/kit/${suite}`))}

const app = (name: string) => ({
    plugins: [react()],
    resolve: { alias: { '@': at(\`./apps/\${name}/src\`) } },
    test: {
        name,
        root: at(\`./apps/\${name}\`),
        environment: 'happy-dom',
        include: ['src/**/*.test.{ts,tsx}', ...CONFORMANCE],
        exclude: ['**/.next/**', '**/dist-demo/**', 'node_modules/@sssb/kit/node_modules/**'],
        setupFiles: [at('./vitest.setup.ts')],
        testTimeout: 20_000,
    },
})

export default defineConfig({
    test: {
        projects: [app('console'), app('ledger'), { test: { name: 'gate', root: at('./packages/gate'), environment: 'node' } }],
    },
})
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
        if (kit.includes(`${path.sep}apps${path.sep}`) && !kit.includes(`node_modules${path.sep}.pnpm`)) {
            fail(`${app}'s @sssb/kit is not an installed package: ${kit}`)
        }
        kits.set(app, kit)
    }
    if (kits.get('console') === kits.get('ledger'))
        fail("both apps resolve ONE @sssb/kit instance, so one of them runs on the other's seam")
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

function typecheckStrict() {
    applyWorkaround('strict-flags-kit-baseline')
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
            `${app}: strict flags (${STRICT_FLAGS.join(', ')}): ${appErrors.length} error(s) in the app, ${kitErrors.length} in @sssb/kit (baseline ${STRICT_KIT_ERROR_BASELINE})`,
        )
        if (result.status !== 0 && errors.length === 0) {
            console.error(result.stdout + result.stderr)
            fail(`${app}: the strict typecheck failed without reporting an error this script can read`)
        }
        if (appErrors.length > 0) {
            console.error(appErrors.map((e) => e.text).join('\n'))
            fail(`${app}: the app's own code fails the strict-flag set`)
        }
        if (kitErrors.length > STRICT_KIT_ERROR_BASELINE) {
            console.error(kitErrors.map((e) => e.text).join('\n'))
            fail(
                `${app}: @sssb/kit has ${kitErrors.length} strict-flag errors, above the baseline of ${STRICT_KIT_ERROR_BASELINE}`,
            )
        }
        if (kitErrors.length < STRICT_KIT_ERROR_BASELINE) {
            fail(
                `${app}: @sssb/kit has ${kitErrors.length} strict-flag errors, BELOW the baseline of ${STRICT_KIT_ERROR_BASELINE}: lower STRICT_KIT_ERROR_BASELINE in scripts/pack-and-consume.mjs`,
            )
        }
    }
}

function unitTests() {
    applyWorkaround('demo-presets-seam-skipped')
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
    const problems = conformanceProblems(readJson(report), kitDirs)
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
    run('pnpm', ['exec', 'playwright', 'install', 'chromium'], { cwd: appDir('console') })
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
step('pack @sssb/kit', () => {
    rmSync(TARBALLS, { recursive: true, force: true })
    mkdirSync(TARBALLS, { recursive: true })
    run('pnpm', ['pack', '--pack-destination', TARBALLS], { cwd: path.join(REPO, 'packages/kit'), env: process.env })
    const packed = readdirSync(TARBALLS).filter((name) => name.endsWith('.tgz'))
    if (packed.length !== 1) fail(`expected one tarball, found ${packed.join(', ') || 'none'}`)
    tarball = path.join(TARBALLS, packed[0])
    const manifest = JSON.parse(
        run('tar', ['-xzOf', tarball, 'package/package.json'], { cwd: BASE, capture: true }).stdout,
    )
    const problems = seamPeerProblems(manifest)
    if (problems.length > 0) fail(`the packed manifest breaks the seam pin:\n  ${problems.join('\n  ')}`)
    console.log(
        `${packed[0]}: ${Math.round(statSync(tarball).size / 1024)} KB; the seam is an optional peer in peerDependenciesMeta only`,
    )
})
step('scaffold the consumer workspace', () => scaffold(tarball))
step('install the tarball', () => run('pnpm', ['install', '--no-frozen-lockfile'], { cwd: WS }))
step('layout: lockfile, seam links, one instance per app', checkLayout)
step('typecheck at the ES2022 floor', typecheck)
step('typecheck with the strict-flag set', typecheckStrict)
step('unit tests and seam conformance, from the workspace root', unitTests)
step('migrator bundles, with no alias and no tsconfig', migratorBundles)
step('negative fixture: an importer with no seam', negativeFixture)
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
