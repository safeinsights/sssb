---
'@sssb/kit': minor
---

### A stream that fails after text is visible, and a fixture can fail the same way

**Kind.** seam

**Action.** optional

**What changed.** The conformance suite gains a check, `llm-stream-failure`, which every app runs from its own `src/sssb.conformance.test.ts` with no change: a stream that fails after some of its text ends in a thrown `LlmUnavailableError` and not in an end that reads as a complete answer, in the real adapter, the fake adapter and the static demo's replay alike. A fixture entry (`fixtures/llm/<purpose>.json`) may now carry `"failure": { "reason": "overloaded" }` (or `rate-limited`, `timed-out`): the fake adapter's `complete` throws, its `stream` yields the entry's `response` and then throws, its `runToolLoop` runs the recorded tool calls and then throws; the static demo's `replayAssistant` takes the same entry. `@sssb/kit/adapters/fake/llm` exports `createFakeLlm({ fixturesDir, catchRequests })` beside `fakeLlm`. The port's docs and the app guide say what `stream` can throw.

**To adopt.** Nothing breaks. An app with a route or a screen that consumes `llm.stream` can test its failure path with a fixture entry that has a `failure`, and should say the failure in the response's body once the response has begun (SSSB's reference app, the showcase, does so in its assistant route, whose NDJSON answer ends with an `{ "error": ... }` line). An app that leaves the check out names it in `optOut` with a reason.

**Now deletable.** A hand-written fixture or mock that throws partway through a stream to test a consumer's failure path.
