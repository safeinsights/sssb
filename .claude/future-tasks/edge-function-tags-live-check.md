# Confirm, on a live deploy, that a tagged Lambda@Edge function deploys

**Priority:** P2 · **Status:** open (a live check, then either close or fix)
**Found by:** writing `fix/cdk-forwarded-host-https` (2026-11-19), reading CloudFront's "Restrictions on all edge
functions".

## Why it is in doubt

`fix/cdk-function-url-post` (#69) gave `SssbApp` a Lambda@Edge function (the request body's hash). For a stack with an
explicit region outside us-east-1, that function lives in a us-east-1 stack of its own. #69's tag mirror then gives
that stack's resources exactly the server function's tags, so a tag policy or SCP that requires tags on
`lambda:CreateFunction` does not refuse it. A function in the app's own stack (us-east-1, or no region) is tagged by
the stack's `Tags.of(...)` like any other resource.

AWS's documentation is ambiguous about whether such a function may carry tags:

- CloudFront's "Restrictions on all edge functions" has a Tagging entry saying edge functions cannot be tagged. It
  may mean CloudFront Functions, or the replicas Lambda@Edge makes, rather than the us-east-1 Lambda function itself.
- An older Lambda@Edge requirements page said tags cannot be applied to Lambda@Edge resources.
- CloudFront's own tutorial for creating a Lambda@Edge function in the Lambda console has a Tags field.

If tags on the function were refused, every explicit-region deploy outside us-east-1 would fail at its edge stack, and
so would a us-east-1 stack whose resources the adopter tags.

## The check

Deploy a stack with an explicit region outside us-east-1 (the starter's `apps/starter/infra/app.ts` with an `env`),
tagged as the starter tags it. Confirm three things:

1. The `edge-<region>-…` stack deploys.
2. Its function and role carry the app's tags (`aws lambda list-tags`, `aws iam list-role-tags`).
3. The distribution associates the function's version.

Then the same with the stack in us-east-1. This is the `deploy-pipeline` cutover row's edge-stack item.

## If it fails

Keep the role and the SSM parameter tagged. Exclude the function from tagging: `Tags.of(...)` with
`excludeResourceTypes: ['AWS::Lambda::Function']` on the edge function only, and the same exclusion in the mirror.
Then say in the construct why the function alone is untagged.
