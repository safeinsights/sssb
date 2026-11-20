import { MantineProvider } from '@mantine/core'
import { act, StrictMode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * The real accept-invite form with Clerk's hooks replaced: which ticket call it makes for each `__clerk_status`, and
 * that it makes it once. A ticket is single-use, and Clerk's resources change identity as clerk-js loads, so a form that
 * re-ran on that change, or under StrictMode's double effect, would submit the ticket twice and could report an error
 * for an invitation that was accepted. Never run against a real Clerk instance (cutover row `auth-dev`).
 */
const h = vi.hoisted(() => ({ isLoaded: true, signIn: {} as Flow, signUp: {} as Flow }))

interface Flow {
    status: string
    ticket: ReturnType<typeof vi.fn>
    finalize: ReturnType<typeof vi.fn>
}

function flow(): Flow {
    const resource: Flow = {
        status: 'needs_identifier',
        ticket: vi.fn(async () => {
            resource.status = 'complete'
            return { error: null }
        }),
        finalize: vi.fn(async () => ({ error: null })),
    }
    return resource
}

vi.mock('@clerk/nextjs', () => ({
    useAuth: () => ({ isLoaded: h.isLoaded }),
    useSignIn: () => ({ signIn: h.signIn, fetchStatus: 'idle' }),
    useSignUp: () => ({ signUp: h.signUp, fetchStatus: 'idle' }),
}))

const LABELS = { missingTicket: 'missing', accepting: 'accepting', oneMoment: 'one moment', genericError: 'error' }
let root: Root
let container: HTMLElement
let assign: ReturnType<typeof vi.fn>

beforeEach(() => {
    h.isLoaded = true
    h.signIn = flow()
    h.signUp = flow()
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
    assign = vi.fn()
    vi.stubGlobal('location', { ...window.location, assign })
})
afterEach(() => {
    act(() => root.unmount())
    container.remove()
    vi.unstubAllGlobals()
})

async function render(props: { ticket: string | null; status?: string | null }): Promise<void> {
    const { RealAcceptInviteForm } = await import('./accept-invite-form')
    await act(async () => {
        root.render(
            <StrictMode>
                <MantineProvider>
                    <RealAcceptInviteForm {...props} redirectTo="/en/dashboard" labels={LABELS} />
                </MantineProvider>
            </StrictMode>,
        )
    })
}

describe('RealAcceptInviteForm', () => {
    it('signs up with the ticket once, under StrictMode and as the resources change identity, then redirects', async () => {
        await render({ ticket: 't-1', status: 'sign_up' })
        // clerk-js finishes loading: the hooks now hand back new resource objects.
        const before = h.signUp
        h.signUp = flow()
        h.signIn = flow()
        await render({ ticket: 't-1', status: 'sign_up' })
        expect(before.ticket).toHaveBeenCalledTimes(1)
        expect(before.ticket).toHaveBeenCalledWith({ ticket: 't-1' })
        expect(h.signUp.ticket).not.toHaveBeenCalled()
        expect(assign).toHaveBeenCalledWith('/en/dashboard')
    })

    it('waits for Clerk to load before submitting the ticket', async () => {
        h.isLoaded = false
        await render({ ticket: 't-2', status: 'sign_up' })
        expect(h.signUp.ticket).not.toHaveBeenCalled()
        h.isLoaded = true
        await render({ ticket: 't-2', status: 'sign_up' })
        expect(h.signUp.ticket).toHaveBeenCalledTimes(1)
    })

    it('signs in by ticket an invitee who already has an account', async () => {
        await render({ ticket: 't-3', status: 'sign_in' })
        expect(h.signIn.ticket).toHaveBeenCalledWith({ ticket: 't-3' })
        expect(h.signUp.ticket).not.toHaveBeenCalled()
        expect(h.signIn.finalize).toHaveBeenCalledTimes(1)
        expect(assign).toHaveBeenCalledWith('/en/dashboard')
    })

    it('redirects without a ticket call when Clerk already accepted the invitation', async () => {
        await render({ ticket: null, status: 'complete' })
        expect(h.signIn.ticket).not.toHaveBeenCalled()
        expect(h.signUp.ticket).not.toHaveBeenCalled()
        expect(assign).toHaveBeenCalledWith('/en/dashboard')
    })

    it('treats a missing status as a sign-up, and shows the error for one it does not know', async () => {
        await render({ ticket: 't-4' })
        expect(h.signUp.ticket).toHaveBeenCalledTimes(1)
        h.signUp = flow()
        await render({ ticket: 't-5', status: 'something_new' })
        expect(h.signUp.ticket).not.toHaveBeenCalled()
        expect(h.signIn.ticket).not.toHaveBeenCalled()
        expect(container.textContent).toContain('error')
    })
    it('shows the error as an alert, and submits the ticket again once Clerk reloads, when a ticket call throws', async () => {
        const failing = h.signUp
        failing.ticket.mockImplementationOnce(async () => {
            throw new Error('network down')
        })
        await render({ ticket: 't-6', status: 'sign_up' })
        expect(failing.ticket).toHaveBeenCalledTimes(1)
        expect(container.querySelector('[role="alert"]')?.textContent).toBe('error')
        expect(assign).not.toHaveBeenCalled()

        h.isLoaded = false
        await render({ ticket: 't-6', status: 'sign_up' })
        h.isLoaded = true
        await render({ ticket: 't-6', status: 'sign_up' })
        expect(failing.ticket).toHaveBeenCalledTimes(2)
        expect(assign).toHaveBeenCalledWith('/en/dashboard')
        expect(container.querySelector('[role="alert"]')).toBeNull()
    })

    it('shows the error as an alert when finalizing throws', async () => {
        h.signIn.finalize.mockImplementationOnce(async () => {
            throw new Error('network down')
        })
        await render({ ticket: 't-7', status: 'sign_in' })
        expect(container.querySelector('[role="alert"]')?.textContent).toBe('error')
        expect(assign).not.toHaveBeenCalled()
    })
})
