---
'@sssb/kit': patch
---

### A verifier for Standard Webhooks senders

**Kind.** seam

**Action.** optional

**What changed.** A new subpath, `@sssb/kit/service-auth/standard-webhooks`, verifies a sender that signs Standard
Webhooks (the scheme Svix signs with): the `webhook-id`, `webhook-timestamp` and `webhook-signature` headers, or Svix's
`svix-*` names, over the exact body. `withStandardWebhookSignature(handler, { secretEnv })` refuses a timestamp more
than five minutes from the server's clock either way, a signature that does not match one of the configured `whsec_…`
secrets in constant time, and the same signed message a second time, with the same opaque 401 the other webhook
wrappers answer. Several secrets, in one variable or several, verify side by side for a rotation. The `webhooks/`
exemption of the authorization scan accepts a handler that is this call, as it accepts `withWebhookSecret(…)`. It adds
nothing to the required environment.

**To adopt.** Put the sender's secret in a server variable of your choosing and wrap the route under
`src/app/api/webhooks/`; the handler gets the verified message and should treat its id as the idempotency key, since a
sender's retry is re-signed and reaches it again:

```ts
import { withStandardWebhookSignature } from '@sssb/kit/service-auth/standard-webhooks'

export const POST = withStandardWebhookSignature(
    async ({ webhook }) => {
        // webhook.id, webhook.timestamp, webhook.body (the raw text)
        return Response.json({ ok: true })
    },
    { secretEnv: 'PARTNER_WEBHOOK_SECRET' },
)
```

With several server instances, pass `replayStore` (`claim` and `release` over a shared table) so a replayed message is
refused on every instance, not only the one that saw it.

**Now deletable.** A hand-rolled Standard Webhooks or Svix signature check (an HMAC over `id.timestamp.body`), and the
`svix` package where it was only used to verify.
