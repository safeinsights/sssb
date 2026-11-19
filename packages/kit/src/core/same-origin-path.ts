const BASE = 'http://same-origin.invalid'

/**
 * `value` as a path on the current origin (path, query and fragment, normalised), or null when a browser given it
 * would leave the origin, run a script, or land on a path that reads as another origin.
 *
 * The Simulator navigates to strings it does not write: a remembered `lastPath` (recorded from a page-view beacon's
 * body), a link in a caught email. A prefix check is not enough, because a browser reads `/\host` as `//host`, drops a
 * tab or newline anywhere (`/<tab>/host` is `//host`), and resolves dot segments (`/.//host` is the path `//host`,
 * which a later relative use turns into another origin). So the string must start with one `/`, hold no backslash,
 * whitespace or control character, resolve against a fixed origin to that same origin, and resolve to a path that
 * does not itself start with `//`.
 */
export function sameOriginPath(value: unknown): string | null {
    if (typeof value !== 'string' || !/^\/(?![/\\])[^\s\\\p{Cc}]*$/u.test(value)) return null
    const url = new URL(value, BASE)
    if (url.origin !== BASE || url.pathname.startsWith('//')) return null
    return url.pathname + url.search + url.hash
}
