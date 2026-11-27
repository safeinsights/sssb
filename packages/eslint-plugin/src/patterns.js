// THE FENCES' VOCABULARY: every import pattern and syntax selector an sssb/* rule enforces, named once. Each
// pattern is written in no-restricted-imports' own shape ({ group } or { regex }, and a message) and is matched
// exactly as that rule matches it (./import-ban.js), but no fence is carried by no-restricted-imports or
// no-restricted-syntax any more: a later config block that sets either rule REPLACES the earlier setting for the
// files it matches (the merge trap), and an adopter's own blocks come after the preset and are free to set
// both. Every fence is a rule with an id of its own (ADR-0014, part 4).

// EVERY extension a fence names. ESLint lints all eight in an SSSB app (its own defaults are .js, .mjs and .cjs,
// typescript-eslint's recommended config adds .ts, .tsx, .mts and .cts, and the react block adds .jsx), so a
// fence that names a DIRECTORY has to hold for each of them. The fences used to say `*.{ts,tsx}`, which let a
// `.mjs` file in an app's src/ import a vendor SDK, read process.env or take the raw db handle with a green lint.
// The runner-shaped carve-outs do NOT take their extensions from here (TEST_FILES and STORY_FILES below, the
// next.config and instrumentation ones in ./app-config.js): each names what its runner actually picks up, and a
// file the runner does not pick up keeps every ban.
export const SRC_EXT = '{ts,tsx,mts,cts,js,jsx,mjs,cjs}'
// vitest's include globs name `*.test.{ts,tsx}` and nothing else, so a `.test.mjs` under src/ is an ordinary
// module that a route can import, and it stays fenced.
export const TEST_FILES = '**/*.test.{ts,tsx}'
// Ladle's stories glob, extension for extension.
export const STORY_FILES = '**/*.stories.{js,jsx,ts,tsx}'

// Vendor SDKs may only be imported inside an adapters directory: packages/kit/src/adapters/ for SSSB's ports,
// an app's src/adapters/real/ for a port the app owns (ADR-0012, addendum 2026-11-16). Two rules enforce the
// one list: sssb/no-vendor-import sees declarations, sssb/no-dynamic-vendor-import sees import(), require() and
// a type-position import('…').
export const vendorSdkPattern = {
    group: [
        '@clerk/*',
        '@aws-sdk/*',
        '@anthropic-ai/*',
        '@sentry/*',
        'posthog-js',
        'posthog-js/*',
        'posthog-node',
        'mailgun.js',
        'mailgun.js/*',
        'pg',
        'pg/*',
    ],
    message:
        "Vendor SDKs may only be imported inside an adapters directory: packages/kit/src/adapters/ for SSSB's " +
        'ports, apps/<app>/src/adapters/real/ for a port the app owns (docs/recipes/app-owned-adapter.md). ' +
        'Code against the port instead (see CONTRIBUTING.md).',
}

// THE SHAPES AN APP'S OWN VENDOR ENTRY MAY TAKE (`sssb.vendors`, and the vendor rules' `vendors` option): a package
// name (`stripe`, `@stripe/stripe-js`) or one subpath of one (`firebase/app`, `@scope/name/sub`), either followed by
// `/*` (what is under it), or a whole scope (`@stripe/*`). A name or subpath bans itself and what is under it, nothing
// else (`firebase/app` bans `firebase/app/x`, not `firebase/apple` or `firebase/auth`). These are exactly what BOTH
// halves of the ban read alike: the declaration half reads gitignore patterns, the dynamic half (import(), require(),
// a type import('…')) only these shapes, so any other gitignore pattern (`@stripe/**`, `stripe-*`, `stripe/`) banned
// a declaration and let import() through. Lowercase, as npm names are: the dynamic half is case-sensitive. A leading
// `!` (a gitignore negation) is refused with the rest.
const PACKAGE_NAME = '[a-z0-9~-][a-z0-9._~-]*'
export const vendorEntrySource = `^(?:@${PACKAGE_NAME}/\\*|(?:@${PACKAGE_NAME}/)?${PACKAGE_NAME}(?:/${PACKAGE_NAME})?(?:/\\*)?)$`
export const vendorEntryShapes =
    '"name", "@scope/name", either with one subpath ("name/sub"), each optionally followed by "/*", or "@scope/*"'

