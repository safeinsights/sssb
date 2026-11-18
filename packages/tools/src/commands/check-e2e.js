// @ts-check
// `sssb check-e2e [--app <dir>]`: fails when an e2e spec reaches the framework other than through
// `@sssb/kit/testing/e2e` (ADR-0014 part 2).
//
// Playwright loads specs with Node. In an adopter's workspace the framework is TypeScript under node_modules, which
// Node will not strip, and its modules read the app's seam (`@sssb/app-config/*`), which Node cannot resolve the way a
// bundler does. So the one entry a spec may reach is `@sssb/kit/testing/e2e`, which ships compiled and seam-free. A
// lint ban on direct imports is not enough, because a spec reaches the kit indirectly too (the showcase's
// tickets-pagination spec imports the app's src/domain/tickets, which imported the kit's state machine). So this
// BUNDLES every file the app's Playwright configs load with esbuild (the app's tsconfig `paths` honoured, a metafile
// kept, every package but the kit, the seam and the app's own files left external) and fails, naming spec and kit
// file, for any kit file reached other than that entry.
//
// WHICH FILES: each Playwright config of the app (`playwright.config.*`, `playwright.<name>.config.*`), its
// `globalSetup`/`globalTeardown` when written as a string, and every script under each `testDir` the config names,
// specs and support modules alike (a non-spec file there is a module specs import). A config naming no `testDir`
// uses Playwright's default: the config's directory, files matching `*.spec.*` or `*.test.*`. The configs are read,
// not run: running one starts nothing, but they are code (they read ports and check for a ticking dev server).
//
// THE ENTRY: whatever `@sssb/kit/testing/e2e` resolves to from the app. For an installed kit that is the compiled
// `dist/testing/e2e.js`, and only that file is allowed. In IN-REPO MODE (SSSB's own repository, where the apps'
// tsconfig `paths` send `@sssb/kit/*` to packages/kit/src) it is the entry's source, so the entry's own source closure,
// computed by bundling the entry alone, is allowed, and that closure must itself reach no `@sssb/app-config` module.
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { isBuiltin } from 'node:module'
import path from 'node:path'
import * as esbuild from 'esbuild'
import { takeAppDir, UsageError, workspaceRootOf } from '../app.js'
import { kitDirOf } from '../kit.js'
import { isInRepoKit, seamOfKit } from './doctor-checks.js'

const KIT = '@sssb/kit'
const ENTRY = `${KIT}/testing/e2e`
const KEEP = /^@sssb\/(kit|app-config)(\/|$)/
const PROBE = 'sssbCheckE2eProbe'
const SCRIPT = /\.(c|m)?[jt]sx?$/
const DEFAULT_TEST_MATCH = /\.(spec|test)\.(c|m)?[jt]sx?$/
const CONFIG = /^playwright(\.[\w-]+)?\.config\.(c|m)?[jt]s$/

/** @param {string} child @param {string} parent */
const inside = (child, parent) => child === parent || child.startsWith(parent + path.sep)

/** @param {string} file */
const real = (file) => (existsSync(file) ? realpathSync(file) : path.resolve(file))

/**
 * Every script file under `dir`, skipping node_modules and dot-directories.
 * @param {string} dir
 * @param {RegExp} match
 * @returns {string[]}
 */
function scriptsUnder(dir, match) {
    if (!existsSync(dir) || !statSync(dir).isDirectory()) return []
    /** @type {string[]} */
    const out = []
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue
        const full = path.join(dir, entry.name)
        if (entry.isDirectory()) out.push(...scriptsUnder(full, match))
        else if (match.test(entry.name) && !entry.name.endsWith('.d.ts')) out.push(full)
    }
    return out
}

/**
 * The app's Playwright configs and every file they load, as above.
 * @param {string} appDir
 * @returns {{ configs: string[], testDirs: string[], files: string[] }}
 */
