# Outbound email over SMTP: one adapter for most providers

**Priority:** P3 · **Status:** open, recorded design; build when an adopter wants a provider other than Mailgun
**Decided in:** ADR-0015, section 1 and the second addendum (2026-11-19).

## Why

Postmark, Amazon SES, Resend and Mailgun itself accept SMTP, so an `smtp` choice for `EMAIL_PROVIDER` covers most
providers with one adapter, and no third party writes against the email port. An app that needs a provider's own
features (templates, tags, suppression lists) still adds a port of its own beside SSSB's, per
`docs/recipes/app-owned-adapter.md`.

## What to build

- **The adapter:** `EMAIL_PROVIDER=smtp`, with a host, port, user and password, and its SDK behind the vendor fence.
  Name the SMTP client in SSSB's vendor list.
- **The email port:** consider an optional `headers` on `EmailMessage` while it is open. Vendors read their extensions
  from headers over SMTP (`X-PM-Tag`, `X-Mailgun-Tag`, `X-SES-CONFIGURATION-SET`), and a field lets an app use them
  without SSSB knowing the vendor. Design it against Mailgun and SMTP both (second addendum, point 2).
- **The settings:** the required-environment snapshot gains the choice (a `minor` changeset), and `SssbApp` passes the
  switch through.

## Done when

- The choice boots with its settings and fails at boot without them.
- Nothing loads its client for other choices (an esbuild graph test).
- A message reaches a local SMTP sink in a test.
- A cutover row names the live checks: a cold-start connection's latency on Lambda, and deliverability.
