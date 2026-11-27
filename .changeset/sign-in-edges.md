---
'@sssb/kit': patch
---

### Real sign-in waits for Clerk to load, and lets a person end a session a failed sign-in left

**Kind.** none

**Action.** none

**What changed.** The real sign-in form (`@sssb/kit/adapters/real/sign-in-form`) no longer submits a password before
Clerk's browser SDK has loaded: its button shows it is busy until then. Before, a password sent that early could act on
an attempt the browser already held, sending its account a code or finishing it. And once Clerk has created a session
for the attempt (the password alone, or an accepted second-step code) but finishing the sign-in fails, the form now
signs that session out (that session only) when the person goes back from the second step, or offers a "Sign out"
button on the password form, and then shows the form ready to sign in again. Before, the session stayed on the browser
while the form showed the password again, so the next page load could come up signed in.
