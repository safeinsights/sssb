---
'@sssb/create': minor
---

### A generated app's proxy runs through `withAuthProxy`

**Kind.** scaffold

**Action.** required

**What changed.** The starter's `src/proxy.ts` wraps its locale routing in `withAuthProxy` from
`@sssb/kit/adapters/proxy`, and its matcher now also sends it every `/api` route (passed through untouched), so real
mode's sign-in works in a generated app. A new `src/proxy.test.ts` checks which paths reach the proxy and what it does
with a page and an API route.

**To adopt.** Make your `src/proxy.ts` the one the kit changeset "Real-mode sign-in: `withAuthProxy` runs Clerk's
middleware around your proxy" shows, and copy the starter's `src/proxy.test.ts` if you want the gate.
