// @ts-check
// `sssb tick <app> [--url <origin>] [--timeout <seconds>]`: calls the running dev server's scheduled-tick route once
// and says what ran. The logic is ../tick/tick.js.
import { main } from '../tick/tick.js'

/** @param {string[]} args */
export async function run(args) {
    return await main(args)
}
