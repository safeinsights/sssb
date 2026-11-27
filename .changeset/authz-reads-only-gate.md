---
'@sssb/kit': minor
---

### A reads-only gate for public and inert reads

**Kind.** seam

**Action.** required

**What changed.** An app's `authz-exemptions.mjs` takes a new gate kind, `{ kind: 'reads-only', names: [...] }`, for
a read (GET, HEAD or OPTIONS) that names nothing from outside itself but inert values and the listed imports (by
exported name) or `const`s and functions of its file, whose own reads must be listed too. Such an entry applies to
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
An app with such a route may now fail where it passed. Nothing else that passed before fails.

**To adopt.** Run the conformance suite (`pnpm test:unit`): a route in a route group under `src/app/api` that it now
names is judged as its URL is (a `service/` route must be wrapped by `withServiceCaller`, as at any other path there).
For a read that the check refuses and that reads no org-scoped data, name what it reads:

```js
export default {
    files: {
        'cors/route.ts': {
            reason: 'CORS preflight: answers with the shared, constant headers object, nothing else',
            mustMatch: { kind: 'reads-only', names: ['corsHeaders'] },
        },
    },
    outsideApi: {
        files: {
            'feed.xml/route.ts': {
                reason: 'the public feed: published posts only, readable by anyone',
                mustMatch: { kind: 'reads-only', names: ['publicPosts'] },
            },
        },
    },
}
```

**Now deletable.** A helper invented only to hang a `calls` gate on a read that reads nothing org-scoped.
