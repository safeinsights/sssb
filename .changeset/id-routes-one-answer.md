---
'@sssb/kit': patch
---

### One answer for a missing id and a refused one

**Kind.** none

**Action.** none

**What changed.** The app guide's Authorization section has a new rule for a route that acts on one row by id: a
person who may not act gets the same answer, status and body, whether or not the id names a row, so no id can be
probed. Authorize before the lookup when the subject's org is the active org; when the subject's orgs come from the row
(a two-sided subject), answer the refusal as a missing row is, by rethrowing `ForbiddenError` as `NotFoundError` in a
`catch` that always rethrows. The conformance check cannot see the order of a lookup and an `authorize`, so the rule is
kept by hand: an app's own `[id]` routes are worth a look, with a route test that sends an existing and a missing id as
a person who may not act. The guide's earlier "call it before any `try`" now excepts that `catch`.
