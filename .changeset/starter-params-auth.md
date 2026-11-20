---
'@sssb/create': patch
---

### The starter declares its auth settings, and authorizes its reads

**Kind.** scaffold

**Action.** optional

**What changed.**

- The starter's `config/params.ts` has an `auth` entry, `tenancy: 'multi'` and `orgSource: 'provider'`. Its comment
  says what `'single'` and `'fixed'` do, and what a shared identity provider means for them.
- Its items GET (`src/app/api/items/route.ts`) now authorizes the read, with `authorize(…, 'read', …)` on the `Item`
  subject, as its writes always did. So a person placed in the org without standing (the role `none`) reads nothing
  there. `src/app/api/items/route.test.ts` pins it: a restricted member reads, and `none` is refused.

**To adopt.** Add the same `auth` entry to your own `config/params.ts` if you want the choices written down; leaving it
out keeps the defaults. Add the same `authorize(…, 'read', …)` call to each of your own org-scoped reads. That matters
before you turn a fixed org source on: the entry "A `none` role, and reads that authorize" says why.
