---
'@sssb/kit': minor
---

### A dropped connection to the model provider is `LlmUnavailableError('connection-lost')`

**Kind.** seam

**Action.** optional

**What changed.** A connection to the provider that drops while an answer is being read, or that `fetch` cannot make, ended as the SDK's own error (a plain `AnthropicError('terminated')`, undici's bare `TypeError('terminated')`, or an `APIConnectionError`), neither repeated nor mapped. The real adapter now repeats such a call once, inside its deadline (a stream only if it had delivered no text), and then throws `LlmUnavailableError` from `@sssb/kit/ports/errors` with the new reason `connection-lost`, which `withPortErrors` already answers with a 503. `LlmUnavailableReason` gains `connection-lost`; a fixture entry's `failure` may name it. The static demo's `replayAssistant` now replays a default fixture entry's `conversation` with its tools, as the fake adapter does, where it answered the entry's `response` alone.

**To adopt.** Nothing breaks at runtime. Code that switches exhaustively on an `LlmUnavailableError`'s `reason` needs a `connection-lost` case, which TypeScript reports. Code that matched the SDK's connection errors around an LLM call must match `LlmUnavailableError` instead.

**Now deletable.** A hand-written retry or catch that rebuilds the provider's `terminated` or connection errors into an error of the app's own.
