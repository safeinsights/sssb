import { beforeEach, describe, expect, test, vi } from 'vitest'
import type { AuthUser } from '@sssb/kit/ports/auth'
import { POST } from './route'

// This route has no GET: its org-scoped read is authorized in POST, because the assistant's tools read the
// org's tickets. Real authorize (pure abilities) runs — only the adapters and data modules are faked.
// Low-entropy fixture ids/slugs (gitleaks): no hex, no UUIDs.
const h = vi.hoisted(() => ({
    requireUser: vi.fn(),
    tenantIdForSlug: vi.fn(),
    orgIdForSlug: vi.fn(),
    runToolLoop: vi.fn(),
    stream: vi.fn(),
    capture: vi.fn(),
}))
vi.mock('@sssb/kit/adapters/index', () => ({
    auth: { requireUser: h.requireUser },
    db: {},
    llm: { runToolLoop: h.runToolLoop, stream: h.stream },
    analytics: { capture: h.capture },
}))
vi.mock('@sssb/kit/db/tenant-lookup', () => ({ tenantIdForSlug: h.tenantIdForSlug }))
vi.mock('@sssb/kit/db/org-lookup', () => ({ orgIdForSlug: h.orgIdForSlug }))

function user(overrides: Partial<AuthUser> = {}): AuthUser {
    return {
        id: 'user-ada',
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

function ask(): Promise<Response> {
    return POST(
        new Request('http://localhost/api/assistant', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ question: 'What is open?' }),
        }),
    )
}

beforeEach(() => {
    for (const fn of Object.values(h)) fn.mockReset()
    h.requireUser.mockResolvedValue(user())
    h.tenantIdForSlug.mockResolvedValue('tenant-northwind')
    h.orgIdForSlug.mockResolvedValue('org-frontline')
    h.runToolLoop.mockResolvedValue({ text: 'gathered' })
    h.stream.mockImplementation(async function* () {
        yield 'Two tickets are open.'
    })
})

describe('POST /api/assistant (the ticket read it authorizes)', () => {
    test('streams the sources line then the answer for a member', async () => {
        const response = await ask()

        expect(response.status).toBe(200)
        const lines = (await response.text()).trim().split('\n')
        expect(JSON.parse(lines[0] ?? '')).toEqual({ sources: [] })
        expect(JSON.parse(lines[1] ?? '')).toEqual({ delta: 'Two tickets are open.' })
    })

    // By design, the opposite of the other routes: the assistant refuses a restricted member outright, before any
    // org lookup, even though Ticket read = sameOrg would allow them the queue itself.
    test('403 for a restricted member: the assistant is closed to them by design', async () => {
        h.requireUser.mockResolvedValue(user({ role: 'restricted', restricted: true }))

        expect((await ask()).status).toBe(403)
        expect(h.runToolLoop).not.toHaveBeenCalled()
    })

    test('403 for a person with the role none, who is not restricted: authorize refuses the Ticket read', async () => {
        h.requireUser.mockResolvedValue(user({ role: 'none', restricted: false }))

        expect((await ask()).status).toBe(403)
        expect(h.runToolLoop).not.toHaveBeenCalled()
    })
})
