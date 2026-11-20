---
'@sssb/create': patch
---

### The starter's sign-in page tells a refused person why

**Kind.** scaffold

**Action.** optional

**What changed.** `src/app/[locale]/signin/page.tsx` asks the auth port whether the signed-in person is refused. If
they are, it shows `AccountRefused` through a new `refused-glue.tsx` instead of the sign-in form. The glue posts to the
app's sign-out route, then reloads the page.

**To adopt.** Copy both changes into your own sign-in page if you run a single tenancy. The entry "A person the
tenant guard refuses can see why" says what they do.
