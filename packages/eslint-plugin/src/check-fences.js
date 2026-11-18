// THE FENCES AS COMPOSED (ADR-0014, part 3): what `sssb check-fences` runs. An adopter's config composes the preset
// with blocks of its own, and nothing about that composition is visible from inside a rule. So this asks ESLint
// itself, through the app's real config, four questions:
//
//  1. For every source file the app has, is every sssb/* rule the preset enables there still enabled, at `error`,
//     with the preset's options? It compares `calculateConfigForFile` through the app's config with the same call
//     through the preset alone. A later block that turns a rule off or down, a later `ignores` that drops the file,
//     a global ignore, a nested config file that takes over a directory: each shows up here as a file the preset
//     fences and the app's config does not.
//  2. Does every fence still REPORT? The probes (./probes.js) are linted as virtual files at paths in the app, so a
//     rule that is on but cannot fire (another parser, another `sssb` plugin, a processor) shows up here.
//  3. Does each `lint-exceptions.mjs` entry exempt exactly the file it names? The named file must pass the tenancy
//     ban and a sibling beside it must not.
//  4. Does any source file switch a fence off inline? An `eslint-disable` naming an sssb/* rule, an inline
//     `/* eslint sssb/… */` config, or a disable that names no rule at all (which disables every rule) is reported:
//     an app's exceptions belong in lint-exceptions.mjs, where they are named and reasoned.
//
// What it cannot see: flags on the app's lint command (`--rule`, `--config`, `--no-config-lookup`), and a parse-time
// failure that only typed linting hits (a probe file outside the app's TypeScript project) is reported as one.
import { existsSync, readdirSync, readFileSync, realpathSync } from 'node:fs'
import { createRequire } from 'node:module'
import { basename, dirname, extname, join, relative, resolve } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { pathToFileURL } from 'node:url'
import { loadAppLintExceptions } from './app-config.js'
import plugin from './index.js'
import { EXCEPTION_PROBE_CODE, PROBE, PROBES } from './probes.js'

const LINTED = new Set(['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs'])
// Never walked: where a package manager, git or a build put files nobody writes by hand.
const SKIPPED_DIRS = new Set(['node_modules', '.git', '.next', '.data', '.turbo', 'dist-demo', 'coverage'])
const SEVERITY = { off: 0, warn: 1, error: 2 }
const severityOf = (entry) => {
    const level = Array.isArray(entry) ? entry[0] : entry
    return typeof level === 'number' ? level : (SEVERITY[level] ?? 0)
}
const optionsOf = (entry) => (Array.isArray(entry) ? entry.slice(1) : [])
// Rules whose options can only ADD to what they fence (the app's own vendors): any options are a tightening.
const ADDITIVE_OPTIONS = new Set(['sssb/no-vendor-import', 'sssb/no-dynamic-vendor-import'])

/**
 * ESLint as the app's directory finds it: the copy the app's lint script runs. WALKED up the app's `node_modules`
 * chain rather than `require.resolve`d, because Node's resolver falls back to NODE_PATH, which `pnpm exec` sets to the
 * workspace's hoisted `.pnpm/node_modules`.
 */
async function eslintOf(appDir) {
    let found
    for (let dir = appDir; !found; dir = dirname(dir)) {
        if (existsSync(join(dir, 'node_modules', 'eslint', 'package.json'))) found = join(dir, 'node_modules', 'eslint')
        else if (dirname(dir) === dir) throw new Error(`@sssb/eslint-plugin: ${appDir} does not install eslint`)
    }
    const resolved = createRequire(join(found, 'package.json')).resolve('eslint')
    return /** @type {typeof import('eslint').ESLint} */ ((await import(pathToFileURL(resolved).href)).ESLint)
}

function* sourceFiles(dir) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (entry.isDirectory()) {
            if (!SKIPPED_DIRS.has(entry.name)) yield* sourceFiles(join(dir, entry.name))
        } else if (entry.isFile() && LINTED.has(extname(entry.name)) && !entry.name.endsWith('.d.ts')) {
            yield join(dir, entry.name)
        }
    }
}

