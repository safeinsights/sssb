// @ts-check
// `sssb dev-tick <app> -- <the dev server's command…>`: what an app's `pnpm dev` runs, its `next dev` plus, only when
// `DEV_TICK_SECONDS` asks, the tick on a timer. The policy is ../tick/dev-tick.js.
import { main } from '../tick/dev-tick.js'

/** @param {string[]} args */
export async function run(args) {
    return await main(args)
}
