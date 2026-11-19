---
'@sssb/kit': minor
'@sssb/tools': minor
'@sssb/cdk': minor
---

### Machine callers send their credential in its own header, which CloudFront passes through

**Kind.** operator

**Action.** optional

**What changed.** `withWebhookSecret` (`@sssb/kit/service-auth/webhook`) reads the shared secret from
`x-sssb-webhook-secret`, and `verifyServiceCaller` (`@sssb/kit/service-auth/verify`) reads a service token from
`x-sssb-service-token`, each exported as a constant (`WEBHOOK_SECRET_HEADER`, `SERVICE_TOKEN_HEADER`). The header wins
when present; `Authorization: Bearer …` is still accepted when it is absent. The reason: `SssbApp`'s CloudFront signs
every request it passes to the server's Function URL, and its signature replaces the `Authorization` header, so a
credential sent there through the public host never reached the route and every such call answered 401. `pnpm tick`
and `SssbApp`'s scheduled tick send the new header.

**To adopt.** Every caller of your webhook and service routes that goes through your deployment's public host (a
scheduler, a build's completion callback, a service) sends `x-sssb-webhook-secret: <secret>` or
`x-sssb-service-token: <jwt>` instead of `Authorization: Bearer …`. A caller that reaches the server another way may
keep `Authorization`, but the header works everywhere.

**Now deletable.** A workaround that delivered a webhook secret or service token around CloudFront because
`Authorization` never arrived.
