import { describe, expect, test, vi } from 'vitest'
import { isRestricted } from './roles'

/**
 * Under a fixed org source everyone is `none` (or `restricted`), and both are restricted, so `restricted` cannot tell
 * an app's own admins from anyone else. An app grants its own people from its own data, and must do so BEFORE it denies
 * on `restricted`: a rule that denies first locks out everyone, its own admins included. SSSB keeps `none` restricted
 * (fail closed) and hands the app's rules the person's `userId` unchanged, so the grant is the app's to write.
 *
 * The two rules below stand in for an app's: `grantsFirst` checks its own admin list before the restricted denial,
 * `deniesFirst` the other way round. `sameOrg` holds for `restricted` (it has standing) and never for `none`.
 */
const APP_ADMINS = new Set(['user-admin'])

const rules = vi.hoisted(() => ({ order: 'grants-first' as 'grants-first' | 'denies-first' }))
vi.mock('@sssb/app-config/abilities', async (importOriginal) => {
    const original = await importOriginal<typeof import('@sssb/app-config/abilities')>()
    return {
        ...original,
        appAbilityRules: (
            actor: { userId: string; restricted: boolean },
            _action: unknown,
            subject: { orgId?: string | null },
            { sameOrg }: { sameOrg: (subject: { orgId?: string | null }) => boolean },
        ) => {
            if (rules.order === 'denies-first' && actor.restricted) return false
            if (APP_ADMINS.has(actor.userId)) return true
            if (actor.restricted) return false
            return sameOrg(subject)
        },
    }
})

const HOME = 'org-depot'
const docket = { type: 'Docket', orgId: HOME } as never

async function ability(role: 'none' | 'restricted', userId: string) {
    const { defineAbilitiesFor } = await import('./abilities')
    return defineAbilitiesFor({
        credential: { kind: 'session', id: null },
        manageAll: false,
        userId,
        role,
        restricted: isRestricted(undefined, role),
        activeOrgId: HOME,
    } as never)
}

describe("a fixed org source's people, as an app's rules see them", () => {
    test('both offered roles are restricted: none still fails closed', () => {
        expect(isRestricted(undefined, 'none')).toBe(true)
        expect(isRestricted(undefined, 'restricted')).toBe(true)
    })

    test.each(['none', 'restricted'] as const)(
        'with %s, a rule that grants from its own data before the restricted denial lets its admin in, no one else',
        async (role) => {
            rules.order = 'grants-first'
            expect((await ability(role, 'user-admin')).can('update', docket)).toBe(true)
            expect((await ability(role, 'user-other')).can('update', docket)).toBe(false)
        },
    )

    test.each(['none', 'restricted'] as const)(
        'with %s, a rule that denies on restricted first locks out everyone, its admin included',
        async (role) => {
            rules.order = 'denies-first'
            expect((await ability(role, 'user-admin')).can('update', docket)).toBe(false)
        },
    )

    test("the app's rules are handed sameOrg for restricted, never for none", async () => {
        const { defineAbilitiesFor } = await import('./abilities')
        const seen: boolean[] = []
        for (const role of ['none', 'restricted'] as const) {
            rules.order = 'grants-first'
            const actor = { credential: { kind: 'session', id: null }, manageAll: false, userId: 'user-other', role }
            const probe = defineAbilitiesFor({
                ...actor,
                restricted: false, // so the stand-in rule reaches sameOrg; restricted is not what is measured here
                activeOrgId: HOME,
            } as never)
            seen.push(probe.can('read', docket))
        }
        expect(seen).toEqual([false, true])
    })
})