// A directive comment that switches an sssb/* rule off, configures one inline, or disables every rule.
const DISABLE = /\/[*/]\s*eslint-disable(?:-next-line|-line)?\b([^\n]*?)(?:\*\/|$)/gm
const INLINE_CONFIG = /\/\*\s*eslint\s+([^*]*?)\*\//g
function inlineSwitches(text) {
    const found = []
    for (const [comment, rest] of text.matchAll(DISABLE)) {
        const ruleList = rest.split('--')[0].trim()
        if (ruleList === '') found.push(`${comment.trim()} (names no rule, so it disables every fence too)`)
        else if (/(^|[\s,])sssb\//.test(ruleList)) found.push(comment.trim())
    }
    for (const [comment, body] of text.matchAll(INLINE_CONFIG)) {
        if (/(^|[\s,])sssb\//.test(body)) found.push(comment.trim())
    }
    return found
}

/**
 * Probe an app's composed lint config. Resolves ESLint from the app's directory unless one is passed.
 * @param {{ appDir: string, ESLint?: typeof import('eslint').ESLint }} options
 * @returns {Promise<{ problems: string[], files: number, probes: number }>}
 */
export async function checkFences({ appDir: given, ESLint: passed }) {
    const appDir = realpathSync(resolve(given))
    const ESLint = passed ?? (await eslintOf(appDir))
    const composed = new ESLint({ cwd: appDir })
    const preset = new ESLint({
        cwd: appDir,
        overrideConfigFile: true,
        overrideConfig: await plugin.configs.app({ root: appDir }),
    })
    const problems = []
    const at = (file) => relative(appDir, file)

    // 1. the effective config, file by file
    let files = 0
    for (const file of sourceFiles(appDir)) {
        if (await preset.isPathIgnored(file)) continue
        files += 1
        const wanted = (await preset.calculateConfigForFile(file))?.rules ?? {}
        let actual
        try {
            actual = (await composed.calculateConfigForFile(file))?.rules
        } catch (error) {
            problems.push(`${at(file)}: the app's config does not load for it (${String(error).split('\n')[0]})`)
            continue
        }
        if (!actual) {
            problems.push(`${at(file)}: the app's config ignores it, and the preset lints it`)
            continue
        }
        for (const [rule, entry] of Object.entries(wanted)) {
            if (!rule.startsWith('sssb/') || severityOf(entry) !== 2) continue
            const got = actual[rule]
            if (severityOf(got) !== 2) {
                problems.push(`${at(file)}: ${rule} is ${got === undefined ? 'not enabled' : 'switched off or down'}`)
            } else if (!ADDITIVE_OPTIONS.has(rule) && !isDeepStrictEqual(optionsOf(got), optionsOf(entry))) {
                problems.push(`${at(file)}: ${rule} runs with options the preset does not set`)
            }
        }
        for (const found of inlineSwitches(readFileSync(file, 'utf8'))) {
            problems.push(`${at(file)}: ${found} — an app's exceptions belong in lint-exceptions.mjs`)
        }
    }

    // 2. the probes
    const lint = async (path, code) => {
        const [result] = await composed.lintText(code, { filePath: join(appDir, path) })
        const unlinted = result.messages.filter((m) => !m.ruleId)
        if (unlinted.length > 0) {
            problems.push(`${path}: not linted as an app file would be (${unlinted[0].message.split('\n')[0]})`)
            return undefined
        }
        return new Set(result.messages.map((m) => m.ruleId))
    }
    for (const probe of PROBES) {
        const fired = await lint(probe.path, probe.code)
        if (!fired) continue
        for (const rule of probe.fires) {
            if (!fired.has(rule)) problems.push(`${probe.path}: ${rule} did not report what it fences`)
        }
    }

    // 3. the app's own exceptions: the named file exempt, a sibling not
    const exceptions = await loadAppLintExceptions(appDir)
    let exceptionProbes = 0
    for (const [rule, entries] of Object.entries(exceptions)) {
        for (const escaped of entries) {
            const file = escaped.replace(/\\(.)/g, '$1')
            const sibling = join(dirname(file), `${PROBE}${extname(file)}`)
            exceptionProbes += 2
            const named = await lint(file, EXCEPTION_PROBE_CODE)
            if (named?.has(rule)) problems.push(`${file}: lint-exceptions.mjs names it, and ${rule} still reports`)
            const beside = await lint(sibling, EXCEPTION_PROBE_CODE)
            if (beside && !beside.has(rule)) {
                problems.push(
                    `${sibling}: ${rule} does not report beside ${basename(file)}: the exception is wider than its file`,
                )
            }
        }
    }

    return { problems, files, probes: PROBES.length + exceptionProbes }
}
