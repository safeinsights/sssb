import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { existsSync, mkdirSync, readdirSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import sssb from '@sssb/eslint-plugin'
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
// The apps of the tree this runs in, never named, so a tree whose apps are renamed or removed needs no edit here.
const APPS = readdirSync(path.join(repoRoot, 'apps'), { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && existsSync(path.join(repoRoot, 'apps', entry.name, 'package.json')))
    .map((entry) => entry.name)
    .sort()

describe("this repo's apps keep every fence through the repo's config", () => {
    // The cases below are one per app found under apps/, so an empty list (a moved directory, a broken filter) would
    // pass with nothing checked.
    it('finds the apps it checks', () => {
        expect(APPS.length).toBeGreaterThan(0)
    })

    it.each(APPS)(
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
const TS_ESLINT = pathToFileURL(createRequire(path.join(repoRoot, 'package.json')).resolve('typescript-eslint')).href
const SOURCES: Record<string, string> = {
    'src/domain/tickets.ts': 'export const ticket = 1\n',
    'src/lib/format.ts': 'export const format = (n: number) => String(n)\n',
    'src/domain/maintenance.ts': 'export const purge = 1\n',
}
const EXCEPTIONS =
    "export default { 'sssb/no-raw-db-handle': [{ file: 'src/domain/maintenance.ts', reason: 'purges every tenant' }] }\n"

/** A scratch app: its sources, its exceptions, and an eslint.config.mjs that is the preset plus `after`. */
function scratchApp(after: string, extra: Record<string, string> = {}): string {
    // The real path: the preset anchors its blocks at the config's import.meta.dirname, which Node resolves through
    // symlinks (macOS's /var is one), so ESLint has to be handed real paths too, as `eslint` run from a shell is.
    const appDir = realpathSync(makeTestTmpDir('check-fences-'))
    const files = {
        ...SOURCES,
        'lint-exceptions.mjs': EXCEPTIONS,
        'eslint.config.mjs':
            `import sssb from '${PLUGIN}'\n` +
            `export default [...(await sssb.configs.app({ root: import.meta.dirname })), ${after}]\n`,
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

    // ESLint itself reads every directive (check-fences lints the app with and without inline configuration), so every
    // form it accepts is seen: quoted rule ids, an empty list, a list on the next line, an inline config holding a `*`.
    const READS_ENV = 'export const region = process.env.AWS_REGION\n'
    it.each([
        ['an eslint-disable naming a fence', `/* eslint-disable sssb/no-process-env */\n${READS_ENV}`],
        [
            'an eslint-disable-next-line naming a fence',
            `// eslint-disable-next-line sssb/no-process-env -- why\n${READS_ENV}`,
        ],
        ['a quoted rule id', `// eslint-disable-next-line "sssb/no-process-env"\n${READS_ENV}`],
        [
            'an eslint-disable-line',
            `export const region = process.env.AWS_REGION // eslint-disable-line 'sssb/no-process-env'\n`,
        ],
        ['an eslint-disable naming no rule', `/* eslint-disable */\n${READS_ENV}`],
        ['an eslint-disable with an empty list', `/* eslint-disable , */\n${READS_ENV}`],
        [
            'a fence named on the comment’s second line',
            `/* eslint-disable @typescript-eslint/no-explicit-any,\n   sssb/no-process-env */\n${READS_ENV}`,
        ],
    ])('fails on %s that hides a finding', async (_case, source) => {
        const problems = await problemsOf(scratchApp('', { 'src/lib/format.ts': source }))
        expect(problems.join('\n')).toMatch(
            /src\/lib\/format\.ts:\d+: an eslint-disable comment hides sssb\/no-process-env/,
        )
    })

    it.each([
        ['an inline config for a fence', `/* eslint sssb/no-process-env: 'off' */\n${READS_ENV}`],
        ['a quoted inline config', `/* eslint "sssb/no-process-env": "off" */\n${READS_ENV}`],
        [
            'an inline config holding a *',
            `/* eslint no-warning-comments: ["off", { terms: ["a*b"] }], sssb/no-process-env: "off" */\n${READS_ENV}`,
        ],
    ])('fails on %s that switches a fence off', async (_case, source) => {
        const problems = await problemsOf(scratchApp('', { 'src/lib/format.ts': source }))
        expect(problems.join('\n')).toMatch(
            /src\/lib\/format\.ts:\d+: an inline \/\* eslint \*\/ comment switches sssb\/no-process-env off there/,
        )
    })

    it('leaves an eslint-disable for a rule of its own alone', async () => {
        const comment = '// eslint-disable-next-line @typescript-eslint/no-explicit-any\n'
        expect(
            await problemsOf(scratchApp('', { 'src/lib/format.ts': `${comment}export const x: any = 1\n` })),
        ).toEqual([])
    })

    // A processor or a parser for one directory never shows in the rules: it drops a fence's findings or blanks the file.
    it.each([
        [
            'a processor that drops the fences’ findings',
            "{ files: ['src/lib/**'], processor: { meta: { name: 'mute' }, preprocess: (t) => [t], " +
                "postprocess: (ms) => ms.flat().filter((m) => !m.ruleId?.startsWith('sssb/')) } }",
            /src\/lib\/format\.ts: it runs through a processor \(mute\), and the preset sets none/,
        ],
        [
            'a parser that returns an empty program',
            "{ files: ['src/lib/**'], languageOptions: { parser: { meta: { name: 'blank' }, parseForESLint: () => " +
                "({ ast: { type: 'Program', body: [], sourceType: 'module', comments: [], tokens: [], range: [0, 0], " +
                'loc: { start: { line: 1, column: 0 }, end: { line: 1, column: 0 } } } }) } } }',
            /src\/lib\/format\.ts: its parser is blank, and the preset's is typescript-eslint\/parser/,
        ],
    ])('fails on %s, scoped away from the probes', async (_case, after, problem) => {
        expect((await problemsOf(scratchApp(after))).join('\n')).toMatch(problem)
    })

    it('walks a .d.ts, which the fences cover', async () => {
        const after = "{ files: ['**/*.d.ts'], rules: { 'sssb/no-vendor-import': 'off' } }"
        const appDir = scratchApp(after, {
            'src/domain/db.d.ts': "import type { Pool } from 'pg'\nexport type P = Pool\n",
        })
        expect(await problemsOf(appDir)).toContain('src/domain/db.d.ts: sssb/no-vendor-import is switched off or down')
    })

    it('walks a directory the preset lints however it is named (.turbo)', async () => {
        const after = "{ files: ['src/.turbo/**'], rules: { 'sssb/no-process-env': 'off' } }"
        const appDir = scratchApp(after, { 'src/.turbo/secret.ts': READS_ENV })
        expect(await problemsOf(appDir)).toContain('src/.turbo/secret.ts: sssb/no-process-env is switched off or down')
    })

    it('walks a symlinked file, and reports a symlinked directory, which ESLint does not enter', async () => {
        const outside = realpathSync(makeTestTmpDir('check-fences-outside-'))
        writeFileSync(path.join(outside, 'reads-env.ts'), READS_ENV)
        const after = "{ files: ['src/lib/linked.ts'], rules: { 'sssb/no-process-env': 'off' } }"
        const appDir = scratchApp(after)
        symlinkSync(path.join(outside, 'reads-env.ts'), path.join(appDir, 'src/lib/linked.ts'))
        symlinkSync(outside, path.join(appDir, 'src/shared'))
        const problems = await problemsOf(appDir)
        expect(problems).toContain('src/lib/linked.ts: sssb/no-process-env is switched off or down')
        expect(problems).toContain(
            'src/shared: a symlinked directory, which ESLint does not enter, so no fence sees its files',
        )
    })
})

// An app-owned adapter's SDK is the app's to add to the ban (docs/recipes/app-owned-adapter.md), in its own
// package.json, so check-fences reads the same list the preset does and compares the rules' options exactly.
describe("an app's own vendors (package.json sssb.vendors)", () => {
    const withVendors = (vendors: unknown, after = '') =>
        scratchApp(after, {
            'package.json': JSON.stringify({ name: 'scratch', private: true, sssb: { vendors } }),
        })
    const lintIn = async (appDir: string, file: string, code: string) => {
        const [result] = await new ESLint({ cwd: appDir }).lintText(code, { filePath: path.join(appDir, file) })
        return result.messages.map((m) => m.ruleId)
    }
    const STRIPE = ['stripe', 'stripe/*']

    it("bans the app's own vendor outside real/, both ways, and leaves real/ free to import it", async () => {
        const appDir = withVendors(STRIPE)
        const code =
            "import Stripe from 'stripe'\nexport const s = Stripe\nexport const load = () => import('stripe/lib/x')\n"
        const outside = await lintIn(appDir, 'src/domain/billing.ts', code)
        expect(outside).toContain('sssb/no-vendor-import')
        expect(outside).toContain('sssb/no-dynamic-vendor-import')
        const inside = await lintIn(appDir, 'src/adapters/real/billing.ts', code)
        expect(inside.filter((rule) => rule?.includes('vendor'))).toEqual([])
        expect(await problemsOf(appDir)).toEqual([])
    })

    it("keeps SSSB's own list whatever the app names", async () => {
        for (const vendors of [STRIPE, []]) {
            const code = "import { S3Client } from '@aws-sdk/client-s3'\nexport { S3Client }\n"
            expect(await lintIn(withVendors(vendors), 'src/domain/s3.ts', code)).toContain('sssb/no-vendor-import')
        }
    })

    it('refuses a negation, which would take a vendor off the list', async () => {
        const appDir = withVendors(['!pg', 'stripe'])
        await expect(sssb.configs.app({ root: appDir })).rejects.toThrow(/a leading ! un-bans a vendor/)
    })

    // The rule's schema refuses it, so ESLint fails the config outright: loud, in lint and in check-fences alike.
    it('refuses a negation handed to the rule by a later block, too', async () => {
        const appDir = scratchApp(
            "{ rules: { 'sssb/no-vendor-import': ['error', { vendors: ['!pg', '!@clerk/*'] }] } }",
        )
        await expect(
            new ESLint({ cwd: appDir }).lintText('export {}\n', { filePath: path.join(appDir, 'src/domain/x.ts') }),
        ).rejects.toThrow(/sssb\/no-vendor-import[\s\S]*should match pattern/)
        expect((await problemsOf(appDir)).join('\n')).toMatch(/the app's config does not load for it/)
    })

    it("fails when a later block swaps the app's list for one directory", async () => {
        const after =
            "{ files: ['src/lib/**'], rules: { 'sssb/no-vendor-import': ['error', { vendors: ['paypal'] }] } }"
        expect(await problemsOf(withVendors(STRIPE, after))).toContain(
            'src/lib/format.ts: sssb/no-vendor-import runs with options the preset does not set',
        )
    })

    // The dynamic half (import(), require(), a type import('…')) reads a package name, one followed by `/*`, and a
    // whole scope; the declaration half reads any gitignore pattern. Each entry below banned a declaration and let
    // import() through (or, `stripe/`, banned nothing), so the list refuses it, in package.json and in the option alike.
    const UNREADABLE = ['@stripe/**', 'stripe-*', 'stripe*', 'stripe/**', '/stripe', 'Stripe', 'stripe/', '@stripe']
    it.each(UNREADABLE)('refuses %j, which import() would get past', async (entry) => {
        await expect(sssb.configs.app({ root: withVendors(['stripe', entry]) })).rejects.toThrow(
            `sssb.vendors holds ${JSON.stringify(entry)}: each entry is "name", "@scope/name", either followed by "/*", or "@scope/*"`,
        )
        const appDir = scratchApp(
            `{ rules: { 'sssb/no-dynamic-vendor-import': ['error', { vendors: [${JSON.stringify(entry)}] }] } }`,
        )
        await expect(
            new ESLint({ cwd: appDir }).lintText('export {}\n', { filePath: path.join(appDir, 'src/domain/x.ts') }),
        ).rejects.toThrow(/sssb\/no-dynamic-vendor-import[\s\S]*should match pattern/)
    })

    it('bans every shape it accepts both ways, and probes each entry through the composed config', async () => {
        const vendors = ['stripe', 'stripe/*', '@stripe/*', '@paypal/sdk', '@paypal/sdk/*']
        const appDir = withVendors(vendors)
        for (const specifier of ['stripe', 'stripe/lib/x', '@stripe/stripe-js', '@paypal/sdk', '@paypal/sdk/x']) {
            const code = `import * as v from '${specifier}'\nexport { v }\nexport const load = () => import('${specifier}')\n`
            const fired = await lintIn(appDir, 'src/domain/billing.ts', code)
            expect(fired.filter((rule) => rule === 'sssb/no-vendor-import')).toHaveLength(1)
            expect(fired.filter((rule) => rule === 'sssb/no-dynamic-vendor-import')).toHaveLength(1)
        }
        const [withList, without] = await Promise.all([
            checkFences({ appDir, ESLint }),
            checkFences({ appDir: withVendors([]), ESLint }),
        ])
        expect(withList.problems).toEqual([])
        expect(withList.probes - without.probes).toBe(vendors.length)
    })

    it('refuses anything but a list of package patterns, and the old option', async () => {
        await expect(sssb.configs.app({ root: withVendors('stripe') })).rejects.toThrow(/must be a list/)
        // @ts-expect-error the option moved to the app's package.json
        await expect(sssb.configs.app({ root: withVendors([]), vendors: ['stripe'] })).rejects.toThrow(
            /takes \{ root \} and nothing else/,
        )
    })
})

// Under an `apps/*` root, an app's directory name is matched literally, as its files are.
describe('an app whose directory name holds glob characters', () => {
    it('keeps its exception to its own file', async () => {
        const root = realpathSync(makeTestTmpDir('glob-apps-'))
        for (const app of ['[ab]', 'a']) {
            mkdirSync(path.join(root, 'apps', app, 'src/domain'), { recursive: true })
            writeFileSync(path.join(root, 'apps', app, 'src/domain/m.ts'), 'export const m = (db) => db.getDb()\n')
        }
        writeFileSync(
            path.join(root, 'apps/[ab]/lint-exceptions.mjs'),
            "export default { 'sssb/no-raw-db-handle': [{ file: 'src/domain/m.ts', reason: 'the system' }] }\n",
        )
        const eslint = new ESLint({
            cwd: root,
            overrideConfigFile: true,
            overrideConfig: await sssb.configs.app({ root: path.join(root, 'apps/*') }),
        })
        const rulesAt = async (app: string) =>
            (await eslint.lintFiles([path.join(root, 'apps', app, 'src/domain/m.ts')]))[0].messages.map((m) => m.ruleId)
        expect(await rulesAt('[ab]')).not.toContain('sssb/no-raw-db-handle')
        expect(await rulesAt('a')).toContain('sssb/no-raw-db-handle')
    })
})

// The command itself (@sssb/tools), which resolves the plugin and ESLint from the app's own directory.
describe('sssb check-fences', () => {
    const sssbCli = (...args: string[]) =>
        spawnSync(process.execPath, [path.join(repoRoot, 'packages/tools/bin/sssb.js'), 'check-fences', ...args], {
            cwd: repoRoot,
            encoding: 'utf8',
        })

    it.each(APPS)(
        'passes apps/%s through the repo config',
        (app) => {
            const run = sssbCli('--app', `apps/${app}`)
            expect(run.stderr).toBe('')
            expect(run.status).toBe(0)
            expect(run.stdout).toMatch(/every fence holds/)
        },
        120_000,
    )

    it('says so when the app does not resolve the plugin', () => {
        const appDir = makeTestTmpDir('check-fences-cli-')
        writeFileSync(path.join(appDir, 'package.json'), '{ "name": "elsewhere", "private": true }\n')
        const run = sssbCli('--app', appDir)
        expect(run.status).toBe(1)
        expect(run.stderr).toMatch(/does not resolve @sssb\/eslint-plugin/)
    })
})

// Under an `apps/*` root, an app's own vendors hold for that app alone, and SSSB's list for every app, one not yet
// created included.
describe("an app's own vendors under an apps/* root", () => {
    it('stay with their app', async () => {
        const root = realpathSync(makeTestTmpDir('vendor-apps-'))
        for (const app of ['billing', 'plain']) mkdirSync(path.join(root, 'apps', app, 'src'), { recursive: true })
        writeFileSync(
            path.join(root, 'apps/billing/package.json'),
            JSON.stringify({ name: 'billing', sssb: { vendors: ['stripe'] } }),
        )
        const eslint = new ESLint({
            cwd: root,
            overrideConfigFile: true,
            overrideConfig: await sssb.configs.app({ root: path.join(root, 'apps/*') }),
        })
        const rulesAt = async (app: string, code: string) =>
            (await eslint.lintText(code, { filePath: path.join(root, 'apps', app, 'src/x.ts') }))[0].messages.map(
                (m) => m.ruleId,
            )
        const STRIPE = "import Stripe from 'stripe'\nexport { Stripe }\n"
        const S3 = "import { S3Client } from '@aws-sdk/client-s3'\nexport { S3Client }\n"
        expect(await rulesAt('billing', STRIPE)).toContain('sssb/no-vendor-import')
        expect(await rulesAt('plain', STRIPE)).not.toContain('sssb/no-vendor-import')
        for (const app of ['billing', 'plain', 'not-yet-created']) {
            expect(await rulesAt(app, S3), app).toContain('sssb/no-vendor-import')
        }
    })
})

// Round 2 of review: what reaches past the comparison without changing a rule's entry.
describe('the fences as the app lints them, whatever its config or its lint command does with a finding', () => {
    const READS_ENV = 'export const region = process.env.AWS_REGION\n'

    it('fails on a processor that calls itself none', async () => {
        const after =
            "{ files: ['src/lib/**'], processor: { meta: { name: 'none' }, preprocess: (t) => [t], " +
            "postprocess: (ms) => ms.flat().filter((m) => !m.ruleId?.startsWith('sssb/')) } }"
        expect(await problemsOf(scratchApp(after))).toContain(
            'src/lib/format.ts: it runs through a processor (none), and the preset sets none',
        )
    })

    it('fails on an inline comment that turns a fence down to a warning', async () => {
        const source = `/* eslint sssb/no-process-env: "warn" */\n${READS_ENV}`
        const problems = await problemsOf(scratchApp('', { 'src/lib/format.ts': source }))
        expect(problems.join('\n')).toMatch(
            /src\/lib\/format\.ts:2: sssb\/no-process-env reports it, and the app's lint must fail on it/,
        )
    })

    // `eslint --suppress-all` writes this file, and the ESLint CLI applies it; the API check-fences uses does not.
    it('fails on a finding an eslint-suppressions.json lets through', async () => {
        const appDir = scratchApp('', {
            'src/lib/format.ts': READS_ENV,
            'eslint-suppressions.json': JSON.stringify({
                'src/lib/format.ts': { 'sssb/no-process-env': { count: 1 } },
            }),
        })
        expect((await problemsOf(appDir)).join('\n')).toMatch(
            /src\/lib\/format\.ts:1: sssb\/no-process-env reports it, and the app's lint must fail on it/,
        )
    })

    // probes.js: an app that bans more than the preset is tightening, and check-fences leaves it alone (bar the file a
    // lint-exceptions.mjs entry names, which must stay exempt).
    it('leaves an app alone that relaxes a tightening of its own', async () => {
        const after = "{ files: ['src/adapters/real/**'], rules: { 'sssb/no-process-env': 'error' } }"
        const source = `// eslint-disable-next-line sssb/no-process-env\n${READS_ENV}`
        expect(await problemsOf(scratchApp(after, { 'src/adapters/real/kv.ts': source }))).toEqual([])
    })

    it('leaves an app alone whose own typescript-eslint parser is another version', async () => {
        const after =
            `{ languageOptions: { parser: { ...(await import('${TS_ESLINT}')).default.parser, ` +
            "meta: { name: 'typescript-eslint/parser', version: '99.0.0' } } } }"
        expect(await problemsOf(scratchApp(after))).toEqual([])
    })

    it('fences a directory deeper in the app that has a build output’s name', async () => {
        const appDir = scratchApp('', { 'src/coverage/report.ts': READS_ENV })
        expect((await problemsOf(appDir)).join('\n')).toMatch(/src\/coverage\/report\.ts:1: sssb\/no-process-env/)
    })

    it('refuses a config that rewrites a rule on the shared plugin object', async () => {
        expect(() => {
            ;(sssb.rules['no-process-env'] as { create: unknown }).create = () => ({})
        }).toThrow(TypeError)
    })
})

// In a child Node process: vitest's module loader does not load a `file:` URL holding `%23` (an encoded `#`), and Node,
// which is what loads an adopter's config, does.
describe('an app whose directory name starts with #', () => {
    it('keeps its exception and its vendors under an apps/* root', () => {
        const root = realpathSync(makeTestTmpDir('hash-apps-'))
        const app = path.join(root, 'apps', '#e')
        mkdirSync(path.join(app, 'src/domain'), { recursive: true })
        writeFileSync(path.join(app, 'src/domain/m.ts'), 'export const m = (db) => db.getDb()\n')
        writeFileSync(path.join(app, 'package.json'), JSON.stringify({ name: 'e', sssb: { vendors: ['stripe'] } }))
        writeFileSync(
            path.join(app, 'lint-exceptions.mjs'),
            "export default { 'sssb/no-raw-db-handle': [{ file: 'src/domain/m.ts', reason: 'the system' }] }\n",
        )
        const ESLINT = pathToFileURL(createRequire(path.join(repoRoot, 'package.json')).resolve('eslint')).href
        const script = `
const { ESLint } = await import(${JSON.stringify(ESLINT)})
const { default: sssb } = await import(${JSON.stringify(PLUGIN)})
const root = ${JSON.stringify(root)}
const app = ${JSON.stringify(app)}
const eslint = new ESLint({ cwd: root, overrideConfigFile: true, overrideConfig: await sssb.configs.app({ root: root + '/apps/*' }) })
const [excepted] = await eslint.lintFiles([app + '/src/domain/m.ts'])
const [stripe] = await eslint.lintText("import Stripe from 'stripe'\\nexport { Stripe }\\n", { filePath: app + '/src/domain/billing.ts' })
console.log(JSON.stringify({ excepted: excepted.messages.map((m) => m.ruleId), stripe: stripe.messages.map((m) => m.ruleId) }))
`
        const run = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8' })
        expect(run.status, run.stderr).toBe(0)
        const { excepted, stripe } = JSON.parse(run.stdout) as { excepted: string[]; stripe: string[] }
        expect(excepted).not.toContain('sssb/no-raw-db-handle')
        expect(stripe).toContain('sssb/no-vendor-import')
    })
})

// Round 3 of review.
describe('what check-fences leaves alone, and what it no longer misses', () => {
    it('leaves a symlinked directory alone when ESLint would lint nothing in it', async () => {
        const outside = realpathSync(makeTestTmpDir('check-fences-assets-'))
        writeFileSync(path.join(outside, 'logo.png'), '')
        const appDir = scratchApp('')
        mkdirSync(path.join(appDir, 'public'), { recursive: true })
        symlinkSync(outside, path.join(appDir, 'public/images'))
        symlinkSync(outside, path.join(appDir, '.data'))
        expect(await problemsOf(appDir)).toEqual([])
    })

    it("lets an exception name a screen's test, which keeps the tenancy ban otherwise", async () => {
        const appDir = scratchApp('', {
            'src/components/card.test.tsx': 'export const load = (db) => db.getDb()\n',
            'lint-exceptions.mjs':
                "export default { 'sssb/no-raw-db-handle': [{ file: 'src/components/card.test.tsx', reason: 'seeds rows' }] }\n",
        })
        expect(await problemsOf(appDir)).toEqual([])
    })

    it("keeps sssb/no-jsx-literals when react's own rule object is rewritten", async () => {
        const rule = (await import('eslint-plugin-react')).default.rules['jsx-no-literals'] as { create: unknown }
        const original = rule.create
        rule.create = () => ({})
        try {
            const appDir = scratchApp('')
            const [result] = await new ESLint({ cwd: appDir }).lintText('export const C = () => <p>Saved</p>\n', {
                filePath: path.join(appDir, 'src/components/c.tsx'),
            })
            expect(result.messages.map((m) => m.ruleId)).toContain('sssb/no-jsx-literals')
        } finally {
            rule.create = original
        }
    })

    it('refuses a config that edits the vendor list it shares with the rules', async () => {
        const { vendorSdkPattern } = await import('../../packages/eslint-plugin/src/patterns.js')
        expect(() => (vendorSdkPattern.group as string[]).splice(0, 1)).toThrow(TypeError)
    })
})
