// @ts-check
// `sssb check-e2e [--app <dir>] [--config <file>]...`: fails when an e2e spec reaches the framework other than through
// `@sssb/kit/testing/e2e` (ADR-0014 part 2).
//
// Playwright loads specs with Node. In an adopter's workspace the framework is TypeScript under node_modules, which
// Node will not strip, and its modules read the app's seam (`@sssb/app-config/*`), which Node cannot resolve the way a
// bundler does. So the one entry a spec may reach is `@sssb/kit/testing/e2e`, which ships compiled and seam-free. A
// lint ban on direct imports is not enough, because a spec reaches the kit indirectly too (the showcase's
// tickets-pagination spec imports the app's src/domain/tickets, which imported the kit's state machine). So this
// BUNDLES every file Playwright loads with esbuild (the app's tsconfig `paths` honoured, a metafile kept) and fails,
// naming file and kit file, for any kit file reached other than that entry.
//
// WHAT IS BUNDLED, WHAT STAYS EXTERNAL: Playwright transforms every file outside node_modules and leaves packages under
// it to Node. So a bare specifier is FOLLOWED when its real path is outside node_modules (the app's own files, its `@/`
// alias, a sibling workspace package and whatever that imports) or is framework source in any copy (its nearest named
// package.json is `@sssb/kit`'s), and the seam always; every other package stays external. A `require()` esbuild can
// see is followed like an import. A loader it cannot see through (a function made by `createRequire(...)`, a plain
// `require` handed a variable that holds the specifier) is not, so a followed file outside the kit that writes, as a
// string literal in its code, an `@sssb/kit` specifier esbuild did not resolve (other than the entry and a `.md` or
// `.json` file of the kit, such as the guide or its `package.json`, other than a property name, and other than an import or export declaration's or a type `import('…')`'s, which esbuild reads or
// which load nothing) fails too; the file is read by the app's own TypeScript parser, so a comment is not code. A
// computed specifier stays out of reach of any static check.
//
// WHICH FILES: Playwright is asked. Each Playwright config of the app (`playwright.config.*`,
// `playwright.<name>.config.*` in its directory), plus each `--config <file>` given (repeatable, relative to the
// working directory, as `playwright test -c` takes one: for a config kept outside the app's directory), is listed by
// the app's own Playwright, from the app's directory: `playwright test --list --reporter=json --config <file>`, the
// report written to a file (`PLAYWRIGHT_JSON_OUTPUT_FILE`), since a spec's own output shares stdout. Listing loads the
// config and every file it matches as a run does (so a config that computes its `testDir` or `require`s, and every
// project's `testDir`, `testMatch` and `testIgnore`, count exactly as Playwright counts them), but starts no
// `webServer`, runs no global setup and needs no browser. The checked files are each config, the global setup and
// teardown the report names, and every file holding a listed test; a support module is checked through every spec
// that imports it. A config Playwright cannot list fails with Playwright's own error, and when that error names a kit
// file other than the allowed entry, the kit file is named too (a spec reaching the kit's TypeScript under
// node_modules, as in an adopter's workspace, stops the listing: Node will not load it). A config that lists no test
// fails as well. Where the report falls short: it names only the FIRST entry of a `globalSetup` or `globalTeardown`
// array (Playwright's public config holds one), and a matched file holding no test is not listed.
//
// THE ENTRY: whatever `@sssb/kit/testing/e2e` resolves to from the app. For an installed kit that is the compiled
// `dist/testing/e2e.js`, and only that file is allowed (in any copy of the kit a sibling package installs). In IN-REPO
// MODE (SSSB's own repository, where the apps' tsconfig `paths` send `@sssb/kit/*` to packages/kit/src) it is the
// entry's source, so the entry's own source closure, computed by bundling the entry alone, is allowed, and that
// closure must itself reach no `@sssb/app-config` module.
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { createRequire, isBuiltin } from 'node:module'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { stripVTControlCharacters as plain } from 'node:util'
import * as esbuild from 'esbuild'
import { takeAppDir, takeOption, UsageError, workspaceRootOf } from '../app.js'
import { kitDirOf, resolveFromApp } from '../kit.js'
import { isInRepoKit, seamOfKit } from './doctor-checks.js'

