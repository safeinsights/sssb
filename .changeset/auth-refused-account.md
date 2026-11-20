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
- Its real-mode form, `RealAccountRefused` (`@sssb/kit/adapters/real/account-refused-form`), signs out through Clerk's
  client. Without that, the browser's short-lived session token would bring the same screen back.

**To adopt.** In your sign-in page, after the `getCurrentUser` redirect, check `await auth.refusal?.()`. When it
answers, show the screen instead of the sign-in form:

- in real mode, `RealAccountRefused`, loaded with `import()`;
- in simulated mode, a small client glue that renders `AccountRefused` and posts JSON to your sign-out route.

The starter's `src/app/[locale]/signin/page.tsx` and `refused-glue.tsx` show both.
