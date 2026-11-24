---
'@sssb/kit': minor
---

### One wait for a paused Data API cluster, and a typed error after it

**Kind.** operator

**Action.** required

**What changed.** On the `data-api` transport, a request that wakes a paused Aurora Serverless v2 cluster now makes one
wait, shared by every call that waits and polled about every second, instead of a growing backoff in each call. A call
waits 18 seconds by default. A `BeginTransaction` that is throttled joins the wait; a statement is still sent again
only after `DatabaseResumingException`, and never once another statement has succeeded in its transaction. When the
wait runs out, or the Data API throttles a statement, times it out, or says the writer or the service is not available,
the error is now `DatabaseUnavailableError` (`@sssb/kit/ports/errors`), with AWS's error as its `cause`. A few answers
that the database is resuming fail at once with it, without a wait: to a commit, whose outcome is then unknown, so
never assume that it failed; to a statement after another has succeeded in its transaction; and to a statement as a
`BadRequestException`. A `pg` deployment is unchanged.

**To adopt.** On `pg`, nothing. On `data-api`, answer the error as you would a busy service; the starter's
`withPortErrors` does it (the scaffold entry of this release). Code that matched the thrown error's `name` against
`DatabaseResumingException`, `ThrottlingException`, `StatementTimeoutException`, `DatabaseUnavailableException` or
`ServiceUnavailableError` must use the typed error instead, or it stops matching:

```ts
import { DatabaseUnavailableError } from '@sssb/kit/ports/errors'

if (error instanceof DatabaseUnavailableError) {
    // error.reason: 'resuming' | 'throttled' | 'timed-out' | 'unavailable'
}
```

Repeat a read by itself if you like, and a write only when the person asks: treat a throttled or timed-out statement or
commit as if it may have run. The wait is set on the server, in milliseconds, and checked at boot; 0 fails at once.
Leave room for the rest of the request under the server's 30-second timeout. In `infra/app.ts`, with the construct kept
(`const sssbApp = new SssbApp(...)`), before `app.synth()`:

```ts
sssbApp.server.addEnvironment('DATABASE_RESUME_BUDGET_MS', '10000')
```

**Now deletable.** Code that searches an error and its causes for AWS names, or for "is resuming", to tell that the
database is waking up.