const KIT = '@sssb/kit'
const ENTRY = `${KIT}/testing/e2e`
/** Kit specifiers written in code that load no framework code: the entry, and a data file (the guide, a manifest). */
const NOT_FRAMEWORK = new Set([ENTRY, `${KIT}/package.json`])
/** @param {string} specifier */
const loadsNoFramework = (specifier) => NOT_FRAMEWORK.has(specifier) || /\.(md|json)$/.test(specifier)
const KEEP = /^@sssb\/(kit|app-config)(\/|$)/
const PROBE = 'sssbCheckE2eProbe'
const CONFIG = /^playwright(\.[\w-]+)?\.config\.(c|m)?[jt]s$/
const USAGE = 'usage: check-e2e [--app <dir>] [--config <file>]...'
/** Indents a detail line under a FAIL line. */
const DETAIL = '\n          '

/** @param {string} child @param {string} parent */
const inside = (child, parent) => child === parent || child.startsWith(parent + path.sep)

/** @param {string} file */
const real = (file) => (existsSync(file) ? realpathSync(file) : path.resolve(file))

/** @param {string} file */
const underNodeModules = (file) => file.split(path.sep).includes('node_modules')

/** @type {Map<string, string | null>} each directory's nearest named package.json: its directory when `@sssb/kit` */
const kitRoots = new Map()

/**
 * The root of the `@sssb/kit` copy `file` belongs to (its nearest named package.json is `@sssb/kit`'s, as
 * `isFrameworkFile` decides), or null when it is not framework source.
 * @param {string} file an absolute, real path
 * @returns {string | null}
 */
function kitRootOf(file) {
    if (!path.isAbsolute(file)) return null
    /** @type {string[]} */
    const walked = []
    /** @type {string | null} */
    let found = null
    for (let dir = path.dirname(file); ; dir = path.dirname(dir)) {
        const cached = kitRoots.get(dir)
        if (cached !== undefined) {
            found = cached
            break
        }
        walked.push(dir)
        const manifest = path.join(dir, 'package.json')
        let name
        try {
            name = existsSync(manifest) ? JSON.parse(readFileSync(manifest, 'utf8'))?.name : undefined
        } catch {
            name = undefined
        }
        if (typeof name === 'string') {
            found = name === KIT ? dir : null
            break
        }
        if (path.dirname(dir) === dir) break
    }
    for (const dir of walked) kitRoots.set(dir, found)
    return found
}

/**
 * Bundles one entry the way check-e2e reads it, and returns esbuild's metafile, or the error that stopped it.
 * @param {{ appDir: string, entry: { file: string } | { contents: string } }} options
 */
async function bundle({ appDir, entry }) {
    const tsconfig = path.join(appDir, 'tsconfig.json')
    try {
        const result = await esbuild.build({
            ...('file' in entry
                ? { entryPoints: [entry.file] }
                : { stdin: { contents: entry.contents, resolveDir: appDir, sourcefile: '<entry>', loader: 'ts' } }),
            absWorkingDir: appDir,
            bundle: true,
            metafile: true,
            write: false,
            platform: 'node',
            format: 'esm',
            logLevel: 'silent',
            ...(existsSync(tsconfig) ? { tsconfig } : {}),
            loader: { '.css': 'empty', '.svg': 'empty', '.png': 'empty', '.jpg': 'empty', '.woff2': 'empty' },
            plugins: [
                {
                    name: 'sssb-check-e2e-external',
                    setup(build) {
                        // A bare specifier is followed when it lands outside node_modules or in framework source (as
                        // Playwright transforms it); every other package stays external, as Node would load it.
                        build.onResolve({ filter: /^[^./]/ }, async (args) => {
                            if (args.pluginData?.[PROBE] || KEEP.test(args.path)) return undefined
                            if (isBuiltin(args.path)) return { external: true }
                            const resolved = await build.resolve(args.path, {
                                kind: args.kind,
                                resolveDir: args.resolveDir,
                                importer: args.importer,
                                pluginData: { [PROBE]: true },
                            })
                            if (resolved.errors.length > 0 || resolved.external || !resolved.path)
                                return { external: true }
                            const target = real(resolved.path)
                            if (!underNodeModules(target) || kitRootOf(target) !== null) return { path: resolved.path }
                            return { path: args.path, external: true }
                        })
                    },
                },
            ],
        })
        return { ok: /** @type {const} */ (true), metafile: result.metafile }
    } catch (error) {
        const errors = /** @type {{ errors?: { text: string, location?: { file: string } | null }[] }} */ (error).errors
        const first = errors?.[0]
        return {
            ok: /** @type {const} */ (false),
            error: first
                ? `${first.text}${first.location ? ` (${first.location.file})` : ''}`
                : error instanceof Error
                  ? error.message
                  : String(error),
        }
    }
}

