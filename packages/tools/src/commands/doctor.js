// @ts-check
// `sssb doctor [--app <dir>]`: the checks that an app's installed SSSB is the one it was built and tested as (ADR-0014
// part 5), and that SSSB's conformance suite would actually run (part 3). It fails, naming every problem, on:
//
//   - two copies of a singleton: a peer of @sssb/kit found from the kit's directory and from the app's must be ONE
//     real directory (the `readlink -f` check build-notes tells a dependency PR to run by hand);
//   - an importer of @sssb/kit, anywhere in the workspace, without its own seam: it must declare its
//     `@sssb/app-config` link, and the instance it resolves must have that very seam linked (in-repo mode, where the
//     seam goes through aliases instead, each app's tsconfig `paths` and Vitest projects must alias its own);
//   - an @sssb/* package the app resolves at another version than its @sssb/kit;
//   - a check of the conformance suite (unit, and the contract runner) that `vitest list`, run the way CI runs
//     Vitest, does not list, unless the app opted out of it by name;
//   - an app guide copy that is stale against the guide the kit ships (`sssb guide --check`), once the kit ships one.
//
// It REPORTS, without failing: `dedupePeerDependents: false` missing from pnpm-workspace.yaml (advice), framework
// cutover rows the workspace's checklist never mentions, and the workflow and plugin pins it cannot check yet.
import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { readJson, takeAppDir, UsageError, workspaceApps, workspaceRootOf } from '../app.js'
import { kitDirOf, kitVersionOf, resolveAppsKit } from '../kit.js'
import {
    aliasProblems,
    cutoverReport,
    importerSeamProblems,
    isInRepoKit,
    kitImporters,
    kitPeers,
    missingTests,
    packageDirFrom,
    parseWorkspaceYaml,
    singletonProblems,
    sssbPackagesOf,
    versionProblems,
} from './doctor-checks.js'
import { projectsRunning, seamAliases, vitestList, vitestRunsFor } from './doctor-vitest.js'

/** @typedef {{ status: 'ok' | 'FAIL' | 'report' | 'advice', title: string, lines?: string[] }} Result */

/** @param {string[]} args */
export async function run(args) {
    const appDir = realpathSync(takeAppDir(args))
    if (args.length > 0) throw new UsageError(`sssb doctor: unknown argument ${args[0]} (usage: doctor [--app <dir>])`)
    const root = realpathSync(workspaceRootOf(appDir))
    const kitDir = kitDirOf(appDir)
    const version = kitVersionOf(appDir)
    const inRepo = isInRepoKit(kitDir, root)
    const rel = (/** @type {string} */ dir) => path.relative(root, dir) || '.'
    console.log(
        `sssb doctor: ${rel(appDir)}, @sssb/kit ${version} at ${rel(kitDir)}` +
            (inRepo
                ? ' (in-repo mode: the kit is a package of this workspace, so the seam goes through aliases, not a link)'
                : ''),
    )

    /** @type {VitestCache} */
    const cache = new Map()
    /** @type {Result[]} */
    const results = [
        singletons(appDir, kitDir),
        inRepo ? await inRepoAliases(root, cache) : importers(root),
        versions(appDir),
        conformance(root, appDir, 'unit', cache),
        conformance(root, appDir, 'contract', cache),
        await guide(appDir),
        {
            status: 'report',
            title:
                `workflow and plugin pins: not checked: @sssb/kit ${version} stamps no release commit to compare the ` +
                "reusable workflow's and the plugin marketplace's pins with (both arrive with later steps of ADR-0014: " +
                'the workflow at P10, the plugin at P13)',
        },
        dedupeAdvice(root, inRepo),
        cutover(root, appDir),
    ]

    let problems = 0
    for (const { status, title, lines = [] } of results) {
        console.log(`${status.padEnd(7)} ${title}`)
        for (const line of lines) console.log(`          ${status === 'FAIL' ? '- ' : ''}${line}`)
        if (status === 'FAIL') problems += Math.max(lines.length, 1)
    }
    console.log(problems === 0 ? 'sssb doctor: ok' : `sssb doctor: ${problems} problem(s)`)
    return problems === 0 ? 0 : 1
}

