// @ts-check
// `sssb check-real-env`: the `dev:real` preflight. Prints exactly which cutover items the real adapters' environment
// still lacks, instead of letting the server crash on its first request.
//
// THROUGH esbuild, NOT tsx OR NODE (ADR-0014 part 2). @sssb/kit ships TypeScript source, and Node refuses to strip
// types from a file under node_modules, so the framework is bundled first. The bundle holds exactly two kinds of
// code: the framework, and the app's own source (its seam, and what the seam imports through the app's `@/` alias).
// Every other package stays EXTERNAL, imported by the absolute path esbuild resolved it to from the file that
// imports it, so a framework dependency loads from the framework's own node_modules exactly as it would in the app.
//
// THE FRAMEWORK IS THE APP'S (rule 4). The entry imports the framework by the real paths the shared resolver
// returns from the app's directory; every bare `@sssb/kit` specifier the seam writes is resolved and checked the
// same way; and after the build every input from any `@sssb/kit` directory must be the app's instance. The seam is
// passed explicitly (`@sssb/app-config` aliased to the app's `src/app-config`), as every SSSB builder passes it:
// in an adopter's app that is redundant with the seam link, and in SSSB's repository it is the only way, since there
// the fallback would be the repo's tsconfig mapping to the framework's test fixture (ADR-0014 part 1).
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { takeAppDir, UsageError } from '../app.js'
import { assertAppsKitFile, kitDirOf, resolveAppsKit } from '../kit.js'

const KIT_SEGMENT = `${path.sep}@sssb${path.sep}kit${path.sep}`
/** The in-memory entry's name, as the metafile lists it. */
const ENTRY = 'sssb-check-real-env.ts'

/** @param {string[]} args */
export async function run(args) {
    const appDir = realpathSync(takeAppDir(args))
    if (args.length > 0) throw new UsageError('usage: sssb check-real-env [--app <dir>]')
    const kitDir = kitDirOf(appDir)
    const seam = path.join(appDir, 'src', 'app-config')
    if (!existsSync(seam)) throw new UsageError(`sssb check-real-env: ${appDir} has no seam at src/app-config`)
    const realIndex = resolveAppsKit(appDir, 'adapters/real/index')
    const errors = resolveAppsKit(appDir, 'ports/errors')
    const appSource = path.join(appDir, 'src') + path.sep

    const { build } = await import('esbuild')
    const outDir = mkdtempSync(path.join(tmpdir(), 'sssb-check-real-env-'))
    try {
        const outfile = path.join(outDir, 'preflight.cjs')
        const tsconfig = path.join(appDir, 'tsconfig.json')
        const result = await build({
            stdin: {
                contents: [
                    `import { assertRealEnv } from ${JSON.stringify(realIndex)}`,
                    `import { CutoverPendingError } from ${JSON.stringify(errors)}`,
                    'try {',
                    '    assertRealEnv()',
                    "    console.log('real-mode env complete: starting dev:real')",
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
                            const ownSource =
                                real.startsWith(appSource) && !real.includes(`${path.sep}node_modules${path.sep}`)
                            if (ownSource) return { path: real }
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
                            const loadable = required.errors.length === 0 && !required.external ? required.path : real
                            return { path: realpathSync(loadable), external: true }
                        })
                    },
                },
            ],
        })
        // Every bundled input that is framework code is the app's own instance: nothing reached another copy by a
        // relative path or an alias the plugin above never saw.
        for (const input of Object.keys(result.metafile.inputs)) {
            if (input === ENTRY) continue
            const real = realpathSync(path.resolve(appDir, input))
            if (real.includes(KIT_SEGMENT) || real.startsWith(kitDir + path.sep)) assertAppsKitFile(appDir, real)
        }
        const run = spawnSync(process.execPath, [outfile], { stdio: 'inherit', env: process.env, cwd: appDir })
        if (run.error) throw run.error
        return run.status ?? 1
    } finally {
        rmSync(outDir, { recursive: true, force: true })
    }
}
