---
'@sssb/kit': patch
---

### A reads-only gate for public and inert reads

**Kind.** seam

**Action.** optional

**What changed.** An app's `authz-exemptions.mjs` takes a new gate kind, `{ kind: 'reads-only', names: [...] }`, for
a read (GET, HEAD or OPTIONS) that names nothing from outside itself but inert values and the listed imports (by
exported name) or declarations of its file. Such an entry applies to reads only: a mutation at its path keeps the gate
it had. It is the one kind an app may put outside `src/app/api`, under a new key `outsideApi: { files, prefixes }` with
keys relative to `src/app` (a public feed, a sitemap route), or name one file under SSSB's `webhooks/` or `simulator/`
prefix (a provider's verification handshake GET, whose POST stays behind the webhook guard). A `reads-only` entry is
stale where its path has no read handler. Nothing that passed before fails.

**To adopt.** For a read that the check refuses and that reads no org-scoped data, name what it reads:

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
