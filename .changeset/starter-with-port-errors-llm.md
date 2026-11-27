---
'@sssb/create': patch
---

### `withPortErrors` answers an LLM provider that is unavailable for now with a 503

**Kind.** scaffold

**Action.** optional

**What changed.** The starter's `src/app/api/respond.ts` maps `LlmUnavailableError` (a provider rate limit, an overloaded provider, or an LLM call past its deadline) to a 503 with `Retry-After`, instead of rethrowing it as a 500.

**To adopt.** In your `withPortErrors`, before the final `throw error`, importing `LlmUnavailableError` from `@sssb/kit/ports/errors`:

```ts
if (error instanceof LlmUnavailableError) {
    console.warn(`llm unavailable (${error.reason}): ${error.message}`)
    return Response.json(
        { error: 'llm-unavailable', reason: error.reason },
        { status: 503, headers: { 'retry-after': String(error.retryAfterSeconds) } },
    )
}
```
