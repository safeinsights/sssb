// Builds `@sssb/kit/testing/e2e` — the one kit entry Node loads directly — into `dist/testing/` (ADR-0014 part 2).
//
//   node scripts/build-testing-e2e.mjs        (the package's `prepack` script: `pnpm pack` runs it)
//
// Playwright loads an adopter's e2e specs with Node, and it does not transform files under `node_modules`, so
// the entry a spec imports must be JavaScript in the packed package: esbuild bundles `src/testing/e2e.ts` into
// `dist/testing/e2e.js` (ES2022, ESM, no imports left), and the TypeScript compiler emits its declarations
// beside it (`dist/testing/e2e.d.ts`, which `exports` resolves by the sibling rule, and `dist/core/*.d.ts`).
// `dist/` is gitignored and only the tarball needs it: inside this repo every tool resolves `@sssb/kit/*` to
// `src/` through an alias (tsconfig `paths`, which Playwright honours too), so nothing here reads it.
//
// THE SEAM GUARD. The entry must be seam-free: Node cannot resolve the app's `@sssb/app-config/*` seam the way a
// bundler does, and a compiled copy of the kit would read the fixture's seam, not the app's. So this build FAILS
// (non-zero exit) if the entry's closure, in the bundle or in the declarations, imports `@sssb/app-config/*` or
// any other package, or reaches a file outside ALLOWED. Growing the entry means adding a seam-free file to
// ALLOWED, deliberately; a file that reads the seam (core/webhook-signing.ts is the example: its header names
// come from APP_SLUG) can never be on it.
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import * as esbuild from 'esbuild'
import ts from 'typescript'

const KIT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const ENTRY = 'src/testing/e2e.ts'
const OUT_DIR = path.join(KIT, 'dist')

/** Every file the compiled entry may contain, relative to packages/kit. Each must import nothing but these. */
const ALLOWED = new Set([ENTRY, 'src/core/webhook-hmac.ts'])

const fail = (/** @type {string} */ message) => {
    // Never leave a half-built entry behind for pack to ship.
    rmSync(OUT_DIR, { recursive: true, force: true })
    process.stderr.write(`build-testing-e2e: FAILED: ${message}\n`)
    process.exit(1)
}

rmSync(OUT_DIR, { recursive: true, force: true })
mkdirSync(path.join(OUT_DIR, 'testing'), { recursive: true })

// ---- JavaScript: one self-contained ES module ----
/** @type {string[]} */
const packageImports = []
const result = await esbuild.build({
    absWorkingDir: KIT,
    entryPoints: [ENTRY],
    outfile: path.join(OUT_DIR, 'testing/e2e.js'),
    bundle: true,
    format: 'esm',
    platform: 'neutral',
    target: 'es2022',
    metafile: true,
    logLevel: 'warning',
    // No tsconfig: the root one maps `@sssb/app-config/*` to the kit's test fixture, which would quietly bundle
    // the FIXTURE's seam into a file every adopter's specs load.
    tsconfigRaw: {},
    plugins: [
        {
            name: 'no-packages',
            setup(build) {
                // Every non-relative specifier, `@sssb/app-config/*` first among them, is recorded and left
                // unresolved, so the failure below names it instead of esbuild resolving it somewhere.
                build.onResolve({ filter: /^[^./]/ }, (args) => {
                    packageImports.push(
                        `${args.path} (imported by ${args.importer ? path.relative(KIT, args.importer) : '?'})`,
                    )
                    return { path: args.path, external: true }
                })
            },
        },
    ],
})

const seamImports = packageImports.filter((line) => line.startsWith('@sssb/app-config'))
if (seamImports.length) {
    fail(
        `@sssb/kit/testing/e2e must be seam-free, but its closure imports the app's seam:\n  ${seamImports.join('\n  ')}\n` +
            'Node loads this entry without the seam (ADR-0014 part 2). Move the seam-free part into its own module.',
    )
}
if (packageImports.length) {
    fail(`@sssb/kit/testing/e2e must import no package, but its closure imports:\n  ${packageImports.join('\n  ')}`)
}
const inputs = Object.keys(result.metafile.inputs).map((file) => path.relative(KIT, path.resolve(KIT, file)))
const outside = inputs.filter((file) => !ALLOWED.has(file))
if (outside.length) {
    fail(
        `@sssb/kit/testing/e2e reaches files outside its allowed seam-free set:\n  ${outside.join('\n  ')}\n` +
            `Allowed: ${[...ALLOWED].join(', ')}. Add a file there only if it imports nothing outside that set.`,
    )
}

// ---- Declarations, over the same closure ----
const program = ts.createProgram({
    rootNames: [path.join(KIT, ENTRY)],
    options: {
        declaration: true,
        emitDeclarationOnly: true,
        outDir: OUT_DIR,
        rootDir: path.join(KIT, 'src'),
        strict: true,
        target: ts.ScriptTarget.ES2022,
        module: ts.ModuleKind.ESNext,
        moduleResolution: ts.ModuleResolutionKind.Bundler,
        lib: ['lib.es2022.d.ts', 'lib.dom.d.ts'],
        types: [],
        skipLibCheck: true,
        noEmitOnError: true,
    },
})
const sources = program
    .getSourceFiles()
    .filter((file) => !program.isSourceFileDefaultLibrary(file))
    .map((file) => path.relative(KIT, file.fileName))
const outsideTypes = sources.filter((file) => !ALLOWED.has(file))
if (outsideTypes.length) {
    fail(
        `the declarations of @sssb/kit/testing/e2e reach files outside its allowed set:\n  ${outsideTypes.join('\n  ')}`,
    )
}
// A relative specifier in a declaration gets its `.js`: Node-style resolution (`nodenext`) requires the extension,
// and bundler resolution maps `./x.js` to `./x.d.ts` just the same.
const withExtensions = (/** @type {string} */ text) =>
    text.replace(/((?:from|import\()\s*['"])(\.{1,2}\/[^'"]+?)(['"])/g, (match, before, specifier, after) =>
        /\.[cm]?js$/.test(specifier) ? match : `${before}${specifier}.js${after}`,
    )
const emitted = program.emit(undefined, (fileName, text) => {
    mkdirSync(path.dirname(fileName), { recursive: true })
    writeFileSync(fileName, withExtensions(text))
})
const diagnostics = [...ts.getPreEmitDiagnostics(program), ...emitted.diagnostics]
if (diagnostics.length || emitted.emitSkipped) {
    const host = { getCanonicalFileName: (f) => f, getCurrentDirectory: () => KIT, getNewLine: () => '\n' }
    fail(`emitting declarations failed:\n${ts.formatDiagnostics(diagnostics, host)}`)
}

process.stdout.write(`build-testing-e2e: dist/testing/e2e.js + declarations from ${inputs.join(', ')}\n`)
