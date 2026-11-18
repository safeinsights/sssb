// @ts-check
// `sssb ci <job>`: the logic of a CI job, so a workflow step is one command that comes from the app's lockfile and
// cannot drift from the installed packages (ADR-0014 part 7). The reusable workflow
// (.github/workflows/app-checks.yml, P10) runs every job here, and SSSB's own checks.yml runs it.
//
//   sssb ci lint-typecheck-unit [--apps <dirs>]  the workspace's lint, typecheck and unit tests, then
//                                                `sssb check-fences` in each app
//   sssb ci contract                             the workspace's real-Postgres contract tests
//   sssb ci matrix [--apps <dirs>]               print the e2e shards and the static-demo apps (and write both to
//                                                $GITHUB_OUTPUT as `e2e=` and `demo-static=`)
//   sssb ci e2e-shards [--apps <dirs>]           print the e2e shard matrix alone (and write `matrix=`)
//   sssb ci e2e [--app <dir>] [--project <p>]    run one shard (the app in the working directory by default)
//   sssb ci demo-static [--app <dir>]            build an app's static demo (each app's, with no --app), check its
//                                                size, run its e2e
//   sssb ci synth --filter <selector>            run `synth` in the infra package(s) a pnpm filter selects
//
// `--apps` is a whitespace-separated list of app directories relative to the workspace root; without it, the
// workspace's apps (the root package.json's `sssb.apps`, or every `apps/<name>` package). A job that finds nothing to
// run FAILS rather than passing empty: a check that ran nothing is not a green check.
//
// `e2e-shards` and `matrix` import nothing outside Node, so they can run before `pnpm install`, from the package's
// source; app-checks.yml's `discover` installs first because it runs `pnpm exec`.
import { spawnSync } from 'node:child_process'
import { appendFileSync, existsSync, readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import {
    appLabels,
    normalAppDir,
    readJson,
    takeAppDir,
    takeOption,
    UsageError,
    workspaceApps,
    workspaceRootOf,
} from '../app.js'

const PLAYWRIGHT_CONFIGS = [
    'playwright.config.ts',
    'playwright.config.mts',
    'playwright.config.cts',
    'playwright.config.js',
    'playwright.config.mjs',
    'playwright.config.cjs',
]

/**
 * @param {string} cwd
 * @param {string[]} command
 */
function sh(cwd, command) {
    console.log(`\n$ (${cwd}) ${command.join(' ')}`)
    const result = spawnSync(command[0] ?? '', command.slice(1), { cwd, stdio: 'inherit' })
    if (result.error) throw result.error
    return result.status ?? 1
}

/**
 * The apps a job covers, relative to the workspace root: `--apps`'s list when given, each of which must be a package,
 * or the workspace's apps. A listed app is normalised (`./apps/a/` is `apps/a`) and named once. An app the list leaves
 * out (`--apps`, or the root's `sssb.apps` when there is no `--apps`), among the workspace's apps and every
 * `apps/<name>` package, is named in a warning (a GitHub Actions annotation on CI): the caller chose the list, and a
 * list that went stale when an app was added is the way an app goes unchecked with every check green.
 * @param {string} root
 * @param {string | undefined} listed
 * @param {{ warn?: boolean }} [options] `warn: false` for a job that covers the same apps as one that warns
 * @returns {string[]}
 */
export function appsOf(root, listed, { warn = true } = {}) {
    if (listed === undefined || listed.trim() === '') {
        const apps = workspaceApps(root)
        if (warn) warnLeftOut(root, apps, '`sssb.apps` in the root package.json')
        return apps
    }
    /** @type {string[]} */
    const apps = []
    for (const app of listed.split(/\s+/).filter(Boolean)) {
        if (path.isAbsolute(app) || app.split(/[\\/]/).includes('..')) {
            throw new UsageError(`sssb ci: --apps names ${app}: each app is a directory inside the workspace`)
        }
        if (!existsSync(path.join(root, app, 'package.json'))) {
            throw new UsageError(`sssb ci: --apps names ${app}, which is not a package (no package.json)`)
        }
        const normal = normalAppDir(app)
        if (!apps.includes(normal)) apps.push(normal)
    }
    if (warn) warnLeftOut(root, apps, '--apps')
    return apps
}

/**
 * Names, in a warning (a GitHub Actions annotation on CI), every app the job does not cover: one the workspace lists
 * as an app, or an `apps/<name>` package. The caller chose the list, so this is not a failure, but a list that went
 * stale when an app was added is the way an app goes unchecked with every check green.
 * @param {string} root
 * @param {string[]} apps
 * @param {string} source
 */
function warnLeftOut(root, apps, source) {
    const appsDir = path.join(root, 'apps')
    const underApps = existsSync(appsDir)
        ? readdirSync(appsDir, { withFileTypes: true })
              .filter((entry) => entry.isDirectory() && existsSync(path.join(appsDir, entry.name, 'package.json')))
              .map((entry) => `apps/${entry.name}`)
        : []
    const left = [...new Set([...workspaceApps(root), ...underApps])].filter((app) => !apps.includes(app)).sort()
    if (left.length === 0) return
    const note = `${source} leaves out ${left.join(', ')}: their e2e, static demo and check-fences do not run`
    console.log(process.env['GITHUB_ACTIONS'] ? `::warning title=sssb ci::${note}` : `WARNING: ${note}`)
}

/**
 * One shard per app running its own `test:e2e` script, UNLESS the app's Playwright config declares a project
 * literally named `destructive`, in which case it splits in two: the `chromium` project, and the destructive one
 * with `--workers=1 --no-deps`, whose specs still share one world with each other. Parallelism is only safe where
 * the worlds are separate, and separate runners have separate worlds, so shards buy it safely. Discovered from the
 * workspace's apps, never hand-listed, so a renamed or added app needs no edit to the workflow.
 * @param {string} root
 * @param {string[]} [apps]
 */
export function e2eShards(root, apps = workspaceApps(root)) {
    /** @type {{ name: string, app: string, project?: string, run: string }[]} */
    const shards = []
    const labels = appLabels(root, apps)
    for (const app of apps) {
        const config = PLAYWRIGHT_CONFIGS.map((name) => path.join(root, app, name)).find((file) => existsSync(file))
        if (!config) continue
        const name = labels.get(app) ?? app
        const base = `pnpm exec sssb ci e2e --app ${app}`
        if (/name:\s*['"]destructive['"]/.test(readFileSync(config, 'utf8'))) {
            shards.push({ name, app, project: 'chromium', run: `${base} --project chromium` })
            shards.push({
                name: `${name}-destructive`,
                app,
                project: 'destructive',
                run: `${base} --project destructive`,
            })
        } else {
            shards.push({ name, app, run: base })
        }
    }
    // Shard names name CI jobs and their report artifacts, so they must be unique: an app's `-destructive` shard could
    // meet another app labelled that way.
    /** @type {Set<string>} */
    const taken = new Set()
    for (const shard of shards) {
        const wanted = shard.name
        for (let n = 2; taken.has(shard.name); n++) shard.name = `${wanted}-${n}`
        taken.add(shard.name)
    }
    return shards
}

/**
 * The apps with a static demo (a `build:demo-static` script), each named as its e2e shard is.
 * @param {string} root
 * @param {string[]} apps
 * @returns {{ name: string, app: string }[]}
 */
export function demoApps(root, apps) {
    const labels = appLabels(root, apps)
    return apps
        .filter((app) => readJson(path.join(root, app, 'package.json')).scripts?.['build:demo-static'])
        .map((app) => ({ name: labels.get(app) ?? app, app }))
}

/** @param {string} line */
function output(line) {
    const file = process.env['GITHUB_OUTPUT']
    if (file) appendFileSync(file, `${line}\n`)
}

/**
 * The root package.json's scripts, and the one a job needs, which must exist: a job does not pass by finding
 * nothing to run.
 * @param {string} root
 * @param {string} job
 * @param {string[]} names the first of these the workspace defines is run
 */
function rootScript(root, job, names) {
    const scripts = readJson(path.join(root, 'package.json')).scripts ?? {}
    const found = names.find((name) => typeof scripts[name] === 'string')
    if (!found) {
        throw new UsageError(
            `sssb ci ${job}: the workspace root's package.json has no ${names.map((n) => `\`${n}\``).join(' or ')} ` +
                'script, so this job has nothing to run (a check that ran nothing is not green)',
        )
    }
    return found
}

/** @param {string[]} args */
export async function run(args) {
    const [job, ...rest] = args
    if (job === 'e2e-shards' || job === 'matrix') {
        const listed = takeOption(rest, '--apps')
        if (rest.length > 0) throw new UsageError(`usage: sssb ci ${job} [--apps <dirs>]`)
        const root = workspaceRootOf(process.cwd())
        const apps = appsOf(root, listed)
        if (apps.length === 0) throw new UsageError(`sssb ci ${job}: the workspace has no apps`)
        const shards = e2eShards(root, apps)
        const noE2e = apps.filter((app) => !shards.some((shard) => shard.app === app))
        if (noE2e.length > 0) {
            throw new UsageError(
                `sssb ci ${job}: ${noE2e.join(', ')} has no Playwright config (${PLAYWRIGHT_CONFIGS.join(', ')}), so its e2e would not run`,
            )
        }
        if (job === 'e2e-shards') {
            const matrix = JSON.stringify(shards)
            console.log(`computed matrix: ${matrix}`)
            output(`matrix=${matrix}`)
            return 0
        }
        // EVERY app the job covers has e2e and a static demo: one that lacks either would drop out of the matrix with
        // every check still green. (A matrix with no entries would fail its job in GitHub Actions without saying why.)
        const demos = demoApps(root, apps)
        const noDemo = apps.filter((app) => !demos.some((demo) => demo.app === app))
        if (noDemo.length > 0) {
            throw new UsageError(
                `sssb ci matrix: ${noDemo.join(', ')} has no build:demo-static script, so its static demo would not be checked`,
            )
        }
        console.log(`e2e shards: ${JSON.stringify(shards)}`)
        console.log(`static demos: ${JSON.stringify(demos)}`)
        output(`e2e=${JSON.stringify(shards)}`)
        output(`demo-static=${JSON.stringify(demos)}`)
        return 0
    }
    if (job === 'lint-typecheck-unit') {
        const listed = takeOption(rest, '--apps')
        if (rest.length > 0) throw new UsageError('usage: sssb ci lint-typecheck-unit [--apps <dirs>]')
        const root = workspaceRootOf(process.cwd())
        // `discover` (`sssb ci matrix`) warns about apps left out, for the same list; one warning a run is enough.
        const apps = appsOf(root, listed, { warn: false })
        if (apps.length === 0) throw new UsageError('sssb ci lint-typecheck-unit: the workspace has no apps')
        const steps = [
            rootScript(root, job, ['lint']),
            rootScript(root, job, ['typecheck']),
            // The coverage run is the unit run with coverage on; a workspace that defines it runs that one instead.
            rootScript(root, job, ['test:coverage', 'test:unit']),
        ]
        // Every step runs, so one red step does not hide the others; the job fails if any did.
        let status = 0
        for (const script of steps) {
            const result = sh(root, ['pnpm', 'run', script])
            status ||= result
        }
        const { run: checkFences } = await import('./check-fences.js')
        for (const app of apps) {
            console.log(`\n$ (${root}) sssb check-fences --app ${app}`)
            // Each app is checked even when one before it cannot be: a usage error (an app that does not resolve the
            // plugin) fails this app and the job, and the next app is still checked.
            let result
            try {
                result = await checkFences(['--app', path.join(root, app)])
            } catch (error) {
                if (!(error instanceof UsageError)) throw error
                console.error(error.message)
                result = 1
            }
            status ||= result
        }
        return status
    }
    if (job === 'contract') {
        if (rest.length > 0) throw new UsageError('usage: sssb ci contract')
        const root = workspaceRootOf(process.cwd())
        return sh(root, ['pnpm', 'run', rootScript(root, job, ['test:contract'])])
    }
    if (job === 'synth') {
        const filter = takeOption(rest, '--filter')
        if (filter === undefined || rest.length > 0) throw new UsageError('usage: sssb ci synth --filter <selector>')
        const root = workspaceRootOf(process.cwd())
        // EVERY package the selector matches has a `synth` script: pnpm's recursive run skips one that does not, and
        // fails only when none has it. --fail-if-no-match: a selector that names no package fails too.
        const listing = spawnSync('pnpm', ['--filter', filter, 'list', '--depth', '-1', '--json'], {
            cwd: root,
            encoding: 'utf8',
        })
        if (listing.status !== 0)
            throw new UsageError(
                `sssb ci synth: pnpm could not list --filter ${filter}\n${listing.stdout}${listing.stderr}`,
            )
        /** @type {{ path: string }[]} */
        const matched = JSON.parse(listing.stdout || '[]')
        if (matched.length === 0) throw new UsageError(`sssb ci synth: --filter ${filter} matches no package`)
        const noSynth = matched.filter(
            (pkg) => typeof readJson(path.join(pkg.path, 'package.json')).scripts?.synth !== 'string',
        )
        if (noSynth.length > 0) {
            throw new UsageError(
                `sssb ci synth: ${noSynth.map((pkg) => path.relative(root, pkg.path)).join(', ')} has no synth script`,
            )
        }
        return sh(root, ['pnpm', '--filter', filter, '--fail-if-no-match', 'run', 'synth'])
    }
    if (job === 'e2e') {
        const appDir = takeAppDir(rest)
        const project = takeOption(rest, '--project')
        if (rest.length > 0) throw new UsageError('usage: sssb ci e2e --app <dir> [--project <name>]')
        if (project === undefined) return sh(appDir, ['pnpm', 'run', 'test:e2e'])
        const extra = project === 'destructive' ? ['--workers=1', '--no-deps'] : []
        return sh(appDir, ['pnpm', 'exec', 'playwright', 'test', `--project=${project}`, ...extra])
    }
    if (job === 'demo-static') {
        const named = rest.includes('--app') ? [takeAppDir(rest)] : undefined
        if (rest.length > 0) throw new UsageError('usage: sssb ci demo-static [--app <dir>]')
        const root = workspaceRootOf(process.cwd())
        const apps = (named ?? workspaceApps(root).map((app) => path.join(root, app))).filter(
            (dir) => readJson(path.join(dir, 'package.json')).scripts?.['build:demo-static'],
        )
        if (apps.length === 0) throw new UsageError('sssb ci demo-static: no app has a build:demo-static script')
        for (const step of ['build:demo-static', 'check:demo-size', 'e2e:demo-static']) {
            for (const dir of apps) {
                const status = sh(dir, ['pnpm', 'run', step])
                if (status !== 0) return status
            }
        }
        return 0
    }
    throw new UsageError(
        'usage: sssb ci <lint-typecheck-unit | contract | matrix | e2e-shards | e2e | demo-static | synth>',
    )
}
