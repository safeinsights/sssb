import { mkdirSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { e2eReach, playwrightFiles } from '../../packages/tools/src/commands/check-e2e.js'
import { makeTestTmpDir } from '../support/tmp-dir'

/**
 * `sssb check-e2e` (packages/tools/src/commands/check-e2e.js, ADR-0014 part 2): a Playwright spec may reach the kit
 * only through `@sssb/kit/testing/e2e`. Which files Playwright loads is asked of Playwright itself (`playwright test
 * --list`), so every fixture links this repository's `@playwright/test` (and `typescript`, which reads the files that
 * name `createRequire`) into the app, and each spec holds a test: Playwright lists a file only by its tests. Tiny
 * workspaces: an adopter's, where the kit is an installed copy whose entry is compiled, and SSSB's own shape (in-repo
 * mode), where the apps' tsconfig `paths` send the kit to source.
 */

function write(file: string, text: string) {
    mkdirSync(path.dirname(file), { recursive: true })
    writeFileSync(file, text)
}

function link(at: string, target: string) {
    mkdirSync(path.dirname(at), { recursive: true })
    symlinkSync(target, at, 'dir')
}

const fromHere = createRequire(import.meta.url)
const PLAYWRIGHT_TEST = path.dirname(fromHere.resolve('@playwright/test/package.json'))
const TYPESCRIPT = path.dirname(fromHere.resolve('typescript/package.json'))

/** A spec Playwright lists: it holds a test. */
const SPEC = "import { test } from '@playwright/test'\ntest('runs', () => {})\n"

/** The packages Playwright and check-e2e resolve from an app, linked into `dir`'s node_modules. */
function linkTools(dir: string) {
    link(path.join(dir, 'node_modules', '@playwright', 'test'), PLAYWRIGHT_TEST)
    link(path.join(dir, 'node_modules', 'typescript'), TYPESCRIPT)
}

/** A scratch app with its own package.json and the tools linked. */
function scratchApp(prefix: string, manifest: Record<string, unknown> = { type: 'module' }) {
    const app = realpathSync(makeTestTmpDir(prefix))
    write(path.join(app, 'package.json'), JSON.stringify({ name: 'x', private: true, ...manifest }))
    linkTools(app)
    return app
}

/** The app every kit fixture shares: a Playwright config, a good spec, a spec reaching the kit through the app, support. */
function writeApp(app: string, tsconfigPaths: Record<string, string[]>) {
    write(path.join(app, 'package.json'), JSON.stringify({ name: 'console', private: true, type: 'module' }))
    write(path.join(app, 'tsconfig.json'), JSON.stringify({ compilerOptions: { paths: tsconfigPaths } }))
    write(
        path.join(app, 'playwright.config.ts'),
        "import { defineConfig } from '@playwright/test'\nexport default defineConfig({ testDir: './tests/e2e' })\n",
    )
    linkTools(app)
    write(
        path.join(app, 'tests/e2e/webhooks.spec.ts'),
        "import { test } from '@playwright/test'\nimport { verify } from '@sssb/kit/testing/e2e'\nimport { login } from './support/login'\ntest('signs', () => { verify(); login() })\n",
    )
    write(
        path.join(app, 'tests/e2e/support/login.ts'),
        "import { expect } from '@playwright/test'\nexport const login = () => expect(1).toBe(1)\n",
    )
    write(
        path.join(app, 'tests/e2e/tickets.spec.ts'),
        "import { test } from '@playwright/test'\nimport { nextState } from '@/domain/tickets'\ntest('moves', () => { nextState() })\n",
    )
    write(
        path.join(app, 'src/domain/tickets.ts'),
        "import { transition } from '@sssb/kit/core/state-machine'\nexport const nextState = () => transition()\n",
    )
    write(path.join(app, 'src/app-config/app.ts'), "export const APP_SLUG = 'console'\n")
}

/**
 * An installed kit copy at `kit`: a compiled entry, and source outside it. The source a spec reaches is JavaScript
 * here, so that Node loads it and Playwright lists the spec for check-e2e to fail; TypeScript under node_modules (the
 * real kit's source) fails Playwright's own listing instead, which is tested on its own below.
 */
function writeInstalledKit(kit: string) {
    write(
        path.join(kit, 'package.json'),
        JSON.stringify({
            name: '@sssb/kit',
            version: '0.1.0',
            type: 'module',
            exports: {
                './package.json': './package.json',
                './testing/e2e': './dist/testing/e2e.js',
                './core/*': './src/core/*.js',
                './typed/*': './src/typed/*.ts',
            },
        }),
    )
    write(path.join(kit, 'dist/testing/e2e.js'), 'export const verify = () => true\n')
    write(path.join(kit, 'src/core/state-machine.js'), "export const transition = () => 'moved'\n")
    write(path.join(kit, 'src/typed/clock.ts'), 'export const now = (): number => 0\n')
}

const rel = (base: string, files: string[]) => files.map((f) => path.relative(base, f))

describe('playwrightFiles (what `playwright test --list` says each config loads)', () => {
    it('takes each config, its listed specs, its global scripts, and the default match when it names no testDir', async () => {
        const app = scratchApp('sssb-e2e-files-')
        write(
            path.join(app, 'playwright.config.ts'),
            "export default { testDir: './tests/e2e', globalSetup: './setup.ts' }\n",
        )
        write(path.join(app, 'playwright.demo.config.mts'), 'export default {}\n')
        write(path.join(app, 'setup.ts'), 'export default async () => {}\n')
        write(path.join(app, 'tests/e2e/a.spec.ts'), SPEC)
        write(path.join(app, 'tests/e2e/.hidden/B.SPEC.ts'), SPEC)
        write(path.join(app, 'tests/e2e/support/b.ts'), '')
        write(path.join(app, 'tests/e2e/types.d.ts'), '')
        write(path.join(app, 'src/c.test.ts'), SPEC)
        write(path.join(app, 'src/d.ts'), '')
        write(path.join(app, 'node_modules/x/e.spec.ts'), SPEC)
        const { configs, files, problems } = await playwrightFiles(app)
        expect(problems).toEqual([])
        expect(rel(app, configs)).toEqual(['playwright.config.ts', 'playwright.demo.config.mts'])
        // The demo config names no testDir, so Playwright looks under its directory with the default match: it DOES
        // load the unit test, so that is checked too. A support module is checked through the spec that imports it.
        expect(rel(app, files)).toEqual([
            'playwright.config.ts',
            'playwright.demo.config.mts',
            'setup.ts',
            'src/c.test.ts',
            'tests/e2e/.hidden/B.SPEC.ts',
            'tests/e2e/a.spec.ts',
        ])
    })

    // Configs that compute or hide their testDir, name their global setup in an array or by `require.resolve`, or are
    // CommonJS (Playwright's own JavaScript scaffold). Read as text, some checked nothing; loaded by a bundle of our own,
    // the `require` ones did not load at all, though Playwright loads them.
    const SETUP = 'setup/global.ts'
    const computed: Record<string, { file?: string; text: string; commonjs?: boolean; setup?: boolean }> = {
        template: { text: 'export default { testDir: `${import.meta.dirname}/tests/e2e` }\n' },
        joined: {
            text: "import path from 'node:path'\nexport default { testDir: path.join(import.meta.dirname, 'tests/e2e') }\n",
        },
        // `__dirname` is CommonJS's: Playwright compiles a config to CommonJS when the package is not an ES module.
        dirname: {
            text: "import path from 'node:path'\nexport default { testDir: path.join(__dirname, 'tests/e2e') }\n",
            commonjs: true,
        },
        shorthand: { text: "const testDir = './tests/e2e'\nexport default { testDir }\n" },
        commented: {
            text: "const E2E = './tests/e2e'\nexport default {\n  // testDir: './old-e2e',\n  testDir: E2E,\n}\n",
        },
        globalArray: {
            text: "export default { testDir: './tests/e2e', globalSetup: ['./setup/global.ts'] }\n",
            setup: true,
        },
        commonjsScaffold: {
            file: 'playwright.config.js',
            text: "const { defineConfig, devices } = require('@playwright/test')\nmodule.exports = defineConfig({\n  testDir: './tests/e2e',\n  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],\n})\n",
            commonjs: true,
        },
        requireResolveSetup: {
            text: "import { defineConfig } from '@playwright/test'\nexport default defineConfig({ testDir: './tests/e2e', globalSetup: require.resolve('./setup/global') })\n",
            commonjs: true,
            setup: true,
        },
    }
    for (const [name, { file = 'playwright.config.ts', text, commonjs, setup }] of Object.entries(computed)) {
        it(`resolves a ${name} config to its spec, not the unit test beside it`, async () => {
            const app = scratchApp(`sssb-e2e-${name}-`, commonjs ? {} : { type: 'module' })
            write(path.join(app, file), text)
            write(path.join(app, 'tests/e2e/a.spec.ts'), SPEC)
            write(path.join(app, 'src/unit.test.ts'), SPEC)
            write(path.join(app, SETUP), 'export default async () => {}\n')
            write(path.join(app, 'old-e2e/stale.spec.ts'), SPEC)
            const { files, problems } = await playwrightFiles(app)
            expect(problems).toEqual([])
            expect(rel(app, files)).toEqual([file, ...(setup ? [SETUP] : []), 'tests/e2e/a.spec.ts'])
        })
    }

    it("takes each project's own testDir, testMatch (a RegExp too) and testIgnore, falling back to the config's", async () => {
        const app = scratchApp('sssb-e2e-projects-')
        write(
            path.join(app, 'playwright.config.ts'),
            [
                'export default {',
                "    testDir: './tests/e2e',",
                "    globalTeardown: ['./teardown.ts'],",
                '    projects: [',
                "        { name: 'main', testIgnore: '**/destructive/**' },",
                "        { name: 'destructive', testDir: './tests/e2e/destructive' },",
                "        { name: 'flows', testDir: './flows', testMatch: /\\.flow\\.ts$/ },",
                '    ],',
                '}',
            ].join('\n'),
        )
        write(path.join(app, 'teardown.ts'), 'export default async () => {}\n')
        write(path.join(app, 'tests/e2e/a.spec.ts'), SPEC)
        write(path.join(app, 'tests/e2e/support/helper.ts'), '')
        write(path.join(app, 'tests/e2e/destructive/d.spec.ts'), SPEC)
        write(path.join(app, 'flows/sign-in.flow.ts'), SPEC)
        write(path.join(app, 'flows/readme.spec.ts'), SPEC)
        write(path.join(app, 'flows/data.json'), '')
        const { files, testDirs, problems } = await playwrightFiles(app)
        expect(problems).toEqual([])
        expect(rel(app, files)).toEqual([
            'flows/sign-in.flow.ts',
            'playwright.config.ts',
            'teardown.ts',
            'tests/e2e/a.spec.ts',
            'tests/e2e/destructive/d.spec.ts',
        ])
        expect(rel(app, testDirs)).toEqual(['flows', 'tests/e2e', 'tests/e2e/destructive'])
    })

    it("fails a config that lists no test, one that does not load, and one with a spec that does not, with Playwright's error", async () => {
        const app = scratchApp('sssb-e2e-empty-')
        write(path.join(app, 'playwright.config.ts'), "export default { testDir: './e2e' }\n")
        write(path.join(app, 'playwright.typo.config.ts'), "export default { testDir: './tests/e2e' }\n")
        write(path.join(app, 'playwright.testless.config.ts'), "export default { testDir: './testless' }\n")
        write(path.join(app, 'playwright.broken.config.ts'), "throw new Error('refusing to load: a ticker is live')\n")
        write(path.join(app, 'playwright.throws.config.ts'), "export default { testDir: './throws' }\n")
        write(path.join(app, 'e2e/a.spec.ts'), SPEC)
        write(path.join(app, 'testless/a.spec.ts'), 'export const notATest = 1\n')
        write(path.join(app, 'throws/a.spec.ts'), `${SPEC}throw new Error('boom while loading')\n`)
        const { problems, files } = await playwrightFiles(app)
        expect(problems).toEqual([
            'playwright.broken.config.ts could not be listed by Playwright (exit 1): Error: refusing to load: a ticker is live',
            'playwright.testless.config.ts lists no test (under testless): Playwright would find no tests in it',
            'playwright.throws.config.ts could not be listed by Playwright (exit 1): Error: boom while loading',
            'playwright.typo.config.ts lists no test (under tests/e2e): Playwright would find no tests in it',
        ])
        expect(rel(app, files)).toContain('e2e/a.spec.ts')
    })

    it('takes a --config kept outside the app, which Playwright resolves from its own directory', async () => {
        const ws = realpathSync(makeTestTmpDir('sssb-e2e-outside-'))
        const app = path.join(ws, 'apps', 'console')
        write(path.join(app, 'package.json'), JSON.stringify({ name: 'console', private: true }))
        linkTools(app)
        linkTools(ws)
        const config = path.join(ws, 'e2e', 'playwright.config.ts')
        write(config, "export default { testDir: './specs' }\n")
        write(path.join(ws, 'e2e/specs/a.spec.ts'), SPEC)
        const { configs, files, problems } = await playwrightFiles(app, [config])
        expect(problems).toEqual([])
        expect(rel(ws, configs)).toEqual(['e2e/playwright.config.ts'])
        expect(rel(ws, files)).toEqual(['e2e/playwright.config.ts', 'e2e/specs/a.spec.ts'])
    })
})

describe('check-e2e against an installed kit (the entry is compiled)', () => {
    const ws = realpathSync(makeTestTmpDir('sssb-e2e-packed-'))
    write(path.join(ws, 'pnpm-workspace.yaml'), 'packages:\n  - apps/*\n  - packages/*\n')
    write(path.join(ws, 'package.json'), JSON.stringify({ name: 'ws', private: true }))
    const app = path.join(ws, 'apps', 'console')
    writeApp(app, { '@/*': ['./src/*'] })
    const home = path.join(ws, 'node_modules', '.pnpm', '@sssb+kit@0.1.0', 'node_modules')
    const kit = path.join(home, '@sssb', 'kit')
    writeInstalledKit(kit)
    link(path.join(home, '@sssb', 'app-config'), path.join(app, 'src', 'app-config'))
    link(path.join(app, 'node_modules', '@sssb', 'kit'), kit)

    // A sibling workspace package, as an adopter's `packages/gate` might be, with ITS OWN copy of the kit (pnpm gives each importer
    // that links a different seam its own instance). Playwright transforms its TypeScript like the app's.
    const shared = path.join(ws, 'packages', 'shared')
    write(
        path.join(shared, 'package.json'),
        JSON.stringify({ name: 'shared', type: 'module', exports: { '.': './src/index.ts', './ok': './src/ok.ts' } }),
    )
    write(path.join(shared, 'src/index.ts'), "export { transition as s } from '@sssb/kit/core/state-machine'\n")
    write(path.join(shared, 'src/ok.ts'), "export { verify as ok } from '@sssb/kit/testing/e2e'\n")
    const sharedHome = path.join(ws, 'node_modules', '.pnpm', '@sssb+kit@0.1.0_shared', 'node_modules')
    writeInstalledKit(path.join(sharedHome, '@sssb', 'kit'))
    link(path.join(sharedHome, '@sssb', 'app-config'), path.join(app, 'src', 'app-config'))
    link(path.join(shared, 'node_modules', '@sssb', 'kit'), path.join(sharedHome, '@sssb', 'kit'))
    link(path.join(app, 'node_modules', 'shared'), shared)

    it('allows the compiled entry alone, and names the spec that reaches the kit through an app module, with its chain', async () => {
        const result = await e2eReach(app)
        expect(result.inRepo).toBe(false)
        expect(result.entryFile).toBe('@sssb/kit:dist/testing/e2e.js')
        expect(result.allowed).toEqual(['@sssb/kit:dist/testing/e2e.js'])
        expect(result.entryProblems).toEqual([])
        expect(result.configProblems).toEqual([])
        const bySpec = Object.fromEntries(result.reach.map((r) => [r.file, r]))
        expect(Object.keys(bySpec).sort()).toEqual([
            'playwright.config.ts',
            'tests/e2e/tickets.spec.ts',
            'tests/e2e/webhooks.spec.ts',
        ])
        expect(bySpec['tests/e2e/webhooks.spec.ts']).toMatchObject({ count: 0, reached: [], throughEntry: true })
        expect(bySpec['playwright.config.ts']).toMatchObject({ count: 0, throughEntry: false })
        expect(bySpec['tests/e2e/tickets.spec.ts']).toEqual({
            file: 'tests/e2e/tickets.spec.ts',
            count: 1,
            reached: [
                {
                    kitFile: '@sssb/kit:src/core/state-machine.js',
                    via: ['tests/e2e/tickets.spec.ts', 'src/domain/tickets.ts', '@sssb/kit:src/core/state-machine.js'],
                },
            ],
            unfollowed: [],
            throughEntry: false,
        })
    })

    it("follows a sibling workspace package into its own copy of the kit, and allows that copy's compiled entry", async () => {
        write(
            path.join(app, 'tests/e2e/sibling.spec.ts'),
            "import { test } from '@playwright/test'\nimport { s } from 'shared'\nimport { ok } from 'shared/ok'\ntest('sibling', () => { console.log(s, ok) })\n",
        )
        try {
            const result = await e2eReach(app)
            const sibling = result.reach.find((r) => r.file === 'tests/e2e/sibling.spec.ts')
            const copy = '@sssb/kit(../../node_modules/.pnpm/@sssb+kit@0.1.0_shared/node_modules/@sssb/kit)'
            expect(sibling).toEqual({
                file: 'tests/e2e/sibling.spec.ts',
                count: 1,
                reached: [
                    {
                        kitFile: `${copy}:src/core/state-machine.js`,
                        via: [
                            'tests/e2e/sibling.spec.ts',
                            '../../packages/shared/src/index.ts',
                            `${copy}:src/core/state-machine.js`,
                        ],
                    },
                ],
                unfollowed: [],
                throughEntry: true,
            })
        } finally {
            write(
                path.join(app, 'tests/e2e/sibling.spec.ts'),
                "import { test } from '@playwright/test'\nimport { ok } from 'shared/ok'\ntest('sibling', () => { console.log(ok) })\n",
            )
        }
        const clean = await e2eReach(app)
        expect(clean.reach.find((r) => r.file === 'tests/e2e/sibling.spec.ts')).toMatchObject({ count: 0 })
    })

    it('follows a dynamic import and a require esbuild sees, and names a kit specifier beside createRequire, in code only', async () => {
        const specs = {
            'tests/e2e/dynamic.spec.ts': "test('d', async () => { await import('@sssb/kit/core/state-machine') })\n",
            'tests/e2e/required.spec.ts': "test('r', () => { console.log(require('@sssb/kit/core/state-machine')) })\n",
            'tests/e2e/created.spec.ts':
                "import { createRequire } from 'node:module'\nconst r = createRequire(import.meta.url)\ntest('c', () => { console.log(r('@sssb/kit/core/state-machine'), r('@sssb/kit/testing/e2e')) })\n",
            // The kit's manifest is not framework code, and a specifier in a comment is not one at all.
            'tests/e2e/version.spec.ts':
                "import { createRequire } from 'node:module'\n// r('@sssb/kit/core/state-machine') was the old way\n/* and `@sssb/kit/core/state-machine` too */\nconst { version } = createRequire(import.meta.url)('@sssb/kit/package.json')\ntest('v', () => { console.log(version) })\n",
        }
        for (const [file, text] of Object.entries(specs))
            write(path.join(app, file), `import { test } from '@playwright/test'\n${text}`)
        const result = await e2eReach(app)
        expect(result.configProblems).toEqual([])
        const bySpec = Object.fromEntries(result.reach.map((r) => [r.file, r]))
        expect(bySpec['tests/e2e/dynamic.spec.ts']).toMatchObject({ count: 1 })
        expect(bySpec['tests/e2e/required.spec.ts']).toMatchObject({ count: 1 })
        expect(bySpec['tests/e2e/created.spec.ts']).toMatchObject({
            count: 0,
            unfollowed: [
                "tests/e2e/created.spec.ts names '@sssb/kit/core/state-machine' where esbuild cannot follow it: reach the kit through @sssb/kit/testing/e2e, or keep the specifier out of code a spec loads",
            ],
        })
        expect(bySpec['tests/e2e/version.spec.ts']).toMatchObject({ count: 0, unfollowed: [] })
    })

    // Playwright compiles a spec to CommonJS, where a plain `require` exists: handed a variable, it loads what esbuild
    // never saw, with no `createRequire` anywhere in the file.
    it('names a kit specifier a plain require loads through a variable, and passes one that loads nothing', async () => {
        const specs = {
            'tests/e2e/variable.spec.ts':
                "const k = '@sssb/kit/core/state-machine'\ntest('v', () => { console.log(require(k)) })\n",
            'tests/e2e/typed.spec.ts':
                "import type { Machine } from '@sssb/kit/core/state-machine'\nexport type T = import('@sssb/kit/core/state-machine').Machine | Machine\ntest('t', () => {})\n",
            // an object key is a name, never a specifier; the kit's guide and manifest are data, not framework code
            'tests/e2e/data.spec.ts':
                "const keys = { '@sssb/kit/core/state-machine': 1 }\nconst guide = `@sssb/kit/guide.md`\nconst m = '@sssb/kit/package.json'\ntest('d', () => { console.log(keys, guide, m) })\n",
            'tests/e2e/literal-type.spec.ts':
                "type S = '@sssb/kit/core/state-machine'\nconst s = 'x' as '@sssb/kit/core/state-machine' | 'x'\ntest('l', () => { console.log(s satisfies S | 'x') })\n",
            'tests/e2e/entry.spec.ts':
                "// const k = '@sssb/kit/core/state-machine'\nconst e = '@sssb/kit/testing/e2e'\ntest('e', () => { console.log(e) })\n",
        }
        for (const [file, text] of Object.entries(specs))
            write(path.join(app, file), `import { test } from '@playwright/test'\n${text}`)
        const result = await e2eReach(app)
        expect(result.configProblems).toEqual([])
        const bySpec = Object.fromEntries(result.reach.map((r) => [r.file, r]))
        expect(bySpec['tests/e2e/variable.spec.ts']).toMatchObject({
            count: 0,
            unfollowed: [
                "tests/e2e/variable.spec.ts names '@sssb/kit/core/state-machine' where esbuild cannot follow it: reach the kit through @sssb/kit/testing/e2e, or keep the specifier out of code a spec loads",
            ],
        })
        expect(bySpec['tests/e2e/typed.spec.ts']).toMatchObject({ count: 0, unfollowed: [] })
        expect(bySpec['tests/e2e/entry.spec.ts']).toMatchObject({ count: 0, unfollowed: [] })
        expect(bySpec['tests/e2e/data.spec.ts']).toMatchObject({ count: 0, unfollowed: [] })
        expect(bySpec['tests/e2e/literal-type.spec.ts']).toMatchObject({ count: 0, unfollowed: [] })
    })

    it("fails the config when a spec reaches the kit's TypeScript source, which Playwright cannot load, naming the kit file", async () => {
        write(
            path.join(app, 'tests/e2e/typed.spec.ts'),
            "import { test } from '@playwright/test'\nimport { now } from '@sssb/kit/typed/clock'\ntest('t', () => { now() })\n",
        )
        const result = await e2eReach(app)
        expect(result.configProblems).toHaveLength(1)
        expect(result.configProblems[0]).toMatch(
            /^playwright\.config\.ts could not be listed by Playwright \(exit 1\): /,
        )
        expect(result.configProblems[0]).toContain(
            '\n          a file Playwright loads reaches @sssb/kit:src/typed/clock.ts, other than through @sssb/kit/testing/e2e',
        )
    })
})

describe('check-e2e in-repo (the kit is a workspace package, reached through tsconfig paths)', () => {
    const ws = realpathSync(makeTestTmpDir('sssb-e2e-in-repo-'))
    write(path.join(ws, 'pnpm-workspace.yaml'), 'packages:\n  - apps/*\n  - packages/*\n')
    write(path.join(ws, 'package.json'), JSON.stringify({ name: 'ws', private: true }))
    const kit = path.join(ws, 'packages', 'kit')
    write(path.join(kit, 'package.json'), JSON.stringify({ name: '@sssb/kit', version: '0.1.0', type: 'module' }))
    write(path.join(kit, 'src/testing/e2e.ts'), "export { verify } from '../core/hmac'\n")
    write(path.join(kit, 'src/core/hmac.ts'), 'export const verify = () => true\n')
    write(path.join(kit, 'src/core/state-machine.ts'), "export const transition = () => 'moved'\n")
    const app = path.join(ws, 'apps', 'console')
    writeApp(app, {
        '@/*': ['./src/*'],
        '@sssb/app-config/*': ['./src/app-config/*'],
        '@sssb/kit/*': ['../../packages/kit/src/*'],
    })
    link(path.join(app, 'node_modules', '@sssb', 'kit'), kit)

    it("allows the entry's source closure, and still names the spec that reaches the rest of the kit", async () => {
        const result = await e2eReach(app)
        expect(result.inRepo).toBe(true)
        expect(result.allowed).toEqual(['@sssb/kit:src/core/hmac.ts', '@sssb/kit:src/testing/e2e.ts'])
        expect(result.entryProblems).toEqual([])
        expect(result.configProblems).toEqual([])
        expect(result.reach.filter((r) => r.count > 0).map((r) => [r.file, r.reached.map((x) => x.kitFile)])).toEqual([
            ['tests/e2e/tickets.spec.ts', ['@sssb/kit:src/core/state-machine.ts']],
        ])
    })

    it('fails the entry itself when its closure reaches the seam', async () => {
        write(
            path.join(kit, 'src/core/hmac.ts'),
            "import { APP_SLUG } from '@sssb/app-config/app'\nexport const verify = () => APP_SLUG\n",
        )
        const result = await e2eReach(app)
        expect([...result.entryProblems].sort()).toEqual([
            '@sssb/kit:src/core/hmac.ts imports @sssb/app-config/app',
            'src/app-config/app.ts is a seam module',
        ])
    })
})
