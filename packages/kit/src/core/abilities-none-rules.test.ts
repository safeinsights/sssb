import { describe, expect, test, vi } from 'vitest'

/**
 * The app's rules are shown a person without standing as active in no org, so a rule that compares org ids itself,
 * rather than calling the `sameOrg` it is handed, cannot grant the role `none` either. The showcase's two-sided
 * `Escalation` rule is that shape (it compares `activeOrgId` with the requester and responder sides).
 */
const seen = vi.hoisted(() => ({ activeOrgId: [] as unknown[] }))
vi.mock('@sssb/app-config/abilities', async (importOriginal) => {
    const original = await importOriginal<typeof import('@sssb/app-config/abilities')>()
    return {
        ...original,
        appAbilityRules: (actor: { activeOrgId: unknown }, _action: unknown, subject: { orgId?: unknown }) => {
            seen.activeOrgId.push(actor.activeOrgId)
            // A rule written against the actor's org directly, as a two-sided subject's is.
            return subject.orgId === actor.activeOrgId
        },
    }
})

describe("a person without standing, as the app's rules see it", () => {
    test('is active in no org, so a rule comparing org ids itself grants nothing', async () => {
        const { defineAbilitiesFor } = await import('./abilities')
        const base = { credential: { kind: 'session', id: null }, userId: 'u', restricted: true, manageAll: false }
        const none = defineAbilitiesFor({ ...base, role: 'none', activeOrgId: 'org-a' } as never)
        expect(none.can('read', { type: 'Docket', orgId: 'org-a' } as never)).toBe(false)
        // For contrast: a member is shown its real org, and the same rule grants it.
        const member = defineAbilitiesFor({ ...base, role: 'member', restricted: false, activeOrgId: 'org-a' } as never)
        expect(member.can('read', { type: 'Docket', orgId: 'org-a' } as never)).toBe(true)
        expect(seen.activeOrgId).toEqual([expect.not.stringMatching(/^org-a$/), 'org-a'])
    })
})
