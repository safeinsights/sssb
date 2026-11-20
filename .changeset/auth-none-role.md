---
'@sssb/kit': minor
---

### A `none` role, and reads that authorize

**Kind.** seam

**Action.** required

**What changed.**

- **A new role, `none`**, the lowest, with no standing in the org its holder is placed in. SSSB's rules let it read or
  write nothing org-scoped, never let it wield the staff org's manage-all, and hand an app's `appAbilityRules` a
  `sameOrg` that is false for it and an active org that matches none. `Role` gains `'none'`, and `hasStanding(role)` is
  exported from `@sssb/kit/core/roles`. A fixed org source (the entry "Two auth settings: where the tenant comes from,
  and where orgs come from") gives it to everyone by default. A provider membership whose role is the string `'none'`
  is now read as `none`, where it used to fall back to `guest`; SSSB never writes it, and an invitation cannot grant it.
- **`MemberStanding`**, what the auth port's `getMember` returns, gains optional `name` and `email`, which SSSB's
  adapters always fill, so a notification can reach one known person.

**To adopt.**

- Code that branches on `Role` must handle `'none'`.
- In `appAbilityRules`, grant org-scoped access through the `sameOrg` you are handed, never because a role is not some
  other role, which would grant `none` too.
- Authorize org-scoped reads, as the starter's items GET now does (`authorize(user, orgId, 'read', …)`): a route that
  lists an org's data by the session's org alone shows it to anyone placed there.

An app on the default auth settings sees no `none` user unless an operator writes that role on a membership.

**Now deletable.** An app-side override that forced every user's role down to deny-by-default.
