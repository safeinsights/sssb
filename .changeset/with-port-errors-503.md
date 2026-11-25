---
'@sssb/create': minor
---

### `withPortErrors` answers a database that is unavailable for now with a 503

**Kind.** scaffold

**Action.** optional

**What changed.** The starter's `src/app/api/respond.ts` maps `DatabaseUnavailableError` to a 503 with `Retry-After`,
instead of rethrowing it as a 500.

**To adopt.** In your `withPortErrors`, before the final `throw error`, importing `DatabaseUnavailableError` from
`@sssb/kit/ports/errors`:

```ts
if (error instanceof DatabaseUnavailableError) {
    console.warn(`database unavailable (${error.reason}): ${error.message}`)
    return Response.json(
        { error: 'database-unavailable', reason: error.reason },
        { status: 503, headers: { 'retry-after': String(error.retryAfterSeconds) } },
    )
}
```
