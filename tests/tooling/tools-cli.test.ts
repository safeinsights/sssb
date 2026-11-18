import { spawnSync } from 'node:child_process'
import {
    appendFileSync,
    existsSync,
    mkdirSync,
    readFileSync,
    realpathSync,
    statSync,
    utimesSync,
    writeFileSync,
} from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { appLabels } from '../../packages/tools/src/app.js'
import { TMP_DIR_MARKER_SUFFIX } from '../../packages/tools/src/testing/tmp-dir-marker.js'
import { makeTestTmpDir } from '../support/tmp-dir'

/**
 * Pins what the `sssb` CLI (packages/tools/bin/sssb.js, ADR-0014 P4) does, command by command, against tiny
 * workspaces built on disk, run as child processes exactly as a package script or a CI step runs them. The
 * commands that need a real framework or a browser (check-real-env, serve-standalone, e2e-profile) are elsewhere
 * or not here; these are the ones whose contract is a byte on stdout, a file on disk or an exit status.
 */
const SSSB = path.resolve(__dirname, '../../packages/tools/bin/sssb.js')

type Run = { status: number | null; stdout: string; stderr: string }

function sssb(cwd: string, args: string[], env: Record<string, string> = {}): Run {
    const result = spawnSync(process.execPath, [SSSB, ...args], {
        cwd,
        encoding: 'utf8',
        // GITHUB_OUTPUT is the CI runner's, never this test's.
        env: { ...process.env, GITHUB_OUTPUT: '', ...env },
    })
    return { status: result.status, stdout: result.stdout, stderr: result.stderr }
}

function write(file: string, text: string) {
    mkdirSync(path.dirname(file), { recursive: true })
    writeFileSync(file, text)
}

/** A workspace root with the given root package.json fields. */
function workspace(prefix: string, rootManifest: Record<string, unknown> = {}) {
    const root = realpathSync(makeTestTmpDir(`sssb-cli-${prefix}-`))
    write(path.join(root, 'pnpm-workspace.yaml'), "packages:\n  - 'apps/*'\n")
    write(path.join(root, 'package.json'), JSON.stringify({ name: 'ws', private: true, ...rootManifest }))
    return root
}

function app(root: string, dir: string, manifest: Record<string, unknown>) {
    const appDir = path.join(root, dir)
    write(path.join(appDir, 'package.json'), JSON.stringify(manifest))
    return appDir
}

const PORTS = { STARTER_PORT: '3123', SHOWCASE_PORT: '3124', LADLE_PORT: '61234' }

describe('sssb (the dispatcher)', () => {
    const root = workspace('dispatch')

    it('prints usage and exits 1 with no command', () => {
        const result = sssb(root, [])
        expect(result.status).toBe(1)
        expect(result.stdout).toContain('usage: sssb <command>')
        expect(result.stdout).toContain('check-real-env')
    })

    it('prints usage and exits 0 for --help', () => {
        const result = sssb(root, ['--help'])
        expect(result.status).toBe(0)
        expect(result.stdout).toContain('usage: sssb <command>')
    })

    it('names an unknown command and exits 1', () => {
        const result = sssb(root, ['frobnicate'])
        expect(result.status).toBe(1)
        expect(result.stderr).toContain('unknown command "frobnicate"')
    })

    it('does not treat an Object.prototype name as a command', () => {
        const result = sssb(root, ['constructor'])
        expect(result.status).toBe(1)
        expect(result.stderr).toContain('unknown command "constructor"')
    })
})

