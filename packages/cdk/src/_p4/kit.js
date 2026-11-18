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
import { existsSync, realpathSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
// TEMPORARY (ADR-0014 P9): a copy of @sssb/tools' src/kit.js until that package publishes it as `./kit`; the one
// change is UsageError, which lives in its src/app.js.
class UsageError extends Error {}

const KIT = '@sssb/kit'

/** @param {string} appDir */
function requireFrom(appDir) {
    return createRequire(path.join(path.resolve(appDir), 'package.json'))
}

/**
 * The real directory of the `@sssb/kit` an app resolves: the first `node_modules/@sssb/kit` walking up from the
 * app's directory, which is where Node's own lookup finds it. Throws, naming the app, when there is none.
 *
 * WALKED, NOT `require.resolve`d: Node's resolver falls back to NODE_PATH when the app's own chain has no match, and
 * `pnpm exec` and `pnpm run` set NODE_PATH to the workspace's hoisted `.pnpm/node_modules`. So for an app that
 * installs no framework, `require.resolve('@sssb/kit/…')` would quietly return the hoisted copy, another app's
 * instance: the slip rule 4 exists to prevent. The walk never consults NODE_PATH or the global folders.
 * @param {string} appDir
 * @returns {string}
 */
export function kitDirOf(appDir) {
    for (let dir = path.resolve(appDir); ; dir = path.dirname(dir)) {
        const candidate = path.join(dir, 'node_modules', '@sssb', 'kit')
        if (existsSync(path.join(candidate, 'package.json'))) return realpathSync(candidate)
        if (path.dirname(dir) === dir) break
    }
    throw new UsageError(
        `sssb: ${path.resolve(appDir)} does not resolve ${KIT}: no node_modules/${KIT} in it or above it. Run this ` +
            'from an app that depends on it, or name one with --app',
    )
}

/**
 * The shared real-path check: `file` must be part of the `@sssb/kit` that `appDir` resolves. Anything else (the
 * hoisted copy, another app's instance, this repository's source reached by a path) throws.
 * @param {string} appDir
 * @param {string} file
 * @returns {string} the file's real path
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
 * @param {string} appDir
 * @param {string} subpath
 * @returns {string}
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
 * @param {string} appDir
 * @param {string} specifier
 * @param {string} why what the app is missing it for, for the error
 * @returns {string}
 */
export function resolveFromApp(appDir, specifier, why) {
    try {
        return requireFrom(appDir).resolve(specifier)
    } catch (error) {
        throw new UsageError(
            `sssb: ${path.resolve(appDir)} does not install \`${specifier}\`, which ${why}. Add it to the app's ` +
                'devDependencies.',
            { cause: error },
        )
    }
}

/**
 * Loads a package the APP installs (see resolveFromApp) and returns its module namespace. A CommonJS package's
 * `module.exports` arrives as `default`, and its named exports as Node's CJS lexer finds them.
 * @param {string} appDir
 * @param {string} specifier
 * @param {string} why
 * @returns {Promise<Record<string, unknown>>}
 */
export async function importFromApp(appDir, specifier, why) {
    return await import(pathToFileURL(resolveFromApp(appDir, specifier, why)).href)
}
