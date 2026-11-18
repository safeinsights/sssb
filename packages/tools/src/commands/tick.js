// @ts-check
// `sssb tick [<app>] [--url <origin>] [--timeout <seconds>] [--app <dir>]`: calls the running dev server's
// scheduled-tick route once and says what ran. The logic is ../tick/tick.js. It runs in the app's directory (`--app`,
// else the working directory), where the server keeps `.data`, and `<app>` (the port slot) defaults to the one the
// app declares (`"sssb": { "port": … }`).
import { declaredPortService } from '../app-port.js'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { takeAppDir } from '../app.js'
import { main } from '../tick/tick.js'

/** @param {string[]} args */
export async function run(args) {
    // With `--app`, or from a package's directory, the slot defaults to the app's declaration; from anywhere else the
    // command takes its slot as an argument and the working directory as it is, as it always has.
    const hasApp = args.includes('--app') || existsSync(path.join(process.cwd(), 'package.json'))
    const appDir = hasApp ? takeAppDir(args) : process.cwd()
    process.chdir(appDir)
    const declared = hasApp ? declaredPortService(appDir) : undefined
    const first = args[0]
    return await main(
        declared !== undefined && (first === undefined || first.startsWith('-')) ? [declared, ...args] : args,
    )
}
