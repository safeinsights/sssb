import { beforeEach, describe, expect, test, vi } from 'vitest'
import type { AuthUser } from '@sssb/kit/ports/auth'
import DashboardPage from './page'

// The real authorize and canInActiveOrg run (pure abilities, the showcase's seam); only the adapters are faked.
const h = vi.hoisted(() => ({ getCurrentUser: vi.fn(), listMembers: vi.fn(), redirect: vi.fn() }))
vi.mock('@sssb/kit/adapters/index', () => ({
    auth: { getCurrentUser: h.getCurrentUser, listMembers: h.listMembers, signInPath: () => '/signin' },
    analytics: { isFlagEnabled: async () => false },
}))
vi.mock('next/navigation', () => ({
    redirect: (to: string) => {
        h.redirect(to)
        throw new Error('NEXT_REDIRECT')
    },
}))
vi.mock('next-intl/server', () => ({ setRequestLocale: () => {} }))
vi.mock('./dashboard-glue', () => ({ DashboardGlue: () => null }))

function user(overrides: Partial<AuthUser> = {}): AuthUser {
    return {
        id: 'user-dana',
        name: 'Dana Okoye',
        email: 'dana.okoye@example.test',
        role: 'member',
        locale: 'en',
        tenantSlug: 'northwind',
        orgSlug: 'frontline',
        restricted: false,
        ...overrides,
    }
}

async function render() {
    return (await DashboardPage({ params: Promise.resolve({ locale: 'en' }) })) as {
        props: { assignees: Array<{ id: string; name: string }> }
    }
}

beforeEach(() => {
    for (const fn of Object.values(h)) fn.mockReset()
    h.listMembers.mockResolvedValue([
        { id: 'user-dana', name: 'Dana Okoye', email: 'dana.okoye@example.test', role: 'member', status: 'active' },
        { id: 'user-ivo', name: null, email: 'ivo@example.test', role: 'member', status: 'active' },
        { id: 'user-pat', name: 'Pat Invitee', email: 'pat@example.test', role: 'member', status: 'invited' },
    ])
})

describe('the dashboard (safeinsights/sssb#259)', () => {
    test("gives a member of the team the team's active members to assign to", async () => {
        h.getCurrentUser.mockResolvedValue(user())
        expect((await render()).props.assignees).toEqual([
            { id: 'user-dana', name: 'Dana Okoye' },
            { id: 'user-ivo', name: 'ivo@example.test' },
        ])
        expect(h.listMembers).toHaveBeenCalledWith('frontline')
    })

    test('sends a person placed in the org without standing (the role none) to their profile, never reading the members', async () => {
        h.getCurrentUser.mockResolvedValue(user({ role: 'none', restricted: true }))
        // Next's redirect throws its own NEXT_REDIRECT, which it answers with a redirect, not an error page.
        await expect(render()).rejects.toThrow('NEXT_REDIRECT')
        expect(h.redirect).toHaveBeenCalledWith('/en/profile')
        expect(h.listMembers).not.toHaveBeenCalled()
    })

    test('sends a signed-out visitor to sign in, and reads nothing', async () => {
        h.getCurrentUser.mockResolvedValue(null)
        await expect(render()).rejects.toThrow('NEXT_REDIRECT')
        expect(h.redirect).toHaveBeenCalledWith('/en/signin')
        expect(h.listMembers).not.toHaveBeenCalled()
    })
})
