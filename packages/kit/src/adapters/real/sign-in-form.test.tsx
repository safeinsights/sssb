import { MantineProvider } from '@mantine/core'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * The real sign-in form with Clerk's hook replaced: where it sends the browser once sign-in completes. `returnTo` comes
 * from the URL, so a value that would leave the origin goes to `/` instead, whatever the page passed. Never run against
 * a real Clerk instance (cutover row `auth-dev`).
 */
const signIn = {
    status: 'needs_identifier',
    password: vi.fn(async () => {
        signIn.status = 'complete'
        return { error: null }
    }),
    finalize: vi.fn(async () => ({ error: null })),
}

vi.mock('@clerk/nextjs', () => ({ useSignIn: () => ({ signIn, fetchStatus: 'idle' }) }))

const LABELS = {
    email: 'email',
    password: 'password',
    submit: 'submit',
    genericError: 'error',
    mfaNotImplemented: 'mfa',
}
let root: Root
let container: HTMLElement
let assign: ReturnType<typeof vi.fn>

beforeEach(() => {
    signIn.status = 'needs_identifier'
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

async function submit(returnTo: string): Promise<void> {
    const { RealSignInForm } = await import('./sign-in-form')
    await act(async () => {
        root.render(
            <MantineProvider>
                <RealSignInForm labels={LABELS} returnTo={returnTo} />
            </MantineProvider>,
        )
    })
    const form = container.querySelector('form')
    if (!form) throw new Error('no form rendered')
    await act(async () => {
        form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    })
}

async function signInWith(returnTo: string): Promise<unknown> {
    await submit(returnTo)
    expect(assign).toHaveBeenCalledTimes(1)
    return assign.mock.calls[0]?.[0]
}

describe('RealSignInForm', () => {
    it.each([
        '/\\evil.example/x',
        '/\t/evil.example/x',
        '//evil.example',
        'https://evil.example',
        'javascript:alert(1)',
    ])('goes to / instead of %j', async (returnTo) => {
        expect(await signInWith(returnTo)).toBe('/')
    })

    it('keeps a path on this origin, query and fragment included', async () => {
        expect(await signInWith('/en/org?x=1#y')).toBe('/en/org?x=1#y')
    })
    it.each(['password', 'finalize'] as const)('shows the error as an alert when %s throws', async (call) => {
        signIn[call].mockImplementationOnce(async () => {
            throw new Error('network down')
        })
        await submit('/en/dashboard')
        expect(container.querySelector('[role="alert"]')?.textContent).toBe('error')
        expect(assign).not.toHaveBeenCalled()
    })

    it('shows a refused sign-in as an alert', async () => {
        signIn.password.mockImplementationOnce(async () => ({ error: { code: 'form_password_incorrect' } }) as never)
        await submit('/en/dashboard')
        expect(container.querySelector('[role="alert"]')?.textContent).toBe('error')
    })
})