// An app's real adapter is reached through the app's adapter registry (src/adapters/index.ts), the module that
// picks the fake in simulated mode — the role SSSB's exports map plays for SSSB's own real adapters. Matches
// `@/…/adapters/real` and its ordinary relative spellings (`../adapters/real`, `../../adapters/real`), and
// nothing that starts with `@sssb/kit/`, so SSSB's three published real-mode components stay importable. It reads
// the specifier as written: an unnormalized one (`../adapters/fake/../real/kv`) gets past it, as a computed
// specifier gets past every import rule.
//
// DECLARATIONS only, and deliberately so: a dynamic import inside an `!isSimulated` branch is exactly how a
// real-mode-only component is reached (SSSB's own sign-in form is loaded that way by the app's sign-in page).
export const appRealAdapterPattern = {
    regex: '^(?:@|\\.{1,2})/(?:.*/)?adapters/real(?:/|$)',
    message:
        "Reach the app's real adapters through its registry (apps/<app>/src/adapters/index.ts), which serves " +
        'the fake in simulated mode — a static import loads the vendor in every run mode and skips the fake. ' +
        'A real-mode-only component is the exception, reached by import() inside an !isSimulated branch the ' +
        "way SSSB's sign-in form is (docs/recipes/app-owned-adapter.md).",
}
// INSIDE the app's adapters directory the rule is stricter: real/ is reached only by `import()`, and the
// registry's `await import('./real/index')` when !isSimulated is the one place that should do it. A static import
// from a fake would load the vendor SDK into a simulated `pnpm dev`, and from the registry it would load it in
// every mode. Matches `./real`, `../real`, `../../adapters/real` and `@/…/adapters/real`.
export const appRealAdapterStaticPattern = {
    regex: '^(?:@/(?:.*/)?adapters|\\.{1,2}(?:/.*)?)/real(?:/|$)',
    message:
        "Inside apps/<app>/src/adapters, real/ is loaded only with import() — the registry's " +
        "`await import('./real/index')` when !isSimulated. A static import loads the vendor SDK in simulated " +
        'mode too (docs/recipes/app-owned-adapter.md).',
}
// SSSB publishes a few of its own real adapters (`@sssb/kit/adapters/real/*`: the real-adapter set, the LLM client, S3 storage, the
// real-mode forms and providers, the migrate handler). Importing one loads its vendor SDK, so outside the app's own
// real adapters (which may build on one, as an app-owned storage adapter builds on `createS3Storage`) a module
// reaches one only by import(), the way the sign-in page loads SSSB's sign-in form when !isSimulated. DECLARATIONS
// only, like the app's own real-adapter rule, less a declaration that is type-only as a whole (`import type`,
// `export type … from`), which loads nothing (`allowTypeOnly`, ./import-ban.js); an inline `import { type X }` does.
export const kitRealAdapterPattern = {
    regex: '^@sssb/kit/adapters/real/',
    message:
        "Outside the app's own real adapters (src/adapters/real/), SSSB's real adapters (@sssb/kit/adapters/real/*) " +
        'are loaded only with import(), when !isSimulated: a static import loads the vendor SDK in simulated mode ' +
        "too. Reach SSSB's ports through its registry (@sssb/kit/adapters/index) (docs/recipes/app-owned-adapter.md).",
}

// Hermetic dev: next/font/google fetches from Google Fonts at build, so pnpm dev would phone home. Self-host
// via next/font/local instead.
export const nextFontPattern = {
    group: ['next/font/google', 'next/font/google/*'],
    message:
        'next/font/google phones home to Google Fonts at build — banned to keep dev hermetic (CLAUDE.md); use next/font/local.',
}

