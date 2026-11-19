'use client'

import { useSignIn, useSignUp } from '@clerk/nextjs'
import { Stack, Text } from '@mantine/core'
import { useEffect, useState } from 'react'

/**
 * Clerk ticket-strategy acceptance (ADR-0003): the invitation mail carries Clerk's invitation URL (./auth.ts
 * `createInvite`), and Clerk sends the invitee on to this page with `__clerk_ticket` and `__clerk_status` query
 * params, where the fake's link carries `?invite=<id>`. Clerk's guide to accepting organization invitations: a status
 * of `sign_in` means the invitee already has an account, and takes a ticket sign-in; any other, a ticket sign-up.
 * sign-in-form.tsx is the reference for the v7 signals API (signIn.password() → status → finalize()); here it is
 * signIn.ticket() or signUp.ticket() → status → finalize(), per @clerk/shared's SignInFutureResource and
 * SignUpFutureResource.
 *
 * AUTHORED — CUTOVER (`auth-dev`): never run against a real Clerk instance. Verify the full
 * ticket round-trip once a dev Clerk instance issues real invitation tickets (see
 * docs/cutover-checklist.md, `auth-dev` row).
 *
 * Lives in packages/kit/src/adapters because it imports the vendor SDK; the AcceptInviteShell renders it as a
 * slot, and all copy arrives via `labels` from the page's next-intl lookup (same contract as
 * RealSignInForm — one auth UI, no vendor-side strings).
 */
export function RealAcceptInviteForm({
    ticket,
    status = null,
    redirectTo,
    labels,
}: {
    ticket: string | null
    /** Clerk's `__clerk_status` from the page's URL: `sign_in` for an invitee who already has an account. */
    status?: string | null
    redirectTo: string
    labels: AcceptInviteTicketLabels
}) {
    const { signUp, fetchStatus: signUpFetch } = useSignUp()
    const { signIn, fetchStatus: signInFetch } = useSignIn()
    const [error, setError] = useState<string | null>(null)
    const [accepted, setAccepted] = useState(false)
    const existingAccount = status === 'sign_in'
    const fetchStatus = existingAccount ? signInFetch : signUpFetch

    useEffect(() => {
        if (!ticket) return
        // Driving an external SDK call on mount (Clerk's ticket strategy) is the
        // legitimate "sync with an external system" case the set-state-in-effect rule guards —
        // same as the Simulator glue's fetch-on-mount effects.
        void (async () => {
            const flow = existingAccount ? signIn : signUp
            const { error: ticketError } = existingAccount
                ? await signIn.ticket({ ticket })
                : await signUp.ticket({ ticket })
            if (ticketError) {
                setError(labels.genericError)
                return
            }
            if (flow.status === 'complete') {
                const finalized = await flow.finalize()
                if (finalized.error) {
                    setError(labels.genericError)
                    return
                }
                setAccepted(true)
                window.location.assign(redirectTo)
            } else {
                setError(labels.genericError)
            }
        })()
    }, [ticket, existingAccount, signIn, signUp, redirectTo, labels.genericError])

    if (!ticket) return <Text c="gray.7">{labels.missingTicket}</Text>

    return (
        <Stack gap="sm">
            {!accepted && !error ? (
                <Text c="gray.7">{fetchStatus === 'fetching' ? labels.accepting : labels.oneMoment}</Text>
            ) : null}
            {error ? <Text c="red.8">{error}</Text> : null}
        </Stack>
    )
}

export interface AcceptInviteTicketLabels {
    missingTicket: string
    accepting: string
    oneMoment: string
    genericError: string
}