describe('sssb port', () => {
    const root = workspace('port')
    const starter = app(root, 'apps/starter', { name: 'starter', sssb: { port: 'starter' } })
    const bare = app(root, 'apps/bare', { name: 'bare' })

    it('prints the declared service’s port and a newline, and nothing else, even under FORCE_COLOR', () => {
        // Playwright injects FORCE_COLOR=1 into a webServer, and a coloured number breaks `$(sssb port)`.
        const result = sssb(starter, ['port'], { ...PORTS, FORCE_COLOR: '1' })
        expect(result.status).toBe(0)
        expect(result.stdout).toBe('3123\n')
        expect(result.stderr).toBe('')
    })

    it('prints a named service’s port', () => {
        const result = sssb(starter, ['port', 'ladle'], { ...PORTS, FORCE_COLOR: '1' })
        expect(result.stdout).toBe('61234\n')
    })

    it('acts on the app --app names', () => {
        expect(sssb(root, ['port', '--app', 'apps/starter'], PORTS).stdout).toBe('3123\n')
    })

    it('exits 1, showing how to declare one, for an app that declares no service and is given none', () => {
        const result = sssb(bare, ['port'], PORTS)
        expect(result.status).toBe(1)
        expect(result.stderr).toContain('"sssb": { "port"')
    })

    it('exits 1 for an unknown service', () => {
        const result = sssb(starter, ['port', 'nonesuch'], PORTS)
        expect(result.status).toBe(1)
        expect(result.stderr).toContain('unknown service "nonesuch"')
    })

    it('exits 1 for a declaration that names an unknown service', () => {
        const wrong = app(root, 'apps/wrong', { name: 'wrong', sssb: { port: 'nonesuch' } })
        const result = sssb(wrong, ['port'], PORTS)
        expect(result.status).toBe(1)
        expect(result.stderr).toContain('declares port service "nonesuch"')
    })

    it('exits 1 outside a package', () => {
        const result = sssb(path.join(root, 'apps'), ['port', 'ladle'], PORTS)
        expect(result.status).toBe(1)
        expect(result.stderr).toContain('is not a package')
    })
})

describe('sssb launch-json', () => {
    const launchJson = (root: string) => path.join(root, '.claude', 'launch.json')
    const read = (root: string) => JSON.parse(readFileSync(launchJson(root), 'utf8'))

    it('writes one <dir>-dev entry per app with a dev script AND a declared port, and skips the rest', () => {
        const root = workspace('launch')
        app(root, 'apps/web', { name: '@x/web', scripts: { dev: 'next dev' }, sssb: { port: 'showcase' } })
        app(root, 'apps/api', { name: '@x/api', scripts: { dev: 'node .' } }) // no port declaration
        app(root, 'apps/docs', { name: '@x/docs', sssb: { port: 'starter' } }) // no dev script

        const result = sssb(root, ['launch-json'], PORTS)

        expect(result.status).toBe(0)
        expect(read(root)).toEqual({
            version: '0.0.1',
            configurations: [
                { name: 'web-dev', runtimeExecutable: 'pnpm', runtimeArgs: ['--filter', '@x/web', 'dev'], port: 3124 },
            ],
        })
    })

    it('leaves the file untouched on a second run, so `prepare` does not churn mtimes', () => {
        const root = workspace('launch-idem')
        app(root, 'apps/web', { name: 'web', scripts: { dev: 'x' }, sssb: { port: 'showcase' } })
        sssb(root, ['launch-json'], PORTS)
        const past = new Date(Date.now() - 60_000)
        utimesSync(launchJson(root), past, past)
        const before = statSync(launchJson(root)).mtimeMs

        const again = sssb(root, ['launch-json'], PORTS)

        expect(again.status).toBe(0)
        expect(again.stdout).toBe('')
        expect(statSync(launchJson(root)).mtimeMs).toBe(before)
    })

    it('rewrites the file when the port moved', () => {
        const root = workspace('launch-moved')
        app(root, 'apps/web', { name: 'web', scripts: { dev: 'x' }, sssb: { port: 'showcase' } })
        sssb(root, ['launch-json'], PORTS)
        sssb(root, ['launch-json'], { ...PORTS, SHOWCASE_PORT: '3999' })
        expect(read(root).configurations[0].port).toBe(3999)
    })

    it('honours `sssb.apps` in the root package.json', () => {
        const root = workspace('launch-listed', { sssb: { apps: ['services/one'] } })
        app(root, 'services/one', { name: 'one', scripts: { dev: 'x' }, sssb: { port: 'starter' } })
        app(root, 'apps/ignored', { name: 'ignored', scripts: { dev: 'x' }, sssb: { port: 'starter' } })

        sssb(root, ['launch-json'], PORTS)

        expect(read(root).configurations.map((c: { name: string }) => c.name)).toEqual(['one-dev'])
    })

    it('errors when `sssb.apps` names something that is not a package', () => {
        const root = workspace('launch-bad', { sssb: { apps: ['services/missing'] } })
        const result = sssb(root, ['launch-json'], PORTS)
        expect(result.status).toBe(1)
        expect(result.stderr).toContain('names services/missing, which is not a package')
        expect(existsSync(launchJson(root))).toBe(false)
    })
})

