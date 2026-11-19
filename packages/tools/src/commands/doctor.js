// @ts-check
// `sssb doctor [--app <dir>]`: the checks that a workspace's installed SSSB is the one it was built and tested as
// (ADR-0014 part 5), and that SSSB's conformance suite would actually run (part 3). ONE RUN CHECKS THE WHOLE
// WORKSPACE: it walks pnpm-workspace.yaml for every importer of @sssb/kit and every APP (in-repo, the apps the
// workspace's commands fan out over, `sssb.apps` or apps/*; otherwise every importer with a seam of its own,
// `src/app-config`), and gives each app the per-app checks, the one it runs for (`--app`, or the working directory)
// among them. WHERE IT STARTS: `--app <dir>`, or the working directory when it resolves @sssb/kit (an app, or an
// in-repo root), or, at the root of a workspace whose root takes no @sssb/kit (a generated workspace's), the
// workspace's first app; the walk then also has to reach every app the workspace names, so starting from the first
// finds what starting from any other would. It fails, naming every problem, on:
//
//   - FIRST, and alone: a layout pnpm installed with a `nodeLinker` other than `isolated` (`pnp`, `hoisted`), or a
//     `.pnp.cjs` at the root or in doctor's own NODE_OPTIONS, which the checks below are not built for, and under which
//     (Plug'n'Play) Vitest's listing never finishes;
//   - a workspace walk that cannot read pnpm-workspace.yaml, or that does not reach the app doctor runs for (or, when it
//     chose its own start, any app the workspace names);
//   - two copies of a singleton: a peer of @sssb/kit found from the kit's directory and from an app's must be ONE
//     real directory (the `readlink -f` check build-notes tells a dependency PR to run by hand);
//   - an importer of @sssb/kit, anywhere in the workspace, without its own seam: it must declare its
//     `@sssb/app-config` link, and the instance it resolves must have that very seam linked (in-repo mode, where the
//     seam goes through aliases instead, every tsconfig `paths` entry and every Vitest alias that would resolve the
//     seam for an app must send it into that app's own);
//   - an @sssb/* package an app resolves at another version than its @sssb/kit;
//   - an app's port declaration (`"sssb": { "port": … }`) that is not valid, two apps that declare one port slot, or two
//     custom slots with one default port: their dev servers and e2e runs would bind one port (portSlotProblems);
//   - a check of the conformance suite that would not run, unless the app opted out of it by name in its own suite
//     file: the MAIN unit run (the config a bare `vitest` would load for the app: the root's when it runs the app's
//     `src/` tests, else the one Vitest finds walking up from the app, else Vitest's defaults there) must list every
//     unit check from the app's own `src/sssb.conformance.test.ts`; some config that runs its `tests/contract/` files
//     must list every contract check from them;
//   - an app guide copy that is stale against the guide the kit ships (`sssb guide --check`), once the kit ships one;
//     in-repo, only once the repository holds a copy (SSSB's own repo, where the kit's guide is the source).
//
// It REPORTS, without failing: every other Vitest config (`vitest*.config.*` at the root or in an app) that runs some of
// an app's `src/` tests but not its suite, or its `tests/contract/` files without listing every contract check, or that
// doctor cannot list (any of them CI might run instead); a bare `vitest` from the app's directory, when the root's is
// the main run, that would not run the app's suite (even one that runs none of its tests); each opt-out with its reason; the flags and file filters the root's and the apps'
// package.json scripts pass to vitest (doctor proves what each configuration would run, never what a CI step's own
// command line adds); which script runs each app's contract config (doctor lists the contract checks, it never runs
// them); `dedupePeerDependents: false` missing from pnpm-workspace.yaml (advice); framework cutover rows the
// workspace's checklist never mentions; an app, or an app's seam package, that the root's knip JSON config (`knip.json`, `knip.jsonc`, `.knip.json` or
// `.knip.jsonc`) gives no workspace, and a root `@sssb/create` that knip would call unused; and the commits the workspace pins SSSB's reusable workflow and the plugin's
// marketplace at (`.github/workflows/*.yml`, `.claude/settings.json`), against the release commit the installed
// @sssb/kit stamps into its package (`dist/release.json`), naming both commits where they differ; and the adopter's own
// settings (doctor-settings.js): on the workspace's GitHub repository, read-only through `gh`, whether `sssb /
// all-checks` is a required check on the default branch, private vulnerability reporting is on, and, for a private
// repository in an organization, its Actions policy lets it call SSSB's reusable workflow, and whether the plugin
// `.claude/settings.json` enables is installed on this machine. A `gh` that is missing, signed out, offline or refused
// reads "not checked", with the reason; none of it runs when `CI` is set.
import { existsSync, readdirSync, readFileSync, realpathSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { readJson, takeAppDir, UsageError, workspaceApps, workspaceRootOf } from '../app.js'
import { kitDirOf, kitVersionOf, resolveAppsKit } from '../kit.js'
import {
    aliasProblems,
    areaOf,
    cutoverReport,
    discoverWorkspace,
    githubRepositoryOf,
    importerSeamProblems,
    kitPeers,
    knipGaps,
    missingTests,
    nodeLinkerProblem,
    ownTests,
    packageDirFrom,
    parseWorkspaceYaml,
    pinReport,
    portSlotProblems,
    PROBE,
    realish,
    singletonProblems,
    sssbPackagesOf,
    versionProblems,
    vitestInvocations,
} from './doctor-checks.js'
import { settingsReports } from './doctor-settings.js'
import {
    projectsRunning,
    runKey,
    seamAliases,
    vitestDefaultConfig,
    vitestList,
    vitestRunsFor,
} from './doctor-vitest.js'

const SEAM = '@sssb/app-config'
const RUNNERS = /** @type {const} */ (['unit', 'contract'])

/** @typedef {{ status: 'ok' | 'FAIL' | 'report' | 'advice', title: string, lines?: string[] }} Result */
/** @typedef {ReturnType<typeof discoverWorkspace>} Workspace */
/** @typedef {import('./doctor-vitest.js').VitestRun} VitestRun */
/** @typedef {import('./doctor-checks.js').SeamRoute} SeamRoute */
/** @typedef {Map<string, ReturnType<typeof vitestList>>} VitestCache each `vitest list`, by cwd, config and selection */
/** @typedef {{ run: VitestRun, projects: string[] }} Selected a Vitest run, and the projects in it to list (none: all) */
/**
 * @typedef {object} Plan which runs hold an app to which checks (planFor)
 * @property {Selected | null} main the MAIN unit run: the first run a bare `vitest` would make for the app that runs
 *   any of its `src/` test files
 * @property {VitestRun[]} tried the bare runs tried for it, in order
 * @property {string[]} mainErrors a bare run doctor could not list before it found the main one
 * @property {{ run: VitestRun, files: number, bare: boolean }[]} partial other configs that run some of the app's
 *   `src/` test files and not its `src/sssb.conformance.test.ts`, and the bare runs past the main one (`bare`) that do
 *   not run it, even running none of those files
 * @property {Selected[]} contract every config that runs any of the app's `tests/contract/` files
 * @property {{ run: VitestRun, error: string }[]} unlisted other configs doctor could not list
 * @property {string[]} nested the workspace packages inside the app, whose files are not the app's
 */

/**
 * The app doctor runs for, and whether it was chosen for the person. Doctor checks the whole workspace from any of its
 * apps, so the short form has to work where people type it, the root: with no `--app`, a working directory that
 * resolves `@sssb/kit` is the app (as before), and a workspace root that does not (a generated workspace's root takes
 * no framework) starts from the workspace's first app.
 * @param {string[]} args
 * @param {string} [cwd]
 * @returns {{ dir: string, defaulted: boolean, named: string[] }} `named`: when doctor chose the app, every app the
 *   workspace names (absolute), which the walk must all reach: the person did not name one to hold it to
 */
export function doctorApp(args, cwd = process.cwd()) {
    if (args.includes('--app')) return { dir: takeAppDir(args, cwd), defaulted: false, named: [] }
    const here = path.resolve(cwd)
    if (existsSync(path.join(here, 'package.json')) && packageDirFrom(here, '@sssb/kit') !== null) {
        return { dir: here, defaulted: false, named: [] }
    }
    if (existsSync(path.join(here, 'pnpm-workspace.yaml')) && existsSync(path.join(here, 'package.json'))) {
        const apps = workspaceApps(here)
        if (apps.length === 0) {
            throw new UsageError(
                `sssb doctor: ${here} is a workspace root that takes no @sssb/kit and has no apps (\`sssb.apps\` in its ` +
                    'package.json, or apps/<name>): pass --app <dir>',
            )
        }
        return { dir: path.resolve(here, apps[0]), defaulted: true, named: apps.map((a) => path.resolve(here, a)) }
    }
    // Neither: the usual refusal, which says to run from an app or pass --app.
    return { dir: takeAppDir(args, cwd), defaulted: false, named: [] }
}

/** @param {string[]} args */
export async function run(args) {
    const chosen = doctorApp(args)
    const appDir = realpathSync(chosen.dir)
    if (args.length > 0) throw new UsageError(`sssb doctor: unknown argument ${args[0]} (usage: doctor [--app <dir>])`)
    const root = realpathSync(workspaceRootOf(appDir))
    const rel = relativeTo(root)
    // Said before anything can fail on the app it chose, so a failure there is read with the reason it was picked.
    if (chosen.defaulted) {
        console.log(
            `sssb doctor: no --app, and the working directory (${root}) takes no @sssb/kit: starting from ${rel(appDir)}. One run checks every app of the workspace.`,
        )
    }
    // First: under another layout nothing below holds, and under Plug'n'Play (`.pnp.cjs` in NODE_OPTIONS) Vitest's
    // listing never finishes until the limit stops it.
    const layout = nodeLinkerProblem(root)
    if (layout !== null) {
        console.log(`sssb doctor: ${rel(appDir)}`)
        return print([{ status: 'FAIL', title: `installed layout: ${layout}. Nothing else is checked until it is` }])
    }
    const kitDir = kitDirOf(appDir)
    const version = kitVersionOf(appDir)
    const heading = `sssb doctor: ${rel(appDir)}, @sssb/kit ${version} at ${rel(kitDir)}`

    /** @type {Workspace} */
    let workspace
    try {
        workspace = discoverWorkspace(root, kitDir)
    } catch (error) {
        if (!(error instanceof UsageError)) throw error
        console.log(heading)
        return print([
            {
                status: 'FAIL',
                title: `workspace walk: ${error.message.replace(/^sssb: /, '')}. Nothing else is checked until doctor can walk the workspace`,
            },
        ])
    }
    const { inRepo, apps } = workspace
    console.log(
        heading +
            (inRepo
                ? ' (in-repo mode: the kit is a package of this workspace, so the seam goes through aliases, not a link)'
                : ''),
    )

    /** @type {VitestCache} */
    const cache = new Map()
    /** @type {Map<string, Plan>} */
    const plans = new Map()
    for (const app of apps) plans.set(app, planFor(root, app, nestedIn(workspace.packages, app), cache))
    const targets = [...new Set([appDir, ...apps])]

    /** @type {Result[]} */
    const results = [
        walk(
            root,
            appDir,
            workspace,
            chosen.named.map((dir) => realpathSync(dir)),
        ),
        ...targets.map((target) => singletons(root, target)),
        inRepo ? await inRepoAliases(root, workspace, plans) : importers(root, workspace),
        ...targets.map((target) => versions(root, target)),
        portSlots(root, apps),
        ...apps.flatMap((app) => RUNNERS.flatMap((runner) => conformance(root, app, runner, plans, cache))),
        ...commandLines(root, appDir, apps, plans),
        ...(await guides(root, apps, inRepo)),
        pins(root, kitDir, version, inRepo),
        dedupeAdvice(root, inRepo),
        cutover(root, appDir),
        ...knip(root, apps, workspace.packages),
        ...settings(root, kitDir),
    ]
    return print(results)
}

/** @param {string} root */
const relativeTo = (root) => (/** @type {string} */ dir) => path.relative(root, dir) || '(the workspace root)'

/**
 * @param {Result[]} results
 * @returns {number} the exit code
 */
function print(results) {
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
 * The workspace packages strictly inside `app` (a root-level app's apps/*), real paths. The app's own seam,
 * `src/app-config`, is a workspace package too (so pnpm keeps it linked), but its files, tests included, are the app's.
 * @param {readonly string[]} packages
 * @param {string} app
 */
const nestedIn = (packages, app) =>
    packages
        .map((dir) => realpathSync(dir))
        .filter((dir) => dir !== app && dir.startsWith(app + path.sep) && dir !== path.join(app, 'src', 'app-config'))

/**
 * PORT SLOTS: each app of the workspace binds a port of its own (see portSlotProblems).
 * @param {string} root
 * @param {readonly string[]} apps
 * @returns {Result}
 */
function portSlots(root, apps) {
    const { problems, slots } = portSlotProblems(root, apps)
    return verdict('port slots: no two apps bind one port', problems, slots)
}

/**
 * THE WALK REACHES THE APP: what every workspace-wide check below covers is what the walk found, so an app it missed
 * (a pnpm-workspace.yaml glob that does not cover it, a manifest that does not declare @sssb/kit) would pass every
 * one of them unexamined. Doctor's own app must be among the importers, and, when it has a seam, among the apps.
 * @param {string} root
 * @param {string} appDir
 * @param {Workspace} workspace
 * @param {string[]} [named] the apps the workspace names, when doctor chose its own start: each must be reached too,
 *   or the bare form would pass a workspace whose walk drops an app that `--app <it>` would fail
 * @returns {Result}
 */
function walk(root, appDir, workspace, named = []) {
    const rel = relativeTo(root)
    const importerDirs = workspace.importers.map(({ dir }) => dir)
    const importers = importerDirs.map(rel).join(', ') || 'none'
    const apps = workspace.apps.map(rel).join(', ') || 'none'
    /** @type {string[]} */
    const problems = []
    if (!importerDirs.includes(appDir))
        problems.push(
            `${rel(appDir)} is not among the importers of @sssb/kit the walk found (${importers}): check pnpm-workspace.yaml's ` +
                `packages globs, and that ${rel(appDir)}'s package.json declares @sssb/kit`,
        )
    if (existsSync(path.join(appDir, 'src', 'app-config')) && !workspace.apps.includes(appDir))
        problems.push(
            `${rel(appDir)} has a seam (src/app-config) but is not among the apps the walk found (${apps})` +
                (workspace.inRepo ? ": in-repo, the apps are the root package.json's sssb.apps, or apps/*" : ''),
        )
    /** @type {string[]} */
    const unreached = []
    for (const dir of named) {
        if (dir === appDir) continue
        if (!importerDirs.includes(dir) || !workspace.apps.includes(dir)) {
            unreached.push(
                `${rel(dir)} is named by the workspace (\`sssb.apps\`, or apps/*) but the walk does not reach it as an app that ` +
                    `takes @sssb/kit (importers: ${importers}; apps: ${apps}): check pnpm-workspace.yaml's packages globs, and that ` +
                    `${rel(dir)}'s package.json declares @sssb/kit`,
            )
        }
    }
    if (problems.length === 0 && unreached.length > 0) {
        return {
            status: 'FAIL',
            title: 'workspace walk: it does not reach every app the workspace names, so the checks below do not cover them',
            lines: unreached,
        }
    }
    return problems.length > 0
        ? {
              status: 'FAIL',
              title: `workspace walk: it does not reach ${rel(appDir)}, the app doctor runs for, so the checks below do not cover it`,
              lines: [...problems, ...unreached],
          }
        : {
              status: 'ok',
              title: `workspace walk: ${workspace.packages.length} package(s) from pnpm-workspace.yaml; importers of @sssb/kit: ${importers}; apps: ${apps}`,
          }
}

/**
 * @param {string} root
 * @param {string} target
 * @returns {Result}
 */
function singletons(root, target) {
    const name = relativeTo(root)(target)
    let kitDir
    try {
        kitDir = kitDirOf(target)
    } catch (error) {
        return { status: 'FAIL', title: `${name}: one copy of each singleton`, lines: [messageOf(error)] }
    }
    const { peers, optional } = kitPeers(kitDir)
    const { problems, notes, same } = singletonProblems({
        peers,
        optional,
        fromKit: (peer) => packageDirFrom(/** @type {string} */ (kitDir), peer),
        fromApp: (peer) => packageDirFrom(target, peer),
    })
    return verdict(
        problems.length > 0
            ? `${name}: one copy of each singleton: it and its @sssb/kit do not share every peer`
            : `${name}: one copy of each singleton: ${same.join(', ') || 'no peer'}`,
        problems,
        notes,
    )
}

/** @param {unknown} error */
const messageOf = (error) => (error instanceof Error ? error.message : String(error))

/**
 * @param {string} root
 * @param {Workspace} workspace
 * @returns {Result}
 */
function importers(root, workspace) {
    const { problems, importers: found } = importerSeamProblems(root, kitDirOf, workspace.importers, workspace.packages)
    return verdict(
        problems.length > 0
            ? 'one SSSB per importer, with its own seam: an importer of @sssb/kit runs on a seam not its own'
            : `one SSSB per importer, with its own seam: ${found.join(', ') || 'no importer'}`,
        problems,
    )
}

/**
 * In-repo mode's check, over every app of the workspace: every tsconfig `paths` entry, and every alias of every Vitest
 * project that holds the app to checks (its main unit run's, and every contract config's), that would resolve the seam
 * sends it into the app's own.
 * @param {string} root
 * @param {Workspace} workspace
 * @param {Map<string, Plan>} plans
 * @returns {Promise<Result>}
 */
async function inRepoAliases(root, workspace, plans) {
    /** Paths shown relative to the workspace root (so equal real paths stay equal); a bare specifier as it is. */
    const shown = (/** @type {string} */ file) => (path.isAbsolute(file) ? path.relative(root, file) || '.' : file)
    const show = (/** @type {SeamRoute} */ route) => ({
        find: route.find,
        to: shown(route.to),
        resolved: route.resolved.map(shown),
    })
    /** @type {Parameters<typeof aliasProblems>[0]} */
    const apps = []
    for (const appDir of workspace.apps) {
        const plan = /** @type {Plan} */ (plans.get(appDir))
        const own = realish(path.join(appDir, 'src', 'app-config'))
        /** @type {Parameters<typeof aliasProblems>[0][number]['projects']} */
        const projects = []
        const seen = new Set()
        for (const { run, projects: names } of [...(plan.main ? [plan.main] : []), ...plan.contract]) {
            const key = `${run.cwd}\0${run.config ?? ''}\0${names.join('\0')}`
            if (seen.has(key)) continue
            seen.add(key)
            const config = configName(root, run)
            for (const [project, routes] of await seamAliases(run, names, own))
                projects.push({ config, project, routes: routes.map(show) })
        }
        apps.push({
            app: relativeTo(root)(appDir),
            own: shown(own),
            tsconfig: tsconfigRoutes(appDir).map(show),
            projects,
        })
    }
    const problems = aliasProblems(apps)
    // The other importers have no seam of their own to alias: in-repo, each is compiled within a program that names one
    // (the root's is the framework's own, on its test fixture; the showcase's seed is compiled within the showcase).
    const others = workspace.importers
        .map(({ dir }) => dir)
        .filter((dir) => !workspace.apps.includes(dir))
        .map(relativeTo(root))
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
 * Every place the app's tsconfig sends the seam, as TypeScript itself reads the file (its `extends` and `baseUrl`
 * honoured), through the compiler the app installs: each target of each `paths` key that is or starts with
 * `@sssb/app-config`, with where a subpath lands through it (a `*` filled in with a probe name). Empty when it maps no
 * such path.
 * @param {string} appDir
 * @returns {SeamRoute[]}
 */
function tsconfigRoutes(appDir) {
    const file = path.join(appDir, 'tsconfig.json')
    if (!existsSync(file)) return []
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
    if (!parsed) return []
    const options = /** @type {{ baseUrl?: string, pathsBasePath?: string }} */ (parsed.options)
    const base = options.baseUrl ?? options.pathsBasePath ?? appDir
    /** @type {SeamRoute[]} */
    const routes = []
    for (const [key, targets] of Object.entries(parsed.options.paths ?? {})) {
        if (!key.startsWith(SEAM)) continue
        for (const target of targets) {
            const to = path.resolve(base, target)
            // The FIRST `*` in the target takes the matched text and any later one stays literal, exactly as
            // TypeScript's resolver substitutes it (`replaceFirstStar`). TypeScript rejects a second `*` only when it
            // builds a program (TS5062), so the parsed config doctor reads still carries such a target, and doctor must
            // follow it where TypeScript would.
            const star = to.indexOf('*')
            const probed = key.includes('*') && star >= 0 ? `${to.slice(0, star)}${PROBE}${to.slice(star + 1)}` : to
            routes.push({ find: key, to, resolved: [realish(probed)] })
        }
    }
    return routes
}

/**
 * @param {string} root
 * @param {string} target
 * @returns {Result}
 */
function versions(root, target) {
    const name = relativeTo(root)(target)
    const packages = sssbPackagesOf(target)
    const problems = versionProblems(packages)
    return verdict(
        problems.length > 0
            ? `${name}: versions in step: an @sssb package is not the version of @sssb/kit`
            : `${name}: versions in step: ${[...packages].map(([pkg, v]) => `${pkg} ${v}`).join(', ')}`,
        problems,
    )
}

/**
 * How a run is named in doctor's output.
 * @param {string} root
 * @param {VitestRun} run
 */
const configName = (root, run) =>
    run.config
        ? path.relative(root, run.config) +
          (path.dirname(run.config) === run.cwd ? '' : ` from ${relativeTo(root)(run.cwd)}`)
        : `Vitest's defaults from ${relativeTo(root)(run.cwd)}`

/**
 * How a `vitest list` is named in doctor's output: where it runs, the config, the projects selected.
 * @param {string} root
 * @param {Selected} selected
 */
const listName = (root, { run, projects }) =>
    `vitest list from ${run.cwd === root ? 'the workspace root' : path.relative(root, run.cwd)}` +
    (run.config ? ` --config ${path.relative(run.cwd, run.config)}` : ", Vitest's defaults") +
    (projects.length ? `, project ${projects.join(', ')}` : '')

/**
 * A `vitest list`, once per run and selection.
 * @param {VitestRun} run
 * @param {{ filesOnly?: boolean, projects?: readonly string[] }} options
 * @param {VitestCache} cache
 */
function listOnce(run, options, cache) {
    const key = [run.cwd, run.config ?? '', options.filesOnly ? 'files' : 'tests', ...(options.projects ?? [])].join(
        '\0',
    )
    // After one listing ran out of time, the rest are not waited on: each would likely hang the same way, and the
    // limit is per listing, so one app's configs could each spend it.
    const listed = cache.get(key) ?? cache.get(STOPPED) ?? vitestList(run, options)
    cache.set(key, listed)
    if (!listed.ok && listed.timedOut && !cache.has(STOPPED)) {
        cache.set(STOPPED, {
            ok: false,
            timedOut: true,
            error: `not listed, since an earlier listing ran out of time (${listed.error})`,
        })
    }
    return listed
}

/** The cache key of the error every listing after one that ran out of time returns. */
const STOPPED = '\0stopped'

/**
 * WHICH RUNS HOLD AN APP TO WHICH CHECKS, found with `vitest list --filesOnly` alone (it loads each config and globs
 * its files; it runs no globalSetup and collects no test file):
 *
 *   - the MAIN unit run: the first of the runs a bare `vitest` would make for the app (vitestRunsFor's `bare`) that
 *     runs any of its `src/` test files, with the projects that run them selected. It must list every unit check. A
 *     bare run doctor cannot list stops the search (doctor cannot tell whether that one is the main run);
 *   - every OTHER config (root's and app's) that runs some of its `src/` test files but not its
 *     `src/sssb.conformance.test.ts`, and every bare run past the main one (the app directory's, when the root's is
 *     main) that does not run that file, even one that runs none of them: reported, since CI might run it instead of
 *     the main one;
 *   - every config (the main run's too) that runs any of its `tests/contract/` files: one of them must list every
 *     contract check (Vitest's defaults are no contract config);
 *   - every other config doctor cannot list: reported.
 *
 * Only the main run and the contract configs are then listed in full (conformance), which loads their globalSetup.
 * @param {string} root
 * @param {string} app
 * @param {string[]} nested the workspace packages inside the app, whose files are not the app's
 * @param {VitestCache} cache
 * @returns {Plan}
 */
function planFor(root, app, nested, cache) {
    /** @type {Plan} */
    const plan = { main: null, tried: [], mainErrors: [], partial: [], contract: [], unlisted: [], nested }
    const { bare, configs } = vitestRunsFor(root, app)
    const filesOf = (/** @type {VitestRun} */ run) => listOnce(run, { filesOnly: true }, cache)
    /** @param {import('./doctor-vitest.js').ListedFile[]} listed @param {'unit' | 'contract'} area */
    const inArea = (listed, area) => listed.filter((entry) => areaOf(entry.file, app, nested) === area)
    /** @param {import('./doctor-vitest.js').ListedFile[]} listed */
    const select = (listed) => {
        const projects = projectsRunning(listed, app)
        return projects.includes('') ? [] : projects
    }

    for (const run of bare) {
        plan.tried.push(run)
        const files = filesOf(run)
        if (!files.ok) {
            plan.mainErrors.push(`${configName(root, run)}: ${files.error}`)
            break
        }
        const unit = inArea(files.listed, 'unit')
        if (unit.length > 0) {
            plan.main = { run, projects: select(unit) }
            break
        }
    }

    const main = plan.main?.run
    const tried = new Set(plan.tried.map(runKey))
    // The bare runs past the main one (the root's was main: a bare `vitest` from the app's directory, as the app's own
    // scripts and a `pnpm -r` run it). Each is held to the unit area like any other config, and reported even when it
    // runs NONE of the app's src/ files: a config whose globs reach the app only from the root finds nothing there,
    // and passes when it sets `passWithNoTests`. One that is not also a config file run from its own directory (the
    // root's config, run from the app) is only reported: it never joins the contract configs, which are listed in full.
    const untried = new Set(bare.filter((run) => !tried.has(runKey(run))).map(runKey))
    const isConfig = (/** @type {VitestRun} */ run) => configs.some((r) => runKey(r) === runKey(run))
    const suite = path.join(app, 'src', 'sssb.conformance.test.ts')
    const runs = [
        ...configs,
        ...(main?.config && !isConfig(main) ? [main] : []),
        ...bare.filter((run) => untried.has(runKey(run)) && !isConfig(run)),
    ]
    for (const run of runs) {
        const isMain = main !== undefined && runKey(run) === runKey(main)
        const isBare = untried.has(runKey(run))
        const reportOnly = isBare && !isConfig(run)
        const files = filesOf(run)
        if (!files.ok) {
            // A bare run tried for the main one already failed the unit check; any other is reported.
            if (!tried.has(runKey(run))) plan.unlisted.push({ run, error: files.error })
            continue
        }
        const unit = inArea(files.listed, 'unit')
        if (!isMain && (unit.length > 0 || isBare) && !unit.some((entry) => path.resolve(entry.file) === suite))
            plan.partial.push({ run, files: new Set(unit.map((entry) => path.resolve(entry.file))).size, bare: isBare })
        const contract = reportOnly ? [] : inArea(files.listed, 'contract')
        if (contract.length > 0) plan.contract.push({ run, projects: select(contract) })
    }
    return plan
}

/**
 * THE CONFORMANCE SUITE WOULD RUN (the unit runner): the main unit run (planFor) must list every test of every unit
 * check, from the app's own `src/sssb.conformance.test.ts` (ownTests), less the checks the app opted out of by name
 * there; no main run, or one doctor cannot list, fails. Every other config that runs some of the app's `src/` tests but
 * not the suite, and every other config doctor cannot list, is reported: doctor cannot see which config CI runs.
 *
 * THE CONTRACT RUNNER'S CHECKS WOULD RUN: some config that runs the app's `tests/contract/` files must list every
 * contract check; when one does, each other that runs them and does not is reported, and when none does, each fails.
 * Each opt-out is reported with its reason.
 * @param {string} root
 * @param {string} app
 * @param {'unit' | 'contract'} runner
 * @param {Map<string, Plan>} plans
 * @param {VitestCache} cache
 * @returns {Result[]}
 */
function conformance(root, app, runner, plans, cache) {
    const rel = relativeTo(root)
    const label = `${rel(app)}: ${runner === 'unit' ? 'the conformance suite would run' : "the contract runner's checks would run"}`
    const plan = /** @type {Plan} */ (plans.get(app))
    let registry
    try {
        registry = readJson(resolveAppsKit(app, 'testing/checks.json'))
    } catch (error) {
        return [{ status: 'FAIL', title: label, lines: [messageOf(error)] }]
    }
    /** @type {Result[]} */
    const results = []
    /** @type {Map<string, string>} */
    const opted = new Map()
    /** @param {Selected} selected */
    const check = (selected) => {
        const result = listOnce(selected.run, { projects: selected.projects }, cache)
        const listed = result.ok ? ownTests(result.listed, app, runner, plan.nested) : []
        const outcome = missingTests(listed, registry, runner)
        if (result.ok) for (const { id, reason } of outcome.optedOut) opted.set(id, reason)
        return {
            ...outcome,
            selected,
            where: listName(root, selected),
            error: result.ok ? null : result.error,
            passes: result.ok && outcome.missing.length === 0,
        }
    }
    /** @param {ReturnType<typeof check>} c @returns {Result} */
    const failed = (c) => ({
        status: 'FAIL',
        title: `${label}: ${c.missing.length} of its ${c.expected} tests would not run (${c.where})`,
        lines: [...(c.error === null ? [] : [`${c.where}: ${c.error}`]), ...c.missing.map((n) => `not listed: ${n}`)],
    })
    /** @param {ReturnType<typeof check>} c */
    const passed = (c) =>
        /** @type {Result} */ ({ status: 'ok', title: `${label}: all ${c.expected} tests listed (${c.where})` })

    if (runner === 'unit') {
        const mainName = plan.main ? configName(root, plan.main.run) : 'the config a bare `vitest` loads'
        if (plan.mainErrors.length > 0)
            results.push({
                status: 'FAIL',
                title: `${label}: doctor cannot list the config a bare \`vitest\` would load for ${rel(app)}, so it cannot tell whether that config runs its tests`,
                lines: plan.mainErrors,
            })
        else if (plan.main === null)
            results.push({
                status: 'FAIL',
                title:
                    `${label}: no config a bare \`vitest\` would load for ${rel(app)} runs a test file of its src/ ` +
                    `(tried ${plan.tried.map((run) => configName(root, run)).join(', ')}), so nothing holds it to the unit checks`,
            })
        else {
            const c = check(plan.main)
            results.push(c.passes ? passed(c) : failed(c))
        }
        for (const { run, files, bare } of plan.partial) {
            const runs =
                files === 0
                    ? 'runs none of its src/ test files, so not src/sssb.conformance.test.ts'
                    : `runs ${files} of its src/ test files but not src/sssb.conformance.test.ts`
            results.push({
                status: 'report',
                title: bare
                    ? `${rel(app)}: a bare \`vitest\` from ${rel(run.cwd)} loads ` +
                      `${run.config ? path.relative(root, run.config) : "no config (Vitest's defaults)"} and ${runs}: ` +
                      `if CI runs it there (the app's own scripts, \`pnpm -r\`) instead of ${mainName} from the root, ` +
                      'the conformance checks do not run'
                    : `${rel(app)}: ${configName(root, run)} ${runs}: if CI runs it instead of ${mainName}, the ` +
                      'conformance checks do not run',
            })
        }
        for (const { run, error } of plan.unlisted)
            results.push({
                status: 'report',
                title:
                    `${rel(app)}: doctor cannot list ${configName(root, run)}, so it cannot tell what that config runs; ` +
                    `it is not the config a bare \`vitest\` loads, so this is no failure, but if CI runs it, doctor has not checked it`,
                lines: [error],
            })
    } else if (plan.contract.length === 0) {
        results.push({
            status: 'FAIL',
            title:
                `${label}: no Vitest config at the workspace root or in ${rel(app)} runs a test file of its ` +
                'tests/contract/, so nothing runs its contract checks',
        })
    } else {
        const checked = plan.contract.map(check)
        const passing = checked.filter((c) => c.passes)
        if (passing.length === 0) results.push(...checked.map(failed))
        else {
            const names = passing.map((c) => configName(root, c.selected.run)).join(', ')
            for (const c of checked)
                results.push(
                    c.passes
                        ? passed(c)
                        : {
                              status: 'report',
                              title:
                                  `${rel(app)}: ${configName(root, c.selected.run)} runs its tests/contract/ files but ` +
                                  (c.error === null
                                      ? `${c.missing.length} of its ${c.expected} contract tests would not run: ` +
                                        `if CI runs it instead of ${names}, those checks do not run`
                                      : `doctor cannot list its tests (${c.error}): if CI runs it instead of ` +
                                        `${names}, doctor has not checked that the contract checks run`),
                          },
                )
        }
    }
    for (const [id, reason] of opted)
        results.push({ status: 'report', title: `${rel(app)}: opted out of ${id}: ${reason || '(no reason given)'}` })
    return results
}

/**
 * WHAT DOCTOR CANNOT SEE: the command line a CI step runs Vitest with. Doctor proves what each configuration would
 * run; a flag or a file filter on the command (`-t`, `--project`, `--shard`, a path...) can run fewer. It reads the
 * root's and the apps' package.json scripts and reports every such flag they pass, and, since it lists the contract
 * checks and never runs them, which script runs each app's contract config, or that none does.
 * @param {string} root
 * @param {string} appDir
 * @param {string[]} apps
 * @param {Map<string, Plan>} plans
 * @returns {Result[]}
 */
function commandLines(root, appDir, apps, plans) {
    const rel = relativeTo(root)
    const dirs = [...new Set([root, appDir, ...apps])]
    const owner = (/** @type {string} */ dir) => (dir === root ? 'root' : rel(dir))
    const invocations = dirs.flatMap((dir) =>
        vitestInvocations(readJson(path.join(dir, 'package.json')).scripts ?? {}).map((call) => ({ ...call, dir })),
    )
    const narrowed = invocations.filter((call) => call.narrowing.length > 0)
    /** @type {Result[]} */
    const results = [
        {
            status: 'report',
            title:
                "CI's command line: doctor proves what each Vitest configuration would run, not what a CI step's own " +
                'flags make of it; the flags and file filters the package.json scripts pass to vitest:',
            lines:
                narrowed.length > 0
                    ? narrowed.map((call) => `${owner(call.dir)} script ${call.script}: ${call.narrowing.join(', ')}`)
                    : [
                          `none (scripts of ${dirs.map(owner).join(', ')}; a flag a CI step adds itself is not here to see)`,
                      ],
        },
    ]
    /** @type {string[]} */
    const lines = []
    for (const app of apps) {
        const plan = /** @type {Plan} */ (plans.get(app))
        const configs = [...new Set(plan.contract.map(({ run }) => run.config).filter((c) => c !== null))]
        for (const config of configs) {
            const callers = invocations.filter(
                (call) =>
                    (call.config ? path.resolve(call.dir, call.config) : vitestDefaultConfig(call.dir)) === config,
            )
            const name = path.relative(root, config)
            lines.push(
                callers.length > 0
                    ? `${rel(app)}: ${callers.map((call) => `${owner(call.dir)} script ${call.script}`).join(', ')} runs ${name}`
                    : `${rel(app)}: no script of the root's or ${rel(app)}'s package.json runs ${name}; CI must run it itself`,
            )
        }
    }
    if (lines.length > 0)
        results.push({
            status: 'report',
            title: "contract checks: doctor lists them and never runs them, so CI must run each app's contract config:",
            lines,
        })
    return results
}

/**
 * The app guide (`sssb guide --check`) of every app, once the framework ships one.
 *
 * IN-REPO, a missing copy is not a failure. There the kit is a package of the workspace and its guide
 * (`packages/kit/src/guide.md`) is the source, checked by the doc gate; a copy is the adopter's mechanism, and SSSB's
 * own `CLAUDE.md` imports the source itself (`@packages/kit/src/guide.md`, ADR-0014 P13), which nothing can make stale:
 * that import is ok, and its absence is reported. Once a copy exists it is checked as an adopter's is. An adopter's
 * workspace is never in-repo, so a missing copy fails there.
 *
 * @param {string} root
 * @param {string[]} apps
 * @param {boolean} inRepo
 * @returns {Promise<Result[]>}
 */
async function guides(root, apps, inRepo) {
    /** @type {Result[]} */
    const results = []
    /** @param {string} title */
    const reportOnce = (title) => {
        if (!results.some((r) => r.title === title)) results.push({ status: 'report', title })
    }
    for (const app of apps) {
        let source
        try {
            source = resolveAppsKit(app, 'guide.md')
        } catch {
            reportOnce('app guide: not checked: this @sssb/kit ships no guide (it arrives at P7)')
            continue
        }
        if (inRepo && !existsSync(path.join(workspaceRootOf(app), '.claude', 'sssb-guide.md'))) {
            const importLine = `@${path.relative(root, realpathSync(source)).split(path.sep).join('/')}`
            const claudeMd = path.join(root, 'CLAUDE.md')
            const imports =
                existsSync(claudeMd) &&
                readFileSync(claudeMd, 'utf8')
                    .split('\n')
                    .some((line) => line.trim().split(/\s+/).includes(importLine))
            if (imports && !results.some((r) => r.status === 'ok' && r.title.startsWith('app guide:')))
                results.push({
                    status: 'ok',
                    title: `app guide: in-repo, CLAUDE.md imports the kit's guide from its source (${importLine}), so no copy can go stale`,
                })
            else if (!imports)
                reportOnce(
                    "app guide: not checked: in-repo, the kit's guide is this workspace's own source, and the repository " +
                        `neither imports it from CLAUDE.md (${importLine}) nor holds a copy of it (\`.claude/sssb-guide.md\`)`,
                )
            continue
        }
        const name = relativeTo(root)(app)
        const status = await (await import('./guide.js')).run(['--app', app, '--check'])
        results.push(
            status === 0
                ? { status: 'ok', title: `${name}: app guide: the repository's copy matches the kit's` }
                : { status: 'FAIL', title: `${name}: app guide: the repository's copy is not the kit's (see above)` },
        )
    }
    return results
}

/**
 * The workflow and plugin pins against the kit's release stamp (pinReport): read here, judged there. The workflows are
 * the workspace root's `.github/workflows/*.{yml,yaml}`, the settings its `.claude/settings.json` (the shared one; a
 * machine's `settings.local.json` is no pin of the repository's), the stamp the APP's kit's `dist/release.json`.
 * @param {string} root
 * @param {string} kitDir
 * @param {string} version
 * @param {boolean} inRepo
 * @returns {Result}
 */
function pins(root, kitDir, version, inRepo) {
    const settingsText = readIfThere(path.join(root, '.claude', 'settings.json'))
    return pinReport({
        inRepo,
        version,
        stamp: readIfThere(path.join(kitDir, 'dist', 'release.json')),
        repository: githubRepositoryOf(readJson(path.join(kitDir, 'package.json')).repository),
        workflows: workflowFiles(root),
        settings: settingsText === null ? null : { file: '.claude/settings.json', text: settingsText },
    })
}

/** @param {string} file */
const readIfThere = (file) => (existsSync(file) ? readFileSync(file, 'utf8') : null)

/**
 * The workspace root's `.github/workflows/*.{yml,yaml}`, sorted, with their text.
 * @param {string} root
 */
function workflowFiles(root) {
    const dir = path.join(root, '.github', 'workflows')
    return existsSync(dir)
        ? readdirSync(dir)
              .filter((name) => /\.ya?ml$/.test(name))
              .sort()
              .map((name) => ({
                  file: `.github/workflows/${name}`,
                  text: /** @type {string} */ (readIfThere(path.join(dir, name))),
              }))
        : []
}

/**
 * THE ADOPTER'S OWN SETTINGS, REPORTED, never failed and never written (doctor-settings.js): the workspace's GitHub
 * repository (`sssb / all-checks` required, private vulnerability reporting, the Actions policy a private organization
 * repository needs for SSSB's reusable workflow) read through `gh`, and the plugin `.claude/settings.json` enables
 * against what this machine has installed. Skipped in CI, with a line saying so.
 * @param {string} root
 * @param {string} kitDir
 * @returns {Result[]}
 */
function settings(root, kitDir) {
    return settingsReports({
        root,
        workflows: workflowFiles(root),
        kitRepository: githubRepositoryOf(readJson(path.join(kitDir, 'package.json')).repository),
    })
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
 * KNIP: each app, and each app's seam package, has a workspace of its own in the root's knip.json (knipGaps).
 * Reported, never failed; nothing per app when the root's knip config has no `workspaces`, and nothing at all when
 * the root has no knip JSON config.
 * @param {string} root
 * @param {readonly string[]} apps
 * @param {readonly string[]} packages
 * @returns {Result[]}
 */
function knip(root, apps, packages) {
    const gaps = knipGaps(root, apps, packages)
    if (gaps === null) return []
    if ('unread' in gaps)
        return [{ status: 'report', title: `knip: not checked: ${gaps.file} does not parse as JSON (${gaps.unread})` }]
    /** @type {Result[]} */
    const results = []
    if (gaps.missing === null) {
        // One config for every package: nothing per app to look for.
    } else if (gaps.missing.length === 0)
        results.push({
            status: 'ok',
            title: `knip: ${gaps.file} gives every app, and every app's seam package, a workspace`,
        })
    else
        results.push({
            status: 'report',
            title:
                `knip: ${gaps.file} gives ${gaps.missing.length} of the apps' packages no workspace, so knip reads them ` +
                "with its defaults and calls the seam's modules and the presets' dependencies unused: add an entry for " +
                "each, like the first app's",
            lines: gaps.missing,
        })
    if (gaps.generator)
        results.push({
            status: 'report',
            title:
                `knip: the root installs @sssb/create, which nothing imports (\`sssb add-app\` loads it from ` +
                `node_modules), so knip calls it unused: \`pnpm remove -w @sssb/create\` once your apps are written, or ` +
                `add it to the root's ignoreDependencies in ${gaps.file}`,
        })
    return results
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
