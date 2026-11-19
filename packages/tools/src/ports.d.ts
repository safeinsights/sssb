/** The built-in port services: SSSB's two reference apps' slots and two tools. */
export type PortService = 'showcase' | 'starter' | 'ladle' | 'contractPg'

/**
 * A port slot an app names for itself, in its package.json: `"sssb": { "port": { "name": "ledger", "default": 3300 } }`.
 * `name` is lowercase words joined by `-` (at most 32 characters) and is not a built-in's; it names the `LEDGER_PORT`
 * variable (`<NAME>_PORT`, with `-` as `_`). `default` is the port in a main checkout, an integer from 1024 to 49151
 * that no built-in service or custom slot's derived band holds.
 */
export interface PortSlot {
    name: string
    default: number
}

/** What an app declares: a built-in service's name (today's form) or a slot of its own. */
export type PortDeclaration = PortService | PortSlot

/** The built-in port services, for a usage message. */
export declare const SERVICE_NAMES: readonly PortService[]

/**
 * Checks a port declaration, as a package.json holds it, and returns it. Throws an Error naming what is wrong (with
 * `where`, the file it was read from, in front when given).
 */
export declare function parsePortDeclaration(value: unknown, where?: string): PortDeclaration

/**
 * The port declaration in the package.json of `appDir` (`"sssb": { "port": … }`), checked; undefined when it has none.
 * Throws when the file cannot be read or the declaration is not valid.
 */
export declare function readPortDeclaration(appDir: string): PortDeclaration | undefined

/**
 * What port a checkout at `root` should use for a service, given an environment: the service's env var
 * (`STARTER_PORT`, `LEDGER_PORT`) when set, a port derived from the path in a linked worktree
 * (`.claude/worktrees/`), and the documented default otherwise. A built-in's derived port is keyed on the checkout
 * alone; a custom slot's also on its name, so two slots of one worktree differ, and comes from a band no built-in
 * uses (20000-29999). Pure, so it can be tested against checkouts that do not exist.
 */
export declare function portForRoot(
    root: string,
    service: PortDeclaration,
    env?: Record<string, string | undefined>,
): number

/**
 * The port THIS checkout (found from the working directory) should use for a service. With no argument, the service
 * the app around the working directory declares (the nearest package.json that declares a port, up to the checkout root): the app's own, from a Playwright config or a test run from the
 * app's directory.
 */
export declare function portFor(service?: PortDeclaration): number

/**
 * `http://localhost:<port>` for a service: the form Playwright's `use.baseURL` and `webServer.url` want. With no
 * argument, the app's declared one, as `portFor`.
 */
export declare function originFor(service?: PortDeclaration): string

/**
 * Why `service` may not be used by an app that makes `declared`: a message when `service` is another app's built-in
 * slot (`showcase`, `starter`) and the app declares a slot of its own, null otherwise. Using it would leave the app's
 * dev server on its own slot and its ticker or e2e run on the other app's port.
 */
export declare function foreignAppSlotProblem(service: string, declared: PortDeclaration | undefined): string | null

/**
 * `http://localhost:<port>` for the app whose package.json is in `appDir`, from the port slot it declares: for a
 * Playwright config of an app on a slot of its own, `originForApp(__dirname)`, which names the app wherever the config
 * is loaded from (the workspace root, by knip or `playwright test -c`, or the app's own directory). Throws when the app
 * declares none.
 */
export declare function originForApp(appDir: string): string
