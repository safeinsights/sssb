---
'@sssb/kit': patch
---

### Under a fixed org source, grant your own people before denying on `restricted`

**Kind.** seam

**Action.** optional

**What changed.** The guide and the adopter reference now say what a fixed org source means for an app's rules.
Everyone it signs in has the role `none` (or `restricted`), and both are restricted, so `restricted` is `true` for
everyone and cannot tell an app's own admins from anyone else. `none` stays restricted on purpose, so nothing opens
silently.

**To adopt.** If you use a fixed org source (`params.auth.orgSource: 'fixed'`), check every rule in `appAbilityRules`,
and every route or screen that reads `user.restricted`. Each must grant your own people from your own data before it
denies on `restricted`. A check that denies on `restricted` first locks everyone out, your own admins included.

- Key the grant on `actor.userId`, never on an email.
- If only the person at the keyboard should have it, also check `actor.credential?.kind === 'session'`: an API token or
  an inbound email reaches your rules with the same `userId`.
- Your rules see `none` in no org (`sameOrg` is false), so a grant scoped to the home org needs
  `defaultRole: 'restricted'`.
