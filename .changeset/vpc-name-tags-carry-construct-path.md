---
'@sssb/cdk': patch
---

### The VPC's `Name` tags change in place on the first deploy on `SssbApp`

**Kind.** operator

**Action.** none

**What changed.** With the stack's resources now inside the `SssbApp` construct (id `Default`), every logical id is
unchanged, but CDK's `Name` tag on the VPC, its subnets, route tables, gateways and elastic IP now carries the
construct path (`<Stack>/Default/Vpc…` instead of `<Stack>/Vpc…`). The first deploy updates those tags in place;
nothing is replaced. Anything that finds these resources by that tag (a `Vpc.fromLookup` by `Name`, a cost report,
a script) needs the new value.
