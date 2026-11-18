---
'@sssb/cdk': patch
---

### A dashed slug names a database Aurora accepts

**Kind.** none

**Action.** none

**What changed.** `SssbApp` names the app's database from its slug with each dash as an underscore (`acme-corp`
becomes `acme_corp`), for the cluster's default database, the server's `DATABASE_NAME` and its `DATABASE_URL`. Aurora
PostgreSQL's database names allow no dash, so an app with a dashed slug synthesized and then failed at deploy. A slug
with no dash names the same database as before, so no existing deployment changes. `databaseNameFor(slug)`, exported
from `@sssb/cdk`, gives the same name to infra that does not use the construct.
