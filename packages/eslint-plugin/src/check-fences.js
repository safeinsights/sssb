// THE FENCES AS COMPOSED (ADR-0014, part 3): what `sssb check-fences` runs. An adopter's config composes the preset
// with blocks of its own, and nothing about that composition is visible from inside a rule. So this asks ESLint
// itself, through the app's real config, four questions:
//
//  1. For every source file the app has, is every sssb/* rule the preset enables there still enabled, at `error`,
//     with the preset's options, under the preset's parser, language and no processor? It compares
//     `calculateConfigForFile` through the app's config with the same call through the preset alone. A later block
//     that turns a rule off or down, swaps the app's vendor list, adds a processor or a parser for one directory, a
//     later `ignores`, a global ignore, a nested config file that takes over a directory: each shows up here.
//  2. Does every fence still REPORT? The probes (./probes.js) are linted as virtual files at paths in the app.
//  3. Does each `lint-exceptions.mjs` entry exempt exactly the file it names? The named file must pass the tenancy
//     ban and a sibling beside it must not.
//  4. Does a fence's finding in the app's own files get through? The app's files are linted twice through its
//     config, once as they are and once with inline configuration off, and ESLint itself reads every directive. For the
//     rules the preset enables on each file, a finding at any severity (an inline comment that turns a fence down to a
//     warning, a suppressions file the ESLint CLI applies and this API does not), one an `eslint-disable` suppressed,
//     or one only the second run reports (an inline `/* eslint sssb/…: off */`) is reported. An app's exceptions
//     belong in lint-exceptions.mjs, named and reasoned. A directive over code that breaks no fence hides nothing yet.
//
// What it cannot see: config code written to deceive (it behaves differently when it detects which tool loaded it,
// a parser borrows another's name, the preset's blocks are rebound to a look-alike plugin, a module the rules read is
// rewritten; see .claude/future-tasks/check-fences-real-file-probes.md); the app's lint command's own flags, except
// that any fence finding in the app's files is reported here whatever the command does with it.
// Reported instead: a symlinked directory holding a file the preset lints (ESLint does not enter it). Typed linting
// (parserOptions.project or projectService) cannot parse the probe files, which are not in the app's TypeScript
// project, and is reported as such.
import { existsSync, readdirSync, realpathSync, statSync } from 'node:fs'
import { createRequire } from 'node:module'
import { basename, dirname, extname, join, relative, resolve } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { pathToFileURL } from 'node:url'
import { loadAppLintExceptions } from './app-config.js'
import plugin from './index.js'
import { EXCEPTION_PROBE_CODE, PROBE, PROBES } from './probes.js'

const LINTED = new Set(['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs'])
// Never walked, anywhere: where a package manager or git puts files.
const NEVER_WALKED = new Set(['node_modules', '.git'])
// Not walked at the APP'S ROOT, where the preset ignores them (build and test output). The same names deeper in the
// app (`src/coverage/`) are source like any other, and walked.
const ROOT_OUTPUTS = new Set(['.next', '.data', 'dist-demo', 'coverage', 'test-results', 'playwright-report'])
const SEVERITY = { off: 0, warn: 1, error: 2 }
const severityOf = (entry) => {
    const level = Array.isArray(entry) ? entry[0] : entry
    return typeof level === 'number' ? level : (SEVERITY[level] ?? 0)
}
const optionsOf = (entry) => (Array.isArray(entry) ? entry.slice(1) : [])
// A parser by what it calls itself, without its version: an app that spreads its own copy of typescript-eslint after
// the preset, at another version, parses the same way. (A parser that borrows another's `meta` is code written to
// deceive, the residual this file's header names.)
const parserName = (parser) =>
    parser === undefined ? 'none' : (parser.meta?.name ?? parser.name ?? 'an unnamed parser')

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

/**
 * Every file ESLint would lint under `dir`, a symlinked file included (ESLint lints one); `linkedDirs` collects the
 * symlinked directories, which ESLint does not enter, so a fence never sees their files.
 * @param {string} dir
 * @param {string[]} linkedDirs
 * @param {boolean} atRoot
 * @returns {Generator<string>}
 */
