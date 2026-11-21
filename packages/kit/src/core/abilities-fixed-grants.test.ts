import { describe, expect, test, vi } from 'vitest'
import { isRestricted } from './roles'

/**
 * Under a fixed org source everyone is `none` (or `restricted`), and both are restricted, so `restricted` cannot tell
 * an app's own admins from anyone else. An app grants its own people from its own data, and must do so BEFORE it denies
 * on `restricted`: a rule that denies first locks out everyone, its own admins included. SSSB keeps `none` restricted
 * (fail closed) and hands the app's rules the person's `userId` and credential unchanged, so the grant is the app's to
 * write.
 *
 * The rule below stands in for an app's, written as the guide says: it grants its own admins by `userId`, and only
 * through a browser session (`credential.kind`), before the restricted denial. Every person credential reaches an
 * app's rules, and under a fixed org source an API token or an inbound email from an admin's account is judged with
 * the same `userId`; a grant meant for the admin at the keyboard must say so. `sameOrg` holds for `restricted` (it has
 * standing) and never for `none`.
 */
const APP_ADMINS = new Set(['user-admin'])

vi.mock('@sssb/app-config/abilities', async (importOriginal) => {
    const original = await importOriginal<typeof import('@sssb/app-config/abilities')>()
    return {
        ...original,
        appAbilityRules: (
            actor: { userId: string; restricted: boolean; credential?: { kind: string } },
            _action: unknown,
            subject: { orgId?: string | null },
            { sameOrg }: { sameOrg: (subject: { orgId?: string | null }) => boolean },
        ) => {
            if (actor.credential?.kind === 'session' && APP_ADMINS.has(actor.userId)) return true
            if (actor.restricted) return false
            return sameOrg(subject)
        },
    }
})

const HOME = 'org-depot'
const docket = { type: 'Docket', orgId: HOME } as never

async function ability(role: 'none' | 'restricted', userId: string, credential = 'session', restricted?: boolean) {
    const { defineAbilitiesFor } = await import('./abilities')
    return defineAbilitiesFor({
        credential: { kind: credential, id: credential === 'session' ? null : 'cred-1' },
        manageAll: false,
        userId,
        role,
        restricted: restricted ?? isRestricted(undefined, role),
        activeOrgId: HOME,
    } as never)
}

describe("a fixed org source's people, as an app's rules see them", () => {
    test('both offered roles are restricted: none still fails closed', () => {
        expect(isRestricted(undefined, 'none')).toBe(true)
        expect(isRestricted(undefined, 'restricted')).toBe(true)
    })

    test.each(['none', 'restricted'] as const)(
        "with %s, the app's own grant, made before the restricted denial, lets its admin in and no one else",
        async (role) => {
            expect((await ability(role, 'user-admin')).can('update', docket)).toBe(true)
            expect((await ability(role, 'user-other')).can('update', docket)).toBe(false)
        },
    )

    test.each(['inbound-email', 'token'])(
        "the admin's %s credential is not the admin at the keyboard: a session-only grant does not reach it",
        async (credential) => {
            expect((await ability('none', 'user-admin', credential)).can('update', docket)).toBe(false)
        },
    )

    test("the app's rules are handed sameOrg for restricted, never for none", async () => {
        // Unrestricted here so the stand-in rule reaches sameOrg: restricted is not what this measures.
        expect((await ability('none', 'user-other', 'session', false)).can('read', docket)).toBe(false)
        expect((await ability('restricted', 'user-other', 'session', false)).can('read', docket)).toBe(true)
    })
})
