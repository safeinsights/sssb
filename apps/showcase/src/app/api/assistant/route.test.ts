import { beforeEach, describe, expect, test, vi } from 'vitest'
import type { AuthUser } from '@sssb/kit/ports/auth'
import { POST } from './route'

const h = vi.hoisted(() => ({
    requireUser: vi.fn(),
    runToolLoop: vi.fn(),
    stream: vi.fn(),
    capture: vi.fn(),
    tenantIdForSlug: vi.fn(),
    orgIdForSlug: vi.fn(),
}))
vi.mock('@sssb/kit/adapters/index', () => ({
    auth: { requireUser: h.requireUser },
    llm: { runToolLoop: h.runToolLoop, stream: h.stream },
    analytics: { capture: h.capture },
    db: {},
}))
vi.mock('@sssb/kit/db/tenant-lookup', () => ({ tenantIdForSlug: h.tenantIdForSlug }))
vi.mock('@sssb/kit/db/org-lookup', () => ({ orgIdForSlug: h.orgIdForSlug }))
vi.mock('@sssb/kit/server-lib/assistant', () => ({ assistantExecutor: () => async () => '{}' }))
vi.mock('@sssb/app-config/assistant', () => ({
    ASSISTANT_COMPOSE_SYSTEM: 'compose',
    assistantComposePurpose: 'compose',
    assistantConfig: { purpose: 'gather', system: 'gather', tools: [] },
}))

const USER: AuthUser = {
    id: 'user-ada',
    name: 'Dana Okoye',
    email: 'dana.okoye@example.test',
    role: 'member',
    locale: 'en',
    tenantSlug: 'northwind',
    orgSlug: 'frontline',
    restricted: false,
}

function ask(body: string): Promise<Response> {
    return POST(new Request('http://localhost/api/assistant', { method: 'POST', body }))
}

beforeEach(() => {
    for (const fn of Object.values(h)) fn.mockReset()
    h.requireUser.mockResolvedValue(USER)
    h.tenantIdForSlug.mockResolvedValue('tenant-northwind')
    h.orgIdForSlug.mockResolvedValue('org-frontline')
    h.runToolLoop.mockResolvedValue({ text: 'gathered' })
})

describe('POST /api/assistant: the question', () => {
    test.each([
        ['not a string', JSON.stringify({ question: { a: 1 } })],
        ['empty', JSON.stringify({ question: '  ' })],
        ['over-long', JSON.stringify({ question: 'x'.repeat(2001) })],
        ['missing (body not an object)', 'null'],
        ['missing (body does not parse)', '{'],
    ])('400 when it is %s, and the model is never called', async (_label, body) => {
        expect((await ask(body)).status).toBe(400)
        expect(h.runToolLoop).not.toHaveBeenCalled()
    })
})

describe('POST /api/assistant: a failed compose stream', () => {
    test('tells the client only that it failed; the vendor detail stays in the server log', async () => {
        h.stream.mockReturnValue(
            (async function* () {
                yield 'Hello'
                throw new Error('overloaded_error: request req_secret_detail for model internal-name')
            })(),
        )
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
        try {
            const response = await ask(JSON.stringify({ question: 'What is open?' }))
            const text = await response.text()
            expect(text).toContain('{"error":"stream failed"}')
            expect(text).not.toContain('req_secret_detail')
            expect(warn).toHaveBeenCalledWith(expect.stringContaining('req_secret_detail'))
        } finally {
            warn.mockRestore()
        }
    })
})

// This route has no GET: its org-scoped read is authorized in POST, because the assistant's tools read the org's
// tickets.
describe('POST /api/assistant: the ticket read it authorizes', () => {
    const question = JSON.stringify({ question: 'What is open?' })

    test('a member is answered', async () => {
        h.stream.mockImplementation(async function* () {
            yield 'Two tickets are open.'
        })

        const response = await ask(question)

        expect(response.status).toBe(200)
        expect(await response.text()).toContain('Two tickets are open.')
        expect(h.runToolLoop).toHaveBeenCalled()
    })

    // By design, the opposite of the other routes: the assistant refuses a restricted member outright, before any
    // org lookup, even though Ticket read = sameOrg would allow them the queue itself.
    test('403 for a restricted member: the assistant is closed to them by design', async () => {
        h.requireUser.mockResolvedValue({ ...USER, role: 'restricted', restricted: true })

        expect((await ask(question)).status).toBe(403)
        expect(h.runToolLoop).not.toHaveBeenCalled()
    })

    test('403 for the role none even past the restricted check (no adapter makes one unrestricted): authorize refuses', async () => {
        h.requireUser.mockResolvedValue({ ...USER, role: 'none', restricted: false })

        expect((await ask(question)).status).toBe(403)
        expect(h.runToolLoop).not.toHaveBeenCalled()
    })
})