function* sourceFiles(dir, linkedDirs, atRoot = true) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name)
        const skipped = NEVER_WALKED.has(entry.name) || (atRoot && ROOT_OUTPUTS.has(entry.name))
        if (entry.isDirectory()) {
            if (!skipped) yield* sourceFiles(full, linkedDirs, false)
        } else if (entry.isSymbolicLink()) {
            const target = existsSync(full) ? statSync(full) : undefined
            if (target?.isDirectory()) {
                if (!skipped) linkedDirs.push(full)
            } else if (target?.isFile() && LINTED.has(extname(entry.name))) yield full
        } else if (entry.isFile() && LINTED.has(extname(entry.name))) {
            yield full
        }
    }
}

/**
 * Whether a symlinked directory holds a file the preset would lint, read through the link's own path (as ESLint would
 * name it, had it entered). Each real directory is read once, so a link cycle ends.
 * @param {string} dir
 * @param {import('eslint').ESLint} preset
 * @param {Set<string>} seen
 * @returns {Promise<boolean>}
 */
async function holdsLintedFiles(dir, preset, seen = new Set()) {
    const real = realpathSync(dir)
    if (seen.has(real)) return false
    seen.add(real)
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (NEVER_WALKED.has(entry.name)) continue
        const full = join(dir, entry.name)
        const target = entry.isSymbolicLink() ? (existsSync(full) ? statSync(full) : undefined) : entry
        if (target?.isDirectory()) {
            if (await holdsLintedFiles(full, preset, seen)) return true
        } else if (target?.isFile() && LINTED.has(extname(entry.name)) && !(await preset.isPathIgnored(full))) {
            return true
        }
    }
    return false
}

/**
 * Probe an app's composed lint config. Resolves ESLint from the app's directory unless one is passed.
 * @param {{ appDir: string, ESLint?: typeof import('eslint').ESLint }} options
 * @returns {Promise<{ problems: string[], files: number, probes: number }>}
 */
