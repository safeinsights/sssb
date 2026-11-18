// Builds `@sssb/kit/testing/e2e` — the one kit entry Node loads directly — into `dist/testing/` (ADR-0014 part 2).
//
//   node scripts/build-testing-e2e.mjs        (the package's `prepack` script: `pnpm pack` runs it)
//   node scripts/build-testing-e2e.mjs --entry <file> --out-dir <dir>   (another entry or output; the guard's tests;
//                                                                         <dir> must be new or empty, see below)
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
// come from APP_SLUG) can never be on it. esbuild sees only a LITERAL specifier, so the emitted file is checked too,
// read with the TypeScript parser: it must hold no import or export of a module, no `import(…)` (a computed or
// template-literal specifier is left in the output as one), no `import.meta`, and no reference to a loader or a
// way to one (`require`, `module`, `globalThis`, `eval`, `Function`, …), since `globalThis['req' + 'uire']` loads
// a module without ever spelling it. The entry is self-contained or the build fails.
import {
    existsSync,
    mkdirSync,
    readdirSync,
    readFileSync,
    realpathSync,
    rmSync,
    statSync,
    writeFileSync,
} from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import * as esbuild from 'esbuild'
import ts from 'typescript'

const KIT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
/** `--entry <file>` and `--out-dir <dir>`, both optional; anything else is refused. */
const flags = (() => {
    /** @type {Record<string, string>} */
    const out = {}
    const args = process.argv.slice(2)
    for (let i = 0; i < args.length; i += 2) {
        const [flag, value] = [args[i], args[i + 1]]
        if ((flag !== '--entry' && flag !== '--out-dir') || value === undefined) {
            process.stderr.write(
                `build-testing-e2e: usage: [--entry <file>] [--out-dir <dir>] (got ${args.join(' ')})\n`,
            )
            process.exit(2)
        }
        out[flag] = path.resolve(value)
    }
    return out
})()
// The real path, as esbuild reports its inputs (a temp dir under macOS's /var is really /private/var).
const ENTRY = flags['--entry'] ? path.relative(KIT, realpathSync(flags['--entry'])) : 'src/testing/e2e.ts'
const OWN_DIST = path.join(KIT, 'dist')
const OUT_DIR = flags['--out-dir'] ?? OWN_DIST
const OUT_FILE = path.join(OUT_DIR, 'testing/e2e.js')

// THE OUTPUT DIRECTORY IS WIPED before the build and on any failure, so only one this build owns is accepted: the
// package's own `dist/`, a path that does not exist yet, or an empty directory. Anything else (`--out-dir .`, `--out-dir
// ~`, a directory holding someone's files) is refused before a byte is touched.
const outDirExisted = existsSync(OUT_DIR)
if (OUT_DIR !== OWN_DIST && outDirExisted && (!statSync(OUT_DIR).isDirectory() || readdirSync(OUT_DIR).length > 0)) {
    process.stderr.write(
        `build-testing-e2e: refusing --out-dir ${OUT_DIR}: it is not empty, and it is not this package's dist ` +
            `(${OWN_DIST}). The build deletes what its output directory holds; name a new or empty one.\n`,
    )
    process.exit(2)
}

/** Every file the compiled entry may contain, relative to packages/kit. Each must import nothing but these. */
const ALLOWED = new Set([ENTRY, 'src/core/webhook-hmac.ts'])

/** Empties the output directory; one this run created (or the package's dist) goes entirely. */
const clean = () => {
    if (OUT_DIR === OWN_DIST || !outDirExisted) rmSync(OUT_DIR, { recursive: true, force: true })
    else for (const entry of readdirSync(OUT_DIR)) rmSync(path.join(OUT_DIR, entry), { recursive: true, force: true })
}

const fail = (/** @type {string} */ message) => {
    // Never leave a half-built entry behind for pack to ship.
    clean()
    process.stderr.write(`build-testing-e2e: FAILED: ${message}\n`)
    process.exit(1)
}

clean()
mkdirSync(path.join(OUT_DIR, 'testing'), { recursive: true })

// ---- JavaScript: one self-contained ES module ----
/** @type {string[]} */
const packageImports = []
const result = await esbuild.build({
    absWorkingDir: KIT,
    entryPoints: [ENTRY],
    outfile: OUT_FILE,
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

// ---- What was emitted: one module that loads nothing ----
/** Free names that reach a module loader, or code built from a string (which could reach one). */
const LOADERS = new Set([
    'require',
    'module',
    'exports',
    'globalThis',
    'global',
    'self',
    'window',
    'process',
    'eval',
    'Function',
])
const emittedJs = ts.createSourceFile(OUT_FILE, readFileSync(OUT_FILE, 'utf8'), ts.ScriptTarget.ES2022, true)
/** @type {string[]} */
const loading = []
const at = (/** @type {ts.Node} */ node) => {
    const { line } = emittedJs.getLineAndCharacterOfPosition(node.getStart(emittedJs))
    return `line ${line + 1}: ${node.getText(emittedJs).slice(0, 80)}`
}
const visit = (/** @type {ts.Node} */ node) => {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier) {
        loading.push(`an ${ts.isImportDeclaration(node) ? 'import' : 'export'} from a module, ${at(node)}`)
    } else if (ts.isImportEqualsDeclaration(node)) loading.push(`an import, ${at(node)}`)
    else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
        loading.push(`a dynamic import(), ${at(node)}`)
    } else if (ts.isMetaProperty(node)) loading.push(`import.meta, ${at(node)}`)
    else if (ts.isIdentifier(node) && LOADERS.has(node.text)) {
        // A property NAME (`x.require`, `{ require: … }`) is not a reference; everything else, a declaration of a
        // local by that name included, is.
        const { parent } = node
        const isPropertyName =
            (ts.isPropertyAccessExpression(parent) && parent.name === node) ||
            ((ts.isPropertyAssignment(parent) || ts.isMethodDeclaration(parent) || ts.isPropertyDeclaration(parent)) &&
                parent.name === node)
        if (!isPropertyName) loading.push(`a reference to \`${node.text}\`, ${at(node)}`)
    }
    ts.forEachChild(node, visit)
}
visit(emittedJs)
if (loading.length) {
    fail(
        `@sssb/kit/testing/e2e must be one self-contained module, but what esbuild emitted can still load code:\n  ` +
            `${loading.join('\n  ')}\nA specifier esbuild cannot read (computed, a template literal) is left for ` +
            'Node to resolve at run time, which is the seam guard bypassed. Import the module by a literal path.',
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

process.stdout.write(`build-testing-e2e: ${path.relative(KIT, OUT_FILE)} + declarations from ${inputs.join(', ')}\n`)
