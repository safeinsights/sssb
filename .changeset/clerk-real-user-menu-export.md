---
'@sssb/kit': patch
---

### A real-mode user menu that signs out in the browser

**Kind.** seam

**Action.** optional

**What changed.** A new published subpath, `@sssb/kit/adapters/real/user-menu`, exports `RealUserMenu`: the user menu for
real mode, which signs out through Clerk's client (this session only, then to the page you name), falling back to the
sign-out route until Clerk has loaded, so the browser does not keep a short-lived session token after the server has
revoked the session. The conformance check `real-auth-provider` counts it as a real auth form, so a layout that loads it
must sit under one that mounts `RealAuthProviders`, as the protected layouts already do.

**To adopt.** Load it only in real mode, with `import()`, as any of SSSB's real adapters; the `@sssb/create` entry
"The header's sign-out ends the session in the browser too, in real mode" shows where the starter does.
