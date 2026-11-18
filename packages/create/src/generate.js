// @ts-check
// GENERATION: a new app workspace from a built template (template.js), into a directory that does not exist or is
// empty. The app is the template's (SSSB's starter) under apps/<slug>/, renamed where its identity lives; the
// workspace around it is written by files.js. Nothing in the output names SSSB's repository, its other app, its
// framework package's path or its maintainers, which tests/tooling/create-generate.test.ts greps for.
import { createHash, randomBytes } from 'node:crypto'
import {
    cpSync,
    existsSync,
    lstatSync,
    mkdirSync,
    readdirSync,
    readFileSync,
    renameSync,
    rmdirSync,
    rmSync,
    statSync,
    writeFileSync,
} from 'node:fs'
import path from 'node:path'
import { columns, CreateError, displayName } from './args.js'
import * as files from './files.js'
import { formatJson, packageJson } from './json.js'
import { holdSignals, releaseSignals } from './signals.js'
import { filesUnder, fromStored, GUIDE_FILE, readTemplate } from './template.js'

/** The @sssb packages the workspace installs (the seam, @sssb/app-config, is the app's own and never installed). */
const SSSB_PACKAGES = ['kit', 'tools', 'eslint-plugin', 'cdk']

const SEAM = '@sssb/app-config'

/**
 * A TypeScript string literal quoted the way Prettier would quote it (single quotes unless the value has more of
 * them than of double quotes), so a display name with an apostrophe does not fail the first `pnpm lint`.
 * @param {string} value
 */
