---
'@sssb/kit': minor
---

### A reads-only gate for public and inert reads

**Kind.** seam

**Action.** required

**What changed.** An app's `authz-exemptions.mjs` takes a new gate kind,
`{ kind: 'reads-only', names: { <exported name>: '<module>' } }`, for a read (GET, HEAD or OPTIONS) that names nothing
from outside itself but inert values and the listed imports, each by its exported name and from the module the entry
pins it to; a value of the route's own file cannot be listed (import it from a module instead). The pin is the
module: the specifier the import writes when it is not relative (`'next/headers'`, `'@acme/ui'`,
`'@sssb/kit/adapters/fake/auth'`, or an alias such as `'@/lib/cors'`) and resolves, from the app's directory and from
the importing file to the same file; or the path from the app's directory, with its extension, of the file the import
resolves to or of the file that declares the name under that name (`'src/lib/cors.ts'`; a barrel's
`export { rows as corsHeaders }` makes it the barrel's). A pin that is the path of a file in the app is only a path,
never matched as a specifier. A read that imports a listed name from any other module fails, and so does
the entry, naming both modules: a reason written for one module does not cover another's export of the same name. Such an entry applies to
reads only: a mutation at its path keeps the gate it had. It is the one kind an app may put outside `src/app/api`,
under a new key `outsideApi: { files, prefixes }` with keys relative to `src/app` (a public feed, a sitemap route), or
name one file under SSSB's `webhooks/` prefix (a provider's verification handshake GET, whose POST stays behind the
webhook guard). It is stale where its path has no read handler, or where it lists a name no read there uses. An
exemption key may now name a dynamic segment (`[locale]`) literally.

**Also changed: the path is the URL.** The check matches a route by the URL Next serves it at, so a route group's
`(name)` and a parallel route's `@slot` segment are dropped from the path exemptions and required gates are matched
against, and from an exemption key. Before, `src/app/api/(internal)/service/x/route.ts`, served at `/api/service/x`,
escaped the `service/` gate, and a route under `src/app/(app)/api/` read as one outside `src/app/api`. A route under an
intercepting segment (`(.)x`, `(..)x`, `(...)x`) now fails outright, since Next also serves it at the URL it intercepts.
An app with such a route may now fail where it passed, and so may an exemption keyed by its written path: a key is
matched by URL too, so `'(public)/'` (only a group) is refused, and `'(g)/webhooks/partner/route.ts'` now overlaps the
framework's `webhooks/` entry. In the other direction, a framework exemption and an app key now reach a route in a
group or slot at the same URL, and a key may name a dynamic segment (`items/[id]/route.ts`) for every gate kind. A
listed name is an import by its exported name: a default import cannot be listed, and every read one entry covers
imports each listed name from the module it pins.

**To adopt.** Run the conformance suite (`pnpm test:unit`): a route in a route group or slot under `src/app/api` that
it now names is judged as its URL is (a `service/` route must be wrapped by `withServiceCaller`, as at any other path
there), and an exemption key written with a group is matched without it (name the URL path).
For a read that the check refuses and that reads no org-scoped data, name what it reads:

```js
export default {
    files: {
        'cors/route.ts': {
            reason: 'CORS preflight: answers with the constant headers object from src/lib/cors.ts, nothing else',
            mustMatch: { kind: 'reads-only', names: { corsHeaders: 'src/lib/cors.ts' } },
        },
    },
    outsideApi: {
        files: {
            'feed.xml/route.ts': {
                reason: 'the public feed: published posts only, readable by anyone',
                mustMatch: { kind: 'reads-only', names: { publicPosts: 'src/domain/public-posts.ts' } },
            },
        },
    },
}
```

**Now deletable.** A helper invented only to hang a `calls` gate on a read that reads nothing org-scoped.
