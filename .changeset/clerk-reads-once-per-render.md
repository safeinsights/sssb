---
'@sssb/kit': patch
---

### The Clerk adapter reads the signed-in person once per server render

**Kind.** none

**Action.** none

**What changed.** In real mode every `getCurrentUser()`, `listMyOrgs()`, `requireUser()` and `requireRole()` called
Clerk's Backend API again, twice for `getCurrentUser()`. Within one server render (a layout, its page and their
components) the person's account and their memberships are now read once each and shared, so a signed-in page render
makes at most two Backend API calls (one more per 100 orgs a person belongs to). Nothing is kept past the request, so
a role change, a removal from an org or a ban shows on the next one. A route handler is not a render, and reads on
each call as before.
