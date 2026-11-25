---
'@sssb/kit': minor
---

### Name the origins whose Clerk session tokens a deployment accepts

**Kind.** operator

**Action.** optional

**What changed.** A new optional server setting, `CLERK_AUTHORIZED_PARTIES`: the app's own origins, comma-separated,
handed to Clerk's middleware as `authorizedParties`. With it set, a request whose session token was minted for another
origin, or names none, is signed out. Unset, nothing changes. A malformed value (a path, a trailing slash, upper case, a
wildcard, a duplicate, `http` other than for `localhost`, `127.0.0.1` or `[::1]`, an empty entry or an empty value)
fails every request the server answers, naming the entry, and `sssb check-real-env` reports it on cutover row
`auth-dev`.

**To adopt.** If your app shares its Clerk instance with another product, or your policy requires the check, set
`CLERK_AUTHORIZED_PARTIES` in each deployment's server environment to every origin that deployment is served from,
custom domain, CloudFront host and preview hosts included, each written as a bare origin:
`CLERK_AUTHORIZED_PARTIES=https://app.example.org,https://d1234abcd.cloudfront.net`. Then sign in and check a page
and an API route still see you signed in: a wrong list signs everyone out. SSSB's adopting reference, "How sign-in
places people", has the details.
