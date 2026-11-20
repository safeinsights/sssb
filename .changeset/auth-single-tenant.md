---
'@sssb/kit': minor
---

### Single-tenant sign-in, a `none` role, and a configurable tenant metadata key

**Kind.** seam

**Action.** required

**What changed.**

- **A new role, `none`**, the lowest, with no standing. SSSB's rules let it read or write nothing org-scoped, never let
  it wield the staff org's manage-all, and hand an app's `appAbilityRules` a `sameOrg` that is false for it. `Role`
  gains `'none'`, and `hasStanding(role)` is exported from `@sssb/kit/core/roles`.
- **A single-tenant mode, `AUTH_TENANCY=single`**, with `AUTH_TENANT_SLUG` and `AUTH_HOME_ORG_SLUG`. Every user the
  identity provider signs in is placed in that tenant and org with role `none`, so no Clerk organization or tenant
  metadata is needed, and the app's own rules decide the rest. In this mode:
    - the members list is empty;
    - invitations are refused;
    - the home org is the only org;
    - a user whose metadata names a different tenant is refused.

    It applies to the fake too when the environment sets it.

- **Multi-tenant (the default, unchanged)** reads the tenant from public metadata under `AUTH_TENANT_METADATA_KEY`,
  `tenantSlug` when unset.
- **The required-environment snapshot** gains an `auth` section: `single` requires the two slugs.

**To adopt.**

- **Every app.** Code that branches on `Role` must handle `'none'`. In `appAbilityRules`, grant org-scoped access
  through the `sameOrg` you are handed, never because a role is not some other role, which would grant `none` too. An
  app that never turns the mode on sees no `none` user.
- **Pages (one tenant per deployment):**
    1. In `apps/<app>/config/params.ts`, set `auth: { tenancy: 'single', tenantSlug: '<your tenant>', homeOrgSlug: '<your
org>' }`.
    2. Check that the tenant and org rows those slugs name exist in the deployed database.
    3. Remove the tenant claim you filled into Clerk metadata (`tenantSlug`) and the Clerk organization you created only
       so sign-in would work.
    4. Grant your publishers through your own rules: every Clerk user, Canopy's included on the shared instance, now
       signs in with role `none` and nothing more.
    5. For `pnpm dev` to match, set `AUTH_TENANCY=single` and the two slugs in your dev environment, with your seeded
       people in that tenant.

**Now deletable.**

- A placeholder `tenantSlug` written into every user's Clerk metadata.
- A Clerk organization created only so sign-in would place people.
- An app-side override that forced every user's role down to deny-by-default.
