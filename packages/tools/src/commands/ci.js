// @ts-check
// `sssb ci <job>`: the logic of a CI job, so a workflow step is one command that comes from the app's lockfile and
// cannot drift from the installed packages (ADR-0014 part 7). The reusable workflow (P10) calls these; SSSB's own
// checks.yml already does.
//
//   sssb ci e2e-shards                         print the e2e shard matrix (and write it to $GITHUB_OUTPUT)
//   sssb ci e2e --app <dir> [--project <p>]    run one shard
//   sssb ci demo-static [--app <dir>]          build each app's static demo, check its size, run its e2e
//
// `e2e-shards` imports nothing outside Node, so it runs before `pnpm install`.
import { spawnSync } from 'node:child_process'
import { appendFileSync, existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { appLabels, readJson, takeAppDir, takeOption, UsageError, workspaceApps, workspaceRootOf } from '../app.js'

const PLAYWRIGHT_CONFIGS = [
    'playwright.config.ts',
    'playwright.config.mts',
    'playwright.config.js',
    'playwright.config.mjs',
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
 * One shard per app running its own `test:e2e` script, UNLESS the app's Playwright config declares a project
 * literally named `destructive`, in which case it splits in two: the `chromium` project, and the destructive one
 * with `--workers=1 --no-deps`, whose specs still share one world with each other. Parallelism is only safe where
 * the worlds are separate, and separate runners have separate worlds, so shards buy it safely. Discovered from the
 * workspace's apps, never hand-listed, so a renamed or added app needs no edit to the workflow.
 * @param {string} root
 */
export function e2eShards(root) {
    /** @type {{ name: string, app: string, run: string }[]} */
    const shards = []
    const apps = workspaceApps(root)
    const labels = appLabels(root, apps)
    for (const app of apps) {
        const config = PLAYWRIGHT_CONFIGS.map((name) => path.join(root, app, name)).find((file) => existsSync(file))
        if (!config) continue
        const name = labels.get(app) ?? app
        const base = `pnpm exec sssb ci e2e --app ${app}`
        if (/name:\s*['"]destructive['"]/.test(readFileSync(config, 'utf8'))) {
            shards.push({ name, app, run: `${base} --project chromium` })
            shards.push({ name: `${name}-destructive`, app, run: `${base} --project destructive` })
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

/** @param {string[]} args */
export async function run(args) {
    const [job, ...rest] = args
    if (job === 'e2e-shards') {
        if (rest.length > 0) throw new UsageError('usage: sssb ci e2e-shards')
        const matrix = JSON.stringify(e2eShards(workspaceRootOf(process.cwd())))
        console.log(`computed matrix: ${matrix}`)
        const output = process.env['GITHUB_OUTPUT']
        if (output) appendFileSync(output, `matrix=${matrix}\n`)
        return 0
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
    throw new UsageError('usage: sssb ci <e2e-shards | e2e | demo-static>')
}