/**
 * What check-e2e reads of Playwright's JSON report (`playwright test --list --reporter=json`): a suite names its file,
 * relative to `config.rootDir`, and holds suites and specs; every path in `config` is absolute.
 * @typedef {{ file?: string, suites?: ListedSuite[], specs?: { file?: string }[] }} ListedSuite
 * @typedef {{
 *   config: { rootDir: string, globalSetup: string | null, globalTeardown: string | null,
 *     projects: { testDir: string }[] },
 *   suites: ListedSuite[], errors: { message?: string }[] }} ListReport
 */

/**
 * The app's own Playwright CLI, or why there is none.
 * @param {string} app
 * @returns {{ cli: string } | { error: string }}
 */
function playwrightCliOf(app) {
    try {
        const manifest = resolveFromApp(
            app,
            '@playwright/test/package.json',
            'lists the files its Playwright configs load',
        )
        const bin = JSON.parse(readFileSync(manifest, 'utf8')).bin
        const relative = typeof bin === 'string' ? bin : bin?.playwright
        if (typeof relative !== 'string') return { error: `${manifest} names no \`playwright\` bin` }
        return { cli: path.join(path.dirname(manifest), relative) }
    } catch (error) {
        return { error: error instanceof Error ? error.message : String(error) }
    }
}

/**
 * Asks the app's own Playwright which files one config loads: lists it from the app's directory, the JSON report
 * written to a temporary file.
 * @param {string} cli
 * @param {string} config absolute
 * @param {string} app
 * @returns {{ report: ListReport, status: number | null } | { error: string }}
 */
function listConfig(cli, config, app) {
    const out = mkdtempSync(path.join(tmpdir(), 'sssb-check-e2e-'))
    try {
        const json = path.join(out, 'list.json')
        /** @type {NodeJS.ProcessEnv} */
        const env = { ...process.env, PLAYWRIGHT_JSON_OUTPUT_FILE: json, FORCE_COLOR: '0' }
        delete env['PLAYWRIGHT_JSON_OUTPUT_DIR']
        delete env['PLAYWRIGHT_JSON_OUTPUT_NAME']
        const child = spawnSync(process.execPath, [cli, 'test', '--list', '--reporter=json', '--config', config], {
            cwd: app,
            env,
            encoding: 'utf8',
            timeout: 120_000,
            maxBuffer: 64 * 1024 * 1024,
        })
        if (existsSync(json)) return { report: JSON.parse(readFileSync(json, 'utf8')), status: child.status }
        // A config that does not load stops Playwright before any reporter: its error is on stderr. Node may print a
        // warning and the throwing source line first; the error itself is the line that names one.
        const said = plain(`${child.stderr ?? ''}\n${child.stdout ?? ''}`)
            .split('\n')
            .map((line) => line.trim())
            .filter((line) => line && !line.startsWith('at '))
        const thrown = said.filter((line) => /^([\w$.]*Error|Uncaught)\b/.test(line))
        const shown = (thrown.length > 0 ? thrown : said).slice(0, 3).join(' | ') || 'no output'
        return { error: `(exit ${child.status ?? child.signal}): ${child.error ? child.error.message : shown}` }
    } finally {
        rmSync(out, { recursive: true, force: true })
    }
}

/**
 * The absolute paths `text` names as `file://` URLs or quoted absolute paths.
 * @param {string} text
 */
