'use client'

import { Button, Stack, Text, TextInput, Title } from '@mantine/core'
import { useTranslations } from 'next-intl'
import { useEffect, useEffectEvent, useId, useRef, useState, type SubmitEvent } from 'react'

/** A second factor the step can take a code for, in this app's words, never the identity provider's. */
export type SecondFactorKind = 'authenticator' | 'phone' | 'email' | 'backup'

export type SecondFactor =
    | { kind: 'authenticator' | 'backup' }
    /** `destination` is where the provider sends the code, masked by it (`+1*******99`). */
    | { kind: 'phone' | 'email'; destination: string }

/** How long a person waits before a sent code can be sent again. */
export const RESEND_COOLDOWN_SECONDS = 30

/** Milliseconds on a clock that a change of the date or time does not move. */
const clock = () => performance.now()

/** How soon after a choice a click is the second of a double click: choosing a factor moves the buttons. */
const DOUBLE_CLICK_MS = 500

/** A long address, or a longer language, wraps at phone width rather than being cut off. */
const WRAPS = { h: 'auto', mih: 36, styles: { label: { whiteSpace: 'normal', overflowWrap: 'anywhere' } } } as const

const COPY = {
    authenticator: { label: 'codeLabelAuthenticator', choice: 'codeChoiceAuthenticator' },
    phone: { label: 'codeLabelPhone', choice: 'codeChoicePhone' },
    email: { label: 'codeLabelEmail', choice: 'codeChoiceEmail' },
    backup: { label: 'codeLabelBackup', choice: 'codeChoiceBackup' },
} as const

/**
 * The second step of sign-in, after the password was accepted: one code from one of the factors the account offers,
 * the first of them chosen, with a button for each of the others. It knows no identity provider: the caller
 * (`adapters/real/sign-in-form.tsx`) says which factors there are and what sending and verifying do.
 *
 * - `onSend` sends a code (`phone`, `email`) and answers whether it went. The step calls it when it opens on such a
 *   factor, when the person chooses one, and when they ask for another code, which they can do once
 *   `RESEND_COOLDOWN_SECONDS` have passed since the last one that went.
 * - `onVerify` answers whether the caller took it from here: `true` keeps the spinner (the page is navigating, or the
 *   caller replaces this step), and `false`, or a rejection, shows the one generic error and leaves the person here
 *   with every choice still open. A refused, expired or rate-limited code all read the same.
 * - `onBack` returns to the password, offered whenever no code is being verified or has been taken.
 *
 * Opening the step moves focus to its code field, inside a group named and described by the heading and the lead, so a
 * screen reader hears the step change; a code's sending is told through a status region and an error as an alert.
 */
