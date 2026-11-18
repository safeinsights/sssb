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
//   template/app/        apps/starter, its infra/ included: the files git tracks there, as they are in the working tree
//   template/root/       the workspace-level files that are generic and copied as they are (tracked too)
//   template/guide.md    @sssb/kit's app guide, which the workspace carries a stamped copy of (`sssb guide`)
//
// TRACKED FILES ONLY (`git ls-files`), so nothing local reaches a packed template: not build output, and not a file
// nobody meant to share (an `.npmrc` with a token, a key, an editor's settings or swap file). A symlink is refused,
// not followed or dropped: what it points at is outside what git tracks. A checkout without git cannot build one.
//
// A leading `.` in a path segment is stored as `_dot_`, because npm's packing drops some dotfiles (`.gitignore`,
// `.npmrc`) and the template must not depend on which.
import { execFileSync } from 'node:child_process'
import { cpSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { CreateError } from './args.js'

/** The starter, the app the template is built from (ADR-0014 D4). */
const STARTER = 'apps/starter'

/**
 * Packing pins the reusable workflow at a commit GitHub must have, and the template must be that commit's. Set to `1`,
 * packing goes on with an unpushed commit or uncommitted template sources (with a warning): for a tarball that never
 * reaches GitHub's runners, as pack and consume's.
 */
export const UNPUSHED_PIN_ENV = 'SSSB_CREATE_UNPUSHED_PIN'

/**
 * git, in the repository, with its failure as a CreateError (no git, not a checkout, an unknown commit).
 * @param {string} repoRoot
 * @param {string[]} args
 */
function git(repoRoot, args) {
    try {
        return execFileSync('git', args, { cwd: repoRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
    } catch (error) {
        const err = /** @type {NodeJS.ErrnoException & { stderr?: string }} */ (error)
        const why = err.code === 'ENOENT' ? 'git is not installed' : (err.stderr ?? '').trim() || err.message
        throw new CreateError(`\`git ${args.join(' ')}\` failed in ${repoRoot}: ${why}`)
    }
}

/**
 * The files git tracks under each of `paths`, relative to the repository, refusing what the template cannot carry
 * faithfully: a symlink or submodule, an unmerged file, a tracked file missing from (or a symlink in) the working tree.
 * @param {string} repoRoot
 * @param {string[]} paths
 */
function trackedFiles(repoRoot, paths) {
    if (!existsSync(path.join(repoRoot, '.git')))
        throw new CreateError(`${repoRoot} is not a git checkout: the template is built from the files git tracks`)
    /** @type {Set<string>} */
    const files = new Set()
    /** @type {string[]} */
    const problems = []
    for (const entry of git(repoRoot, ['ls-files', '--stage', '-z', '--', ...paths]).split('\0')) {
        if (entry === '') continue
        const [info = '', file = ''] = entry.split('\t')
        const [mode, , stage] = info.split(' ')
        if (stage !== '0') problems.push(`${file} is unmerged`)
        else if (mode === '120000') problems.push(`${file} is a symlink`)
        else if (mode === '160000') problems.push(`${file} is a submodule`)
        else {
            const stat = lstatSync(path.join(repoRoot, file), { throwIfNoEntry: false })
            if (!stat) problems.push(`${file} is tracked but missing from the working tree`)
            else if (!stat.isFile()) problems.push(`${file} is not a regular file in the working tree`)
            else files.add(file)
        }
    }
    if (problems.length > 0)
        throw new CreateError(`the template cannot be built:\n  ${[...new Set(problems)].join('\n  ')}`)
    return [...files].sort()
}

/** What a template directory holds, beside its files. */
export const META_FILE = 'meta.json'
export const GUIDE_FILE = 'guide.md'

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
 *   allowBuilds: Record<string, boolean>,
 *   minimumReleaseAge: number | null,
 *   seamSpecifiers: string[],
 *   cutoverRows: { id: string, what: string }[],
 *   actions: Record<string, string>,
 *   gitleaksVersion: string,
 *   dependencyNames: string[],
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
 * Every file under a directory, as `/`-separated paths relative to it.
 * @param {string} dir
 * @returns {string[]}
 */
export function filesUnder(dir) {
    /** @type {string[]} */
    const out = []
    /** @param {string} relative */
    const walk = (relative) => {
        for (const entry of readdirSync(path.join(dir, relative), { withFileTypes: true })) {
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
    const ref = git(repoRoot, ['rev-parse', 'HEAD']).trim()
    try {
        git(repoRoot, ['cat-file', '-e', `${ref}:.github/workflows/app-checks.yml`])
    } catch {
        throw new CreateError(`commit ${ref} holds no .github/workflows/app-checks.yml, so it cannot be the pinned ref`)
    }
    return ref
}

/**
 * The `owner/name` path a remote's URL names, lowercased, or null for a URL that is not a network remote: scp-like
 * (`git@github.com:o/n.git`, or through an ssh host alias, `git@github-work:o/n.git`) or a URL with a scheme
 * (`https://github.com/o/n`, `ssh://git@ssh.github.com:443/o/n`). The host is not read: an ssh alias can be named
 * anything, so any remote at the path counts, a fork (another owner's path) never.
 * @param {string} url
 */
export function remotePath(url) {
    const match = /^[a-z][a-z0-9+.-]*:\/\/[^/]+\/(.+)$/i.exec(url) ?? /^(?:[^@/:]+@)?[^/:]+:(?!\/\/)(.+)$/.exec(url)
    return match?.[1]
        ? match[1]
              .replace(/\/+$/, '')
              .replace(/\.git$/i, '')
              .replace(/^\/+/, '')
              .toLowerCase()
        : null
}

/**
 * Why the pinned commit may not be on GitHub, or null when it is: a workspace pinned to a commit GitHub does not have
 * fails its first CI run (`uses:` cannot resolve). On GitHub means: contained in a remote-tracking branch of a remote
 * of this checkout whose path is `repository` (remotePath), as of the last fetch (no network).
 * @param {{ repoRoot: string, ref: string, repository: string }} options
 * @returns {string | null}
 */
export function unpushedPin({ repoRoot, ref, repository }) {
    /** @type {Set<string>} */
    const remotes = new Set()
    for (const line of git(repoRoot, ['remote', '-v']).split('\n')) {
        const [remote, url] = line.split(/\s+/)
        if (remote && remotePath(url ?? '') === repository.toLowerCase()) remotes.add(remote)
    }
    if (remotes.size === 0)
        return `no remote of this checkout is github.com/${repository}, so commit ${ref} cannot be shown to be there`
    let branches
    try {
        branches = git(repoRoot, ['branch', '--remotes', '--contains', ref, '--format=%(refname)']).split('\n')
    } catch {
        return `commit ${ref} is not in this checkout, so it cannot be shown to be on github.com/${repository}`
    }
    if (branches.some((branch) => [...remotes].some((remote) => branch.startsWith(`refs/remotes/${remote}/`))))
        return null
    return (
        `commit ${ref} is on no branch of ${[...remotes].join(', ')} (github.com/${repository}) as of the last ` +
        "fetch: a workspace pinned to it fails its first CI run, because GitHub cannot resolve the workflow's `uses:`"
    )
}

/** What the template copies from the working tree, which must be the pinned commit's at pack time. */
const TEMPLATE_SOURCES = [STARTER, 'packages/kit/src/guide.md']

/**
 * Why the template's sources may not be the commit it pins, or null when they are: the template is copied from the
 * working tree, but the pin (and the release it ships in) is HEAD, so a change not committed (staged or not), an
 * untracked file, or a deleted one under them makes a tarball whose template no commit holds.
 * @param {string} repoRoot
 * @returns {string | null}
 */
export function uncommittedSources(repoRoot) {
    const entries = git(repoRoot, [
        'status',
        '--porcelain=v1',
        '-z',
        '--untracked-files=all',
        '--',
        ...TEMPLATE_SOURCES,
    ])
        .split('\0')
        .filter(Boolean)
    // A rename's entry is followed by its old path, which has no status of its own.
    const changed = entries.filter((entry) => /^[ MADRCU?!]{2} /.test(entry)).map((entry) => entry.slice(3))
    return changed.length === 0
        ? null
        : `the template's sources differ from HEAD, which it pins (commit them, or remove what is untracked):\n  ${changed.join('\n  ')}`
}

/**
 * pnpm-workspace.yaml's `allowBuilds` approvals, as the repository grants them: each package's name and whether its
 * install script may run. The block's comments speak for this repository, so they stay here.
 * @param {string} text
 * @returns {Record<string, boolean>}
 */
function allowBuilds(text) {
    const block = /^allowBuilds:\n((?:[ #].*\n|\n)*?)(?=^\S|(?![\s\S]))/m.exec(text)?.[1]
    if (!block) throw new CreateError("could not read allowBuilds from the repository's pnpm-workspace.yaml")
    /** @type {Record<string, boolean>} */
    const approvals = {}
    for (const line of block.split('\n')) {
        if (line.trim() === '' || line.trim().startsWith('#')) continue
        const entry = /^ +'?(@?[a-z0-9][a-z0-9._/-]*)'?: (true|false)$/.exec(line)
        if (!entry?.[1])
            throw new CreateError(`pnpm-workspace.yaml's allowBuilds has an entry this cannot read: ${line}`)
        approvals[entry[1]] = entry[2] === 'true'
    }
    return approvals
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
 * The resolution of a workspace shaped as the generator writes one: pack and consume's lockfile seed, which its
 * generated shape installs from (a superset of the generated workspace's: the seed also holds the pages shape's second
 * app and sibling package). Not this repository's own pnpm-lock.yaml, which holds this repository's own tooling too
 * (`events`, `history`, `open` and `cookies` among it), none of which a generated workspace installs.
 */
const WORKSPACE_LOCKFILE = 'scripts/pack-and-consume/consumer-lock.yaml'

/**
 * The unscoped names of every package a generated workspace installs (WORKSPACE_LOCKFILE): a slug that is one of them
 * would make the app's package share its name with a dependency, and pnpm then mistakes one for the other (it gave an
 * app named `ws` the `ws` package's optional peers). Scoped names cannot be a slug.
 * @param {string} lockfile the text of a pnpm lockfile
 */
function dependencyNames(lockfile) {
    const section = /^packages:\n([\s\S]*?)(?=^\S|(?![\s\S]))/m.exec(lockfile)?.[1]
    if (!section) throw new CreateError(`could not read the packages of the repository's ${WORKSPACE_LOCKFILE}`)
    /** @type {Set<string>} */
    const names = new Set()
    for (const match of section.matchAll(/^ {2}'?([a-z0-9][^@'\s/]*)@/gm)) if (match[1]) names.add(match[1])
    return [...names].sort()
}

/**
 * Builds the template from SSSB's repository into `outDir`, which is replaced.
 * @param {{ repoRoot: string, outDir: string, workflowRef?: string, warn?: (message: string) => void }} options
 *   `workflowRef` instead of the repository's HEAD (which must hold the reusable workflow); `warn` hears of the
 *   starter's untracked files, which are left out
 * @returns {TemplateMeta}
 */
export function buildTemplate(options) {
    try {
        return writeTemplate(options)
    } catch (error) {
        // A file the template reads that is not there, a directory it cannot write: a message, not a stack trace.
        const err = /** @type {NodeJS.ErrnoException} */ (error)
        if (error instanceof CreateError || typeof err?.code !== 'string' || typeof err.syscall !== 'string')
            throw error
        throw new CreateError(`could not build the template: ${err.message}`)
    }
}

/** @param {Parameters<typeof buildTemplate>[0]} options */
function writeTemplate({ repoRoot, outDir, workflowRef, warn = () => {} }) {
    const at = (/** @type {string} */ relative) => path.join(repoRoot, relative)
    const starter = at(STARTER)
    if (!existsSync(path.join(starter, 'package.json'))) throw new CreateError(`${starter} is not the starter app`)
    const tracked = trackedFiles(repoRoot, [STARTER, ...ROOT_FILES])
    const missing = ROOT_FILES.filter((file) => !tracked.includes(file))
    if (missing.length > 0) throw new CreateError(`the repository does not track ${missing.join(', ')}`)
    const untracked = git(repoRoot, ['ls-files', '--others', '--exclude-standard', '-z', '--', STARTER])
        .split('\0')
        .filter(Boolean)
    if (untracked.length > 0)
        warn(
            `left out of the template, because git does not track them (git add them to include them):\n  ${untracked.join('\n  ')}`,
        )

    rmSync(outDir, { recursive: true, force: true })
    mkdirSync(outDir, { recursive: true })
    for (const file of tracked) {
        const target = file.startsWith(`${STARTER}/`)
            ? path.join(outDir, 'app', toStored(file.slice(STARTER.length + 1)))
            : path.join(outDir, 'root', toStored(file))
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
        allowBuilds: allowBuilds(workspace),
        minimumReleaseAge: releaseAge === undefined ? null : Number(releaseAge),
        seamSpecifiers: readJson(at('packages/kit/src/testing/seam-specifiers.json')).specifiers,
        cutoverRows: readJson(at('packages/kit/src/cutover/rows.json'))
            .rows.filter((/** @type {{ scope?: string }} */ row) => row.scope === undefined)
            .map((/** @type {{ id: string, what: string }} */ row) => ({ id: row.id, what: row.what })),
        actions: actionPins(appChecks),
        gitleaksVersion,
        dependencyNames: dependencyNames(readFileSync(at(WORKSPACE_LOCKFILE), 'utf8')),
    }
    // The app guide @sssb/kit ships (`@sssb/kit/guide.md`), which the workspace carries a stamped copy of (`sssb
    // guide`); `sssb doctor` fails a workspace without it. The kit is of the generator's version (one fixed group).
    cpSync(at('packages/kit/src/guide.md'), path.join(outDir, GUIDE_FILE))
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
    for (const part of ['app/', 'root/', GUIDE_FILE])
        if (!existsSync(path.join(templateDir, part))) throw new CreateError(`${templateDir} has no ${part}`)
    return readJson(file)
}
