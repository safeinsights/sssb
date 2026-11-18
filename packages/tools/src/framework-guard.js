// @ts-check
// The guard the Vite and Vitest presets add (ADR-0014, rule 4): every module the app's build or test run loads that is
// framework source must be the app's own @sssb/kit instance.
//
// The presets pass the app's seam explicitly (`@sssb/app-config` to its `src/app-config`), and the alias applies to
// every module in the project. So if anything the app imports (a workspace package, a library) brings a framework
// instance of its own, that second instance would run on THIS app's seam beside the app's, silently, as a second
// copy of every framework class: the case pnpm's layout makes fail loudly everywhere else (an instance with no seam
// cannot load). The guard turns it into an error naming both. Framework source is recognised by its package, not its
// path (kit.js, isFrameworkFile), so a copy of the framework's tree reached by a relative path is caught too.
import { existsSync } from 'node:fs'
import path from 'node:path'
import { assertNoForeignFramework } from './kit.js'

/**
 * @param {string} appDir
 * @returns {import('vite').Plugin}
 */
export function frameworkGuard(appDir) {
    /** @type {Set<string>} */
    const checked = new Set()
    return {
        name: 'sssb:framework-guard',
        enforce: 'pre',
        load(id) {
            const file = id.split('?', 1)[0] ?? id
            // Virtual modules (`\0…`, `virtual:…`) and ids that are not files have no package to judge.
            if (checked.has(file) || !path.isAbsolute(file) || !existsSync(file)) return null
            // Remembered only once it passes, so a foreign file fails every test file that loads it, not just the first.
            assertNoForeignFramework(appDir, file)
            checked.add(file)
            return null
        },
    }
}
