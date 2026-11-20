---
'@sssb/kit': patch
'@sssb/tools': patch
---

### Deployment and tooling fixes from the 0.4.0 baseline review

**Kind.** operator

**Action.** optional

**What changed.**

- The CodeBuild jobs runner passes the job's org to the build as `JOB_ORG_ID` (empty for none). Job payloads go to
  CodeBuild as plaintext, readable in its console and in CloudTrail: never put a secret or personal data in one.
- The PostHog adapter's `capture` waits for the event to be sent, for at most two seconds, so an event is not lost
  when a Lambda freezes after its response. A slow or failed send is logged, never thrown.
- Mailgun inbound: a token is remembered until its signature goes stale, which closes a replay window when the
  sender's clock runs ahead. The new `forgetMailgunToken` (`@sssb/kit/service-auth/mailgun`) lets a route forget a
  token whose handler failed, so the provider's retry is processed.
- The migrator encodes the database name in its connection URL. Migration 0015's role error says SSSB.
- Data API transport: a date before year 1 or after 9999 is accepted; an array of a type node-postgres has no
  parser for (an `enum[]`) comes back as Postgres text, as on `pg`; a string constant continued on the next line is
  read as one string.
- `parseDbKeysetCursor` answers `invalid` for a cursor at year 0000, which the database cannot hold, so the route's 400 replaces a 500. A failed webhook enqueue after a job status commits
  is logged and no longer fails the caller. An outbound webhook's response body is cancelled once its status is read.
- A relative `APP_DATA_DIR` works: fake storage refused every key under one. A fake analytics flag named like an `Object.prototype` member
  answers its default.
- In a linked git worktree anywhere (a `.git` file that points into `worktrees/`), not only under
  `.claude/worktrees/`, an app's ports are derived per checkout; a checkout that is itself a worktree of a bare
  repository now gets derived ports too. `pnpm exec sssb port` prints them. Ladle's derived ports start at 61001.
- `createTicker(...).stop()` resolves to the ticker's status, as its type said. `sssb serve-standalone` forwards
  SIGINT, SIGTERM and SIGHUP to the server and fails when the server dies on a signal.
- The static demo: notification emails escape their copy; a held job's webhook goes to the job's own org; an actor
  completing a job emits what the server emits; Exit during a tour step stays exited; reset reseeds schedules from
  the world clock.

**To adopt.** Nothing is required. A CodeBuild buildspec can read `JOB_ORG_ID`. An inbound-email route can call
`forgetMailgunToken(token)` when its handler throws or answers a 5xx, as SSSB's reference app does.
