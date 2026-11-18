// @ts-check
// How `sssb doctor` asks Vitest what would actually run (ADR-0014 part 3), instead of reading the config: `vitest
// list`, run with each config that could run an app's tests, and read back as JSON from a file (stdout carries Vite's
// warnings beside it). What a CI step adds on its command line is not here to see (doctor reports what its scripts add).
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
 * The file names doctor treats as a Vitest config: every `vitest*.config.*` (`vitest.config.ts`,
 * `vitest.contract.config.ts`, `vitest.ci.config.ts`, `vitest-e2e.config.mjs`...) and `vite.config.*`, the file Vitest
 * loads when there is no `vitest.config.*`. Other Vite configs (`vite.demo.config.ts`) are left out: Vitest loads one
 * only when a command names it, and a Vite build config is not written to run tests.
 */
const CONFIG_NAME = new RegExp(`^(vitest[\\w.-]*|vite)\\.config\\.(${EXTENSIONS.join('|')})$`)

/** @typedef {{ cwd: string, config: string | null }} VitestRun where and with which config Vitest is run */

/**
 * WHERE VITEST COULD RUN AN APP'S TESTS (ADR-0014 part 3): every Vitest config at the workspace root and in the app's
 * own directory (CONFIG_NAME), each run from its own directory, root first; then the config a bare `vitest` in the
 * app's directory would load, when it lies elsewhere (vitestDefaultConfig). Doctor cannot know which of them CI runs,
 * so it asks Vitest what each would run (`vitest list --filesOnly`) and holds every one that runs any of the app's
 * test files to the checks of those files' runner. When a bare `vitest` in the app's directory would load no config at
 * all, Vitest's defaults there are the unit runner's fallback (vitestDefaults).
 * @param {string} root
 * @param {string} appDir
 * @returns {VitestRun[]} the candidates, in order
 */
export function vitestConfigsFor(root, appDir) {
    const dirs = path.resolve(appDir) === path.resolve(root) ? [root] : [root, appDir]
    /** @type {VitestRun[]} */
    const runs = dirs.flatMap((dir) =>
        readdirSync(dir)
            .filter((name) => CONFIG_NAME.test(name))
            .sort()
            .map((name) => ({ cwd: dir, config: path.join(dir, name) })),
    )
    const loaded = vitestDefaultConfig(appDir)
    if (loaded !== null && !runs.some((run) => run.config === loaded)) runs.push({ cwd: appDir, config: loaded })
    return runs
}

/**
 * The config a bare `vitest` run in `dir` loads, found as Vitest finds it: walking up from `dir`, the first directory
 * holding `vitest.config.<ext>` or `vite.config.<ext>` (names in that order, then extensions). Null when there is none.
 * @param {string} dir
 * @returns {string | null}
 */
export function vitestDefaultConfig(dir) {
    for (let at = path.resolve(dir); ; at = path.dirname(at)) {
        for (const stem of ['vitest', 'vite']) {
            for (const ext of EXTENSIONS) {
                const file = path.join(at, `${stem}.config.${ext}`)
                if (existsSync(file)) return file
            }
        }
        if (path.dirname(at) === at) return null
    }
}

/**
 * Vitest's defaults, run from the app's directory, when a bare `vitest` there would load no config at all; null when
 * it would load one. Only the unit runner falls back to them: a contract run needs a config of its own.
 * @param {string} appDir
 * @returns {VitestRun | null}
 */
export function vitestDefaults(appDir) {
    return vitestDefaultConfig(appDir) === null ? { cwd: appDir, config: null } : null
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

/** @typedef {{ name: string, file: string, projectName?: string }} ListedTest */
/** @typedef {{ file: string, projectName?: string }} ListedFile */

/**
 * `vitest list --json=<file>`, with `--filesOnly` or not, from `run.cwd`, selecting `projects` (none: all). Returns
 * what it listed, or the error Vitest stopped with (a test file that throws while it is collected stops the list,
 * and Vitest then writes no JSON at all).
 * @param {VitestRun} run
 * @param {{ filesOnly?: boolean, projects?: readonly string[] }} [options]
 * @returns {{ ok: true, listed: ListedTest[] } | { ok: false, error: string }}
 */
export function vitestList(run, { filesOnly = false, projects = [] } = {}) {
    const cli = vitestCli(run.cwd)
    if (cli === null) return { ok: false, error: `no vitest is installed for ${run.cwd}` }
    const scratch = mkdtempSync(path.join(tmpdir(), 'sssb-doctor-'))
    try {
        const out = path.join(scratch, 'list.json')
        const args = [cli, 'list', `--json=${out}`]
        if (filesOnly) args.push('--filesOnly')
        if (run.config) args.push('--config', run.config)
        for (const project of projects) args.push('--project', project)
        const result = spawnSync(process.execPath, args, {
            cwd: run.cwd,
            encoding: 'utf8',
            env: { ...process.env, VITE_CONFIG_NATIVE_IGNORE_WARNING: 'true' },
            maxBuffer: 64 * 1024 * 1024,
        })
        if (result.status === 0 && existsSync(out)) return { ok: true, listed: JSON.parse(readFileSync(out, 'utf8')) }
        return { ok: false, error: vitestError(`${result.stderr ?? ''}\n${result.stdout ?? ''}`, result.status) }
    } finally {
        rmSync(scratch, { recursive: true, force: true })
    }
}

/**
 * Vitest's error line, without the source excerpt and stack below it (or its last line, when none says Error).
 * @param {string} output
 * @param {number | null} status
 */
function vitestError(output, status) {
    const lines = output
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean)
    const picked = lines.find((line) => /\b\w*Error\b/.test(line)) ?? lines.at(-1)
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
