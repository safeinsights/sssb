import { mkdirSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { e2eReach, playwrightFiles } from '../../packages/tools/src/commands/check-e2e.js'
import { makeTestTmpDir } from '../support/tmp-dir'

/**
 * `sssb check-e2e` (packages/tools/src/commands/check-e2e.js, ADR-0014 part 2): a Playwright spec may reach the kit
 * only through `@sssb/kit/testing/e2e`. Two tiny workspaces: an adopter's, where the kit is an installed copy whose
 * entry is compiled, and SSSB's own shape (in-repo mode), where the apps' tsconfig `paths` send the kit to source.
 */

function write(file: string, text: string) {
    mkdirSync(path.dirname(file), { recursive: true })
    writeFileSync(file, text)
}

function link(at: string, target: string) {
    mkdirSync(path.dirname(at), { recursive: true })
    symlinkSync(target, at, 'dir')
}

/** The app every fixture shares: a Playwright config, a good spec, a spec reaching the kit through the app, support. */
function writeApp(app: string, tsconfigPaths: Record<string, string[]>) {
    write(path.join(app, 'package.json'), JSON.stringify({ name: 'console', private: true, type: 'module' }))
    write(path.join(app, 'tsconfig.json'), JSON.stringify({ compilerOptions: { paths: tsconfigPaths } }))
    write(
        path.join(app, 'playwright.config.ts'),
        "import { defineConfig } from '@playwright/test'\nexport default defineConfig({ testDir: './tests/e2e' })\n",
    )
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

describe('playwrightFiles', () => {
    it("loads each config, every script under each testDir it names, and Playwright's default match when it names none", () => {
        const app = realpathSync(makeTestTmpDir('sssb-e2e-files-'))
        write(
            path.join(app, 'playwright.config.ts'),
            "export default { testDir: './tests/e2e', globalSetup: './setup.ts' }\n",
        )
        write(path.join(app, 'playwright.demo.config.mts'), 'export default {}\n')
        write(path.join(app, 'setup.ts'), '')
        write(path.join(app, 'tests/e2e/a.spec.ts'), '')
        write(path.join(app, 'tests/e2e/support/b.ts'), '')
        write(path.join(app, 'tests/e2e/types.d.ts'), '')
        write(path.join(app, 'src/c.test.ts'), '')
        write(path.join(app, 'src/d.ts'), '')
        write(path.join(app, 'node_modules/x/e.spec.ts'), '')
        const { configs, files } = playwrightFiles(app)
        expect(configs.map((f) => path.relative(app, f))).toEqual([
            'playwright.config.ts',
            'playwright.demo.config.mts',
        ])
        expect(files.map((f) => path.relative(app, f))).toEqual([
            'playwright.config.ts',
            'playwright.demo.config.mts',
            'setup.ts',
            'src/c.test.ts',
            'tests/e2e/a.spec.ts',
            'tests/e2e/support/b.ts',
        ])
    })
})

describe('check-e2e against an installed kit (the entry is compiled)', () => {
    const ws = realpathSync(makeTestTmpDir('sssb-e2e-packed-'))
    write(path.join(ws, 'pnpm-workspace.yaml'), 'packages:\n  - apps/*\n')
    write(path.join(ws, 'package.json'), JSON.stringify({ name: 'ws', private: true }))
    const app = path.join(ws, 'apps', 'console')
    writeApp(app, { '@/*': ['./src/*'] })
    const home = path.join(ws, 'node_modules', '.pnpm', '@sssb+kit@0.1.0', 'node_modules')
    const kit = path.join(home, '@sssb', 'kit')
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
    link(path.join(home, '@sssb', 'app-config'), path.join(app, 'src', 'app-config'))
    link(path.join(app, 'node_modules', '@sssb', 'kit'), kit)

    it('allows the compiled entry alone, and names the spec that reaches the kit through an app module, with its chain', async () => {
        const result = await e2eReach(app)
        expect(result.inRepo).toBe(false)
        expect(result.entryFile).toBe('@sssb/kit:dist/testing/e2e.js')
        expect(result.allowed).toEqual(['@sssb/kit:dist/testing/e2e.js'])
        expect(result.entryProblems).toEqual([])
        const bySpec = Object.fromEntries(result.reach.map((r) => [r.file, r]))
        expect(bySpec['tests/e2e/webhooks.spec.ts']).toMatchObject({ count: 0, reached: [] })
        expect(bySpec['tests/e2e/support/login.ts']).toMatchObject({ count: 0 })
        expect(bySpec['playwright.config.ts']).toMatchObject({ count: 0 })
        expect(bySpec['tests/e2e/tickets.spec.ts']).toEqual({
            file: 'tests/e2e/tickets.spec.ts',
            count: 1,
            reached: [
                {
                    kitFile: '@sssb/kit:src/core/state-machine.ts',
                    via: ['tests/e2e/tickets.spec.ts', 'src/domain/tickets.ts', '@sssb/kit:src/core/state-machine.ts'],
                },
            ],
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
