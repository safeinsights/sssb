// @ts-check
// GENERATION: a new app workspace from a built template (template.js), into a directory that does not exist or is
// empty. The app is the template's (SSSB's starter) under apps/<slug>/, renamed where its identity lives; the
// workspace around it is written by files.js. Nothing in the output names SSSB's repository, its other app, its
// framework package's path or its maintainers, which tests/tooling/create-generate.test.ts greps for.
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { CreateError } from './args.js'
import * as files from './files.js'
import { formatJson, packageJson } from './json.js'
import { filesUnder, fromStored, readTemplate } from './template.js'

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
        for (const pkg of SSSB_PACKAGES) {
            const found = names.filter((name) => new RegExp(`^sssb-${pkg}-\\d[^/]*\\.tgz$`).test(name))
            if (found.length !== 1) {
                throw new CreateError(
                    `--sssb ${sssb}: expected one sssb-${pkg}-<version>.tgz there, found ${found.join(', ') || 'none'}`,
                )
            }
            tarballs[pkg] = path.join(dir, /** @type {string} */ (found[0]))
        }
        return { spec: (pkg) => `file:${tarballs[pkg]}`, tarballs }
    }
    if (!/^[\^~]?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(sssb))
        throw new CreateError(`--sssb ${sssb} is neither a directory of tarballs nor a version`)
    return { spec: () => sssb, tarballs: null }
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
 * Writes a new workspace. Refuses a target that exists and is not an empty directory.
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
    if (existsSync(root) && (!statSync(root).isDirectory() || readdirSync(root).length > 0))
        throw new CreateError(`${root} already exists and is not an empty directory: name a new one`)
    const ref = workflowRef ?? meta.workflow.ref
    if (!/^[0-9a-f]{40}$/.test(ref)) throw new CreateError(`the workflow ref "${ref}" is not a full commit SHA`)
    const { spec, tarballs } = resolveSssb(sssb, meta.version)

    /** @type {import('./files.js').Context} */
    const c = { slug, name, repo, owners, meta, sssbSpec: spec, tarballs, workflowRef: ref }
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

    // The app's manifest: its name, the @sssb packages it installs, the seam linked as a package of the app's own
    // (ADR-0014 part 1), and the lint fences' plugin and ESLint beside it.
    const manifest = readJson(inApp('package.json'))
    manifest.name = slug
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
        'docs/cutover-checklist.md': files.cutoverChecklist(c),
        '.github/workflows/checks.yml': files.workflow(c),
        '.github/ISSUE_TEMPLATE/config.yml': files.issueConfig(c),
        '.github/ISSUE_TEMPLATE/bug_report.yml': files.BUG_REPORT,
    }
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
    return { root, appDir, files: all, workflowRef: ref, tarballs }
}
