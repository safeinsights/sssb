---
'@sssb/kit': minor
---

### LLM calls have a deadline, and a provider's rate limit is `LlmUnavailableError`

**Kind.** seam

**Action.** required

**What changed.** `createRealLlm` built the Anthropic client with the SDK's defaults: ten minutes per attempt, two retries that sleep a provider's whole `Retry-After`, and a vendor 429 or 529 surfacing as the SDK's own error. Every LLM port call (`complete`, `stream`, `runToolLoop`) now ends within 25 s, retries and a tool loop's `execute` calls included, by default (the server function has 30 s). A rate limit (429), an overloaded provider (529) and a call past its deadline throw `LlmUnavailableError` from `@sssb/kit/ports/errors`, with `reason` `rate-limited`, `overloaded` or `timed-out`, the vendor SDK's error as `cause` and a `retryAfterSeconds`. `LlmRequest` and `LlmToolLoopRequest` gain an optional `timeoutMs`, and `createRealLlm(key, { timeoutMs, maxRetries })` takes defaults for an app that builds it. The adapter, not the SDK, retries each request to the provider once, and only when twice the wait is less than what is left of the deadline. The fake adapter rejects a `timeoutMs` that is not a positive number of at most 2^31 - 1 milliseconds with a `RangeError`, as the real one does. The app guide gains a rule on it.

**To adopt.** A call on a request path (a route, or a job the in-process runner runs inside the server function) needs nothing: 25 s is already inside that function's 30 s limit. But an LLM call that takes longer than 25 s now fails where it used to succeed, so an app whose job runs on a runner without the server's limit (the CodeBuild runner) breaks if it does nothing: that job's handler passes a longer `timeoutMs` on the request, to `complete`, `stream` or `runToolLoop`:

```ts
await ctx.llm.complete({ purpose: 'summarize-bundle', messages, timeoutMs: 120_000 })
```

Then let `LlmUnavailableError` propagate from a route into `withPortErrors` (the starter's changeset for `@sssb/create` adds the 503), and from a job handler, which fails the job. Code that matched the SDK's `RateLimitError` or `InternalServerError` around an LLM call must match `LlmUnavailableError` instead; an app's own adapter is not affected.

**Now deletable.** A hand-written timeout or `Promise.race` around an LLM call, and a catch that rebuilds the provider's 429 or 529 into an error of the app's own.
