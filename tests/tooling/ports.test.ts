import { spawnSync } from 'node:child_process'
import { mkdirSync, realpathSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { originForApp, parsePortDeclaration, portForRoot, readPortDeclaration } from '@sssb/tools/ports'
import { makeTestTmpDir } from '../support/tmp-dir'

/**
 * Every dev server and every e2e run in this repo now gets its port from this function, so its two
 * branches are load-bearing: the main checkout must keep the ports the docs promise, and a linked
 * worktree must get its own so two agent sessions cannot silently drive each other's app
 * (docs/build-notes.md records that failure three times).
 */
const MAIN = path.join('/repos', 'sssb')
const WORKTREE = path.join('/repos', 'sssb', '.claude', 'worktrees', 'feature-abc123')
const OTHER_WORKTREE = path.join('/repos', 'sssb', '.claude', 'worktrees', 'other-def456')

describe('portForRoot', () => {
    it('keeps the documented defaults on the main checkout, so the runbooks stay true', () => {
        expect(portForRoot(MAIN, 'showcase', {})).toBe(3000)
        expect(portForRoot(MAIN, 'starter', {})).toBe(3100)
        expect(portForRoot(MAIN, 'ladle', {})).toBe(61000)
        expect(portForRoot(MAIN, 'contractPg', {})).toBe(5439)
    })

    it('moves a linked worktree off the defaults entirely', () => {
        for (const service of ['showcase', 'starter', 'ladle', 'contractPg'] as const) {
            expect(portForRoot(WORKTREE, service, {})).not.toBe(portForRoot(MAIN, service, {}))
        }
    })

    it('is deterministic — the same checkout always gets the same port', () => {
        // Load-bearing: showcase's `test:e2e` is TWO playwright invocations, and the package script
        // that starts the server computes the port separately from the config that points at it.
        // If this were a scan or a random pick, those could disagree and the suite would hang.
        expect(portForRoot(WORKTREE, 'showcase', {})).toBe(portForRoot(WORKTREE, 'showcase', {}))
    })

    it('gives different worktrees different ports', () => {
        expect(portForRoot(WORKTREE, 'showcase', {})).not.toBe(portForRoot(OTHER_WORKTREE, 'showcase', {}))
    })

    it("pairs each worktree's two apps adjacently, so one session's pair cannot straddle another's", () => {
        expect(portForRoot(WORKTREE, 'starter', {})).toBe(portForRoot(WORKTREE, 'showcase', {}) + 1)
        expect(portForRoot(OTHER_WORKTREE, 'starter', {})).toBe(portForRoot(OTHER_WORKTREE, 'showcase', {}) + 1)
    })

    it('keeps derived app ports inside the reserved band, clear of the defaults', () => {
        for (const root of [WORKTREE, OTHER_WORKTREE]) {
            const showcase = portForRoot(root, 'showcase', {})
            expect(showcase).toBeGreaterThanOrEqual(3200)
            expect(showcase).toBeLessThan(3600)
        }
    })

    it('lets an explicit env var win, which is the one-off isolated-run escape hatch', () => {
        expect(portForRoot(MAIN, 'showcase', { SHOWCASE_PORT: '3210' })).toBe(3210)
        expect(portForRoot(WORKTREE, 'showcase', { SHOWCASE_PORT: '3210' })).toBe(3210)
    })

    it('rejects a malformed override rather than silently falling back', () => {
        // A silent fallback here would start the server on a different port than the suite targets —
        // precisely the confusing failure this module exists to prevent.
        expect(() => portForRoot(MAIN, 'showcase', { SHOWCASE_PORT: 'nope' })).toThrow(/must be a port number/)
        expect(() => portForRoot(MAIN, 'showcase', { SHOWCASE_PORT: '70000' })).toThrow(/must be a port number/)
    })

    it('rejects an unknown service name', () => {
        // @ts-expect-error -- deliberately outside the known set
        expect(() => portForRoot(MAIN, 'nope', {})).toThrow(/unknown service/)
    })
})

describe('portFor with no workspace file', () => {
    it('falls back to the nearest .git, then the start directory, instead of throwing', () => {
        const scratch = realpathSync(makeTestTmpDir('sssb-ports-nows-'))
        const PORTS_JS = path.resolve(__dirname, '../../packages/tools/src/ports.js')
        const script = `import {portFor} from ${JSON.stringify(PORTS_JS)}; console.log(portFor('starter'))`
        const env = { ...process.env }
        delete env['STARTER_PORT']
        const printed = (cwd: string) =>
            spawnSync(process.execPath, ['--input-type=module', '-e', script], { cwd, env, encoding: 'utf8' })

        const bare = printed(scratch)
        expect(bare.stderr).toBe('')
        expect(bare.stdout.trim()).toBe('3100')

        mkdirSync(path.join(scratch, 'repo', '.git'), { recursive: true })
        mkdirSync(path.join(scratch, 'repo', 'sub'), { recursive: true })
        const nested = printed(path.join(scratch, 'repo', 'sub'))
        expect(nested.stderr).toBe('')
        expect(nested.stdout.trim()).toBe('3100')
    })
})

/**
 * A slot an app names for itself (future task port-slots-for-adopter-apps): a workspace with two apps of its own, both
 * made from the starter, would otherwise share the `starter` slot and so one port. The pin the task names: two apps on
 * distinct custom slots get distinct ports in a main checkout and in a worktree, and the built-in string form is as
 * it always was (the tests above, unchanged).
 */
describe('a port slot an app declares for itself', () => {
    const LEDGER = { name: 'ledger', default: 3700 }
    const PORTAL = { name: 'portal', default: 3710 }
    const BUILT_IN = ['showcase', 'starter', 'ladle', 'contractPg'] as const

    it('is the declared default on a main checkout, the documented behaviour of every built-in', () => {
        expect(portForRoot(MAIN, LEDGER, {})).toBe(3700)
        expect(portForRoot(MAIN, PORTAL, {})).toBe(3710)
    })

    it('gives two apps on distinct slots distinct ports in a main checkout and in a worktree', () => {
        for (const root of [MAIN, WORKTREE, OTHER_WORKTREE]) {
            expect(portForRoot(root, LEDGER, {}), root).not.toBe(portForRoot(root, PORTAL, {}))
        }
    })

    it('keys a derived port on the slot name as well as the checkout, so two slots of one worktree differ', () => {
        // The failure the name prevents: two custom slots on one hash of the path would be one port in every worktree.
        // Many names in one worktree: all different (a collision is 1 in 10000 per pair, so 40 names are safe).
        const ports = Array.from({ length: 40 }, (_, n) =>
            portForRoot(WORKTREE, { name: `app${n}`, default: 3700 + n }, {}),
        )
        expect(new Set(ports).size).toBe(ports.length)
    })

    it('moves a linked worktree off the declared default, deterministically, and differently per worktree', () => {
        const derived = portForRoot(WORKTREE, LEDGER, {})
        expect(derived).not.toBe(3700)
        expect(portForRoot(WORKTREE, LEDGER, {})).toBe(derived)
        expect(portForRoot(OTHER_WORKTREE, LEDGER, {})).not.toBe(derived)
    })

    it('derives from a band no built-in default or derived port can land in', () => {
        const builtIn = new Set<number>()
        for (const root of [WORKTREE, OTHER_WORKTREE, '/repos/a/.claude/worktrees/x', '/repos/b/.claude/worktrees/y']) {
            for (const service of BUILT_IN) builtIn.add(portForRoot(root, service, {}))
        }
        for (const service of BUILT_IN) builtIn.add(portForRoot(MAIN, service, {}))
        for (let n = 0; n < 200; n++) {
            const root = path.join('/repos', 'sssb', '.claude', 'worktrees', `wt-${n}`)
            const port = portForRoot(root, LEDGER, {})
            expect(port).toBeGreaterThanOrEqual(20000)
            expect(port).toBeLessThan(30000)
            expect(builtIn.has(port)).toBe(false)
        }
    })

    it('reads its own variable, <NAME>_PORT with - as _, and nothing else overrides it', () => {
        expect(portForRoot(MAIN, LEDGER, { LEDGER_PORT: '3999' })).toBe(3999)
        expect(portForRoot(WORKTREE, LEDGER, { LEDGER_PORT: '3999' })).toBe(3999)
        expect(portForRoot(MAIN, { name: 'back-office', default: 3720 }, { BACK_OFFICE_PORT: '3998' })).toBe(3998)
        // A built-in's variable never reaches a custom slot, nor a custom slot's a built-in.
        expect(portForRoot(MAIN, LEDGER, { STARTER_PORT: '3999', SHOWCASE_PORT: '3999' })).toBe(3700)
        expect(portForRoot(MAIN, 'starter', { LEDGER_PORT: '3999' })).toBe(3100)
        expect(() => portForRoot(MAIN, LEDGER, { LEDGER_PORT: 'nope' })).toThrow(/LEDGER_PORT must be a port number/)
    })

    it('rejects a slot that is not well formed, naming the problem', () => {
        const bad: [unknown, RegExp][] = [
            [{ name: 'Ledger', default: 3700 }, /name is lowercase words joined by "-"/],
            [{ name: 'my_app', default: 3700 }, /name is lowercase words joined by "-"/],
            [{ name: '', default: 3700 }, /name is lowercase words joined by "-"/],
            [{ name: 'x'.repeat(33), default: 3700 }, /at most 32 characters/],
            [{ default: 3700 }, /name is lowercase words/],
            [{ name: 'ledger' }, /"default" must be an integer from 1024 to 49151/],
            [{ name: 'ledger', default: '3700' }, /"default" must be an integer/],
            [{ name: 'ledger', default: 3700.5 }, /"default" must be an integer/],
            [{ name: 'ledger', default: 80 }, /"default" must be an integer from 1024 to 49151/],
            [{ name: 'ledger', default: 55000 }, /"default" must be an integer from 1024 to 49151/],
            [{ name: 'ledger', default: 3700, env: 'X' }, /only "name" and "default", not env/],
            [['ledger'], /a port declaration is a service name or/],
            [3700, /a port declaration is a service name or/],
            [null, /a port declaration is a service name or/],
        ]
        for (const [slot, message] of bad) {
            expect(() => parsePortDeclaration(slot), JSON.stringify(slot)).toThrow(message)
            expect(() => portForRoot(MAIN, slot as never, {}), JSON.stringify(slot)).toThrow(message)
        }
    })

    it('rejects a name or default that belongs to a built-in service', () => {
        // The name would read the built-in's variable ("starter" is STARTER_PORT, "contract-pg" CONTRACT_PG_PORT).
        for (const name of ['starter', 'showcase', 'ladle', 'contract-pg']) {
            expect(() => parsePortDeclaration({ name, default: 3700 }), name).toThrow(
                /variable of the built-in service/,
            )
        }
        // The default would sit on a built-in's default or inside a derived band.
        for (const port of [3000, 3100, 3200, 3599, 5439, 5440, 5639, 20000, 29999]) {
            expect(() => parsePortDeclaration({ name: 'ledger', default: port }), String(port)).toThrow(
                /default \d+ is (the default of|inside the derived worktree ports of)/,
            )
        }
        for (const port of [3199, 3600, 5438, 5640, 19999, 30000, 3700]) {
            expect(parsePortDeclaration({ name: 'ledger', default: port }), String(port)).toEqual({
                name: 'ledger',
                default: port,
            })
        }
    })

    it('still takes a built-in service by name, and still refuses any other string', () => {
        for (const service of BUILT_IN) expect(parsePortDeclaration(service)).toBe(service)
        expect(() => parsePortDeclaration('ledger')).toThrow(/unknown service "ledger" \(known: showcase, starter,/)
    })
})

describe('the declaration an app makes in its package.json', () => {
    function appWith(sssb: unknown) {
        const dir = realpathSync(makeTestTmpDir('sssb-ports-decl-'))
        writeFileSync(
            path.join(dir, 'package.json'),
            JSON.stringify({ name: 'x', ...(sssb === undefined ? {} : { sssb }) }),
        )
        return dir
    }

    it('reads the string form and the slot form, and none as undefined', () => {
        expect(readPortDeclaration(appWith({ port: 'starter' }))).toBe('starter')
        expect(readPortDeclaration(appWith({ port: { name: 'ledger', default: 3700 } }))).toEqual({
            name: 'ledger',
            default: 3700,
        })
        expect(readPortDeclaration(appWith({}))).toBeUndefined()
        expect(readPortDeclaration(appWith(undefined))).toBeUndefined()
    })

    it('names the file when the declaration or the file is wrong', () => {
        const dir = appWith({ port: { name: 'Ledger', default: 3700 } })
        expect(() => readPortDeclaration(dir)).toThrow(new RegExp(`${dir}/package.json: a port slot's name`))
        expect(() => readPortDeclaration(path.join(dir, 'nowhere'))).toThrow(/cannot read .*nowhere\/package.json/)
    })

    it('is what portFor() and originFor() use with no argument, from the app’s directory, in a main checkout and a worktree', () => {
        // Playwright runs from the app, so `originFor()` there is the app's own origin. Run as a child process: the
        // working directory is the argument.
        const PORTS_JS = path.resolve(__dirname, '../../packages/tools/src/ports.js')
        const script = `import {portFor, originFor} from ${JSON.stringify(PORTS_JS)}; console.log(portFor(), originFor())`
        const env = { ...process.env }
        for (const key of Object.keys(env)) if (key.endsWith('_PORT')) delete env[key]
        const printed = (cwd: string, extra: Record<string, string> = {}) =>
            spawnSync(process.execPath, ['--input-type=module', '-e', script], {
                cwd,
                env: { ...env, ...extra },
                encoding: 'utf8',
            })

        const main = realpathSync(makeTestTmpDir('sssb-ports-noarg-'))
        mkdirSync(path.join(main, 'apps', 'ledger'), { recursive: true })
        writeFileSync(path.join(main, 'pnpm-workspace.yaml'), 'packages:\n  - apps/*\n')
        writeFileSync(
            path.join(main, 'apps', 'ledger', 'package.json'),
            JSON.stringify({ name: 'ledger', sssb: { port: { name: 'ledger', default: 3700 } } }),
        )
        const here = printed(path.join(main, 'apps', 'ledger'))
        expect(here.stderr).toBe('')
        expect(here.stdout.trim()).toBe('3700 http://localhost:3700')
        expect(printed(path.join(main, 'apps', 'ledger'), { LEDGER_PORT: '3999' }).stdout.trim()).toBe(
            '3999 http://localhost:3999',
        )

        // The same app in a linked worktree gets a derived port, from the custom band.
        const worktree = path.join(main, '.claude', 'worktrees', 'wt')
        mkdirSync(path.join(worktree, 'apps', 'ledger'), { recursive: true })
        writeFileSync(path.join(worktree, 'pnpm-workspace.yaml'), 'packages:\n  - apps/*\n')
        writeFileSync(
            path.join(worktree, 'apps', 'ledger', 'package.json'),
            JSON.stringify({ name: 'ledger', sssb: { port: { name: 'ledger', default: 3700 } } }),
        )
        const derived = printed(path.join(worktree, 'apps', 'ledger'))
        const port = Number(derived.stdout.split(' ')[0])
        expect(port).toBeGreaterThanOrEqual(20000)
        expect(port).toBeLessThan(30000)
        expect(derived.stdout.trim()).toBe(`${port} http://localhost:${port}`)

        // And the starter's string form, from its directory, is the built-in's.
        mkdirSync(path.join(main, 'apps', 'plain'), { recursive: true })
        writeFileSync(
            path.join(main, 'apps', 'plain', 'package.json'),
            JSON.stringify({ name: 'plain', sssb: { port: 'starter' } }),
        )
        expect(printed(path.join(main, 'apps', 'plain')).stdout.trim()).toBe('3100 http://localhost:3100')

        // From a directory below the app (its tests/), the app around it is the one that counts.
        mkdirSync(path.join(main, 'apps', 'ledger', 'tests'), { recursive: true })
        expect(printed(path.join(main, 'apps', 'ledger', 'tests')).stdout.trim()).toBe('3700 http://localhost:3700')
        // From the workspace root (knip, `playwright test -c apps/ledger/…`), no app is around: the config names its own.
        const root = printed(main)
        expect(root.status).not.toBe(0)
        expect(root.stderr).toMatch(/no service named, and the app around .* declares none/)
        const named = spawnSync(
            process.execPath,
            [
                '--input-type=module',
                '-e',
                `import {originForApp} from ${JSON.stringify(PORTS_JS)}; console.log(originForApp(${JSON.stringify(path.join(main, 'apps', 'ledger'))}), originForApp(${JSON.stringify(path.join(worktree, 'apps', 'ledger'))}))`,
            ],
            { cwd: main, env, encoding: 'utf8' },
        )
        expect(named.stderr).toBe('')
        expect(named.stdout.trim()).toBe(`http://localhost:3700 http://localhost:${port}`)
        expect(() => originForApp(path.join(main, 'apps'))).toThrow(/cannot read/)
        expect(() => originForApp(appWith({}))).toThrow(/declares no port service/)
    })

    it('refuses another app’s built-in slot in an app that declares its own, which a starter-derived script would use by mistake', () => {
        // `originFor('starter')` left in a second app's Playwright config would point its e2e run at the first app's
        // port while its dev server binds the slot it declares. Tools' own services stay free to name.
        const PORTS_JS = path.resolve(__dirname, '../../packages/tools/src/ports.js')
        const printed = (cwd: string, call: string) =>
            spawnSync(
                process.execPath,
                [
                    '--input-type=module',
                    '-e',
                    `import {portFor} from ${JSON.stringify(PORTS_JS)}; console.log(${call})`,
                ],
                {
                    cwd,
                    encoding: 'utf8',
                    env: Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.endsWith('_PORT'))),
                },
            )
        const own = appWith({ port: { name: 'ledger', default: 3700 } })
        const refused = printed(own, "portFor('starter')")
        expect(refused.status).not.toBe(0)
        expect(refused.stderr).toMatch(/"starter" is another app's port slot, and this app declares its own, "ledger"/)
        expect(printed(own, "portFor('showcase')").status).not.toBe(0)
        // A package nested in the app (its infra/) does not hide the app's slot, from a directory with none of its own.
        mkdirSync(path.join(own, 'infra'), { recursive: true })
        writeFileSync(path.join(own, 'pnpm-workspace.yaml'), 'packages:\n  - infra\n') // the checkout's root
        writeFileSync(path.join(own, 'infra', 'package.json'), JSON.stringify({ name: 'infra' }))
        expect(printed(path.join(own, 'infra'), "portFor('starter')").status).not.toBe(0)
        expect(printed(path.join(own, 'infra'), "portFor('ladle')").stdout.trim()).toBe('61000')
        expect(printed(own, "portFor('ladle')").stdout.trim()).toBe('61000')
        expect(printed(own, "portFor('contractPg')").stdout.trim()).toBe('5439')
        // An app on a built-in slot may still name the other one (the showcase's tests do), and so may a non-app directory.
        expect(printed(appWith({ port: 'showcase' }), "portFor('starter')").stdout.trim()).toBe('3100')
        expect(printed(appWith({}), "portFor('starter')").stdout.trim()).toBe('3100')
    })

    it('says what to do when the working directory declares nothing', () => {
        const PORTS_JS = path.resolve(__dirname, '../../packages/tools/src/ports.js')
        const script = `import {originFor} from ${JSON.stringify(PORTS_JS)}; originFor()`
        const dir = appWith({})
        const run = spawnSync(process.execPath, ['--input-type=module', '-e', script], { cwd: dir, encoding: 'utf8' })
        expect(run.status).not.toBe(0)
        expect(run.stderr).toMatch(/no service named, and the app around .* declares none/)
    })
})
