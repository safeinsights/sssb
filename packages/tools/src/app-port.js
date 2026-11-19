// @ts-check
// Which port service an app's dev server binds: its package.json says, as `"sssb": { "port": "<service>" }` (one of
// SSSB's built-in services) or `"sssb": { "port": { "name": "<name>", "default": <port> } }` (a slot of the app's own, for
// a workspace whose apps are not SSSB's). One declaration, read by `sssb port` (with no argument, in the app's dev and
// start scripts), `sssb serve-standalone`, `sssb launch-json`, `sssb tick` and `sssb dev-tick`, so the server, the
// standalone server, the browser pane and the ticker cannot disagree.
import path from 'node:path'
import { UsageError } from './app.js'
import { foreignAppSlotProblem, readPortDeclaration, SERVICE_NAMES } from './ports.js'

/**
 * The name a declaration goes by on a command line: a built-in service's name, or a custom slot's.
 * @param {import('./ports.d.ts').PortDeclaration} declaration
 * @returns {string}
 */
export const portNameOf = (declaration) => (typeof declaration === 'string' ? declaration : declaration.name)

/**
 * The app's declaration, or undefined when it makes none (launch-json skips such an app). An invalid one is a
 * UsageError that says what is wrong, never a silent skip.
 * @param {string} appDir
 * @returns {import('./ports.d.ts').PortDeclaration | undefined}
 */
export function declaredPortService(appDir) {
    try {
        return readPortDeclaration(appDir)
    } catch (error) {
        throw new UsageError(`sssb: ${error instanceof Error ? error.message.replace(/^ports: /, '') : String(error)}`)
    }
}

/**
 * The app's declaration; a UsageError when it makes none.
 * @param {string} appDir
 * @returns {import('./ports.d.ts').PortDeclaration}
 */
export function appPortService(appDir) {
    const declared = declaredPortService(appDir)
    if (declared === undefined) {
        throw new UsageError(
            `sssb: ${path.join(appDir, 'package.json')} declares no port service. Add a slot of the app's own, ` +
                '"sssb": { "port": { "name": "<name>", "default": <port> } }, or a built-in service, "sssb": { "port": ' +
                `"<service>" } (one of ${SERVICE_NAMES.join(', ')}), or name one: sssb port <service>`,
        )
    }
    return declared
}

/**
 * What a service name typed on a command line means for the app in `appDir`: a built-in service, or the slot the
 * app declares under that name. Undefined when it is neither (a custom slot is the declaring app's alone).
 * @param {string} appDir
 * @param {string} name
 * @returns {import('./ports.d.ts').PortDeclaration | undefined}
 */
export function serviceNamed(appDir, name) {
    const declared = declaredPortService(appDir)
    if (SERVICE_NAMES.includes(/** @type {import('./ports.d.ts').PortService} */ (name))) {
        // Another app's slot, to an app that declares one of its own: refused, never quietly that app's port.
        const problem = foreignAppSlotProblem(name, declared)
        if (problem !== null) throw new UsageError(`sssb: ${problem}`)
        return /** @type {import('./ports.d.ts').PortService} */ (name)
    }
    return declared !== undefined && portNameOf(declared) === name ? declared : undefined
}

/**
 * The names `serviceNamed` accepts for the app in `appDir`, for a usage message.
 * @param {string} appDir
 * @returns {string[]}
 */
export function servicesKnownTo(appDir) {
    const declared = declaredPortService(appDir)
    return declared === undefined || typeof declared === 'string'
        ? [...SERVICE_NAMES]
        : [...SERVICE_NAMES.filter((name) => foreignAppSlotProblem(name, declared) === null), declared.name]
}