export function playwrightFiles(appDir) {
    const configs = readdirSync(appDir)
        .filter((name) => CONFIG.test(name))
        .sort()
        .map((name) => path.join(appDir, name))
    const files = new Set(configs)
    const testDirs = new Set()
    for (const config of configs) {
        const text = readFileSync(config, 'utf8')
        const dirs = [...text.matchAll(/\btestDir\s*:\s*(['"`])([^'"`]+)\1/g)].map((m) =>
            path.resolve(appDir, m[2] ?? ''),
        )
        for (const m of text.matchAll(/\bglobal(?:Setup|Teardown)\s*:\s*(['"`])([^'"`]+)\1/g)) {
            const file = path.resolve(appDir, m[2] ?? '')
            if (existsSync(file)) files.add(file)
        }
        if (dirs.length === 0) {
            testDirs.add(appDir)
            for (const file of scriptsUnder(appDir, DEFAULT_TEST_MATCH)) files.add(file)
        }
        for (const dir of dirs) {
            testDirs.add(dir)
            for (const file of scriptsUnder(dir, SCRIPT)) files.add(file)
        }
    }
    return { configs, testDirs: [...testDirs].sort(), files: [...files].sort() }
}

/**
 * Bundles one entry the way check-e2e reads it, and returns esbuild's metafile, or the error that stopped it.
 * @param {{ appDir: string, kitDir: string, entry: { file: string } | { contents: string } }} options
 */
async function bundle({ appDir, kitDir, entry }) {
    const tsconfig = path.join(appDir, 'tsconfig.json')
    try {
        const result = await esbuild.build({
            ...('file' in entry
                ? { entryPoints: [entry.file] }
                : { stdin: { contents: entry.contents, resolveDir: appDir, sourcefile: '<entry>', loader: 'ts' } }),
            absWorkingDir: appDir,
            bundle: true,
            write: false,
            metafile: true,
            platform: 'node',
            format: 'esm',
            logLevel: 'silent',
            ...(existsSync(tsconfig) ? { tsconfig } : {}),
            loader: { '.css': 'empty', '.svg': 'empty', '.png': 'empty', '.jpg': 'empty', '.woff2': 'empty' },
            plugins: [
                {
                    name: 'sssb-check-e2e-external',
                    setup(build) {
                        // A bare specifier is bundled only when it is the kit, the seam, or lands in the app's own
                        // files (its `@/` alias); every other package stays external, as Node would load it.
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
                            const own = inside(target, appDir) && !target.split(path.sep).includes('node_modules')
                            return own || inside(target, kitDir) ? { path: resolved.path } : { external: true }
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

/**
 * @typedef {{ file: string, error?: string, reached: { kitFile: string, via: string[] }[], count: number }} SpecReach
 *   `reached`: the kit files outside the entry that the file enters the kit through (each with its import chain);
 *   `count`: every kit file outside the entry it reaches
 */

/**
 * What `sssb check-e2e` checks, without printing: the entry, what it allows, and each file's reach.
 * @param {string} appDir
 */
export async function e2eReach(appDir) {
    const app = realpathSync(appDir)
    const root = realpathSync(workspaceRootOf(app))
    const kitDir = kitDirOf(app)
    const inRepo = isInRepoKit(kitDir, root)
    /** @param {string} file */
    const show = (file) => (inside(file, kitDir) ? `${KIT}:${path.relative(kitDir, file)}` : path.relative(app, file))

    // The entry, alone: what it resolves to, its closure, and whether that closure touches the seam.
    const alone = await bundle({ appDir: app, kitDir, entry: { contents: `export * from '${ENTRY}'\n` } })
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
    // An installed kit's entry is compiled into one file: only that file is allowed. In-repo, its source closure.
    const allowed = new Set(inRepo ? closure : [entryFile])
    if (!inRepo) {
        for (const file of closure)
            if (file !== entryFile) entryProblems.push(`the compiled entry reaches another kit file, ${show(file)}`)
    }

    const { configs, testDirs, files } = playwrightFiles(app)
    /** @type {SpecReach[]} */
    const reach = []
    for (const file of files) {
        const result = await bundle({ appDir: app, kitDir, entry: { file } })
        if (!result.ok) {
            reach.push({ file: path.relative(app, file), error: result.error, reached: [], count: 0 })
            continue
        }
        const realOf = realPaths(result.metafile, app)
        const outside = new Set([...realOf].filter(([, f]) => inside(f, kitDir) && !allowed.has(f)).map(([key]) => key))
        const fromKey = path.relative(app, file).split(path.sep).join('/')
        const start = fromKey in result.metafile.inputs ? fromKey : (Object.keys(result.metafile.inputs)[0] ?? fromKey)
        // Report where the file ENTERS the kit: an outside kit file imported by a file that is not part of the kit.
        const entered = [...outside].filter((key) =>
            Object.entries(result.metafile.inputs).some(
                ([importer, input]) =>
                    !inside(realOf.get(importer) ?? importer, kitDir) &&
                    input.imports.some((i) => i.path === key && !i.external),
            ),
        )
        reach.push({
            file: path.relative(app, file),
            reached: (entered.length ? entered : [...outside]).sort().map((key) => ({
                kitFile: show(realOf.get(key) ?? key),
                via: chain(result.metafile, start, key).map((k) => show(realOf.get(k) ?? k)),
            })),
            count: outside.size,
        })
    }
    return {
        app,
        root,
        kitDir,
        inRepo,
        entryFile: show(entryFile),
        allowed: [...allowed].map(show).sort(),
        entryProblems,
        configs: configs.map((c) => path.relative(app, c)),
        testDirs: testDirs.map((d) => path.relative(app, d) || '.'),
        reach,
    }
}

/** @param {string[]} args */
export async function run(args) {
    const appDir = takeAppDir(args)
    if (args.length > 0)
        throw new UsageError(`sssb check-e2e: unknown argument ${args[0]} (usage: check-e2e [--app <dir>])`)
    const r = await e2eReach(appDir)
    if (r.configs.length === 0) {
        console.log(`sssb check-e2e: ${path.relative(r.root, r.app)} has no Playwright config: nothing to check`)
        return 0
    }
    console.log(
        `sssb check-e2e: ${path.relative(r.root, r.app) || '.'}: ${r.reach.length} file(s) Playwright loads ` +
            `(${r.configs.join(', ')}; under ${r.testDirs.join(', ')}); ${ENTRY} is ${r.entryFile}` +
            (r.inRepo ? ` (in-repo mode: its source closure is allowed: ${r.allowed.join(', ')})` : ''),
    )
    let problems = 0
    for (const problem of r.entryProblems) {
        problems++
        console.log(`FAIL    ${ENTRY} is not seam-free: ${problem}`)
    }
    for (const spec of r.reach) {
        if (spec.error !== undefined) {
            problems++
            console.log(`FAIL    ${spec.file}: could not be bundled: ${spec.error}`)
        } else if (spec.count > 0) {
            problems++
            console.log(`FAIL    ${spec.file} reaches ${spec.count} @sssb/kit file(s) other than ${ENTRY}:`)
            for (const { kitFile, via } of spec.reached) console.log(`          ${kitFile}  (${via.join(' -> ')})`)
        }
    }
    console.log(
        problems === 0
            ? `sssb check-e2e: ok, no file reaches @sssb/kit other than through ${ENTRY}`
            : `sssb check-e2e: ${problems} problem(s): a spec may reach the kit only through ${ENTRY}, which Node can load`,
    )
    return problems === 0 ? 0 : 1
}