describe('sssb guide', () => {
    const STAMP = /^<!-- sssb-guide sha256:[0-9a-f]{64} /

    /** A workspace whose one app installs a fake kit, with or without a guide. */
    function withKit(prefix: string, guide: string | undefined) {
        const root = workspace(prefix)
        const appDir = app(root, 'apps/a', { name: 'a' })
        const kit = path.join(appDir, 'node_modules', '@sssb', 'kit')
        write(
            path.join(kit, 'package.json'),
            JSON.stringify({
                name: '@sssb/kit',
                version: '1.2.3',
                type: 'module',
                exports: {
                    './package.json': './package.json',
                    ...(guide === undefined ? {} : { './guide.md': './guide.md' }),
                },
            }),
        )
        if (guide !== undefined) write(path.join(kit, 'guide.md'), guide)
        return { root, appDir, kit }
    }

    it('writes the guide under a hash stamp, and --check agrees until the kit’s guide changes', () => {
        const { root, appDir, kit } = withKit('guide', '# Rules\n\nKeep to the seam.\n')
        const target = path.join(root, '.claude', 'sssb-guide.md')

        const written = sssb(appDir, ['guide'])
        expect(written.status).toBe(0)
        const text = readFileSync(target, 'utf8')
        expect(text.split('\n')[0]).toMatch(STAMP)
        expect(text.split('\n')[0]).toContain('@sssb/kit 1.2.3')
        expect(text.endsWith('# Rules\n\nKeep to the seam.\n')).toBe(true)

        expect(sssb(appDir, ['guide', '--check']).status).toBe(0)

        writeFileSync(path.join(kit, 'guide.md'), '# Rules\n\nKeep to the seam, and more.\n')
        const stale = sssb(appDir, ['guide', '--check'])
        expect(stale.status).toBe(1)
        expect(stale.stderr).toContain('different guide')
    })

    it('compares the hash, not the bytes, so a reformatted copy still matches', () => {
        const { root, appDir } = withKit('guide-fmt', '# Rules\n')
        const target = path.join(root, '.claude', 'sssb-guide.md')
        sssb(appDir, ['guide'])
        appendFileSync(target, '\n\n\n')
        expect(sssb(appDir, ['guide', '--check']).status).toBe(0)
    })

    it('fails --check when there is no copy yet', () => {
        const { appDir } = withKit('guide-none', '# Rules\n')
        const result = sssb(appDir, ['guide', '--check'])
        expect(result.status).toBe(1)
        expect(result.stderr).toContain('missing or carries no stamp')
    })

    it('honours --out', () => {
        const { root, appDir } = withKit('guide-out', '# Rules\n')
        const out = path.join(root, 'elsewhere', 'guide-copy.md')
        expect(sssb(appDir, ['guide', '--out', out]).status).toBe(0)
        expect(readFileSync(out, 'utf8')).toMatch(STAMP)
        expect(existsSync(path.join(root, '.claude', 'sssb-guide.md'))).toBe(false)
        expect(sssb(appDir, ['guide', '--check', '--out', out]).status).toBe(0)
    })

    it('exits 1, pointing at P7, when the installed kit ships no guide', () => {
        const { appDir } = withKit('guide-absent', undefined)
        const result = sssb(appDir, ['guide'])
        expect(result.status).toBe(1)
        expect(result.stderr).toContain('P7')
    })
})