// THE FRAMEWORK/APP FENCE (ADR-0012), which holds inside packages/kit only. The framework IS a package, so the
// fence is a package boundary: nothing inside it may reach the host app's code. The app's `@/*` alias still
// resolves from anywhere in SSSB's repo (tsconfig paths are global), so it is banned wholesale, along with the
// app's seed package. The `@sssb/app-config/*` seam is the one sanctioned door; it is DELIBERATELY distinct from
// `@/app-config/*` so the fenced form stays bannable.
//
// A `regex`, not a `group`: the `@/*` group (gitignore syntax, through the `ignore` package) does not match an
// empty segment, and an app's tsconfig maps `@/*` to `./src/*`, so `@//domain/tickets` reached app code past it.
// So `@` followed by ANY slash is the alias, and `@app` then slashes then `seed` is the seed; nothing published is
// named either way. A fuzz of some 7,000 spellings against TypeScript's resolver found no other alias spelling.
const appCodePattern = {
    regex: String.raw`^(@[\\/]|@app[\\/]+seed([\\/]|$))`,
    message:
        'Framework code (packages/kit) must reach app content only through the seam — import from the ' +
        "@sssb/app-config/* alias (apps/*/src/app-config/*), never the app's @/* alias or @app/seed (ADR-0012).",
}
// HOW A SPECIFIER CAN REACH APP CODE, every way, and which piece of the fence holds each. Three review rounds each
// found a new spelling, so the fence is built from this list rather than from the spellings:
//  1. an alias: `@/…` and `@app/seed…` (appCodePattern);
//  2. a PATH (`./`, `../`, `/`, `\`, or a `file:` URL): wherever it is spelled to go, it lands somewhere, symlinks
//     and all (sssb/no-path-to-app-code resolves it and asks where);
//  3. a package or alias specifier that climbs out of itself with `..` (bareTraversalPattern);
//  4. a specifier through a `node_modules` directory, where pnpm links the apps and the seed among other workspace
//     packages (nodeModulesPathPattern);
//  5. an app's package by name: SSSB depends on no app package, so a bare `showcase` resolves to nothing.
// Out of reach of every import rule, here as everywhere: a computed specifier (`import(name)`), a `data:` URL,
// whose module can name a file of its own, and a require not called by that name (`createRequire(…)(…)`,
// `module.require(…)`).
//
// A specifier that matches two of these patterns is two findings, in both halves: each half reports every pattern
// that matches. Nothing is exempted from one pattern because another "already bans it": the traversal ban once
// exempted `@/…` and `@app/seed…` that way, and missed `@\..\..\apps\…` and then `@//../../apps/…`, two spellings
// (1)'s group does not match. A double report on a strange specifier costs less than a hole.
//
// (3) `@sssb/app-config/../seed` resolves to the app's seed through the one door the fence leaves open, and
// `@scope/../../apps/…`, `.x/../../apps/…` and `lodash/../../packages/seed/src/index` resolve out of node_modules
// into app code (TypeScript's resolver does, and Node's `require()` when the specifier spells the file's
// extension); no package specifier has a reason to say `..`. Banned in any specifier that is not a path (a `./`,
// `../`, `/` or `\` path, or a `file:` URL, is (2)'s).
const bareTraversalPattern = {
    regex: String.raw`^(?!\.{1,2}([\\/]|$))(?![\\/])(?!file:)(.*[\\/])?\.\.([\\/]|$)`,
    message:
        'Framework code (packages/kit) must reach app content only through the seam — a `..` in a package or ' +
        'alias specifier climbs out of it, into app code the seam does not register. Import the module directly ' +
        '(ADR-0012).',
}
// (4) `.pnpm/node_modules/showcase/src/…`, or `../../node_modules/.pnpm/node_modules/@app/seed/…`: a package
// reached by where pnpm put it rather than by its name. Nothing in SSSB imports through node_modules.
export const nodeModulesPathPattern = {
    regex: String.raw`(^|[\\/])node_modules([\\/]|$)`,
    message:
        'Framework code (packages/kit) must reach app content only through the seam, and imports a package by its ' +
        'name, never through node_modules: pnpm links every workspace package there, the apps and the seed among ' +
        'them (ADR-0012).',
}
export const appCodePatterns = [appCodePattern, bareTraversalPattern, nodeModulesPathPattern]
// @sssb/kit/core is pure TypeScript (ADR-0006).
export const coreFrameworkPattern = {
    group: ['react', 'react-*', 'next', 'next/*', 'next-intl', 'next-intl/*', '@mantine/*'],
    message: '@sssb/kit/core is pure TypeScript — no framework imports (ADR-0006).',
}

