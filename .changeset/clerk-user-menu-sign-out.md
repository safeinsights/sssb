---
'@sssb/kit': minor
---

### The header's sign-out ends the session in the browser too, in real mode

**Kind.** scaffold

**Action.** optional

**What changed.** In real mode the user menu's sign-out revoked the session on Clerk's server only, so the browser kept
its short-lived session token and the page reached next could still show the person signed in for up to a minute. A
new real-mode menu, `RealUserMenu` from `@sssb/kit/adapters/real/user-menu`, signs out through Clerk's client (this
session only, then to the page you name), falling back to the sign-out route until Clerk has loaded. The conformance
check `real-auth-provider` counts it as a real auth form, so a layout that loads it must sit under one that mounts
`RealAuthProviders`, as the protected layouts already do. The starter's protected layout and header glue use it.

**To adopt.** In `src/app/[locale]/(protected)/layout.tsx`, load the menu in real mode and hand it to the header glue:

```tsx
let userMenu: ReactNode = null
if (!isSimulated) {
    const { RealUserMenu } = await import('@sssb/kit/adapters/real/user-menu')
    userMenu = <RealUserMenu user={menuUser} signedOutHref={`/${locale}`} />
}
```

Pass `profileHref` too if your menu offers a profile page. In the header glue, take a `userMenu?: ReactNode` prop and
render `{userMenu ?? <UserMenu ... />}`, keeping the existing menu for simulated mode.