/**
 * @param {string} title
 * @param {string[]} problems
 * @param {string[]} [notes]
 * @returns {Result}
 */
const verdict = (title, problems, notes = []) =>
    problems.length > 0 ? { status: 'FAIL', title, lines: problems } : { status: 'ok', title, lines: notes }

/**
 * @param {string} appDir
 * @param {string} kitDir
 * @returns {Result}
 */
function singletons(appDir, kitDir) {
    const { peers, optional } = kitPeers(kitDir)
    const { problems, notes, same } = singletonProblems({
        peers,
        optional,
        fromKit: (name) => packageDirFrom(kitDir, name),
        fromApp: (name) => packageDirFrom(appDir, name),
    })
    return verdict(
        problems.length > 0
            ? 'one copy of each singleton: the app and @sssb/kit do not share every peer'
            : `one copy of each singleton: ${same.join(', ')}`,
        problems,
        notes,
    )
}

/**
 * @param {string} root
 * @returns {Result}
 */
function importers(root) {
    const { problems, importers: found } = importerSeamProblems(root, kitDirOf)
    return verdict(
        problems.length > 0
            ? 'one SSSB per importer, with its own seam: an importer of @sssb/kit runs on a seam not its own'
            : `one SSSB per importer, with its own seam: ${found.join(', ') || 'no importer'}`,
        problems,
    )
}

/**
 * In-repo mode's check, over every app of the workspace (`sssb.apps`, or apps/*): the seam each app's tsconfig and
 * Vitest projects alias is its own.
 * @param {string} root
 * @param {VitestCache} cache
 * @returns {Promise<Result>}
 */
async function inRepoAliases(root, cache) {
    /** Real paths, shown relative to the workspace root (so equal paths stay equal). */
    const shown = (/** @type {string} */ file) => path.relative(root, file) || '.'
    /** @type {Parameters<typeof aliasProblems>[0]} */
    const apps = []
    /** @type {string[]} */
    const problems = []
    for (const app of workspaceApps(root)) {
        const appDir = path.join(root, app)
        const own = path.join(appDir, 'src', 'app-config')
        /** @type {Parameters<typeof aliasProblems>[0][number]['projects']} */
        const projects = []
        for (const runner of /** @type {const} */ (['unit', 'contract'])) {
            const selected = selectRun(root, appDir, runner, cache)
            if ('error' in selected) {
                problems.push(`${app}: ${selected.error}`)
                continue
            }
            const aliases = await seamAliases(selected.run, selected.projects)
            const config = path.relative(root, selected.run.config ?? selected.run.cwd)
            for (const [project, seam] of aliases) projects.push({ config, project, seam: seam && shown(seam) })
        }
        const tsconfig = tsconfigSeam(appDir)
        apps.push({
            app,
            own: shown(existsSync(own) ? realpathSync(own) : own),
            tsconfig: tsconfig === null ? null : shown(tsconfig),
            projects,
        })
    }
    problems.push(...aliasProblems(apps))
    // The other importers have no seam of their own to alias: in-repo, each is compiled within a program that names one
    // (the root's is the framework's own, on its test fixture; the showcase's seed is compiled within the showcase).
    const appDirs = new Set(apps.map((a) => path.join(root, a.app)))
    const others = kitImporters(root)
        .map(({ dir }) => dir)
        .filter((dir) => !appDirs.has(dir))
        .map((dir) => path.relative(root, dir) || '(the workspace root)')
    return verdict(
        problems.length > 0
            ? "in-repo mode: an app's aliases send @sssb/app-config somewhere other than its own src/app-config"
            : `in-repo mode: each app's tsconfig and Vitest projects alias @sssb/app-config to its own src/app-config: ${apps
                  .map((a) => `${a.app} (${a.projects.map((p) => `${p.config}:${p.project}`).join(', ')})`)
                  .join('; ')}`,
        problems,
        others.length
            ? [
                  `not apps, so not alias-checked: ${others.join(', ')} (no seam of their own; each compiles within a program that names one)`,
              ]
            : [],
    )
}

