// @ts-check
// `sssb serve-standalone [service]`: runs the app's standalone production build locally (`next start` does not
// serve `output: 'standalone'`). Copies the static assets the way the Lambda packaging step does, then boots
// server.js.
//
// In a monorepo Next nests the standalone output under the app's path relative to the inferred workspace root, so
// the server is at `.next/standalone/<…>/apps/<app>/server.js`, not at the top, and static assets must sit beside
// THAT file. The exact prefix depends on where Next infers the root, so it is discovered rather than assumed.
//
// The port: PORT when set, else the named port service, else the app's declared one (`"sssb": { "port": … }`).
import { spawn } from 'node:child_process'
import { cpSync, existsSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { appPortService } from '../app-port.js'
import { takeAppDir, UsageError } from '../app.js'
import { portFor, SERVICE_NAMES } from '../ports.js'

/**
 * The single server.js Next emitted, wherever it nested it.
 * @param {string} dir
 * @returns {string | null}
 */
function findServer(dir) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (entry.isFile() && entry.name === 'server.js') return path.join(dir, entry.name)
        if (entry.isDirectory() && entry.name !== 'node_modules' && entry.name !== '.next') {
            const found = findServer(path.join(dir, entry.name))
            if (found) return found
        }
    }
    return null
}

/** @param {string[]} args */
export async function run(args) {
    const root = takeAppDir(args)
    if (args.length > 1) throw new UsageError(`usage: sssb serve-standalone [${SERVICE_NAMES.join('|')}]`)
    const service = args[0] ?? (process.env['PORT'] ? undefined : appPortService(root))
    if (service !== undefined && !SERVICE_NAMES.includes(/** @type {import('../ports.d.ts').PortService} */ (service)))
        throw new UsageError(`sssb serve-standalone: unknown port service "${service}"`)

    const standalone = path.join(root, '.next', 'standalone')
    if (!existsSync(standalone)) {
        throw new UsageError('No standalone build found: build the app first (its `build:demo` or `build` script).')
    }
    const server = findServer(standalone)
    if (!server) throw new UsageError(`No server.js under ${standalone}: the standalone build looks incomplete.`)
    const serverDir = path.dirname(server)

    cpSync(path.join(root, '.next', 'static'), path.join(serverDir, '.next', 'static'), { recursive: true })
    if (existsSync(path.join(root, 'public'))) {
        cpSync(path.join(root, 'public'), path.join(serverDir, 'public'), { recursive: true })
    }

    const port = process.env['PORT'] ?? String(portFor(/** @type {import('../ports.d.ts').PortService} */ (service)))

    // PIN THE WORLD TO THE APP, not to the build output. The fake adapters resolve `.data` relative to the working
    // directory, and this child's is `serverDir`, somewhere inside `.next/standalone/…`. Left alone it writes its
    // world THERE, which is invisible from the app directory: `rm -rf .data` looks like it reset everything and
    // resets nothing, so state leaks between runs. That cost two e2e failures that looked like product bugs before
    // the cause was found. An explicit APP_DATA_DIR still wins, which is how a shard runner gives each shard its own.
    const dataDir = process.env['APP_DATA_DIR'] ?? path.join(root, '.data')

    console.log(`serving standalone build on http://localhost:${port} (world: ${dataDir})`)
    const child = spawn(process.execPath, [server], {
        stdio: 'inherit',
        env: { ...process.env, PORT: port, HOSTNAME: '127.0.0.1', APP_DATA_DIR: dataDir },
        cwd: serverDir,
    })
    return await new Promise((resolve) => {
        child.on('error', (error) => {
            console.error(`Could not start the standalone server: ${error.message}`)
            resolve(1)
        })
        child.on('exit', (code) => resolve(code ?? 0))
    })
}