describe('sssb ci', () => {
    it('computes the e2e shard matrix, splitting only an app whose Playwright config declares `destructive`', () => {
        const root = workspace('ci')
        app(root, 'apps/alpha', { name: 'alpha' })
        write(
            path.join(root, 'apps/alpha/playwright.config.ts'),
            "export default { projects: [{ name: 'chromium' }, { name: 'destructive' }] }\n",
        )
        app(root, 'apps/beta', { name: 'beta' })
        write(
            path.join(root, 'apps/beta/playwright.config.ts'),
            "export default { projects: [{ name: 'chromium' }] }\n",
        )
        app(root, 'apps/gamma', { name: 'gamma' }) // no Playwright config: no shard

        const result = sssb(root, ['ci', 'e2e-shards'])

        expect(result.status).toBe(0)
        const line = result.stdout.split('\n').find((l) => l.startsWith('computed matrix: '))
        expect(line).toBeDefined()
        expect(JSON.parse(line!.slice('computed matrix: '.length))).toEqual([
            { name: 'alpha', app: 'apps/alpha', run: 'pnpm exec sssb ci e2e --app apps/alpha --project chromium' },
            {
                name: 'alpha-destructive',
                app: 'apps/alpha',
                run: 'pnpm exec sssb ci e2e --app apps/alpha --project destructive',
            },
            { name: 'beta', app: 'apps/beta', run: 'pnpm exec sssb ci e2e --app apps/beta' },
        ])
    })

    it('appends `matrix=<json>` to $GITHUB_OUTPUT when it is set', () => {
        const root = workspace('ci-output')
        app(root, 'apps/alpha', { name: 'alpha' })
        write(path.join(root, 'apps/alpha/playwright.config.ts'), 'export default {}\n')
        const output = path.join(root, 'github-output')
        writeFileSync(output, 'earlier=1\n')

        const result = sssb(root, ['ci', 'e2e-shards'], { GITHUB_OUTPUT: output })

        expect(result.status).toBe(0)
        const matrix = JSON.stringify([
            { name: 'alpha', app: 'apps/alpha', run: 'pnpm exec sssb ci e2e --app apps/alpha' },
        ])
        expect(readFileSync(output, 'utf8')).toBe(`earlier=1\nmatrix=${matrix}\n`)
    })

    it('exits 1 for an unknown job', () => {
        const result = sssb(workspace('ci-unknown'), ['ci', 'deploy'])
        expect(result.status).toBe(1)
        expect(result.stderr).toContain('usage: sssb ci')
    })
})

describe('sssb check-tmpdir-leak', () => {
    const cwd = workspace('leak')
    const node = (script: string) => ['check-tmpdir-leak', process.execPath, '-e', script]
    const PRINT_TMP = "console.log('TMP=' + process.env.TMPDIR)"
    const tmpOf = (run: Run) => /^TMP=(.+)$/m.exec(run.stdout)![1]!

    it('passes a clean run and removes the private run directory', () => {
        const result = sssb(cwd, node(PRINT_TMP))
        expect(result.status).toBe(0)
        expect(result.stdout).toContain('0 unremoved test temp dir(s)')
        expect(existsSync(tmpOf(result))).toBe(false)
    })

    it('fails a run that leaves a marker behind, names it, and still removes the run directory', () => {
        const script = `${PRINT_TMP}; require('fs').writeFileSync(process.env.TMPDIR + '/leaked-dir${TMP_DIR_MARKER_SUFFIX}', '')`
        const result = sssb(cwd, node(script))
        expect(result.status).toBe(1)
        expect(result.stderr).toContain(`leaked-dir${TMP_DIR_MARKER_SUFFIX}`)
        expect(existsSync(tmpOf(result))).toBe(false)
    })

    it('ignores a leftover that carries no marker', () => {
        const script = `require('fs').writeFileSync(process.env.TMPDIR + '/unmarked', '')`
        expect(sssb(cwd, node(script)).status).toBe(0)
    })

    it('passes a failing child’s status through, without a leak verdict, and cleans up', () => {
        const result = sssb(cwd, node(`${PRINT_TMP}; process.exit(7)`))
        expect(result.status).toBe(7)
        expect(existsSync(tmpOf(result))).toBe(false)
    })

    it('exits 1 for a command that cannot be run', () => {
        const result = sssb(cwd, ['check-tmpdir-leak', 'sssb-no-such-command-anywhere'])
        expect(result.status).toBe(1)
        expect(result.stderr).toContain('could not run')
    })

    it('needs a command', () => {
        const result = sssb(cwd, ['check-tmpdir-leak'])
        expect(result.status).toBe(1)
        expect(result.stderr).toContain('usage: sssb check-tmpdir-leak')
    })
})

