/**
 * Clerk's keyless fallback, closed (safeinsights/sssb#193). Outside a production build Clerk will decrypt the request
 * data its middleware hands a route (`x-clerk-request-data`) with a key it publishes (`clerk_keyless_dummy_key`): first
 * when no secret or encryption key is set, and again, when its keyless mode may run (`NODE_ENV=development`, outside a
 * CI run, `NEXT_PUBLIC_CLERK_KEYLESS_DISABLED` not set), after the real key fails. It then checks the session token
 * header's signature with the secret key that decrypted data names. So on a path the app's proxy matcher skips, where
 * Clerk's middleware never writes its own headers over a client's, a caller who sends all three (the request data,
 * the token, its signature) under a key of its own choosing is signed in as anyone. A production build never falls
 * back (@clerk/nextjs 7.10, `decryptClerkRequestData`).
 *
 * The Clerk adapter (./auth.ts) asks this before every read of the session, and refuses to read one while the
 * fallback can be reached: outside a production build, a secret key (or encryption key) must be set AND keyless mode
 * disabled. That is stricter than Clerk's own condition on purpose (it ignores the CI exemption and holds under
 * `NODE_ENV=test` too), so it does not depend on Clerk's list of CI variables. `dev:real` sets the variable.
 *
 * Clerk reads `NEXT_PUBLIC_CLERK_KEYLESS_DISABLED` with its own `isTruthy` ('true' in any case, or a positive number);
 * this accepts only `1` and `true`, which Clerk reads as set too, so a value this accepts is one Clerk honours.
 */
export function clerkKeylessProblem(env: Readonly<Record<string, string | undefined>> = process.env): string | null {
    if (env['NODE_ENV'] === 'production') return null
    if (!env['CLERK_SECRET_KEY'] && !env['CLERK_ENCRYPTION_KEY']) {
        return (
            'Clerk has no secret key: outside a production build it would read request data under its public keyless ' +
            'key, so a forged x-clerk-auth header could sign anyone in. Set CLERK_SECRET_KEY'
        )
    }
    const disabled = env['NEXT_PUBLIC_CLERK_KEYLESS_DISABLED']?.trim().toLowerCase()
    if (disabled !== '1' && disabled !== 'true') {
        return (
            "Clerk's keyless mode is enabled outside a production build: on a path the proxy skips, a forged " +
            'x-clerk-auth header could sign anyone in (safeinsights/sssb#193). Set NEXT_PUBLIC_CLERK_KEYLESS_DISABLED=1 ' +
            'wherever real mode runs under next dev'
        )
    }
    return null
}

/** Throws `clerkKeylessProblem`'s answer, if there is one. */
export function assertClerkKeylessClosed(): void {
    const problem = clerkKeylessProblem()
    if (problem) throw new Error(problem)
}
