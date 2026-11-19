import path from 'node:path'
import { describe, expect, it } from 'vitest'
import registry from './checks.json'
import { conformanceSuite } from './index'

/**
 * The conformance suite, run against the framework's OWN seam (packages/kit/test-fixture), exactly as every app runs
 * it against its own from `src/sssb.conformance.test.ts`. The fixture opts out of two checks, which also keeps the
 * opt-out path exercised: its routes are a reference tree under `test-fixture/api`, not an app's `src/app`, and the
 * kit's own scan (packages/kit/src/authz/authorized-mutations.test.ts) is what walks them; and with no `src/app` it
 * renders no page to hold to `real-auth-provider`, which ./conformance/auth-provider.test.ts runs on scratch apps.
 */
conformanceSuite({
    appDir: path.resolve(import.meta.dirname, '../../test-fixture'),
    optOut: {
        'authz-mutations':
            "the fixture's routes live under test-fixture/api, not src/app; authorized-mutations.test.ts scans them",
        'real-auth-provider':
            'the fixture has no src/app and renders no page; auth-provider.test.ts runs the check on scratch apps',
    },
})

describe('conformanceSuite refuses, while the file is collected', () => {
    it('an opt-out naming a check it does not register', () => {
        expect(() => conformanceSuite({ appDir: '.', optOut: { 'i18n-parit': 'typo' } })).toThrow(
            /optOut names "i18n-parit", which is not a check this suite registers/,
        )
        // A contract check is not the unit suite's to leave out.
        expect(() => conformanceSuite({ appDir: '.', optOut: { 'contract-rls': 'not here' } })).toThrow(
            /optOut names "contract-rls"/,
        )
    })

    it('an opt-out without a reason', () => {
        expect(() => conformanceSuite({ appDir: '.', optOut: { 'seam-map': '  ' } })).toThrow(
            /optOut "seam-map" needs a reason/,
        )
    })
})

describe('checks.json', () => {
    it('names each check once, with a runner, a title and fixed test names', () => {
        const ids = registry.checks.map((check) => check.id)
        expect(new Set(ids).size).toBe(ids.length)
        for (const check of registry.checks) {
            expect(['unit', 'contract'], check.id).toContain(check.runner)
            expect(check.title.length, check.id).toBeGreaterThan(0)
            expect(check.tests.length, check.id).toBeGreaterThan(0)
            expect(new Set(check.tests).size, check.id).toBe(check.tests.length)
            // Vitest formats `%` sequences in some names; a full name doctor computes must be the name Vitest lists.
            expect(
                [check.title, ...check.tests].filter((name) => name.includes('%') || name.includes(' > ')),
                check.id,
            ).toEqual([])
        }
    })
})
