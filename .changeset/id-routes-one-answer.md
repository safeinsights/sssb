---
'@sssb/kit': patch
---

### One answer for a missing id and a refused one

**Kind.** seam

**Action.** optional

**What changed.** The app guide (`@sssb/kit/guide.md`) has a new rule in its Authorization section: a person who may
not act gets the same answer, status and body, whether or not a thing the request names exists (a row by its id, an
org by a slug in the body), so nothing can be probed. Authorize before the lookup when the session alone can decide;
when the decision needs the row (a two-sided subject), throw `NotFoundError` for a missing row and rethrow a
`ForbiddenError` as `NotFoundError` in a `catch` that always rethrows. The conformance check cannot see the order of a
lookup and an `authorize`, so no gate keeps the rule and nothing fails on upgrade: it is kept by hand. The guide's
earlier "call it before any `try`" now excepts that `try`.

**To adopt.** Read the guide's rule "A person who may not act gets the same answer, status and body, whether or not a
thing the request names exists", then review your own routes that look something up by request input: an `[id]` in
the path, a slug or id in the body. A route that answers 404 for a missing row before it authorizes tells a person who
may not act which ids exist; move `authorize` before the lookup, or, when it needs the row, use the guide's rethrow.
Pin each such route with a route test that sends an existing id and a missing one as a person who may not act, and
expects the same status and body for both.
