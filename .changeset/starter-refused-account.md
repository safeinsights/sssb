---
'@sssb/create': patch
---

### The starter's sign-in page tells a refused person why, and its sign-out takes JSON only

**Kind.** scaffold

**Action.** optional

**What changed.**

- `src/app/[locale]/signin/page.tsx` asks the auth port whether the signed-in person is refused. If they are, it shows
  the refused-account screen instead of the sign-in form: `RealAccountRefused` in real mode, and a new
  `refused-glue.tsx` in simulated mode.
- `src/app/api/auth/signout/route.ts` now refuses a request that is not JSON (`refuseNonJson`, 415). A page on a sibling
  subdomain, which the browser sends the session cookie with, could otherwise sign a person out with no click. The
  header's sign-out and the new glue send `content-type: application/json`.
- `page.test.tsx` and `route.test.ts` pin both.

**To adopt.** Copy the sign-in page's refusal branch if you run a single tenancy. Copy the sign-out route's
`refuseNonJson` check, and the JSON header on every caller of that route, whatever your settings.
