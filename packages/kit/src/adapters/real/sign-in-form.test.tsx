import { MantineProvider } from '@mantine/core'
import { NextIntlClientProvider } from 'next-intl'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import enFramework from '../../i18n/messages/en.json'

/**
 * The real sign-in form with Clerk's hook replaced: where it sends the browser once sign-in completes, and the second
 * step Clerk asks for. `returnTo` comes from the URL, so a value that would leave the origin goes to `/` instead,
 * whatever the page passed. Never run against a real Clerk instance (cutover row `auth-dev`).
 */
type Answer = { error: { code: string } | null }
type Offered = { strategy: string; safeIdentifier?: string }
const ok: Answer = { error: null }
const refused: Answer = { error: { code: 'form_code_incorrect' } }

const signIn = {
    id: 'sia_1' as string | undefined,
    status: 'needs_identifier' as string,
    supportedSecondFactors: [] as readonly Offered[],
    password: vi.fn<() => Promise<Answer>>(),
    finalize: vi.fn<() => Promise<Answer>>(),
    reset: vi.fn<() => Promise<Answer>>(),
    mfa: {
        sendPhoneCode: vi.fn<() => Promise<Answer>>(),
        sendEmailCode: vi.fn<() => Promise<Answer>>(),
        verifyPhoneCode: vi.fn<() => Promise<Answer>>(),
        verifyEmailCode: vi.fn<() => Promise<Answer>>(),
        verifyTOTP: vi.fn<() => Promise<Answer>>(),
        verifyBackupCode: vi.fn<() => Promise<Answer>>(),
    },
}

vi.mock('@clerk/nextjs', () => ({ useSignIn: () => ({ signIn, fetchStatus: 'idle' }) }))

const LABELS = { email: 'email', password: 'password', submit: 'submit', genericError: 'error' }
const copy = enFramework.auth
const TOTP: Offered = { strategy: 'totp' }
const BACKUP: Offered = { strategy: 'backup_code' }
const PHONE: Offered = { strategy: 'phone_code', safeIdentifier: '+1*******99' }
const EMAIL: Offered = { strategy: 'email_code', safeIdentifier: 'a***r@example.test' }
const EMAIL_LINK: Offered = { strategy: 'email_link', safeIdentifier: 'a***r@example.test' }
const PASSKEY: Offered = { strategy: 'passkey' }

const VERIFY = {
    authenticator: signIn.mfa.verifyTOTP,
    backup: signIn.mfa.verifyBackupCode,
    phone: signIn.mfa.verifyPhoneCode,
    email: signIn.mfa.verifyEmailCode,
}

let root: Root
let container: HTMLElement
let assign: ReturnType<typeof vi.fn>

/** A Clerk call that succeeds and leaves the attempt at `status`. */
const leaves = (status: string) => async (): Promise<Answer> => {
    signIn.status = status
    return ok
}
const refuses = async (): Promise<Answer> => refused
const throws = async (): Promise<Answer> => {
    throw new Error('network down')
}

beforeEach(() => {
    ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
    signIn.id = 'sia_1'
    signIn.status = 'needs_identifier'
    signIn.supportedSecondFactors = []
    signIn.password.mockReset().mockImplementation(leaves('complete'))
    signIn.finalize.mockReset().mockResolvedValue(ok)
    signIn.reset.mockReset().mockResolvedValue(ok)
    for (const call of Object.values(signIn.mfa)) call.mockReset().mockResolvedValue(ok)
    for (const call of Object.values(VERIFY)) call.mockImplementation(leaves('complete'))
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

const submitForm = () =>
    act(async () => {
        const form = container.querySelector('form')
        if (!form) throw new Error('no form rendered')
        form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    })

async function render(returnTo: string): Promise<void> {
    const { RealSignInForm } = await import('./sign-in-form')
    await act(async () => {
        root.render(
            <NextIntlClientProvider locale="en" messages={enFramework}>
                <MantineProvider>
                    <RealSignInForm labels={LABELS} returnTo={returnTo} />
                </MantineProvider>
            </NextIntlClientProvider>,
        )
    })
}

async function submit(returnTo: string): Promise<void> {
    await render(returnTo)
    await submitForm()
}

async function signInWith(returnTo: string): Promise<unknown> {
    await submit(returnTo)
    expect(assign).toHaveBeenCalledTimes(1)
    return assign.mock.calls[0]?.[0]
}

/** The password is accepted, and the attempt then waits on a second step. */
async function reachStep(
    factors: readonly Offered[],
    status = 'needs_second_factor',
    returnTo = '/en/dashboard',
): Promise<void> {
    signIn.supportedSecondFactors = factors
    signIn.password.mockImplementation(leaves(status))
    await submit(returnTo)
}

const step = () => container.querySelector('[data-testid="second-factor-step"]')
const alertText = () => container.querySelector('[role="alert"]')?.textContent
const input = (selector: string) => container.querySelector<HTMLInputElement>(selector)!
const stepButton = (id: string) => container.querySelector<HTMLButtonElement>(`[data-testid="second-factor-${id}"]`)!
const click = (id: string) => act(async () => stepButton(id).click())
const choices = () => ['authenticator', 'phone', 'email', 'backup'].filter((kind) => stepButton(`choose-${kind}`))

async function fill(selector: string, value: string): Promise<void> {
    await act(async () => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input(selector), value)
        input(selector).dispatchEvent(new Event('input', { bubbles: true }))
    })
}
async function enterCode(code = '123456'): Promise<void> {
    await fill('input[name="code"]', code)
    await submitForm()
}

