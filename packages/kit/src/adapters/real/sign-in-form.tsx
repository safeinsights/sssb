'use client'

import { useSignIn } from '@clerk/nextjs'
import { Button, PasswordInput, Stack, Text, TextInput } from '@mantine/core'
import { useForm } from '@mantine/form'
import { useState } from 'react'

import { sameOriginPath } from '../../core/same-origin-path'

/**
 * Clerk-headless credential form (ADR-0003) using @clerk/nextjs v7's signals API
 * (signIn.password → status → finalize). MFA verification (status 'needs_second_factor') is a
 * documented follow-up slice — see ADR-0003's MFA rider seam.
 *
 * AUTHORED — CUTOVER (`auth-dev`): never run against a real Clerk instance.
 * Lives in packages/kit/src/adapters because it imports the vendor SDK; the SignInScreen renders it as a slot.
 *
 * `returnTo` usually comes from the URL, so the form goes there only when `sameOriginPath` accepts it, and to `/`
 * otherwise: a page that forgot to check it must not turn sign-in into an open redirect (`/\evil.example` and
 * `/<tab>/evil.example` pass a `startsWith('/')` check and leave the origin).
 */
export function RealSignInForm({ labels, returnTo }: { labels: SignInLabels; returnTo: string }) {
    const { signIn, fetchStatus } = useSignIn()
    const [formError, setFormError] = useState<string | null>(null)
    const form = useForm({ initialValues: { email: '', password: '' } })

    const submit = form.onSubmit(async (values) => {
        setFormError(null)
        // A Clerk call that throws (the network, not a refused password) is shown as the same generic error, never left
        // as an unhandled rejection with nothing on screen.
        try {
            const { error } = await signIn.password({ identifier: values.email, password: values.password })
            if (error) {
                setFormError(labels.genericError)
                return
            }
            if (signIn.status === 'complete') {
                const finalized = await signIn.finalize()
                if (finalized.error) setFormError(labels.genericError)
                else window.location.assign(sameOriginPath(returnTo) ?? '/')
            } else if (signIn.status === 'needs_second_factor') {
                setFormError(labels.mfaNotImplemented)
            } else {
                setFormError(labels.genericError)
            }
        } catch {
            setFormError(labels.genericError)
        }
    })

    return (
        <form onSubmit={submit}>
            <Stack>
                <TextInput label={labels.email} type="email" required {...form.getInputProps('email')} />
                <PasswordInput label={labels.password} required {...form.getInputProps('password')} />
                <Button type="submit" loading={fetchStatus === 'fetching'}>
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

export interface SignInLabels {
    email: string
    password: string
    submit: string
    genericError: string
    mfaNotImplemented: string
}
