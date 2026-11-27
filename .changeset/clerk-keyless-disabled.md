---
'@sssb/kit': minor
---

### Real mode under `next dev` needs Clerk's keyless mode disabled

**Kind.** operator

**Action.** required

**What changed.** Outside a production build, Clerk's keyless fallback let a request on a path the proxy matcher skips
carry forged `x-clerk-auth-*` headers that Clerk's `auth()` accepted as anyone. SSSB's Clerk adapter now refuses to
read a session or call Clerk's Backend API outside a production build unless `NEXT_PUBLIC_CLERK_KEYLESS_DISABLED` is `1` (or `true`) and
`CLERK_SECRET_KEY` is set, and its error names the variable. A production build (`next build`, then `next start`) is
unchanged.

**To adopt.** Wherever you run real mode under `next dev` (a `dev:real` script, say), set the variable for that
process:

```sh
NEXT_PUBLIC_CLERK_KEYLESS_DISABLED=1 APP_MODE=real next dev
```

A deployment built for production needs nothing.
