---
'@sssb/tools': patch
'@sssb/kit': patch
---

### The dev-ticker marker is written whole and cleared without a gap, and a failing default fixture entry always fails typed

**Kind.** none

**Action.** none

**What changed.** `@sssb/tools`: the dev ticker's marker is written to a name beside it and renamed onto it, so a Playwright config loading at that instant never reads half of it and passes over a ticking dev server; and a stale marker is moved aside and judged from the copy before it is deleted, so a marker another wrapper writes at the same moment is not removed with it. `@sssb/kit`: a default fixture entry with a `failure` and no answer to replay (`response: null`, no `conversation`) now throws `LlmUnavailableError` from the fake adapter's `complete`, `stream` and `runToolLoop`, as the static demo's replay already did; it threw a plain "no default entry" error.

**Now deletable.** An `response: ""` written only so that a failing default entry would fail typed.
