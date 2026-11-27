// @ts-check
// `sssb check-real-env`: the `dev:real` preflight. Prints exactly which cutover items the real adapters' environment
// still lacks, instead of letting the server crash on its first request. After a pass it prints the framework's
// `realEnvNotices()` too, advisory lines on optional settings (a `notice:` each), which never change the exit code.
//
// THROUGH esbuild, NOT tsx OR NODE (ADR-0014 part 2). @sssb/kit ships TypeScript source, and Node refuses to strip
// types from a file under node_modules, so the framework is bundled first. The bundle holds the framework and every
// file outside node_modules: the app's own source (its seam, and what the seam imports through the app's `@/` alias)
// and any workspace package the seam reaches, which is TypeScript source too and may itself import the framework.
// Every package under node_modules stays EXTERNAL, imported by the absolute path esbuild resolved it to from the file
// that imports it, so a framework dependency loads from the framework's own node_modules as it would in the app.
//
// THE FRAMEWORK IS THE APP'S (rule 4). The entry imports the framework by the real paths the shared resolver
// returns from the app's directory; every bare `@sssb/kit` specifier is resolved and checked the same way; and every
// bundled input and every external that is framework source (its nearest package.json is `@sssb/kit`, wherever it
// sits, a copy of the framework's tree included) must be the app's own instance. The seam is
// passed explicitly (`@sssb/app-config` aliased to the app's `src/app-config`), as every SSSB builder passes it:
// in an adopter's app that is redundant with the seam link, and in SSSB's repository it is the only way, since there
// the fallback would be the repo's tsconfig mapping to the framework's test fixture (ADR-0014 part 1).
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { takeAppDir, UsageError } from '../app.js'
import { assertAppsKitFile, assertNoForeignFramework, isFrameworkFile, resolveAppsKit } from '../kit.js'

const NODE_MODULES = `${path.sep}node_modules${path.sep}`
/**
 * esbuild's loader for a source file, by its extension.
 * @param {string} file
 * @returns {'ts' | 'tsx' | 'js' | 'jsx'}
 */
function loaderFor(file) {
    const ext = path.extname(file).replace(/^\.[cm]?/, '.')
    return ext === '.tsx' ? 'tsx' : ext === '.ts' ? 'ts' : ext === '.jsx' ? 'jsx' : 'js'
}

/** The in-memory entry's name, as the metafile lists it. */
const ENTRY = 'sssb-check-real-env.ts'

