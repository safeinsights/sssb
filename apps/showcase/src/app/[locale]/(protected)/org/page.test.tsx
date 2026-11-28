import { beforeEach, describe, expect, test, vi } from 'vitest'
import type { AuthUser } from '@sssb/kit/ports/auth'
import OrgPage from './page'

// The real authorize runs (pure abilities, the showcase's seam); only the adapters are faked.
const h = vi.hoisted(() => ({ getCurrentUser: vi.fn(), listMembers: vi.fn(), redirect: vi.fn() }))
vi.mock('@sssb/kit/adapters/index', () => ({
    auth: { getCurrentUser: h.getCurrentUser, listMembers: h.listMembers, signInPath: () => '/signin' },
}))
vi.mock('next/navigation', () => ({
    redirect: (to: string) => {
        h.redirect(to)
        throw new Error('NEXT_REDIRECT')
    },
}))
vi.mock('next-intl/server', () => ({ setRequestLocale: () => {} }))
vi.mock('./org-glue', () => ({ OrgGlue: () => null }))

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

const MEMBERS = [
    { id: 'user-dana', name: 'Dana Okoye', email: 'dana.okoye@example.test', role: 'member', status: 'active' },
]

beforeEach(() => {
    for (const fn of Object.values(h)) fn.mockReset()
    h.listMembers.mockResolvedValue(MEMBERS)
})

describe('the org page', () => {
    test('lists the team for a member of it', async () => {
        h.getCurrentUser.mockResolvedValue(user())
        const page = (await OrgPage({ params: Promise.resolve({ locale: 'en' }) })) as { props: { members: unknown } }
        expect(page.props.members).toEqual(MEMBERS)
    })

    test('sends a person placed in the org without standing (the role none) to their profile, never reading the members', async () => {
        h.getCurrentUser.mockResolvedValue(user({ role: 'none', restricted: true }))
        await expect(OrgPage({ params: Promise.resolve({ locale: 'en' }) })).rejects.toThrow('NEXT_REDIRECT')
        expect(h.redirect).toHaveBeenCalledWith('/en/profile')
        expect(h.listMembers).not.toHaveBeenCalled()
    })
})
