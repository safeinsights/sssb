/**
 * Clerk's keyless fallback, closed (safeinsights/sssb#193), and no more than it needs closing. Clerk decrypts the request
 * data its middleware hands a route (`x-clerk-request-data`) with a key it publishes (`clerk_keyless_dummy_key`) in two
 * cases (@clerk/nextjs 7.10, `decryptClerkRequestData`, `canUseKeyless`):
 *
 * - FIRST, when it holds neither `CLERK_ENCRYPTION_KEY` nor `CLERK_SECRET_KEY` and `NODE_ENV` is not `production`;
 * - AS A FALLBACK, after the real key fails, when `NODE_ENV` is `development`, it is not a CI run, and
 *   `NEXT_PUBLIC_CLERK_KEYLESS_DISABLED` is not set (Next sets `NODE_ENV=development` under `next dev`).
 *
 * It then checks the session token header's signature with the secret key that decrypted data names, or with
 * `CLERK_SECRET_KEY` when the data names none, which is the empty string when that is unset, whatever `NODE_ENV` says and
 * whether or not an encryption key is set. So on a path the app's proxy matcher skips, where Clerk's middleware never
 * writes its own headers over a client's, a caller who sends the request data, a token and its signature, all under keys
 * of its own choosing, is signed in as anyone. Nothing else opens it: with the secret key set and `NODE_ENV` unset,
 * `test` or `production`, a forgery under the dummy key fails to decrypt.
 *
 * So the Clerk adapter (./auth.ts), before every read of the session and before building Clerk's Backend API client
 * (which decrypts the same data), refuses in exactly two cases:
 *
 * 1. `CLERK_SECRET_KEY` is unset, in any `NODE_ENV`. An encryption key alone does not do: the signature key is still
 *    empty.
 * 2. `NODE_ENV` is `development` and `NEXT_PUBLIC_CLERK_KEYLESS_DISABLED` is not `1` or `true`. That is stricter than
 *    Clerk (which also lets a CI run through) on purpose, so it copies none of Clerk's list of CI variables. `dev:real`
 *    sets the variable.
 *
 * A process outside `next dev` with the secret key set, a job program on CodeBuild, an ops script, a test run, needs
 * nothing: it has no `NODE_ENV=development` and nothing to forge. (An earlier cut refused everything but a production
 * build, which broke exactly those: safeinsights/sssb#222's review, finding A3.)
 *
 * Clerk reads `NEXT_PUBLIC_CLERK_KEYLESS_DISABLED` with its own `isTruthy` (`true` in any case, untrimmed, or a positive
 * number); this accepts exactly `1` and `true`, which Clerk reads as set too, so a value this accepts is one Clerk
 * honours (a padded ` true ` is not).
 *
 * Clerk is bundled into the app, where Next inlines `process.env.NODE_ENV` (as `development` under `next dev`, whatever
 * the process was started with), so `assertClerkKeylessClosed` reads it in the same literal form, which Next inlines
 * alike. `NEXT_PUBLIC_CLERK_KEYLESS_DISABLED` is read in that form too: Next inlines every `NEXT_PUBLIC_` variable set at
 * build time into server code, Clerk's constant included, so a build and a run with different values agree.
 */
export function clerkKeylessProblem(env: Readonly<Record<string, string | undefined>> = process.env): string | null {
    if (!env['CLERK_SECRET_KEY']) {
        return (
            'Clerk has no secret key: it would read request data under its public keyless key, or check a token header ' +
            'against an empty key, so a forged x-clerk-auth header could sign anyone in. Set CLERK_SECRET_KEY'
        )
    }
    const disabled = env['NEXT_PUBLIC_CLERK_KEYLESS_DISABLED']
    if (env['NODE_ENV'] === 'development' && disabled !== '1' && disabled !== 'true') {
        return (
            "Clerk's keyless mode is enabled under NODE_ENV=development (next dev): on a path the proxy skips, a " +
            'forged x-clerk-auth header could sign anyone in (safeinsights/sssb#193). Set ' +
            'NEXT_PUBLIC_CLERK_KEYLESS_DISABLED=1 wherever real mode runs under next dev'
        )
    }
    return null
}

/** `clerkKeylessProblem` for this process, reading the two variables Next inlines in the literal form (above). */
export function currentClerkKeylessProblem(): string | null {
    return clerkKeylessProblem({
        ...process.env,
        NODE_ENV: process.env.NODE_ENV,
        NEXT_PUBLIC_CLERK_KEYLESS_DISABLED: process.env.NEXT_PUBLIC_CLERK_KEYLESS_DISABLED,
    })
}

/** Throws `currentClerkKeylessProblem`'s answer, if there is one. */
export function assertClerkKeylessClosed(): void {
    const problem = currentClerkKeylessProblem()
    if (problem) throw new Error(problem)
}

declare global {
    // The one way to add a variable to Node's `process.env` type, which the literal read above needs under the strict
    // `noPropertyAccessFromIndexSignature`.
    // eslint-disable-next-line @typescript-eslint/no-namespace -- a declaration merge into Node's own namespace
    namespace NodeJS {
        interface ProcessEnv {
            /** Clerk's switch for its keyless mode, read here in the literal form Next inlines (above). */
            readonly NEXT_PUBLIC_CLERK_KEYLESS_DISABLED?: string
        }
    }
}
