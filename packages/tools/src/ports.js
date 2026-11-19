// @ts-check
// Per-checkout ports, so two agent sessions in two git worktrees can run dev servers and e2e suites at the same
// time without silently driving each other's app.
//
// The failure this prevents is recorded three times in SSSB's docs/build-notes.md: Playwright's webServer sets
// `reuseExistingServer: !CI`, so a `next dev` that another worktree left on :3000 is ADOPTED rather than replaced,
// and the suite quietly tests someone else's build. The symptoms look exactly like product defects, the tell is
// easy to miss (no `[WebServer]` startup lines in the log), and it has burned multiple full verify runs.
//
// Two properties this derivation must have, and one it must not:
//
//   * PURE FUNCTION OF THE CHECKOUT PATH, not a scan for a free port. An app's `test:e2e` may run several
//     `playwright test` invocations and all must land on the same port. A free-port scan could disagree between
//     them; a hash cannot.
//   * STABLE ACROSS PROCESSES. The package script that starts the server and the Playwright config that points
//     at it compute it independently: they agree only because neither one guesses.
//   * NOT applied to a main checkout. It keeps the documented defaults, so every runbook that names :3000 or
//     :3100 stays true for the person reading it. Only linked worktrees under .claude/worktrees/ derive.
//
// An explicit env var always wins, which is what makes an isolated one-off run possible without editing
// anything: `SHOWCASE_PORT=3210 pnpm dev`.
//
// A SERVICE is one of the built-ins below, named by a string, or a SLOT an app declares for itself in its package.json,
// `"sssb": { "port": { "name": "ledger", "default": 3700 } }`, for a workspace whose apps are not SSSB's two: without
// it two apps made from the starter share `starter`, and so one port. A custom slot follows the same three rules: its
// variable is `LEDGER_PORT`, a main checkout gets its `default`, and a linked worktree derives from a band the
// built-ins do not use (CUSTOM_BAND), keyed on the name as well as the checkout so two slots of one worktree differ.
//
// THIS MODULE MUST PARSE AS BOTH ESM AND CJS, which rules out `import.meta` and `__dirname` alike: Playwright
// compiles `playwright.config.ts`, and everything it imports from outside node_modules, to CommonJS, where
// `import.meta` is a syntax error at config-load time that takes the whole suite with it. Inside SSSB's own
// repository this package is a workspace link, so its real path is outside node_modules and Playwright compiles
// it. Walking up from the working directory is the portable option.
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'

/**
 * The checkout's root: the nearest directory holding `pnpm-workspace.yaml`, else (a repository that is one package,
 * with no workspace file) the nearest holding `.git`, else the working directory itself.
 * @param {string} start
 */
function findCheckoutRoot(start) {
    for (const marker of ['pnpm-workspace.yaml', '.git']) {
        for (let dir = path.resolve(start); ; dir = path.dirname(dir)) {
            if (existsSync(path.join(dir, marker))) return dir
            if (path.dirname(dir) === dir) break
        }
    }
    return path.resolve(start)
}

/**
 * Wide enough that a handful of concurrent worktrees rarely collide (4 worktrees over 200 slots is ~3%), narrow
 * enough to stay in a memorable band. A collision is not silent: the second server fails to bind, which is a
 * loud EADDRINUSE rather than the quiet wrong-app adoption above.
 */
const SLOTS = 200

/**
 * The port services. They are SSSB's two reference apps' slots plus two tools, and an app keeps the slot it was
 * generated with when it is renamed (the starter's `starter` slot is the adopter's app's). Derived showcase and
 * starter ports share a slot and sit adjacent (3200/3201, 3202/3203, …) so one session's pair never straddles
 * another's. No derived band overlaps the defaults.
 * @type {Record<string, { env: string, fallback: number, derive: (slot: number) => number }>}
 */
const SERVICES = {
    showcase: { env: 'SHOWCASE_PORT', fallback: 3000, derive: (slot) => 3200 + slot * 2 },
    starter: { env: 'STARTER_PORT', fallback: 3100, derive: (slot) => 3201 + slot * 2 },
    ladle: { env: 'LADLE_PORT', fallback: 61000, derive: (slot) => 61000 + slot },
    contractPg: { env: 'CONTRACT_PG_PORT', fallback: 5439, derive: (slot) => 5440 + slot },
}