// THE TENANCY BAN's selectors (ADR-0004), enforced by sssb/no-raw-db-handle. They used to be no-restricted-syntax
// selectors, re-listed in every block that bans getDb, and the merge trap dropped one of them for every route,
// page and component (a later block's list replaced the earlier one for those files).
// These aim at the ACT — naming `getDb` — rather than one syntactic shape of it, because shape-matching was
// bypassed twice. They do NOT catch every indirection and cannot: a name built at runtime (`db['get' + 'Db']()`)
// still walks past them, and no lint rule can chase an arbitrary alias. A key held in a variable is caught where
// the string is written (getDbStringSelector). The real boundary is RLS in the database; this is a fast, local
// reminder.
//
// The history is why they look like this: a call-expression selector missed `const { getDb } = db`, and adding a
// destructuring selector still left `db.getDb.bind(db)`, `db['getDb']()` and destructuring in a function
// PARAMETER. So the MemberExpression form subsumes the original call form, and the ObjectPattern form deliberately
// carries no `VariableDeclarator >` ancestor, which is what makes a destructured parameter count. A key spelled as
// a template literal with no expressions (``db[`getDb`]``) or quoted (`const { 'getDb': g } = db`) names it just
// the same, so both match too.
//
// A KEY can name something three ways: an identifier (`.name`, `{ name }`), a string (`['name']`,
// `{ 'name': x }`), or a template literal with no expressions. Every name these selectors aim at (getDb, `env` on
// `process` or imported from it, a run-mode variable) is matched in all three: through anyKey, or, for getDb's
// member access, the dot selector for the identifier and quotedKey for the other two. `path` is the esquery path
// to the key; `name` is a quoted string or a regex. quotedKey leaves out the identifier because in a computed
// access an identifier is a VARIABLE (`db[k]`), not the name. The anyKey selectors on `process` keep it, so
// `process[env]` with `env` a variable is reported too. A key wrapped in a TypeScript assertion is out of these
// selectors' reach: `process.env['APP_MODE' as const]` passes, and `db['getDb' as const]` is caught only because
// its string is (getDbStringSelector).
const quotedKey = (path, name) =>
    `:matches([${path}.value=${name}], [${path}.expressions.length=0][${path}.quasis.0.value.cooked=${name}])`
const anyKey = (path, name) =>
    `:matches([${path}.name=${name}], [${path}.value=${name}], ` +
    `[${path}.expressions.length=0][${path}.quasis.0.value.cooked=${name}])`
