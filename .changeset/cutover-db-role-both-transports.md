---
'@sssb/kit': patch
---

### The `db-role-not-superuser` cutover row covers the Data API transport

**Kind.** operator

**Action.** optional

**What changed.** The cutover row `db-role-not-superuser` said "The role in `DATABASE_URL`", but a deployment on the
Data API transport sets no `DATABASE_URL`: the role it connects as is the one the secret at `DATABASE_SECRET_ARN` holds.
The row (`@sssb/kit/cutover/rows.json`, and its proof in SSSB's checklist) now names both, and says how to run the
check on each: through `DATABASE_URL` on `pg`, with `aws rds-data execute-statement` and that secret on `data-api`.

**To adopt.** If your deployment uses `data-api`, close the row by running its check through the Data API as the
role the secret at `DATABASE_SECRET_ARN` holds. You may copy the new wording into your own checklist's row; nothing
reads it but people.