export function SecondFactorStep({
    factors,
    newDevice = false,
    onSend,
    onVerify,
    onBack,
}: {
    factors: readonly [SecondFactor, ...SecondFactor[]]
    /** The provider asks because it does not know the device, not because the account has a second factor. */
    newDevice?: boolean
    onSend: (kind: 'phone' | 'email') => Promise<boolean>
    onVerify: (kind: SecondFactorKind, code: string) => Promise<boolean>
    onBack: () => void
}) {
    const t = useTranslations('auth')
    const id = useId()
    const [factor, setFactor] = useState<SecondFactor>(factors[0])
    const [code, setCode] = useState('')
    const [busy, setBusy] = useState<'sending' | 'verifying' | null>(null)
    const [error, setError] = useState<'code' | 'send' | null>(null)
    /** Per kind, when another code may be sent. Absent until one has gone. */
    const [resendAt, setResendAt] = useState<Partial<Record<SecondFactorKind, number>>>({})
    const [now, setNow] = useState(0)
    const input = useRef<HTMLInputElement>(null)

    const { kind } = factor
    const sentUntil = resendAt[kind]
    const wait = sentUntil === undefined ? 0 : Math.max(0, Math.ceil((sentUntil - now) / 1000))

    // The field is a new element for each kind (its autofill attributes differ), so focus follows it.
    useEffect(() => {
        input.current?.focus()
    }, [kind])

    // `now` runs until the last cooldown has ended, whichever factor is showing: `choose` reads it too.
    useEffect(() => {
        const last = Math.max(0, ...Object.values(resendAt))
        if (last === 0) return
        const timer = setInterval(() => {
            const at = clock()
            setNow(at)
            if (at >= last) clearInterval(timer)
        }, 1000)
        return () => clearInterval(timer)
    }, [resendAt])

    async function send(target: 'phone' | 'email') {
        setError(null)
        setBusy('sending')
        let sent = false
        try {
            sent = await onSend(target)
        } catch {
            // Shown below, as a send the provider refused.
        }
        setBusy(null)
        if (sent) {
            const at = clock()
            setNow(at)
            setResendAt((before) => ({ ...before, [target]: at + RESEND_COOLDOWN_SECONDS * 1000 }))
        } else {
            setError('send')
        }
        // Pressing a button that was disabled meanwhile leaves focus nowhere. Anywhere else, it is where the person went.
        if (document.activeElement === document.body) input.current?.focus()
    }

    // The code for the factor the step opens on. Once: a development double-run of effects must not send two.
    const opened = useRef(false)
    const sendFirst = useEffectEvent(() => {
        if (factor.kind === 'phone' || factor.kind === 'email') void send(factor.kind)
    })
    useEffect(() => {
        if (opened.current) return
        opened.current = true
        sendFirst()
    }, [])

    const chosenAt = useRef(-Infinity)
    /** Whether a click comes too soon after a choice to be meant for the button now under it. Keeps focus on the field. */
    function isSecondClick(): boolean {
        if (clock() - chosenAt.current >= DOUBLE_CLICK_MS) return false
        input.current?.focus()
        return true
    }

    function choose(next: SecondFactor) {
        if (isSecondClick()) return
        chosenAt.current = clock()
        setFactor(next)
        setCode('')
        setError(null)
        // One that went a moment ago is still good: going back and forth between factors sends nothing more.
        if ((next.kind === 'phone' || next.kind === 'email') && (resendAt[next.kind] ?? 0) <= now) void send(next.kind)
    }

    async function verify(event: SubmitEvent<HTMLFormElement>) {
        event.preventDefault()
        // Authenticator apps and text messages print a code in groups; the provider wants its characters alone.
        const typed = kind === 'backup' ? code.trim() : code.replace(/\s/g, '')
        if (busy !== null || typed === '') return
        setError(null)
        setBusy('verifying')
        let taken = false
        try {
            taken = await onVerify(kind, typed)
        } catch {
            // Shown below, as a code the provider refused.
        }
        if (taken) return
        setBusy(null)
        setError('code')
        input.current?.focus()
        input.current?.select()
    }

    const others = factors.filter((candidate) => candidate.kind !== kind)
    const sends = kind === 'phone' || kind === 'email'
    return (
        <form onSubmit={(event) => void verify(event)} data-testid="second-factor-step">
            <Stack role="group" aria-labelledby={`${id}-title`} aria-describedby={`${id}-lead`}>
                <Title order={2} size="h4" id={`${id}-title`}>
                    {t('secondFactorTitle')}
                </Title>
                <Text size="sm" id={`${id}-lead`}>
                    {t(newDevice ? 'secondFactorNewDevice' : 'secondFactorLead')}
                </Text>
                <TextInput
                    key={kind}
                    ref={input}
                    label={t(COPY[kind].label)}
                    name="code"
                    required
                    value={code}
                    onChange={(event) => setCode(event.currentTarget.value)}
                    error={error === 'code'}
                    // Mantine's error red is too pale for text; the border, aria-invalid and the alert say it is wrong.
                    styles={{ input: { color: 'var(--mantine-color-text)' } }}
                    // A backup code is no one-time-code: a password manager would fill the authenticator's instead.
                    autoComplete={kind === 'backup' ? 'off' : 'one-time-code'}
                    inputMode={kind === 'backup' ? 'text' : 'numeric'}
                    autoCapitalize="none"
                    spellCheck={false}
                />
                <Text role="status" size="sm" c="gray.7" data-testid="second-factor-status">
                    {busy === 'sending'
                        ? t('codeSending')
                        : sends && sentUntil !== undefined && error !== 'send'
                          ? t('codeSent', { destination: factor.destination })
                          : null}
                </Text>
                {error ? (
                    <Text c="red.8" role="alert">
                        {t(error === 'code' ? 'codeError' : 'codeSendError')}
                    </Text>
                ) : null}
                <Button type="submit" {...WRAPS} loading={busy === 'verifying'} disabled={busy === 'sending'}>
                    {t('codeVerify')}
                </Button>
                {sends ? (
                    <Button
                        variant="default"
                        {...WRAPS}
                        disabled={busy !== null || wait > 0}
                        onClick={() => {
                            // This button is about to be disabled; the code goes in the field.
                            input.current?.focus()
                            void send(kind)
                        }}
                        data-testid="second-factor-resend"
                    >
                        {wait > 0 ? t('codeResendIn', { seconds: wait }) : t('codeResend')}
                    </Button>
                ) : null}
                {others.map((other) => (
                    <Button
                        key={other.kind}
                        variant="default"
                        {...WRAPS}
                        disabled={busy !== null}
                        onClick={() => choose(other)}
                        data-testid={`second-factor-choose-${other.kind}`}
                    >
                        {t(COPY[other.kind].choice, 'destination' in other ? { destination: other.destination } : {})}
                    </Button>
                ))}
                <Button
                    variant="subtle"
                    {...WRAPS}
                    disabled={busy === 'verifying'}
                    onClick={() => {
                        if (!isSecondClick()) onBack()
                    }}
                    data-testid="second-factor-back"
                >
                    {t('secondFactorBack')}
                </Button>
            </Stack>
        </form>
    )
}