export const getDbSelector = {
    selector: 'MemberExpression[property.name="getDb"]',
    message:
        "App code and SSSB's screens must not use the raw db handle — use db.withTenant() (or a @sssb/kit/db helper) so RLS tenant context is set (ADR-0004).",
}
export const getDbComputedSelector = {
    selector: `MemberExpression[computed=true]${quotedKey('property', '"getDb"')}`,
    message:
        "Reaching the raw db handle as db['getDb'] bypasses the same rule — use db.withTenant() (or a @sssb/kit/db helper) so RLS tenant context is set (ADR-0004).",
}
export const getDbDestructureSelector = {
    selector: `ObjectPattern > Property${anyKey('key', '"getDb"')}`,
    message:
        'Destructuring getDb out of the db port bypasses the same rule — use db.withTenant() (or a @sssb/kit/db helper) so RLS tenant context is set (ADR-0004).',
}
// The name as a STRING anywhere else: `Reflect.get(db, 'getDb')`, `Object.getOwnPropertyDescriptor(db,
// 'getDb')`, a key held in a variable (`const k = 'getDb'; db[k]()`). Reaching the handle that way needs the
// string, so the string is the finding. What is left out:
//  - a computed member's key: the computed selector above reports it (no double report). A destructured key is
//    reported by the destructure selector, and is left out with the rest of the keys below.
//  - a key that DEFINES a member rather than reading one: a quoted key in an object literal, a class (abstract and
//    accessor members included), or a type (`{ 'getDb': … }`, `'getDb'() {}`,
//    `interface P { 'getDb'(): unknown }`), as the unquoted key is.
//  - a TypeScript type position (`Pick<DbPort, 'getDb'>`), which loads nothing.
//  - in a TEST FILE only, a spy's key (`vi.spyOn(db, 'getDb')`), which is how a route test asserts the raw handle
//    is never taken. A spy calls through to the original, so anywhere else it IS the raw handle; the rule checks
//    the file name for this one. RESIDUAL, accepted: in a test the spy calls through too, so a route test that
//    calls it (`vi.spyOn(db, 'getDb')()`) does take the handle. The ban guards the code under test; a test that
//    reaches past it is a review matter.
export const getDbStringSelector = {
    selector:
        ':matches(Literal[value="getDb"], TemplateLiteral[expressions.length=0][quasis.0.value.cooked="getDb"])' +
        ':not(MemberExpression[computed=true] > .property)' +
        ':not(:matches(Property, MethodDefinition, PropertyDefinition, AccessorProperty, TSAbstractMethodDefinition, ' +
        'TSAbstractPropertyDefinition, TSAbstractAccessorProperty, TSPropertySignature, TSMethodSignature) > .key)' +
        ':not(TSLiteralType > .literal)',
    message:
        "Naming getDb as a string (Reflect.get(db, 'getDb'), a key held in a variable) reaches the same raw handle — use " +
        'db.withTenant() (or a @sssb/kit/db helper) so RLS tenant context is set (ADR-0004).',
}

// process.env, and the import form — `import { env }`, or a default or namespace import, from
// `process`/`node:process` — which reads the same object under another name (a type-only import, or
// `import { cwd }`, does not). It closes that one form: re-exporting `env` from `node:process`, or
// `const { env } = process`, still gets past, as any alias does (`globalThis.process.env` included).
// `process['env']` is not an alias, it is the same name spelled as a key (anyKey).
export const processEnvSelector = {
    selector:
        `:matches(MemberExpression[object.name="process"]${anyKey('property', '"env"')}, ` +
        'ImportDeclaration[importKind!="type"][source.value=/^(node:)?process$/] > ' +
        `:matches(ImportSpecifier${anyKey('imported', '"env"')}, ImportDefaultSpecifier, ImportNamespaceSpecifier))`,
    message:
        "process.env is read ONLY inside an adapters directory — packages/kit/src/adapters, or an app's own " +
        'apps/<app>/src/adapters/real (CLAUDE.md) — deployment/service params come from the app ' +
        "config/params.ts, run mode from @sssb/kit/adapters (isSimulated/isDemoMode). SSSB's own two secret readers " +
        "in packages/kit are exempted by file in SSSB's eslint.config.mjs.",
}
// An app's real adapter may read its OWN configuration from process.env, but never the run mode. That is SSSB's:
// `appMode`/`isSimulated`/`isDemoMode` from @sssb/kit/adapters/index, whose import also runs the fail-closed
// production guard. A second reader of APP_MODE can disagree with it (SSSB treats a legacy `APP_MODE=fake` as
// simulated) and never runs the guard. Matched: the variable read as a key of `process.env` in any of anyKey's
// three spellings, with `env` itself in any of them too (`process['env'].APP_MODE`), and destructuring in a
// declaration, an assignment or a parameter default. No lint rule chases an alias (`const env = process.env;
// env.APP_MODE`, or `env` imported from `node:process`).
const RUN_MODE_ENV = '/^(APP_MODE|DEMO_MODE|E2E_BUILD)$/'
const runModeEnvMessage =
    "Run mode is SSSB's — import isSimulated/isDemoMode/appMode from @sssb/kit/adapters/index. An app adapter " +
    "that reads APP_MODE, DEMO_MODE or E2E_BUILD itself can disagree with SSSB's registry and skips its " +
    'fail-closed production guard (docs/recipes/app-owned-adapter.md).'