/** @param {string[]} args */
export async function run(args) {
    const appDir = realpathSync(takeAppDir(args))
    if (args.length > 0) throw new UsageError('usage: sssb check-real-env [--app <dir>]')
    const seam = path.join(appDir, 'src', 'app-config')
    if (!existsSync(seam)) throw new UsageError(`sssb check-real-env: ${appDir} has no seam at src/app-config`)
    const realIndex = resolveAppsKit(appDir, 'adapters/real/index')
    const errors = resolveAppsKit(appDir, 'ports/errors')

    const { build, transform } = await import('esbuild')
    const outDir = mkdtempSync(path.join(tmpdir(), 'sssb-check-real-env-'))
    try {
        const outfile = path.join(outDir, 'preflight.cjs')
        const tsconfig = path.join(appDir, 'tsconfig.json')
        const result = await build({
            stdin: {
                contents: [
                    `import * as real from ${JSON.stringify(realIndex)}`,
                    `import { CutoverPendingError } from ${JSON.stringify(errors)}`,
                    'try {',
                    '    real.assertRealEnv()',
                    "    console.log('real-mode env complete: starting dev:real')",
                    // Advisory lines the framework may offer (safeinsights/sssb#192), after a pass and never a failure.
                    // A framework without `realEnvNotices` (the packages move in one version group, but a guard costs
                    // one line) offers none. The lookup is by name, at run time: esbuild warns about any static
                    // mention of an export the framework lacks, `in` guard or not.
                    "    const offered = Object.entries(real).find(([name]) => name === 'realEnvNotices')?.[1]",
                    '    try {',
                    "        const notices = typeof offered === 'function' ? offered() : []",
                    "        for (const notice of notices) console.log('notice: ' + notice)",
                    '    } catch (error) {',
                    // Advice that fails is advice missed, not a failed check.
                    "        console.log('notice: the notices could not be read: ' + (error && error.message))",
                    '    }',
                    '} catch (error) {',
                    '    if (!(error instanceof CutoverPendingError)) throw error',
                    "    console.error('\\ndev:real is not available yet.\\n')",
                    '    console.error(error.message)',
                    "    console.error('\\nEach item is a row in the cutover checklist, with what unlocks it.\\n')",
                    '    process.exit(1)',
                    '}',
                ].join('\n'),
                resolveDir: appDir,
                sourcefile: ENTRY,
                loader: 'ts',
            },
            absWorkingDir: appDir,
            bundle: true,
            platform: 'node',
            // CommonJS, so every external is a require() with esbuild's interop: the packages left external are
            // loaded by their CommonJS builds where they have one (below), and Node 24 requires an ES-only one.
            format: 'cjs',
            target: 'node22',
            outfile,
            metafile: true,
            logLevel: 'warning',
            ...(existsSync(tsconfig) ? { tsconfig } : {}),
            alias: { '@sssb/app-config': seam },
            plugins: [
                {
                    name: 'sssb-bundle-only-the-framework-and-the-app',
                    setup(build) {
                        // The bundle is CommonJS, where `import.meta` is empty, so a bundled file (the framework, the
                        // app, a workspace package) that finds a file beside it with `new URL('./x', import.meta.url)`
                        // or `import.meta.dirname` would break or look in the bundle's temp directory. Each such file is
                        // first transformed with `import.meta` defined as an object holding its own location. A define
                        // replaces expressions, never text inside a string, and covers `import.meta.url`, `.dirname`,
                        // `.filename` and a destructured or bare `import.meta`; `.resolve` and `.env` stay undefined.
                        // TypeScript is stripped here and JSX kept, so the bundle still compiles JSX with the app's
                        // tsconfig.
                        build.onLoad({ filter: /\.[cm]?[jt]sx?$/ }, async (args) => {
                            if (args.path.includes(NODE_MODULES) && !isFrameworkFile(args.path)) return undefined
                            const text = readFileSync(args.path, 'utf8')
                            if (!text.includes('import.meta')) return undefined
                            const loader = loaderFor(args.path)
                            const meta = {
                                url: pathToFileURL(args.path).href,
                                dirname: path.dirname(args.path),
                                filename: args.path,
                            }
                            const { code } = await transform(text, {
                                loader,
                                format: 'esm',
                                jsx: 'preserve',
                                sourcefile: args.path,
                                define: { 'import.meta': JSON.stringify(meta) },
                                logLevel: 'silent',
                            })
                            return { contents: code, loader: loader === 'tsx' || loader === 'jsx' ? 'jsx' : 'js' }
                        })
                        build.onResolve({ filter: /^[^./]/ }, async (args) => {
                            if (args.pluginData === 'sssb-inner') return undefined
                            const resolved = await build.resolve(args.path, {
                                kind: args.kind,
                                importer: args.importer,
                                resolveDir: args.resolveDir,
                                pluginData: 'sssb-inner',
                            })
                            if (resolved.errors.length > 0) return { errors: resolved.errors }
                            if (resolved.external) return { path: resolved.path, external: true }
                            if (args.path === '@sssb/kit' || args.path.startsWith('@sssb/kit/')) {
                                return { path: assertAppsKitFile(appDir, resolved.path) }
                            }
                            const real = realpathSync(resolved.path)
                            if (!real.includes(NODE_MODULES)) return { path: real }
                            // An external package is loaded by plain Node, so it gets the entry Node can load: the
                            // `require` build where the package has one. Some packages' ES builds are written for
                            // bundlers only (@clerk/nextjs's imports directories, which Node refuses), and a CommonJS
                            // build resolves its own dependencies with Node's resolver from where it sits.
                            const required = await build.resolve(args.path, {
                                kind: 'require-call',
                                importer: args.importer,
                                resolveDir: args.resolveDir,
                                pluginData: 'sssb-inner',
                            })
                            const loadable = realpathSync(
                                required.errors.length === 0 && !required.external ? required.path : real,
                            )
                            assertNoForeignFramework(appDir, loadable)
                            return { path: loadable, external: true }
                        })
                    },
                },
            ],
        })
        // Every bundled input that is framework source is the app's own instance: nothing reached another copy by a
        // relative path, an alias or a workspace package the plugin above never saw as a bare `@sssb/kit`.
        for (const input of Object.keys(result.metafile.inputs)) {
            if (input !== ENTRY) assertNoForeignFramework(appDir, path.resolve(appDir, input))
        }
        const run = spawnSync(process.execPath, [outfile], { stdio: 'inherit', env: process.env, cwd: appDir })
        if (run.error) throw run.error
        return run.status ?? 1
    } finally {
        rmSync(outDir, { recursive: true, force: true })
    }
}
