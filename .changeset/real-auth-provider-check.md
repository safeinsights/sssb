---
'@sssb/kit': minor
---

### The conformance suite checks that real-mode sign-in has its provider

**Kind.** seam

**Action.** required

**What changed.** SSSB's real sign-in and invite forms (`@sssb/kit/adapters/real/sign-in-form`,
`@sssb/kit/adapters/real/accept-invite-form`) call the auth provider's client hooks, which throw outside its
provider, `RealAuthProviders` (`@sssb/kit/adapters/real/providers`). Only real mode loads either, so a missing
provider showed nowhere but in a real sign-in page that failed to render. A new conformance check,
`real-auth-provider`, reads every module under the app's `src/app` and fails one that loads either form with no
`layout` in its directory or above it that loads the provider.

**To adopt.** If your conformance suite fails `real-auth-provider`, mount the provider in your locale layout,
`src/app/[locale]/layout.tsx`, in real mode only:

```tsx
async function AuthProviders({ children }: { children: ReactNode }) {
    if (isSimulated) return children
    const { RealAuthProviders } = await import('@sssb/kit/adapters/real/providers')
    return <RealAuthProviders>{children}</RealAuthProviders>
}
```

and wrap the layout's children in `<AuthProviders>`. An app whose layout already mounts it, or that renders neither
form, changes nothing.

**Now deletable.** A `ClerkProvider` imported from `@clerk/nextjs` in your own layout to make real-mode sign-in work:
`RealAuthProviders` is that provider, and keeps the vendor import inside SSSB's adapters.