/**
 * Where the app's tsconfig sends `@sssb/app-config/*`, as TypeScript itself reads the file (its `extends` and
 * `baseUrl` honoured), through the compiler the app installs. Null when it maps no such path.
 * @param {string} appDir
 */
function tsconfigSeam(appDir) {
    const file = path.join(appDir, 'tsconfig.json')
    if (!existsSync(file)) return null
    /** @type {typeof import('typescript')} */
    let ts
    try {
        ts = createRequire(path.join(appDir, 'package.json'))('typescript')
    } catch (error) {
        throw new UsageError(`sssb doctor: ${appDir} does not resolve \`typescript\`, which reads its tsconfig`, {
            cause: error,
        })
    }
    const parsed = ts.getParsedCommandLineOfConfigFile(
        file,
        {},
        {
            ...ts.sys,
            onUnRecoverableConfigFileDiagnostic: () => {},
        },
    )
    const target = parsed?.options.paths?.['@sssb/app-config/*']?.[0]
    if (!parsed || target === undefined) return null
    const options = /** @type {{ baseUrl?: string, pathsBasePath?: string }} */ (parsed.options)
    const resolved = path.resolve(options.baseUrl ?? options.pathsBasePath ?? appDir, target.replace(/\/\*$/, ''))
    return existsSync(resolved) ? realpathSync(resolved) : resolved
}

/**
 * @param {string} appDir
 * @returns {Result}
 */
function versions(appDir) {
    const packages = sssbPackagesOf(appDir)
    const problems = versionProblems(packages)
    return verdict(
        problems.length > 0
            ? 'versions in step: an @sssb package is not the version of @sssb/kit'
            : `versions in step: ${[...packages].map(([name, v]) => `${name} ${v}`).join(', ')}`,
        problems,
    )
}

/** @typedef {import('./doctor-vitest.js').VitestRun} VitestRun */
/** @typedef {Map<string, ReturnType<typeof vitestList>>} VitestCache each run's --filesOnly listing, by cwd and config */

/**
 * The Vitest run that would execute the app's tests for a runner, and the projects in it that run the app's files.
 * @param {string} root
 * @param {string} appDir
 * @param {'unit' | 'contract'} runner
 * @param {VitestCache} cache
 * @returns {{ run: VitestRun, projects: string[] } | { error: string }}
 */
function selectRun(root, appDir, runner, cache) {
    const candidates = vitestRunsFor(root, appDir, runner)
    const stem = runner === 'unit' ? 'vitest.config.*' : 'vitest.contract.config.*'
    if (candidates.length === 0) {
        return {
            error:
                `no ${stem} in the workspace root or in ${path.relative(root, appDir) || '.'}, so nothing runs the ` +
                `${runner} checks`,
        }
    }
    const tried = []
    for (const run of candidates) {
        const key = `${run.cwd}\0${run.config ?? ''}`
        const files = cache.get(key) ?? vitestList(run, { filesOnly: true })
        cache.set(key, files)
        const where = path.relative(root, run.config ?? run.cwd) || '.'
        if (!files.ok) return { error: `${where}: ${files.error}` }
        const projects = projectsRunning(files.listed, appDir)
        if (projects.length > 0) return { run, projects: projects.includes('') ? [] : projects }
        tried.push(where)
    }
    return {
        error: `no Vitest project in ${tried.join(' or ')} runs a test file of ${path.relative(root, appDir) || '.'}`,
    }
}

/**
 * THE CONFORMANCE SUITE WOULD RUN: `vitest list`, run where CI runs Vitest, must list every test of every check of
 * the runner, less the checks the app opted out of by name.
 * @param {string} root
 * @param {string} appDir
 * @param {'unit' | 'contract'} runner
 * @param {VitestCache} cache
 * @returns {Result}
 */
