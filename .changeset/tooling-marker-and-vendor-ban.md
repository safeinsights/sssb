---
'@sssb/tools': patch
'@sssb/eslint-plugin': patch
---

### A reused pid no longer keeps a stale dev-ticker marker alive, and the vendor ban reads its list one way

**Kind.** none

**Action.** none

**What changed.** The dev ticker's marker (`dev-ticker.json`) is now stale, and cleared, when the process now at its pid started after the marker was written (a wrapper killed with SIGKILL leaves it, and the OS may give its pid to an unrelated process, which made the e2e configs refuse to load until the file was deleted by hand); where the start time cannot be told (Windows, no `ps`) it stays live as before. `@sssb/tools/ticker-marker` also exports `processStartedAt`. In `@sssb/eslint-plugin`, the vendor ban's two halves (`sssb/no-vendor-import` and `sssb/no-dynamic-vendor-import`) now read one list through one matcher, with its bare names anchored: a local `./pg` or `some/dir/pg` is no longer a vendor SDK to either half (it was to the declaration half), and a vendor specifier is matched without regard to case in both (`@CLERK/nextjs` was a vendor to the declaration half only). An app's own bare `sssb.vendors` entries are anchored the same way.

**Now deletable.** A hand-deleted `dev-ticker.json` after a killed ticker, and an `eslint-disable` for the vendor ban on a local file named like a vendor SDK.
