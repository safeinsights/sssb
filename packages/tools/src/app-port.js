// @ts-check
// Which port service an app's dev server binds: its package.json says, as `"sssb": { "port": "<service>" }`. One
// declaration, read by `sssb port` (with no argument, in the app's dev and start scripts), `sssb serve-standalone`
// and `sssb launch-json`, so the server, the standalone server and the browser pane cannot disagree.
import path from 'node:path'
import { readJson, UsageError } from './app.js'
import { SERVICE_NAMES } from './ports.js'

/**
 * @param {string} appDir
 * @returns {import('./ports.d.ts').PortService}
 */
export function appPortService(appDir) {
    const service = readJson(path.join(appDir, 'package.json'))?.sssb?.port
    if (service === undefined) {
        throw new UsageError(
            `sssb: ${path.join(appDir, 'package.json')} declares no port service. Add "sssb": { "port": "<service>" } ` +
                `(one of ${SERVICE_NAMES.join(', ')}), or name one: sssb port <service>`,
        )
    }
    if (!SERVICE_NAMES.includes(service)) {
        throw new UsageError(
            `sssb: ${path.join(appDir, 'package.json')} declares port service "${service}", which is not one of ${SERVICE_NAMES.join(', ')}`,
        )
    }
    return service
}

/**
 * The same, or undefined when the app declares none (launch-json skips such an app).
 * @param {string} appDir
 * @returns {import('./ports.d.ts').PortService | undefined}
 */
export function declaredPortService(appDir) {
    return readJson(path.join(appDir, 'package.json'))?.sssb?.port === undefined ? undefined : appPortService(appDir)
}
