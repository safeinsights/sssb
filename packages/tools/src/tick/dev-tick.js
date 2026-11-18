// @ts-check
// What `pnpm dev` runs: the app's `next dev`, plus, only when asked, `pnpm tick` on a timer.
//
//     DEV_TICK_SECONDS=30 pnpm dev        # also tick the scheduler every 30 seconds
//     pnpm dev                            # as before: nothing ticks it
//
// OFF BY DEFAULT, and not by oversight (docs/decision-log.md, "`pnpm tick`, and a dev ticker that is opt-in"). The
// showcase's Simulator controls the world clock in a demo and says when a digest fires; the e2e suites expect a
// scheduler that does nothing until a test asks; and hermetic dev does not do work nobody asked for. So the ticker is a
// variable you set, never a default, and the places that must stay quiet say so themselves:
//
//   * Playwright starts the server with `pnpm dev` and blanks `DEV_TICK_SECONDS` for it (both apps' playwright
//     configs), so a value in your shell never reaches a server Playwright starts;
//   * Playwright ADOPTS a dev server already on its port when it is not on CI, so a ticking server you left running
//     would be adopted: while a ticker runs it leaves a marker (ticker-marker.js) and both playwright configs
//     refuse to load while one is live;
//   * `E2E_BUILD` and `DEMO_MODE` are the build-time switches of the e2e build and the demo build. Those servers
//     start from `sssb serve-standalone`, not from here, but a ticker asked for with either set is refused and
//     said so, rather than trusted to be unreachable;
//   * the file:// static demo has no server at all, so there is nothing to tick.
//
// This wraps `next dev`, it does not live inside the app: the app's source stays free of any reading of
// `process.env`, and nothing in the server changes. The ticking itself is ticker.js, which owns start, stop,
// the interval and its status and knows nothing of the environment: this file is the policy for `pnpm dev`.
import { spawn } from 'node:child_process'
import { portFor } from '../ports.js'
import { TICK_APPS } from './tick.js'
import { createTicker, intervalProblem } from './ticker.js'
import { tickerMarkerPath } from './ticker-marker.js'

const DEV_TICK_VARIABLE = 'DEV_TICK_SECONDS'

/**
 * What the environment asks of the ticker.
 *
 * @param {Record<string, string | undefined>} env
 * @returns {{ mode: 'off' } | { mode: 'refused', reason: string } | { mode: 'on', seconds: number } | { mode: 'invalid', reason: string }}
 */
export function resolveDevTick(env) {
    const raw = env[DEV_TICK_VARIABLE]
    if (raw === undefined || raw.trim() === '') return { mode: 'off' }
    const seconds = Number(raw)
    const problem = intervalProblem(seconds)
    if (problem) {
        return {
            mode: 'invalid',
            reason: `${DEV_TICK_VARIABLE} must be ${problem} (or unset, for no ticker), got "${raw}"`,
        }
    }
    const blocker = ['E2E_BUILD', 'DEMO_MODE'].find((name) => env[name])
    if (blocker) {
        return {
            mode: 'refused',
            reason: `${DEV_TICK_VARIABLE} is ignored while ${blocker} is set: the ticker never runs under e2e or the demo`,
        }
    }
    return { mode: 'on', seconds }
}

/**
 * `sssb dev-tick <app> -- <command...>`
 *
 * @param {string[]} argv
 * @returns {{ app: string, command: string[] } | { error: string }}
 */
export function parseDevArgs(argv) {
    const dash = argv.indexOf('--')
    const app = argv[0]
    if (dash !== 1 || argv.length < 3 || !TICK_APPS.includes(app)) {
        return { error: `usage: sssb dev-tick <${TICK_APPS.join('|')}> -- <the dev server's command...>` }
    }
    return { app, command: argv.slice(dash + 1) }
}

/** @param {string[]} argv */
export async function main(argv) {
    const parsed = parseDevArgs(argv)
    if ('error' in parsed) {
        console.error(parsed.error)
        return 2
    }
    const wanted = resolveDevTick(process.env)
    if (wanted.mode === 'invalid') {
        // Before the server starts: a typo'd variable is a mistake to fix, not a ticker to quietly not have.
        console.error(`dev: ${wanted.reason}`)
        return 2
    }
    if (wanted.mode === 'refused') console.warn(`[tick] ${wanted.reason}`)

    const child = spawn(parsed.command[0], parsed.command.slice(1), {
        stdio: 'inherit',
        shell: process.platform === 'win32',
    })

    // This process is now the pid a supervisor holds (it was `next` itself when the script was a bare `next dev`), so
    // every signal that stopped the server has to reach it. A terminal's Ctrl-C reaches the child directly as well, so
    // `next` sees SIGINT twice, which it tolerates (checked: SIGINT to the whole process group of `pnpm dev` with a real
    // `next dev` exited 0, removed the marker and left no process behind).
    for (const name of /** @type {const} */ (['SIGINT', 'SIGTERM', 'SIGHUP'])) process.on(name, () => child.kill(name))

    const origin = `http://localhost:${portFor(/** @type {'showcase' | 'starter'} */ (parsed.app))}`
    const ticker = createTicker({ origin, markerFile: tickerMarkerPath() })
    if (wanted.mode === 'on') {
        console.log(
            `[tick] ${DEV_TICK_VARIABLE}=${wanted.seconds}: ticking ${origin} every ${wanted.seconds}s (pnpm tick does it once)`,
        )
        ticker.start(wanted.seconds)
    }

    return await new Promise((resolve) => {
        child.on('error', (error) => {
            console.error(`dev: could not start ${parsed.command[0]}: ${error.message}`)
            void ticker.stop().then(() => resolve(1))
        })
        child.on('exit', (code, signal) => {
            const status = code ?? (signal ? 128 + (signal === 'SIGINT' ? 2 : signal === 'SIGTERM' ? 15 : 1) : 1)
            void ticker.stop().then(() => resolve(status))
        })
    })
}
