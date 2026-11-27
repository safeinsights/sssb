---
'@sssb/tools': patch
'@sssb/eslint-plugin': patch
---

### A reused pid no longer keeps a stale dev-ticker marker alive, and the vendor ban reads its list one way

**Kind.** none

**Action.** none

**What changed.** The dev ticker's marker (`dev-ticker.json`) now carries a token for the start of the process that wrote it, and is stale, ignored and cleared, when the process now at its pid has another one (a wrapper killed with SIGKILL leaves the marker, and the OS may give its pid to an unrelated process, which made the e2e configs refuse to load until the file was deleted by hand); the token is the kernel's record of the start, not a date, so a wall clock stepped later does not make a live ticker's marker stale, and a marker that cannot be judged (no token, Windows, no `ps`) stays live as before. `@sssb/tools/ticker-marker` also exports `processStartToken`. In `@sssb/eslint-plugin`, the vendor ban's two halves (`sssb/no-vendor-import` and `sssb/no-dynamic-vendor-import`) now read one list through one matcher, with its bare names anchored: a local `./pg` or `some/dir/pg` is no longer a vendor SDK to either half (it was to the declaration half), and a vendor specifier is matched without regard to case in both (`@CLERK/nextjs` was a vendor to the declaration half only). An app's own bare `sssb.vendors` entries are anchored the same way.

**Now deletable.** A hand-deleted `dev-ticker.json` after a killed ticker, and an `eslint-disable` for the vendor ban on a local file named like a vendor SDK.