function expectNotSignedIn(): void {
    expect(signIn.finalize).not.toHaveBeenCalled()
    expect(assign).not.toHaveBeenCalled()
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
        signIn[call].mockImplementationOnce(throws)
        await submit('/en/dashboard')
        expect(alertText()).toBe('error')
        expect(assign).not.toHaveBeenCalled()
    })

    it.each(['password', 'finalize'] as const)('shows a refused %s as an alert', async (call) => {
        signIn[call].mockResolvedValueOnce(refused)
        await submit('/en/dashboard')
        expect(alertText()).toBe('error')
        expect(assign).not.toHaveBeenCalled()
    })

    it.each(['complete', 'needs_second_factor'])(
        'goes nowhere on a refused password, even with an attempt left at %s',
        async (status) => {
            signIn.supportedSecondFactors = [TOTP]
            signIn.status = status
            signIn.password.mockResolvedValueOnce(refused)
            await submit('/en/dashboard')
            expectNotSignedIn()
            expect(step()).toBeNull()
        },
    )

    it.each(['needs_identifier', 'needs_first_factor'])('shows the generic error at %s', async (status) => {
        await reachStep([TOTP], status)
        expect(alertText()).toBe('error')
        expectNotSignedIn()
    })

    it.each(['needs_new_password', 'needs_protect_check', 'needs_something_new', ''])(
        'says it cannot complete a sign-in at %j, and keeps the form',
        async (status) => {
            await reachStep([TOTP], status)
            expect(alertText()).toBe(copy.signInUnsupported)
            expect(input('input[type="email"]')).not.toBeNull()
            expectNotSignedIn()
        },
    )
})

