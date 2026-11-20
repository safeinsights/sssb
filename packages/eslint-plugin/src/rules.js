// EVERY sssb/* RULE, app-side and SSSB-internal alike (ADR-0014, part 4). Flat config throws `Cannot redefine
// plugin "sssb"` when two blocks matching one file bind `sssb` to different objects, and SSSB's own repository
// binds it both in its internal blocks and through the app preset, so there is one plugin object and it carries
// every rule; the preset enables only the app-side ones.
//
// No rule reads a file when this module loads. The internal rules that need SSSB's repository (the package's
// manifest, the repo root) take it as an option and read it when they run, so importing the plugin works in any
// adopter's config.
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { basename, dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import reactPlugin from 'eslint-plugin-react'
import {
    declarationImportBan,
    declarationlessImportBan,
    declarationlessVisitors,
    declarationVisitors,
    literalSpecifier,
    matchesPatterns,
    syntaxBan,
} from './import-ban.js'
import {
    a11yLiteralSelector,
    appCodePatterns,
    appRealAdapterDynamicSelector,
    appRealAdapterPattern,
    appRealAdapterStaticPattern,
    coreFrameworkPattern,
    getDbComputedSelector,
    getDbDestructureSelector,
    getDbSelector,
    getDbStringSelector,
    kitRealAdapterPattern,
    nextFontPattern,
    nodeModulesPathPattern,
    processEnvSelector,
    runModeEnvDestructureSelector,
    runModeEnvSelector,
    vendorEntrySource,
    vendorSdkPattern,
} from './patterns.js'

// ---------------------------------------------------------------------------------------------------------------
// THE APP-SIDE FENCES. Each was a no-restricted-imports pattern or a no-restricted-syntax selector until
// ADR-0014's P6, and is now a rule of its own, so a later block that sets either core rule cannot drop it.

// The vendor list is SSSB's, and an app adds its own adapters' SDKs to it in its package.json (`sssb.vendors`), which
// the preset passes to both halves as this option. SSSB's list is always part of the group, and the schema admits only
// the shapes both halves read alike (vendorEntrySource, the same test loadAppVendors makes), which leaves out a leading
// `!` (a gitignore negation), so the option adds patterns and cannot remove one of SSSB's. `sssb check-fences` still
// compares it exactly with the app's package.json, so a later block cannot swap the app's list for another.
const vendorsOption = {
    type: 'object',
    properties: { vendors: { type: 'array', items: { type: 'string', pattern: vendorEntrySource } } },
    additionalProperties: false,
}
const vendorGroupOf = (context) => [...vendorSdkPattern.group, ...(context.options[0]?.vendors ?? [])]
// One rule module per distinct vendor list, built once: `build(group)` makes the rule that fences that group.
const withAppVendors = (build) => {
    const built = new Map()
    const ruleFor = (group) => {
        const key = JSON.stringify(group)
        if (!built.has(key)) built.set(key, build(group))
        return built.get(key)
    }
    const { meta } = ruleFor(vendorSdkPattern.group)
    return {
        meta: { ...meta, schema: [vendorsOption] },
        create: (context) => ruleFor(vendorGroupOf(context)).create(context),
    }
}

const vendorStatic = withAppVendors((group) =>
    declarationImportBan({
        description: 'Vendor SDKs are imported only inside an adapters directory.',
        patterns: [{ ...vendorSdkPattern, group }],
    }),
)

// The dynamic half keeps its OWN reading of the vendor list. The two disagree at the edges: the declaration half
// matches a bare name at any depth and ignores case, so its `pg` flags a local `./pg` and its `@clerk/*` flags
// `@CLERK/nextjs`; this rule flags neither. Bringing them together means anchoring the bare names in
// vendorSdkPattern first, which changes the declaration half, so it is left for its own change.
const isVendorSpecifier = (group, specifier) =>
    group.some((pattern) =>
        pattern.endsWith('/*')
            ? specifier.startsWith(pattern.slice(0, -1)) && specifier.length > pattern.length - 1
            : specifier === pattern || specifier.startsWith(`${pattern}/`),
    )
const vendorDeclarationlessRule =
    "Vendor SDKs live only in packages/kit/src/adapters/ (SSSB's ports) or apps/<app>/src/adapters/real/ " +
    '(a port the app owns) — code against the port instead (docs/recipes/app-owned-adapter.md).'
const vendorDynamic = withAppVendors((group) =>
    declarationlessImportBan({
        description: 'Vendor SDKs are not imported dynamically outside an adapters directory.',
        what: 'a vendor SDK',
        matches: (specifier) => (isVendorSpecifier(group, specifier) ? [vendorDeclarationlessRule] : []),
    }),
)

const nextFontGoogle = declarationImportBan({
    description: 'next/font/google phones home at build; dev stays hermetic.',
    patterns: [nextFontPattern],
})
const realAdapterViaRegistry = declarationImportBan({
    description: 'An app reaches its real adapters through its registry, never by a static import.',
    patterns: [appRealAdapterPattern],
})
const staticRealAdapterInAdapters = declarationImportBan({
    description: "Inside an app's adapters directory, real/ is loaded only with import().",
    patterns: [appRealAdapterStaticPattern],
})
const kitRealAdapterInAdapters = declarationImportBan({
    description: "Outside an app's own real adapters, SSSB's real adapters are loaded only with import().",
    patterns: [kitRealAdapterPattern],
    // What the fence guards is the vendor SDK LOADING, and a type-only declaration loads nothing.
    allowTypeOnly: true,
})
const dynamicRealAdapter = syntaxBan({
    description: "Only an app's registry loads real/.",
    selectors: { dynamic: appRealAdapterDynamicSelector },
})
const processEnv = syntaxBan({
    description: 'process.env is read only inside an adapters directory.',
    selectors: { env: processEnvSelector },
})
const runModeEnv = syntaxBan({
    description: "An app's real adapter never reads the run mode itself.",
    selectors: { member: runModeEnvSelector, destructure: runModeEnvDestructureSelector },
})
const a11yLiteral = syntaxBan({
    description: 'Accessible names, placeholders, titles and alt text come from the catalog, never a literal.',
    selectors: { literal: a11yLiteralSelector },
})

// THE i18n LITERAL BAN (ADR-0008) under an id of its own: eslint-plugin-react's jsx-no-literals with the options
// SSSB requires, fixed. It was `react/jsx-no-literals` with those options in the repo's config, and an adopter's own
// block that configured that rule for their own reasons (or turned it off for a directory) replaced them. This rule
// takes no options; it runs react's rule with these.
const JSX_NO_LITERALS_OPTIONS = [{ noStrings: true, ignoreProps: true, allowedStrings: [] }]
const reactJsxNoLiterals = reactPlugin.rules['jsx-no-literals']
// Taken when the plugin loads: the rule object is eslint-plugin-react's, which an app's config can reach and rewrite.
const reactJsxNoLiteralsCreate = reactJsxNoLiterals.create
/** @type {import('eslint').Rule.RuleModule} */
const jsxLiterals = {
    meta: {
        type: 'problem',
        docs: { description: 'UI code holds no hard-coded strings: all copy goes through next-intl (ADR-0008).' },
        schema: [],
        messages: reactJsxNoLiterals.meta.messages,
    },
    create(context) {
        // Every other property (report, sourceCode, filename, …) is the real context's, through the prototype.
        return reactJsxNoLiteralsCreate(Object.create(context, { options: { value: JSX_NO_LITERALS_OPTIONS } }))
    },
}

// ---------------------------------------------------------------------------------------------------------------
// THE TENANCY BAN (ADR-0004): the getDb selectors, each with its message.
/** @type {import('eslint').Rule.RuleModule} */
const rawDbHandle = {
    meta: {
        type: 'problem',
        docs: { description: "App code and SSSB's screens reach the database through db.withTenant()." },
        schema: [],
        messages: {
            member: getDbSelector.message,
            computed: getDbComputedSelector.message,
            destructure: getDbDestructureSelector.message,
            string: getDbStringSelector.message,
        },
    },
    create(context) {
        const report = (messageId) => (node) => context.report({ node, messageId })
        // A spy's key in a test file is the one string left alone outside the selector (see getDbStringSelector).
        const inTestFile = /\.test\.tsx?$/.test(context.filename)
        const isSpyKey = (node) =>
            node.parent?.type === 'CallExpression' &&
            node.parent.arguments.includes(node) &&
            node.parent.callee.type === 'MemberExpression' &&
            /^(vi|jest)$/.test(node.parent.callee.object.name ?? '') &&
            node.parent.callee.property.name === 'spyOn'
        return {
            [getDbSelector.selector]: report('member'),
            [getDbComputedSelector.selector]: report('computed'),
            [getDbDestructureSelector.selector]: report('destructure'),
            [getDbStringSelector.selector]: (node) => {
                if (inTestFile && isSpyKey(node)) return
                report('string')(node)
            },
        }
    },
}

// NO RAW mkdtemp IN TESTS. A test that calls `mkdtemp`/`mkdtempSync` itself leaves the directory behind on every
// run, and enough runs filled a dev machine's temp filesystem past 100GB. Tests make scratch directories through
// makeTestTmpDir() from @sssb/tools/testing/tmp-dir (the framework's own tests through its copy in
// packages/kit/src/testing/tmp-dir.ts), which queues the removal. Deliberately narrow: it matches the call by the NAME it is made under
// — bare `mkdtempSync(…)`, `fs.mkdtempSync(…)`, `fsp.mkdtemp(…)`, `await mkdtemp(…)` — and not a renamed import
// (`import { mkdtemp as m }`) or a computed key. `sssb check-tmpdir-leak`'s per-run TMPDIR sweep is what bounds the damage
// if one slips by.
/** @type {import('eslint').Rule.RuleModule} */
const directMkdtemp = {
    meta: {
        type: 'problem',
        docs: { description: 'Tests make scratch directories through makeTestTmpDir(), never a raw mkdtemp.' },
        schema: [],
        messages: {
            direct:
                '`{{name}}()` leaves its directory behind on every test run. Use makeTestTmpDir() / ' +
                'makeTestTmpDirAsync() from @sssb/tools/testing/tmp-dir (in the framework, makeTestTmpDir() from ' +
                'packages/kit/src/testing/tmp-dir.ts), which removes the directory when the test file finishes — ' +
                'or, in a Playwright spec, testInfo.outputPath(), which Playwright ' +
                'clears at the start of every run.',
        },
    },
    create(context) {
        const report = (node, name) => context.report({ node, messageId: 'direct', data: { name } })
        return {
            'CallExpression[callee.type="Identifier"][callee.name=/^mkdtemp(Sync)?$/]': (node) =>
                report(node, node.callee.name),
            'CallExpression[callee.type="MemberExpression"][callee.computed=false][callee.property.name=/^mkdtemp(Sync)?$/]':
                (node) => report(node, node.callee.property.name),
        }
    },
}

// ---------------------------------------------------------------------------------------------------------------
// SSSB-INTERNAL FENCES: rules SSSB's own repository enables over packages/kit. They ship in the same object (see
// the top of this file); no preset enables them.

// THE FRAMEWORK/APP FENCE and @sssb/kit/core's framework ban, in declarations and outside them.
const appImport = declarationImportBan({
    description: 'Framework code reaches app content only through the @sssb/app-config/* seam.',
    patterns: appCodePatterns,
})
const appImportDynamic = declarationlessImportBan({
    description: 'Framework code does not reach app content by import(), require() or a type import().',
    what: 'app content',
    matches: matchesPatterns(appCodePatterns),
})
const coreFrameworkImport = declarationImportBan({
    description: '@sssb/kit/core imports no framework.',
    patterns: [coreFrameworkPattern],
})
const coreFrameworkMatches = matchesPatterns([coreFrameworkPattern])
const coreFrameworkImportDynamicBan = declarationlessImportBan({
    description:
        '@sssb/kit/core does not reach a framework by import(), require(), a type import() or a ' +
        '`/// <reference types>`.',
    what: 'a framework',
    matches: coreFrameworkMatches,
})
// `/// <reference types="react" />` pulls React's global types into the pure-TypeScript core with no import at all,
// so a `types=` that names a package is judged as a specifier too.
/** @type {import('eslint').Rule.RuleModule} */
const coreFrameworkImportDynamic = {
    meta: {
        ...coreFrameworkImportDynamicBan.meta,
        messages: {
            ...coreFrameworkImportDynamicBan.meta.messages,
            reference:
                '`{{specifier}}` is a framework, and `/// <reference types="{{specifier}}" />` loads its types into ' +
                '@sssb/kit/core as an import would. {{rule}}',
        },
    },
    create(context) {
        const visitors = coreFrameworkImportDynamicBan.create(context)
        return {
            ...visitors,
            Program: () => {
                for (const { loc, kind, value } of referenceDirectives(context)) {
                    if (kind !== 'types') continue
                    for (const rule of coreFrameworkMatches(value.trim())) {
                        context.report({ loc, messageId: 'reference', data: { specifier: value.trim(), rule } })
                    }
                }
            },
        }
    },
}

// JSX in @sssb/kit/core is a framework import nobody writes: with `"jsx": "react-jsx"` every element compiles to an
// import of `react/jsx-runtime`. Neither half of core's ban can see an import that is not in the source, so the JSX
// itself is the finding: each outermost element or fragment.
/** @type {import('eslint').Rule.RuleModule} */
const jsxInCore = {
    meta: {
        type: 'problem',
        docs: { description: '@sssb/kit/core holds no JSX: it compiles to an import of react/jsx-runtime.' },
        schema: [],
        messages: {
            jsx: `JSX compiles to an import of react/jsx-runtime ("jsx": "react-jsx" in tsconfig.json). ${coreFrameworkPattern.message}`,
        },
    },
    create(context) {
        // Each OUTERMOST element or fragment, so nested JSX is one finding and a disable comment on one element does
        // not hide another.
        const report = (node) => {
            for (let up = node.parent; up; up = up.parent) {
                if (up.type === 'JSXElement' || up.type === 'JSXFragment') return
            }
            context.report({ node, messageId: 'jsx' })
        }
        return { JSXElement: report, JSXFragment: report }
    },
}

// Options naming a directory of SSSB's repository: absolute, so they never depend on where ESLint was started.
const rootOption = {
    type: 'object',
    properties: { root: { type: 'string' } },
    required: ['root'],
    additionalProperties: false,
}
const optionsOf = (context, rule) => {
    const [options] = context.options
    if (!options?.root || !/^([\\/]|[A-Za-z]:[\\/])/.test(options.root)) {
        throw new Error(`sssb/${rule} needs { root }: the absolute path of SSSB's repository root`)
    }
    return options
}
// A JSON file read when a rule runs, kept until the file changes, so an editor's lint server sees an edit.
const jsonCache = new Map()
const readJson = (file) => {
    const { mtimeMs } = statSync(file)
    const cached = jsonCache.get(file)
    if (cached?.mtimeMs === mtimeMs) return cached.value
    const value = JSON.parse(readFileSync(file, 'utf8'))
    jsonCache.set(file, { mtimeMs, value })
    return value
}
const realRootOf = (root) => realpathSync(root).toLowerCase()

// NO BARE @sssb/kit IN ANY OTHER SSSB PACKAGE (ADR-0014, rule 4; P4). @sssb/tools (and every SSSB package after it
// but the framework) has no dependency on @sssb/kit, so a bare `@sssb/kit/…` resolved from the package's own location
// finds whichever copy pnpm hoisted into `.pnpm/node_modules`: in a workspace with two apps, the other app's
// instance on the other app's seam. ADR-0014's independent review reproduced exactly that. Those packages reach the
// framework only through the shared resolver (packages/tools/src/kit.js), which resolves from the APP's directory
// and checks the real path, and whose specifiers are built at run time, never written as a literal. It sees a
// declaration, `export … from`, import(), a type import('…'), require(), `import x = require(…)`, any `.resolve('…')`
// call (require.resolve, createRequire(…).resolve, import.meta.resolve), and vitest's loaders: every way the slip can
// be written with a literal.
const isBareKitSpecifier = (specifier) => typeof specifier === 'string' && /^@sssb\/kit(\/|$)/.test(specifier.trim())
/** @type {import('eslint').Rule.RuleModule} */
const bareKitImport = {
    meta: {
        type: 'problem',
        docs: { description: 'SSSB packages other than the framework never name @sssb/kit by a bare specifier.' },
        schema: [],
        messages: {
            bare:
                '`{{specifier}}` names the framework by a bare specifier, which resolves from this package, not from ' +
                "the app, and can load another app's @sssb/kit (ADR-0014, rule 4). Reach it through the shared resolver " +
                '(packages/tools/src/kit.js: resolveAppsKit(appDir, subpath)).',
        },
    },
    create(context) {
        const check = (node) => {
            const specifier = literalSpecifier(node)
            if (isBareKitSpecifier(specifier)) context.report({ node, messageId: 'bare', data: { specifier } })
        }
        return {
            ...declarationlessVisitors(check),
            ...declarationVisitors((_node, source) => check(source)),
            'CallExpression[callee.type="MemberExpression"][callee.property.name="resolve"]': (node) =>
                check(node.arguments[0]),
            'CallExpression[callee.object.name=/^(vi|jest)$/][callee.property.name=/^(mock|doMock|unmock)$/]': (node) =>
                check(node.arguments[0]),
        }
    },
}

// SSSB's PUBLIC SURFACE (ADR-0012). packages/kit/package.json's `exports` map names the subpaths an app may import;
// the rest of the package is internal, reachable only by relative import inside packages/kit. SSSB's repository
// ALIASES `@sssb/kit` to source in tsconfig paths, both vitest configs and each app's vite build, and an alias
// bypasses the exports map entirely — so on its own the map is a comment, not a boundary. This rule is the
// boundary: it reads the SAME map (`{ root }/packages/kit/package.json`, when it runs) and fails any
// `@sssb/kit/<subpath>` specifier the map does not publish. An adopter does not need it: TypeScript's resolution
// already refuses an unpublished subpath of a real installed package (ADR-0014, part 4).
const KIT_MANIFEST = 'packages/kit/package.json'
const publicSurfaceOf = (manifest) => {
    const subpaths = new Set()
    const patterns = []
    for (const [key, target] of Object.entries(readJson(manifest).exports ?? {})) {
        // `null` targets are explicit denials, and `.`/`./package.json` are not module subpaths.
        if (target === null || key === '.' || key === './package.json') continue
        const subpath = key.replace(/^\.\//, '')
        if (subpath.includes('*')) {
            const [prefix, suffix] = subpath.split('*')
            patterns.push({ prefix, suffix })
        } else {
            subpaths.add(subpath)
        }
    }
    return (specifier) => {
        const subpath = specifier.slice('@sssb/kit/'.length)
        if (subpaths.has(subpath)) return true
        return patterns.some(
            ({ prefix, suffix }) =>
                subpath.length >= prefix.length + suffix.length &&
                subpath.startsWith(prefix) &&
                subpath.endsWith(suffix),
        )
    }
}
/** @type {import('eslint').Rule.RuleModule} */
const publicSurface = {
    meta: {
        type: 'problem',
        docs: {
            description: "Only SSSB's published subpaths (packages/kit/package.json `exports`) may be imported.",
        },
        schema: [rootOption],
        messages: {
            private:
                "`{{specifier}}` is not part of SSSB's public surface — it is an internal of packages/kit, " +
                'reachable only by relative import inside the package. Import a published subpath ' +
                '(packages/kit/package.json `exports`) instead, or promote this module by adding it there ' +
                'if it is genuinely part of the contract (ADR-0012).',
        },
    },
    create(context) {
        const isPublic = publicSurfaceOf(join(optionsOf(context, 'public-surface').root, KIT_MANIFEST))
        // Every place an import fence reads a specifier (./import-ban.js), so a template literal, a type-position
        // import('…'), `import x = require('…')`, vi.requireActual and a specifier with spaces around it are read as
        // an import declaration is: each compiles and runs against the internal module through the source alias.
        const check = (node) => {
            const value = literalSpecifier(node)?.trim()
            if (typeof value !== 'string' || !value.startsWith('@sssb/kit/')) return
            if (isPublic(value)) return
            context.report({ node, messageId: 'private', data: { specifier: value } })
        }
        return {
            ...declarationVisitors((_declaration, source) => check(source)),
            ...declarationlessVisitors(check),
            // vitest/jest mock a module by specifier, which resolves exactly like an import.
            'CallExpression[callee.object.name=/^(vi|jest)$/][callee.property.name=/^(mock|doMock|unmock)$/]': (node) =>
                check(node.arguments[0]),
        }
    },
}

// THE FENCE BY PATH. A relative or absolute specifier, or a `file:` URL, names a FILE, so what matters is where it
// lands, not how it is spelled: `../../../../apps/showcase/src/domain/tickets` from SSSB's server-lib, the same with
// `//` or `\` separators, or `../../../../packages/seed/src/index`. Each names app content with no alias for a
// pattern to see. sssb/no-path-to-app-code resolves the path against the importing file and reports it if it lands
// in an app (`apps/`) or the app's seed package (`packages/seed/`, which `@app/seed` names); any other path out of
// packages/kit is sssb/no-path-out-of-package's finding. Matching ignores case, as macOS's file system does, and
// follows symlinks: the path is judged by where it really lands, so neither a symlink into app code nor a checkout
// opened through a symlinked directory (an editor's workspace, say) moves it out of reach. A specifier that is not a
// path is the pattern fence's, and so is a path through node_modules, which these rules leave alone: one finding,
// not two.
const APP_CODE_DIRS = ['apps', 'packages/seed']
const throughNodeModules = new RegExp(nodeModulesPathPattern.regex, 'iu')
// Where `target` really is: symlinks resolved through its deepest existing ancestor, because a specifier names a
// module without its extension, or one that does not exist yet.
const RESOLVED_EXTENSIONS = ['.ts', '.tsx', '.mts', '.cts', '.d.ts', '.js', '.jsx', '.mjs', '.cjs']
// A `.js` specifier names its TypeScript source to the compiler and the bundlers (`./roles.js` for `roles.ts`).
const TYPESCRIPT_TWINS = {
    '.js': ['.ts', '.tsx', '.d.ts'],
    '.jsx': ['.tsx'],
    '.mjs': ['.mts', '.d.mts'],
    '.cjs': ['.cts', '.d.cts'],
}
const isFileAt = (file) => {
    try {
        return statSync(file).isFile()
    } catch {
        return false
    }
}
const isDirectoryAt = (file) => {
    try {
        return statSync(file).isDirectory()
    } catch {
        return false
    }
}
// Where `target` really is when nothing of it is a file to follow: symlinks resolved through its deepest existing
// ancestor, because a specifier can name a module that does not exist yet.
const realPathThroughAncestors = (target) => {
    const missing = []
    let existing = target
    while (!existsSync(existing) && dirname(existing) !== existing) {
        missing.unshift(basename(existing))
        existing = dirname(existing)
    }
    return join(realpathSync(existing), ...missing)
}
/**
 * EVERY file a resolver could load for `target`, real paths, in the order resolvers try them: the file itself; the name
 * with each extension (a module is named without one, and a resolver prefers `zz.ts` to a directory `zz/`); a
 * directory's `index` with each extension; a missing `.js` name's TypeScript twin (`roles.js` for `roles.ts`). The
 * extension a probe added to the name is taken off again, so a landing reads as the specifier did. When none exists,
 * the target itself, through its deepest existing ancestor. A path rule judges every one: resolvers differ in which
 * they pick, and a symlink at any of them (`zz.ts` beside a real `zz/`, `yy/index.ts`, `zzkit.ts` named `zzkit.js`)
 * would otherwise go unseen.
 * @param {string} target
 * @returns {string[]}
 */
const landingsOf = (target) => {
    if (isFileAt(target)) return [realpathSync(target)]
    /** @type {string[]} */
    const landings = []
    for (const ext of RESOLVED_EXTENSIONS) {
        if (!isFileAt(`${target}${ext}`)) continue
        const real = realpathSync(`${target}${ext}`)
        landings.push(real.endsWith(ext) ? real.slice(0, -ext.length) : real)
    }
    if (isDirectoryAt(target)) {
        for (const ext of RESOLVED_EXTENSIONS) {
            const index = join(target, `index${ext}`)
            if (isFileAt(index)) landings.push(realpathSync(index))
        }
    } else {
        const ext = /\.[cm]?jsx?$/.exec(target)?.[0]
        for (const twin of (ext && TYPESCRIPT_TWINS[ext]) ?? []) {
            const file = `${target.slice(0, -ext.length)}${twin}`
            if (isFileAt(file)) landings.push(realpathSync(file))
        }
    }
    landings.push(realPathThroughAncestors(target))
    return [...new Set(landings)]
}
/** The first of landingsOf(target): the file a resolver loads, for a rule that judges one landing. */
const realPathOf = (target) => landingsOf(target)[0]
// The file a path specifier names: a `file:` URL's (Node loads one as the absolute path it names), or a relative or
// absolute path resolved against the importer. Anything else is not a path.
const pathTarget = (filename, specifier) => {
    if (/^file:/i.test(specifier)) {
        try {
            return fileURLToPath(specifier)
        } catch {
            return undefined // a remote host, an encoded slash or a malformed URL: Node loads no file from it
        }
    }
    if (!/^(\.{1,2}([\\/]|$)|[\\/])/.test(specifier)) return undefined
    return resolve(dirname(filename), specifier.replaceAll('\\', '/'))
}
// Where a path specifier really lands, relative to the repo root and `/`-separated; undefined for a specifier that
// is not a path, or a path through node_modules (the pattern fence's).
const landingOfPath = (repoRoot, filename, specifier) => {
    const target = throughNodeModules.test(specifier) ? undefined : pathTarget(filename, specifier)
    if (!target) return undefined
    return relative(repoRoot, realPathOf(target).toLowerCase()).replaceAll('\\', '/')
}
const isUnder = (fromRoot, dir) => fromRoot === dir || fromRoot.startsWith(`${dir}/`)
// Both readings of a path specifier: as written, and cut at its first `?` or `#` (by index: `/[?#].*$/` retried from
// every `?` in a long run, which a linted file controls, and took time quadratic in it). Vite and Vitest load the file a
// relative path's query or hash is cut from; the compiler reads it as written. A `file:` URL's are URL syntax, which
// fileURLToPath reads, so it has one reading. Both path rules judge both readings, so neither can hand the other a
// specifier whose second reading lands somewhere only the other rule would have looked.
const readingsOf = (specifier) => {
    const cut = /^file:/i.test(specifier) ? -1 : specifier.search(/[?#]/)
    return cut < 0 ? [specifier] : [specifier, specifier.slice(0, cut)]
}
// A triple-slash `path=` or `types=` reference, in any case and with its attributes in any order: the compiler loads
// what it names just as an import does. A `types=` that names a package is not a path, and pathTarget leaves it alone.
const REFERENCE_DIRECTIVE = /^\/\s*<reference\s[^>]*?\b(path|types)\s*=\s*(["'])(.+?)\2/i
/** Each `/// <reference path|types="…" />` in the file: `{ loc, kind, value }`. */
const referenceDirectives = (context) =>
    context.sourceCode.getAllComments().flatMap((comment) => {
        const match = comment.type === 'Line' ? REFERENCE_DIRECTIVE.exec(comment.value) : null
        return match ? [{ loc: comment.loc, kind: match[1].toLowerCase(), value: match[3] }] : []
    })

/** @type {import('eslint').Rule.RuleModule} */
const pathToAppCode = {
    meta: {
        type: 'problem',
        docs: { description: 'Framework code does not reach app content by a relative or absolute path.' },
        schema: [rootOption],
        messages: {
            path:
                '`{{specifier}}` is a path into {{dir}}/: app content under another name. Framework code ' +
                '(packages/kit) reaches app content only through the @sssb/app-config/* seam (ADR-0012).',
        },
    },
    create(context) {
        const repoRoot = realRootOf(optionsOf(context, 'no-path-to-app-code').root)
        // The app directory either reading of the specifier lands in, or undefined.
        const appDirOf = (specifier) => {
            for (const reading of readingsOf(specifier.trim())) {
                const fromRoot = landingOfPath(repoRoot, context.filename, reading)
                const dir = fromRoot === undefined ? undefined : APP_CODE_DIRS.find((d) => isUnder(fromRoot, d))
                if (dir) return dir
            }
            return undefined
        }
        const report = (loc, specifier) => {
            const dir = appDirOf(specifier)
            if (dir) context.report({ ...loc, messageId: 'path', data: { specifier, dir } })
        }
        const check = (node) => {
            const specifier = literalSpecifier(node)
            if (typeof specifier === 'string') report({ node }, specifier)
        }
        return {
            ...declarationVisitors((_node, source) => check(source)),
            ...declarationlessVisitors(check),
            // `/// <reference path="…" />` makes the compiler load a file just as an import does.
            Program: () => {
                for (const { loc, value } of referenceDirectives(context)) report({ loc }, value)
            },
        }
    },
}

// THE PACKAGE'S EDGE (ADR-0014 P3). @sssb/kit is installed from a tarball of packages/kit's `files` alone, so a path
// to anything else names a file an adopter does not have: until P3, 23 of SSSB's tests and one shipped conformance
// suite reached the repo's tests/support/tmp-dir.ts that way, and the suite could not run from the tarball. A path is
// judged where it really lands, exactly as sssb/no-path-to-app-code judges one, and a landing in app code is that
// rule's finding, not this one's. This rule reports, from any file in packages/kit (fixture included):
//  - a path that lands outside packages/kit;
//  - an absolute path or a `file:` URL, wherever it lands: it names this checkout, which an adopter's machine has not;
//  - from a SHIPPED file, a path to a file the tarball leaves out (a test, a story, the fixture, a config), which
//    exists here, so it typechecks and runs here and fails only once installed.
// "Shipped" reads packages/kit/package.json's `files` when the rule runs: `src`, minus every test and story, plus the
// files it names back, and package.json and LICENSE, which ship whatever `files` says. A `/// <reference path=…>` or
// relative `types=…` counts as a path too.
const KIT_DIR = 'packages/kit'
const SCRIPT_EXT = /\.[cm]?[jt]sx?$/
const TEST_OR_STORY = /\.(test|stories)(\.[cm]?[jt]sx?)?$/
// npm and pnpm ship a package's own package.json (and its LICENSE) whatever `files` says.
const ALWAYS_SHIPPED = new Set([`${KIT_DIR}/package.json`, `${KIT_DIR}/license`])
const shippedKitFiles = (manifest) => {
    const reincluded = new Set(
        (readJson(manifest).files ?? [])
            .filter((entry) => !entry.startsWith('!') && entry !== 'src')
            .map((entry) => `${KIT_DIR}/${entry}`.toLowerCase()),
    )
    // A suite named back is shipped by its exact name, or by its name less the extension when a specifier omits it.
    const isReincluded = (fromRoot) =>
        reincluded.has(fromRoot) ||
        (!SCRIPT_EXT.test(fromRoot) && [...reincluded].some((file) => file.replace(SCRIPT_EXT, '') === fromRoot))
    return (fromRoot) =>
        ALWAYS_SHIPPED.has(fromRoot) ||
        (isUnder(fromRoot, `${KIT_DIR}/src`) && (!TEST_OR_STORY.test(fromRoot) || isReincluded(fromRoot)))
}
const isAbsoluteSpecifier = (specifier) => /^file:/i.test(specifier) || /^[\\/]/.test(specifier)
/** @type {import('eslint').Rule.RuleModule} */
const pathOutOfPackage = {
    meta: {
        type: 'problem',
        docs: {
            description: "Framework code reaches only what @sssb/kit's tarball holds, and only by a relative path.",
        },
        schema: [rootOption],
        messages: {
            outside:
                '`{{specifier}}` leaves packages/kit (it lands in {{landing}}): @sssb/kit is installed from a ' +
                'tarball of packages/kit alone, so an adopter has nothing there. Move what it needs into the ' +
                'package (ADR-0014 P3).',
            absolute:
                '`{{specifier}}` is an absolute path or a `file:` URL: it names this checkout ({{landing}}), which ' +
                "an adopter's machine does not have. Use a relative path (ADR-0014 P3).",
            unshipped:
                "`{{specifier}}` reaches {{landing}}, which packages/kit/package.json's `files` leaves out of the " +
                'tarball, from a file that ships: it resolves here and fails once installed. Ship it, or move ' +
                'what this file needs into shipped source (ADR-0014 P3).',
        },
    },
    create(context) {
        const { root } = optionsOf(context, 'no-path-out-of-package')
        const repoRoot = realRootOf(root)
        const isShipped = shippedKitFiles(join(root, KIT_DIR, 'package.json'))
        // The message id and landing for a specifier that crosses the package's edge, or undefined when it does not.
        // Each reading is judged (readingsOf): as written, and with a relative path's `?query` or `#hash` cut off.
        const finding = (rawSpecifier) => {
            for (const reading of readingsOf(rawSpecifier)) {
                const found = findingOf(reading)
                if (found) return found
            }
            return undefined
        }
        const findingOf = (specifier) => {
            const landing = landingOfPath(repoRoot, context.filename, specifier)
            if (landing === undefined || APP_CODE_DIRS.some((dir) => isUnder(landing, dir))) return undefined
            if (!isUnder(landing, KIT_DIR)) return { messageId: 'outside', landing: landing || '.' }
            if (isAbsoluteSpecifier(specifier)) return { messageId: 'absolute', landing }
            const importer = relative(repoRoot, realPathOf(context.filename).toLowerCase()).replaceAll('\\', '/')
            if (isShipped(importer) && !isShipped(landing)) return { messageId: 'unshipped', landing }
            return undefined
        }
        const report = (loc, specifier) => {
            const found = finding(specifier.trim())
            if (found)
                context.report({ ...loc, messageId: found.messageId, data: { specifier, landing: found.landing } })
        }
        const check = (node) => {
            const specifier = literalSpecifier(node)
            if (typeof specifier === 'string') report({ node }, specifier)
        }
        return {
            ...declarationVisitors((_node, source) => check(source)),
            ...declarationlessVisitors(check),
            // `/// <reference path="…" />` makes the compiler load a file just as an import does.
            Program: () => {
                for (const { loc, value } of referenceDirectives(context)) report({ loc }, value)
            },
        }
    },
}

// THE KIT BY PATH (an app-side fence; `sssb/public-surface` judges `@sssb/kit/…` specifiers only). @sssb/kit ships
// its source, so `../node_modules/@sssb/kit/src/testing/conformance/suite` from an adopter's app, or
// `../../../packages/kit/src/…` in SSSB's own repository, reaches any internal of the framework past its exports map,
// and compiles and runs. A relative or absolute path, or a `file:` URL, is judged where it really lands (symlinks
// resolved, both readings of a `?`/`#` specifier): inside the package whose nearest package.json names `@sssb/kit` it
// is a finding, unless the importing file is inside that package too (the kit's own files and its fixture). Any
// specifier with a `node_modules` segment is a finding of its own, wherever it lands: a package is imported by its
// name. One finding per node.
const NODE_MODULES_SEGMENT = /(^|[\\/])node_modules([\\/]|$)/i
/** @type {import('eslint').Rule.RuleModule} */
const pathIntoKit = {
    meta: {
        type: 'problem',
        docs: { description: '@sssb/kit is imported by a published subpath, never by a path into the package.' },
        schema: [],
        messages: {
            kit:
                '`{{specifier}}` is a path into @sssb/kit ({{landing}}), past its exports map. Import `@sssb/kit` by ' +
                'a published subpath (its package.json `exports`) instead.',
            nodeModules:
                '`{{specifier}}` is a path through node_modules. Import a package by its name, and `@sssb/kit` by a ' +
                'published subpath (its package.json `exports`).',
        },
    },
    create(context) {
        /** @type {Map<string, string | null>} the kit package's root a directory is inside, or null */
        const kitRootOf = new Map()
        /** @param {string} dir */
        const kitRootAbove = (dir) => {
            if (kitRootOf.has(dir)) return kitRootOf.get(dir) ?? null
            const manifest = join(dir, 'package.json')
            let found = null
            if (existsSync(manifest)) {
                let name
                try {
                    name = readJson(manifest)?.name
                } catch {
                    name = undefined // a manifest that does not parse names no package
                }
                found = name === '@sssb/kit' ? dir : null
            } else if (dirname(dir) !== dir) {
                found = kitRootAbove(dirname(dir))
            }
            kitRootOf.set(dir, found)
            return found
        }
        const importer = realPathOf(resolve(context.filename))
        const isUnderDir = (file, dir) => file === dir || file.startsWith(`${dir}/`) || file.startsWith(`${dir}\\`)
        // The app's `@/` alias is `src/` of the app (the generator writes `"@/*": ["src/*"]`, and the guide says so):
        // the nearest directory above the importing file with a package.json and a `src/` beside it. A path spelled
        // through it is judged as that path (`@/../../../packages/kit/…`, or a symlink under src/ into the kit).
        const appSrc = (() => {
            for (let dir = dirname(resolve(context.filename)); ; dir = dirname(dir)) {
                if (existsSync(join(dir, 'package.json')) && existsSync(join(dir, 'src'))) return join(dir, 'src')
                if (dirname(dir) === dir) return undefined
            }
        })()
        /** @param {string} reading */
        const targetOf = (reading) => {
            if (reading.startsWith('@/')) return appSrc === undefined ? undefined : resolve(appSrc, reading.slice(2))
            return pathTarget(context.filename, reading)
        }
        /** @type {Map<string, string[]>} each target's landings, for this file: every relative specifier is probed */
        const landingsCache = new Map()
        const landingsFor = (target) => {
            if (!landingsCache.has(target)) landingsCache.set(target, landingsOf(target))
            return /** @type {string[]} */ (landingsCache.get(target))
        }
        // `throughNodeModules`: whether a `node_modules` segment is a finding of its own. Not for a string handed to a
        // `.resolve` that is not a module resolver (`path.resolve('node_modules/.cache/x')`, `Promise.resolve(…)`).
        const finding = (specifier, throughNodeModules = true) => {
            if (throughNodeModules && NODE_MODULES_SEGMENT.test(specifier)) {
                return { messageId: 'nodeModules', landing: '' }
            }
            for (const reading of readingsOf(specifier)) {
                const target = targetOf(reading)
                if (!target) continue
                for (const landing of landingsFor(target)) {
                    const kitRoot = kitRootAbove(dirname(landing))
                    if (kitRoot && !isUnderDir(importer, kitRoot)) return { messageId: 'kit', landing }
                }
            }
            return undefined
        }
        const report = (loc, rawSpecifier, throughNodeModules = true) => {
            const specifier = rawSpecifier.trim()
            const found = finding(specifier, throughNodeModules)
            if (found)
                context.report({ ...loc, messageId: found.messageId, data: { specifier, landing: found.landing } })
        }
        const check = (node, throughNodeModules = true) => {
            const specifier = literalSpecifier(node)
            if (typeof specifier === 'string') report({ node }, specifier, throughNodeModules)
        }
        // A module resolver's `.resolve`: `require.resolve`, `import.meta.resolve`, `createRequire(…).resolve` (also
        // `module.createRequire(…).resolve`).
        const isModuleResolver = (callee) => {
            const object = callee.object
            if (object.type === 'Identifier') return object.name === 'require'
            if (object.type === 'MetaProperty') return object.meta.name === 'import' && object.property.name === 'meta'
            if (object.type !== 'CallExpression') return false
            const made = object.callee
            return (
                (made.type === 'Identifier' && made.name === 'createRequire') ||
                (made.type === 'MemberExpression' &&
                    made.property.type === 'Identifier' &&
                    made.property.name === 'createRequire')
            )
        }
        return {
            ...declarationVisitors((_declaration, source) => check(source)),
            ...declarationlessVisitors(check),
            // vitest/jest mock a module by specifier, which resolves exactly like an import.
            'CallExpression[callee.object.name=/^(vi|jest)$/][callee.property.name=/^(mock|doMock|unmock)$/]': (node) =>
                check(node.arguments[0]),
            // `require.resolve('…')`, `createRequire(…).resolve('…')`, `import.meta.resolve('…')`: a path the caller
            // then reads or loads. Any other `.resolve(…)` (`path.resolve`, `Promise.resolve`) is judged only for a
            // path that lands in the kit: its string need not be a module, so a `node_modules` in it is no finding.
            'CallExpression[callee.type="MemberExpression"][callee.property.name="resolve"]': (node) =>
                check(node.arguments[0], isModuleResolver(node.callee)),
            // `/// <reference path="…" />` makes the compiler load the file just as an import does.
            Program: () => {
                for (const { loc, value } of referenceDirectives(context)) report({ loc }, value)
            },
        }
    },
}

/** Every sssb/* rule, by its id without the prefix. */
export const rules = {
    // app-side: the preset enables these (./app-config.js)
    'no-vendor-import': vendorStatic,
    'no-dynamic-vendor-import': vendorDynamic,
    'no-next-font-google': nextFontGoogle,
    'no-real-adapter-import': realAdapterViaRegistry,
    'no-static-real-adapter-import': staticRealAdapterInAdapters,
    'no-kit-real-adapter-import': kitRealAdapterInAdapters,
    'no-dynamic-real-adapter-import': dynamicRealAdapter,
    'no-process-env': processEnv,
    'no-run-mode-env': runModeEnv,
    'no-literal-a11y-copy': a11yLiteral,
    'no-jsx-literals': jsxLiterals,
    'no-raw-db-handle': rawDbHandle,
    'no-direct-mkdtemp': directMkdtemp,
    'no-path-into-kit': pathIntoKit,
    // SSSB-internal: SSSB's own repository enables these over packages/kit
    'no-app-import': appImport,
    'no-dynamic-app-import': appImportDynamic,
    'no-path-to-app-code': pathToAppCode,
    'no-path-out-of-package': pathOutOfPackage,
    'no-framework-import-in-core': coreFrameworkImport,
    'no-dynamic-framework-import-in-core': coreFrameworkImportDynamic,
    'no-jsx-in-core': jsxInCore,
    'no-bare-kit-import': bareKitImport,
    'public-surface': publicSurface,
}
