// @ts-check
// How `sssb doctor` asks Vitest what would actually run (ADR-0014 part 3), instead of reading the config: `vitest
// list --filesOnly` with each config that could run an app's tests (it loads the config and globs, and runs no
// globalSetup), then a full `vitest list` with only the configs that must list check names, each read back as JSON
// from a file (stdout carries Vite's warnings beside it). What a CI step adds on its command line is not here to see
// (doctor reports what its scripts add).
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { readJson } from '../app.js'
import { aliasRoutes, packageDirFrom } from './doctor-checks.js'

/** @typedef {import('./doctor-checks.js').SeamRoute} SeamRoute */

const EXTENSIONS = ['ts', 'mts', 'cts', 'js', 'mjs', 'cjs']

/**
 * The other config files doctor asks about: every `vitest*.config.*` beyond the one a bare `vitest` loads
 * (`vitest.contract.config.ts`, `vitest.ci.config.ts`, `vitest-e2e.config.mjs`...), each of which a command can name
 * with `--config`. Vite configs are left out (`vite.config.*` counts only where Vitest itself loads it, see
 * bareConfigIn; `vite.demo.config.ts` is a build config Vitest loads only when a command names it).
 */
const VITEST_CONFIG = new RegExp(`^vitest[\\w.-]*\\.config\\.(${EXTENSIONS.join('|')})$`)

/** @typedef {{ cwd: string, config: string | null }} VitestRun where and with which config Vitest is run (null: none, Vitest's defaults) */

/**
 * The config a bare `vitest` run in `dir` loads from `dir` itself, as Vitest looks (vitest.config.<ext>, then
 * vite.config.<ext>, extensions in Vitest's order): so a `vite.config.*` beside a `vitest.config.*` is never it. Null
 * when `dir` holds neither.
 * @param {string} dir
 * @returns {string | null}
 */
function bareConfigIn(dir) {
    for (const stem of ['vitest', 'vite']) {
        for (const ext of EXTENSIONS) {
            const file = path.join(dir, `${stem}.config.${ext}`)
            if (existsSync(file)) return file
        }
    }
    return null
}

/**
 * The config a bare `vitest` run in `dir` loads, found as Vitest finds it: walking up from `dir` to the filesystem root,
 * the first directory with a bareConfigIn. Null when there is none (Vitest then runs on its defaults).
 * @param {string} dir
 * @returns {string | null}
 */
export function vitestDefaultConfig(dir) {
    for (let at = path.resolve(dir); ; at = path.dirname(at)) {
        const found = bareConfigIn(at)
        if (found !== null) return found
        if (path.dirname(at) === at) return null
    }
}

/** @param {VitestRun} run */
export const runKey = (run) => `${run.cwd}\0${run.config ?? ''}`

/**
 * WHERE VITEST COULD RUN AN APP'S TESTS (ADR-0014 part 3), in two lists:
 *
 *   - `bare`: the runs a bare `vitest` would make for the app, in the order doctor tries them for the MAIN unit run:
 *     from the workspace root with the config the root holds itself, when it holds one; then from the app's directory
 *     with the config Vitest finds walking up from there (the app's own, else the root's, else none at all: Vitest's
 *     defaults);
 *   - `configs`: every config file at the root and in the app, each run from its own directory: the one a bare
 *     `vitest` loads there (bareConfigIn), and every other `vitest*.config.*`.
 *
 * Doctor cannot know which of them CI runs; which ones hold the app to which checks is planFor's (doctor.js).
 * @param {string} root
 * @param {string} appDir
 * @returns {{ bare: VitestRun[], configs: VitestRun[] }}
 */