describe.each(['needs_second_factor', 'needs_client_trust'])('the second step, at %s', (status) => {
    it.each([
        ['authenticator', TOTP],
        ['backup', BACKUP],
        ['phone', PHONE],
        ['email', EMAIL],
    ] as const)('signs in with the code: %s', async (kind, factor) => {
        await reachStep([factor], status, '/en/org?x=1')
        expect(step()).not.toBeNull()
        expectNotSignedIn()
        await enterCode()
        expect(VERIFY[kind].mock.calls).toEqual([[{ code: '123456' }]])
        for (const [other, call] of Object.entries(VERIFY)) if (other !== kind) expect(call).not.toHaveBeenCalled()
        expect(signIn.finalize).toHaveBeenCalledTimes(1)
        expect(assign.mock.calls).toEqual([['/en/org?x=1']])
    })

    it('checks returnTo after it too', async () => {
        await reachStep([TOTP], status, '/\\evil.example/x')
        await enterCode()
        expect(assign.mock.calls).toEqual([['/']])
    })

    it.each([
        ['an emailed link', [EMAIL_LINK]],
        ['a passkey', [PASSKEY]],
        ['one nobody has heard of', [{ strategy: 'telepathy' }]],
        ['nothing', []],
    ])('says it cannot complete the sign-in when the account offers only %s', async (_, factors) => {
        await reachStep(factors, status)
        expect(step()).toBeNull()
        expect(alertText()).toBe(copy.signInUnsupported)
        expectNotSignedIn()
    })

    it.each([
        ['refused (a wrong code)', refuses],
        ['expired', async (): Promise<Answer> => ({ error: { code: 'verification_expired' } })],
        ['rate-limited', async (): Promise<Answer> => ({ error: { code: 'too_many_requests' } })],
        ['answered with a throw', throws],
        ['accepted but leaves the attempt where it was', leaves(status)],
        ['accepted but leaves it at needs_identifier', leaves('needs_identifier')],
        ['accepted but leaves it at needs_first_factor', leaves('needs_first_factor')],
    ])('stays when the code is %s, and signs nobody in', async (_, answer) => {
        signIn.mfa.verifyTOTP.mockImplementationOnce(answer)
        await reachStep([TOTP, BACKUP], status)
        await enterCode()
        expect(step()).not.toBeNull()
        expect(alertText()).toBe(copy.codeError)
        expectNotSignedIn()
        // The next code signs in.
        await enterCode('654321')
        expect(assign).toHaveBeenCalledTimes(1)
    })

    it.each(['needs_new_password', 'needs_protect_check', 'needs_something_new'])(
        'goes back to the password with the unsupported message when the code leaves the attempt at %s',
        async (next) => {
            signIn.mfa.verifyTOTP.mockImplementationOnce(leaves(next))
            await reachStep([TOTP], status)
            await enterCode()
            expect(step()).toBeNull()
            expect(alertText()).toBe(copy.signInUnsupported)
            expectNotSignedIn()
        },
    )

    it('never finalizes on a refused code, even when the attempt reads complete', async () => {
        signIn.mfa.verifyTOTP.mockImplementationOnce(async () => {
            signIn.status = 'complete'
            return refused
        })
        await reachStep([TOTP], status)
        await enterCode()
        expectNotSignedIn()
        expect(alertText()).toBe(copy.codeError)
    })
})

describe('the factors offered', () => {
    it("keeps Clerk's order, backup codes last, and leaves out what it cannot take a code for", async () => {
        await reachStep([PASSKEY, BACKUP, PHONE, EMAIL_LINK, TOTP])
        expect(container.textContent).toContain(copy.codeLabelPhone)
        expect(choices()).toEqual(['authenticator', 'backup'])
        // In that order on the screen: the first is open, the backup code is the last choice.
        const ids = [...container.querySelectorAll('[data-testid^="second-factor-choose-"]')]
        expect(ids.map((element) => element.getAttribute('data-testid'))).toEqual([
            'second-factor-choose-authenticator',
            'second-factor-choose-backup',
        ])
    })

    it("names the number the code goes to, Clerk's first of several", async () => {
        await reachStep([PHONE, { ...PHONE, safeIdentifier: '+1*******11' }])
        expect(container.textContent).toContain('+1*******99')
        expect(container.textContent).not.toContain('+1*******11')
        expect(signIn.mfa.sendPhoneCode).toHaveBeenCalledTimes(1)
    })

    it('switches between them', async () => {
        await reachStep([TOTP, EMAIL])
        expect(signIn.mfa.sendEmailCode).not.toHaveBeenCalled()
        await click('choose-email')
        expect(signIn.mfa.sendEmailCode).toHaveBeenCalledTimes(1)
        expect(signIn.mfa.sendPhoneCode).not.toHaveBeenCalled()
        await enterCode()
        expect(signIn.mfa.verifyEmailCode).toHaveBeenCalledTimes(1)
        expect(signIn.mfa.verifyTOTP).not.toHaveBeenCalled()
    })

    it.each([
        ['phone', PHONE, signIn.mfa.sendPhoneCode],
        ['email', EMAIL, signIn.mfa.sendEmailCode],
    ] as const)('sends and resends: %s', async (_, factor, sendCode) => {
        vi.useFakeTimers()
        try {
            await reachStep([factor])
            expect(sendCode).toHaveBeenCalledTimes(1)
            await act(async () => vi.advanceTimersByTimeAsync(30_000))
            await click('resend')
            expect(sendCode).toHaveBeenCalledTimes(2)
        } finally {
            vi.useRealTimers()
        }
    })

    it.each([
        ['refused', refuses],
        ['answered with a throw', throws],
    ])('says so when the sending is %s', async (_, answer) => {
        signIn.mfa.sendPhoneCode.mockImplementationOnce(answer)
        await reachStep([PHONE])
        expect(step()).not.toBeNull()
        expect(alertText()).toBe(copy.codeSendError)
        expectNotSignedIn()
    })
})

