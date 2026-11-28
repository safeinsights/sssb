import { existsSync, readFileSync, statSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import ts from 'typescript'
import { FRAMEWORK_POLICY, isGate } from './route-policy'
import {
    type Exemption,
    type ScannedAction,
    type ScannedRoute,
    type ScanRoot,
    type ScanPolicy,
    exemptionFor,
    isPageFileName,
    isReadVerb,
    isUnroutedSegment,
    judge,
    judgeServerAction,
    scanPages,
    scanRoutes,
    scanServerActions,
    serverActionFilesOutsideSrc,
    unreadPageFiles,
    unreadRouteFiles,
} from './route-scan'

/**
 * AN APP'S OWN AUTHORIZATION EXEMPTIONS, and the per-app authorization scan that applies them (the conformance
 * suite's `authz-mutations` check, `@sssb/kit/testing`).
 *
 * The framework's exemption map (./route-policy.ts) is the kit's, and an adopter cannot edit it. A route the app
 * owns that is genuinely not a per-actor product mutation is named in the app's own `authz-exemptions.mjs`, beside
 * its `package.json`, the way `lint-exceptions.mjs` names the app's lint exceptions (ADR-0014 part 3):
 *
 *     export default {
 *         files: { 'partner/ping/route.ts': { reason: '…', mustMatch: { kind: 'calls', callees: ['partner.ping'] } } },
 *         prefixes: { 'hooks/': { reason: '…', mustMatch: { kind: 'wrapped-by', callees: ['withPartnerSignature'] } } },
 *     }
 *
 * Keys are paths relative to the app's `src/app/api`, as the framework's are: `files` names one route file,
 * `prefixes` a directory ending in `/`. Each entry carries a non-empty `reason` and a checkable `mustMatch` gate
 * (./route-scan.ts, `Gate`), for the same reason the framework's do: a gateless entry exempts that path outright.
 * An entry FAILS (and is not applied) when it is malformed, when it overlaps a framework entry (same key, under one
 * of the framework's prefixes, or a prefix over one of its keys — an app cannot weaken a framework gate, the
 * `service/` gate above all), when it is a prefix nested in another of the app's prefixes (both fail: a route under
 * both would get one gate and silently lose the other), or when it matches no judged route (one that exports a handler) in the app's own tree: an app exemption is
 * measured against the app, so a deleted route's exemption cannot wait for a new route at the same path.
 *
 * Since safeinsights/sssb#220: `outsideApi: { files, prefixes }` takes `reads-only` entries keyed from `src/app`; a
 * route group's `(name)` and a slot's `@name` segment are dropped from every key, as from a route's path, and two keys
 * for one route are both refused; one `reads-only` file entry may sit under the framework's `webhooks/` prefix (the
 * one overlap allowed, for reads only); a `reads-only` entry is stale without a read handler it governs, and each name
 * it lists must be one such a read uses.
 *
 * Since safeinsights/sssb#221: pages, layouts and metadata routes are judged as reads, so an `outsideApi.files` key may
 * name one of them (`[locale]/signin/page.tsx`), and a page's export is a read handler for staleness and unused names.
 */

/** The file, beside the app's `package.json`. */
export const APP_EXEMPTIONS_FILE = 'authz-exemptions.mjs'

export interface AppExemptions {
    files: Record<string, Exemption>
    prefixes: Record<string, Exemption>
}

const KEYS = ['files', 'prefixes', 'outsideApi'] as const
const SPACE_KEYS = ['files', 'prefixes'] as const
const ROUTE_FILE = /(?:^|\/)route\.(?:mjs|[jt]sx?)$/
const GLOB = /[*?[\]{}]/
/** A dynamic segment Next routes by (`[id]`, `[...slug]`, `[[...slug]]`): literal in a key, never a glob. */
const DYNAMIC_SEGMENT = /^(?:\[[\w-]+\]|\[\.\.\.[\w-]+\]|\[\[\.\.\.[\w-]+\]\])$/
/**
 * The framework prefixes under which an app may name one file with a reads-only entry: `webhooks/` alone, for a
 * provider's verification handshake (safeinsights/sssb#220). `simulator/`'s guarantee is "404 in real mode", which a
 * reads-only read does not keep.
 */
const READS_ONLY_FRAMEWORK_PREFIXES: readonly string[] = ['webhooks/']
/** Where `outsideApi` keys are measured from: the app's `src/app`, one level above `src/app/api`. */
const OUTSIDE_API = '../'

/** Two keys overlap when they are equal or one is a prefix (`…/`) the other sits under. */
function overlaps(a: string, b: string): boolean {
    return a === b || (a.endsWith('/') && b.startsWith(a)) || (b.endsWith('/') && a.startsWith(b))
}

/**
 * Validates a loaded `authz-exemptions.mjs` default export. Returns the entries that are well formed and do not
 * collide with the framework's policy, and a problem for every one that is not. `label` names the file in messages.
 * Entries under `outsideApi` come back keyed as the scan measures them, with `../` before the key.
 */
export function appExemptionsFrom(value: unknown, label: string): { exemptions: AppExemptions; problems: string[] } {
    const exemptions: AppExemptions = { files: {}, prefixes: {} }
    const problems: string[] = []
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        problems.push(`${label}: its default export must be an object with \`files\` and/or \`prefixes\``)
        return { exemptions, problems }
    }
    const frameworkKeys = [
        ...Object.keys(FRAMEWORK_POLICY.exemptFiles),
        ...Object.keys(FRAMEWORK_POLICY.exemptPrefixes),
        ...Object.keys(FRAMEWORK_POLICY.requiredAlongside),
    ]
    const duplicated = new Set<string>()
    /** Validates one `{ files, prefixes }` space: the api one (keys relative to src/app/api) or `outsideApi`. */
    const space = (key: string, entries: unknown, outside: boolean): void => {
        const name = outside ? `outsideApi.${key}` : key
        if (typeof entries !== 'object' || entries === null || Array.isArray(entries)) {
            problems.push(`${label}: \`${name}\` must map a path to { reason, mustMatch }`)
            return
        }
        const prefix = key === 'prefixes'
        const base = outside ? "the app's src/app" : "the app's src/app/api"
        for (const [written, entry] of Object.entries(entries as Record<string, unknown>)) {
            const where = `${label}: ${name} \`${written}\``
            // Matched as the scan matches a route: by URL, so a route group's and a slot's segment is dropped.
            const rel = written
                .split('/')
                .filter((segment) => !isUnroutedSegment(segment))
                .join('/')
            if (rel === '' || rel === '/') {
                problems.push(
                    `${where} is only route groups or slots, which are not part of a URL: name the path the route is ` +
                        'served at',
                )
                continue
            }
            if (
                rel.startsWith('/') ||
                rel.includes('\\') ||
                rel.split('/').includes('..') ||
                rel.split('/').some((segment) => !DYNAMIC_SEGMENT.test(segment) && GLOB.test(segment))
            ) {
                problems.push(`${where} must be a literal path relative to ${base}, with / separators (no glob)`)
                continue
            }
            if (outside && (rel === 'api/' || rel.startsWith('api/'))) {
                problems.push(`${where} is under src/app/api: name it in \`${key}\`, relative to src/app/api`)
                continue
            }
            if (prefix && !rel.endsWith('/')) {
                problems.push(`${where} is a prefix, so it must end with /`)
                continue
            }
            // Outside src/app/api a file entry may also name a page, a layout or a metadata route (safeinsights/sssb#221),
            // which the scan judges as reads.
            if (!prefix && !ROUTE_FILE.test(rel) && !(outside && isPageFileName(rel.split('/').pop() ?? ''))) {
                problems.push(
                    outside
                        ? `${where} must name one route file (route.ts, route.tsx, route.js, route.jsx, route.mjs), or one ` +
                              'page, layout or metadata route file (page, layout, template, default, loading, not-found, ' +
                              'forbidden, unauthorized, sitemap, robots, manifest, opengraph-image, twitter-image, icon, ' +
                              'apple-icon, with one of those extensions)'
                        : `${where} must name one route file (route.ts, route.tsx, route.js, route.jsx, route.mjs)`,
                )
                continue
            }
            const { reason, mustMatch } = (entry ?? {}) as { reason?: unknown; mustMatch?: unknown }
            if (typeof reason !== 'string' || reason.trim() === '') {
                problems.push(`${where} needs a non-empty reason`)
                continue
            }
            if (!isGate(mustMatch)) {
                problems.push(
                    `${where} has no checkable mustMatch gate — a bare exemption exempts that path outright. ` +
                        'Name the gate the reason rests on (wrapped-by, calls, opens-with-simulated-404 or reads-only).',
                )
                continue
            }
            const readsOnly = mustMatch.kind === 'reads-only'
            if (outside && !readsOnly) {
                problems.push(
                    `${where} must have a reads-only gate: a route outside src/app/api may be exempted only as a read ` +
                        'that names nothing but its request, inert values and the names the gate lists',
                )
                continue
            }
            const collisions = outside ? [] : frameworkKeys.filter((framework) => overlaps(rel, framework))
            // One allowance (safeinsights/sssb#220): a read-only entry for one file under one of the framework's exempt
            // prefixes. It applies to reads only, so every mutation there keeps the framework's gate.
            const underFrameworkPrefix =
                !prefix &&
                readsOnly &&
                collisions.length > 0 &&
                collisions.every(
                    (framework) => READS_ONLY_FRAMEWORK_PREFIXES.includes(framework) && rel.startsWith(framework),
                )
            if (collisions.length > 0 && !underFrameworkPrefix) {
                problems.push(
                    `${where} overlaps the framework's own entry \`${collisions[0]}\`; an app cannot replace or widen a ` +
                        'framework exemption or gate (only a reads-only entry for one file may sit under `webhooks/`, ' +
                        'and it applies to reads only)',
                )
                continue
            }
            const target = prefix ? exemptions.prefixes : exemptions.files
            const stored = outside ? OUTSIDE_API + rel : rel
            // Two written keys for one URL (`feed/route.ts` and `(site)/feed/route.ts`) would leave one silently in force.
            if (Object.hasOwn(target, stored) || duplicated.has(stored)) {
                problems.push(`${where} names the same route as another key once route groups and slots are dropped`)
                delete target[stored]
                duplicated.add(stored)
                continue
            }
            target[stored] = { reason, mustMatch }
        }
    }
    for (const [key, entries] of Object.entries(value)) {
        if (!(KEYS as readonly string[]).includes(key)) {
            problems.push(`${label}: unknown key \`${key}\` (only ${KEYS.map((k) => `\`${k}\``).join(', ')})`)
            continue
        }
        if (key !== 'outsideApi') {
            space(key, entries, false)
            continue
        }
        if (typeof entries !== 'object' || entries === null || Array.isArray(entries)) {
            problems.push(`${label}: \`outsideApi\` must be an object with \`files\` and/or \`prefixes\``)
            continue
        }
        for (const [inner, innerEntries] of Object.entries(entries)) {
            if (!(SPACE_KEYS as readonly string[]).includes(inner)) {
                problems.push(`${label}: unknown key \`outsideApi.${inner}\` (only \`files\` and \`prefixes\`)`)
                continue
            }
            space(inner, innerEntries, true)
        }
    }
    // Nested prefixes (`hooks/` and `hooks/partner/`) would leave the route under both to whichever the scan meets
    // first, silently dropping the other's gate. Neither is applied: the app names one prefix per subtree.
    const appPrefixes = Object.keys(exemptions.prefixes)
    const nested = appPrefixes
        .map((rel) => ({ rel, others: appPrefixes.filter((other) => other !== rel && overlaps(rel, other)) }))
        .filter(({ others }) => others.length > 0)
    for (const { rel, others } of nested) {
        problems.push(
            `${label}: prefixes \`${rel}\` overlaps the app's own prefix ${others.map((o) => `\`${o}\``).join(', ')}; ` +
                'a route under both would get only one of their gates, so neither applies. Use one prefix per ' +
                'subtree, or name the inner routes in `files` (an exact entry wins over a prefix).',
        )
    }
    for (const { rel } of nested) delete exemptions.prefixes[rel]
    return { exemptions, problems }
}

/** Reads `<appDir>/authz-exemptions.mjs`, if the app has one. A file that does not load is a problem, not a throw. */
async function readAppExemptions(appDir: string): Promise<{ exemptions: AppExemptions; problems: string[] }> {
    const file = path.join(appDir, APP_EXEMPTIONS_FILE)
    const label = `${path.basename(appDir)}/${APP_EXEMPTIONS_FILE}`
    if (!existsSync(file)) return { exemptions: { files: {}, prefixes: {} }, problems: [] }
    let loaded: { default?: unknown }
    try {
        // Node's own loader, not the test runner's: under a browser-like test environment (happy-dom) Vite reads an
        // absolute path as a URL under the project root, and a file URL not at all. `require` of an ES module is
        // Node's since 22.12; the file is plain JavaScript, as `lint-exceptions.mjs` is.
        loaded = createRequire(file)(file) as { default?: unknown }
    } catch (error) {
        return {
            exemptions: { files: {}, prefixes: {} },
            problems: [`${label}: does not load: ${error instanceof Error ? error.message : String(error)}`],
        }
    }
    return appExemptionsFrom(loaded.default, label)
}

/** The framework's policy plus an app's (already validated, collision-free) exemptions. */
function policyWithApp(app: AppExemptions): ScanPolicy {
    return {
        ...FRAMEWORK_POLICY,
        exemptPrefixes: { ...FRAMEWORK_POLICY.exemptPrefixes, ...app.prefixes },
        exemptFiles: { ...FRAMEWORK_POLICY.exemptFiles, ...app.files },
    }
}

/** App exemptions that match no judged route in the app's own tree (`judgedRels`, relative to its `src/app/api`). */
function staleAppExemptions(
    app: AppExemptions,
    judged: readonly ScannedRoute[],
    policy: ScanPolicy,
    label: string,
): string[] {
    // A reads-only entry applies to reads only, so it is in use only where a read handler is.
    const covers = (exemption: Exemption, matches: (rel: string) => boolean) =>
        judged.some(
            (route) =>
                matches(route.rel) &&
                (exemption.mustMatch.kind !== 'reads-only' || route.handlers.some((h) => isReadVerb(h.verb))),
        )
    const outside = (rel: string) => rel.startsWith(OUTSIDE_API)
    const key = (kind: string, rel: string) =>
        outside(rel) ? `outsideApi.${kind} \`${rel.slice(OUTSIDE_API.length)}\`` : `${kind} \`${rel}\``
    const tree = (rel: string) => (outside(rel) ? "the app's src/app" : "the app's src/app/api")
    const handler = (exemption: Exemption) =>
        exemption.mustMatch.kind === 'reads-only' ? 'read handler' : 'route handler'
    /**
     * A reads-only entry's names that no read handler it covers names: a name nobody reads would pre-approve it for the
     * next edit, so each one listed has to be in use.
     */
    const unused = (kind: string, rel: string, exemption: Exemption, matches: (r: string) => boolean): string[] => {
        const gate = exemption.mustMatch
        if (gate.kind !== 'reads-only') return []
        const governs = (route: ScannedRoute, h: ScannedRoute['handlers'][number]) =>
            isReadVerb(h.verb) && !h.facts?.reachesAuthorize && exemptionFor(policy, route.rel, h.verb) === exemption
        // A governed read the gate refuses outright (it names something no name excuses) fails already; what it would
        // have named is unknown, so no name is called unused beside that failure.
        if (
            judged.some(
                (route) =>
                    matches(route.rel) && route.handlers.some((h) => governs(route, h) && !h.facts?.outsideNames),
            )
        ) {
            return []
        }
        // Only the reads this entry governs (not one under its own exact entry), and that rest on it (not one that
        // authorizes anyway): a name only those use is in use.
        const read = new Set(
            judged
                .filter((route) => matches(route.rel))
                .flatMap((route) => route.handlers.filter((h) => governs(route, h)))
                .flatMap((h) => [...(h.facts?.outsideNames ?? [])]),
        )
        // One name, one module: a listed name the governed reads import from two modules would let the second module
        // inherit an entry whose reason was written for the first.
        const from = new Map<string, Set<string>>()
        for (const route of judged.filter((r) => matches(r.rel))) {
            for (const h of route.handlers.filter((h) => governs(route, h))) {
                for (const [n, source] of h.facts?.outsideSources ?? [])
                    from.set(n, (from.get(n) ?? new Set()).add(source))
            }
        }
        const split = [...from]
            .filter(([n, sources]) => gate.names.includes(n) && sources.size > 1)
            .map(
                ([n, sources]) =>
                    `${label}: ${key(kind, rel)} lists \`${n}\`, which the reads it covers import from more than one ` +
                    `module (${[...sources].map((f) => path.basename(f)).join(', ')}); each listed name must come from one`,
            )
        return [
            ...split,
            ...gate.names
                .filter((n) => !read.has(n))
                .map(
                    (n) =>
                        `${label}: ${key(kind, rel)} lists \`${n}\`, which no read handler it covers names; ` +
                        'list only what the read uses',
                ),
        ]
    }
    return [
        ...Object.entries(app.files).flatMap(([rel, exemption]) =>
            covers(exemption, (r) => r === rel) ? unused('files', rel, exemption, (r) => r === rel) : [],
        ),
        ...Object.entries(app.prefixes).flatMap(([prefix, exemption]) =>
            covers(exemption, (r) => r.startsWith(prefix))
                ? unused('prefixes', prefix, exemption, (r) => r.startsWith(prefix))
                : [],
        ),
        ...Object.entries(app.files)
            .filter(([rel, exemption]) => !covers(exemption, (r) => r === rel))
            .map(
                ([rel, exemption]) =>
                    `${label}: ${key('files', rel)} is stale — ${tree(rel)} has no ${handler(exemption)} there`,
            ),
        ...Object.entries(app.prefixes)
            .filter(([prefix, exemption]) => !covers(exemption, (r) => r.startsWith(prefix)))
            .map(
                ([prefix, exemption]) =>
                    `${label}: ${key('prefixes', prefix)} is stale — it covers no ${handler(exemption)} in ${tree(prefix)}`,
            ),
    ]
}

