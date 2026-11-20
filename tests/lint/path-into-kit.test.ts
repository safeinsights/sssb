import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'
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
