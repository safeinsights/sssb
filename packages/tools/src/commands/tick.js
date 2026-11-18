// @ts-check
// `sssb tick [<app>] [--url <origin>] [--timeout <seconds>] [--app <dir>]`: calls the running dev server's
// scheduled-tick route once and says what ran. The logic is ../tick/tick.js. It runs in the app's directory (`--app`,
// else the working directory), where the server keeps `.data`, and `<app>` (the port slot) defaults to the one the
// app declares (`"sssb": { "port": … }`).
import { declaredPortService } from '../app-port.js'
import { takeAppDir } from '../app.js'
import { main } from '../tick/tick.js'

/** @param {string[]} args */
export async function run(args) {
    const appDir = takeAppDir(args)
    process.chdir(appDir)
    const declared = declaredPortService(appDir)
    const first = args[0]
    return await main(
        declared !== undefined && (first === undefined || first.startsWith('-')) ? [declared, ...args] : args,
    )
}
