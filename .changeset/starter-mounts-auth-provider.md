---
'@sssb/create': patch
---

### The starter's layout mounts the auth provider in real mode

**Kind.** scaffold

**Action.** optional

**What changed.** The starter's `src/app/[locale]/layout.tsx` rendered SSSB's real sign-in form without the provider
its hooks need, so real-mode sign-in in a generated app failed to render. It now mounts `RealAuthProviders` in real
mode, loaded with `import()` so that simulated mode and `pnpm dev` load none of it.

**To adopt.** The entry "The conformance suite checks that real-mode sign-in has its provider" gives the change to
make in your own layout, and its check tells you whether you need it.
