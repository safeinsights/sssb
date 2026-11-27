/** The hosts a browser reaches on the machine itself, the only ones served over plain `http` in a real run. */
const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]'])

/**
 * Why `entry` is not an origin the app can be served from, or `null` when it is one: exactly its own origin as the
 * browser writes it (`new URL(entry).origin`: no path, query or trailing slash, lower case, no default port, no user
 * info), over `https`, or over `http` for the loopback hosts only. Shared by the settings that name the app's own
 * origins: `CLERK_AUTHORIZED_PARTIES` (./real/clerk-authorized-parties.ts) and `PUBLIC_ORIGIN` (./edge-headers.ts).
 */
export function originProblem(entry: string): string | null {
    if (entry === '') return 'is empty'
    if (entry.includes('*')) return 'is a wildcard: name one origin'
    let url: URL
    try {
        url = new URL(entry)
    } catch {
        return 'is not a URL'
    }
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && LOOPBACK.has(url.hostname))) {
        return 'is not https (http is for localhost, 127.0.0.1 and [::1] only)'
    }
    if (url.origin !== entry) return `is not a bare origin: write it as ${url.origin}`
    return null
}
