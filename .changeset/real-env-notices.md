---
'@sssb/kit': patch
'@sssb/tools': patch
---

### `sssb check-real-env` says when `CLERK_AUTHORIZED_PARTIES` is unset

**Kind.** operator

**Action.** optional

**What changed.** `CLERK_AUTHORIZED_PARTIES` is optional, and unset it leaves a deployment accepting a Clerk session
token minted for any origin its instance signed. Nothing told an operator the check was off. After a passing
`sssb check-real-env` prints `real-mode env complete`, it now prints a `notice:` line when the variable is unset, and one
for any variable spelled like it and not it (`CLERK_AUTHORISED_PARTIES`), which does nothing though a value looks set. The exit code is unchanged: unset is a supported setting, so a notice is advice, never a failure. The lines come
from `realEnvNotices()` in `@sssb/kit/adapters/real/index`, which `check-real-env` calls if the framework has it. It
reads the environment the command runs in, so it speaks for your server only when run with the server's.

**To adopt.** Nothing is required. Read the notice, and set `CLERK_AUTHORIZED_PARTIES` on the server to the origins it is
served from if you meant to (SSSB's adopting reference, `docs/adopting-reference.md` in SSSB's repository, "Name the origins whose session tokens your app accepts").
