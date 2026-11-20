---
'@sssb/kit': minor
---

### `sameOriginPath` is published, and the sign-in redirect uses it

**Kind.** seam

**Action.** optional

**What changed.** `@sssb/kit/core/same-origin-path` is a published subpath: `sameOriginPath(value)` returns a
same-origin path, normalised, or `null`. SSSB's real sign-in form now follows its `returnTo` only through it. The
check the starter's sign-in page shipped (`returnTo.startsWith('/') && !returnTo.startsWith('//')`) let `/\evil.example` and `/<tab>/evil.example` through, which a browser resolves to another origin: an open redirect straight after a real sign-in. `sameOriginPath` answers `null` for any whitespace, backslash or control character in the path, an unencoded space included, so a fallback replaces such a value.

**To adopt.** In your `src/app/[locale]/signin/page.tsx`, and wherever your own code navigates to a value from the
URL or the server, use the function's return value:

```ts
import { sameOriginPath } from '@sssb/kit/core/same-origin-path'

const target = sameOriginPath(returnTo) ?? `/${locale}/dashboard`
```

**Now deletable.** A hand-written prefix test on a `returnTo`, `next` or `redirectTo` value.