describe('between one step and the next', () => {
    it('takes a second factor after a new device, as a step of its own', async () => {
        signIn.mfa.verifyEmailCode.mockImplementationOnce(async () => {
            signIn.status = 'needs_second_factor'
            signIn.supportedSecondFactors = [TOTP]
            return ok
        })
        await reachStep([EMAIL], 'needs_client_trust')
        expect(container.textContent).toContain(copy.secondFactorNewDevice)
        await enterCode()
        expectNotSignedIn()
        expect(container.textContent).toContain(copy.secondFactorLead)
        expect(input('input[name="code"]').value).toBe('')
        await enterCode()
        expect(signIn.mfa.verifyTOTP).toHaveBeenCalledTimes(1)
        expect(assign).toHaveBeenCalledTimes(1)
    })

    it('goes back to the password, the attempt dropped, the email kept and the password not', async () => {
        signIn.supportedSecondFactors = [TOTP]
        signIn.password.mockImplementation(leaves('needs_second_factor'))
        await render('/en/dashboard')
        await fill('input[type="email"]', 'ada@example.test')
        await fill('input[type="password"]', 'a password')
        await submitForm()
        await click('back')
        expect(step()).toBeNull()
        expect(signIn.reset).toHaveBeenCalledTimes(1)
        expect(input('input[type="email"]').value).toBe('ada@example.test')
        expect(input('input[type="password"]').value).toBe('')
        expect(document.activeElement).toBe(input('input[type="password"]'))
        expect(alertText()).toBeUndefined()
        expectNotSignedIn()
        // And there and back once more.
        await submitForm()
        expect(step()).not.toBeNull()
        await click('back')
        expect(document.activeElement).toBe(input('input[type="password"]'))
    })

    it.each([
        ['rejects', throws],
        [
            'throws',
            () => {
                throw new Error('no client')
            },
        ],
    ])('goes back even when the reset %s', async (_, reset) => {
        signIn.reset.mockImplementationOnce(reset)
        await reachStep([TOTP])
        await click('back')
        expect(step()).toBeNull()
        expect(alertText()).toBeUndefined()
    })
})

describe('a finalize that fails after the code was accepted', () => {
    it.each([
        ['refused', refuses],
        ['answered with a throw', throws],
    ])('is tried again without spending another code: %s', async (_, answer) => {
        signIn.finalize.mockImplementationOnce(answer)
        await reachStep([TOTP])
        await enterCode()
        expect(step()).not.toBeNull()
        expect(alertText()).toBe(copy.codeError)
        expect(assign).not.toHaveBeenCalled()
        await submitForm()
        expect(signIn.mfa.verifyTOTP).toHaveBeenCalledTimes(1)
        expect(signIn.finalize).toHaveBeenCalledTimes(2)
        expect(assign).toHaveBeenCalledTimes(1)
    })

    it.each([
        ['another attempt took its place', () => void (signIn.id = 'sia_2')],
        ['the attempt is no longer complete', () => void (signIn.status = 'needs_second_factor')],
        ['the attempt has lost its id', () => void (signIn.id = undefined)],
    ])('verifies again when %s', async (_, change) => {
        signIn.finalize.mockResolvedValueOnce(refused)
        await reachStep([TOTP])
        await enterCode()
        change()
        signIn.mfa.verifyTOTP.mockResolvedValueOnce(refused)
        await submitForm()
        expect(signIn.mfa.verifyTOTP).toHaveBeenCalledTimes(2)
        expect(signIn.finalize).toHaveBeenCalledTimes(1)
        expect(assign).not.toHaveBeenCalled()
    })

    it('is forgotten on the way back: the next step verifies its own code', async () => {
        signIn.finalize.mockResolvedValueOnce(refused)
        await reachStep([TOTP])
        await enterCode()
        await click('back')
        await submitForm()
        signIn.status = 'complete'
        signIn.mfa.verifyTOTP.mockResolvedValueOnce(refused)
        await enterCode()
        expect(signIn.mfa.verifyTOTP).toHaveBeenCalledTimes(2)
        expect(assign).not.toHaveBeenCalled()
    })
})
