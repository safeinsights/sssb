import { mkdirSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { e2eReach, fileMatcher, playwrightFiles } from '../../packages/tools/src/commands/check-e2e.js'
import { makeTestTmpDir } from '../support/tmp-dir'

/**
 * `sssb check-e2e` (packages/tools/src/commands/check-e2e.js, ADR-0014 part 2): a Playwright spec may reach the kit
 * only through `@sssb/kit/testing/e2e`. Tiny workspaces: an adopter's, where the kit is an installed copy whose entry
 * is compiled, and SSSB's own shape (in-repo mode), where the apps' tsconfig `paths` send the kit to source. The
 * configs are LOADED, as Playwright loads them, so a fixture that imports `@playwright/test` links this repo's.
 */

function write(file: string, text: string) {
    mkdirSync(path.dirname(file), { recursive: true })
    writeFileSync(file, text)
}

function link(at: string, target: string) {
    mkdirSync(path.dirname(at), { recursive: true })
    symlinkSync(target, at, 'dir')
}

const PLAYWRIGHT_TEST = path.dirname(createRequire(import.meta.url).resolve('@playwright/test/package.json'))

/** The app every fixture shares: a Playwright config, a good spec, a spec reaching the kit through the app, support. */
function writeApp(app: string, tsconfigPaths: Record<string, string[]>) {
    write(path.join(app, 'package.json'), JSON.stringify({ name: 'console', private: true, type: 'module' }))
    write(path.join(app, 'tsconfig.json'), JSON.stringify({ compilerOptions: { paths: tsconfigPaths } }))
    write(
        path.join(app, 'playwright.config.ts'),
        "import { defineConfig } from '@playwright/test'\nexport default defineConfig({ testDir: './tests/e2e' })\n",
    )
    link(path.join(app, 'node_modules', '@playwright', 'test'), PLAYWRIGHT_TEST)
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

/** An installed kit copy at `kit`: a compiled entry, and TypeScript source that reads the seam. */
function writeInstalledKit(kit: string) {
    write(
        path.join(kit, 'package.json'),
        JSON.stringify({
            name: '@sssb/kit',
            version: '0.1.0',
            type: 'module',
            exports: { './testing/e2e': './dist/testing/e2e.js', './core/*': './src/core/*.ts' },
        }),
    )
    write(path.join(kit, 'dist/testing/e2e.js'), 'export const verify = () => true\n')
    write(
        path.join(kit, 'src/core/state-machine.ts'),
        "import { APP_SLUG } from '@sssb/app-config/app'\nexport const transition = () => APP_SLUG\n",
    )
}

const rel = (base: string, files: string[]) => files.map((f) => path.relative(base, f))

describe('playwrightFiles', () => {
    it("loads each config, its specs by Playwright's match, its global scripts, and the default match when it names no testDir", async () => {
        const app = realpathSync(makeTestTmpDir('sssb-e2e-files-'))
        write(
            path.join(app, 'playwright.config.ts'),
            "export default { testDir: './tests/e2e', globalSetup: './setup.ts' }\n",
        )
        write(path.join(app, 'playwright.demo.config.mts'), 'export default {}\n')
        write(path.join(app, 'setup.ts'), '')
        write(path.join(app, 'tests/e2e/a.spec.ts'), '')
        write(path.join(app, 'tests/e2e/.hidden/B.SPEC.ts'), '')
        write(path.join(app, 'tests/e2e/support/b.ts'), '')
        write(path.join(app, 'tests/e2e/types.d.ts'), '')
        write(path.join(app, 'src/c.test.ts'), '')
        write(path.join(app, 'src/d.ts'), '')
        write(path.join(app, 'node_modules/x/e.spec.ts'), '')
        const { configs, files, problems } = await playwrightFiles(app)
        expect(rel(app, configs)).toEqual(['playwright.config.ts', 'playwright.demo.config.mts'])
        // The demo config names no testDir, so Playwright looks under its directory with the default match: it WOULD
        // load the unit test, so that is checked too. A support module is checked through the spec that imports it.
        expect(rel(app, files)).toEqual([
            'playwright.config.ts',
            'playwright.demo.config.mts',
            'setup.ts',
            'src/c.test.ts',
            'tests/e2e/.hidden/B.SPEC.ts',
            'tests/e2e/a.spec.ts',
        ])
        expect(problems).toEqual([])
    })

    // The configs the review measured the old text-reading against: each computes or hides its testDir, or names its
    // global setup in an array. Read as text, some checked nothing (a vacuous ok) and others pulled in the unit test.
    const computed = {
        template: 'export default { testDir: `${import.meta.dirname}/tests/e2e` }\n',
        joined: "import path from 'node:path'\nexport default { testDir: path.join(import.meta.dirname, 'tests/e2e') }\n",
        dirname: "import path from 'node:path'\nexport default { testDir: path.join(__dirname, 'tests/e2e') }\n",
        shorthand: "const testDir = './tests/e2e'\nexport default { testDir }\n",
        commented: "const E2E = './tests/e2e'\nexport default {\n  // testDir: './old-e2e',\n  testDir: E2E,\n}\n",
        globalArray: "export default { testDir: './tests/e2e', globalSetup: ['./setup/global.ts'] }\n",
    }
    for (const [name, config] of Object.entries(computed)) {
        it(`resolves a ${name} config to its spec, not the unit test beside it`, async () => {
            const app = realpathSync(makeTestTmpDir(`sssb-e2e-${name}-`))
            // `__dirname` is CommonJS's: Playwright compiles a config to CommonJS when the package is not an ES module.
            const type = name === 'dirname' ? {} : { type: 'module' }
            write(path.join(app, 'package.json'), JSON.stringify({ name: 'x', private: true, ...type }))
            write(path.join(app, 'playwright.config.ts'), config)
            write(path.join(app, 'tests/e2e/a.spec.ts'), '')
            write(path.join(app, 'src/unit.test.ts'), '')
            write(path.join(app, 'setup/global.ts'), '')
            write(path.join(app, 'old-e2e/stale.spec.ts'), '')
            const { files, problems } = await playwrightFiles(app)
            expect(rel(app, files)).toEqual([
                'playwright.config.ts',
                ...(name === 'globalArray' ? ['setup/global.ts'] : []),
                'tests/e2e/a.spec.ts',
            ])
            expect(problems).toEqual([])
        })
    }

    it("takes each project's own testDir, testMatch (a RegExp too) and testIgnore, falling back to the config's", async () => {
        const app = realpathSync(makeTestTmpDir('sssb-e2e-projects-'))
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
        write(path.join(app, 'teardown.ts'), '')
        write(path.join(app, 'tests/e2e/a.spec.ts'), '')
        write(path.join(app, 'tests/e2e/support/helper.ts'), '')
        write(path.join(app, 'tests/e2e/destructive/d.spec.ts'), '')
        write(path.join(app, 'flows/sign-in.flow.ts'), '')
        write(path.join(app, 'flows/readme.spec.ts'), '')
        write(path.join(app, 'flows/data.json'), '')
        const { files, testDirs, problems } = await playwrightFiles(app)
        expect(rel(app, files)).toEqual([
            'flows/sign-in.flow.ts',
            'playwright.config.ts',
            'teardown.ts',
            'tests/e2e/a.spec.ts',
            'tests/e2e/destructive/d.spec.ts',
        ])
        expect(rel(app, testDirs)).toEqual(['flows', 'tests/e2e', 'tests/e2e/destructive'])
        expect(problems).toEqual([])
    })

    it('fails a config that matches no spec file, one that names a testDir with none, and one that does not load', async () => {
        const app = realpathSync(makeTestTmpDir('sssb-e2e-empty-'))
        write(path.join(app, 'playwright.config.ts'), "export default { testDir: './e2e' }\n")
        write(path.join(app, 'playwright.typo.config.ts'), "export default { testDir: './tests/e2e' }\n")
        write(path.join(app, 'playwright.broken.config.ts'), "throw new Error('refusing to load: a ticker is live')\n")
        write(path.join(app, 'e2e/a.spec.ts'), '')
        const { problems } = await playwrightFiles(app)
        expect(problems).toHaveLength(2)
        expect(problems[0]).toBe(
            'playwright.broken.config.ts could not be loaded (exit 1): Error: refusing to load: a ticker is live',
        )
        expect(problems[1]).toBe(
            'playwright.typo.config.ts matches no spec file (under tests/e2e): Playwright would find no tests',
        )
    })

    it('takes a --config kept outside the app, resolving it from its own directory', async () => {
        const ws = realpathSync(makeTestTmpDir('sssb-e2e-outside-'))
        const app = path.join(ws, 'apps', 'console')
        write(path.join(app, 'package.json'), JSON.stringify({ name: 'console', private: true }))
        const config = path.join(ws, 'e2e', 'playwright.config.ts')
        write(config, "export default { testDir: './specs' }\n")
        write(path.join(ws, 'e2e/specs/a.spec.ts'), '')
        const { configs, files } = await playwrightFiles(app, [config])
        expect(rel(ws, configs)).toEqual(['e2e/playwright.config.ts'])
        expect(rel(ws, files)).toEqual(['e2e/playwright.config.ts', 'e2e/specs/a.spec.ts'])
    })
})

describe('fileMatcher', () => {
    it("matches as Playwright's createFileMatcher does: globs from any depth, case-insensitive, dotfiles, RegExps", () => {
        const match = fileMatcher('**/*.@(spec|test).?(c|m)[jt]s?(x)')
        expect(match('/a/tests/x.spec.ts')).toBe(true)
        expect(match('/a/tests/X.SPEC.MTS')).toBe(true)
        expect(match('/a/.hidden/x.test.tsx')).toBe(true)
        expect(match('/a/tests/x.ts')).toBe(false)
        expect(fileMatcher('destructive/**')('/a/tests/destructive/x.spec.ts')).toBe(true)
        expect(fileMatcher({ regexp: '\\.flow\\.ts$', flags: '' })('/a/x.flow.ts')).toBe(true)
        expect(fileMatcher([])('/a/x.spec.ts')).toBe(false)
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

    // A sibling workspace package, as Pages' packages/gate is, with ITS OWN copy of the kit (pnpm gives each importer
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
        const bySpec = Object.fromEntries(result.reach.map((r) => [r.file, r]))
        expect(Object.keys(bySpec).sort()).toEqual([
            'playwright.config.ts',
            'tests/e2e/tickets.spec.ts',
            'tests/e2e/webhooks.spec.ts',
        ])
        expect(result.configProblems).toEqual([])
        expect(bySpec['tests/e2e/webhooks.spec.ts']).toMatchObject({ count: 0, reached: [], throughEntry: true })
        expect(bySpec['playwright.config.ts']).toMatchObject({ count: 0, throughEntry: false })
        expect(bySpec['tests/e2e/tickets.spec.ts']).toEqual({
            file: 'tests/e2e/tickets.spec.ts',
            count: 1,
            reached: [
                {
                    kitFile: '@sssb/kit:src/core/state-machine.ts',
                    via: ['tests/e2e/tickets.spec.ts', 'src/domain/tickets.ts', '@sssb/kit:src/core/state-machine.ts'],
                },
            ],
            unfollowed: [],
            throughEntry: false,
        })
    })

    it("follows a sibling workspace package into its own copy of the kit, and allows that copy's compiled entry", async () => {
        write(
            path.join(app, 'tests/e2e/sibling.spec.ts'),
            "import { s } from 'shared'\nimport { ok } from 'shared/ok'\nconsole.log(s, ok)\n",
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
                        kitFile: `${copy}:src/core/state-machine.ts`,
                        via: [
                            'tests/e2e/sibling.spec.ts',
                            '../../packages/shared/src/index.ts',
                            `${copy}:src/core/state-machine.ts`,
                        ],
                    },
                ],
                unfollowed: [],
                throughEntry: true,
            })
        } finally {
            write(path.join(app, 'tests/e2e/sibling.spec.ts'), "import { ok } from 'shared/ok'\nconsole.log(ok)\n")
        }
        const clean = await e2eReach(app)
        expect(clean.reach.find((r) => r.file === 'tests/e2e/sibling.spec.ts')).toMatchObject({ count: 0 })
    })

    it('follows a dynamic import and a require esbuild sees, and names a kit specifier beside createRequire', async () => {
        write(path.join(app, 'tests/e2e/dynamic.spec.ts'), "await import('@sssb/kit/core/state-machine')\n")
        write(
            path.join(app, 'tests/e2e/required.spec.ts'),
            "const m = require('@sssb/kit/core/state-machine')\nconsole.log(m)\n",
        )
        write(
            path.join(app, 'tests/e2e/created.spec.ts'),
            "import { createRequire } from 'node:module'\nconst r = createRequire(import.meta.url)\nconsole.log(r('@sssb/kit/core/state-machine'), r('@sssb/kit/testing/e2e'))\n",
        )
        const result = await e2eReach(app)
        const bySpec = Object.fromEntries(result.reach.map((r) => [r.file, r]))
        expect(bySpec['tests/e2e/dynamic.spec.ts']).toMatchObject({ count: 1 })
        expect(bySpec['tests/e2e/required.spec.ts']).toMatchObject({ count: 1 })
        expect(bySpec['tests/e2e/created.spec.ts']).toMatchObject({
            count: 0,
            unfollowed: ["tests/e2e/created.spec.ts names '@sssb/kit/core/state-machine' beside createRequire"],
        })
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
    write(
        path.join(kit, 'src/core/state-machine.ts'),
        "import { APP_SLUG } from '@sssb/app-config/app'\nexport const transition = () => APP_SLUG\n",
    )
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
