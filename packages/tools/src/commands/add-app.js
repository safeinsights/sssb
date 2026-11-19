// @ts-check
// `sssb add-app <slug> [--name "<Name>"] [--port <port>] [--slot <name>] [--create <dir>]`: a second app (or a third)
// in an existing workspace, written from SSSB's starter under apps/<slug>/ with the generator's renames, a port slot of
// its own, and each @sssb package taken as the workspace's first app takes it; then named in the root's `sssb.apps`,
// the one list of apps every SSSB tool reads. It prints what is left to the person (the root scripts and the CI
// workflow name one app on purpose), and `sssb doctor` names anything else.
//
// WHERE THE STARTER COMES FROM: the @sssb/create the workspace installs (`pnpm add -D -w @sssb/create@<version>`, at
// the @sssb packages' one version), which carries the starter as its packed template and the renames as its code
// (`@sssb/create/add-app`). Reached from the workspace root, as rule 4 reaches @sssb/kit from the app: no SSSB package
// depends on another (ADR-0014 part 10). `--create <dir>` names an unpacked @sssb/create instead.
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { readJson, takeOption, UsageError, workspaceApps, workspaceRootOf } from '../app.js'
import { parsePortDeclaration, portForRoot, readPortDeclaration } from '../ports.js'
import { workspacePackages } from './doctor-checks.js'

const USAGE = 'usage: sssb add-app <slug> [--name "<Name>"] [--port <port>] [--slot <name>] [--create <dir>]'

/**
 * `@sssb/create/add-app`'s `addApp`, as this command calls it (the generator is plain JavaScript with no types of its
 * own, and no SSSB package depends on another).
 * @typedef {(options: {
 *   templateDir: string,
 *   root: string,
 *   slug: string,
 *   name: string | null,
 *   port: { name: string, default: number },
 *   like: string,
 * }) => { appDir: string, name: string, files: string[], notes: string[] }} AddApp
 */

/** The first main-checkout port offered to a new app's slot, and the step between offers (3700, 3800, ...). */
const FIRST_DEFAULT = 3700
const DEFAULT_STEP = 100
const LAST_DEFAULT = 9900

/** @SSSB/tools' own version: the @sssb packages are one fixed group, released together at one version. */
const TOOLS_VERSION = readJson(path.resolve(import.meta.dirname, '..', '..', 'package.json')).version

/**
 * The @sssb/create to write the app with, checked: an unpacked package of that name, at @sssb/tools' version, holding
 * its packed template.
 * @param {string} root
 * @param {string | undefined} option `--create <dir>`
 * @returns {{ dir: string, templateDir: string, module: string }}
 */
export function createPackage(root, option) {
    const dir = option === undefined ? path.join(root, 'node_modules', '@sssb', 'create') : path.resolve(option)
    const manifestFile = path.join(dir, 'package.json')
    if (!existsSync(manifestFile)) {
        throw new UsageError(
            option === undefined
                ? `sssb add-app: the workspace does not install @sssb/create, whose packed template is the app it writes. ` +
                      `Install it at your SSSB version, then run this again:\n  pnpm add -D -w @sssb/create@${TOOLS_VERSION}`
                : `sssb add-app: --create ${option} is not a package (no package.json at ${dir})`,
        )
    }
    const manifest = readJson(manifestFile)
    if (manifest.name !== '@sssb/create')
        throw new UsageError(`sssb add-app: ${dir} holds ${manifest.name ?? 'an unnamed package'}, not @sssb/create`)
    if (manifest.version !== TOOLS_VERSION) {
        throw new UsageError(
            `sssb add-app: @sssb/create ${manifest.version} writes the starter of @sssb ${manifest.version}, and this ` +
                `@sssb/tools is ${TOOLS_VERSION}: the @sssb packages are released together, so install ` +
                `@sssb/create@${TOOLS_VERSION}`,
        )
    }
    const entry = manifest.exports?.['./add-app']
    if (typeof entry !== 'string')
        throw new UsageError(`sssb add-app: @sssb/create ${manifest.version} exports no ./add-app`)
    const templateDir = path.join(dir, 'template')
    if (!existsSync(path.join(templateDir, 'meta.json'))) {
        throw new UsageError(
            `sssb add-app: ${dir} holds no packed template (template/meta.json): only a packed @sssb/create carries ` +
                'the starter (a checkout of SSSB has none until `pnpm pack` builds it)',
        )
    }
    return { dir, templateDir, module: path.join(dir, entry) }
}

