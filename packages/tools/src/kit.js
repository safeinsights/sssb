// @ts-check
// THE ONE WAY @sssb/tools REACHES THE FRAMEWORK (ADR-0014, rule 4).
//
// @sssb/tools does not depend on @sssb/kit, and must never import it by a bare specifier: resolved from this
// package's own location, `@sssb/kit` finds whichever copy pnpm happened to hoist into `.pnpm/node_modules`,
// which in a workspace with two apps is the OTHER app's instance, running on the other app's seam. The
// independent review of ADR-0014 reproduced exactly that. So every tool that needs a framework file resolves it
// HERE, with the app's own directory as the base, and then runs the shared check: the real path of the file it
// got must sit inside the real directory of the `@sssb/kit` that the app itself resolves. The lint rule
// `sssb/no-bare-kit-import` keeps every other route out of this package's source.
import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { builtinModules, createRequire } from 'node:module'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { UsageError } from './app.js'

const KIT = '@sssb/kit'

/** @param {string} appDir */
function requireFrom(appDir) {
    return createRequire(path.join(path.resolve(appDir), 'package.json'))
}

/**
 * The real directory of the package `name` as Node's lexical lookup finds it from `fromDir`: the first
 * `node_modules/<name>` walking up. Null when there is none. It never consults NODE_PATH (see kitDirOf).
 * @param {string} fromDir
 * @param {string} name
 * @returns {string | null}
 */
function packageDirFrom(fromDir, name) {
    for (let dir = path.resolve(fromDir); ; dir = path.dirname(dir)) {
        const candidate = path.join(dir, 'node_modules', ...name.split('/'))
        if (existsSync(path.join(candidate, 'package.json'))) return realpathSync(candidate)
        if (path.dirname(dir) === dir) return null
    }
}

/** @param {string} specifier `@scope/name/sub` or `name/sub` */
const packageNameOf = (specifier) =>
    specifier
        .split('/')
        .slice(0, specifier.startsWith('@') ? 2 : 1)
        .join('/')

/** @type {Map<string, string | null>} the `name` of each directory's nearest named package.json */
const owningNames = new Map()

/**
 * The `name` in the nearest package.json at or above `dir` that has one (a nameless `{ "type": "module" }` is not a
 * package), or null.
 * @param {string} dir
 * @returns {string | null}
 */
function owningPackageName(dir) {
    const cached = owningNames.get(dir)
    if (cached !== undefined) return cached
    const manifest = path.join(dir, 'package.json')
    /** @type {string | null} */
    let name
    // A package.json with no `name` (a nested `{ "type": "module" }`) does not make a package: keep walking, or a file
    // under one inside a framework copy would read as nobody's and pass every guard.
    /** @type {string | null} */
    let named = null
    if (existsSync(manifest)) {
        try {
            const parsed = JSON.parse(readFileSync(manifest, 'utf8'))
            named = typeof parsed?.name === 'string' ? parsed.name : null
        } catch {
            named = null
        }
    }
    if (named !== null) name = named
    else {
        const parent = path.dirname(dir)
        name = parent === dir ? null : owningPackageName(parent)
    }
    owningNames.set(dir, name)
    return name
}

/**
 * Whether `file` is framework source: its nearest named package.json is `@sssb/kit`'s, wherever it sits (an installed
 * instance, a workspace link, or a copy of the framework's tree reached by a relative path). Recognised by the
 * package, not by an `@sssb/kit` segment in the path, which a copy outside node_modules does not have.
 *
 * @type {import('./kit.d.ts').isFrameworkFile}
 */
export function isFrameworkFile(file) {
    return owningPackageName(path.dirname(realpathSync(file))) === KIT
}

/**
 * The guard every loader runs on each file it loads for an app: framework source must be the app's own instance
 * (`assertAppsKitFile`); anything else passes.
 *
 * @type {import('./kit.d.ts').assertNoForeignFramework}
 */
export function assertNoForeignFramework(appDir, file) {
    if (isFrameworkFile(file)) assertAppsKitFile(appDir, file)
}

/**
 * The real directory of the `@sssb/kit` an app resolves: the first `node_modules/@sssb/kit` walking up from the
 * app's directory, which is where Node's own lookup finds it. Throws, naming the app, when there is none.
 *
 * WALKED, NOT `require.resolve`d: Node's resolver falls back to NODE_PATH when the app's own chain has no match, and
 * `pnpm exec` and `pnpm run` set NODE_PATH to the workspace's hoisted `.pnpm/node_modules`. So for an app that
 * installs no framework, `require.resolve('@sssb/kit/…')` would quietly return the hoisted copy, another app's
 * instance: the slip rule 4 exists to prevent. The walk never consults NODE_PATH or the global folders.
 *
 * @type {import('./kit.d.ts').kitDirOf}
 */
