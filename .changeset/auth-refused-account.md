---
'@sssb/kit': patch
---

### A person the tenant guard refuses can see why

**Kind.** seam

**Action.** optional

**What changed.** Under a single tenancy, a person whose identity-provider account names another tenant is refused.
Before, they saw the sign-in form again while still signed in to the provider, with nothing saying why.

- The auth port gains an optional `refusal()`, which answers `{ reason: 'other-tenant' }` for such a person, and null
  otherwise.
- A new framework screen, `AccountRefused` (`@sssb/kit/components/auth/account-refused`), says the account belongs
  to another site. It offers one sign-out button, and says first that signing out also signs the person out of other
  sites that share the sign-in. Nothing signs them out on its own.

**To adopt.** In your sign-in page, after the `getCurrentUser` redirect, add
`if (await auth.refusal?.()) return <SignInScreen body={<RefusedGlue />} />`. Here `RefusedGlue` is a small client
component that renders `AccountRefused` and posts to your sign-out route; the starter's
`src/app/[locale]/signin/refused-glue.tsx` is one to copy.
