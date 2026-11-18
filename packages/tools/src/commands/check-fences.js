// @ts-check
// `sssb check-fences`: the lint fences as the app's real config composes them (ADR-0014 part 3). An adopter's
// eslint.config.mjs composes `@sssb/eslint-plugin`'s preset with blocks of its own, and nothing inside a rule can see
// what a later block did to it. The probes and the comparison are the plugin's (`@sssb/eslint-plugin/check-fences`):
// every source file's effective config against the preset's, probe files linted through the app's config, each
// lint-exceptions.mjs entry (the named file exempt, a sibling not), and every fence finding in the app's own files,
// at any severity, suppressed by a directive or switched off by an inline config (ESLint reads the directives). This command
// resolves the plugin, and through it ESLint, from the app's own directory, as every tool here resolves what the app
// installed; @sssb/tools depends on neither.
import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { takeAppDir, UsageError } from '../app.js'

// The plugin's directory, WALKED up from the app's `node_modules` chain, never `require.resolve`d: Node's resolver falls
// back to NODE_PATH, and `pnpm exec` sets it to the workspace's hoisted `.pnpm/node_modules`, where an app that
// installs no plugin would find another package's (the same reason src/kit.js walks for @sssb/kit).
/** @param {string} appDir */
function pluginDirOf(appDir) {
    for (let dir = appDir; ; dir = path.dirname(dir)) {
        const candidate = path.join(dir, 'node_modules', '@sssb', 'eslint-plugin')
        if (existsSync(path.join(candidate, 'package.json'))) return candidate
        if (path.dirname(dir) === dir) return undefined
    }
}

/** @param {string[]} args */
export async function run(args) {
    const appDir = takeAppDir(args)
    if (args.length > 0) throw new UsageError('usage: sssb check-fences [--app <dir>]')
    const pluginDir = pluginDirOf(appDir)
    if (!pluginDir) {
        throw new UsageError(
            `sssb check-fences: ${appDir} does not resolve @sssb/eslint-plugin. Add it to the app's devDependencies ` +
                'and compose its preset in the eslint.config.mjs that lints the app.',
        )
    }
    // The package names itself: a self-reference through its own `exports`.
    const entry = createRequire(path.join(pluginDir, 'package.json')).resolve('@sssb/eslint-plugin/check-fences')
    /** @type {{ checkFences: (o: { appDir: string }) => Promise<{ problems: string[], files: number, probes: number }> }} */
    const { checkFences } = await import(pathToFileURL(entry).href)
    const { problems, files, probes } = await checkFences({ appDir })
    if (problems.length === 0) {
        console.log(`sssb check-fences: every fence holds (${files} source files compared, ${probes} probes)`)
        return 0
    }
    console.error(`sssb check-fences: ${problems.length} problem(s) in ${appDir}:`)
    for (const problem of problems) console.error(`  ${problem}`)
    return 1
}
