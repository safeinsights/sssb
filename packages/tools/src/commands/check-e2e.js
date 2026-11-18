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
// see is followed like an import. A function made by `createRequire(...)` it cannot see through, so a followed file
// outside the kit that mentions `createRequire` and names, as a string literal, an `@sssb/kit` specifier esbuild did
// not resolve (other than the entry) fails too. A computed specifier stays out of reach of any static check.
//
// WHICH FILES: each Playwright config of the app (`playwright.config.*`, `playwright.<name>.config.*` in its
// directory), plus each `--config <file>` given (repeatable, relative to the working directory, as `playwright test -c`
// takes one: for a config kept outside the app's directory). Each config is LOADED, as Playwright loads it: bundled
// by esbuild into a temporary module and imported by a child Node process (a config is code: it may compute
// `testDir`, read ports, or refuse to load while a ticking dev server's marker is live; Playwright runs it all the
// same). From the loaded config, Playwright's own resolution: one project per entry of `projects` (the config itself
// when it has none), each with its `testDir`, `testMatch` and `testIgnore` (the project's, else the config's, else
// Playwright's defaults: the config's directory, `**/*.@(spec|test).?(c|m)[jt]s?(x)`, nothing), matched as Playwright
// matches them (globs against the absolute path, case-insensitive, dotfiles included; RegExps as given), skipping
// node_modules; and `globalSetup` and `globalTeardown`, a string or an array. The checked files are the configs,
// their global scripts and the matched specs; a support module is checked through every spec that imports it. A
// config that does not load, or matches no spec file at all, fails: Playwright would find no tests in it either. One
// approximation: where Playwright honours `.gitignore` (a project with no `testDir` anywhere), this does not, so it
// may check a file Playwright would skip, never the reverse.
//
// THE ENTRY: whatever `@sssb/kit/testing/e2e` resolves to from the app. For an installed kit that is the compiled
// `dist/testing/e2e.js`, and only that file is allowed (in any copy of the kit a sibling package installs). In IN-REPO
// MODE (SSSB's own repository, where the apps' tsconfig `paths` send `@sssb/kit/*` to packages/kit/src) it is the
// entry's source, so the entry's own source closure, computed by bundling the entry alone, is allowed, and that
// closure must itself reach no `@sssb/app-config` module.
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync } from 'node:fs'
import { createRequire, isBuiltin } from 'node:module'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import * as esbuild from 'esbuild'
import { takeAppDir, takeOption, UsageError, workspaceRootOf } from '../app.js'
import { kitDirOf } from '../kit.js'
import { isInRepoKit, seamOfKit } from './doctor-checks.js'

const KIT = '@sssb/kit'
const ENTRY = `${KIT}/testing/e2e`
const KEEP = /^@sssb\/(kit|app-config)(\/|$)/
const PROBE = 'sssbCheckE2eProbe'
const CONFIG = /^playwright(\.[\w-]+)?\.config\.(c|m)?[jt]s$/
const USAGE = 'usage: check-e2e [--app <dir>] [--config <file>]...'
/** Playwright's own default `testMatch`, and the extensions it considers a test file at all. */
const DEFAULT_TEST_MATCH = '**/*.@(spec|test).?(c|m)[jt]s?(x)'
const TEST_EXTENSIONS = new Set([
    '.js',
    '.ts',
    '.mjs',
    '.mts',
    '.cjs',
    '.cts',
    '.jsx',
    '.tsx',
    '.mjsx',
    '.mtsx',
    '.cjsx',
    '.ctsx',
])

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
 * A Playwright `testMatch`/`testIgnore` value as the child process hands it over: RegExps as `{ regexp, flags }`.
 * @typedef {string | { regexp: string, flags: string }} Pattern
 */

/**
 * Playwright's `createFileMatcher`: a RegExp is tested against the absolute path; a glob is prefixed with `**` unless
 * it starts with one and matched by minimatch with `{ nocase: true, dot: true }`. Node's `path.matchesGlob` takes no
 * options, so case is folded on both sides, and a path segment starting with a dot is also tried without it (what
 * `dot: true` buys: a `*` or `**` matching such a segment).
 * @param {Pattern | Pattern[]} patterns
 * @returns {(file: string) => boolean}
 */
