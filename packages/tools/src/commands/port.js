// @ts-check
// `sssb port [service]`: prints one port, so package scripts can say `next dev --port "$(sssb port)"`.
import { appPortService } from '../app-port.js'
import { takeAppDir, UsageError } from '../app.js'
import { portFor, SERVICE_NAMES } from '../ports.js'

/** @param {string[]} args */
export async function run(args) {
    const appDir = takeAppDir(args)
    if (args.length > 1) throw new UsageError(`usage: sssb port [${SERVICE_NAMES.join('|')}]`)
    const service = args[0] ?? appPortService(appDir)
    if (!SERVICE_NAMES.includes(/** @type {import('../ports.d.ts').PortService} */ (service))) {
        throw new UsageError(`sssb port: unknown service "${service}" (known: ${SERVICE_NAMES.join(', ')})`)
    }
    // `process.stdout.write` of a STRING, never `console.log` of a number. Playwright injects FORCE_COLOR=1 into
    // every webServer process it spawns, and `console.log` of a NUMBER goes through util.inspect, which then colours
    // it: the bytes become `\e[33m3240\e[39m`. That renders as a clean "3240" in a terminal and in a log file, so the
    // corruption is invisible; but `$(...)` captures the escape codes too, and `next dev --port` then fails with
    // "'3240' is not a non-negative number". Strings are never coloured, so this cannot recur.
    process.stdout.write(`${portFor(/** @type {import('../ports.d.ts').PortService} */ (service))}\n`)
    return 0
}