/**
 * @param {string} root
 * @param {string} [name] a custom slot's name, which keys its port as well as the checkout, so two custom slots in
 *   one worktree get different ports. The built-in services pass none and key on the checkout alone, as they always have.
 */
function hashOf(root, name) {
    // Any stable spread works; sha1 is here for distribution, not for security.
    return createHash('sha1')
        .update(name === undefined ? root : `${root}\0${name}`)
        .digest()
        .readUInt32BE(0)
}

/** @param {string} root */
const slotFor = (root) => hashOf(root) % SLOTS

/**
 * The band a custom slot's derived port comes from in a linked worktree: 10000 ports, so two custom slots of one
 * worktree collide about once in ten thousand (a loud EADDRINUSE, never a silent adoption). Clear of every built-in
 * default and derived band (3000, 3100, 3200-3599, 5439-5639, 61000-61199), and below Linux's ephemeral range (32768)
 * and macOS's (49152), so the OS never hands one of these to an outbound connection.
 */
const CUSTOM_BAND = { start: 20000, size: 10000 }

/** The highest port an app may declare as its main-checkout default: above it the OS hands ports out at random. */
const MAX_DECLARED_DEFAULT = 49151

/** The lowest: below it a port needs privileges. */
const MIN_DECLARED_DEFAULT = 1024

const CUSTOM_NAME = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/
const MAX_CUSTOM_NAME_LENGTH = 32

/** @param {string} name */
const customEnvVar = (name) => `${name.toUpperCase().replaceAll('-', '_')}_PORT`

/**
 * What already holds `port` (a built-in default, a built-in derived band or the custom band), or null.
 * @param {number} port
 * @returns {string | null}
 */
function reservedFor(port) {
    for (const [name, spec] of Object.entries(SERVICES)) {
        if (port === spec.fallback) return `the default of the built-in "${name}"`
        if (port >= spec.derive(0) && port <= spec.derive(SLOTS - 1)) {
            return `inside the derived worktree ports of the built-in "${name}"`
        }
    }
    if (port >= CUSTOM_BAND.start && port < CUSTOM_BAND.start + CUSTOM_BAND.size) {
        return 'inside the derived worktree ports of custom slots'
    }
    return null
}

/** @type {import('./ports.d.ts').parsePortDeclaration} */
export function parsePortDeclaration(value, where) {
    const at = where === undefined ? 'ports: ' : `ports: ${where}: `
    if (typeof value === 'string') {
        if (!Object.hasOwn(SERVICES, value)) {
            throw new Error(
                `${at}unknown service "${value}" (known: ${Object.keys(SERVICES).join(', ')}; or declare a slot of ` +
                    'your own, { "name": "<name>", "default": <port> })',
            )
        }
        return /** @type {import('./ports.d.ts').PortService} */ (value)
    }
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
        throw new Error(
            `${at}a port declaration is a service name or { "name": "<name>", "default": <port> }, got ${JSON.stringify(value)}`,
        )
    }
    const { name, default: fallback, ...rest } = /** @type {Record<string, unknown>} */ (value)
    if (Object.keys(rest).length > 0) {
        throw new Error(`${at}a port slot has only "name" and "default", not ${Object.keys(rest).join(', ')}`)
    }
    if (typeof name !== 'string' || !CUSTOM_NAME.test(name) || name.length > MAX_CUSTOM_NAME_LENGTH) {
        throw new Error(
            `${at}a port slot's name is lowercase words joined by "-", at most ${MAX_CUSTOM_NAME_LENGTH} characters ` +
                `(it names the <NAME>_PORT variable), got ${JSON.stringify(name)}`,
        )
    }
    const taken = Object.entries(SERVICES).find(([, spec]) => spec.env === customEnvVar(name))
    if (taken) {
        throw new Error(
            `${at}port slot "${name}" would read ${customEnvVar(name)}, the variable of the built-in service "${taken[0]}": pick another name`,
        )
    }
    if (
        typeof fallback !== 'number' ||
        !Number.isInteger(fallback) ||
        fallback < MIN_DECLARED_DEFAULT ||
        fallback > MAX_DECLARED_DEFAULT
    ) {
        throw new Error(
            `${at}port slot "${name}": "default" must be an integer from ${MIN_DECLARED_DEFAULT} to ${MAX_DECLARED_DEFAULT}, got ${JSON.stringify(fallback)}`,
        )
    }
    const holder = reservedFor(fallback)
    if (holder !== null) {
        throw new Error(`${at}port slot "${name}": default ${fallback} is ${holder}: pick a port outside SSSB's own`)
    }
    return { name, default: fallback }
}

