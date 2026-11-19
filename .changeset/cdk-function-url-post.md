---
'@sssb/cdk': minor
---

### `SssbApp` takes request bodies through CloudFront, and pins the server's `HOSTNAME`

**Kind.** operator

**Action.** required

**What changed.** A deployed app answered 403 to every `POST`, `PUT` and `PATCH`: its Function URL sits behind
CloudFront's origin access control, and Lambda refuses a request there whose body hash (`x-amz-content-sha256`) is
missing, which CloudFront never adds. `SssbApp` now runs a Lambda@Edge function on the default behavior's origin
request that sets that hash from the body, so request bodies up to 1 MB reach the server, and a larger one answers 413.
The server's environment also sets `HOSTNAME=0.0.0.0`, where Next's standalone server listens: with `127.0.0.1`,
requests through the auth provider's proxy fail. Lambda@Edge lives in us-east-1 only, so an environment-agnostic stack
now deploys to us-east-1 only (elsewhere CloudFront refuses the function and the deploy rolls back), and a stack with
an explicit region outside us-east-1 gets the function in a second stack in us-east-1, `edge-<region>-…`, carrying the
stack's tags.

**To adopt.** Upgrade and run `cdk diff`. It shows, for the stack: a new `BodyHash` function with its role and a
version, the distribution's default behavior gaining a `LambdaFunctionAssociations` entry (`origin-request`,
`IncludeBody`), and `HOSTNAME` added to the `Server` function's environment; no stateful resource changes. A stack with
an explicit region outside us-east-1 also gets a cross-region reader custom resource, and a new stack in us-east-1:
run `cdk bootstrap aws://<account>/us-east-1` first. `cdk deploy` with no stack name then refuses (the app has two
stacks): name your stack, which deploys the us-east-1 one first, or pass `--all`; `--exclusively` skips it. An
environment-agnostic stack deployed outside us-east-1 must take an explicit `env` before upgrading. A teardown can now
fail on the edge function while CloudFront drops its replicas (up to a few hours): delete the stack again then. Leave
`HOSTNAME` out of your deploy pipeline's `run.sh`.

**Now deletable.** A Lambda@Edge function of your own that sets `x-amz-content-sha256` on the distribution's default
behavior, with its role and the escape-hatch override (`LambdaFunctionAssociations`) that attaches it: keeping the
override replaces `SssbApp`'s association with yours. An `export HOSTNAME=0.0.0.0` in your `run.sh`.
