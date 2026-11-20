import { describe, expect, it } from 'vitest'
import { APP, lint } from './lint-text'

/**
 * `sssb/public-surface`: an `@sssb/kit/<subpath>` the exports map does not publish is refused however the specifier
 * is named. In this repository the alias sends `@sssb/kit/*` to source, so every form below compiles and runs against
 * the internal module; the rule reads each place an import fence reads a specifier, not only a string literal in an
 * import declaration. `adapters/dev-server` is a module of packages/kit/src that the exports map leaves out.
 */
const forms = (subpath: string): [string, string][] => [
    ['an import declaration', `import { x } from '${subpath}'\nexport { x }\n`],
    ['a re-export', `export { x } from '${subpath}'\n`],
    ['a re-export of everything', `export * from '${subpath}'\n`],
    ['import()', `export const load = () => import('${subpath}')\n`],
    ['import() of a template literal', `export const load = () => import(\`${subpath}\`)\n`],
    ['a type-position import()', `export type T = import('${subpath}').T\n`],
    ['import = require()', `import t = require('${subpath}')\nexport { t }\n`],
    ['require()', `export const t = require('${subpath}')\n`],
    ['vi.mock()', `vi.mock('${subpath}')\n`],
    ['vi.importActual()', `export const t = vi.importActual('${subpath}')\n`],
    ['vi.requireActual()', `export const t = vi.requireActual('${subpath}')\n`],
    ['vi.requireMock()', `export const t = vi.requireMock('${subpath}')\n`],
    ['a specifier with spaces around it', `import { x } from ' ${subpath} '\nexport { x }\n`],
]
const FILES = [`${APP}/src/lib/surface.ts`, 'scripts/surface.ts']
const fired = async (file: string, code: string) =>
    (await lint(file, code)).filter((f) => f.rule === 'sssb/public-surface')

describe('sssb/public-surface', () => {
    for (const file of FILES) {
        it.each(forms('@sssb/kit/adapters/dev-server'))(
            `refuses an unpublished subpath named by %s in ${file}`,
            async (_, code) => {
                const findings = await fired(file, code)
                expect(findings).toHaveLength(1)
                expect(findings[0].message).toContain(
                    "`@sssb/kit/adapters/dev-server` is not part of SSSB's public surface",
                )
            },
        )
        it.each(forms('@sssb/kit/authz/authorize'))(
            `lets a published subpath through by %s in ${file}`,
            async (_, code) => {
                expect(await fired(file, code)).toEqual([])
            },
        )
    }
})