function pathsNamedIn(text) {
    const found = new Set()
    for (const [url] of text.matchAll(/file:\/\/[^\s"'`)]+/g)) {
        try {
            found.add(fileURLToPath(url))
        } catch {
            // not a file URL after all
        }
    }
    for (const [, file] of text.matchAll(/["'`](\/[^"'`\s]+)["'`]/g)) if (file !== undefined) found.add(file)
    return [...found]
}

/**
 * The app's Playwright configs and every file Playwright says they load, as above. `extraConfigs` are `--config`
 * files, already absolute. `problems` holds each config Playwright cannot list or that lists no test. `kitFile`, when
 * given, says whether a path is a kit file a spec may not reach, and shows it: a listing error naming one says so.
 * @param {string} appDir
 * @param {string[]} [extraConfigs]
 * @param {(file: string) => string | null} [kitFile]
 * @returns {Promise<{ configs: string[], testDirs: string[], files: string[], problems: string[] }>}
 */
export async function playwrightFiles(appDir, extraConfigs = [], kitFile = () => null) {
    const app = real(appDir)
    const discovered = readdirSync(app)
        .filter((name) => CONFIG.test(name))
        .map((name) => path.join(app, name))
    const configs = [...new Set([...discovered, ...extraConfigs.map(real)])].sort()
    /** @param {string} file */
    const shown = (file) => path.relative(app, file) || '.'
    if (configs.length === 0) return { configs, testDirs: [], files: [], problems: [] }
    const files = new Set(configs)
    /** @type {Set<string>} */
    const testDirs = new Set()
    /** @type {string[]} */
    const problems = []
    const playwright = playwrightCliOf(app)
    if ('error' in playwright) {
        problems.push(`Playwright cannot be run from the app to list its configs: ${playwright.error}`)
        return { configs, testDirs: [], files: [...files].sort(), problems }
    }
    for (const config of configs) {
        const listed = listConfig(playwright.cli, config, app)
        if ('error' in listed) {
            problems.push(`${shown(config)} could not be listed by Playwright ${listed.error}`)
            continue
        }
        const { report, status } = listed
        const searched = [...new Set(report.config.projects.map((project) => project.testDir))].sort()
        const errors = [...new Set(report.errors.map((e) => plain(e.message ?? '').trim()).filter(Boolean))]
        const onlyNoTests = errors.length > 0 && errors.every((message) => message === 'Error: No tests found')
        if (errors.length > 0 && !onlyNoTests) {
            const reached = [...new Set(errors.flatMap(pathsNamedIn).map(kitFile))].filter((f) => f !== null).sort()
            problems.push(
                `${shown(config)} could not be listed by Playwright (exit ${status}): ` +
                    errors.map((message) => message.split('\n')[0]).join(' | ') +
                    reached
                        .map((f) => `${DETAIL}a file Playwright loads reaches ${f}, other than through ${ENTRY}`)
                        .join(''),
            )
            continue
        }
        for (const dir of searched) testDirs.add(dir)
        for (const script of [report.config.globalSetup, report.config.globalTeardown])
            if (script) files.add(real(script))
        /** @type {Set<string>} */
        const specs = new Set()
        /** @param {ListedSuite} suite */
        const collect = (suite) => {
            for (const file of [suite.file, ...(suite.specs ?? []).map((spec) => spec.file)])
                if (file) specs.add(real(path.resolve(report.config.rootDir, file)))
            for (const child of suite.suites ?? []) collect(child)
        }
        for (const suite of report.suites) collect(suite)
        if (specs.size === 0) {
            problems.push(
                `${shown(config)} lists no test (under ${searched.map(shown).join(', ')}): Playwright would find no tests in it`,
            )
        }
        for (const spec of specs) files.add(spec)
    }
    return { configs, testDirs: [...testDirs].sort(), files: [...files].sort(), problems }
}

/**
 * The real path of each input of a metafile, by its key (keys are relative to the app; `<entry>` is the stdin one).
 * @param {esbuild.Metafile} metafile
 * @param {string} appDir
 * @returns {Map<string, string>}
 */
function realPaths(metafile, appDir) {
    return new Map(
        Object.keys(metafile.inputs).map((key) => [key, key.startsWith('<') ? key : real(path.resolve(appDir, key))]),
    )
}

/**
 * The shortest import chain from `from` to `to` in a metafile, as metafile keys.
 * @param {esbuild.Metafile} metafile
 * @param {string} from
 * @param {string} to
 */
function chain(metafile, from, to) {
    /** @type {Map<string, string | null>} */
    const previous = new Map([[from, null]])
    const queue = [from]
    while (queue.length > 0) {
        const at = /** @type {string} */ (queue.shift())
        if (at === to) break
        for (const imported of metafile.inputs[at]?.imports ?? []) {
            if (imported.external || previous.has(imported.path) || !(imported.path in metafile.inputs)) continue
            previous.set(imported.path, at)
            queue.push(imported.path)
        }
    }
    /** @type {string[]} */
    const steps = []
    for (let at = /** @type {string | null | undefined} */ (to); at; at = previous.get(at)) steps.unshift(at)
    return steps[0] === from ? steps : [to]
}

/** @type {Map<string, typeof import('typescript')>} the app's own TypeScript, by app */
const typescripts = new Map()

/**
 * The `@sssb/kit` specifiers `file` writes as string literals in its CODE, outside the module specifier of an import or
 * export declaration and a type `import('…')` (esbuild follows the first, and neither a type-only declaration nor a type
 * import loads anything) and a `declare module` name. Read by the app's own TypeScript parser, as doctor reads the
 * app's tsconfig: comments are not code.
 * @param {string} app
 * @param {string} file
 * @param {string} text
 * @returns {string[]}
 */
function kitLiteralsInCode(app, file, text) {
    let ts = typescripts.get(app)
    if (ts === undefined) {
        const resolved = resolveFromApp(
            app,
            'typescript',
            'sssb check-e2e reads the files it follows for a kit specifier esbuild cannot see with',
        )
        ts = /** @type {typeof import('typescript')} */ (createRequire(import.meta.url)(resolved))
        typescripts.set(app, ts)
    }
    const ext = path.extname(file)
    const kind =
        ext === '.tsx'
            ? ts.ScriptKind.TSX
            : ext === '.jsx'
              ? ts.ScriptKind.JSX
              : /^\.[cm]?ts$/.test(ext)
                ? ts.ScriptKind.TS
                : ts.ScriptKind.JS
    const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, kind)
    /** @type {string[]} */
    const literals = []
    /** @param {import('typescript').Node} node */
    const visit = (node) => {
        if (
            (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) &&
            /^@sssb\/kit(\/|$)/.test(node.text)
        ) {
            const parent = node.parent
            const named =
                ((ts.isImportDeclaration(parent) || ts.isExportDeclaration(parent)) &&
                    parent.moduleSpecifier === node) ||
                // a string-literal TYPE (`type S = '@sssb/kit/…'`, an import('…') type's argument): a type loads nothing
                ts.isLiteralTypeNode(parent) ||
                // a NAME (an object-literal or class key, an interface member, a `declare module`): never a specifier
                ('name' in parent && parent.name === node)
            if (!named) literals.push(node.text)
        }
        ts.forEachChild(node, visit)
    }
    visit(source)
    return literals
}

/**
 * @typedef {{ file: string, error?: string, reached: { kitFile: string, via: string[] }[], count: number,
 *   unfollowed: string[], throughEntry: boolean }} SpecReach
 *   `reached`: the kit files outside the entry that the file enters the kit through (each with its import chain);
 *   `count`: every kit file outside the entry it reaches; `unfollowed`: a kit specifier named where esbuild cannot follow it
 *   that esbuild could not follow; `throughEntry`: whether it reaches the allowed entry at all
 */

/**
 * What `sssb check-e2e` checks, without printing: the entry, what it allows, and each file's reach.
 * @param {string} appDir
 * @param {string[]} [extraConfigs] `--config` files, absolute
 */
export async function e2eReach(appDir, extraConfigs = []) {
    const app = realpathSync(appDir)
    const root = realpathSync(workspaceRootOf(app))
    const kitDir = kitDirOf(app)
    const inRepo = isInRepoKit(kitDir, root)
    /** @param {string} file */
    const show = (file) => {
        const kitRoot = kitRootOf(file)
        if (kitRoot === null) return path.relative(app, file)
        const within = path.relative(kitRoot, file)
        return kitRoot === kitDir ? `${KIT}:${within}` : `${KIT}(${path.relative(app, kitRoot)}):${within}`
    }

    // The entry, alone: what it resolves to, its closure, and whether that closure touches the seam.
    const alone = await bundle({ appDir: app, entry: { contents: `export * from '${ENTRY}'\n` } })
    if (!alone.ok) throw new UsageError(`sssb check-e2e: ${ENTRY} does not bundle from ${app}: ${alone.error}`)
    const entryReal = realPaths(alone.metafile, app)
    const closure = [...entryReal.values()].filter((file) => inside(file, kitDir))
    const entryKey = alone.metafile.inputs['<entry>']?.imports.find((i) => !i.external)?.path
    const entryFile = entryKey === undefined ? undefined : entryReal.get(entryKey)
    if (entryFile === undefined || !inside(entryFile, kitDir)) {
        throw new UsageError(`sssb check-e2e: ${ENTRY} does not resolve into the @sssb/kit ${app} resolves (${kitDir})`)
    }
    /** @type {string[]} */
    const entryProblems = []
    const seams = [seamOfKit(kitDir), real(path.join(app, 'src', 'app-config'))].filter((s) => s !== null)
    for (const [key, input] of Object.entries(alone.metafile.inputs)) {
        for (const imported of input.imports) {
            if (/^@sssb\/app-config(\/|$)/.test(imported.original ?? ''))
                entryProblems.push(`${show(entryReal.get(key) ?? key)} imports ${imported.original}`)
        }
        const file = entryReal.get(key) ?? key
        if (seams.some((seam) => inside(file, seam))) entryProblems.push(`${show(file)} is a seam module`)
    }
    // An installed kit's entry is compiled into one file: only that file is allowed. In-repo, its source closure. By
    // the path within the kit, so the same file of another copy (a sibling package's own install) is allowed too.
    const allowed = new Set((inRepo ? closure : [entryFile]).map((file) => path.relative(kitDir, file)))
    if (!inRepo) {
        for (const file of closure)
            if (file !== entryFile) entryProblems.push(`the compiled entry reaches another kit file, ${show(file)}`)
    }
    /** @param {string} file */
    const isKit = (file) => kitRootOf(file) !== null
    /** @param {string} file */
    const isAllowed = (file) => {
        const kitRoot = kitRootOf(file)
        return kitRoot !== null && allowed.has(path.relative(kitRoot, file))
    }

    const {
        configs,
        testDirs,
        files,
        problems: configProblems,
    } = await playwrightFiles(app, extraConfigs, (file) =>
        isKit(real(file)) && !isAllowed(real(file)) ? show(real(file)) : null,
    )
    /** @type {SpecReach[]} */
    const reach = []
    for (const file of files) {
        const result = await bundle({ appDir: app, entry: { file } })
        if (!result.ok) {
            reach.push({
                file: path.relative(app, file),
                error: result.error,
                reached: [],
                count: 0,
                unfollowed: [],
                throughEntry: false,
            })
            continue
        }
        const realOf = realPaths(result.metafile, app)
        const outside = new Set([...realOf].filter(([, f]) => isKit(f) && !isAllowed(f)).map(([key]) => key))
        const fromKey = path.relative(app, file).split(path.sep).join('/')
        const start = fromKey in result.metafile.inputs ? fromKey : (Object.keys(result.metafile.inputs)[0] ?? fromKey)
        // Report where the file ENTERS the kit: an outside kit file imported by a file that is not part of the kit.
        const entered = [...outside].filter((key) =>
            Object.entries(result.metafile.inputs).some(
                ([importer, input]) =>
                    !isKit(realOf.get(importer) ?? importer) &&
                    input.imports.some((i) => i.path === key && !i.external),
            ),
        )
        // What esbuild cannot see: a kit specifier written in the code of a followed file outside the kit, which it did not
        // resolve as an import (a `createRequire(...)` function, a `require` of a variable).
        /** @type {string[]} */
        const unfollowed = []
        for (const [key, input] of Object.entries(result.metafile.inputs)) {
            const source = realOf.get(key) ?? key
            if (!path.isAbsolute(source) || isKit(source) || underNodeModules(source)) continue
            const text = readFileSync(source, 'utf8')
            const seen = new Set(input.imports.map((i) => i.original))
            for (const specifier of kitLiteralsInCode(app, source, text)) {
                if (!loadsNoFramework(specifier) && !seen.has(specifier))
                    unfollowed.push(`${show(source)} names '${specifier}' where esbuild cannot follow it`)
            }
        }
        reach.push({
            file: path.relative(app, file),
            reached: (entered.length ? entered : [...outside]).sort().map((key) => ({
                kitFile: show(realOf.get(key) ?? key),
                via: chain(result.metafile, start, key).map((k) => show(realOf.get(k) ?? k)),
            })),
            count: outside.size,
            unfollowed: [...new Set(unfollowed)].sort(),
            throughEntry: [...realOf.values()].some(isAllowed),
        })
    }
    return {
        app,
        root,
        kitDir,
        inRepo,
        entryFile: show(entryFile),
        allowed: [...allowed].map((within) => `${KIT}:${within}`).sort(),
        entryProblems,
        configs: configs.map((c) => path.relative(app, c)),
        testDirs: testDirs.map((d) => path.relative(app, d) || '.'),
        configProblems,
        reach,
    }
}

/** @param {string[]} args */
export async function run(args) {
    const appDir = takeAppDir(args)
    /** @type {string[]} */
    const extraConfigs = []
    for (let config = takeOption(args, '--config'); config !== undefined; config = takeOption(args, '--config')) {
        const file = path.resolve(config)
        if (!existsSync(file)) throw new UsageError(`sssb check-e2e: --config ${config}: no such file`)
        extraConfigs.push(file)
    }
    if (args.length > 0) throw new UsageError(`sssb check-e2e: unknown argument ${args[0]} (${USAGE})`)
    const r = await e2eReach(appDir, extraConfigs)
    if (r.configs.length === 0) {
        console.log(`sssb check-e2e: ${path.relative(r.root, r.app)} has no Playwright config: nothing to check`)
        return 0
    }
    console.log(
        `sssb check-e2e: ${path.relative(r.root, r.app) || '.'}: ${r.reach.length} file(s) Playwright loads ` +
            `(${r.configs.join(', ')}; under ${r.testDirs.join(', ') || 'no testDir'}); ${ENTRY} is ${r.entryFile}` +
            (r.inRepo ? ` (in-repo mode: its source closure is allowed: ${r.allowed.join(', ')})` : ''),
    )
    let problems = 0
    for (const problem of r.configProblems) {
        problems++
        console.log(`FAIL    ${problem}`)
    }
    for (const problem of r.entryProblems) {
        problems++
        console.log(`FAIL    ${ENTRY} is not seam-free: ${problem}`)
    }
    for (const spec of r.reach) {
        if (spec.error !== undefined) {
            problems++
            console.log(`FAIL    ${spec.file}: could not be bundled: ${spec.error}`)
            continue
        }
        if (spec.count > 0) {
            problems++
            console.log(`FAIL    ${spec.file} reaches ${spec.count} @sssb/kit file(s) other than ${ENTRY}:`)
            for (const { kitFile, via } of spec.reached) console.log(`          ${kitFile}  (${via.join(' -> ')})`)
        }
        if (spec.unfollowed.length > 0) {
            problems++
            console.log(`FAIL    ${spec.file} loads @sssb/kit where esbuild cannot follow:`)
            for (const line of spec.unfollowed) console.log(`          ${line}`)
        }
        if (spec.count === 0 && spec.unfollowed.length === 0)
            console.log(`ok      ${spec.file}${spec.throughEntry ? `  (reaches the kit through ${ENTRY})` : ''}`)
    }
    const reaching = r.reach.some((spec) => spec.count > 0 || spec.unfollowed.length > 0)
    console.log(
        problems === 0
            ? `sssb check-e2e: ok, no file reaches @sssb/kit other than through ${ENTRY}`
            : `sssb check-e2e: ${problems} problem(s)` +
                  (reaching ? `: a spec may reach the kit only through ${ENTRY}, which Node can load` : ''),
    )
    return problems === 0 ? 0 : 1
}