function tsString(value) {
    const singles = (value.match(/'/g) ?? []).length
    const doubles = (value.match(/"/g) ?? []).length
    return singles > doubles
        ? `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
        : `'${value.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`
}

/** @param {string} value */
const htmlText = (value) => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

/**
 * `--sssb`: a directory of packed tarballs, or a version (range) for every @sssb package.
 * @param {string | null} sssb
 * @param {string} version the generator's own, the fixed group's
 * @returns {{ spec: (pkg: string) => string, tarballs: Record<string, string> | null }}
 */
function resolveSssb(sssb, version) {
    if (sssb === null) return { spec: () => `^${version}`, tarballs: null }
    const dir = path.resolve(sssb)
    if (existsSync(dir) && statSync(dir).isDirectory()) {
        const names = readdirSync(dir)
        /** @type {Record<string, string>} */
        const tarballs = {}
        /** @type {Map<string, string[]>} */
        const versions = new Map()
        for (const pkg of SSSB_PACKAGES) {
            const found = names.filter((name) => new RegExp(`^sssb-${pkg}-\\d[^/]*\\.tgz$`).test(name))
            if (found.length !== 1) {
                throw new CreateError(
                    `--sssb ${sssb}: expected one sssb-${pkg}-<version>.tgz there, found ${found.join(', ') || 'none'}`,
                )
            }
            const file = /** @type {string} */ (found[0])
            tarballs[pkg] = path.join(dir, file)
            const version = file.slice(`sssb-${pkg}-`.length, -'.tgz'.length)
            versions.set(version, [...(versions.get(version) ?? []), `@sssb/${pkg}`])
        }
        // The @sssb packages are one fixed group, released together at one version (ADR-0014 part 7): tarballs of two
        // versions are two releases mixed, which no published install could ever be.
        if (versions.size > 1) {
            throw new CreateError(
                `--sssb ${sssb}: the tarballs are of different versions (${[...versions]
                    .map(([version, pkgs]) => `${pkgs.join(', ')} ${version}`)
                    .join('; ')}); the @sssb packages are released together at one version`,
            )
        }
        checkVersion(sssb, /** @type {string} */ ([...versions.keys()][0]), version)
        return { spec: (pkg) => `file:${tarballs[pkg]}`, tarballs }
    }
    if (!/^[\^~]?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(sssb))
        throw new CreateError(`--sssb ${sssb} is neither a directory of tarballs nor a version`)
    checkVersion(sssb, sssb.replace(/^[\^~]/, ''), version)
    return { spec: () => sssb, tarballs: null }
}

/**
 * The @sssb packages a workspace installs must be the generator's own version: the workspace's copy of the app guide
 * (.claude/sssb-guide.md) is stamped with the hash of the guide packed into the generator, and `sssb doctor` fails on
 * the first `pnpm verify` when the installed @sssb/kit's guide differs.
 * @param {string} sssb the flag's value
 * @param {string} given the version it names
 * @param {string} version the generator's
 */
function checkVersion(sssb, given, version) {
    if (given !== version) {
        throw new CreateError(
            `--sssb ${sssb} is @sssb ${given}, and this generator writes workspaces of @sssb ${version} (its copy of ` +
                `the app guide is ${version}'s): run @sssb/create@${given} instead`,
        )
    }
}

/**
 * @param {string} file
 * @param {string} from
 * @param {string} to
 */
function replaceOnce(file, from, to) {
    const text = readFileSync(file, 'utf8')
    const count = text.split(from).length - 1
    if (count !== 1)
        throw new CreateError(
            `the template's ${path.basename(file)}: expected ${JSON.stringify(from)} once, found ${count}`,
        )
    writeFileSync(
        file,
        text.replace(from, () => to),
    )
}

/** @param {string} file */
const readJson = (file) => JSON.parse(readFileSync(file, 'utf8'))

/**
 * Every @sssb dependency of a manifest, rewritten to what this workspace installs.
 * @param {Record<string, Record<string, string>>} manifest
 * @param {(pkg: string) => string} spec
 */
function pinSssb(manifest, spec) {
    for (const field of ['dependencies', 'devDependencies']) {
        const deps = manifest[field]
        if (!deps) continue
        for (const name of Object.keys(deps)) {
            if (!name.startsWith('@sssb/') || name === SEAM) continue
            const pkg = name.slice('@sssb/'.length)
            if (!SSSB_PACKAGES.includes(pkg))
                throw new CreateError(`the template depends on ${name}, an unknown package`)
            deps[name] = spec(pkg)
        }
    }
}

/**
 * @param {Record<string, string>} deps
 * @returns {Record<string, string>}
 */
const sorted = (deps) => Object.fromEntries(Object.entries(deps).sort(([a], [b]) => a.localeCompare(b)))

/**
 * The seam package's exports: every specifier the framework imports from `@sssb/app-config` resolves to a module of
 * the app's. The flat modules by one pattern (`./*` to `./*.ts`), so a seam module the framework adds later is
 * covered when the app writes it; a directory module (`db/migrations`) by name.
 * @param {string} seamDir
 * @param {string[]} specifiers
 */
function seamExports(seamDir, specifiers) {
    /** @type {Record<string, string>} */
    const exportsMap = {}
    let flat = false
    for (const specifier of specifiers) {
        if (!specifier.startsWith(`${SEAM}/`)) throw new CreateError(`${specifier} is not a seam specifier`)
        const sub = specifier.slice(SEAM.length + 1)
        if (existsSync(path.join(seamDir, `${sub}.ts`))) flat = true
        else if (existsSync(path.join(seamDir, sub, 'index.ts'))) exportsMap[`./${sub}`] = `./${sub}/index.ts`
        else throw new CreateError(`the template's seam has no module for ${specifier}`)
    }
    if (flat) exportsMap['./*'] = './*.ts'
    return exportsMap
}

/**
 * @typedef {{
 *   templateDir: string,
 *   target: string,
 *   slug: string,
 *   name: string,
 *   repo?: string | null,
 *   owners?: string[],
 *   sssb?: string | null,
 *   workflowRef?: string | null,
 * }} GenerateOptions
 */

/**
 * A filesystem failure (no permission, no space, a name that cannot be made) as a CreateError, for the person at the
 * terminal; anything else, a bug, as it is.
 * @param {unknown} error
 */
function asCreateError(error) {
    if (error instanceof CreateError) return error
    const err = /** @type {NodeJS.ErrnoException} */ (error)
    if (typeof err?.code === 'string' && typeof err.syscall === 'string')
        return new CreateError(`could not write the workspace: ${err.message}`)
    return error
}

/**
 * The slug names the app's packages; refused when one of those names is a package the workspace installs (the
 * template's `dependencyNames`, from pack and consume's lockfile seed), which pnpm would then mistake for the app (an
 * app named `ws` was handed the `ws` package's optional peers).
 * @param {string} slug
 * @param {import('./template.js').TemplateMeta} meta
 */
function checkPackageNames(slug, meta) {
    const names = new Set(meta.dependencyNames)
    for (const pkg of [slug, `${slug}-infra`, `${slug}-workspace`]) {
        if (names.has(pkg)) {
            throw new CreateError(
                `the slug "${slug}" would name a package "${pkg}", which is also a dependency the workspace installs ` +
                    `(npm's ${pkg}): pnpm mistakes one for the other. Pass another --slug`,
            )
        }
    }
}

/**
 * What a directory may hold and still count as empty, each left untouched: a repository's `.git` (`git init`, or
 * `gh repo clone` of a new repository), the Finder's `.DS_Store` (which it may also write while the workspace is), and a
 * filesystem root's `lost+found`. The workspace writes none of them.
 */
const LEFT_ALONE = new Set(['.git', '.DS_Store', 'lost+found'])

/**
 * A directory's entries but those LEFT_ALONE and `also`.
 * @param {string} dir
 * @param {string} [also]
 */
const occupants = (dir, also) => readdirSync(dir).filter((entry) => !LEFT_ALONE.has(entry) && entry !== also)

/**
 * Writes a new workspace. Refuses a target that exists and is not an empty directory (LEFT_ALONE's entries aside), or
 * is a symlink. An existing target is never removed or replaced (it may be the shell's working directory, a mount
 * point, or in a directory this user cannot write; its mode, owner and ACLs are the user's): the workspace is written
 * into a stage INSIDE it, `<target>/.sssb-create-<hex>/`, whose entries are moved up into the target at the end. A
 * failure part-way, or a SIGINT, SIGTERM or SIGHUP (signals.js), leaves nothing behind: the stage and whatever was
 * moved up are removed, and the target and its parents too when this run created them (and they are empty).
 * @param {GenerateOptions} options
 * @returns {{ root: string, appDir: string, files: string[], workflowRef: string, tarballs: Record<string, string> | null }}
 */
export function generate({
    templateDir,
    target,
    slug,
    name,
    repo = null,
    owners = [],
    sssb = null,
    workflowRef = null,
}) {
    const meta = readTemplate(templateDir)
    const root = path.resolve(target)
    const ref = workflowRef ?? meta.workflow.ref
    if (!/^[0-9a-f]{40}$/.test(ref)) throw new CreateError(`the workflow ref "${ref}" is not a full commit SHA`)
    checkPackageNames(slug, meta)
    const { spec, tarballs } = resolveSssb(sssb, meta.version)
    /** @type {import('./files.js').Context} */
    const c = { slug, name: displayName(name), repo, owners, meta, sssbSpec: spec, tarballs, workflowRef: ref }

    /** What this run made: the first directory it created on the way to the target (maybe the target), the stage. */
    const made = {
        created: /** @type {string | undefined} */ (undefined),
        stage: '',
        moved: /** @type {string[]} */ ([]),
    }
    // Only what this run made goes: the stage, the entries it moved up, then each directory it created, while empty.
    const undo = () => {
        if (made.stage) rmSync(made.stage, { recursive: true, force: true })
        for (const entry of made.moved.splice(0)) rmSync(path.join(root, entry), { recursive: true, force: true })
        for (let dir = root; made.created; dir = path.dirname(dir)) {
            try {
                rmdirSync(dir)
            } catch {
                break
            }
            if (dir === made.created) break
        }
    }
    holdSignals(undo)
    try {
        const existing = lstatSync(root, { throwIfNoEntry: false })
        if (existing?.isSymbolicLink())
            throw new CreateError(`${root} is a symbolic link: name a new directory, or an empty one`)
        if (existing && (!existing.isDirectory() || occupants(root).length > 0))
            throw new CreateError(`${root} already exists and is not an empty directory: name a new one`)
        if (!existing) {
            made.created = mkdirSync(path.dirname(root), { recursive: true })
            mkdirSync(root)
            made.created ??= root
        }
        const stageName = `.sssb-create-${randomBytes(4).toString('hex')}`
        made.stage = path.join(root, stageName)
        mkdirSync(made.stage)
        const files = writeWorkspace(made.stage, c, templateDir)
        const arrived = occupants(root, stageName)
        if (arrived.length > 0)
            throw new CreateError(
                `${root} gained ${arrived.join(', ')} while the workspace was written: name a new one`,
            )
        for (const entry of readdirSync(made.stage)) {
            // Never over one of LEFT_ALONE's (a rename replaces a file), and so never undoing it.
            if (lstatSync(path.join(root, entry), { throwIfNoEntry: false }))
                throw new CreateError(`${root} already holds ${entry}, which the workspace would replace`)
            renameSync(path.join(made.stage, entry), path.join(root, entry))
            made.moved.push(entry)
        }
        rmdirSync(made.stage)
        made.stage = ''
        return { root, appDir: path.join(root, 'apps', slug), files, workflowRef: ref, tarballs }
    } catch (error) {
        undo()
        throw asCreateError(error)
    } finally {
        releaseSignals(undo)
    }
}

/**
 * The workspace's files, written under `root`.
 * @param {string} root
 * @param {import('./files.js').Context} c
 * @param {string} templateDir
 * @returns {string[]} the files written, relative to `root`
 */
function writeWorkspace(root, c, templateDir) {
    const { slug, name, meta, sssbSpec: spec } = c
    const appDir = path.join(root, 'apps', slug)
    const inApp = (/** @type {string} */ relative) => path.join(appDir, relative)

    // The template, copied: the app, and the generic workspace files.
    for (const [from, to] of /** @type {const} */ ([
        ['app', appDir],
        ['root', root],
    ])) {
        for (const stored of filesUnder(path.join(templateDir, from))) {
            const file = path.join(to, fromStored(stored))
            mkdirSync(path.dirname(file), { recursive: true })
            cpSync(path.join(templateDir, from, stored), file)
        }
    }

    // THE APP'S IDENTITY: its slug (config/app.ts, which everything mechanical derives from), its package names, and
    // its display name in its catalogs and titles. Each edit must find what it replaces exactly once, so a template
    // that moved its identity elsewhere fails here instead of shipping half-renamed.
    const slugLine = /export const APP_SLUG = '([^']+)'/.exec(readFileSync(inApp('config/app.ts'), 'utf8'))
    if (!slugLine?.[1]) throw new CreateError("the template's config/app.ts declares no APP_SLUG")
    const oldSlug = slugLine[1]
    const oldName = readJson(inApp('messages/en.json'))?.welcome?.appName
    if (typeof oldName !== 'string') throw new CreateError("the template's messages/en.json has no welcome.appName")
    replaceOnce(inApp('config/app.ts'), `export const APP_SLUG = '${oldSlug}'`, `export const APP_SLUG = '${slug}'`)
    replaceOnce(inApp('config/app.ts'), `\`${oldSlug}_session\``, `\`${slug}_session\``)
    for (const locale of ['en', 'es']) {
        for (const key of ['appName', 'title'])
            replaceOnce(
                inApp(`messages/${locale}.json`),
                `"${key}": ${JSON.stringify(oldName)}`,
                `"${key}": ${JSON.stringify(name)}`,
            )
    }
    replaceOnce(inApp('src/app/[locale]/layout.tsx'), `title: ${tsString(oldName)}`, `title: ${tsString(name)}`)
    replaceOnce(inApp('src/demo-static/index.html'), `<title>${oldName} `, `<title>${htmlText(name)} `)
    // Prettier wraps an HTML line past the print width, so the title line must fit (displayName caps the name; `&`
    // grows as it is escaped).
    const titleLine = readFileSync(inApp('src/demo-static/index.html'), 'utf8')
        .split('\n')
        .find((line) => line.includes('<title>'))
    if (titleLine && columns(titleLine) > 120)
        throw new CreateError(`--name "${name}" is too long for the static demo's <title> line: shorten it`)

    // The app's manifest: its name, the @sssb packages it installs, the seam linked as a package of the app's own
    // (ADR-0014 part 1), and the lint fences' plugin and ESLint beside it. No `license`: the packages are private, and
    // which licence the workspace takes (a LICENSE at its root) is the adopter's to choose, not the starter's to claim.
    const manifest = readJson(inApp('package.json'))
    manifest.name = slug
    delete manifest.license
    manifest.description = `${name}: the app.`
    pinSssb(manifest, spec)
    manifest.dependencies = sorted({ ...manifest.dependencies, [SEAM]: 'link:./src/app-config' })
    manifest.devDependencies = sorted({
        ...manifest.devDependencies,
        '@sssb/eslint-plugin': spec('eslint-plugin'),
        eslint: /** @type {string} */ (meta.ranges['eslint']),
    })
    writeFileSync(inApp('package.json'), packageJson(manifest))
    const budget = /sssb check-demo-size (\d+)/.exec(manifest.scripts?.['check:demo-size'] ?? '')?.[1]
    if (!budget) throw new CreateError("the template's package.json has no `sssb check-demo-size <bytes>` script")

    const infra = readJson(inApp('infra/package.json'))
    infra.name = `${slug}-infra`
    delete infra.license
    pinSssb(infra, spec)
    writeFileSync(inApp('infra/package.json'), packageJson(infra))

    // The seam package (ADR-0014 part 1, option C): `@sssb/app-config`, linked from the app's src/app-config, with an
    // export for every module the framework imports. It takes the app's module `type`, because a nested package.json
    // resets it for everything below it.
    const seamDir = inApp('src/app-config')
    /** @type {Record<string, unknown>} */
    const seam = { name: SEAM, private: true }
    if (manifest.type) seam['type'] = manifest.type
    seam['exports'] = seamExports(seamDir, meta.seamSpecifiers)
    writeFileSync(path.join(seamDir, 'package.json'), packageJson(seam))

    // The app's tsconfig, on @sssb/tools' base: in SSSB's repository the starter's also sends @sssb/kit and the seam to
    // source and compiles the framework's own tree (it is the framework's falsifier there). Here resolution goes
    // through the installed packages and the seam link, so only the app's own `@/` alias stays.
    const tsconfig = readJson(inApp('tsconfig.json'))
    if (tsconfig.extends !== '@sssb/tools/tsconfig.base.json')
        throw new CreateError(`the template's tsconfig.json extends ${tsconfig.extends}, not @sssb/tools' base`)
    const own = (/** @type {string} */ entry) => !entry.startsWith('../')
    tsconfig.compilerOptions.paths = { '@/*': tsconfig.compilerOptions.paths['@/*'] }
    tsconfig.include = tsconfig.include.filter(own)
    tsconfig.exclude = tsconfig.exclude.filter(own)
    writeFileSync(inApp('tsconfig.json'), formatJson(tsconfig))

    writeFileSync(inApp('eslint.config.mjs'), files.APP_ESLINT)
    writeFileSync(inApp('DEMO-SIZE.md'), files.demoSizeMd(Number(budget)))

    // The workspace around it.
    /** @type {Record<string, string>} */
    const written = {
        'package.json': files.rootPackageJson(c),
        'pnpm-workspace.yaml': files.pnpmWorkspace(c),
        '.gitignore': files.GITIGNORE,
        '.prettierignore': files.PRETTIERIGNORE,
        'lint-staged.config.mjs': files.LINT_STAGED,
        'eslint.config.mjs': files.ROOT_ESLINT,
        'tsconfig.json': files.ROOT_TSCONFIG,
        'vitest.config.ts': files.vitestConfig(c),
        'vitest.contract.config.ts': files.vitestContractConfig(c),
        'knip.json': files.knipJson(c),
        '.jscpd.json': files.JSCPD,
        '.gitleaks.toml': files.GITLEAKS,
        CODEOWNERS: files.codeowners(c),
        'SECURITY.md': files.securityMd(c),
        'CODE_OF_CONDUCT.md': files.codeOfConduct(c),
        'README.md': files.readme(c),
        'CLAUDE.md': files.CLAUDE_MD,
        '.claude/settings.json': files.claudeSettings(c),
        'docs/cutover-checklist.md': files.cutoverChecklist(c),
        '.github/workflows/checks.yml': files.workflow(c),
        '.github/ISSUE_TEMPLATE/config.yml': files.issueConfig(c),
        '.github/ISSUE_TEMPLATE/bug_report.yml': files.BUG_REPORT,
    }
    // The app guide's stamped copy, as `sssb guide` writes it (@sssb/tools' guide.js; the generator depends on no SSSB
    // package): `sssb doctor` fails a workspace without it, and fails it again once an upgrade's guide differs.
    const guide = readFileSync(path.join(templateDir, GUIDE_FILE))
    written['.claude/sssb-guide.md'] =
        `<!-- sssb-guide sha256:${createHash('sha256').update(guide).digest('hex')} (copied from @sssb/kit ` +
        `${meta.version} by \`sssb guide\`: edit nothing here; rerun it after an upgrade and review the diff) -->\n\n` +
        guide.toString('utf8')
    for (const [relative, text] of Object.entries(written)) {
        const file = path.join(root, relative)
        mkdirSync(path.dirname(file), { recursive: true })
        writeFileSync(file, text)
    }

    const all = filesUnder(root)
    // Nothing may still point at a workspace package this workspace does not have.
    for (const file of all.filter((f) => path.basename(f) === 'package.json')) {
        if (readFileSync(path.join(root, file), 'utf8').includes('"workspace:'))
            throw new CreateError(`${file} still depends on a package by workspace: protocol`)
    }
    return all
}