export async function checkFences({ appDir: given, ESLint: passed }) {
    const appDir = realpathSync.native(resolve(given))
    const ESLint = passed ?? (await eslintOf(appDir))
    const composed = new ESLint({ cwd: appDir })
    const noInlineConfig = new ESLint({ cwd: appDir, allowInlineConfig: false })
    const preset = new ESLint({
        cwd: appDir,
        overrideConfigFile: true,
        overrideConfig: await plugin.configs.app({ root: appDir }),
    })
    const problems = []
    const at = (file) => relative(appDir, file)

    // 1. the effective config, file by file
    const linkedDirs = []
    let unloadable = false
    /** The sssb/* rules the preset enables at `error`, for each file the preset lints. @type {Map<string, Set<string>>} */
    const fenced = new Map()
    for (const file of sourceFiles(appDir, linkedDirs)) {
        if (await preset.isPathIgnored(file)) continue
        const wantedConfig = await preset.calculateConfigForFile(file)
        const wanted = wantedConfig?.rules ?? {}
        const rules = new Set(
            Object.entries(wanted)
                .filter(([rule, entry]) => rule.startsWith('sssb/') && severityOf(entry) === 2)
                .map(([rule]) => rule),
        )
        fenced.set(file, rules)
        let actualConfig
        try {
            actualConfig = await composed.calculateConfigForFile(file)
        } catch (error) {
            problems.push(`${at(file)}: the app's config does not load for it (${String(error).split('\n')[0]})`)
            unloadable = true
            continue
        }
        const actual = actualConfig?.rules
        if (!actual) {
            problems.push(`${at(file)}: the app's config ignores it, and the preset lints it`)
            continue
        }
        // What reads the file before any rule does. The language is ESLint's own object, so it is the preset's or it is
        // another; the preset sets no processor, so any processor is one the app added; the parser is compared by name.
        if (actualConfig.language !== wantedConfig.language) {
            problems.push(`${at(file)}: it is parsed as another language than the preset's`)
        }
        if (actualConfig.processor !== wantedConfig.processor) {
            const name = actualConfig.processor?.meta?.name ?? 'an unnamed one'
            problems.push(`${at(file)}: it runs through a processor (${name}), and the preset sets none`)
        }
        const [wantParser, gotParser] = [wantedConfig, actualConfig].map((c) => parserName(c.languageOptions?.parser))
        if (wantParser !== gotParser) {
            problems.push(`${at(file)}: its parser is ${gotParser}, and the preset's is ${wantParser}`)
        }
        for (const rule of rules) {
            const got = actual[rule]
            if (severityOf(got) !== 2) {
                problems.push(`${at(file)}: ${rule} is ${got === undefined ? 'not enabled' : 'switched off or down'}`)
            } else if (!isDeepStrictEqual(optionsOf(got), optionsOf(wanted[rule]))) {
                problems.push(`${at(file)}: ${rule} runs with options the preset does not set`)
            }
        }
    }
    for (const dir of linkedDirs) {
        if (await holdsLintedFiles(dir, preset)) {
            problems.push(`${at(dir)}: a symlinked directory, which ESLint does not enter, so no fence sees its files`)
        }
    }
    // When the app's config does not load for some file, step 4's lintFiles (every file at once) would throw, and the
    // problem above already fails the check; the probes are skipped rather than run against a config known to be broken.
    if (unloadable) return { problems, files: fenced.size, probes: 0 }

    // 4. what a fence finds in the app's own files, as ESLint itself reads them. Only the rules the preset enables for
    // each file count: an app that tightens a fence beyond the preset may relax its own tightening.
    if (fenced.size > 0) {
        const files = [...fenced.keys()]
        const asWritten = await composed.lintFiles(files)
        const withoutInline = new Map((await noInlineConfig.lintFiles(files)).map((r) => [r.filePath, r]))
        for (const result of asWritten) {
            const rules = fenced.get(result.filePath) ?? new Set()
            const ours = (messages) => (messages ?? []).filter((m) => rules.has(m.ruleId))
            const key = (m) => `${m.ruleId}@${m.line}:${m.column}`
            const where = `${at(result.filePath)}`
            // Reported as it stands, at any severity: a finding the app's lint lets through (an inline comment that
            // turns the fence down to a warning, a suppressions file the ESLint CLI applies and this API does not, a
            // lint script with flags) is a fence that is not holding.
            for (const m of ours(result.messages)) {
                problems.push(`${where}:${m.line}: ${m.ruleId} reports it, and the app's lint must fail on it`)
            }
            for (const m of ours(result.suppressedMessages)) {
                problems.push(
                    `${where}:${m.line}: an eslint-disable comment hides ${m.ruleId}; an app's exceptions belong in lint-exceptions.mjs`,
                )
            }
            const seen = new Set([...ours(result.messages), ...ours(result.suppressedMessages)].map(key))
            for (const m of ours(withoutInline.get(result.filePath)?.messages)) {
                if (!seen.has(key(m))) {
                    problems.push(`${where}:${m.line}: an inline /* eslint */ comment switches ${m.ruleId} off there`)
                }
            }
        }
    }

    // 2. the probes
    const lint = async (path, code) => {
        const [result] = await composed.lintText(code, { filePath: join(appDir, path) })
        const unlinted = result.messages.filter((m) => !m.ruleId)
        if (unlinted.length > 0) {
            const why = unlinted[0].message.split('\n')[0]
            const typed = /project service|parserOptions\.project|TSConfig/i.test(unlinted[0].message)
                ? ': typed linting cannot parse a file outside the TypeScript project, so check-fences needs the probes untyped'
                : ''
            problems.push(`${path}: not linted as an app file would be (${why})${typed}`)
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

    return { problems, files: fenced.size, probes: PROBES.length + exceptionProbes }
}
