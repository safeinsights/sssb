/** The port services: SSSB's two reference apps' slots and two tools. */
export type PortService = 'showcase' | 'starter' | 'ladle' | 'contractPg'

/** The port services, for a usage message. */
export declare const SERVICE_NAMES: readonly PortService[]

/**
 * What port a checkout at `root` should use for a service, given an environment: the service's env var
 * (`STARTER_PORT`) when set, a port derived from the path in a linked worktree (`.claude/worktrees/`), and the
 * documented default otherwise. Pure, so it can be tested against checkouts that do not exist.
 */
export declare function portForRoot(
    root: string,
    service: PortService,
    env?: Record<string, string | undefined>,
): number

/** The port THIS checkout (found from the working directory) should use for a service. */
export declare function portFor(service: PortService): number

/** `http://localhost:<port>` for a service: the form Playwright's `use.baseURL` and `webServer.url` want. */
export declare function originFor(service: PortService): string
