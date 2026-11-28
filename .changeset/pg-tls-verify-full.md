---
'@sssb/kit': minor
'@sssb/cdk': minor
---

### The pg transport connects over verified TLS

**Kind.** operator

**Action.** required

**What changed.** On the `pg` transport the server and the Migrator now connect to Postgres over TLS that checks the
server's certificate chains to a trusted root and names the host it connects to (libpq's `verify-full`). Before, TLS
was only what `DATABASE_URL` asked for, which on `SssbApp` was nothing, and the URL the Migrator builds from the
secret carried none. Two optional variables set it: `DATABASE_SSL_MODE` (`verify-full`, the default when unset or empty, or `disable`) and
`DATABASE_SSL_ROOT_CERT` (the absolute path of a PEM file whose certificates are then the only roots trusted). `SssbApp`
sets both on the server and the Migrator, trusting the Amazon CA bundle in the Lambda Node.js runtime
(`/var/runtime/ca-cert.pem`). A `DATABASE_URL` that sets `sslmode`, or any other `ssl*` parameter or `uselibpqcompat`,
is refused at boot, because `pg` would let it override the mode. The Data API transport is unchanged.

**To adopt.** On `SssbApp`, upgrade `@sssb/kit` and `@sssb/cdk` together, then **deploy the upgraded stack
(`cdk deploy`) before you ship the server's new code.** The stack sets the two variables on the server and the Migrator;
the server's code is what your pipeline ships (`aws lambda update-function-code`). The order matters one way only: the
new code under the old stack's environment has no root file, so it verifies against Node's own roots, which do not hold
Amazon RDS's, and every database connection fails; the old code ignores the new variables, so a stack deployed first
changes nothing until the code follows. Then run the Migrator, the first thing to connect with the new settings, and
ship the code once it succeeds.

If the Migrator cannot connect over TLS, the way back while you find out why is `DATABASE_SSL_MODE=disable` on both
functions, which connects as the previous release did, set in your stack and deployed:

```ts
sssbApp.server.addEnvironment('DATABASE_SSL_MODE', 'disable')
sssbApp.migrator.addEnvironment('DATABASE_SSL_MODE', 'disable')
```

Take it out once the cause is fixed: it is a stopgap, never a deployed database's setting. Then prove TLS on the deployed
cluster: `pnpm exec sssb doctor` reports a framework cutover row named `db-tls` that your workspace's
`docs/cutover-checklist.md` does not mention (the file was written when the workspace was generated, before the row
existed). Add it beside the others, in their shape:

```md
- [ ] `db-tls`: On `pg`, the server and the Migrator reach the database over TLS that verifies its certificate (`DATABASE_SSL_MODE`: `verify-full` when unset, never `disable` deployed; `DATABASE_SSL_ROOT_CERT`: the roots)
```

and close it once the deployed cluster proves it: with `rds.force_ssl` set to 1 in its parameter group the Migrator
still returns `{ ok: true }` and the app still serves; `pg_stat_ssl` (joined to `pg_stat_activity`, run as the master user)
shows TLS on every connection the app holds; and both Lambdas show `DATABASE_SSL_MODE` as `verify-full` or unset, since
`pg_stat_ssl` shows encryption, not that the certificate was checked. (SSSB's own checklist, in SSSB's repository, has
the full row.) A deployment of your own (another Postgres host) sets `DATABASE_SSL_ROOT_CERT`
to its host's root bundle unless its certificate chains to a root Node trusts, and removes `sslmode` and the other
`ssl*` parameters from `DATABASE_URL`. A real-mode run against a local Postgres with no TLS sets
`DATABASE_SSL_MODE=disable`; never set it on a deployed database. A Lambda deployed from a container image may not have
`/var/runtime/ca-cert.pem`: put the RDS bundle in the image and point `DATABASE_SSL_ROOT_CERT` at it.

Two more settings are refused at boot: `NODE_PG_FORCE_NATIVE` (pg's native client ignores `DATABASE_SSL_MODE`), and, in
the contract run, a `CONTRACT_DATABASE_URL` that sets `sslmode` or another `ssl*` parameter (the contract run connects
without TLS, so a server that accepts only TLS connections cannot serve it).

**Now deletable.** An `?sslmode=...` query string appended to `DATABASE_URL` by hand, and a `NODE_EXTRA_CA_CERTS`
setting added only so the database's certificate would verify.
