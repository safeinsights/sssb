// @ts-check
// How `sssb doctor` asks Vitest what would actually run (ADR-0014 part 3), instead of reading the config: `vitest
// list`, run the way CI runs Vitest, and read back as JSON from a file (stdout carries Vite's warnings beside it).
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { readJson } from '../app.js'
import { packageDirFrom } from './doctor-checks.js'

const EXTENSIONS = ['ts', 'mts', 'cts', 'js', 'mjs', 'cjs']

/**
 * The config file `<stem>.config.<ext>` in `dir`, or null.
 * @param {string} dir
 * @param {string} stem `vitest` or `vitest.contract`
 */
function configIn(dir, stem) {
    for (const ext of EXTENSIONS) {
        const file = path.join(dir, `${stem}.config.${ext}`)
        if (existsSync(file)) return file
    }
    return null
}

/** @typedef {{ cwd: string, config: string | null }} VitestRun where and with which config Vitest is run */

/**
 * WHERE CI RUNS VITEST for an app (ADR-0014 part 3): from the workspace root when the root has a Vitest config
 * (`vitest.config.*`, or `vitest.contract.config.*` for the contract runner), as SSSB's repository and Pages do, with
 * the projects that run the app's files selected; otherwise from the app's own directory, with the app's own config
 * of that name if it has one (the unit runner may also run on Vitest's defaults). The root's config is tried first,
 * and the app's is the fallback when the root's runs none of the app's files.
 * @param {string} root
 * @param {string} appDir
 * @param {'unit' | 'contract'} runner
 * @returns {VitestRun[]} the candidates, in order
 */
export function vitestRunsFor(root, appDir, runner) {
    const stem = runner === 'unit' ? 'vitest' : 'vitest.contract'
    /** @type {VitestRun[]} */
    const runs = []
    const atRoot = configIn(root, stem)
    if (atRoot) runs.push({ cwd: root, config: atRoot })
    const inApp = path.resolve(appDir) === path.resolve(root) ? null : configIn(appDir, stem)
    if (inApp) runs.push({ cwd: appDir, config: inApp })
    // Vitest's defaults find the app's tests with no config at all; a contract run needs its own.
    else if (runner === 'unit' && !atRoot) runs.push({ cwd: appDir, config: null })
    return runs
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
 * Each project's `@sssb/app-config` alias, as Vitest itself resolves the config (in-repo mode's alias check), through
 * the Vitest the run directory installs. Real paths; null for a project without the alias.
 * @param {VitestRun} run
 * @param {readonly string[]} projects
 * @returns {Promise<Map<string, string | null>>}
 */
export async function seamAliases(run, projects) {
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
    /** @type {Map<string, string | null>} */
    const aliases = new Map()
    try {
        for (const project of vitest.projects) {
            /** @type {{ find: string | RegExp, replacement: string }[]} */
            const list = project.vite.config.resolve.alias
            const seam = list.find((entry) => entry.find === '@sssb/app-config')
            aliases.set(project.name, seam && existsSync(seam.replacement) ? realpathSync(seam.replacement) : null)
        }
    } finally {
        await vitest.close()
    }
    return aliases
}
