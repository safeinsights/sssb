---
'@sssb/kit': minor
---

### LLM calls have a deadline, and a provider's rate limit is `LlmUnavailableError`

**Kind.** seam

**Action.** optional

**What changed.** `createRealLlm` built the Anthropic client with the SDK's defaults: ten minutes per attempt, two retries, and a vendor 429 or 529 surfacing as the SDK's own error. Every LLM port call (`complete`, `stream`, `runToolLoop`) now ends within 25 s, retries and a tool loop's `execute` calls included, by default (the server function has 30 s). A rate limit (429), an overloaded provider (529) and a call past its deadline throw `LlmUnavailableError` from `@sssb/kit/ports/errors`, with `reason` `rate-limited`, `overloaded` or `timed-out`, the vendor's error as `cause` and a `retryAfterSeconds`. `LlmRequest` and `LlmToolLoopRequest` gain an optional `timeoutMs`, and `createRealLlm(key, { timeoutMs, maxRetries })` takes defaults for an app that builds it. The SDK retries once, not twice. The fake adapter rejects a `timeoutMs` that is not a positive finite number with a `RangeError`, as the real one does. The app guide gains a rule on it.

**To adopt.** Nothing breaks: a call that took longer than 25 s now fails, so a job handler whose LLM call needs longer (one the CodeBuild runner runs; the in-process runner runs inside the server function) passes it:

```ts
await ctx.llm.complete({ purpose: 'summarize-bundle', messages, timeoutMs: 120_000 })
```

Let `LlmUnavailableError` propagate from a route into `withPortErrors` (the starter's changeset for `@sssb/create` adds the 503), and from a job handler, which fails the job. Code that matched the SDK's `RateLimitError` or `InternalServerError` around an LLM call must match `LlmUnavailableError` instead; an app's own adapter is not affected.

**Now deletable.** A hand-written timeout or `Promise.race` around an LLM call, and a catch that rebuilds the provider's 429 or 529 into an error of the app's own.