/**
 * The new app's port slot: `--slot` (else the slug) and `--port` (else the first of 3700, 3800, ... that no app of the
 * workspace binds in a main checkout and SSSB keeps for nothing of its own), checked as `sssb doctor` checks slots.
 * @param {{ root: string, apps: string[], slug: string, slot?: string, port?: string }} options `apps` absolute
 * @returns {{ name: string, default: number }}
 */
export function newPortSlot({ root, apps, slug, slot, port }) {
    const name = slot ?? slug
    /** @type {Map<string, string>} */
    const names = new Map()
    /** @type {Map<number, string>} */
    const defaults = new Map()
    for (const app of apps) {
        let declared
        try {
            declared = readPortDeclaration(app)
        } catch (error) {
            throw new UsageError(
                `sssb add-app: ${error instanceof Error ? error.message.replace(/^ports: /, '') : error}`,
            )
        }
        if (declared === undefined) continue
        const where = path.relative(root, app)
        names.set(typeof declared === 'string' ? declared : declared.name, where)
        defaults.set(portForRoot(path.sep, declared, {}), where)
    }
    const holder = names.get(name)
    if (holder !== undefined)
        throw new UsageError(`sssb add-app: ${holder} already declares the port slot "${name}": pass --slot <name>`)
    /**
     * @param {number} value
     * @returns {{ name: string, default: number } | UsageError}
     */
    const check = (value) => {
        try {
            return /** @type {{ name: string, default: number }} */ (parsePortDeclaration({ name, default: value }))
        } catch (error) {
            return new UsageError(
                `sssb add-app: ${error instanceof Error ? error.message.replace(/^ports: /, '') : String(error)}`,
            )
        }
    }
    if (port !== undefined) {
        const value = Number(port)
        const result = check(value)
        if (result instanceof UsageError) throw result
        if (defaults.has(value))
            throw new UsageError(`sssb add-app: ${defaults.get(value)} binds port ${value} in a main checkout already`)
        return result
    }
    /** @type {UsageError | undefined} */
    let first
    for (let value = FIRST_DEFAULT; value <= LAST_DEFAULT; value += DEFAULT_STEP) {
        if (defaults.has(value)) continue
        const result = check(value)
        if (!(result instanceof UsageError)) return result
        first ??= result
    }
    // Every offer refused: a name the slot cannot carry refuses them all, so the first refusal says why.
    throw new UsageError(
        `${first?.message ?? 'sssb add-app: no free default port from 3700 to 9900'} (pass --slot <name> or --port <port>)`,
    )
}

/**
 * The indent a JSON file is written with (its first indented line's), so the root package.json keeps its own.
 * @param {string} text
 */
const indentOf = (text) => /\n([ \t]+)"/.exec(text)?.[1] ?? '    '

/**
 * What is left to the person once the app is written: what the workspace names one app in by design (the root's
 * scripts, the CI workflow's synth) and what does not cover the new one.
 * @param {string} root
 * @param {{ slug: string, appDir: string, like: string }} added
 * @returns {string[]}
 */