export interface AppScan {
    root: ScanRoot
    /** Every route file under the app's `src/app`, whether or not it exports a handler. Empty when there is no `src/app`. */
    routes: ScannedRoute[]
    /**
     * Every page, layout and metadata route under the app's `src/app` (safeinsights/sssb#221), each export Next calls
     * judged as a read; a `'use client'` one has none.
     */
    pages: ScannedRoute[]
    /** Every Server Action under the app's `src`. */
    actions: ScannedAction[]
    /**
     * One message per route handler, page export or Server Action that fails (`<root>: <rel> <VERB> …why`, the export's
     * name for a page's), and one for each
     * Pages Router API directory the app has, which the scan cannot read.
     */
    failures: string[]
    /** The app's exemptions file: malformed, colliding or stale entries. */
    exemptionProblems: string[]
}

/** Whether `file` is a directory (through a link); false when it is missing or a file. */
function isDirectory(file: string): boolean {
    try {
        return statSync(file).isDirectory()
    } catch {
        return false
    }
}

/** The names Next loads its config from, beside the app's `package.json`. */
const NEXT_CONFIGS = [
    'next.config.js',
    'next.config.mjs',
    'next.config.cjs',
    'next.config.ts',
    'next.config.mts',
    'next.config.cts',
]

/**
 * The app's Next configs that name `pageExtensions` (as a property, a shorthand or a string key; read with the
 * TypeScript parser, so a comment does not count). The scan reads only its own extensions, so a custom list would let
 * Next serve a route or page nobody checked: the check fails it rather than pass silently.
 */