export const runModeEnvSelector = {
    selector:
        `MemberExpression[object.object.name="process"]${anyKey('object.property', '"env"')}` +
        anyKey('property', RUN_MODE_ENV),
    message: runModeEnvMessage,
}
// Destructuring in a declaration, an assignment, or a parameter default — each puts `process.env` on the right of
// the pattern under a different parent node.
export const runModeEnvDestructureSelector = {
    selector:
        `:matches(VariableDeclarator[init.object.name="process"]${anyKey('init.property', '"env"')}, ` +
        `AssignmentExpression[right.object.name="process"]${anyKey('right.property', '"env"')}, ` +
        `AssignmentPattern[right.object.name="process"]${anyKey('right.property', '"env"')}) > ObjectPattern > ` +
        `Property${anyKey('key', RUN_MODE_ENV)}`,
    message: runModeEnvMessage,
}
// Inside an app's adapters directory, only the registry loads real/. A fake, or a second module, doing
// `await import('../real/kv')` would put the vendor SDK behind code that never asks the run mode. The static
// form is appRealAdapterStaticPattern; this is the dynamic one.
const REAL_DIR = '/(^|[/])real([/]|$)/'
export const appRealAdapterDynamicSelector = {
    selector: `ImportExpression:matches([source.value=${REAL_DIR}], [source.quasis.0.value.cooked=${REAL_DIR}])`,
    message:
        "Only the app's registry (apps/<app>/src/adapters/index.ts) loads real/, with import() when " +
        '!isSimulated. Anywhere else in the adapters directory it would load the vendor SDK without asking the ' +
        'run mode (docs/recipes/app-owned-adapter.md).',
}
// i18n (ADR-0008): these attributes carry user-visible copy, which jsx-no-literals can't see (ignoreProps:true).
// Route them through next-intl (a t() call), never a string literal. Stories are carved out (they render
// fixtures, not shipped UI).
export const a11yLiteralSelector = {
    selector: "JSXAttribute[name.name=/^(aria-label|placeholder|title|alt)$/][value.type='Literal']",
    message:
        'aria-label/placeholder/title/alt carry user-visible copy — route them through next-intl (t()), never a string literal (ADR-0008).',
}

// The visitor's origin and address (safeinsights/sssb#131, #132), read only through @sssb/kit/adapters/edge-headers
// (`publicOrigin`, `clientAddress`). Behind SssbApp, `request.url` and `nextUrl` name the server's own bind address
// (`https://localhost:3000`), and the first X-Forwarded-For entry, X-Real-IP, CF-Connecting-IP and Forwarded hold
// whatever the visitor wrote. The obvious forms, never an alias:
// - a header that names the visitor's host or address, by its name as a string (any case), read from something that is
//   plainly a request's headers: `.get`, `.has` or `.getAll` on `<x>.headers`, on `headers()` or `await headers()`
//   (next/headers), or on a variable whose name says header; or a computed key on `<x>.headers` (Node's
//   `req.headers[...]`). A `searchParams.get('host')` or `process.env['HOST']` is not a request's header;
// - the `origin`, `host`, `hostname` or `href` of `new URL(<x>.url)` or of `<x>.nextUrl`, by member or destructuring;
// - `new URL(path, <x>.url)` (or `<x>.nextUrl`), an absolute URL on the server's own host, but where it is handed
//   straight to a `redirect` or `rewrite`: Next relativizes a same-origin redirect a proxy answers;
// - `baseUrl: <x>.url`, the argument SSSB's own `sendOrgInvite` and `applyDemoPreset` take.
// Path and search parameters of the same URLs are right and stay allowed.
const VISITOR_HEADER =
    '/^(host|forwarded|x-forwarded-(for|host|proto|port)|x-real-ip|x-client-ip|cf-connecting-ip|true-client-ip|' +
    'cloudfront-viewer-address|x-sssb-viewer-address)$/i'