export function leftToDo(root, { slug, appDir, like }) {
    /** @type {string[]} */
    const left = []
    const rel = (/** @type {string} */ dir) => path.relative(root, dir).split(path.sep).join('/')
    const packages = new Set(workspacePackages(root))
    const uncovered = [appDir, path.join(appDir, 'infra'), path.join(appDir, 'src', 'app-config')].filter(
        (dir) => existsSync(path.join(dir, 'package.json')) && !packages.has(dir),
    )
    if (uncovered.length > 0)
        left.push(`pnpm-workspace.yaml's packages do not cover ${uncovered.map(rel).join(', ')}: add globs that do`)

    const likeName = readJson(path.join(like, 'package.json')).name
    const scripts = /** @type {Record<string, string>} */ (readJson(path.join(root, 'package.json')).scripts ?? {})
    const naming = Object.entries(scripts)
        .filter(([, text]) => typeof text === 'string')
        .filter(
            ([, text]) =>
                new RegExp(`--filter[= ](['"]?)${likeName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\1(\\s|$)`).test(
                    text,
                ) || text.includes(`./${rel(like)}`),
        )
        .map(([script]) => script)
    if (naming.length > 0) {
        left.push(
            `the root's ${naming.join(', ')} script(s) run ${likeName} alone; add ones for ${slug} if you want them ` +
                `(say, "dev:${slug}": "pnpm --filter ${slug} dev")`,
        )
    }

    const workflows = path.join(root, '.github', 'workflows')
    if (existsSync(workflows)) {
        for (const file of readdirSync(workflows).filter((name) => /\.ya?ml$/.test(name))) {
            const text = readFileSync(path.join(workflows, file), 'utf8')
            const synth = /^\s*synth:\s*['"]?(\S+?)['"]?\s*(?:#.*)?$/m.exec(text)?.[1]
            if (synth && synth.includes(rel(like)) && !synth.includes('*')) {
                left.push(
                    `.github/workflows/${file} synthesizes ${synth} alone: make its \`synth\` a selector that takes ` +
                        `${rel(appDir)}/infra too (./apps/*/infra takes every app's)`,
                )
            }
        }
    }
    return left
}

/** @param {string[]} args */
export async function run(args) {
    const name = takeOption(args, '--name')
    const port = takeOption(args, '--port')
    const slot = takeOption(args, '--slot')
    const create = takeOption(args, '--create')
    const [slug, ...rest] = args
    if (slug === undefined || slug.startsWith('-') || rest.length > 0)
        throw new UsageError(
            `sssb add-app: ${slug === undefined ? 'name the app' : `unexpected ${rest[0] ?? slug}`}\n${USAGE}`,
        )

    const root = workspaceRootOf(process.cwd())
    const apps = workspaceApps(root).map((app) => path.join(root, app))
    const like = apps.find((app) => {
        const manifest = readJson(path.join(app, 'package.json'))
        return Boolean(manifest.dependencies?.['@sssb/kit'] ?? manifest.devDependencies?.['@sssb/kit'])
    })
    if (like === undefined) {
        throw new UsageError(
            `sssb add-app: ${root} has no app that takes @sssb/kit (\`sssb.apps\` in its package.json, or apps/<name>) ` +
                'to add one beside: a new workspace is `pnpm create @sssb <dir>`',
        )
    }
    const { templateDir, module } = createPackage(root, create)
    const generator = /** @type {{ addApp: AddApp, checkSlug: (slug: string) => void }} */ (
        await import(pathToFileURL(module).href)
    )
    /** @type {<T>(work: () => T) => T} the generator's refusals, as this command's */
    const asUsage = (work) => {
        try {
            return work()
        } catch (error) {
            if (error instanceof Error && error.name === 'CreateError')
                throw new UsageError(`sssb add-app: ${error.message}`)
            throw error
        }
    }
    asUsage(() => generator.checkSlug(slug))
    const appDir = path.join(root, 'apps', slug)
    const names = new Set(
        [root, ...workspacePackages(root)].flatMap((dir) => {
            const file = path.join(dir, 'package.json')
            return existsSync(file) ? [readJson(file).name] : []
        }),
    )
    for (const taken of [slug, `${slug}-infra`, `${slug}-app-config`]) {
        if (names.has(taken))
            throw new UsageError(`sssb add-app: the workspace already has a package named ${taken}: pick another slug`)
    }
    const portSlot = newPortSlot({ root, apps, slug, slot, port })
    const added = asUsage(() => generator.addApp({ templateDir, root, slug, name: name ?? null, port: portSlot, like }))

    // The one list of apps: named in `sssb.apps` when the root keeps one (else apps/* is the list, and holds it).
    const manifestFile = path.join(root, 'package.json')
    const text = readFileSync(manifestFile, 'utf8')
    const manifest = JSON.parse(text)
    const entry = path.relative(root, appDir).split(path.sep).join('/')
    const listed = manifest.sssb?.apps
    if (Array.isArray(listed) && !listed.includes(entry)) {
        manifest.sssb.apps = [...listed, entry]
        writeFileSync(manifestFile, `${JSON.stringify(manifest, null, indentOf(text))}\n`)
    }

    const left = [...added.notes, ...leftToDo(root, { slug, appDir, like })]
    console.log(`
Added ${added.name} in ${entry}/: ${added.files.length} files, from the starter of @sssb/create ${TOOLS_VERSION}.
Its port slot is "${portSlot.name}": port ${portSlot.default} in a main checkout, ${portSlot.name
        .toUpperCase()
        .replaceAll('-', '_')}_PORT overrides it.${Array.isArray(listed) ? ` The root's sssb.apps names it.` : ''}

Next:
  pnpm install
  pnpm exec sssb doctor        (it names anything else the workspace still needs for ${slug})
${left.length > 0 ? `\nLeft to you:\n${left.map((line) => `  - ${line}`).join('\n')}\n` : ''}`)
    return 0
}
