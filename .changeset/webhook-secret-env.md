---
'@sssb/kit': patch
---

### A webhook route can read its shared secret from a variable of its own

**Kind.** seam

**Action.** optional

**What changed.** `withWebhookSecret` and `verifyWebhookCaller` (`@sssb/kit/service-auth/webhook`) take an optional
`{ secretEnv }`, the environment variable real mode reads the shared secret from. It defaults to `WEBHOOK_SECRET`, so
every existing route behaves as before, and simulated mode still uses the per-checkout dev secret. A name that is not
a server-only variable (lower case, a dash, or `NEXT_PUBLIC_*`) throws a `TypeError` when the route module loads.

**To adopt.** For a sender whose secret is already deployed under another name, pass that name and set it on the
server; SSSB's real-environment checks know only `WEBHOOK_SECRET`, so add the variable to your own cutover checklist:

```ts
export const POST = withWebhookSecret(handler, { secretEnv: 'PARTNER_HOOK_SECRET' })
```

**Now deletable.** A copy of the constant-time shared-secret check kept only to read a differently named variable.
