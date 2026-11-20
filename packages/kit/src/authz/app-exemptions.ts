import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { FRAMEWORK_POLICY, isGate } from './route-policy'
import {
    type Exemption,
    type ScannedAction,
    type ScannedRoute,
    type ScanRoot,
    type ScanPolicy,
    judge,
    judgeServerAction,
    scanRoutes,
    scanServerActions,
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
 * both would get one gate and silently lose the other), or when it matches no mutating route in the app's own tree: an app exemption is
 * measured against the app, so a deleted route's exemption cannot wait for a new route at the same path.
 */

/** The file, beside the app's `package.json`. */
export const APP_EXEMPTIONS_FILE = 'authz-exemptions.mjs'

export interface AppExemptions {
    files: Record<string, Exemption>
    prefixes: Record<string, Exemption>
}

const KEYS = ['files', 'prefixes'] as const
const ROUTE_FILE = /(?:^|\/)route\.(?:mjs|[jt]sx?)$/
const GLOB = /[*?[\]{}]/

/** Two keys overlap when they are equal or one is a prefix (`…/`) the other sits under. */
function overlaps(a: string, b: string): boolean {
    return a === b || (a.endsWith('/') && b.startsWith(a)) || (b.endsWith('/') && a.startsWith(b))
}

/**
 * Validates a loaded `authz-exemptions.mjs` default export. Returns the entries that are well formed and do not
 * collide with the framework's policy, and a problem for every one that is not. `label` names the file in messages.
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
    for (const [key, entries] of Object.entries(value)) {
        if (!(KEYS as readonly string[]).includes(key)) {
            problems.push(`${label}: unknown key \`${key}\` (only ${KEYS.map((k) => `\`${k}\``).join(' and ')})`)
            continue
        }
        if (typeof entries !== 'object' || entries === null || Array.isArray(entries)) {
            problems.push(`${label}: \`${key}\` must map a path to { reason, mustMatch }`)
            continue
        }
        const prefix = key === 'prefixes'
        for (const [rel, entry] of Object.entries(entries as Record<string, unknown>)) {
            const where = `${label}: ${key} \`${rel}\``
            if (
                rel === '' ||
                rel.startsWith('/') ||
                rel.includes('\\') ||
                rel.split('/').includes('..') ||
                GLOB.test(rel)
            ) {
                problems.push(
                    `${where} must be a literal path relative to the app's src/app/api, with / separators (no glob)`,
                )
                continue
            }
            if (prefix && !rel.endsWith('/')) {
                problems.push(`${where} is a prefix, so it must end with /`)
                continue
            }
            if (!prefix && !ROUTE_FILE.test(rel)) {
                problems.push(`${where} must name one route file (route.ts, route.tsx, route.js, route.jsx, route.mjs)`)
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
                        'Name the gate the reason rests on (wrapped-by, calls or opens-with-simulated-404).',
                )
                continue
            }
            const collision = frameworkKeys.find((framework) => overlaps(rel, framework))
            if (collision !== undefined) {
                problems.push(
                    `${where} overlaps the framework's own entry \`${collision}\`; an app cannot replace or widen a ` +
                        'framework exemption or gate',
                )
                continue
            }
            ;(prefix ? exemptions.prefixes : exemptions.files)[rel] = { reason, mustMatch }
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

/** App exemptions that match no mutating route in the app's own tree (`mutatingRels`, relative to its `src/app/api`). */
function staleAppExemptions(app: AppExemptions, mutatingRels: readonly string[], label: string): string[] {
    return [
        ...Object.keys(app.files)
            .filter((rel) => !mutatingRels.includes(rel))
            .map((rel) => `${label}: files \`${rel}\` is stale — the app's src/app/api has no mutating route there`),
        ...Object.keys(app.prefixes)
            .filter((prefix) => !mutatingRels.some((rel) => rel.startsWith(prefix)))
            .map(
                (prefix) =>
                    `${label}: prefixes \`${prefix}\` is stale — it covers no mutating route in the app's src/app/api`,
            ),
    ]
}

export interface AppScan {
    root: ScanRoot
    /** Every route file under the app's `src/app`, mutating or not. Empty when there is no `src/app`. */
    routes: ScannedRoute[]
    /** Every Server Action under the app's `src`. */
    actions: ScannedAction[]
    /**
     * One message per mutating handler or Server Action that fails (`<root>: <rel> <VERB> …why`), and one for each
     * Pages Router API directory the app has, which the scan cannot read.
     */
    failures: string[]
    /** The app's exemptions file: malformed, colliding or stale entries. */
    exemptionProblems: string[]
}

/** Where Next looks for Pages Router API routes: `pages/api` beside `src`, or inside it. */
const PAGES_API_DIRS = ['pages/api', 'src/pages/api']

/**
 * The authorization scan over ONE app: every `route.*` under `<appDir>/src/app` (Next serves one from anywhere
 * there, so not only `api/`, and through a symbolic link too), judged against the framework's policy plus the app's
 * own exemptions, which are measured from `<appDir>/src/app/api` (so a mutating route outside `api/` can match no
 * exemption and must call `authorize(...)` itself). Every Server Action under `<appDir>/src` (a `'use server'` file's
 * exports, and each function whose body opens with `'use server'`) is judged as a POST is, and can match no
 * exemption. A Pages Router API directory fails outright: SSSB apps are App Router, and the scan reads no
 * `pages/api` handler. Re-exported handlers are followed with the app's `tsconfig.json` (or `jsconfig.json`).
 */
export async function scanApp(appDir: string): Promise<AppScan> {
    const name = path.basename(appDir)
    const root: ScanRoot = {
        label: name,
        dir: path.join(appDir, 'src/app'),
        exemptDir: path.join(appDir, 'src/app/api'),
        // An app without one (a JS app's jsconfig.json, or neither) still gets scanned: relative re-exports resolve
        // without a config, and an alias that does not resolve is refused, loudly.
        tsconfig: ['tsconfig.json', 'jsconfig.json'].map((file) => path.join(appDir, file)).find((f) => existsSync(f)),
    }
    const { exemptions, problems } = await readAppExemptions(appDir)
    const routes = existsSync(root.dir) ? scanRoutes([root]) : []
    const mutating = routes.filter((route) => route.handlers.length > 0)
    const policy = policyWithApp(exemptions)
    const srcDir = path.join(appDir, 'src')
    const actions = existsSync(srcDir) ? scanServerActions({ ...root, dir: srcDir, exemptDir: srcDir }) : []
    const failures = [
        ...mutating.flatMap((route) => route.handlers.flatMap((handler) => judge(route, handler, policy) ?? [])),
        ...actions.flatMap((action) => judgeServerAction(action) ?? []),
        ...PAGES_API_DIRS.filter((dir) => existsSync(path.join(appDir, dir))).map(
            (dir) =>
                `${name}: ${dir} is a Pages Router API directory. SSSB apps are App Router, and the authorization scan ` +
                `reads only route handlers under src/app and Server Actions, so nothing in ${dir} is checked. Move ` +
                `each handler to a route.ts under src/app/api.`,
        ),
    ]
    const label = `${name}/${APP_EXEMPTIONS_FILE}`
    return {
        root,
        routes,
        actions,
        failures,
        exemptionProblems: [
            ...problems,
            ...staleAppExemptions(
                exemptions,
                mutating.map((route) => route.rel),
                label,
            ),
        ],
    }
}