export function vitestRunsFor(root, appDir) {
    /** @param {VitestRun[]} runs */
    const unique = (runs) => runs.filter((run, i) => runs.findIndex((r) => runKey(r) === runKey(run)) === i)
    const atRoot = bareConfigIn(root)
    const bare = unique([
        ...(atRoot === null ? [] : [{ cwd: root, config: atRoot }]),
        { cwd: appDir, config: vitestDefaultConfig(appDir) },
    ])
    const dirs = path.resolve(appDir) === path.resolve(root) ? [root] : [root, appDir]
    const configs = unique(
        dirs.flatMap((dir) => {
            const own = bareConfigIn(dir)
            const named = readdirSync(dir)
                .filter((name) => VITEST_CONFIG.test(name))
                .sort()
                .map((name) => path.join(dir, name))
            return [...(own === null ? [] : [own]), ...named].map((config) => ({ cwd: dir, config }))
        }),
    )
    return { bare, configs }
}

/**
 * The `vitest` CLI the directory `cwd` would run (`pnpm exec vitest` there): the nearest installed package, walking
 * up. Null when none is installed.
 * @param {string} cwd
 */
function vitestCli(cwd) {
    const dir = packageDirFrom(cwd, 'vitest')
    if (dir === null) return null
    const bin = readJson(path.join(dir, 'package.json')).bin
    const relative = typeof bin === 'string' ? bin : bin?.vitest
    return typeof relative === 'string' ? path.join(dir, relative) : null
}

/** The environment variable that sets the limit on one `vitest list`, in seconds. */
const TIMEOUT_ENV = 'SSSB_DOCTOR_VITEST_TIMEOUT'

/** The limit on one `vitest list`, in whole milliseconds: `SSSB_DOCTOR_VITEST_TIMEOUT` seconds when set, else 120 s. */
function listTimeoutMs() {
    const seconds = Number(process.env[TIMEOUT_ENV])
    return Number.isFinite(seconds) && seconds > 0 ? Math.min(Math.ceil(seconds * 1000), 2 ** 31 - 1) : 120_000
}

/** The exit code the launcher gives when it stopped Vitest at the limit. */
const TIMED_OUT = 124

/**
 * Runs Vitest (`process.argv` after the limit) in a process group of its own and, at the limit (ms), kills the whole
 * group, so no pool worker of a listing that never finished outlives it (killing Vitest's own process leaves them
 * running), then exits TIMED_OUT. Otherwise it exits with Vitest's code. Run with `node -e`, so it ships as this string.
 */
const LAUNCHER = `
const { spawn } = require('node:child_process')
const [limit, ...args] = process.argv.slice(1)
const child = spawn(process.execPath, args, { stdio: 'inherit', detached: process.platform !== 'win32' })
const stop = () => {
    try { process.kill(process.platform === 'win32' ? child.pid : -child.pid, 'SIGKILL') } catch {}
}
const timer = setTimeout(() => { stop(); process.exit(${TIMED_OUT}) }, Number(limit))
child.on('exit', (code) => { clearTimeout(timer); stop(); process.exit(code ?? 1) })
`

/** @typedef {{ name: string, file: string, projectName?: string }} ListedTest */
/** @typedef {{ file: string, projectName?: string }} ListedFile */

/**
 * `vitest list --json=<file>`, with `--filesOnly` or not, from `run.cwd`, selecting `projects` (none: all). Returns
 * what it listed, or the error Vitest stopped with (a test file that throws while it is collected stops the list,
 * and Vitest then writes no JSON at all). A listing that runs past `timeoutMs` is killed, its workers with it, and
 * reported as an error with `timedOut`, so nothing it waits on can hang doctor.
 * @param {VitestRun} run
 * @param {{ filesOnly?: boolean, projects?: readonly string[], timeoutMs?: number }} [options]
 * @returns {{ ok: true, listed: ListedTest[] } | { ok: false, error: string, timedOut?: true }}
 */
