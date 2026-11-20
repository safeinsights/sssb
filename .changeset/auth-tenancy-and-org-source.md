---
'@sssb/kit': minor
---

### Two auth settings: where the tenant comes from, and where orgs come from

**Kind.** operator

**Action.** optional

**What changed.** The auth adapters, the fake and Clerk, read two settings, each validated at boot. Left
unset, both keep today's behaviour.

- **`AUTH_TENANCY`**: `multi` (the default) reads each user's tenant from their public metadata under
  `AUTH_TENANT_METADATA_KEY` (`tenantSlug` when unset). `single`, with `AUTH_TENANT_SLUG`, fixes the tenant for the
  deployment and changes nothing else: orgs, roles, members, invitations and notifications are the org source's. A user
  whose metadata names a different tenant is refused.
- **`AUTH_ORG_SOURCE`**: `provider` (the default) is the identity provider's organizations and per-membership roles.
  `fixed`, with `AUTH_HOME_ORG_SLUG`, is for an app that uses the provider without its organizations, and needs a
  single tenancy. Every user the
  provider signs in is placed in that org with `AUTH_DEFAULT_ROLE`: `none` (the default) or `restricted`, and no role
  that writes. In this mode:
    - the members list is empty;
    - invitations are refused;
    - the home org is the only org;
    - a home org that is the app's staff org, with the role `restricted`, is refused at boot.

    On a provider instance shared with another product, every user of that product is placed in the home org.

The required-environment snapshot's `auth` section says what each choice requires: `single` needs `AUTH_TENANT_SLUG`,
and `fixed` needs `AUTH_HOME_ORG_SLUG`. The simulated world runs the same settings when its environment sets them.

**To adopt.** Nothing, to keep today's sign-in. For one tenant per deployment, set `params.auth.tenancy` to `'single'`
with `tenantSlug`, and insert that tenant's row. For an identity provider used without organizations, also set
`params.auth.orgSource` to `'fixed'` with `homeOrgSlug` (and `defaultRole` if not `none`), and insert that org's row.
Before you do, authorize every org-scoped read (the entry "A `none` role, and reads that authorize"), and grant your
people what they need through your own rules. With a fixed org source, pass `requestedBy` when you submit a job (the
entry "A job records who started it").

**Now deletable.**

- A placeholder tenant claim written into every user's identity-provider metadata.
- An identity-provider organization created only so sign-in would place people in an org.
