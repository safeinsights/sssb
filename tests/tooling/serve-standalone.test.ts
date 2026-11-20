import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { makeTestTmpDir } from '../support/tmp-dir'

/**
 * `sssb serve-standalone` wraps the app's standalone server.js. Playwright stops it by killing the process group, but
 * a signal to the wrapper alone (`kill <pid>`, a supervisor, a CI cancel) used to leave the server holding the app's
 * port, where the next run's `reuseExistingServer` adopted a stale build; and a server that died on a signal was
 * reported as a success. A fake server.js stands in for Next's: it records its pid, then serves or kills itself.
 */
const SSSB = path.resolve(__dirname, '../../packages/tools/bin/sssb.js')

/** An app with a standalone build whose server.js runs `body` after writing its pid beside itself. */
function standaloneApp(body: string) {
    const root = realpathSync(makeTestTmpDir('sssb-serve-standalone-'))
    writeFileSync(path.join(root, 'pnpm-workspace.yaml'), "packages:\n  - 'apps/*'\n")
    const app = path.join(root, 'apps', 'web')
    mkdirSync(path.join(app, '.next', 'standalone'), { recursive: true })
    mkdirSync(path.join(app, '.next', 'static'), { recursive: true })
    writeFileSync(
        path.join(app, 'package.json'),
        JSON.stringify({ name: 'web', sssb: { port: { name: 'web', default: 3900 } } }),
    )
    const pidFile = path.join(root, 'server.pid')
    writeFileSync(
        path.join(app, '.next', 'standalone', 'server.js'),
        `require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid))\n${body}\n`,
    )
    return { app, pidFile }
}

const freePort = () =>
    new Promise<number>((resolve) => {
        const server = createServer().listen(0, '127.0.0.1', () => {
            const { port } = server.address() as { port: number }
            server.close(() => resolve(port))
        })
    })

const alive = (pid: number) => {
    try {
        process.kill(pid, 0)
        return true
    } catch {
        return false
    }
}

async function until(condition: () => boolean, what: string) {
    for (let i = 0; i < 200 && !condition(); i++) await new Promise((resolve) => setTimeout(resolve, 25))
    if (!condition()) throw new Error(`timed out waiting for ${what}`)
}

/** Starts the wrapper in its own process group, so a signal reaches it alone, as a `kill <pid>` would. */
function serve(app: string, port: number) {
    const env: NodeJS.ProcessEnv = { ...process.env, PORT: String(port) }
    for (const key of Object.keys(env)) if (key.startsWith('VITEST')) delete env[key]
    const wrapper = spawn(process.execPath, [SSSB, 'serve-standalone'], {
        cwd: app,
        env,
        detached: true,
        stdio: 'ignore',
    })
    const exited = new Promise<number | null>((resolve) => wrapper.on('exit', (code) => resolve(code)))
    return { wrapper, exited }
}

describe('sssb serve-standalone', () => {
    it('stops the server when the wrapper alone is sent SIGTERM, and exits non-zero', async () => {
        const { app, pidFile } = standaloneApp(
            "require('node:http').createServer((q, s) => s.end('ok')).listen(process.env.PORT, '127.0.0.1')",
        )
        const { wrapper, exited } = serve(app, await freePort())
        await until(() => existsSync(pidFile), 'the server to start')
        const server = Number(readFileSync(pidFile, 'utf8'))
        expect(alive(server)).toBe(true)
        wrapper.kill('SIGTERM')
        const status = await exited
        await until(() => !alive(server), 'the server to stop')
        expect(status).toBe(128 + 15)
    }, 20_000)

    it('exits non-zero when the server dies on a signal', async () => {
        const { app, pidFile } = standaloneApp("process.kill(process.pid, 'SIGKILL')")
        const { exited } = serve(app, await freePort())
        expect(await exited).toBe(128 + 9)
        expect(existsSync(pidFile)).toBe(true)
    }, 20_000)
})
