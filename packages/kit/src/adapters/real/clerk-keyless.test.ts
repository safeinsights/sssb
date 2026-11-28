import { describe, expect, it } from 'vitest'
import { clerkKeylessProblem } from './clerk-keyless'

/**
 * When SSSB's Clerk adapter refuses to read a session or call Clerk (safeinsights/sssb#193), in exactly the two cases
 * Clerk's own code leaves a forgery open (./clerk-keyless.ts): no secret key, or NODE_ENV=development with keyless mode on.
 * A process outside `next dev` with the secret key set is let through: a job program, an ops script, a test run
 * (safeinsights/sssb#222's review, A3). ./clerk-keyless.clerk.test.ts drives the same refusals through Clerk's real
 * `auth()`, and shows that what this lets through is refused by Clerk itself.
 */
const SECRET = { CLERK_SECRET_KEY: 'sk_test_1' }
const NODE_ENVS = ['development', 'test', 'production', undefined] as const

describe('clerkKeylessProblem', () => {
    it.each(['test', 'production', undefined])(
        'lets a process through with the secret key and NODE_ENV %s, the flag unset: nothing to forge, as outside next dev',
        (NODE_ENV) => {
            expect(clerkKeylessProblem({ ...SECRET, NODE_ENV })).toBeNull()
        },
    )

    it.each(['1', 'true'])('lets next dev through with the secret key and keyless disabled by %j', (v) => {
        expect(
            clerkKeylessProblem({ ...SECRET, NODE_ENV: 'development', NEXT_PUBLIC_CLERK_KEYLESS_DISABLED: v }),
        ).toBeNull()
    })

    // Clerk reads `TRUE` and ` 1 ` as set too, but a padded ` true ` as unset: only the two plain forms are taken.
    it.each([undefined, '', '0', 'false', 'off', 'no', 'yes', ' true ', 'TRUE', ' 1 '])(
        'refuses next dev with the flag at %j',
        (value) => {
            expect(
                clerkKeylessProblem({ ...SECRET, NODE_ENV: 'development', NEXT_PUBLIC_CLERK_KEYLESS_DISABLED: value }),
            ).toMatch(/NEXT_PUBLIC_CLERK_KEYLESS_DISABLED=1/)
        },
    )

    it.each(NODE_ENVS)(
        'refuses no secret key, in NODE_ENV %s, flag set or not, and an encryption key in its place',
        (NODE_ENV) => {
            for (const env of [
                {},
                { CLERK_SECRET_KEY: '' },
                { CLERK_ENCRYPTION_KEY: 'enc_1' },
                { NEXT_PUBLIC_CLERK_KEYLESS_DISABLED: '1' },
            ]) {
                expect(clerkKeylessProblem({ ...env, NODE_ENV })).toMatch(/Set CLERK_SECRET_KEY/)
            }
        },
    )
})
