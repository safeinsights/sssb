'use client'

import { useAuth, useSignIn, useSignUp } from '@clerk/nextjs'
import { Stack, Text } from '@mantine/core'
import { useEffect, useRef, useState } from 'react'

/**
 * Clerk ticket-strategy acceptance (ADR-0003): the invitation mail carries Clerk's invitation URL (./auth.ts
 * `createInvite`), and Clerk sends the invitee on to this page with `__clerk_ticket` and `__clerk_status` query
 * params, where the fake's link carries `?invite=<id>`. Clerk's guide to accepting organization invitations: a status
 * of `sign_in` means the invitee already has an account, and takes a ticket sign-in; `sign_up` (or none), a ticket
 * sign-up; `complete`, that Clerk accepted it already, so the form only redirects; any other is shown as the error.
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
    /**
     * Clerk's `__clerk_status` from the page's URL: `sign_in` for an invitee who already has an account, `sign_up` for
     * one who has none, `complete` when Clerk accepted the invitation itself (the invitee was already signed in).
     */
    status?: string | null
    redirectTo: string
    labels: AcceptInviteTicketLabels
}) {
    const { isLoaded } = useAuth()
    const { signUp, fetchStatus: signUpFetch } = useSignUp()
    const { signIn, fetchStatus: signInFetch } = useSignIn()
    const [error, setError] = useState<string | null>(null)
    const [accepted, setAccepted] = useState(false)
    const plan = planFor(status)
    const fetchStatus = plan === 'sign-in' ? signInFetch : signUpFetch

    // A ticket is single-use, so it is submitted once. The resources change identity as Clerk loads, so the effect
    // reads the current ones through a ref rather than depending on them (a dependency would run it again), starts
    // only once Clerk has loaded, and remembers what it started.
    const flows = useRef({ signIn, signUp })
    useEffect(() => {
        flows.current = { signIn, signUp }
    })
    const started = useRef<string | null>(null)

    useEffect(() => {
        if (!isLoaded || (plan !== 'accepted' && !ticket)) return
        const key = `${plan}:${ticket ?? ''}`
        if (started.current === key) return
        started.current = key
        // Driving an external SDK call on mount (Clerk's ticket strategy) is the
        // legitimate "sync with an external system" case the set-state-in-effect rule guards —
        // same as the Simulator glue's fetch-on-mount effects.
        void (async () => {
            if (plan === 'accepted') {
                setAccepted(true)
                window.location.assign(redirectTo)
                return
            }
            if (plan === 'unknown' || !ticket) {
                setError(labels.genericError)
                return
            }
            const { signIn: currentSignIn, signUp: currentSignUp } = flows.current
            const flow = plan === 'sign-in' ? currentSignIn : currentSignUp
            setError(null) // a retry after a thrown call starts with no error on screen
            try {
                const { error: ticketError } =
                    plan === 'sign-in' ? await currentSignIn.ticket({ ticket }) : await currentSignUp.ticket({ ticket })
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
            } catch {
                // A call that THREW (the network) is not Clerk refusing the ticket: show the error, and forget that this
                // ticket was started, so the effect's next run (Clerk reloading, the page remounting) submits it again.
                // A refusal above is not retried: Clerk has answered, and a ticket is single-use.
                started.current = null
                setError(labels.genericError)
            }
        })()
    }, [isLoaded, plan, ticket, redirectTo, labels.genericError])

    if (!ticket && plan !== 'accepted') return <Text c="gray.7">{labels.missingTicket}</Text>

    return (
        <Stack gap="sm">
            {!accepted && !error ? (
                <Text c="gray.7">{fetchStatus === 'fetching' ? labels.accepting : labels.oneMoment}</Text>
            ) : null}
            {error ? (
                <Text c="red.8" role="alert">
                    {error}
                </Text>
            ) : null}
        </Stack>
    )
}

type Plan = 'sign-in' | 'sign-up' | 'accepted' | 'unknown'

/** What Clerk's `__clerk_status` asks of the form. A missing status is a sign-up, as before the status was read. */
function planFor(status: string | null): Plan {
    if (status === 'complete') return 'accepted'
    if (status === 'sign_in') return 'sign-in'
    if (status === null || status === 'sign_up') return 'sign-up'
    return 'unknown'
}

export interface AcceptInviteTicketLabels {
    missingTicket: string
    accepting: string
    oneMoment: string
    genericError: string
}
