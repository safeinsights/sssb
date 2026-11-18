// @ts-check
// `sssb dev-tick [<app>] [--app <dir>] -- <the dev server's command…>`: what an app's `pnpm dev` runs, its `next dev`
// plus, only when `DEV_TICK_SECONDS` asks, the tick on a timer. The policy is ../tick/dev-tick.js. It runs in the app's
// directory (`--app`, else the working directory), and `<app>` (the port slot) defaults to the one the app declares.
import { declaredPortService } from '../app-port.js'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { takeAppDir } from '../app.js'
import { main } from '../tick/dev-tick.js'

/** @param {string[]} args */
export async function run(args) {
    // `--app` only before the `--`: what follows it is the dev server's own command line.
    const split = args.indexOf('--')
    const own = split < 0 ? args : args.slice(0, split)
    const hasApp = own.includes('--app') || existsSync(path.join(process.cwd(), 'package.json'))
    const appDir = hasApp ? takeAppDir(own) : process.cwd()
    process.chdir(appDir)
    const command = split < 0 ? [] : args.slice(split)
    const declared = hasApp ? declaredPortService(appDir) : undefined
    return await main(own.length === 0 && declared !== undefined ? [declared, ...command] : [...own, ...command])
}
