// @ts-check
// `sssb launch-json`: generates `.claude/launch.json` for THIS checkout.
//
// The Claude desktop app's browser pane starts a dev server by name from that file and then waits on the `port`
// it declares. The file is static JSON with no way to read an env var, so a checked-in `"port": 3000` was wrong in
// every linked worktree the moment ports became per-checkout (src/ports.js): `pnpm dev` would bind the derived
// port while the pane waited on 3000 and timed out. The right value differs per checkout, so the file is
// generated and gitignored, and this generator is what is tracked instead. Run it from the workspace root's
// `prepare` script, so a fresh clone and every new worktree get a correct one from `pnpm install`.
//
// One configuration per workspace app (`sssb.apps`, else `apps/*`) that has a `dev` script and declares its port
// service (`"sssb": { "port": … }`), named `<app directory>-dev`.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { declaredPortService } from '../app-port.js'
import { appLabels, readJson, UsageError, workspaceApps, workspaceRootOf } from '../app.js'
import { portForRoot } from '../ports.js'

/** @param {string[]} args */
export async function run(args) {
    if (args.length > 0) throw new UsageError('usage: sssb launch-json')
    const root = workspaceRootOf(process.cwd())
    const configurations = []
    const apps = workspaceApps(root)
    const labels = appLabels(root, apps)
    for (const app of apps) {
        const appDir = path.join(root, app)
        const manifest = readJson(path.join(appDir, 'package.json'))
        const service = declaredPortService(appDir)
        if (!manifest.scripts?.dev || service === undefined) continue
        configurations.push({
            name: `${labels.get(app) ?? app}-dev`,
            runtimeExecutable: 'pnpm',
            runtimeArgs: ['--filter', manifest.name, 'dev'],
            port: portForRoot(root, service),
        })
    }
    const target = path.join(root, '.claude', 'launch.json')
    const next = `${JSON.stringify({ version: '0.0.1', configurations }, null, 4)}\n`

    // Only write when the content changes: `prepare` runs on every install, and rewriting an identical file would
    // churn mtimes and any watcher pointed at it.
    let current
    try {
        current = readFileSync(target, 'utf8')
    } catch {
        // No file yet (fresh clone, new worktree): fall through and write one.
    }
    if (current !== next) {
        mkdirSync(path.dirname(target), { recursive: true })
        writeFileSync(target, next)
        console.log(`launch.json: ${configurations.map((c) => `${c.name} on ${c.port}`).join(', ') || 'no apps'}`)
    }
    return 0
}
