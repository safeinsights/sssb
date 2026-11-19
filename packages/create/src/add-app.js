// @ts-check
// AN APP ADDED TO AN EXISTING WORKSPACE: `sssb add-app <slug>`, @sssb/tools' command, imports this module from the
// @sssb/create the workspace installs (`@sssb/create/add-app`), so the template and the renames stay the generator's
// alone. The app is the template's, written as `generate` writes a new workspace's first app (generate.js' writeApp):
// under apps/<slug>/, renamed where its identity lives, with a port slot of its own, and taking each @sssb package as an
// app already in the workspace takes it. The workspace around it (its `sssb.apps`) is the command's to change.
import { randomBytes } from 'node:crypto'
import { existsSync, lstatSync, mkdirSync, readFileSync, renameSync, rmdirSync, rmSync } from 'node:fs'
import path from 'node:path'
import { checkSlug, CreateError, displayName, titleCase } from './args.js'
import { checkPackageNames, SSSB_PACKAGES, writeApp } from './generate.js'
import { holdSignals, releaseSignals } from './signals.js'
import { filesUnder, readTemplate } from './template.js'

export { checkSlug, CreateError }

/**
 * @typedef {{
 *   templateDir: string,
 *   root: string,
 *   slug: string,
 *   name?: string | null,
 *   port: { name: string, default: number },
 *   like: string,
 * }} AddAppOptions `root`: the workspace's root; `like`: an app of the workspace (absolute), whose manifests (its
 *   package.json, and its infra/'s when it has one) say how the new app's take each @sssb package; `port`: the new
 *   app's own slot, which the caller has checked against the workspace's other apps
 */

/** @param {string} file */
const readJson = (file) => JSON.parse(readFileSync(file, 'utf8'))

/**
 * A dependency's specifier as a manifest in `toDir` must write it to name what it names from `fromDir`: a relative
 * `file:` or `link:` path rebased, anything else (a range, a URL, an absolute path, `workspace:`) as it is.
 * @param {string} spec
 * @param {string} fromDir
 * @param {string} toDir
 */
export function rebaseSpec(spec, fromDir, toDir) {
    const match = /^(file:|link:)(.+)$/.exec(spec)
    if (!match?.[1] || !match[2] || path.isAbsolute(match[2])) return spec
    const relative = path.relative(toDir, path.resolve(fromDir, match[2])).split(path.sep).join('/')
    return `${match[1]}${relative.startsWith('.') ? relative : `./${relative}`}`
}

/**
 * Each @sssb package a manifest takes (the seam's alias aside), by its full name.
 * @param {string} file
 * @returns {{ dir: string, specs: Record<string, string>, eslint: string | undefined }}
 */
function takes(file) {
    const manifest = readJson(file)
    /** @type {Record<string, string>} */
    const specs = {}
    for (const field of ['dependencies', 'devDependencies', 'peerDependencies']) {
        for (const [name, spec] of Object.entries(manifest[field] ?? {})) {
            if (name.startsWith('@sssb/') && typeof spec === 'string' && !(name in specs)) specs[name] = spec
        }
    }
    const eslint = manifest.devDependencies?.eslint ?? manifest.dependencies?.eslint
    return { dir: path.dirname(file), specs, eslint: typeof eslint === 'string' ? eslint : undefined }
}

/**
 * Writes the template's app into the workspace at `root`, as apps/<slug>/. All or nothing: the app is written into a
 * stage beside it (`apps/.sssb-add-app-<hex>/`) and renamed into place, and a failure or a SIGINT, SIGTERM or SIGHUP
 * part-way leaves nothing behind. Refuses a slug the generator refuses, and an apps/<slug> that exists.
 * @param {AddAppOptions} options
 * @returns {{ appDir: string, name: string, files: string[], notes: string[] }} `files` relative to `root`; `notes`,
 *   what the caller should tell the person (a package no app of the workspace takes, written at the template's range)
 */
export function addApp({ templateDir, root, slug, name = null, port, like }) {
    checkSlug(slug)
    const display = displayName(name ?? titleCase(slug))
    const meta = readTemplate(templateDir)
    checkPackageNames(slug, meta)
    const appsDir = path.join(root, 'apps')
    const appDir = path.join(appsDir, slug)
    if (lstatSync(appDir, { throwIfNoEntry: false })) throw new CreateError(`${appDir} already exists`)

    const appTakes = takes(path.join(like, 'package.json'))
    const likeInfra = path.join(like, 'infra', 'package.json')
    const infraTakes = existsSync(likeInfra) ? takes(likeInfra) : appTakes
    /** @type {string[]} */
    const notes = []
    /** @type {import('./generate.js').AppContext['spec']} */
    const spec = (pkg, manifest) => {
        if (!SSSB_PACKAGES.includes(pkg))
            throw new CreateError(`the template depends on @sssb/${pkg}, an unknown package`)
        const toDir = manifest === 'infra' ? path.join(appDir, 'infra') : appDir
        // The manifest's own counterpart first, then the other one: a workspace whose deployment is not inside its app
        // (Pages' infra/ at the root) still names @sssb/cdk somewhere.
        for (const source of manifest === 'infra' ? [infraTakes, appTakes] : [appTakes, infraTakes]) {
            const found = source.specs[`@sssb/${pkg}`]
            if (found) return rebaseSpec(found, source.dir, toDir)
        }
        const range = `^${meta.version}`
        notes.push(
            `${path.relative(root, path.join(toDir, 'package.json'))} takes @sssb/${pkg} at ${range}: ` +
                `${path.relative(root, like)} names no @sssb/${pkg} to copy. Write it as your workspace takes SSSB's packages`,
        )
        return range
    }
    const eslint = appTakes.eslint ?? /** @type {string} */ (meta.ranges['eslint'])

    const made = { apps: /** @type {string | undefined} */ (undefined), stage: '' }
    const undo = () => {
        if (made.stage) rmSync(made.stage, { recursive: true, force: true })
        if (made.apps) {
            try {
                rmdirSync(made.apps)
            } catch {
                // not empty, or gone: leave it
            }
        }
    }
    holdSignals(undo)
    try {
        made.apps = mkdirSync(appsDir, { recursive: true })
        made.stage = path.join(appsDir, `.sssb-add-app-${randomBytes(4).toString('hex')}`)
        writeApp(made.stage, { slug, name: display, meta, spec, eslint, port }, templateDir)
        if (lstatSync(appDir, { throwIfNoEntry: false }))
            throw new CreateError(`${appDir} appeared while the app was written`)
        renameSync(made.stage, appDir)
        made.stage = ''
        made.apps = undefined
        const files = filesUnder(appDir).map((file) => path.relative(root, path.join(appDir, file)))
        return { appDir, name: display, files, notes }
    } catch (error) {
        undo()
        const err = /** @type {NodeJS.ErrnoException} */ (error)
        if (!(error instanceof CreateError) && typeof err?.code === 'string' && typeof err.syscall === 'string')
            throw new CreateError(`could not write the app: ${err.message}`)
        throw error
    } finally {
        releaseSignals(undo)
    }
}