export function fileMatcher(patterns) {
    /** @type {RegExp[]} */
    const regexps = []
    /** @type {string[]} */
    const globs = []
    for (const pattern of Array.isArray(patterns) ? patterns : [patterns]) {
        if (typeof pattern === 'string')
            globs.push((pattern.startsWith('**/') ? pattern : `**/${pattern}`).toLowerCase())
        else regexps.push(new RegExp(pattern.regexp, pattern.flags))
    }
    return (file) => {
        for (const re of regexps) {
            re.lastIndex = 0
            if (re.test(file)) return true
        }
        const folded = file.toLowerCase()
        const undotted = folded
            .split('/')
            .map((segment) => (segment.startsWith('.') ? `\u0001${segment.slice(1)}` : segment))
            .join('/')
        return globs.some(
            (glob) => path.matchesGlob(folded, glob) || (undotted !== folded && path.matchesGlob(undotted, glob)),
        )
    }
}

/**
 * Every file under `dir`, as Playwright's collector walks it: node_modules skipped, dot-directories not.
 * @param {string} dir
 * @returns {string[]}
 */
function filesUnder(dir) {
    if (!existsSync(dir) || !statSync(dir).isDirectory()) return []
    /** @type {string[]} */
    const out = []
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name)
        if (entry.isDirectory()) {
            if (entry.name !== 'node_modules') out.push(...filesUnder(full))
        } else if (entry.isFile()) out.push(full)
    }
    return out
}

/**
 * Bundles one entry the way check-e2e reads it, and returns esbuild's metafile, or the error that stopped it. With
 * `outfile`, the bundle is also written there to be RUN (a Playwright config): every bundled file that names
 * `import.meta`, `__dirname` or `__filename` gets its own location defined in, since the bundle runs from elsewhere,
 * and `require` is defined for what stays external.
 * @param {{ appDir: string, entry: { file: string } | { contents: string }, outfile?: string }} options
 */
