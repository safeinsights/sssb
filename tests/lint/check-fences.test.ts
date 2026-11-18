import { spawnSync } from 'node:child_process'
import { mkdirSync, realpathSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { checkFences } from '@sssb/eslint-plugin/check-fences'
import { ESLint } from 'eslint'
import { describe, expect, it } from 'vitest'
import { makeTestTmpDir } from '../support/tmp-dir'

/**
 * `sssb check-fences` (@sssb/eslint-plugin/check-fences): the fences as an app's real config composes them. This file
 * runs it over both of this repo's apps, through the repo's own config, and over scratch apps whose own config adds,
 * after the preset, each way an adopter's config could switch a fence off or narrow it. Every one of those must come
 * back as a problem; the ordinary composition (an adopter's own `no-restricted-imports` and `no-restricted-syntax`
 * blocks, which used to replace the fences) must not.
 */
const repoRoot = process.cwd()

describe("this repo's apps keep every fence through the repo's config", () => {
    it.each(['showcase', 'starter'])(
        'apps/%s',
        async (app) => {
            const result = await checkFences({ appDir: path.join(repoRoot, 'apps', app), ESLint })
            expect(result.problems).toEqual([])
            expect(result.files).toBeGreaterThan(20)
            expect(result.probes).toBeGreaterThan(5)
        },
        120_000,
    )
})

// The plugin by file URL: a scratch app outside the workspace cannot resolve `@sssb/eslint-plugin` by name.
const PLUGIN = pathToFileURL(path.join(repoRoot, 'packages/eslint-plugin/src/index.js')).href
const SOURCES: Record<string, string> = {
    'src/domain/tickets.ts': 'export const ticket = 1\n',
    'src/lib/format.ts': 'export const format = (n: number) => String(n)\n',
    'src/domain/maintenance.ts': 'export const purge = 1\n',
}
const EXCEPTIONS =
    "export default { 'sssb/no-raw-db-handle': [{ file: 'src/domain/maintenance.ts', reason: 'purges every tenant' }] }\n"

/** A scratch app: its sources, its exceptions, and an eslint.config.mjs that is the preset plus `after`. */
function scratchApp(after: string, extra: Record<string, string> = {}, presetOptions = ''): string {
    // The real path: the preset anchors its blocks at the config's import.meta.dirname, which Node resolves through
    // symlinks (macOS's /var is one), so ESLint has to be handed real paths too, as `eslint` run from a shell is.
    const appDir = realpathSync(makeTestTmpDir('check-fences-'))
    const files = {
        ...SOURCES,
        'lint-exceptions.mjs': EXCEPTIONS,
        'eslint.config.mjs':
            `import sssb from '${PLUGIN}'\n` +
            `export default [...(await sssb.configs.app({ root: import.meta.dirname${presetOptions} })), ${after}]\n`,
        ...extra,
    }
    for (const [file, text] of Object.entries(files)) {
        mkdirSync(path.dirname(path.join(appDir, file)), { recursive: true })
        writeFileSync(path.join(appDir, file), text)
    }
    return appDir
}
const problemsOf = async (appDir: string) => (await checkFences({ appDir, ESLint })).problems

describe('an app config that composes the preset with blocks of its own', () => {
    it('holds when the app only adds (the positive control)', async () => {
        expect(await problemsOf(scratchApp(''))).toEqual([])
    })

    // The merge trap, which the move to rule ids of their own exists to close: these blocks used to replace fences.
    it("holds when the app's own blocks set no-restricted-imports and no-restricted-syntax", async () => {
        const after =
            "{ rules: { 'no-restricted-imports': ['error', { patterns: ['lodash'] }], " +
            "'no-restricted-syntax': ['error', 'WithStatement'] } }"
        expect(await problemsOf(scratchApp(after))).toEqual([])
    })

    it('fails when a later block turns a fence off', async () => {
        const problems = await problemsOf(scratchApp("{ rules: { 'sssb/no-vendor-import': 'off' } }"))
        expect(problems.join('\n')).toMatch(/src\/domain\/tickets\.ts: sssb\/no-vendor-import is switched off/)
        expect(problems.join('\n')).toMatch(/sssb\/no-vendor-import did not report/)
    })

    it('fails when a later block turns a fence down to a warning', async () => {
        const problems = await problemsOf(scratchApp("{ rules: { 'sssb/no-process-env': 'warn' } }"))
        expect(problems.join('\n')).toMatch(/sssb\/no-process-env is switched off or down/)
    })

    it('fails when a later block narrows a fence to spare one directory', async () => {
        const after = "{ files: ['src/lib/**'], rules: { 'sssb/no-raw-db-handle': 'off' } }"
        const problems = await problemsOf(scratchApp(after))
        expect(problems).toContain('src/lib/format.ts: sssb/no-raw-db-handle is switched off or down')
        expect(problems.some((p) => p.startsWith('src/domain/'))).toBe(false)
    })

    it("fails when the app's config ignores a directory the preset lints", async () => {
        const problems = await problemsOf(scratchApp("{ ignores: ['src/lib/**'] }"))
        expect(problems).toContain("src/lib/format.ts: the app's config ignores it, and the preset lints it")
    })

    it('fails when a nested config file takes a directory over', async () => {
        const problems = await problemsOf(scratchApp('', { 'src/lib/eslint.config.mjs': 'export default []\n' }))
        // An empty nested config matches no file, so ESLint ignores the directory outright.
        expect(problems).toContain("src/lib/format.ts: the app's config ignores it, and the preset lints it")
    })

    it('fails when a nested config file lints a directory without the fences', async () => {
        const nested = { 'src/lib/eslint.config.mjs': "export default [{ rules: { 'no-console': 'error' } }]\n" }
        const problems = await problemsOf(scratchApp('', nested))
        // A config with no `files` lints ESLint's default .js/.mjs/.cjs, the nested config file itself among them.
        expect(problems).toContain('src/lib/eslint.config.mjs: sssb/no-vendor-import is not enabled')
    })

    it('fails when a lint-exceptions.mjs entry is widened to its directory', async () => {
        const after = "{ files: ['src/domain/**'], rules: { 'sssb/no-raw-db-handle': 'off' } }"
        const problems = await problemsOf(scratchApp(after))
        expect(problems.join('\n')).toMatch(/__sssb_fence_probe__\.ts: sssb\/no-raw-db-handle does not report beside/)
    })

    // The exception's other half: a later block that re-enables the ban over all of src/ makes the entry a dead letter,
    // and the module it names fails lint for doing what the entry says it may.
    it('fails when a lint-exceptions.mjs entry no longer exempts its file', async () => {
        const after = "{ files: ['src/**'], rules: { 'sssb/no-raw-db-handle': 'error' } }"
        const problems = await problemsOf(scratchApp(after))
        expect(problems).toContain(
            'src/domain/maintenance.ts: lint-exceptions.mjs names it, and sssb/no-raw-db-handle still reports',
        )
    })

    it.each([
        ['an eslint-disable naming a fence', '/* eslint-disable sssb/no-vendor-import */\n'],
        ['an eslint-disable-next-line naming a fence', '// eslint-disable-next-line sssb/no-process-env -- why\n'],
        ['an eslint-disable naming no rule', '/* eslint-disable */\n'],
        ['an inline config for a fence', "/* eslint sssb/no-raw-db-handle: 'off' */\n"],
    ])('fails on %s in a source file', async (_case, comment) => {
        const appDir = scratchApp('', { 'src/lib/format.ts': `${comment}export const x = 1\n` })
        expect((await problemsOf(appDir)).join('\n')).toMatch(/src\/lib\/format\.ts: .*lint-exceptions\.mjs/)
    })

    it('leaves an eslint-disable for a rule of its own alone', async () => {
        const comment = '// eslint-disable-next-line @typescript-eslint/no-explicit-any\n'
        expect(
            await problemsOf(scratchApp('', { 'src/lib/format.ts': `${comment}export const x: any = 1\n` })),
        ).toEqual([])
    })
})

// An app-owned adapter's SDK is the app's to add to the ban (docs/recipes/app-owned-adapter.md), and adding is all the
// option can do.
describe('configs.app({ root, vendors })', () => {
    const VENDORS = ", vendors: ['stripe', 'stripe/*']"
    const lintIn = async (appDir: string, file: string, code: string) => {
        const [result] = await new ESLint({ cwd: appDir }).lintText(code, { filePath: path.join(appDir, file) })
        return result.messages.map((m) => m.ruleId)
    }

    it("bans the app's own vendor outside real/, both ways, and leaves real/ free to import it", async () => {
        const appDir = scratchApp('', {}, VENDORS)
        const code =
            "import Stripe from 'stripe'\nexport const s = Stripe\nexport const load = () => import('stripe/lib/x')\n"
        const outside = await lintIn(appDir, 'src/domain/billing.ts', code)
        expect(outside).toContain('sssb/no-vendor-import')
        expect(outside).toContain('sssb/no-dynamic-vendor-import')
        const inside = await lintIn(appDir, 'src/adapters/real/billing.ts', code)
        expect(inside.filter((rule) => rule?.includes('vendor'))).toEqual([])
    })

    it("keeps SSSB's own list whatever the app passes", async () => {
        for (const options of [VENDORS, ', vendors: []']) {
            const appDir = scratchApp('', {}, options)
            const found = await lintIn(
                appDir,
                'src/domain/s3.ts',
                "import { S3Client } from '@aws-sdk/client-s3'\nexport { S3Client }\n",
            )
            expect(found).toContain('sssb/no-vendor-import')
        }
    })

    it('is a tightening, so check-fences accepts it', async () => {
        expect(await problemsOf(scratchApp('', {}, VENDORS))).toEqual([])
    })

    it('refuses anything but a list of package patterns', async () => {
        const sssb = (await import('@sssb/eslint-plugin')).default
        // @ts-expect-error a string, not a list
        await expect(sssb.configs.app({ root: makeTestTmpDir('vendors-'), vendors: 'stripe' })).rejects.toThrow(
            /list of package patterns/,
        )
    })
})

// The command itself (@sssb/tools), which resolves the plugin and ESLint from the app's own directory.
describe('sssb check-fences', () => {
    const sssbCli = (...args: string[]) =>
        spawnSync(process.execPath, [path.join(repoRoot, 'packages/tools/bin/sssb.js'), 'check-fences', ...args], {
            cwd: repoRoot,
            encoding: 'utf8',
        })

    it('passes the starter through the repo config', () => {
        const run = sssbCli('--app', 'apps/starter')
        expect(run.stderr).toBe('')
        expect(run.status).toBe(0)
        expect(run.stdout).toMatch(/every fence holds/)
    }, 120_000)

    it('says so when the app does not resolve the plugin', () => {
        const appDir = makeTestTmpDir('check-fences-cli-')
        writeFileSync(path.join(appDir, 'package.json'), '{ "name": "elsewhere", "private": true }\n')
        const run = sssbCli('--app', appDir)
        expect(run.status).toBe(1)
        expect(run.stderr).toMatch(/does not resolve @sssb\/eslint-plugin/)
    })
})
