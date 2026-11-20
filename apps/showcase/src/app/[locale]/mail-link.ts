import { sameOriginPath } from '@sssb/kit/core/same-origin-path'

/** What the Simulator does with a link in a caught email: follow `path`, or say why not. */
export type MailLinkTarget = { path: string } | { refused: 'origin'; origin: string } | { refused: 'unusable' }

/**
 * Same origin only (design invariant), and never silently. A path is followed; so is an absolute URL on this origin,
 * since a real email (the invite accept link) carries one. Both go through `sameOriginPath`, which refuses what a
 * browser would read as another origin (`/\host`, a tab inside), so a prefix check is not the gate. A
 * protocol-relative `//host` link is resolved against this page and judged by its host like any absolute URL; one
 * with no origin at all (`mailto:`) is unusable here.
 */
export function mailLinkTarget(href: string, pageHref: string): MailLinkTarget {
    const path = sameOriginPath(href)
    if (path) return { path }
    let url: URL
    try {
        url = href.startsWith('//') ? new URL(href, pageHref) : new URL(href)
    } catch {
        return { refused: 'unusable' }
    }
    const origin = new URL(pageHref).origin
    const local = url.origin === origin ? sameOriginPath(url.pathname + url.search + url.hash) : null
    if (local) return { path: local }
    if (url.origin === origin || url.origin === 'null') return { refused: 'unusable' }
    return { refused: 'origin', origin: url.origin }
}
