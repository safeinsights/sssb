---
description: Add an outbound webhook event kind registered through the app-config seam
argument-hint: <entity.event, and when it fires>
---

Add an outbound webhook event kind for: $ARGUMENTS

**The app** is the directory the workspace root `package.json` lists in `sssb.apps` (with more than one, the one
the request names, or ask). Paths below are relative to that directory; run `pnpm` scripts from the workspace root.
SSSB's reference app is cited by URL, where `<ref>` is the commit your project's Claude Code settings pin the `sssb`
marketplace to (in SSSB's own repository, read its local showcase app instead).

Outbound webhooks (signed delivery, retries and backoff, the endpoint rows, the Simulator's Hooks tab) are the
framework's; event kinds are vocabulary you register:

1. **Register** in `src/app-config/webhooks.ts`: add the kind to `appWebhookEventKinds` (`<entity>.<event>`) and
   its payload shape to `AppWebhookEventPayloadMap`. Payloads are the signed envelope's `data`: keep them small,
   stable and id-bearing (consumers dedupe on the delivery id).
2. **Emit** with `enqueueWebhookEvent` (`@sssb/kit/db/webhooks`) at the mutation choke point, after the write
   commits; the reference app's escalations routes (`escalation.created`, `escalation.decided`) are the worked
   examples: `https://github.com/safeinsights/sssb/tree/<ref>/apps/showcase/src/app/api/escalations`. Delivery is
   at-least-once; the drain does the network effect on the next tick.
3. **Signature headers** derive from the app's slug (`WEBHOOK_*_HEADER` in `@sssb/kit/core/webhook-signing`): never
   hard-code them; receivers pin these names at integration time.
4. **Test**: emit → drain → a caught delivery with a verifying signature (the reference app's
   `https://github.com/safeinsights/sssb/blob/<ref>/apps/showcase/src/app-config/webhooks.test.ts`). That test is the
   server's proof: a generated app's Simulator on `pnpm dev` has People, Mail and Jobs but no Hooks tab (that is the
   reference app's own panel), and the app has no endpoint-management route. The static demo has both: its team screen registers
   endpoints and its panel's Hooks tab shows deliveries (its failure toggle exercises the retry path). If the demo
   world emits your kind, mirror the emit in `src/demo-static/app.tsx` with `world.enqueueWebhook(kind, payload)`
   and inspect it there. Finish with `pnpm verify`.
