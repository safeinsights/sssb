---
'@sssb/create': patch
---

### The starter declares its auth tenancy, and authorizes its reads

**Kind.** scaffold

**Action.** optional

**What changed.**

- The starter's `config/params.ts` has an `auth` entry, `tenancy: 'multi'`, with a comment saying what `single` does
  and what a shared identity provider means for it.
- Its items GET (`src/app/api/items/route.ts`) now authorizes the read, with `authorize(…, 'read', …)` on the `Item`
  subject, as its writes always did, so a person placed in the org without standing (the role `none`) reads nothing
  there.

**To adopt.** Add the same `auth` entry to your own `config/params.ts` if you want the choice written down; leaving it
out keeps multi-tenant sign-in. Add the same `authorize(…, 'read', …)` call to each of your own org-scoped reads,
which matters before you turn single-tenant sign-in on (the entry "Single-tenant sign-in, a `none` role, and a
configurable tenant metadata key" says why).
