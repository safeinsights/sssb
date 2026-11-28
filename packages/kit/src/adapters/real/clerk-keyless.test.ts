import { readFileSync } from 'node:fs'
import path from 'node:path'
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

    // Next inlines `process.env.NODE_ENV` and every `NEXT_PUBLIC_` variable in the literal form, in Clerk's bundled copy and
    // in this module alike; reading only `process.env` as a whole would see the runtime values instead, and part from
    // Clerk's under `NODE_ENV=production next dev` (a self-inflicted outage) or the reverse. Nothing observable in a test
    // run tells the two apart, so the source is held to it.
    it('reads NODE_ENV and the flag in the literal form Next inlines, beside the whole environment', () => {
        const source = readFileSync(path.join(__dirname, 'clerk-keyless.ts'), 'utf8')
        const body = source.slice(source.indexOf('export function currentClerkKeylessProblem'))
        expect(body).toContain('NODE_ENV: process.env.NODE_ENV,')
        expect(body).toContain('NEXT_PUBLIC_CLERK_KEYLESS_DISABLED: process.env.NEXT_PUBLIC_CLERK_KEYLESS_DISABLED,')
    })
})
