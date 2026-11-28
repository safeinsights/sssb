---
'@sssb/create': patch
---

### The header's sign-out ends the session in the browser too, in real mode

**Kind.** scaffold

**Action.** optional

**What changed.** In real mode the user menu's sign-out revoked the session on Clerk's server only, so the browser kept
its short-lived session token and the page reached next could still show the person signed in for up to a minute. The
starter's protected layout and header glue now use the kit's new real-mode menu, `RealUserMenu` (its own entry, "A
real-mode user menu that signs out in the browser", says what it does), in real mode, and keep the existing menu in
simulated mode.

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
