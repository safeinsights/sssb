/**
 * Webhook signing — the outbound webhook header NAMES, plus (re-exported) the pure signer and verifier.
 *
 * The HMAC-SHA256, `signWebhookBody` / `webhookSignatureHeader` for egress, `verifyWebhookSignature` (with a
 * replay window) for the counterparty, and the Mailgun inbound recompute all live in ./webhook-hmac.ts, which
 * is pure, isomorphic and SEAM-FREE (and is cross-checked against `node:crypto` in webhook-hmac.test.ts). This
 * module adds the one thing that needs the app: the header names, built from `APP_SLUG`, which it reads from
 * the `@sssb/app-config/*` seam when it loads. That read is why the two are split: a Playwright spec is loaded
 * by Node with no seam to read, so it reaches the signer through `@sssb/kit/testing/e2e`, never through here
 * (ADR-0014 part 2). Everything that imported this module before the split still gets every name from it.
 *
 * Scheme (Stripe-style): the signature covers `{timestamp}.{body}`; the header value is
 * `t=<unix-seconds>,v1=<hex>` under the signature header (WEBHOOK_SIGNATURE_HEADER, derived from
 * APP_SLUG — receivers pin the name at integration time, so it must carry the app's identity, not the
 * template's).
 */
import { APP_SLUG } from '@sssb/app-config/identity'

// The whole seam-free half: this module's surface is what it was before the split.
export * from './webhook-hmac'

/** Outbound webhook header names. Derived, not literal: once a receiver validates signatures the
 *  names are a frozen external contract — an adopter must inherit `x-<their-app>-*`, never the
 *  template's brand. */
export const WEBHOOK_SIGNATURE_HEADER = `x-${APP_SLUG}-signature`
export const WEBHOOK_EVENT_HEADER = `x-${APP_SLUG}-event`
export const WEBHOOK_DELIVERY_HEADER = `x-${APP_SLUG}-delivery`
