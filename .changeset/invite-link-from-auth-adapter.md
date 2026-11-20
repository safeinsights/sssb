---
'@sssb/kit': minor
---

### The invitation mail carries a link the real accept page can use

**Kind.** seam

**Action.** required

**What changed.** SSSB mailed every invitee `/<locale>/accept-invite?invite=<id>`, the fake's link, in every mode. In
real mode the accept page reads Clerk's `__clerk_ticket`, which that link never carries, so a real invitation could
not be accepted from SSSB's mail. The link is now the auth adapter's to build: `AuthPort.createInvite` takes
`acceptPageUrl` (the app's accept page, absolute, no query) and returns a `CreatedInvite`, a `Membership` with
`acceptUrl`, the link to mail. The fake returns its page with `?invite=<id>`, as before; the Clerk adapter passes the
page's path to Clerk as `redirectUrl` (a path, since a deployed request's URL names the server's own host) and returns
Clerk's invitation URL. When the adapter returns no link, `sendOrgInvite` sends no mail of its own, and it never
returns the link to its caller: it is the invitee's credential. `RealAcceptInviteForm` takes an optional `status`, the
page's `__clerk_status`: `sign_in`, an invitee who already has an account, signs in by ticket rather than signing up,
and `complete`, an invitation Clerk already accepted, only redirects. It also submits a ticket once, after Clerk has
loaded: it used to submit it again as Clerk loaded, and twice under React's StrictMode.

**To adopt.** If your app calls `sendOrgInvite`, its code changes nothing, but in real mode Clerk now sends invitees to
your `/<locale>/accept-invite` page: an app that invites people needs that page, rendering `RealAcceptInviteForm` with
`ticket` and `status` from `__clerk_ticket` and `__clerk_status`, as SSSB's showcase does. If it calls
`auth.createInvite` itself, pass
`acceptPageUrl` and mail the returned `acceptUrl` to the invitee only (never send it back to the inviter), sending
nothing when it is `null`. An app-side fake or test double of the auth port returns `acceptUrl` too.

**Now deletable.** Code that rebuilds an accept link from an invitation's id, or appends a ticket to one, after calling
`createInvite`.
