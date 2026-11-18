// @ts-check
// `sssb check-demo-size <bytes>`: guards the file:// single-file demo artifact against silent bloat (vendored
// libraries, base64 blobs, a seam import that drags a server graph in).
//
// THE BUDGET IS THE APP'S OWN NUMBER, the argument of the `check:demo-size` script in its package.json; this
// command holds none. One shared number sized for the largest app is not a gate for the others, since a small app
// could double and still pass. The artifact is the app's (`<app>/dist-demo/index.html`), found from the app's
// directory: the working directory, or `--app <dir>`.
//
// To change an app's number, re-set it in that app's package.json and record what changed and why beside it (SSSB's
// starter keeps a DEMO-SIZE.md for this), in its own commit: what grew, by how much, and how much headroom you left
// on purpose.
//
// WHEN IT GOES RED: find what grew before raising anything. The static demo build prints, per app, how much
// stylesheet the Mantine pruning removed; the JS is where features land. Build the previous commit in a throwaway
// worktree and compare `dist-demo/index.html`, or bundle with a recorder plugin that prints each module's
// `renderedLength`: a dependency that arrived, a seam registry imported into the bundle (37% in one commit once, see
// SSSB's ADR-0012), a base64 asset, a catalog namespace. Fix an incidental cause; raise the budget only for a
// feature.
//
// WHEN IT WARNS: under 2% headroom the command passes and says so (on CI as a workflow annotation too). That is the
// cue to look at what grew while it is cheap, not a failure; it exists because "one dependency bump from red" used
// to be something a person had to notice by measuring.
import { statSync } from 'node:fs'
import path from 'node:path'
import { takeAppDir, UsageError } from '../app.js'

/** Headroom, as a fraction of the budget, under which the gate still passes but says so. */
const THIN_HEADROOM = 0.02

const WHEN_RED =
    'WHEN IT GOES RED: first find what grew: build the previous commit and compare dist-demo/index.html, or bundle with a recorder ' +
    "plugin that prints each module's renderedLength. Fix an incidental cause (a new dependency, a seam registry " +
    'imported into the bundle, a base64 asset); raise the budget only for a feature.'

/** @param {string[]} args */
export async function run(args) {
    const appDir = takeAppDir(args)
    if (args.length !== 1) {
        throw new UsageError(
            "usage: sssb check-demo-size <bytes>: pass this app's budget, the argument of the `check:demo-size` " +
                'script in its package.json',
        )
    }
    const budget = Number(args[0])
    if (!Number.isFinite(budget) || budget <= 0) {
        throw new UsageError(
            `sssb check-demo-size: the budget argument must be a positive number of bytes, got ${args[0]}`,
        )
    }
    const file = path.join(appDir, 'dist-demo', 'index.html')
    let size
    try {
        size = statSync(file).size
    } catch {
        throw new UsageError(`sssb check-demo-size: no ${file}: build the static demo first`)
    }
    if (size > budget) {
        console.error(`${file} is ${size} bytes — ${size - budget} over the ${budget} byte budget.`)
        console.error(
            "That number is this app's own: the argument of `check:demo-size` in its package.json. " +
                `${WHEN_RED} If the growth is intentional, raise the budget in its own commit and say what grew ` +
                'where the app records its budget.',
        )
        return 1
    }
    const headroom = budget - size
    // Rounded DOWN, so a headroom under THIN_HEADROOM never prints as the threshold itself ("2.0%" beside a warning).
    const percent = (Math.floor((headroom * 1000) / budget) / 10).toFixed(1)
    console.log(`${file}: ${size} / ${budget} bytes — OK (${headroom} bytes, ${percent}% headroom)`)
    if (headroom / budget < THIN_HEADROOM) {
        const message =
            `only ${headroom} bytes (${percent}%) of headroom left under the ${budget} byte budget: the next feature ` +
            "may tip it. Look at what grew while that is cheap; raise this app's budget, in its own commit, only for " +
            'a feature.'
        console.warn(`check-demo-size: ${message}`)
        if (process.env['GITHUB_ACTIONS']) console.log(`::warning title=demo size headroom::${message}`)
    }
    return 0
}