/**
 * @param {import('./ports.d.ts').PortDeclaration} service
 * @returns {{ env: string, fallback: number, derive: (root: string) => number }}
 */
function specFor(service) {
    const declaration = parsePortDeclaration(service)
    if (typeof declaration === 'string') {
        const spec = SERVICES[declaration]
        return { env: spec.env, fallback: spec.fallback, derive: (root) => spec.derive(slotFor(root)) }
    }
    return {
        env: customEnvVar(declaration.name),
        fallback: declaration.default,
        derive: (root) => CUSTOM_BAND.start + (hashOf(root, declaration.name) % CUSTOM_BAND.size),
    }
}

/** @type {import('./ports.d.ts').readPortDeclaration} */
export function readPortDeclaration(appDir) {
    const file = path.join(appDir, 'package.json')
    let manifest
    try {
        manifest = JSON.parse(readFileSync(file, 'utf8'))
    } catch (error) {
        throw new Error(`ports: cannot read ${file}: ${error instanceof Error ? error.message : String(error)}`, {
            cause: error,
        })
    }
    const declared = manifest?.sssb?.port
    return declared === undefined ? undefined : parsePortDeclaration(declared, file)
}

/** @type {import('./ports.d.ts').portForRoot} */
export function portForRoot(root, service, env = process.env) {
    const spec = specFor(service)

    const override = env[spec.env]
    if (override) {
        const parsed = Number(override)
        if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) {
            throw new Error(`ports: ${spec.env} must be a port number, got "${override}"`)
        }
        return parsed
    }

    const linked = root.includes(`${path.sep}.claude${path.sep}worktrees${path.sep}`)
    return linked ? spec.derive(root) : spec.fallback
}

/**
 * The declaration to use when a caller names none: the one the package.json in the working directory makes. A
 * Playwright config runs from its app's directory, so `originFor()` there is the app's own origin.
 * @returns {import('./ports.d.ts').PortDeclaration}
 */
function declaredHere() {
    const declared = readPortDeclaration(process.cwd())
    if (declared === undefined) {
        throw new Error(
            `ports: no service named, and ${path.join(process.cwd(), 'package.json')} declares none ("sssb": { "port": … }): name one, or run this from the app's directory`,
        )
    }
    return declared
}

/** The built-in services that are an APP's slot, as against the tools' (`ladle`, `contractPg`). */
const APP_SERVICES = ['showcase', 'starter']

/** @type {import('./ports.d.ts').foreignAppSlotProblem} */
export function foreignAppSlotProblem(service, declared) {
    if (typeof service !== 'string' || !APP_SERVICES.includes(service)) return null
    if (declared === undefined || typeof declared === 'string') return null
    return (
        `"${service}" is another app's port slot, and this app declares its own, "${declared.name}": ask for it by ` +
        `leaving the service out (originFor(), sssb port, sssb tick) or by name, and drop "${service}" from this app's ` +
        'scripts and Playwright config, or its dev server and its ticker and e2e run would use different ports'
    )
}

/** @type {import('./ports.d.ts').portFor} */
export function portFor(service) {
    // A service an app copied from the starter, `originFor('starter')`, would silently name the starter's port in an
    // app that declares a slot of its own: its dev server on its slot, its e2e run on another app's. Refused.
    if (
        typeof service === 'string' &&
        APP_SERVICES.includes(service) &&
        existsSync(path.join(process.cwd(), 'package.json'))
    ) {
        const problem = foreignAppSlotProblem(service, readPortDeclaration(process.cwd()))
        if (problem !== null) throw new Error(`ports: ${problem}`)
    }
    return portForRoot(findCheckoutRoot(process.cwd()), service ?? declaredHere())
}

/** @type {import('./ports.d.ts').originFor} */
export function originFor(service) {
    return `http://localhost:${portFor(service)}`
}

/** @type {import('./ports.d.ts').SERVICE_NAMES} */
export const SERVICE_NAMES = /** @type {import('./ports.d.ts').PortService[]} */ (Object.keys(SERVICES))
