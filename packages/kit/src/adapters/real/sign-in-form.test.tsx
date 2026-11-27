import { MantineProvider } from '@mantine/core'
import { NextIntlClientProvider } from 'next-intl'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import enFramework from '../../i18n/messages/en.json'

/**
 * The real sign-in form with Clerk's hook replaced: where it sends the browser once sign-in completes, and the second
 * step Clerk asks for. `returnTo` comes from the URL, so a value that would leave the origin goes to `/` instead,
 * whatever the page passed. Nothing is submitted before clerk-js has loaded, and going back after Clerk accepted a code
 * signs that session out (safeinsights/sssb#198). Never run against a real Clerk instance (cutover row `auth-dev`).
 */
type Answer = { error: { code: string } | null }
type Verification = { strategy?: string; status?: string; expireAt?: Date | string | null }
type Offered = { strategy: string; safeIdentifier?: string }
const ok: Answer = { error: null }
const refused: Answer = { error: { code: 'form_code_incorrect' } }

const signIn = {
    id: 'sia_1' as string | undefined,
    secondFactorVerification: {} as Verification | undefined,
    status: 'needs_identifier' as string,
    // The session Clerk gives an attempt once it is complete.
    createdSessionId: null as string | null,
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

/** What the hook answers: `signIn`, until a client update puts another attempt in its place. */
const hook = { signIn }
/**
 * What `useClerk` answers: whether clerk-js has loaded, the sessions its client holds signed in, and its client sign-out,
 * which (as Clerk's) takes the session off the client.
 */
const clerk = {
    loaded: true,
    client: { signedInSessions: [] as { id: string }[] },
    signOut: vi.fn<(options: { sessionId: string; redirectUrl: string }) => Promise<void>>(),
}
vi.mock('@clerk/nextjs', () => ({
    useSignIn: () => ({ signIn: hook.signIn, fetchStatus: 'idle' }),
    useClerk: () => clerk,
}))

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

/** A Clerk call that succeeds and leaves the attempt at `status`, its verification rebuilt as by every answer. */
const leaves = (status: string) => async (): Promise<Answer> => {
    signIn.status = status
    signIn.createdSessionId = status === 'complete' ? 'sess_1' : null
    signIn.secondFactorVerification = {}
    return ok
}
const refuses = async (): Promise<Answer> => refused
const throws = async (): Promise<Answer> => {
    throw new Error('network down')
}

beforeEach(() => {
    ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
    hook.signIn = signIn
    signIn.id = 'sia_1'
    signIn.secondFactorVerification = {}
    signIn.status = 'needs_identifier'
    signIn.createdSessionId = null
    signIn.supportedSecondFactors = []
    clerk.loaded = true
    clerk.client.signedInSessions = [{ id: 'sess_1' }]
    clerk.signOut.mockReset().mockImplementation(async ({ sessionId }) => {
        clerk.client.signedInSessions = clerk.client.signedInSessions.filter((session) => session.id !== sessionId)
    })
    signIn.password.mockReset().mockImplementation(leaves('complete'))
    signIn.finalize.mockReset().mockResolvedValue(ok)
    signIn.reset.mockReset().mockResolvedValue(ok)
    for (const call of Object.values(signIn.mfa)) call.mockReset().mockImplementation(() => leaves(signIn.status)())
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

    it.each(['complete', 'needs_second_factor'])(
        'goes nowhere on a refused password that moved the attempt to %s',
        async (status) => {
            signIn.supportedSecondFactors = [TOTP]
            signIn.password.mockImplementationOnce(async () => {
                await leaves(status)()
                return refused
            })
            await submit('/en/dashboard')
            expect(alertText()).toBe('error')
            expectNotSignedIn()
            expect(step()).toBeNull()
        },
    )

    it('shows no old error while it tries again, and takes no second submit', async () => {
        signIn.password.mockResolvedValueOnce(refused)
        await submit('/en/dashboard')
        signIn.password.mockReturnValueOnce(new Promise(() => {}))
        await submitForm()
        expect(alertText()).toBeUndefined()
        expect(container.querySelector<HTMLButtonElement>('[type="submit"]')!.disabled).toBe(true)
    })

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
        [
            'refused, with the attempt changed',
            async () => {
                await leaves('needs_second_factor')()
                return refused
            },
        ],
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

    it('leaves the password ready while a code is still being sent', async () => {
        signIn.mfa.sendPhoneCode.mockReturnValue(new Promise(() => {}))
        await reachStep([PHONE])
        await click('back')
        expect(container.querySelector<HTMLButtonElement>('[type="submit"]')!.disabled).toBe(false)
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

describe('the attempt a step is on', () => {
    /** Another attempt takes the first one's place in the hook, as clerk-js does, and the form renders again. */
    async function replaceAttempt(status: string): Promise<typeof signIn> {
        const other = {
            ...signIn,
            status,
            finalize: vi.fn<() => Promise<Answer>>().mockResolvedValue(ok),
            mfa: { ...signIn.mfa, verifyTOTP: vi.fn<() => Promise<Answer>>().mockResolvedValue(ok) },
        }
        hook.signIn = other
        await render('/en/dashboard')
        return other
    }

    it.each(['needs_identifier', 'needs_second_factor', 'complete'])(
        'is the one its password opened, whatever took its place (%s)',
        async (status) => {
            await reachStep([TOTP])
            const other = await replaceAttempt(status)
            await enterCode()
            expect(signIn.mfa.verifyTOTP).toHaveBeenCalledTimes(1)
            expect(signIn.finalize).toHaveBeenCalledTimes(1)
            expect(other.mfa.verifyTOTP).not.toHaveBeenCalled()
            expect(other.finalize).not.toHaveBeenCalled()
            expect(assign).toHaveBeenCalledTimes(1)
        },
    )

    it('is still the one finalized when a finalize failed half-way and left the hook an empty one', async () => {
        signIn.finalize.mockResolvedValueOnce(refused)
        await reachStep([TOTP])
        await enterCode()
        const other = await replaceAttempt('needs_identifier')
        await submitForm()
        expect(signIn.mfa.verifyTOTP).toHaveBeenCalledTimes(1)
        expect(other.mfa.verifyTOTP).not.toHaveBeenCalled()
        expect(signIn.finalize).toHaveBeenCalledTimes(2)
        expect(assign).toHaveBeenCalledTimes(1)
    })
})

describe('a request clerk-js dropped, which it answers with no error', () => {
    const dropped = async (): Promise<Answer> => ok

    it.each(['complete', 'needs_second_factor'])(
        'acts on no attempt left at %s by an earlier password',
        async (status) => {
            signIn.status = status
            signIn.supportedSecondFactors = [TOTP]
            signIn.password.mockImplementation(dropped)
            await submit('/en/dashboard')
            expect(alertText()).toBe('error')
            expect(step()).toBeNull()
            expectNotSignedIn()
        },
    )

    it.each([
        ['phone', PHONE, signIn.mfa.sendPhoneCode],
        ['email', EMAIL, signIn.mfa.sendEmailCode],
    ] as const)('never says a code was sent: %s', async (_, factor, sendCode) => {
        sendCode.mockImplementation(dropped)
        await reachStep([factor])
        expect(alertText()).toBe(copy.codeSendError)
        expect(stepButton('resend').disabled).toBe(false)
    })

    it('lets a code in anyway, if one did arrive and only the sending looked dropped', async () => {
        signIn.mfa.sendPhoneCode.mockImplementation(dropped)
        await reachStep([PHONE])
        expect(alertText()).toBe(copy.codeSendError)
        await enterCode()
        expect(assign).toHaveBeenCalledTimes(1)
    })

    it('signs nobody in on a code that was dropped', async () => {
        signIn.mfa.verifyTOTP.mockImplementation(dropped)
        await reachStep([TOTP])
        await enterCode()
        expect(alertText()).toBe(copy.codeError)
        expectNotSignedIn()
    })
})

describe('a clerk-js that never rebuilds the verification', () => {
    const inPlace = (change: () => void) => async (): Promise<Answer> => {
        change()
        return ok
    }

    it.each([{}, undefined, { expireAt: null }, { expireAt: 'soon' }])(
        'still takes a password that moves the status, verification %j',
        async (verification) => {
            signIn.secondFactorVerification = verification
            signIn.password.mockImplementation(inPlace(() => (signIn.status = 'complete')))
            expect(await signInWith('/en/dashboard')).toBe('/en/dashboard')
        },
    )

    it.each(['complete', 'needs_second_factor'])(
        'still takes a password that starts another attempt at the same status (%s)',
        async (status) => {
            signIn.status = status
            signIn.supportedSecondFactors = [TOTP]
            signIn.password.mockImplementation(inPlace(() => (signIn.id = 'sia_2')))
            await submit('/en/dashboard')
            expect(alertText()).toBeUndefined()
            if (status === 'complete') expect(assign).toHaveBeenCalledTimes(1)
            else expect(step()).not.toBeNull()
        },
    )

    it('still refuses a password that answers no error and changes nothing', async () => {
        signIn.status = 'complete'
        signIn.password.mockResolvedValue(ok)
        await submit('/en/dashboard')
        expect(alertText()).toBe('error')
        expectNotSignedIn()
    })

    it.each([
        ['strategy', { strategy: 'phone_code' }],
        ['status', { status: 'unverified' }],
        ['expiry', { expireAt: new Date(2) }],
    ])('still sees a code sent by its %s', async (_, change) => {
        signIn.secondFactorVerification = { strategy: 'totp', status: 'x', expireAt: new Date(1) }
        signIn.password.mockImplementation(inPlace(() => (signIn.status = 'needs_second_factor')))
        signIn.mfa.sendPhoneCode.mockImplementation(
            inPlace(() => Object.assign(signIn.secondFactorVerification ?? {}, change)),
        )
        signIn.supportedSecondFactors = [PHONE]
        await submit('/en/dashboard')
        expect(step()).not.toBeNull()
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

    it('verifies again when the attempt is no longer complete', async () => {
        signIn.finalize.mockResolvedValueOnce(refused)
        await reachStep([TOTP])
        await enterCode()
        signIn.status = 'needs_second_factor'
        signIn.mfa.verifyTOTP.mockResolvedValueOnce(refused)
        await submitForm()
        expect(signIn.mfa.verifyTOTP).toHaveBeenCalledTimes(2)
        expect(signIn.finalize).toHaveBeenCalledTimes(1)
        expect(assign).not.toHaveBeenCalled()
    })

    // Going back otherwise signs the session out; here the client no longer holds it, so it is only forgotten.
    it('is forgotten on the way back: the next step verifies its own code', async () => {
        signIn.finalize.mockResolvedValueOnce(refused)
        await reachStep([TOTP])
        await enterCode()
        clerk.client.signedInSessions = []
        await click('back')
        expect(clerk.signOut).not.toHaveBeenCalled()
        await submitForm()
        signIn.status = 'complete'
        signIn.mfa.verifyTOTP.mockResolvedValueOnce(refused)
        await enterCode()
        expect(signIn.mfa.verifyTOTP).toHaveBeenCalledTimes(2)
        expect(assign).not.toHaveBeenCalled()
    })
})

describe('a password submitted before clerk-js has loaded (safeinsights/sssb#198)', () => {
    const button = () => container.querySelector<HTMLButtonElement>('button[type="submit"]')!

    it('is held: no call is made, and the button shows it is busy, until Clerk has loaded', async () => {
        clerk.loaded = false
        await submit('/en/dashboard')
        expect(signIn.password).not.toHaveBeenCalled()
        expect(button().disabled).toBe(true)
        expect(alertText()).toBeUndefined()
        clerk.loaded = true
        await render('/en/dashboard')
        expect(button().disabled).toBe(false)
        await submitForm()
        expect(signIn.password).toHaveBeenCalledTimes(1)
        expect(assign).toHaveBeenCalledTimes(1)
    })
})

describe('going back after Clerk accepted the code (safeinsights/sssb#198)', () => {
    it("signs out the session the code created, this one only, back to this page, through Clerk's client", async () => {
        signIn.finalize.mockResolvedValueOnce(refused)
        await reachStep([TOTP])
        await enterCode()
        expect(step()).not.toBeNull()
        await click('back')
        expect(clerk.signOut).toHaveBeenCalledWith({ sessionId: 'sess_1', redirectUrl: window.location.href })
        expect(signIn.reset).not.toHaveBeenCalled()
        expect(alertText()).toBeUndefined()
    })

    it('says so when Clerk refuses the sign-out', async () => {
        signIn.finalize.mockResolvedValueOnce(refused)
        clerk.signOut.mockRejectedValueOnce(new Error('network'))
        await reachStep([TOTP])
        await enterCode()
        await click('back')
        expect(alertText()).toBe(copy.refusedSignOutError)
    })

    it('signs nobody out before a code was accepted: the attempt is only dropped', async () => {
        await reachStep([TOTP])
        signIn.mfa.verifyTOTP.mockResolvedValueOnce(refused)
        await enterCode()
        await click('back')
        expect(clerk.signOut).not.toHaveBeenCalled()
        expect(signIn.reset).toHaveBeenCalledTimes(1)
    })
})

describe('a session the form saw created, when signing in does not finish (safeinsights/sssb#198)', () => {
    const signOutButton = () => container.querySelector<HTMLButtonElement>('[data-testid="sign-in-sign-out"]')
    const submitButton = () => container.querySelector<HTMLButtonElement>('button[type="submit"]')!

    it('is still the one signed out when a finalize failed half-way and emptied the attempt', async () => {
        signIn.finalize.mockImplementationOnce(async () => {
            signIn.status = 'needs_identifier'
            signIn.createdSessionId = null
            return refused
        })
        await reachStep([TOTP])
        await enterCode()
        hook.signIn = { ...signIn, createdSessionId: null, status: 'needs_identifier' }
        await click('back')
        expect(clerk.signOut).toHaveBeenCalledWith({ sessionId: 'sess_1', redirectUrl: window.location.href })
    })

    it('can be signed out from the password form when the password alone completed and finalize failed', async () => {
        signIn.finalize.mockResolvedValueOnce(refused)
        await submit('/en/dashboard')
        expect(alertText()).toBe(LABELS.genericError)
        expect(submitButton().disabled).toBe(true)
        await act(async () => signOutButton()!.click())
        expect(clerk.signOut).toHaveBeenCalledWith({ sessionId: 'sess_1', redirectUrl: window.location.href })
    })

    it('can be tried again when Clerk refuses the sign-out', async () => {
        signIn.finalize.mockResolvedValueOnce(refused)
        clerk.signOut.mockRejectedValueOnce(new Error('network'))
        await reachStep([TOTP])
        await enterCode()
        await click('back')
        expect(alertText()).toBe(copy.refusedSignOutError)
        expect(submitButton().disabled).toBe(true)
        await act(async () => signOutButton()!.click())
        expect(clerk.signOut).toHaveBeenCalledTimes(2)
        expect(alertText()).toBeUndefined()
    })

    it('keeps the form busy while the sign-out runs', async () => {
        signIn.finalize.mockResolvedValueOnce(refused)
        clerk.signOut.mockImplementationOnce(() => new Promise(() => {}))
        await reachStep([TOTP])
        await enterCode()
        await click('back')
        expect(submitButton().disabled).toBe(true)
        expect(signOutButton()!.disabled).toBe(true)
        await submitForm()
        expect(signIn.password).toHaveBeenCalledTimes(1)
    })

    it('is only forgotten, with nothing signed out, once the client no longer holds it', async () => {
        signIn.finalize.mockResolvedValueOnce(refused)
        await reachStep([TOTP])
        await enterCode()
        clerk.client.signedInSessions = [{ id: 'sess_other' }]
        await click('back')
        expect(clerk.signOut).not.toHaveBeenCalled()
        expect(signOutButton()).toBeNull()
        expect(submitButton().disabled).toBe(false)
    })
})

describe('after the held session is signed out (safeinsights/sssb#198)', () => {
    const signOutButton = () => container.querySelector<HTMLButtonElement>('[data-testid="sign-in-sign-out"]')
    const submitButton = () => container.querySelector<HTMLButtonElement>('button[type="submit"]')!

    // Clerk's redirect to this page is a soft navigation, which keeps the form: it must be ready to sign in again.
    it('is ready to sign in again, with nothing held', async () => {
        signIn.finalize.mockResolvedValueOnce(refused)
        await reachStep([TOTP])
        await enterCode()
        await click('back')
        expect(clerk.signOut).toHaveBeenCalledTimes(1)
        expect(signOutButton()).toBeNull()
        expect(submitButton().disabled).toBe(false)
        expect(alertText()).toBeUndefined()
    })

    it('says the sign-out failed when Clerk answers but the client still holds the session', async () => {
        signIn.finalize.mockResolvedValueOnce(refused)
        clerk.signOut.mockResolvedValueOnce(undefined)
        await reachStep([TOTP])
        await enterCode()
        await click('back')
        expect(alertText()).toBe(copy.refusedSignOutError)
        expect(signOutButton()).not.toBeNull()
    })

    it('offers no sign-out, and stays busy, once a sign-in has finished and the browser is leaving', async () => {
        await submit('/en/dashboard')
        expect(assign).toHaveBeenCalledTimes(1)
        expect(signOutButton()).toBeNull()
        expect(submitButton().disabled).toBe(true)
    })
})
