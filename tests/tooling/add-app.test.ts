import { spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'
import { rebaseSpec } from '../../packages/create/src/add-app.js'
import { generate } from '../../packages/create/src/generate.js'
import { buildTemplate } from '../../packages/create/src/template.js'
import { newPortSlot } from '../../packages/tools/src/commands/add-app.js'
import { makeTestTmpDir } from '../support/tmp-dir'

/**
 * `sssb add-app <slug>` (@sssb/tools' packages/tools/src/commands/add-app.js), writing a second app into a workspace
 * the generator wrote, from an @sssb/create laid out as a packed one is (its bin, src and package.json, and the
 * template its prepack builds, here from THIS repository's live tree). Run as a child process, as a person runs it.
 * That the app it writes installs and passes the workspace's gates is pack and consume's pages shape (its ledger).
 */
const REPO = path.resolve(__dirname, '../..')
const SSSB = path.join(REPO, 'packages/tools/bin/sssb.js')
/** Each test writes a workspace or two and runs the CLI several times: seconds alone, longer on a loaded machine. */
const SLOW = 120_000
const VERSION: string = JSON.parse(readFileSync(path.join(REPO, 'packages/tools/package.json'), 'utf8')).version

const read = (root: string, file: string) => readFileSync(path.join(root, file), 'utf8')
const readJson = (root: string, file: string) => JSON.parse(read(root, file))

function sssb(cwd: string, args: string[]) {
    const result = spawnSync(process.execPath, [SSSB, ...args], { cwd, encoding: 'utf8' })
    return { status: result.status, stdout: result.stdout, stderr: result.stderr }
}

/** What `prettier --check .` says in a workspace, under its own config: '' when it is clean. */
function prettierCheck(root: string) {
    const result = spawnSync(path.join(REPO, 'node_modules/.bin/prettier'), ['--check', '--log-level', 'warn', '.'], {
        cwd: root,
        encoding: 'utf8',
    })
    return `${result.stdout}${result.stderr}${result.status === 0 ? '' : `exit ${result.status}`}`
}

/** An @sssb/create as `pnpm pack` lays it out: its package.json, bin/, src/ and template/. */
let packedCreate = ''
let template = ''

/** A fresh workspace the generator wrote, its one app `console`, with the packed @sssb/create installed at its root. */
function workspace(prefix: string, { install = true } = {}) {
    const ws = path.join(makeTestTmpDir(prefix), 'ws')
    generate({ templateDir: template, target: ws, slug: 'console', name: 'Console' })
    if (install) cpSync(packedCreate, path.join(ws, 'node_modules/@sssb/create'), { recursive: true })
    return ws
}

beforeAll(() => {
    packedCreate = path.join(makeTestTmpDir('add-app-create-'), 'create')
    for (const part of ['package.json', 'bin', 'src'])
        cpSync(path.join(REPO, 'packages/create', part), path.join(packedCreate, part), { recursive: true })
    template = path.join(packedCreate, 'template')
    buildTemplate({ repoRoot: REPO, outDir: template })
}, SLOW)

describe('sssb add-app', () => {
    it(
        'writes the starter as apps/<slug>, renamed, on a port slot of its own, and names it in sssb.apps',
        () => {
            const ws = workspace('add-app-ok-')
            const result = sssb(ws, ['add-app', 'ledger', '--name', 'Ledger Books'])
            expect(result.stderr).toBe('')
            expect(result.status).toBe(0)

            expect(readJson(ws, 'package.json').sssb.apps).toEqual(['apps/console', 'apps/ledger'])
            const manifest = readJson(ws, 'apps/ledger/package.json')
            expect(manifest.name).toBe('ledger')
            expect(manifest.description).toBe('Ledger Books: the app.')
            expect(manifest.sssb).toEqual({ port: { name: 'ledger', default: 3700 } })
            // Its scripts and Playwright config read its own slot, never the starter's (which the console holds).
            expect(manifest.scripts.dev).toContain('sssb dev-tick -- next dev')
            expect(manifest.scripts.tick).toBe('sssb tick')
            for (const text of Object.values(manifest.scripts)) expect(text).not.toMatch(/\bstarter\b/)
            const playwright = read(ws, 'apps/ledger/playwright.config.ts')
            expect(playwright).toContain("import { originForApp } from '@sssb/tools/ports'")
            expect(playwright).toContain('const BASE_URL = originForApp(__dirname)')
            expect(playwright).not.toContain("'starter'")
            // The console keeps its own.
            expect(readJson(ws, 'apps/console/package.json').sssb).toEqual({ port: 'starter' })

            // The generator's renames, the app's identity, as they are in a generated app.
            expect(read(ws, 'apps/ledger/config/app.ts')).toMatch(/export const APP_SLUG = 'ledger'\n/)
            expect(read(ws, 'apps/ledger/config/app.ts')).toContain('`ledger_session`')
            expect(readJson(ws, 'apps/ledger/messages/en.json').welcome.appName).toBe('Ledger Books')
            expect(readJson(ws, 'apps/ledger/infra/package.json').name).toBe('ledger-infra')
            expect(readJson(ws, 'apps/ledger/src/app-config/package.json').name).toBe('ledger-app-config')
            expect(manifest.dependencies['@sssb/app-config']).toBe('workspace:ledger-app-config@*')

            // Each @sssb package as the console takes it, in the app's manifest and its infra's.
            const first = readJson(ws, 'apps/console/package.json')
            for (const field of ['dependencies', 'devDependencies'])
                for (const [name, spec] of Object.entries(first[field] as Record<string, string>))
                    if (name.startsWith('@sssb/') && name !== '@sssb/app-config')
                        expect(manifest[field][name]).toBe(spec)
            expect(readJson(ws, 'apps/ledger/infra/package.json').dependencies).toEqual(
                readJson(ws, 'apps/console/infra/package.json').dependencies,
            )

            // Every file the generator writes into an app, and nothing else; the same files the console has.
            const files = (app: string) =>
                spawnSync('find', ['.', '-type', 'f'], { cwd: path.join(ws, 'apps', app), encoding: 'utf8' })
                    .stdout.split('\n')
                    .filter(Boolean)
                    .sort()
            expect(files('ledger')).toEqual(files('console'))
            expect(readdirSync(path.join(ws, 'apps')).sort()).toEqual(['console', 'ledger'])
            expect(prettierCheck(ws)).toBe('')

            // What it says is left: the root scripts and the CI synth name the console alone, by design.
            expect(result.stdout).toContain('Added Ledger Books in apps/ledger/')
            expect(result.stdout).toContain(
                'Its port slot is "ledger": port 3700 in a main checkout, LEDGER_PORT overrides it.',
            )
            expect(result.stdout).toMatch(/the root's dev, tick, start script\(s\) run console alone/)
            expect(result.stdout).toContain('.github/workflows/checks.yml synthesizes ./apps/console/infra alone')
            expect(result.stdout).toContain('pnpm exec sssb doctor')
        },
        SLOW,
    )

    it(
        'takes the next free default port, and a slot and port of the caller’s choosing',
        () => {
            const ws = workspace('add-app-ports-')
            expect(sssb(ws, ['add-app', 'ledger']).status).toBe(0)
            const taken = sssb(ws, ['add-app', 'audit', '--port', '3700'])
            expect(taken.stderr).toMatch(/apps\/ledger binds port 3700 in a main checkout already/)
            expect(sssb(ws, ['add-app', 'audit']).status).toBe(0)
            expect(readJson(ws, 'apps/audit/package.json').sssb.port).toEqual({ name: 'audit', default: 3800 })
            expect(readJson(ws, 'apps/audit/messages/en.json').welcome.appName).toBe('Audit')
            expect(sssb(ws, ['add-app', 'reports', '--slot', 'books', '--port', '4321']).status).toBe(0)
            expect(readJson(ws, 'apps/reports/package.json').sssb.port).toEqual({ name: 'books', default: 4321 })
            expect(readJson(ws, 'package.json').sssb.apps).toEqual([
                'apps/console',
                'apps/ledger',
                'apps/audit',
                'apps/reports',
            ])
        },
        SLOW,
    )

    it(
        'refuses what would collide with the workspace, and writes nothing then',
        () => {
            const ws = workspace('add-app-refuse-')
            const before = read(ws, 'package.json')
            const refused = (args: string[], message: RegExp) => {
                const result = sssb(ws, ['add-app', ...args])
                expect(result.status).toBe(1)
                expect(result.stderr).toMatch(message)
                expect(read(ws, 'package.json')).toBe(before)
                expect(readdirSync(path.join(ws, 'apps'))).toEqual(['console'])
            }
            refused(['console'], /already has a package named console/)
            refused(['ledger', '--slot', 'starter'], /apps\/console already declares the port slot "starter"/)
            refused(['ledger', '--port', '3100'], /default 3100 is the default of the built-in "starter"/)
            refused(['ledger', '--port', '3000'], /default 3000 is the default of the built-in "showcase"/)
            refused(['showcase'], /SHOWCASE_PORT, the variable of the built-in service "showcase".*--slot/)
            refused(['Ledger'], /"Ledger" is not a valid slug/)
            refused(['select'], /a word Aurora PostgreSQL reserves/)
            refused([], /name the app/)
            refused(['ledger', 'extra'], /unexpected extra/)
            mkdirSync(path.join(ws, 'apps/ledger'))
            const taken = sssb(ws, ['add-app', 'ledger'])
            expect(taken.stderr).toMatch(/apps\/ledger already exists/)
        },
        SLOW,
    )

    it(
        'finds @sssb/create at the workspace root, at its own version, holding its template, or says how to get it',
        () => {
            const ws = workspace('add-app-create-', { install: false })
            const missing = sssb(ws, ['add-app', 'ledger'])
            expect(missing.status).toBe(1)
            expect(missing.stderr).toContain(`pnpm add -D -w @sssb/create@${VERSION}`)

            const other = path.join(makeTestTmpDir('add-app-other-'), 'create')
            cpSync(packedCreate, other, { recursive: true })
            const manifest = JSON.parse(readFileSync(path.join(other, 'package.json'), 'utf8'))
            writeFileSync(path.join(other, 'package.json'), JSON.stringify({ ...manifest, version: '9.9.9' }))
            expect(sssb(ws, ['add-app', 'ledger', '--create', other]).stderr).toMatch(
                new RegExp(`@sssb/create 9\\.9\\.9 .* this @sssb/tools is ${VERSION.replaceAll('.', '\\.')}`),
            )
            // A checkout's @sssb/create, which carries no template until it is packed.
            expect(sssb(ws, ['add-app', 'ledger', '--create', path.join(REPO, 'packages/create')]).stderr).toMatch(
                /holds no packed template/,
            )
            expect(sssb(ws, ['add-app', 'ledger', '--create', path.join(REPO, 'packages/tools')]).stderr).toMatch(
                /holds @sssb\/tools, not @sssb\/create/,
            )
            // Named by --create, it need not be installed.
            expect(sssb(ws, ['add-app', 'ledger', '--create', packedCreate]).status).toBe(0)
            expect(existsSync(path.join(ws, 'apps/ledger/package.json'))).toBe(true)
        },
        SLOW,
    )

    it(
        'leaves nothing behind when the template cannot be written part-way',
        () => {
            const ws = workspace('add-app-undo-')
            const broken = path.join(makeTestTmpDir('add-app-broken-'), 'create')
            cpSync(packedCreate, broken, { recursive: true })
            // The rename of the display name finds nothing to rename: writeApp throws after the copy.
            writeFileSync(path.join(broken, 'template/app/src/app/[locale]/layout.tsx'), 'export {}\n')
            const result = sssb(ws, ['add-app', 'ledger', '--create', broken])
            expect(result.status).toBe(1)
            expect(result.stderr).toMatch(/layout\.tsx: expected .* once, found 0/)
            expect(readdirSync(path.join(ws, 'apps'))).toEqual(['console'])
            expect(readJson(ws, 'package.json').sssb.apps).toEqual(['apps/console'])
        },
        SLOW,
    )

    it(
        'adds to a workspace that keeps no sssb.apps, whose apps/* is the list',
        () => {
            const ws = workspace('add-app-noapps-')
            const manifest = readJson(ws, 'package.json')
            delete manifest.sssb
            writeFileSync(path.join(ws, 'package.json'), `${JSON.stringify(manifest, null, 4)}\n`)
            const result = sssb(ws, ['add-app', 'ledger'])
            expect(result.status).toBe(0)
            expect(readJson(ws, 'package.json').sssb).toBeUndefined()
            expect(result.stdout).not.toContain('sssb.apps names it')
        },
        SLOW,
    )
})

describe('rebaseSpec', () => {
    it('rebases a relative file: or link: path to the new manifest, and leaves anything else as it is', () => {
        const root = '/ws'
        expect(rebaseSpec('file:../../tarballs/kit.tgz', `${root}/apps/console`, `${root}/apps/ledger/infra`)).toBe(
            'file:../../../tarballs/kit.tgz',
        )
        expect(rebaseSpec('link:../shared', `${root}/apps/console`, `${root}/apps/ledger`)).toBe('link:../shared')
        expect(rebaseSpec('file:vendor/kit.tgz', `${root}/apps/console`, `${root}/apps/ledger`)).toBe(
            'file:../console/vendor/kit.tgz',
        )
        for (const spec of ['^0.2.0', 'file:/abs/kit.tgz', 'https://example.test/kit.tgz', 'workspace:*'])
            expect(rebaseSpec(spec, `${root}/apps/console`, `${root}/apps/ledger`)).toBe(spec)
    })
})

describe('newPortSlot', () => {
    it('skips a default another app binds and one SSSB keeps, and names the slot after the slug', () => {
        const root = makeTestTmpDir('add-app-slot-')
        const app = (dir: string, port: unknown) => {
            mkdirSync(path.join(root, dir), { recursive: true })
            writeFileSync(path.join(root, dir, 'package.json'), JSON.stringify({ sssb: { port } }))
            return path.join(root, dir)
        }
        const apps = [app('apps/a', 'starter'), app('apps/b', { name: 'b', default: 3700 })]
        expect(newPortSlot({ root, apps, slug: 'ledger' })).toEqual({ name: 'ledger', default: 3800 })
        expect(() => newPortSlot({ root, apps, slug: 'b' })).toThrow(/apps\/b already declares the port slot "b"/)
        expect(() => newPortSlot({ root, apps, slug: 'ledger', port: '3700' })).toThrow(/apps\/b binds port 3700/)
        expect(() => newPortSlot({ root, apps, slug: 'ledger', port: '3300' })).toThrow(/derived worktree ports/)
        expect(() => newPortSlot({ root, apps, slug: 'a'.repeat(40) })).toThrow(/at most 32 characters.*--slot/)
    })
})
