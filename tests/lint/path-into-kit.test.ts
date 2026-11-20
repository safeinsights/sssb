import { mkdirSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { ESLint } from 'eslint'
import { describe, expect, it } from 'vitest'
import { makeTestTmpDir } from '../support/tmp-dir'
import { APP, lint } from './lint-text'

/**
 * `sssb/no-path-into-kit`: `sssb/public-surface` judges `@sssb/kit/…` specifiers, and @sssb/kit ships its source, so a
 * PATH into the package reached any of its internals past the exports map with lint clean:
 * `../node_modules/@sssb/kit/src/…` from an adopter's app, `../../../packages/kit/src/…` in this repository. A path is
 * judged where it really lands; any path through node_modules is a finding of its own. The kit's own files, its fixture
 * included, are inside the package and import each other freely.
 */
const RULE = 'sssb/no-path-into-kit'
const forms = (to: string): [string, string][] => [
    ['an import declaration', `import { x } from ${to}\nexport { x }\n`],
    ['a re-export', `export { x } from ${to}\n`],
    ['import()', `export const load = () => import(${to})\n`],
    ['a type-position import()', `export type T = import(${to}).T\n`],
    ['import = require()', `import t = require(${to})\nexport { t }\n`],
    ['require()', `export const t = require(${to})\n`],
    ['vi.mock()', `vi.mock(${to})\n`],
    ['vi.importActual()', `export const t = vi.importActual(${to})\n`],
]
const fired = async (file: string, code: string) => (await lint(file, code)).filter((f) => f.rule === RULE)
const from = (file: string, target: string) => path.relative(path.dirname(file), target)

describe('sssb/no-path-into-kit', () => {
    const SUITE = 'packages/kit/src/testing/conformance/suite'
    for (const file of [`${APP}/src/zz.test.ts`, `${APP}/src/lib/x.ts`, 'scripts/zz.ts', 'tests/tooling/zz.test.ts']) {
        describe(file, () => {
            const intoKit = JSON.stringify(from(file, SUITE))
            const throughNodeModules = JSON.stringify(
                from(file, path.join(path.dirname(file), '../node_modules/@sssb/kit/src/testing/conformance/suite')),
            )
            it.each(forms(intoKit))('refuses a path into packages/kit by %s', async (_, code) => {
                const findings = await fired(file, code)
                expect(findings).toHaveLength(1)
                expect(findings[0].message).toContain('is a path into @sssb/kit')
            })
            it.each(forms(throughNodeModules))('refuses a path through node_modules by %s', async (_, code) => {
                const findings = await fired(file, code)
                expect(findings).toHaveLength(1)
                expect(findings[0].message).toContain('is a path through node_modules')
            })
            it('reads a template literal, a query and a hash, an absolute path and a file: URL', async () => {
                const absolute = path.join(process.cwd(), SUITE)
                for (const to of [
                    `\`${from(file, SUITE)}\``,
                    JSON.stringify(`${from(file, SUITE)}?raw`),
                    JSON.stringify(`${from(file, SUITE)}#x`),
                    JSON.stringify(absolute),
                    JSON.stringify(pathToFileURL(absolute).href),
                ]) {
                    expect(await fired(file, `export const load = () => import(${to})\n`), to).toHaveLength(1)
                }
            })
        })
    }

    it("leaves the app's own relative imports, another package's and a published subpath alone", async () => {
        const file = `${APP}/src/lib/x.ts`
        const code = [
            "import { a } from './a'",
            "import { b } from '../domain/b'",
            `import { c } from ${JSON.stringify(from(file, 'packages/tools/src/ports.js'))}`,
            "import { d } from '@sssb/kit/authz/authorize'",
            'export { a, b, c, d }',
        ].join('\n')
        expect(await fired(file, code)).toEqual([])
    })

    it.each([
        [
            'packages/kit/src/core/kv.ts',
            "import { r } from './roles'\nimport { t } from '../testing/tmp-dir'\nexport { r, t }\n",
        ],
        ['packages/kit/test-fixture/domain/kv.ts', "import { r } from '../../src/core/roles'\nexport { r }\n"],
    ])('leaves %s, inside the package, free to import its siblings', async (file, code) => {
        expect(await fired(file, code)).toEqual([])
    })
})

/**
 * The spellings a plain relative path does not cover, in a scratch workspace outside this repository: an app under the
 * preset, and a stand-in `@sssb/kit` package beside it (its package.json is what names it), so a symlink never has to be
 * written into this checkout.
 */
describe('sssb/no-path-into-kit, through a symlink, the app alias, require.resolve and a reference', () => {
    const PLUGIN = pathToFileURL(path.join(process.cwd(), 'packages/eslint-plugin/src/index.js')).href
    const workspace = () => {
        const root = realpathSync(makeTestTmpDir('path-into-kit-'))
        const write = (file: string, text: string) => {
            mkdirSync(path.dirname(path.join(root, file)), { recursive: true })
            writeFileSync(path.join(root, file), text)
        }
        write('kit/package.json', JSON.stringify({ name: '@sssb/kit' }))
        write('kit/src/core/roles.ts', 'export const r = 1\n')
        write('app/package.json', JSON.stringify({ name: 'app', private: true }))
        write('app/src/lib/other.ts', 'export const o = 1\n')
        write(
            'app/eslint.config.mjs',
            `import sssb from '${PLUGIN}'\nexport default [...(await sssb.configs.app({ root: import.meta.dirname }))]\n`,
        )
        // a FILE symlink, imported without its extension, and a DIRECTORY symlink, reached through `@/`
        symlinkSync(path.join(root, 'kit/src/core/roles.ts'), path.join(root, 'app/src/zzkit.ts'))
        symlinkSync(path.join(root, 'kit/src'), path.join(root, 'app/src/zzdir'), 'dir')
        // a resolver prefers a file to a directory of the same name, follows a directory's index, and maps `.js` to `.ts`
        write('app/src/zz/real.ts', 'export const z = 1\n')
        symlinkSync(path.join(root, 'kit/src/core/roles.ts'), path.join(root, 'app/src/zz.ts'))
        mkdirSync(path.join(root, 'app/src/yy'))
        symlinkSync(path.join(root, 'kit/src/core/roles.ts'), path.join(root, 'app/src/yy/index.ts'))
        return path.join(root, 'app')
    }
    const firedIn = async (app: string, code: string) => {
        const [result] = await new ESLint({ cwd: app }).lintText(code, { filePath: path.join(app, 'src/lib/x.ts') })
        expect(
            result.messages.filter((m) => !m.ruleId),
            'not actually linted',
        ).toEqual([])
        return result.messages.filter((m) => m.ruleId === RULE)
    }

    it.each([
        ['a file symlink imported without its extension', "import { r } from '../zzkit'\nexport { r }\n"],
        ['the @/ alias through a directory symlink', "import { r } from '@/zzdir/core/roles'\nexport { r }\n"],
        ['the @/ alias climbing out of src/', "import { r } from '@/../../kit/src/core/roles'\nexport { r }\n"],
        ['require.resolve()', "export const at = require.resolve('../../../kit/src/core/roles')\n"],
        ['a file symlink beside a real directory of its name', "import { r } from '../zz'\nexport { r }\n"],
        ['a directory whose index is a symlink', "import { r } from '../yy'\nexport { r }\n"],
        ['a .js name whose .ts twin is a symlink', "import { r } from '../zzkit.js'\nexport { r }\n"],
        [
            'a triple-slash reference path',
            '/// <reference path="../../../kit/src/core/roles.ts" />\nexport const x = 1\n',
        ],
    ])('refuses %s', async (_, code) => {
        const findings = await firedIn(workspace(), code)
        expect(findings).toHaveLength(1)
        expect(findings[0].message).toContain('is a path into @sssb/kit')
    })

    // `.resolve` is also `path.resolve` and `Promise.resolve`, whose string need not be a module: only a module
    // resolver's (`require`, `import.meta`, `createRequire(…)`) path through node_modules is a finding.
    it('judges node_modules in a .resolve only for a module resolver', async () => {
        const app = workspace()
        const code = [
            "export const a = path.resolve('node_modules/.cache/x')",
            "export const b = Promise.resolve('node_modules')",
            "export const c = somePath.resolve('./x')",
        ].join('\n')
        expect(await firedIn(app, `${code}\n`)).toEqual([])
        for (const resolver of ['require', 'import.meta', "createRequire('/x')"]) {
            const findings = await firedIn(
                app,
                `export const d = ${resolver}.resolve('../node_modules/@sssb/kit/src/x')\n`,
            )
            expect(findings, resolver).toHaveLength(1)
            expect(findings[0].message).toContain('is a path through node_modules')
        }
    })

    it("leaves the app's own @/ imports and a resolve of its own file alone", async () => {
        const code = "import { o } from '@/lib/other'\nexport { o }\nexport const at = require.resolve('./other')\n"
        expect(await firedIn(workspace(), code)).toEqual([])
    })
})

// The two kit-internal path rules judge a landing with the same helper, and had the same blind spot: a file symlink
// inside packages/kit, named without its extension, was not followed out of the package.
describe('sssb/no-path-out-of-package follows an extensionless file symlink too', () => {
    it('reports a symlink under packages/kit that lands outside it', async () => {
        const root = realpathSync(makeTestTmpDir('path-out-of-package-'))
        const write = (file: string, text: string) => {
            mkdirSync(path.dirname(path.join(root, file)), { recursive: true })
            writeFileSync(path.join(root, file), text)
        }
        write('packages/kit/package.json', JSON.stringify({ name: '@sssb/kit', files: ['src'] }))
        write('scripts/helper.ts', 'export const h = 1\n')
        write('packages/kit/src/roles.ts', 'export const r = 1\n')
        symlinkSync(path.join(root, 'scripts/helper.ts'), path.join(root, 'packages/kit/src/zzhelper.ts'))
        const { default: sssb } = await import('@sssb/eslint-plugin')
        const { default: tseslint } = await import('typescript-eslint')
        const eslint = new ESLint({
            cwd: root,
            overrideConfigFile: true,
            overrideConfig: [
                {
                    files: ['**/*.ts'],
                    languageOptions: { parser: tseslint.parser },
                    plugins: { sssb: sssb as unknown as ESLint.Plugin },
                    rules: { 'sssb/no-path-out-of-package': ['error', { root }] },
                },
            ],
        })
        const [result] = await eslint.lintText("import { h } from './zzhelper'\nexport { h }\n", {
            filePath: path.join(root, 'packages/kit/src/x.ts'),
        })
        expect(result.messages.map((m) => m.ruleId)).toEqual(['sssb/no-path-out-of-package'])
        expect(result.messages[0].message).toContain('leaves packages/kit (it lands in scripts/helper)')
    })
})