function conformance(root, appDir, runner, cache) {
    const label = runner === 'unit' ? 'the conformance suite would run' : "the contract runner's checks would run"
    let registry
    try {
        registry = readJson(resolveAppsKit(appDir, 'testing/checks.json'))
    } catch (error) {
        return { status: 'FAIL', title: label, lines: [error instanceof Error ? error.message : String(error)] }
    }
    const selected = selectRun(root, appDir, runner, cache)
    /** @type {string[]} */
    let listed = []
    let where = ''
    /** @type {string | null} */
    let failure = null
    if ('error' in selected) failure = selected.error
    else {
        const { run, projects } = selected
        where =
            `vitest list from ${path.relative(root, run.cwd) || 'the workspace root'}` +
            (run.config ? ` --config ${path.basename(run.config)}` : '') +
            (projects.length ? `, project ${projects.join(', ')}` : '')
        const result = vitestList(run, { projects })
        if (!result.ok) failure = `${where}: ${result.error}`
        else {
            const inside = appDir + path.sep
            listed = result.listed.filter((test) => path.resolve(test.file).startsWith(inside)).map((test) => test.name)
        }
    }
    const { missing, optedOut, expected } = missingTests(listed, registry, runner)
    if (failure !== null || missing.length > 0) {
        return {
            status: 'FAIL',
            title: `${label}: ${missing.length} of its ${expected} tests would not run${where ? ` (${where})` : ''}`,
            lines: [...(failure === null ? [] : [failure]), ...missing.map((name) => `not listed: ${name}`)],
        }
    }
    return {
        status: 'ok',
        title: `${label}: all ${expected} tests listed (${where})`,
        lines: optedOut.map((id) => `opted out by name: ${id}`),
    }
}

/**
 * The app guide (`sssb guide --check`), once the framework ships one.
 * @param {string} appDir
 * @returns {Promise<Result>}
 */
async function guide(appDir) {
    try {
        resolveAppsKit(appDir, 'guide.md')
    } catch {
        return { status: 'report', title: 'app guide: not checked: this @sssb/kit ships no guide (it arrives at P7)' }
    }
    const status = await (await import('./guide.js')).run(['--app', appDir, '--check'])
    return status === 0
        ? { status: 'ok', title: "app guide: the repository's copy matches the kit's" }
        : { status: 'FAIL', title: "app guide: the repository's copy is not the kit's (see above)" }
}

/**
 * @param {string} root
 * @param {boolean} inRepo
 * @returns {Result}
 */
function dedupeAdvice(root, inRepo) {
    const { dedupePeerDependents } = parseWorkspaceYaml(readFileSync(path.join(root, 'pnpm-workspace.yaml'), 'utf8'))
    if (dedupePeerDependents === false)
        return { status: 'ok', title: 'pnpm-workspace.yaml sets dedupePeerDependents: false' }
    return {
        status: 'advice',
        title:
            'pnpm-workspace.yaml does not set `dedupePeerDependents: false`: without it, a package that takes @sssb/kit ' +
            "and links no seam silently shares another app's instance and seam (ADR-0014 part 5). Set it, then reinstall " +
            'from a fresh lockfile, since a lockfile resolved before it keeps the merged layout' +
            (inRepo ? ' (in-repo mode: the seam goes through aliases here, so this is advice for an adopter)' : ''),
    }
}

/**
 * @param {string} root
 * @param {string} appDir
 * @returns {Result}
 */
function cutover(root, appDir) {
    let rows
    try {
        rows = readJson(resolveAppsKit(appDir, 'cutover/rows.json'))
    } catch {
        return { status: 'report', title: 'cutover rows: not checked: this @sssb/kit publishes no cutover/rows.json' }
    }
    const file = path.join(root, 'docs', 'cutover-checklist.md')
    const checklist = existsSync(file) ? readFileSync(file, 'utf8') : null
    const { unmentioned, sssbOnly } = cutoverReport(rows, checklist)
    const skipped = sssbOnly.length ? ` (${sssbOnly.join(', ')}: SSSB's own repository only, not looked for)` : ''
    if (unmentioned.length === 0)
        return { status: 'ok', title: `cutover rows: docs/cutover-checklist.md records every framework row${skipped}` }
    return {
        status: 'report',
        title:
            (checklist === null
                ? `cutover rows: the workspace has no docs/cutover-checklist.md, so none of the framework's rows is recorded`
                : `cutover rows: docs/cutover-checklist.md never mentions ${unmentioned.length} framework row(s)`) +
            skipped,
        lines: [unmentioned.join(', ')],
    }
}