const HEADERS_OBJECT = (at) =>
    `:matches([${at}.property.name="headers"], [${at}.name=/header/i], [${at}.callee.name="headers"], ` +
    `[${at}.argument.callee.name="headers"])`
const HEADER_READ = `CallExpression[callee.property.name=/^(get|has|getAll)$/]${HEADERS_OBJECT('callee.object')}`
export const visitorHeaderSelector = {
    selector:
        `:matches(${HEADER_READ}[arguments.0.value=${VISITOR_HEADER}], ` +
        `${HEADER_READ}[arguments.0.type="TemplateLiteral"][arguments.0.expressions.length=0]` +
        `[arguments.0.quasis.0.value.cooked=${VISITOR_HEADER}], ` +
        `MemberExpression[computed=true][property.value=${VISITOR_HEADER}]${HEADERS_OBJECT('object')})`,
    message:
        "Read the visitor's address with clientAddress(request), and their origin with publicOrigin(request), from " +
        '@sssb/kit/adapters/edge-headers, never from a forwarded header: behind CloudFront the first X-Forwarded-For ' +
        "entry, X-Real-IP, CF-Connecting-IP and Forwarded hold what the visitor wrote, and Host is the server's own.",
}
const REQUEST_URL = (at) =>
    `:matches([${at}.type="NewExpression"][${at}.callee.name="URL"][${at}.arguments.length=1]` +
    `[${at}.arguments.0.property.name="url"], [${at}.property.name="nextUrl"])`
const ORIGIN_PART = '/^(origin|host|hostname|href)$/'
export const requestOriginSelector = {
    selector:
        `:matches(MemberExpression[property.name=${ORIGIN_PART}]${REQUEST_URL('object')}, ` +
        `VariableDeclarator${REQUEST_URL('init')} > ObjectPattern > Property[key.name=${ORIGIN_PART}], ` +
        'NewExpression[callee.name="URL"][arguments.length=2][arguments.1.property.name=/^(url|nextUrl)$/]' +
        ':not(CallExpression[callee.property.name=/^(redirect|rewrite)$/] > NewExpression), ' +
        'Property[key.name="baseUrl"][value.type="MemberExpression"][value.property.name="url"])',
    message:
        'Build an absolute URL on publicOrigin(request) from @sssb/kit/adapters/edge-headers: behind SssbApp, the ' +
        "request's own URL names the server's bind address (https://localhost:3000), not the app's. Its path and " +
        'search parameters are right as they are.',
}

// Every pattern frozen, its lists included: the rules read them when they run, and an app's config is code that could
// reach this module by its file path.
for (const pattern of [
    vendorSdkPattern,
    appRealAdapterPattern,
    appRealAdapterStaticPattern,
    kitRealAdapterPattern,
    nextFontPattern,
    appCodePattern,
    bareTraversalPattern,
    nodeModulesPathPattern,
    coreFrameworkPattern,
    getDbSelector,
    getDbComputedSelector,
    getDbDestructureSelector,
    getDbStringSelector,
    processEnvSelector,
    runModeEnvSelector,
    runModeEnvDestructureSelector,
    appRealAdapterDynamicSelector,
    a11yLiteralSelector,
    visitorHeaderSelector,
    requestOriginSelector,
]) {
    if (pattern.group) Object.freeze(pattern.group)
    Object.freeze(pattern)
}
Object.freeze(appCodePatterns)