describe('appLabels', () => {
    it('names each app by its directory, the path with dashes when two share a name, and `.` by the root', () => {
        const root = path.join('/ws', 'my-repo')
        expect([...appLabels(root, ['apps/showcase', 'apps/starter'])]).toEqual([
            ['apps/showcase', 'showcase'],
            ['apps/starter', 'starter'],
        ])
        expect([...appLabels(root, ['apps/web', 'services/web', 'apps/api'])]).toEqual([
            ['apps/web', 'apps-web'],
            ['services/web', 'services-web'],
            ['apps/api', 'api'],
        ])
        expect([...appLabels(root, ['.'])]).toEqual([['.', 'my-repo']])
    })

    it('keeps every label unique when two spellings of a path meet', () => {
        const root = path.join('/ws', 'my-repo')
        for (const apps of [
            ['services/web', 'other/web', 'services-web'],
            ['a/x/web', 'a-x/web'],
            ['apps/web', './apps/web'],
        ]) {
            const labels = appLabels(root, apps)
            expect(new Set(labels.values()).size).toBe(apps.length)
        }
        expect([...appLabels(root, ['services/web', 'other/web', 'services-web']).values()]).toEqual([
            'services-web',
            'other-web',
            'services-web-2',
        ])
        expect([...appLabels(root, ['a/x/web', 'a-x/web']).values()]).toEqual(['a-x-web', 'a-x-web-2'])
        expect([...appLabels(root, ['apps/web', './apps/web']).values()]).toEqual(['apps-web', 'apps-web-2'])
    })

    it('keeps `ci e2e-shards` names unique when an app labelled `x-destructive` sits beside a splitting app `x`', () => {
        const root = workspace('labels-destructive', { sssb: { apps: ['apps/x', 'apps/x-destructive'] } })
        app(root, 'apps/x', { name: 'x' })
        write(
            path.join(root, 'apps/x/playwright.config.ts'),
            "export default { projects: [{ name: 'chromium' }, { name: 'destructive' }] }\n",
        )
        app(root, 'apps/x-destructive', { name: 'x-destructive' })
        write(path.join(root, 'apps/x-destructive/playwright.config.ts'), 'export default {}\n')
        const result = sssb(root, ['ci', 'e2e-shards'])
        expect(result.status).toBe(0)
        const line = result.stdout.split('\n').find((l) => l.startsWith('computed matrix: '))!
        const names = JSON.parse(line.slice('computed matrix: '.length)).map((shard: { name: string }) => shard.name)
        expect(names).toHaveLength(3)
        expect(new Set(names).size).toBe(3)
        expect(names).toEqual(['x', 'x-destructive', 'x-destructive-2'])
    })

    it('gives `ci e2e-shards` unique names for two apps that share a basename', () => {
        const root = workspace('labels', { sssb: { apps: ['apps/web', 'services/web'] } })
        for (const dir of ['apps/web', 'services/web']) {
            app(root, dir, { name: dir.replace('/', '-') })
            write(path.join(root, dir, 'playwright.config.ts'), 'export default {}\n')
        }
        const result = sssb(root, ['ci', 'e2e-shards'])
        expect(result.status).toBe(0)
        const line = result.stdout.split('\n').find((l) => l.startsWith('computed matrix: '))!
        const names = JSON.parse(line.slice('computed matrix: '.length)).map((shard: { name: string }) => shard.name)
        expect(names).toEqual(['apps-web', 'services-web'])
    })
})

describe('sssb tick and dev-tick with --app', () => {
    it('`tick --app <dir>` takes the slot from the app’s declared port, so it gets as far as reaching for the server', () => {
        const root = workspace('tick-app')
        const dir = app(root, 'apps/web', { name: 'web', sssb: { port: 'starter' } })

        const result = sssb(root, ['tick', '--app', dir, '--url', 'http://127.0.0.1:1', '--timeout', '2'])

        expect(result.stderr).toContain('tick: request to http://127.0.0.1:1')
        expect(result.status).toBe(1)
    })

    it('`tick <slot> --url …` from a directory with no package.json gets past argument parsing', () => {
        const scratch = realpathSync(makeTestTmpDir('sssb-cli-tick-bare-'))

        const result = sssb(scratch, ['tick', 'showcase', '--url', 'http://127.0.0.1:1', '--timeout', '2'])

        expect(result.stderr).toContain('tick: request to http://127.0.0.1:1')
        expect(result.stderr).not.toContain('is not a package')
        expect(result.status).toBe(1)
    })

    it('`dev-tick --app <dir> -- <cmd>` runs the command in the app’s directory and returns its status', () => {
        const root = workspace('devtick-app')
        const dir = app(root, 'apps/web', { name: 'web', sssb: { port: 'starter' } })

        const result = sssb(root, [
            'dev-tick',
            '--app',
            dir,
            '--',
            process.execPath,
            '-e',
            'console.log(process.cwd()); process.exit(3)',
        ])

        expect(result.status).toBe(3)
        expect(result.stdout.split('\n').map((l) => l.trim())).toContain(realpathSync(dir))
    })
})
