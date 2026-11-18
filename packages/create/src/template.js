// @ts-check
// THE TEMPLATE (ADR-0014 D4: the starter IS the template). One function builds it from SSSB's repository, and it is
// used twice: by the package's `prepack`, which writes `template/` into the tarball (never committed: no second copy of
// the starter lives in the repository), and by the repository's tests, which generate from the live tree without
// packing. So what the tests prove is what is packed.
//
//   template/meta.json   what the generator needs from the repository once it is no longer beside it: the version,
//                        the reusable workflow's repository and commit, the toolchain (packageManager, engines, the
//                        ranges of the tools the workspace installs), the build-script approvals, the seam's
//                        specifiers, the framework's cutover rows and the action pins its own workflow uses
//   template/app/        apps/starter, its infra/ included, as it is on disk (less build output and local state)
//   template/root/       the workspace-level files that are generic and copied as they are
//
// A leading `.` in a path segment is stored as `_dot_`, because npm's packing drops some dotfiles (`.gitignore`,
// `.npmrc`) and the template must not depend on which.
import { execFileSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { CreateError } from './args.js'

/** What a template directory holds, beside its files. */
export const META_FILE = 'meta.json'

/**
 * Never copied into the template, at any depth: dependencies, build and test output, local state and secrets (the
 * names this repository's .gitignore gives them). The template is copied from the working tree, not from git, so the
 * tests see the starter as it is on disk; this list is what keeps a developer's local files out of a packed template.
 */
export const EXCLUDED = new Set([
    'node_modules',
    '.next',
    '.data',
    'dist-demo',
    'test-results',
    'playwright-report',
    'coverage',
    'cdk.out',
    'out',
    'dist',
    'build',
    '.turbo',
    '.DS_Store',
    'next-env.d.ts',
    '.eslintcache',
])

/** @param {string} name */
const excluded = (name) =>
    EXCLUDED.has(name) || name.endsWith('.tsbuildinfo') || (name.startsWith('.env') && name !== '.env.example')

/**
 * The workspace-level files copied as they are: each is generic (it names nothing of this repository's), which the
 * generator's no-survivor test holds. Everything else at the workspace root is generated (files.js).
 */
export const ROOT_FILES = [
    '.editorconfig',
    '.nvmrc',
    '.prettierrc.json',
    '.husky/pre-commit',
    '.husky/commit-msg',
    'commitlint.config.mjs',
]

/**
 * The tools the workspace root installs, at this repository's ranges: what its scripts and root configs run (lint,
 * typecheck, the Vitest configs and coverage, knip, jscpd, the hooks), and esbuild and tsx, which the app's infra/
 * synth needs at the workspace root (`SssbApp` bundles the migrator with the root's esbuild; cdk.json runs tsx).
 */
const ROOT_DEV_DEPENDENCIES = [
    '@commitlint/cli',
    '@commitlint/config-conventional',
    '@eslint/js',
    '@testing-library/jest-dom',
    '@types/node',
    '@types/react',
    '@types/react-dom',
    '@vitest/coverage-v8',
    'concurrently',
    'esbuild',
    'eslint',
    'happy-dom',
    'husky',
    'jscpd',
    'knip',
    'lint-staged',
    'prettier',
    'tsx',
    'typescript',
    'typescript-eslint',
    'vitest',
]

/** The actions the generated workflow's own jobs use, pinned as SSSB's reusable workflow pins them. */
const ACTIONS = ['actions/checkout', 'pnpm/action-setup', 'actions/setup-node']

/**
 * @typedef {{
 *   version: string,
 *   workflow: { repository: string, ref: string },
 *   packageManager: string,
 *   engines: Record<string, string>,
 *   ranges: Record<string, string>,
 *   allowBuilds: string,
 *   minimumReleaseAge: number | null,
 *   seamSpecifiers: string[],
 *   cutoverRows: { id: string, what: string }[],
 *   actions: Record<string, string>,
 *   gitleaksVersion: string,
 * }} TemplateMeta
 */

/**
 * A path as the template stores it.
 * @param {string} relative
 */
const toStored = (relative) =>
    relative
        .split('/')
        .map((segment) => (segment.startsWith('.') ? `_dot_${segment.slice(1)}` : segment))
        .join('/')

/**
 * A stored path as the workspace gets it.
 * @param {string} stored
 */
export const fromStored = (stored) =>
    stored
        .split('/')
        .map((segment) => (segment.startsWith('_dot_') ? `.${segment.slice('_dot_'.length)}` : segment))
        .join('/')

/**
 * Every file under a directory, as `/`-separated paths relative to it, less the excluded names.
 * @param {string} dir
 * @param {(name: string) => boolean} [skip]
 * @returns {string[]}
 */
export function filesUnder(dir, skip = () => false) {
    /** @type {string[]} */
    const out = []
    /** @param {string} relative */
    const walk = (relative) => {
        for (const entry of readdirSync(path.join(dir, relative), { withFileTypes: true })) {
            if (skip(entry.name)) continue
            const child = relative ? `${relative}/${entry.name}` : entry.name
            if (entry.isDirectory()) walk(child)
            else if (entry.isFile()) out.push(child)
        }
    }
    walk('')
    return out.sort()
}

/** @param {string} file */
const readJson = (file) => JSON.parse(readFileSync(file, 'utf8'))

/**
 * The `owner/name` a package.json's `repository.url` names on GitHub.
 * @param {string} manifestFile
 */
function githubRepository(manifestFile) {
    const url = readJson(manifestFile)?.repository?.url
    const match = typeof url === 'string' ? /github\.com[/:]([^/]+\/[^/.]+)(?:\.git)?$/.exec(url) : null
    if (!match?.[1]) throw new CreateError(`${manifestFile}: its repository.url names no GitHub repository`)
    return match[1]
}

/**
 * The commit the template is built at, which must hold the reusable workflow it pins.
 * @param {string} repoRoot
 */
function workflowCommit(repoRoot) {
    /** @param {string[]} args */
    const git = (args) => execFileSync('git', args, { cwd: repoRoot, encoding: 'utf8' }).trim()
    const ref = git(['rev-parse', 'HEAD'])
    try {
        git(['cat-file', '-e', `${ref}:.github/workflows/app-checks.yml`])
    } catch {
        throw new CreateError(`commit ${ref} holds no .github/workflows/app-checks.yml, so it cannot be the pinned ref`)
    }
    return ref
}

/**
 * pnpm-workspace.yaml's `allowBuilds` block, comments and all, as the repository grants them.
 * @param {string} text
 */
function allowBuildsBlock(text) {
    const block = /^allowBuilds:\n((?:[ #].*\n|\n)*?)(?=^\S|(?![\s\S]))/m.exec(text)?.[0]
    if (!block) throw new CreateError("could not read allowBuilds from the repository's pnpm-workspace.yaml")
    return `${block.trimEnd()}\n`
}

/**
 * @param {string} workflow the text of a workflow
 * @returns {Record<string, string>} each action's `uses:` value, pin and version comment included
 */
function actionPins(workflow) {
    /** @type {Record<string, string>} */
    const pins = {}
    for (const action of ACTIONS) {
        const match = new RegExp(`uses: (${action.replace('/', '\\/')}@[0-9a-f]{40} # \\S+)`).exec(workflow)
        if (!match?.[1]) throw new CreateError(`app-checks.yml pins no ${action} by commit SHA`)
        pins[action] = match[1]
    }
    return pins
}

/**
 * Builds the template from SSSB's repository into `outDir`, which is replaced.
 * @param {{ repoRoot: string, outDir: string, workflowRef?: string }} options `workflowRef` instead of the
 *   repository's HEAD (which must hold the reusable workflow)
 * @returns {TemplateMeta}
 */
export function buildTemplate({ repoRoot, outDir, workflowRef }) {
    const at = (/** @type {string} */ relative) => path.join(repoRoot, relative)
    const starter = at('apps/starter')
    if (!existsSync(path.join(starter, 'package.json'))) throw new CreateError(`${starter} is not the starter app`)

    rmSync(outDir, { recursive: true, force: true })
    mkdirSync(outDir, { recursive: true })
    for (const file of filesUnder(starter, excluded)) {
        const target = path.join(outDir, 'app', toStored(file))
        mkdirSync(path.dirname(target), { recursive: true })
        cpSync(path.join(starter, file), target)
    }
    for (const file of ROOT_FILES) {
        const target = path.join(outDir, 'root', toStored(file))
        mkdirSync(path.dirname(target), { recursive: true })
        cpSync(at(file), target)
    }

    const root = readJson(at('package.json'))
    /** @type {Record<string, string>} */
    const ranges = {}
    for (const name of ROOT_DEV_DEPENDENCIES) {
        const range = root.devDependencies?.[name] ?? root.dependencies?.[name]
        if (typeof range !== 'string') throw new CreateError(`the repository's package.json has no range for ${name}`)
        ranges[name] = range
    }
    const workspace = readFileSync(at('pnpm-workspace.yaml'), 'utf8')
    const releaseAge = /^minimumReleaseAge:\s*(\d+)\s*$/m.exec(workspace)?.[1]
    const appChecks = readFileSync(at('.github/workflows/app-checks.yml'), 'utf8')
    const gitleaksVersion = /gitleaks\/releases\/download\/v(\d+\.\d+\.\d+)\//.exec(
        readFileSync(at('.github/workflows/checks.yml'), 'utf8'),
    )?.[1]
    if (!gitleaksVersion) throw new CreateError("could not read the gitleaks version from the repository's checks.yml")

    /** @type {TemplateMeta} */
    const meta = {
        version: readJson(at('packages/create/package.json')).version,
        workflow: {
            repository: githubRepository(at('packages/create/package.json')),
            ref: workflowRef ?? workflowCommit(repoRoot),
        },
        packageManager: root.packageManager,
        engines: root.engines,
        ranges,
        allowBuilds: allowBuildsBlock(workspace),
        minimumReleaseAge: releaseAge === undefined ? null : Number(releaseAge),
        seamSpecifiers: readJson(at('packages/kit/src/testing/seam-specifiers.json')).specifiers,
        cutoverRows: readJson(at('packages/kit/src/cutover/rows.json'))
            .rows.filter((/** @type {{ scope?: string }} */ row) => row.scope === undefined)
            .map((/** @type {{ id: string, what: string }} */ row) => ({ id: row.id, what: row.what })),
        actions: actionPins(appChecks),
        gitleaksVersion,
    }
    writeFileSync(path.join(outDir, META_FILE), `${JSON.stringify(meta, null, 4)}\n`)
    return meta
}

/**
 * A built template's meta, checked for the files the generator reads.
 * @param {string} templateDir
 * @returns {TemplateMeta}
 */
export function readTemplate(templateDir) {
    const file = path.join(templateDir, META_FILE)
    if (!existsSync(file)) throw new CreateError(`${templateDir} is not a built template (no ${META_FILE})`)
    for (const dir of ['app', 'root'])
        if (!existsSync(path.join(templateDir, dir))) throw new CreateError(`${templateDir} has no ${dir}/`)
    return readJson(file)
}