export function kitDirOf(appDir) {
    const dir = packageDirFrom(appDir, KIT)
    if (dir !== null) return dir
    throw new UsageError(
        `sssb: ${path.resolve(appDir)} does not resolve ${KIT}: no node_modules/${KIT} in it or above it. Run this ` +
            'from an app that depends on it, or name one with --app',
    )
}

/** @type {import('./kit.d.ts').kitVersionOf} */
export function kitVersionOf(appDir) {
    const manifest = JSON.parse(readFileSync(path.join(kitDirOf(appDir), 'package.json'), 'utf8'))
    if (typeof manifest.version !== 'string') {
        throw new UsageError(
            `sssb: the ${KIT} that ${path.resolve(appDir)} resolves has no version in its package.json`,
        )
    }
    return manifest.version
}

/**
 * The shared real-path check: `file` must be part of the `@sssb/kit` that `appDir` resolves. Anything else (the
 * hoisted copy, another app's instance, this repository's source reached by a path) throws.
 *
 * @type {import('./kit.d.ts').assertAppsKitFile}
 */
export function assertAppsKitFile(appDir, file) {
    const kitDir = kitDirOf(appDir)
    const real = realpathSync(file)
    if (real !== kitDir && !real.startsWith(kitDir + path.sep)) {
        throw new UsageError(
            `sssb: ${real} is not part of the ${KIT} that ${path.resolve(appDir)} resolves (${kitDir}). ` +
                'A tool reached the framework some other way than from the app, so it may be running on another ' +
                "app's instance and seam (ADR-0014, rule 4).",
        )
    }
    return real
}

/**
 * A published subpath of `@sssb/kit` (`i18n/request`, `adapters/real/index`), resolved with the app's directory
 * as the base and checked. Returns the real path.
 *
 * @type {import('./kit.d.ts').resolveAppsKit}
 */
export function resolveAppsKit(appDir, subpath) {
    let file
    try {
        file = requireFrom(appDir).resolve(`${KIT}/${subpath}`)
    } catch (error) {
        // Distinguish "no framework here" from "the framework does not publish that subpath".
        kitDirOf(appDir)
        throw new UsageError(
            `sssb: the ${KIT} that ${path.resolve(appDir)} resolves does not publish \`${KIT}/${subpath}\``,
            { cause: error },
        )
    }
    return assertAppsKitFile(appDir, file)
}

/**
 * Another package the APP installs, resolved from the app's directory: a preset configures the app's own copy
 * of a tool (next-intl's plugin, Vite's React plugin), never one of its own.
 *
 * @type {import('./kit.d.ts').resolveFromApp}
 */
export function resolveFromApp(appDir, specifier, why) {
    const missing = () =>
        specifier.startsWith('#')
            ? `sssb: ${path.resolve(appDir)} cannot resolve \`${specifier}\`, which ${why}: check the \`imports\` of the app's package.json.`
            : `sssb: ${path.resolve(appDir)} does not install \`${specifier}\`, which ${why}. Add it to the app's devDependencies.`
    // The package must be on the app's own lookup chain. Node's resolver would otherwise fall back to NODE_PATH, which
    // pnpm points at the hoisted store, and hand back a copy installed for another package (see kitDirOf).
    // Node's built-ins and package imports (`#x`) are not packages on a lookup chain.
    const bare = !specifier.startsWith('node:') && !specifier.startsWith('#') && !builtinModules.includes(specifier)
    if (bare && packageDirFrom(appDir, packageNameOf(specifier)) === null) throw new UsageError(missing())
    try {
        return requireFrom(appDir).resolve(specifier)
    } catch (error) {
        throw new UsageError(missing(), { cause: error })
    }
}

/**
 * Loads a package the APP installs (see resolveFromApp) and returns its module namespace. A CommonJS package's
 * `module.exports` arrives as `default`, and its named exports as Node's CJS lexer finds them.
 *
 * @type {import('./kit.d.ts').importFromApp}
 */
export async function importFromApp(appDir, specifier, why) {
    return await import(pathToFileURL(resolveFromApp(appDir, specifier, why)).href)
}
