---
'@sssb/cdk': patch
---

### A production stack keeps its database secret

**Kind.** operator

**Action.** optional

**What changed.** `SssbApp` retained the Aurora cluster, its writer, its subnet group and both buckets when
`production` is true, but the cluster's generated master secret (`DbSecret…`) kept `DeletionPolicy: Delete` and
`UpdateReplacePolicy: Delete`. Deleting or replacing a production stack therefore kept the database and deleted the only
credentials to it. The secret now takes the same policy as the cluster: `Retain` for both in production, `Delete` for
both otherwise. Its logical id (`DbSecretCF6D79B0`) is unchanged, and the stateful snapshot is too. No KMS key or
rotation schedule exists to retain beside it: the cluster, the secret and the buckets use AWS-managed or S3-managed keys.

**To adopt.** Nothing breaks if you do nothing. Take `@sssb/cdk` and run `cdk diff` against a production stack: the only
change is the two policy attributes on the secret, which CloudFormation applies without touching the secret, its value
or the cluster (a policy attribute is not a property, so there is no replacement). A non-production stack's template is
byte-identical to before. After you take it, deleting a production stack leaves the secret behind with the cluster, as
it has always left the cluster: delete the secret by hand (Secrets Manager, `aws secretsmanager delete-secret`) when you
also delete the retained database for good, since a retained secret keeps costing its monthly charge.
