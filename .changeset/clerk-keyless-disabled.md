---
'@sssb/kit': minor
---

### Real mode under `next dev` needs Clerk's keyless mode disabled

**Kind.** operator

**Action.** required

**What changed.** Under `next dev` (which sets `NODE_ENV=development`), Clerk's keyless fallback let a request on a path
the proxy matcher skips carry forged `x-clerk-auth-*` headers that Clerk's `auth()` accepted as anyone. SSSB's Clerk
adapter now refuses to read a session or call Clerk's Backend API in exactly the two cases Clerk's own code leaves that
open: `NODE_ENV` is `development` and `NEXT_PUBLIC_CLERK_KEYLESS_DISABLED` is not `1` (or `true`), or `CLERK_SECRET_KEY` is
unset (in any `NODE_ENV`: Clerk would then check a token against an empty key). Its error names the variable. Nothing
else is refused: a production build (`next build`, then `next start`), and any other process with the secret key set and
no `NODE_ENV=development`, such as a CodeBuild job program, an ops script or a test run, needs nothing. The same
refusals now stop `createRealPorts` at boot and fail `sssb check-real-env` when that process has `NODE_ENV=development`,
as a cutover item on `auth-dev`; and when it has not (the preflight of `dev:real` runs before `next dev` does),
`check-real-env` prints a `notice:` saying what `next dev` would do with the environment it was given.

**To adopt.** Wherever you run real mode under `next dev` (a `dev:real` script, say), set the variable for the whole
script, so the preflight sees it too:

```sh
export NEXT_PUBLIC_CLERK_KEYLESS_DISABLED=1 && APP_MODE=real sssb check-real-env && APP_MODE=real next dev
```

A deployment built for production, and a process that is not `next dev`, needs nothing.
