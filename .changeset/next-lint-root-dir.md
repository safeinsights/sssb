---
'@sssb/eslint-plugin': patch
---

### No "Pages directory cannot be found" when linting from the workspace root

**Kind.** none

**Action.** none

**What changed.** The preset tells Next's lint rules where each app is (`settings.next.rootDir`), so ESLint run from
the workspace root no longer prints "Pages directory cannot be found", and `@next/next/no-html-link-for-pages`
checks links against the app's routes from there too, rather than skipping them.
