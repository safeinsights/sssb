import { describe, expect, it } from 'vitest'
import { lint } from './lint-text'

/**
 * Pins `sssb/no-bare-kit-import` (eslint.config.mjs) through the repo's REAL config: ADR-0014's rule 4 says every
 * SSSB package but the framework reaches @sssb/kit only through the shared resolver, which resolves from the app's
 * directory. A bare specifier written in one of those packages resolves from the package itself, and in a workspace
 * with two apps that loads the other app's instance. The ban covers every SSSB package by default (`packages/*`
 * minus the framework and the showcase's seed), so a new package is fenced before anyone names it.
 */
const RULE = 'sssb/no-bare-kit-import'
const fired = async (file: string, code: string) =>
    (await lint(file, code)).filter((finding) => finding.rule === RULE).length

describe('sssb/no-bare-kit-import', () => {
    const forms: [string, string][] = [
        ['a static import', "import { x } from '@sssb/kit/core/state-machine'\nexport { x }\n"],
        ['the package root', "export * from '@sssb/kit'\n"],
        ['a re-export', "export { x } from '@sssb/kit/core/state-machine'\n"],
        ['import()', "export const m = import('@sssb/kit/ports/errors')\n"],
        ['require()', "export const m = require('@sssb/kit/ports/errors')\n"],
        ['require.resolve()', "export const m = require.resolve('@sssb/kit/package.json')\n"],
        ['import.meta.resolve()', "export const m = import.meta.resolve('@sssb/kit/i18n/request')\n"],
        ['a template with no expressions', 'export const m = import(`@sssb/kit/ports/errors`)\n'],
        ["Vitest's vi.mock", "vi.mock('@sssb/kit/ports/errors')\n"],
        ["Vitest's vi.importActual", "export const m = vi.importActual('@sssb/kit/ports/errors')\n"],
    ]
    it.each(forms)('bans %s in @sssb/tools', async (_form, code) => {
        expect(await fired('packages/tools/src/probe.js', code)).toBe(1)
    })

    it("covers TypeScript's import-equals form", async () => {
        expect(
            await fired(
                'packages/tools/src/probe.ts',
                "import errors = require('@sssb/kit/ports/errors')\nexport { errors }\n",
            ),
        ).toBe(1)
    })

    it('covers a type import in a declaration file', async () => {
        expect(
            await fired('packages/tools/src/probe.d.ts', "export type T = import('@sssb/kit/ports/db').DbPort\n"),
        ).toBe(1)
    })

    it('covers an SSSB package nobody has named yet', async () => {
        expect(
            await fired('packages/eslint-plugin/src/probe.js', "export * from '@sssb/kit/core/state-machine'\n"),
        ).toBe(1)
    })

    it('lets the shared resolver build its specifier at run time', async () => {
        const code = "const KIT = '@sssb/kit'\nexport const f = (r, s) => r.resolve(`${KIT}/${s}`)\n"
        expect(await fired('packages/tools/src/probe.js', code)).toBe(0)
    })

    it('does not mistake a package whose name starts the same way', async () => {
        expect(await fired('packages/tools/src/probe.js', "export const m = import('@sssb/kitchen')\n")).toBe(0)
    })

    it.each([
        ['the framework itself', 'packages/kit/src/probe.ts'],
        ["the showcase's seed (app content)", 'packages/seed/src/probe.ts'],
        ['an app', 'apps/any-app/src/probe.ts'],
    ])('does not apply to %s', async (_what, file) => {
        expect(await fired(file, "export * from '@sssb/kit/core/state-machine'\n")).toBe(0)
    })
})
