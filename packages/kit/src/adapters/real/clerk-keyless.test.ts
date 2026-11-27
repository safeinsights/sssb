import { describe, expect, it } from 'vitest'
import { clerkKeylessProblem } from './clerk-keyless'

/**
 * When SSSB's Clerk adapter refuses to read a session (safeinsights/sssb#193): outside a production build, unless a
 * secret (or encryption) key is set and keyless mode is disabled by a value Clerk honours. ./clerk-keyless.clerk.test.ts
 * drives the same refusal through Clerk's real `auth()`.
 */
const READY = { NODE_ENV: 'development', CLERK_SECRET_KEY: 'sk_test_1', NEXT_PUBLIC_CLERK_KEYLESS_DISABLED: '1' }

describe('clerkKeylessProblem', () => {
    it('finds none in a production build, whatever else is set', () => {
        expect(clerkKeylessProblem({ NODE_ENV: 'production' })).toBeNull()
    })

    it.each(['1', 'true'])('finds none outside one with a secret key and keyless disabled by %j', (v) => {
        expect(clerkKeylessProblem({ ...READY, NEXT_PUBLIC_CLERK_KEYLESS_DISABLED: v })).toBeNull()
        expect(
            clerkKeylessProblem({
                ...READY,
                CLERK_SECRET_KEY: undefined,
                CLERK_ENCRYPTION_KEY: 'enc_1',
                NEXT_PUBLIC_CLERK_KEYLESS_DISABLED: v,
            }),
        ).toBeNull()
    })

    // Clerk reads `TRUE` and ` 1 ` as set too, but a padded ` true ` as unset: only the two plain forms are taken.
    it.each([undefined, '', '0', 'false', 'off', 'no', 'yes', ' true ', 'TRUE', ' 1 '])(
        'refuses any other value (%j), under next dev and under a test run alike',
        (value) => {
            for (const NODE_ENV of ['development', 'test', undefined]) {
                expect(clerkKeylessProblem({ ...READY, NODE_ENV, NEXT_PUBLIC_CLERK_KEYLESS_DISABLED: value })).toMatch(
                    /NEXT_PUBLIC_CLERK_KEYLESS_DISABLED=1/,
                )
            }
        },
    )

    it('refuses no secret key, keyless disabled or not', () => {
        expect(clerkKeylessProblem({ ...READY, CLERK_SECRET_KEY: '' })).toMatch(/Set CLERK_SECRET_KEY/)
    })
})
