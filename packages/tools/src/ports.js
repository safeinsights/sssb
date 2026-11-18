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
// THIS MODULE MUST PARSE AS BOTH ESM AND CJS, which rules out `import.meta` and `__dirname` alike: Playwright
// compiles `playwright.config.ts`, and everything it imports from outside node_modules, to CommonJS, where
// `import.meta` is a syntax error at config-load time that takes the whole suite with it. Inside SSSB's own
// repository this package is a workspace link, so its real path is outside node_modules and Playwright compiles
// it. Walking up from the working directory is the portable option.
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import path from 'node:path'

/** @param {string} start */
function findCheckoutRoot(start) {
    let dir = path.resolve(start)
    for (;;) {
        if (existsSync(path.join(dir, 'pnpm-workspace.yaml'))) return dir
        const parent = path.dirname(dir)
        if (parent === dir) {
            throw new Error(`ports: no pnpm-workspace.yaml above ${start}: run this from inside the workspace`)
        }
        dir = parent
    }
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

/** @param {string} root */
function slotFor(root) {
    // Any stable spread works; sha1 is here for distribution, not for security.
    return createHash('sha1').update(root).digest().readUInt32BE(0) % SLOTS
}

/** @type {import('./ports.d.ts').portForRoot} */
export function portForRoot(root, service, env = process.env) {
    const spec = Object.hasOwn(SERVICES, service) ? SERVICES[service] : undefined
    if (!spec) throw new Error(`ports: unknown service "${service}" (known: ${Object.keys(SERVICES).join(', ')})`)

    const override = env[spec.env]
    if (override) {
        const parsed = Number(override)
        if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) {
            throw new Error(`ports: ${spec.env} must be a port number, got "${override}"`)
        }
        return parsed
    }

    const linked = root.includes(`${path.sep}.claude${path.sep}worktrees${path.sep}`)
    return linked ? spec.derive(slotFor(root)) : spec.fallback
}

/** @type {import('./ports.d.ts').portFor} */
export function portFor(service) {
    return portForRoot(findCheckoutRoot(process.cwd()), service)
}

/** @type {import('./ports.d.ts').originFor} */
export function originFor(service) {
    return `http://localhost:${portFor(service)}`
}

/** @type {import('./ports.d.ts').SERVICE_NAMES} */
export const SERVICE_NAMES = /** @type {import('./ports.d.ts').PortService[]} */ (Object.keys(SERVICES))
