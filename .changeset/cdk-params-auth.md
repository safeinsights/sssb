---
'@sssb/cdk': patch
---

### `SssbApp` sets the auth tenancy from `params.auth`

**Kind.** operator

**Action.** optional

**What changed.** `SssbApp` reads an optional `params.auth`, the `AuthTenancyParams` type, and sets `AUTH_TENANCY`,
`AUTH_TENANT_SLUG`, `AUTH_HOME_ORG_SLUG` and `AUTH_TENANT_METADATA_KEY` on the server from it. It validates it at synth:
an unknown key or tenancy, a malformed slug, single without both slugs, or a slug given to multi fails `cdk synth`. Left
out, it sets nothing, and the framework stays multi-tenant.

**To adopt.** To use single-tenant sign-in, add `auth: { tenancy: 'single', tenantSlug, homeOrgSlug }` to the params
your infra passes to `SssbApp` (the entry "Single-tenant sign-in, a `none` role, and a configurable tenant metadata key"
says what the mode does).
