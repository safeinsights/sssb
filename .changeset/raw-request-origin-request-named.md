---
'@sssb/eslint-plugin': patch
---

### `sssb/no-raw-request-origin` counts only the request's own URL

**Kind.** none

**Action.** none

**What changed.** The rule new in this release no longer reads every `.url` or `.nextUrl` as the request's: in its URL
forms the object must be named like the request (`req`, `request`, `nextRequest`, or a `.req` or `.request` member), so
`new URL(body.url).hostname`, `new URL(path, upstream.url)` and `baseUrl: config.url` pass, as the correct code they are.
