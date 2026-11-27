---
'@sssb/kit': patch
---

### Real sign-in waits for Clerk to load, and going back after a code signs that session out

**Kind.** none

**Action.** none

**What changed.** The real sign-in form (`@sssb/kit/adapters/real/sign-in-form`) no longer submits a password before
Clerk's browser SDK has loaded: its button shows it is busy until then. Before, a password sent that early could act on
an attempt the browser already held, sending its account a code or finishing it. And once Clerk has accepted the second
step's code, going back from that step now signs out the session the code created (that session only) and returns to
the sign-in page. Before, the session stayed on the browser even though the form showed the password again, so the next
page load could come up signed in.
