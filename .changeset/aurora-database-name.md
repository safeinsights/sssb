---
'@sssb/cdk': patch
'@sssb/kit': patch
---

### A dashed slug names a database Aurora accepts

**Kind.** none

**Action.** none

**What changed.** `SssbApp` names the app's database from its slug with each dash as an underscore (`acme-corp`
becomes `acme_corp`): the cluster's default database, the server's `DATABASE_NAME` or `DATABASE_URL`, and the
migrator's `DATABASE_NAME`, which the framework's migrate handler now prefers to the secret's `dbname` on `pg`. Aurora
PostgreSQL's database names allow no dash, so an app with a dashed slug synthesized and then failed at deploy. A slug
with no dash names the same database as before, so no existing deployment's database changes. A slug whose name the
engine reserves (`user`, `select`) or that runs past 63 characters is refused at synth.
`databaseNameFor(slug)`, exported from `@sssb/cdk`, gives the same name to infra that does not use the construct.
