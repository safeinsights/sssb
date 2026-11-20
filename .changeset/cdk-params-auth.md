---
'@sssb/cdk': patch
---

### `SssbApp` sets the auth settings from `params.auth`

**Kind.** operator

**Action.** optional

**What changed.** `SssbApp` reads an optional `params.auth`, the `AuthTenancyParams` type, and sets the server's
`AUTH_TENANCY`, `AUTH_TENANT_SLUG`, `AUTH_TENANT_METADATA_KEY`, `AUTH_ORG_SOURCE`, `AUTH_HOME_ORG_SLUG` and
`AUTH_DEFAULT_ROLE` from it. It validates them at synth: an unknown key or choice, a malformed slug, a choice without its
slug, a slug or role its choice does not use, a fixed org source without a single tenancy, or a default role other than
`'none'` or `'restricted'` fails `cdk synth`.
Left out, it sets nothing, and the framework keeps its defaults.

**To adopt.** For one tenant per deployment, add `auth: { tenancy: 'single', tenantSlug }` to the params your infra
passes to `SssbApp`. For an identity provider used without organizations, add `orgSource: 'fixed', homeOrgSlug` to that (and
`defaultRole: 'restricted'` if not `'none'`). The entry "Two auth settings: where the tenant comes from, and where orgs
come from" says what each does.
