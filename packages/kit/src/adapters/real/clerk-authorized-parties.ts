import { originProblem as appOriginProblem } from '../origin-form'

/**
 * The origins whose Clerk session tokens this deployment accepts: `CLERK_AUTHORIZED_PARTIES`, the app's own origins,
 * comma-separated (`https://app.example.org,https://preview.example.org`), handed to Clerk's middleware as
 * `authorizedParties` (./clerk-proxy.ts). Unset, it is `undefined` and Clerk accepts any session token its instance
 * signed, as before the setting existed.
 *
 * What Clerk does with it (@clerk/backend 3.29, `assertAuthorizedPartiesClaim`, run on every session token it verifies:
 * the cookie's, a refreshed one's and a handshake's): a token whose `azp` claim is not exactly one of the listed strings
 * is refused, and so is a token with no `azp` at all; the request is then signed out, with no handshake. It compares
 * strings, never origins, so `https://App.example.org` or a trailing slash would match nothing and sign everyone out.
 * An empty list turns the check off. So every entry is held to the form Clerk's own `azp` takes, the browser's origin
 * (`new URL(entry).origin`), and a value that would leave the check off while looking set is refused rather than
 * ignored.
 *
 * Refused, with the reason: an empty value or entry, a wildcard (Clerk has none), anything that is not exactly its own
 * origin (a path, a query, a trailing slash, upper case, a default port, user info), a scheme other than `https`, but
 * `http` for the loopback hosts (`localhost`, `127.0.0.1`, `[::1]`), and a duplicate.
 */
export function clerkAuthorizedParties(value: string | undefined): string[] | undefined {
    if (value === undefined) return undefined
    const entries = value.split(',').map((entry) => entry.trim())
    const problems = entries.map((entry, index) => {
        const problem = originProblem(entry)
        if (problem) return `"${entry}" ${problem}`
        return entries.indexOf(entry) === index ? null : `"${entry}" is listed twice`
    })
    const found = problems.filter((problem): problem is string => problem !== null)
    if (found.length > 0) {
        throw new Error(
            `CLERK_AUTHORIZED_PARTIES: ${found.join('; ')}. List the origins the app is served from ` +
                '(https://host[:port]), comma-separated, or unset it to accept a session token from any origin',
        )
    }
    return entries
}

function originProblem(entry: string): string | null {
    if (entry === '') return 'is empty (an empty list would turn the check off)'
    if (entry.includes('*')) return 'is a wildcard, which Clerk does not expand: list each origin'
    return appOriginProblem(entry)
}
