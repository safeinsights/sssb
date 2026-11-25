'use client'

import { useSignIn } from '@clerk/nextjs'
import { Button, PasswordInput, Stack, Text, TextInput } from '@mantine/core'
import { useForm } from '@mantine/form'
import { useTranslations } from 'next-intl'
import { useEffect, useRef, useState } from 'react'

import { SecondFactorStep, type SecondFactor, type SecondFactorKind } from '../../components/auth/second-factor-step'
import { sameOriginPath } from '../../core/same-origin-path'

type SignIn = ReturnType<typeof useSignIn>['signIn']

/**
 * Clerk-headless credential form (ADR-0003) using @clerk/nextjs v7's signals API: `signIn.password`, then `status`, then
 * `finalize`, with `signIn.mfa` between them when Clerk asks for a second step.
 *
 * Only `complete` finishes a sign-in: Clerk gives an attempt a session (`createdSessionId`, which `finalize` needs) at
 * no other status, and the form calls `finalize` at no other. Every other status goes one of three ways (`proceed`):
 *
 * - `needs_second_factor`, and `needs_client_trust` (Clerk's check of a device it does not know, verified by the same
 *   `signIn.mfa` calls), show the code step for the factors SSSB takes a code for, and the unsupported message when the
 *   account offers none of them (a passkey, an emailed link).
 * - `needs_identifier` and `needs_first_factor`: Clerk did not take the password. The generic error.
 * - Any other (`needs_new_password`, `needs_protect_check`, one a later Clerk adds): the unsupported message.
 *
 * AUTHORED — CUTOVER (`auth-dev`): never run against a real Clerk instance.
 * Lives in packages/kit/src/adapters because it imports the vendor SDK; the SignInScreen renders it as a slot. The
 * password step's copy is the page's `labels`; what comes after it reads the framework's catalog itself (`auth`), so it
 * renders under `NextIntlClientProvider`, as `SignInScreen` does.
 *
 * `returnTo` usually comes from the URL, so the form goes there only when `sameOriginPath` accepts it, and to `/`
 * otherwise: a page that forgot to check it must not turn sign-in into an open redirect (`/\evil.example` and
 * `/<tab>/evil.example` pass a `startsWith('/')` check and leave the origin).
 */
export function RealSignInForm({ labels, returnTo }: { labels: SignInLabels; returnTo: string }) {
    const { signIn } = useSignIn()
    const t = useTranslations('auth')
    const [formError, setFormError] = useState<string | null>(null)
    // Not the hook's `fetchStatus`, which a code still being sent holds after the person has gone back from the step.
    const [busy, setBusy] = useState(false)
    const [step, setStep] = useState<Step | null>(null)
    const form = useForm({ initialValues: { email: '', password: '' } })

    // Clerk accepted the step's code, kept for a `finalize` that fails after it: a code is spent once verified, so
    // trying again finalizes the same attempt, while it is still complete, and verifies nothing.
    const [accepted, setAccepted] = useState(false)

    // Leaving the step puts focus back where the person types next.
    const password = useRef<HTMLInputElement>(null)
    const [leftStep, setLeftStep] = useState(false)
    useEffect(() => {
        if (leftStep) password.current?.focus()
    }, [leftStep])

    function leaveStep(error: string | null) {
        setLeftStep(step !== null)
        setStep(null)
        setFormError(error)
    }

    /** Acts on the attempt's status, and answers whether that moved it on from `from`, the step it is on. */
    async function proceed(attempt: SignIn, from: Step | null): Promise<boolean> {
        const { status } = attempt
        switch (status) {
            case 'complete': {
                const { error } = await attempt.finalize()
                if (error) return false
                window.location.assign(sameOriginPath(returnTo) ?? '/')
                return true
            }
            case 'needs_identifier':
            case 'needs_first_factor':
                return false
            case 'needs_second_factor':
            case 'needs_client_trust': {
                if (status === from?.status) return false
                const factors = supportedFactors(attempt)
                if (factors) {
                    form.setFieldValue('password', '')
                    setAccepted(false)
                    setLeftStep(false)
                    setStep({ attempt, status, factors })
                } else {
                    leaveStep(t('signInUnsupported'))
                }
                return true
            }
            default:
                leaveStep(t('signInUnsupported'))
                return true
        }
    }

    const submit = form.onSubmit(async (values) => {
        setFormError(null)
        setBusy(true)
        // A Clerk call that throws (the network, not a refused password) is shown as the same generic error, never left
        // as an unhandled rejection with nothing on screen.
        try {
            const taken = await succeeds(signIn, () =>
                signIn.password({ identifier: values.email, password: values.password }),
            )
            if (!taken || !(await proceed(signIn, null))) setFormError(labels.genericError)
        } catch {
            setFormError(labels.genericError)
        } finally {
            setBusy(false)
        }
    })

    if (step) {
        const { attempt } = step
        return (
            <SecondFactorStep
                key={step.status}
                factors={step.factors}
                newDevice={step.status === 'needs_client_trust'}
                onSend={(kind) =>
                    succeeds(attempt, () =>
                        kind === 'phone' ? attempt.mfa.sendPhoneCode() : attempt.mfa.sendEmailCode(),
                    )
                }
                // A throw (the network) is the step's to show, as a code Clerk refused is.
                onVerify={async (kind, code) => {
                    if (!accepted || attempt.status !== 'complete') {
                        const { error } = await verifyCode(attempt, kind, code)
                        if (error) return false
                        setAccepted(true)
                    }
                    return proceed(attempt, step)
                }}
                onBack={() => {
                    leaveStep(null)
                    // Clerk's attempt is dropped too (local state only, no request). The next password starts a new one
                    // either way, so a reset that fails changes nothing.
                    void Promise.resolve()
                        .then(() => signIn.reset())
                        .catch(() => {})
                }}
            />
        )
    }

    return (
        <form onSubmit={submit}>
            <Stack>
                <TextInput label={labels.email} type="email" required {...form.getInputProps('email')} />
                <PasswordInput label={labels.password} required ref={password} {...form.getInputProps('password')} />
                <Button type="submit" loading={busy}>
                    {labels.submit}
                </Button>
                {formError ? (
                    <Text c="red.8" role="alert">
                        {formError}
                    </Text>
                ) : null}
            </Stack>
        </form>
    )
}

