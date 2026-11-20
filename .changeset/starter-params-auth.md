---
'@sssb/create': patch
---

### The starter declares its auth tenancy

**Kind.** scaffold

**Action.** optional

**What changed.** The starter's `config/params.ts` has an `auth` entry, `tenancy: 'multi'`, with a comment saying
what `single` does and what a shared identity provider means for it.

**To adopt.** Add the same entry to your own `config/params.ts` if you want the choice written down; leaving it out
keeps multi-tenant sign-in.
