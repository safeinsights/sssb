---
'@sssb/kit': minor
'@sssb/cdk': minor
---

### Jobs and scheduled work without CodeBuild: the in-process runner and `SssbApp`'s scheduled tick

**Kind.** operator

**Action.** optional

**What changed.** `JOBS_RUNNER=in-process` (`params.ports.jobs: 'in-process'`) runs each job's registered handler in
the server, from the request or the scheduled tick that started it, records its terminal status and, for one of the app's own job kinds,
notifies its org's admins before that call returns: no CodeBuild project and no jobs webhook route. A job shares that invocation's time limit (30
seconds on `SssbApp`); longer work stays on `codebuild`. `SssbApp` takes a new option, `scheduledTick: { webhookSecret,
every? }`: an EventBridge rule (every five minutes unless `every` says otherwise) runs a function that reads that
secret and invokes the server directly with a POST of `/api/webhooks/cron`, the route behind `withWebhookSecret` that
`pnpm tick` calls in development. It goes through neither CloudFront nor the Function URL. Without the option nothing
changes in your stack.

**To adopt.** To run jobs without CodeBuild, set `jobs: 'in-process'` in `params.ports`. To run your scheduled work,
pass the secret your server's `WEBHOOK_SECRET` holds (a plain string secret):

```ts
new SssbApp(stack, 'Default', { ...props, scheduledTick: { webhookSecret } })
```

The construct grants its function read on that secret and invoke on the server; getting the value into the server's
`WEBHOOK_SECRET` stays yours. Close the `scheduled-tick` cutover row with its proof after the first deploy.

**Now deletable.** A ticker of your own (an EventBridge rule and a Lambda that POSTs a route of yours with the webhook
secret) whose route only does what a registered job kind and a `job_schedules` row would; and a route of your own that
runs scheduled work in the server because SSSB's real jobs port started every job as a CodeBuild build.