/** What the code step answers, and the factors the account offered for it when the step opened. */
interface Step {
    /**
     * The attempt the password opened, which every call of the step is made on, rather than the hook's current `signIn`,
     * which a client update can replace: another tab's attempt, a code sent before the person went back, or the empty
     * attempt `finalize` can leave when it fails half-way. (A password submitted before clerk-js has loaded is the
     * exception: what the hook answers then is a placeholder that follows its current attempt.)
     */
    attempt: SignIn
    status: 'needs_second_factor' | 'needs_client_trust'
    factors: [SecondFactor, ...SecondFactor[]]
}

/**
 * Whether Clerk took a call. Where clerk-js takes the browser to be offline (its test includes the user agent), it drops a
 * failed request and answers no error, with the attempt as it was: an accepted password, or a code sent, that never
 * left. So a call is taken when it answers no error and anything about the attempt has changed. A password moves its
 * status, or starts an attempt with another id, so no password depends on what clerk-js does with the verification; a
 * sent code moves neither, and there the verification says (clerk-js rebuilds it from every success).
 */
async function succeeds(attempt: SignIn, call: () => Promise<{ error: unknown }>): Promise<boolean> {
    const before = fingerprint(attempt)
    const { error } = await call()
    const after = fingerprint(attempt)
    return !error && after.some((value, index) => !Object.is(value, before[index]))
}

/** What a Clerk answer changes about an attempt. */
function fingerprint(attempt: SignIn): unknown[] {
    const { id, status, secondFactorVerification: verification } = attempt
    return [
        id,
        status,
        verification,
        // Its values too, for one updated in place. Optional, so that a build without one cannot break the password.
        verification?.status,
        verification?.strategy,
        verification?.expireAt?.getTime(),
    ]
}

/**
 * The account's factors SSSB takes a code for, in Clerk's order with backup codes last, or null when there is none.
 * One per kind, Clerk's first: `signIn.mfa.sendPhoneCode` and `sendEmailCode` take no address, and send to the first
 * number or address the attempt lists, so that is the one to name.
 */
function supportedFactors(signIn: SignIn): [SecondFactor, ...SecondFactor[]] | null {
    const found = new Map<SecondFactorKind, SecondFactor>()
    for (const offered of signIn.supportedSecondFactors) {
        const factor = toFactor(offered)
        if (factor && !found.has(factor.kind)) found.set(factor.kind, factor)
    }
    const factors = [...found.values()]
    const [first, ...rest] = [
        ...factors.filter(({ kind }) => kind !== 'backup'),
        ...factors.filter(({ kind }) => kind === 'backup'),
    ]
    return first ? [first, ...rest] : null
}

function toFactor(offered: SignIn['supportedSecondFactors'][number]): SecondFactor | null {
    switch (offered.strategy) {
        case 'totp':
            return { kind: 'authenticator' }
        case 'backup_code':
            return { kind: 'backup' }
        case 'phone_code':
            return { kind: 'phone', destination: offered.safeIdentifier }
        case 'email_code':
            return { kind: 'email', destination: offered.safeIdentifier }
        default:
            return null
    }
}

function verifyCode(signIn: SignIn, kind: SecondFactorKind, code: string) {
    switch (kind) {
        case 'authenticator':
            return signIn.mfa.verifyTOTP({ code })
        case 'backup':
            return signIn.mfa.verifyBackupCode({ code })
        case 'phone':
            return signIn.mfa.verifyPhoneCode({ code })
        case 'email':
            return signIn.mfa.verifyEmailCode({ code })
    }
}

export interface SignInLabels {
    email: string
    password: string
    submit: string
    genericError: string
}