function configsSettingPageExtensions(appDir: string): string[] {
    return NEXT_CONFIGS.filter((name) => {
        let text: string
        try {
            text = readFileSync(path.join(appDir, name), 'utf8')
        } catch {
            return false
        }
        if (!text.includes('pageExtensions')) return false
        const sf = ts.createSourceFile(name, text, ts.ScriptTarget.ESNext, false)
        let found = false
        const visit = (node: ts.Node): void => {
            if (found) return
            if ((ts.isIdentifier(node) || ts.isStringLiteralLike(node)) && node.text === 'pageExtensions') found = true
            else ts.forEachChild(node, visit)
        }
        visit(sf)
        return found
    })
}

/** Where Next looks for the Pages Router: `pages` beside `src`, or inside it. */
const PAGES_DIRS = ['pages', 'src/pages']

/**
 * The authorization scan over ONE app: every `route.*` under `<appDir>/src/app` (Next serves one from anywhere
 * there but a private `_` folder, so not only `api/`, and through a symbolic link too), each exported handler, read or mutation, judged against the framework's policy plus the app's
 * own exemptions, which are measured from `<appDir>/src/app/api` (so a route outside `api/` can match only an
 * `outsideApi` entry, whose gate is `reads-only` and which covers reads only; a mutation there must call
 * `authorize(...)` itself). Every page, layout and metadata route there (./route-scan.ts `scanPages`) is judged too,
 * each export Next calls as a read, which may match only a `reads-only` entry (`outsideApi` names one by its file, a
 * `page.tsx` or a `layout.tsx` as a route's `route.ts`). Every Server Action under `<appDir>/src` (a `'use server'` file's
 * exports, and each function whose body opens with `'use server'`) is judged as a POST is, and can match no
 * exemption. A Pages Router API directory fails outright: SSSB apps are App Router, and the scan reads no
 * `pages/api` handler. So does a root-level `app/` directory (Next serves it instead of `src/app`), and a file under
 * `src/app` named `route.<ext>` for an extension the scan does not read (`pageExtensions` is not read). Re-exported handlers are followed with the app's `tsconfig.json` (or `jsconfig.json`).
 */
