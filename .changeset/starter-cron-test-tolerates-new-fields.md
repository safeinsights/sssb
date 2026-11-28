---
'@sssb/create': minor
---

### The cron route's test checks the tick's answer by the fields it needs

**Kind.** scaffold

**Action.** required

**What changed.** The scheduled tick's answer gains fields in this release (`deferred`, `stoppedBy`, a `retries` part, and
`deferred` and `stoppedBy` under `deliveries`). A workspace generated before it has a test,
`apps/<app>/src/app/api/webhooks/cron/route.test.ts`, that compares that answer whole with `toEqual`, so it fails once
the packages are upgraded, and with it `pnpm test:unit`, `pnpm verify` and the workspace's `sssb / lint-typecheck-unit`
check. The starter's test now compares it with `toMatchObject`, by the fields the test relies on, so a field a later
release adds no longer fails it.

**To adopt.** In that file, in the test named "with the shared secret it runs SSSB's tick and says what it did", change
the one `toEqual` that checks the response body to `toMatchObject`:

```ts
expect(await response.json()).toMatchObject({
    ok: true,
    spawned: expect.any(Number),
    failed: 0,
    deliveries: { delivered: expect.any(Number), failed: expect.any(Number), dead: expect.any(Number) },
})
```

Leave the other test's `toEqual({ error: 'unauthorized' })` as it is: that answer is meant to stay exactly that.

**Now deletable.** An `expect.any(...)` or a hand-edited expected object kept up to date with each release's tick fields.
