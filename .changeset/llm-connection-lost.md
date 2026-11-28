---
'@sssb/kit': minor
---

### A dropped connection to the model provider is `LlmUnavailableError('connection-lost')`

**Kind.** seam

**Action.** optional

**What changed.** A connection to the provider that drops while an answer is being read, or that `fetch` cannot make, ended as the SDK's own error (a plain `AnthropicError('terminated')`, undici's bare `TypeError('terminated')`, or an `APIConnectionError`), neither repeated nor mapped. The real adapter now repeats such a call once, inside its deadline (a stream only if it had delivered no text), and then throws `LlmUnavailableError` from `@sssb/kit/ports/errors` (new in this release; its own entry says what it is) with the reason `connection-lost`. A `withPortErrors` that maps `LlmUnavailableError` (this release's `@sssb/create` entry for it says how to add one) answers it with a 503. `connection-lost` is one of the four reasons of `LlmUnavailableReason`, beside `rate-limited`, `overloaded` and `timed-out`; a fixture entry's `failure` may name it. The static demo's `replayAssistant` now replays a default fixture entry's `conversation` with its tools, as the fake adapter does, where it answered the entry's `response` alone.

**To adopt.** Nothing breaks at runtime. Code you write that switches exhaustively on an `LlmUnavailableError`'s `reason` covers all four reasons; TypeScript reports one left out. Code that matched the SDK's connection errors around an LLM call must match `LlmUnavailableError` instead.

**Now deletable.** A hand-written retry or catch that rebuilds the provider's `terminated` or connection errors into an error of the app's own.
