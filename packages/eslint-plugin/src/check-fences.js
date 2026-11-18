// THE FENCES AS COMPOSED (ADR-0014, part 3): what `sssb check-fences` runs. An adopter's config composes the preset
// with blocks of its own, and nothing about that composition is visible from inside a rule. So this asks ESLint
// itself, through the app's real config, four questions:
//
//  1. For every source file the app has, is every sssb/* rule the preset enables there still enabled, at `error`,
//     with the preset's options, under the preset's parser, processor and language? It compares
//     `calculateConfigForFile` through the app's config with the same call through the preset alone. A later block
//     that turns a rule off or down, swaps the app's vendor list, adds a processor or a parser for one directory, a
//     later `ignores`, a global ignore, a nested config file that takes over a directory: each shows up here.
//  2. Does every fence still REPORT? The probes (./probes.js) are linted as virtual files at paths in the app.
//  3. Does each `lint-exceptions.mjs` entry exempt exactly the file it names? The named file must pass the tenancy
//     ban and a sibling beside it must not.
//  4. Does an inline comment hide a fence's finding? The app's files are linted twice through its config, once as
//     they are and once with inline configuration off, and ESLint itself reads every directive: a finding an
//     `eslint-disable` suppressed (one naming the fence, or naming no rule), or one only the second run reports (an
//     inline `/* eslint sssb/…: off */`), is reported. An app's exceptions belong in lint-exceptions.mjs, named and
//     reasoned. A directive over code that breaks no fence hides nothing yet, and ESLint reports it as unused.
//
// What it cannot see: flags on the app's lint command (`--rule`, `--config`, `--no-config-lookup`); a config that
// behaves differently when it detects which tool loaded it (it is code); a directory ESLint does not enter (a
// symlinked one, which is reported instead). Typed linting (parserOptions.project or projectService) cannot parse the
// probe files, which are not in the app's TypeScript project, and is reported as such.
import { existsSync, readdirSync, realpathSync, statSync } from 'node:fs'
import { createRequire } from 'node:module'
import { basename, dirname, extname, join, relative, resolve } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { pathToFileURL } from 'node:url'
import { loadAppLintExceptions } from './app-config.js'
import plugin from './index.js'
import { EXCEPTION_PROBE_CODE, PROBE, PROBES } from './probes.js'

const LINTED = new Set(['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs'])
// Never walked: where a package manager or git put files, and what the preset itself ignores. Anything else is walked,
// and the preset's own ignores (isPathIgnored) decide.
const SKIPPED_DIRS = new Set(['node_modules', '.git', '.next', '.data', 'dist-demo', 'coverage'])
const SEVERITY = { off: 0, warn: 1, error: 2 }
const severityOf = (entry) => {
    const level = Array.isArray(entry) ? entry[0] : entry
    return typeof level === 'number' ? level : (SEVERITY[level] ?? 0)
}
const optionsOf = (entry) => (Array.isArray(entry) ? entry.slice(1) : [])
// What parses and pre-processes a file: a later block's parser or processor can blank a file or drop a fence's findings.
const nameOf = (thing) =>
    thing === undefined
        ? 'none'
        : typeof thing === 'string'
          ? thing
          : (thing.meta?.name ?? thing.name ?? 'an unnamed one') + (thing.meta?.version ? `@${thing.meta.version}` : '')

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
 * @returns {Generator<string>}
 */
function* sourceFiles(dir, linkedDirs) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name)
        if (entry.isDirectory()) {
            if (!SKIPPED_DIRS.has(entry.name)) yield* sourceFiles(full, linkedDirs)
        } else if (entry.isSymbolicLink()) {
            const target = existsSync(full) ? statSync(full) : undefined
            if (target?.isDirectory()) linkedDirs.push(full)
            else if (target?.isFile() && LINTED.has(extname(entry.name))) yield full
        } else if (entry.isFile() && LINTED.has(extname(entry.name))) {
            yield full
        }
    }
}

const sssbOnly = (messages) => messages.filter((m) => m.ruleId?.startsWith('sssb/'))
const where = (m) => `${m.ruleId}@${m.line}:${m.column}`

/**
 * Probe an app's composed lint config. Resolves ESLint from the app's directory unless one is passed.
 * @param {{ appDir: string, ESLint?: typeof import('eslint').ESLint }} options
 * @returns {Promise<{ problems: string[], files: number, probes: number }>}
 */
export async function checkFences({ appDir: given, ESLint: passed }) {
    const appDir = realpathSync(resolve(given))
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
    const walked = []
    for (const file of sourceFiles(appDir, linkedDirs)) {
        if (await preset.isPathIgnored(file)) continue
        walked.push(file)
        const wantedConfig = await preset.calculateConfigForFile(file)
        const wanted = wantedConfig?.rules ?? {}
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
        for (const [what, of] of /** @type {const} */ ([
            ['parser', (c) => c?.languageOptions?.parser],
            ['processor', (c) => c?.processor],
            ['language', (c) => c?.language],
        ])) {
            const [want, got] = [nameOf(of(wantedConfig)), nameOf(of(actualConfig))]
            if (want !== got) problems.push(`${at(file)}: its ${what} is ${got}, and the preset's is ${want}`)
        }
        for (const [rule, entry] of Object.entries(wanted)) {
            if (!rule.startsWith('sssb/') || severityOf(entry) !== 2) continue
            const got = actual[rule]
            if (severityOf(got) !== 2) {
                problems.push(`${at(file)}: ${rule} is ${got === undefined ? 'not enabled' : 'switched off or down'}`)
            } else if (!isDeepStrictEqual(optionsOf(got), optionsOf(entry))) {
                problems.push(`${at(file)}: ${rule} runs with options the preset does not set`)
            }
        }
    }
    for (const dir of linkedDirs) {
        problems.push(`${at(dir)}: a symlinked directory, which ESLint does not enter, so no fence sees its files`)
    }
    // A config that does not load fails every lint the steps below would run: that one problem is the answer.
    if (unloadable) return { problems, files: walked.length, probes: 0 }

    // 4. inline directives, as ESLint itself reads them
    if (walked.length > 0) {
        const asWritten = await composed.lintFiles(walked)
        const withoutInline = new Map((await noInlineConfig.lintFiles(walked)).map((r) => [r.filePath, r]))
        for (const result of asWritten) {
            for (const m of sssbOnly(result.suppressedMessages ?? [])) {
                problems.push(
                    `${at(result.filePath)}:${m.line}: an eslint-disable comment hides ${m.ruleId}; an app's exceptions belong in lint-exceptions.mjs`,
                )
            }
            const seen = new Set(
                [...sssbOnly(result.messages), ...sssbOnly(result.suppressedMessages ?? [])].map(where),
            )
            for (const m of sssbOnly(withoutInline.get(result.filePath)?.messages ?? [])) {
                if (!seen.has(where(m))) {
                    problems.push(
                        `${at(result.filePath)}:${m.line}: an inline /* eslint */ comment switches ${m.ruleId} off there`,
                    )
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

    return { problems, files: walked.length, probes: PROBES.length + exceptionProbes }
}
