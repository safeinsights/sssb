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
import { realpathSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'

const KIT = '@sssb/kit'

/** @param {string} appDir */
function requireFrom(appDir) {
    return createRequire(path.join(path.resolve(appDir), 'package.json'))
}

/**
 * The real directory of the `@sssb/kit` an app resolves. Throws, naming the app, when the app does not
 * install the framework at all.
 * @param {string} appDir
 * @returns {string}
 */
export function kitDirOf(appDir) {
    let manifest
    try {
        manifest = requireFrom(appDir).resolve(`${KIT}/package.json`)
    } catch (error) {
        throw new Error(
            `sssb: ${path.resolve(appDir)} does not resolve ${KIT}. Run this from an app that depends on it, ` +
                `or name one with --app (${error instanceof Error ? error.message.split('\n')[0] : String(error)})`,
            { cause: error },
        )
    }
    return realpathSync(path.dirname(manifest))
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
        throw new Error(
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
        throw new Error(
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
        throw new Error(
            `sssb: ${path.resolve(appDir)} does not install \`${specifier}\`, which ${why}. Add it to the app's ` +
                'devDependencies.',
            { cause: error },
        )
    }
}