export function vitestList(run, { filesOnly = false, projects = [], timeoutMs = listTimeoutMs() } = {}) {
    const cli = vitestCli(run.cwd)
    if (cli === null) return { ok: false, error: `no vitest is installed for ${run.cwd}` }
    const scratch = mkdtempSync(path.join(tmpdir(), 'sssb-doctor-'))
    try {
        const out = path.join(scratch, 'list.json')
        const args = [cli, 'list', `--json=${out}`]
        if (filesOnly) args.push('--filesOnly')
        if (run.config) args.push('--config', run.config)
        for (const project of projects) args.push('--project', project)
        const result = spawnSync(process.execPath, ['-e', LAUNCHER, String(timeoutMs), ...args], {
            cwd: run.cwd,
            encoding: 'utf8',
            env: { ...process.env, VITE_CONFIG_NATIVE_IGNORE_WARNING: 'true' },
            maxBuffer: 64 * 1024 * 1024,
            // The launcher's own limit, past Vitest's: should the launcher itself stall, this one still returns.
            timeout: timeoutMs + 10_000,
            killSignal: 'SIGKILL',
        })
        const output = `${result.stderr ?? ''}\n${result.stdout ?? ''}`
        if (
            result.status === TIMED_OUT ||
            /** @type {NodeJS.ErrnoException | undefined} */ (result.error)?.code === 'ETIMEDOUT'
        ) {
            return {
                ok: false,
                timedOut: true,
                error: `vitest list did not finish within ${timeoutMs / 1000}s, so doctor stopped it (${TIMEOUT_ENV} sets the limit, in seconds)`,
            }
        }
        if (result.status === 0 && existsSync(out)) return { ok: true, listed: JSON.parse(readFileSync(out, 'utf8')) }
        return { ok: false, error: vitestError(output, result.status) }
    } finally {
        rmSync(scratch, { recursive: true, force: true })
    }
}

/**
 * Vitest's error line (`Error: ...`, `TypeError: ...`), without the source excerpt and stack below it; else the first
 * line that says Error, else the last line. Vitest's section banners (`⎯⎯⎯ Collect Error ⎯⎯⎯`) are never picked.
 * @param {string} output
 * @param {number | null} status
 */
function vitestError(output, status) {
    const lines = output
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line !== '' && !line.includes('⎯'))
    const picked =
        lines.find((line) => /^\w*Error\b.*:/.test(line)) ??
        lines.find((line) => /\b\w*Error\b/.test(line)) ??
        lines.at(-1)
    return `vitest list exited ${status ?? 'by a signal'}${picked ? `: ${picked}` : ''}`
}

/**
 * The names of the projects that run any test file inside `appDir`, from a `--filesOnly` listing.
 * @param {readonly ListedFile[]} files
 * @param {string} appDir
 * @returns {string[]}
 */
export function projectsRunning(files, appDir) {
    const inside = path.resolve(appDir) + path.sep
    return [
        ...new Set(
            files
                .filter((entry) => path.resolve(entry.file).startsWith(inside))
                .map((entry) => entry.projectName ?? ''),
        ),
    ]
}

/**
 * Each project's aliases that would match an `@sssb/app-config` specifier, with where each sends it (aliasRoutes), as
 * Vitest itself resolves the config (in-repo mode's alias check), through the Vitest the run directory installs. An
 * empty list for a project without such an alias.
 * @param {VitestRun} run
 * @param {readonly string[]} projects
 * @param {string} own the app's own seam directory (real path)
 * @returns {Promise<Map<string, SeamRoute[]>>}
 */
export async function seamAliases(run, projects, own) {
    const vitestNode = createRequire(path.join(run.cwd, 'package.json')).resolve('vitest/node')
    const { createVitest } = await import(pathToFileURL(vitestNode).href)
    // Vite's notice about its future config loader is not doctor's to print (the `vitest list` children set it too).
    process.env['VITE_CONFIG_NATIVE_IGNORE_WARNING'] ??= 'true'
    const vitest = await createVitest(
        'test',
        {
            watch: false,
            ...(run.config ? { config: run.config } : {}),
            ...(projects.length ? { project: [...projects] } : {}),
        },
        {},
    )
    /** @type {Map<string, SeamRoute[]>} */
    const aliases = new Map()
    try {
        for (const project of vitest.projects) {
            // Vite hands every project its aliases as one array of { find, replacement }, the object form converted.
            /** @type {{ find: string | RegExp, replacement: string }[]} */
            const list = project.vite.config.resolve.alias
            aliases.set(project.name, aliasRoutes(list, own))
        }
    } finally {
        await vitest.close()
    }
    return aliases
}
