// @ts-check
// Where a command acts: the app in the working directory, or the one `--app <dir>` names (ADR-0014 part 9), and
// the workspace around it. Nothing here assumes this repository's layout, so a workspace whose apps are not
// under apps/ (or a single-app repository) is first-class.
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'

/** A CLI failure: printed without a stack, exit code 1. */
export class UsageError extends Error {}

/**
 * The checkout's root: the nearest directory, walking up from `start`, that holds `pnpm-workspace.yaml`.
 * @param {string} start
 * @returns {string}
 */
export function workspaceRootOf(start) {
    let dir = path.resolve(start)
    for (;;) {
        if (existsSync(path.join(dir, 'pnpm-workspace.yaml'))) return dir
        const parent = path.dirname(dir)
        if (parent === dir)
            throw new UsageError(`sssb: no pnpm-workspace.yaml above ${start}: run this inside a workspace`)
        dir = parent
    }
}

/**
 * Takes `--app <dir>` out of `args` (in place) and returns the app's absolute directory: that one, or the working
 * directory. It must hold a package.json.
 * @param {string[]} args
 * @param {string} [cwd]
 * @returns {string}
 */
export function takeAppDir(args, cwd = process.cwd()) {
    const value = takeOption(args, '--app')
    const dir = path.resolve(cwd, value ?? '.')
    if (!existsSync(path.join(dir, 'package.json'))) {
        throw new UsageError(
            value === undefined
                ? `sssb: ${dir} is not a package (no package.json): run this from an app's directory or pass --app <dir>`
                : `sssb: --app ${value} is not a package (no package.json at ${dir})`,
        )
    }
    return dir
}

/**
 * Removes `name <value>` from `args` and returns the value, or undefined when absent.
 * @param {string[]} args
 * @param {string} name
 * @returns {string | undefined}
 */
export function takeOption(args, name) {
    const at = args.indexOf(name)
    if (at < 0) return undefined
    const value = args[at + 1]
    if (value === undefined || value.startsWith('--')) throw new UsageError(`sssb: ${name} needs a value`)
    args.splice(at, 2)
    return value
}

/**
 * Removes a boolean flag from `args` and says whether it was there.
 * @param {string[]} args
 * @param {string} name
 */
export function takeFlag(args, name) {
    const at = args.indexOf(name)
    if (at < 0) return false
    args.splice(at, 1)
    return true
}

/** @param {string} file */
export const readJson = (file) => JSON.parse(readFileSync(file, 'utf8'))

/**
 * The apps a workspace-wide command fans out over, as directories relative to the workspace root: the root
 * package.json's `sssb.apps` list when it has one, otherwise every `apps/<name>` that is a package.
 * @param {string} root
 * @returns {string[]}
 */
export function workspaceApps(root) {
    const manifest = readJson(path.join(root, 'package.json'))
    const listed = manifest?.sssb?.apps
    if (listed !== undefined) {
        if (!Array.isArray(listed) || !listed.every((entry) => typeof entry === 'string'))
            throw new UsageError('sssb: `sssb.apps` in the root package.json must be a list of directories')
        for (const dir of listed) {
            if (!existsSync(path.join(root, dir, 'package.json')))
                throw new UsageError(`sssb: \`sssb.apps\` names ${dir}, which is not a package`)
        }
        return listed.map((dir) => dir.replace(/\/+$/, ''))
    }
    const appsDir = path.join(root, 'apps')
    if (!existsSync(appsDir)) return []
    return readdirSync(appsDir, { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && existsSync(path.join(appsDir, entry.name, 'package.json')))
        .map((entry) => `apps/${entry.name}`)
        .sort()
}