export async function scanApp(appDir: string): Promise<AppScan> {
    const name = path.basename(appDir)
    const root: ScanRoot = {
        label: name,
        dir: path.join(appDir, 'src/app'),
        exemptDir: path.join(appDir, 'src/app/api'),
        appDir,
        // An app without one (a JS app's jsconfig.json, or neither) still gets scanned: relative re-exports resolve
        // without a config, and an alias that does not resolve is refused, loudly.
        tsconfig: ['tsconfig.json', 'jsconfig.json'].map((file) => path.join(appDir, file)).find((f) => existsSync(f)),
    }
    const { exemptions, problems } = await readAppExemptions(appDir)
    const routes = existsSync(root.dir) ? scanRoutes([root]) : []
    const pages = existsSync(root.dir) ? scanPages([root]) : []
    const judged = [...routes, ...pages].filter((route) => route.handlers.length > 0)
    const policy = policyWithApp(exemptions)
    const srcDir = path.join(appDir, 'src')
    const actions = existsSync(srcDir) ? scanServerActions({ ...root, dir: srcDir, exemptDir: srcDir }) : []
    const outsideUnreadable = new Map<string, string>()
    const outsideActionFiles = serverActionFilesOutsideSrc(appDir, outsideUnreadable)
    const failures = [
        ...judged.flatMap((route) => route.handlers.flatMap((handler) => judge(route, handler, policy) ?? [])),
        ...actions.flatMap((action) => judgeServerAction(action) ?? []),
        ...(isDirectory(path.join(appDir, 'app'))
            ? [
                  `${name}: app/ is a root-level App Router directory. Next serves it and ignores src/app when both ` +
                      `exist, and the authorization scan reads only src/app, so no route in app/ is checked. Keep the ` +
                      `app's routes in src/app.`,
              ]
            : []),
        ...(existsSync(root.dir) ? unreadPageFiles(root.dir) : []).map(
            (file) =>
                `${name}: ${path.relative(appDir, file).split(path.sep).join('/')} is named like a page, layout or ` +
                `metadata route, but the authorization scan reads only those with a .ts, .tsx, .js, .jsx or .mjs ` +
                `extension. If Next serves it (a pageExtensions entry), nothing checked it: rename it to one of those, ` +
                `or to a name Next does not render.`,
        ),
        ...(existsSync(root.dir) ? unreadRouteFiles(root.dir) : []).map(
            (file) =>
                `${name}: ${path.relative(appDir, file).split(path.sep).join('/')} is named like a route, but the ` +
                `authorization scan reads only route.ts, route.tsx, route.js, route.jsx and route.mjs. If Next serves it ` +
                `(a pageExtensions entry), nothing checked it: rename it to one of those, or rename it to something not ` +
                `named route.`,
        ),
        ...[...outsideUnreadable].map(
            ([dir, code]) =>
                `${name}: ${path.relative(appDir, dir).split(path.sep).join('/') || '.'} could not be read (${code}), so ` +
                `a Server Action in it would go unchecked. Make it readable to the user running the check.`,
        ),
        ...outsideActionFiles.map(
            (file) =>
                `${name}: ${path.relative(appDir, file).split(path.sep).join('/')} declares Server Actions outside src, ` +
                `where the authorization scan does not judge them. Move them under src. (Actions a workspace package ` +
                `exports are not read either.)`,
        ),
        ...configsSettingPageExtensions(appDir).map(
            (config) =>
                `${name}: ${config} sets pageExtensions. The authorization scan reads route and page files with the .ts, ` +
                `.tsx, .js, .jsx and .mjs extensions only, not the config, so a route or page Next serves for another ` +
                `extension would go unchecked. Leave pageExtensions at Next's default.`,
        ),
        ...PAGES_DIRS.filter((dir) => isDirectory(path.join(appDir, dir))).map((dir) =>
            isDirectory(path.join(appDir, dir, 'api'))
                ? `${name}: ${dir}/api is a Pages Router API directory. SSSB apps are App Router, and the authorization ` +
                  `scan reads only route handlers and pages under src/app and Server Actions, so nothing in ${dir} is ` +
                  `checked. Move each handler to a route.ts under src/app/api, and each page under src/app.`
                : `${name}: ${dir} is a Pages Router directory, whose pages Next renders on the server. SSSB apps are App ` +
                  `Router, and the authorization scan reads only pages under src/app, so nothing in ${dir} is checked. ` +
                  `Move each page under src/app (as a page.tsx).`,
        ),
    ]
    const label = `${name}/${APP_EXEMPTIONS_FILE}`
    return {
        root,
        routes,
        pages,
        actions,
        failures,
        // An intercepting page can match no exemption, so none keeps an entry alive.
        exemptionProblems: [
            ...problems,
            ...staleAppExemptions(
                exemptions,
                judged.filter((route) => !route.intercepting),
                policy,
                label,
            ),
        ],
    }
}
