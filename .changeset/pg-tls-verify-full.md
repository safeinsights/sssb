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

**To adopt.** On `SssbApp`, upgrade `@sssb/kit` and `@sssb/cdk` together and redeploy: the stack sets the variables,
and there is nothing else to do. Then work the new `db-tls` row of your cutover checklist, which names the proof on the
deployed cluster. A deployment of your own (another Postgres host) sets `DATABASE_SSL_ROOT_CERT` to its host's root
bundle unless its certificate chains to a root Node trusts, and removes `sslmode` and the other `ssl*` parameters from
`DATABASE_URL`. A real-mode run against a local Postgres with no TLS sets `DATABASE_SSL_MODE=disable`; never set it on
a deployed database. A Lambda deployed from a container image may not have `/var/runtime/ca-cert.pem`: put the RDS
bundle in the image and point `DATABASE_SSL_ROOT_CERT` at it.

**Now deletable.** An `?sslmode=...` query string appended to `DATABASE_URL` by hand, and a `NODE_EXTRA_CA_CERTS`
setting added only so the database's certificate would verify.