async function bundle({ appDir, entry, outfile }) {
    const tsconfig = path.join(appDir, 'tsconfig.json')
    try {
        const result = await esbuild.build({
            ...('file' in entry
                ? { entryPoints: [entry.file] }
                : { stdin: { contents: entry.contents, resolveDir: appDir, sourcefile: '<entry>', loader: 'ts' } }),
            absWorkingDir: appDir,
            bundle: true,
            metafile: true,
            platform: 'node',
            format: 'esm',
            logLevel: 'silent',
            ...(outfile
                ? {
                      outfile,
                      write: true,
                      banner: {
                          js: "import { createRequire as sssbCreateRequire } from 'node:module'\nconst require = sssbCreateRequire(import.meta.url)",
                      },
                  }
                : { write: false }),
            ...(existsSync(tsconfig) ? { tsconfig } : {}),
            loader: { '.css': 'empty', '.svg': 'empty', '.png': 'empty', '.jpg': 'empty', '.woff2': 'empty' },
            plugins: [
                {
                    name: 'sssb-check-e2e-external',
                    setup(build) {
                        if (outfile) {
                            build.onLoad({ filter: /\.[cm]?[jt]sx?$/ }, async (args) => {
                                const text = readFileSync(args.path, 'utf8')
                                if (!/import\.meta|__dirname|__filename/.test(text)) return undefined
                                const ext = path.extname(args.path).replace(/^\.[cm]?/, '.')
                                const loader =
                                    ext === '.tsx' ? 'tsx' : ext === '.ts' ? 'ts' : ext === '.jsx' ? 'jsx' : 'js'
                                const meta = {
                                    url: pathToFileURL(args.path).href,
                                    dirname: path.dirname(args.path),
                                    filename: args.path,
                                }
                                // A define replaces free references only: a file's own `const __dirname = …` stays.
                                const { code } = await esbuild.transform(text, {
                                    loader,
                                    format: 'esm',
                                    jsx: 'preserve',
                                    sourcefile: args.path,
                                    define: {
                                        'import.meta': JSON.stringify(meta),
                                        __dirname: JSON.stringify(meta.dirname),
                                        __filename: JSON.stringify(meta.filename),
                                    },
                                    logLevel: 'silent',
                                })
                                return { contents: code, loader: loader === 'tsx' || loader === 'jsx' ? 'jsx' : 'js' }
                            })
                        }
                        // A bare specifier is followed when it lands outside node_modules or in framework source (as
                        // Playwright transforms it); every other package stays external, as Node would load it, by the
                        // URL of the file esbuild resolved it to, so a written bundle loads it from where it sits.
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
                            return { path: pathToFileURL(target).href, external: true }
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
 * The child process that imports a bundled config and writes what check-e2e needs of it as JSON (argv: the bundle,
 * the output file). Playwright's own unwrapping: the module's `default` when it has one, else the module. It exits
 * itself, so a config that leaves a timer or a handle open cannot hang the check.
 */
const LOADER = `
import { writeFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
const [bundled, out] = process.argv.slice(1)
let config = await import(pathToFileURL(bundled).href)
if (config && typeof config === 'object') config = 'default' in config ? config.default : { ...config }
const pattern = (v) =>
    v instanceof RegExp ? { regexp: v.source, flags: v.flags }
    : Array.isArray(v) ? v.map(pattern)
    : v === undefined || typeof v === 'string' ? v
    : { unsupported: typeof v }
const scripts = (v) => (v === undefined || typeof v === 'string' || Array.isArray(v) ? v : { unsupported: typeof v })
const pick = (o) => ({
    testDir: o?.testDir,
    testMatch: pattern(o?.testMatch),
    testIgnore: pattern(o?.testIgnore),
})
writeFileSync(out, JSON.stringify({
    isObject: !!config && typeof config === 'object',
    ...pick(config),
    globalSetup: scripts(config?.globalSetup),
    globalTeardown: scripts(config?.globalTeardown),
    projects: Array.isArray(config?.projects) ? config.projects.map((p) => ({ name: p?.name, ...pick(p) })) : null,
}))
process.exit(0)
`

/**
 * @typedef {{ testDir?: unknown, testMatch?: unknown, testIgnore?: unknown }} LoadedProject
 * @typedef {LoadedProject & { isObject: boolean, globalSetup?: unknown, globalTeardown?: unknown,
 *   projects: (LoadedProject & { name?: unknown })[] | null }} LoadedConfig
 */

/**
 * Loads one Playwright config as Playwright would run it: bundled, then imported by a child Node process.
 * @param {string} config
 * @param {string} appDir
 * @returns {Promise<{ config: LoadedConfig } | { error: string }>}
 */
async function loadConfig(config, appDir) {
    const out = mkdtempSync(path.join(tmpdir(), 'sssb-check-e2e-'))
    try {
        const outfile = path.join(out, 'config.mjs')
        const built = await bundle({ appDir, entry: { file: config }, outfile })
        if (!built.ok) return { error: `could not be bundled: ${built.error}` }
        const json = path.join(out, 'config.json')
        const child = spawnSync(process.execPath, ['--input-type=module', '-e', LOADER, outfile, json], {
            cwd: appDir,
            env: process.env,
            encoding: 'utf8',
            timeout: 60_000,
        })
        if (child.status !== 0 || !existsSync(json)) {
            const said = `${child.stderr ?? ''}\n${child.stdout ?? ''}`
                .split('\n')
                .map((line) => line.trim())
                .filter((line) => line && !line.startsWith('at '))
            // Node prints the throwing source line first; the error itself is the line that names one.
            const thrown = said.filter((line) => /^([\w$.]*Error|Uncaught)\b/.test(line))
            const shown = (thrown.length > 0 ? thrown : said).slice(0, 3).join(' | ') || 'no output'
            return { error: `could not be loaded (exit ${child.status ?? child.signal}): ${shown}` }
        }
        return { config: JSON.parse(readFileSync(json, 'utf8')) }
    } finally {
        rmSync(out, { recursive: true, force: true })
    }
}

/**
 * A `testMatch`/`testIgnore` value as loaded, or why it cannot be used.
 * @param {unknown} value
 * @param {Pattern | Pattern[]} fallback
 * @returns {Pattern | Pattern[] | string}
 */
function patternOf(value, fallback) {
    if (value === undefined) return fallback
    /** @param {unknown} v */
    const ok = (v) =>
        typeof v === 'string' || (typeof v === 'object' && v !== null && 'regexp' in v && typeof v.regexp === 'string')
    if (ok(value) || (Array.isArray(value) && value.every(ok))) return /** @type {Pattern | Pattern[]} */ (value)
    return `unsupported (${JSON.stringify(value)})`
}

/**
 * The app's Playwright configs and every file they load, as above. `extraConfigs` are `--config` files, already
 * absolute. `problems` holds each config that does not load, names something unusable, or matches no spec file.
 * @param {string} appDir
 * @param {string[]} [extraConfigs]
 * @returns {Promise<{ configs: string[], testDirs: string[], files: string[], problems: string[] }>}
 */
export async function playwrightFiles(appDir, extraConfigs = []) {
    const app = real(appDir)
    const discovered = readdirSync(app)
        .filter((name) => CONFIG.test(name))
        .map((name) => path.join(app, name))
    const configs = [...new Set([...discovered, ...extraConfigs.map(real)])].sort()
    /** @param {string} file */
    const shown = (file) => path.relative(app, file) || '.'
    const files = new Set(configs)
    /** @type {Set<string>} */
    const testDirs = new Set()
    /** @type {string[]} */
    const problems = []
    for (const config of configs) {
        const loaded = await loadConfig(config, app)
        if ('error' in loaded) {
            problems.push(`${shown(config)} ${loaded.error}`)
            continue
        }
        const c = loaded.config
        if (!c.isObject) {
            problems.push(`${shown(config)} does not export a config object`)
            continue
        }
        const configDir = path.dirname(config)
        for (const key of /** @type {const} */ (['globalSetup', 'globalTeardown'])) {
            const value = c[key]
            const ids = value === undefined ? [] : Array.isArray(value) ? value : [value]
            for (const id of ids) {
                if (!id) continue
                if (typeof id !== 'string') {
                    problems.push(`${shown(config)}: ${key} is ${JSON.stringify(id)}, not a path`)
                    continue
                }
                // Playwright's resolveScript: a path from the config's directory, else a module resolved from there.
                const local = path.resolve(configDir, id)
                if (existsSync(local)) files.add(real(local))
                else {
                    try {
                        files.add(real(createRequire(path.join(configDir, 'package.json')).resolve(id)))
                    } catch {
                        problems.push(`${shown(config)}: ${key} ${id} resolves to no file`)
                    }
                }
            }
        }
        /** @type {Set<string>} */
        const specs = new Set()
        /** @type {string[]} */
        const searched = []
        for (const project of c.projects ?? [c]) {
            const dirOf = /** @param {unknown} d */ (d) =>
                typeof d === 'string' ? path.resolve(configDir, d) : undefined
            if (
                (project.testDir !== undefined && typeof project.testDir !== 'string') ||
                (c.testDir !== undefined && typeof c.testDir !== 'string')
            ) {
                problems.push(`${shown(config)}: a testDir is not a string`)
                continue
            }
            const testDir = dirOf(project.testDir) ?? dirOf(c.testDir) ?? configDir
            const testMatch = patternOf(project.testMatch ?? c.testMatch, DEFAULT_TEST_MATCH)
            const testIgnore = patternOf(project.testIgnore ?? c.testIgnore, [])
            if (typeof testMatch === 'string' && testMatch.startsWith('unsupported')) {
                problems.push(`${shown(config)}: testMatch is ${testMatch}`)
                continue
            }
            if (typeof testIgnore === 'string' && testIgnore.startsWith('unsupported')) {
                problems.push(`${shown(config)}: testIgnore is ${testIgnore}`)
                continue
            }
            testDirs.add(testDir)
            searched.push(shown(testDir))
            const match = fileMatcher(testMatch)
            const ignore = fileMatcher(testIgnore)
            for (const file of filesUnder(testDir)) {
                if (TEST_EXTENSIONS.has(path.extname(file)) && !ignore(file) && match(file)) specs.add(file)
            }
        }
        if (specs.size === 0 && searched.length > 0) {
            problems.push(
                `${shown(config)} matches no spec file (under ${[...new Set(searched)].join(', ')}): Playwright would find no tests`,
            )
        }
        for (const spec of specs) files.add(real(spec))
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

/** An `@sssb/kit` specifier written as a string literal. */
const KIT_LITERAL = /(['"`])(@sssb\/kit(?:\/[\w./-]*)?)\1/g

/**
 * @typedef {{ file: string, error?: string, reached: { kitFile: string, via: string[] }[], count: number,
 *   unfollowed: string[], throughEntry: boolean }} SpecReach
 *   `reached`: the kit files outside the entry that the file enters the kit through (each with its import chain);
 *   `count`: every kit file outside the entry it reaches; `unfollowed`: a kit specifier named beside `createRequire`
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

    const { configs, testDirs, files, problems: configProblems } = await playwrightFiles(app, extraConfigs)
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
        // What esbuild cannot see: a kit specifier beside `createRequire` in a followed file outside the kit.
        /** @type {string[]} */
        const unfollowed = []
        for (const [key, input] of Object.entries(result.metafile.inputs)) {
            const source = realOf.get(key) ?? key
            if (!path.isAbsolute(source) || isKit(source) || underNodeModules(source)) continue
            const text = readFileSync(source, 'utf8')
            if (!/\bcreateRequire\b/.test(text)) continue
            const seen = new Set(input.imports.map((i) => i.original))
            for (const [, , specifier] of text.matchAll(KIT_LITERAL)) {
                if (specifier !== undefined && specifier !== ENTRY && !seen.has(specifier))
                    unfollowed.push(`${show(source)} names '${specifier}' beside createRequire`)
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
