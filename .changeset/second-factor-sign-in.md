---
'@sssb/kit': minor
'@sssb/create': minor
---

### Sign in with an enrolled second factor

**Kind.** seam

**Action.** required

**What changed.** `RealSignInForm` (`@sssb/kit/adapters/real/sign-in-form`) now signs in a person whose account has a
second factor: after the password it asks for a code from an authenticator app, a text message, an email or a set of
backup codes, whichever the account offers, with a choice and a resend. It does the same for the provider's check of a
new device. It used to stop there with a message that it was not built. A factor it takes no code for (a passkey, an
emailed link), and any other status it does not know, gets a message that says so.
`SignInLabels` loses `mfaNotImplemented`, and the framework catalog loses `auth.mfaNotImplemented`.

**To adopt.** Delete this line from your sign-in page's `labels` (`src/app/[locale]/signin/page.tsx`); with it left in,
a page that writes the labels inline no longer typechecks, and any other logs a missing message:

```ts
mfaNotImplemented: t('mfaNotImplemented'),
```

The form reads the rest of its copy from the framework's catalog, so it
must render under `NextIntlClientProvider`, as `SignInScreen` must. Once you have tried it on your provider's development
instance (the `auth-dev` row of SSSB's cutover checklist), an operator whose provider requires a second factor can use
SSSB's form. It signs in with a factor a person already has: enrolling one still happens outside SSSB.

**Now deletable.** A sign-in form of your own written to handle a second factor or a new-device check.
