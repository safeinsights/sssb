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
import { holdSignals, releaseSignals, signalsSettled } from './signals.js'
import { filesUnder, readTemplate } from './template.js'

export { checkSlug, CreateError, signalsSettled }

/**
 * @typedef {{
 *   templateDir: string,
 *   root: string,
 *   slug: string,
 *   name?: string | null,
 *   port: { name: string, default: number },
 *   like: string,
 *   others?: string[],
 *   finish?: (appDir: string) => (() => void),
 * }} AddAppOptions `root`: the workspace's root; `like`: an app of the workspace (absolute), whose manifests (its
 *   package.json, and its infra/'s when it has one) say how the new app's take each @sssb package, and `others`, more
 *   package directories to look in after it (a deployment outside the app); `port`: the new app's own slot, which the
 *   caller has checked against the workspace's other apps; `finish`: the caller's own change to the workspace, made
 *   under the same signal hold once the app is in place, returning how to undo it
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
 * Each @sssb package a manifest takes, by its full name (the seam's alias, `@sssb/app-config`, among them: no package
 * of SSSB's is named so, so nothing looks it up).
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
 * stage beside it (`apps/.sssb-add-app-<hex>/`) and renamed into place, then `finish` makes the caller's change; a
 * failure, or a SIGINT, SIGTERM or SIGHUP that comes while it runs (dispatched once it returns: the work is
 * synchronous), removes the app and undoes `finish`'s change. A caller that reports success awaits `signalsSettled()`
 * first. Refuses a slug the generator refuses, and an apps/<slug> that exists.
 * @param {AddAppOptions} options
 * @returns {{ appDir: string, name: string, files: string[], notes: string[] }} `files` relative to `root`; `notes`,
 *   what the caller should tell the person (a package no app of the workspace takes, written at the template's range)
 */
export function addApp({ templateDir, root, slug, name = null, port, like, others = [], finish }) {
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
    const otherTakes = others
        .map((dir) => path.join(dir, 'package.json'))
        .filter((file) => existsSync(file))
        .map(takes)
    /** @type {string[]} */
    const notes = []
    /** @type {import('./generate.js').AppContext['spec']} */
    const spec = (pkg, manifest) => {
        if (!SSSB_PACKAGES.includes(pkg))
            throw new CreateError(`the template depends on @sssb/${pkg}, an unknown package`)
        const toDir = manifest === 'infra' ? path.join(appDir, 'infra') : appDir
        // The manifest's own counterpart first, then the other one, then the caller's other packages: a workspace
        // whose deployment is not inside its app (an infra/ at the root) names @sssb/cdk there.
        const sources = manifest === 'infra' ? [infraTakes, appTakes] : [appTakes, infraTakes]
        for (const source of [...sources, ...otherTakes]) {
            const found = source.specs[`@sssb/${pkg}`]
            if (found) return rebaseSpec(found, source.dir, toDir)
        }
        const range = `^${meta.version}`
        notes.push(
            `${path.relative(root, path.join(toDir, 'package.json'))} takes @sssb/${pkg} at ${range}: ` +
                `no package of the workspace names @sssb/${pkg} to copy. Write it as your workspace takes SSSB's packages`,
        )
        return range
    }
    const eslint = appTakes.eslint ?? /** @type {string} */ (meta.ranges['eslint'])

    // What this run made, kept after it returns: a signal that came while it ran is dispatched only then, and must still
    // find the app, the caller's change and the apps/ directory it may have created (as `generate` keeps `moved`).
    const made = {
        apps: /** @type {string | undefined} */ (undefined),
        stage: '',
        app: '',
        finished: /** @type {(() => void) | undefined} */ (undefined),
    }
    const undo = () => {
        if (made.finished) {
            const finished = made.finished
            made.finished = undefined
            finished()
        }
        if (made.stage) rmSync(made.stage, { recursive: true, force: true })
        if (made.app) rmSync(made.app, { recursive: true, force: true })
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
        made.app = appDir
        if (finish) made.finished = finish(appDir)
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
