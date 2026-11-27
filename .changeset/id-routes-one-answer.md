---
'@sssb/kit': patch
---

### One answer for a missing id and a refused one

**Kind.** none

**Action.** none

**What changed.** The app guide's Authorization section has a new rule: a person who may not act gets the same
answer, status and body, whether or not a thing the request names exists (a row by its id, an org by a slug in the
body), so nothing can be probed. Authorize before the lookup when the session alone can decide; when the decision
needs the row (a two-sided subject), throw `NotFoundError` for a missing row and rethrow a `ForbiddenError` as
`NotFoundError` in a `catch` that always rethrows. The conformance check cannot see the order of a lookup and an
`authorize`, so the rule is kept by hand: the guide says to pin it with a route test that sends an existing and a
missing id as a person who may not act. The guide's earlier "call it before any `try`" now excepts that `try`.
