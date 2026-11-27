/**
 * The deadline of one LLM port call (`safeinsights/sssb#98`), shared by the real adapter and the fake one so a bad
 * value fails the same way in both.
 *
 * 25 s is the default because the app server's function has 30 s (`packages/cdk/src/sssb-app.js`): a call that is
 * still waiting at 25 s ends as an error the route can answer, where one that waits to 30 s ends as a killed
 * invocation and a gateway's 502. A job's handler, with no person waiting and a runner that lives longer, passes a
 * longer `timeoutMs` on the request.
 */
export const LLM_DEFAULT_TIMEOUT_MS = 25_000

/**
 * The deadline for a call: what the request asked for, else `fallback`. A value that is not a positive finite number
 * of milliseconds is a bug in the caller, so it throws a `RangeError` instead of becoming a call with no bound (`0`
 * and `Infinity` would both mean "never" to a timer).
 */
export function llmTimeoutMs(requested: number | undefined, fallback: number = LLM_DEFAULT_TIMEOUT_MS): number {
    if (requested === undefined) return fallback
    if (!Number.isFinite(requested) || requested <= 0) {
        throw new RangeError(`llm timeoutMs must be a positive, finite number of milliseconds, got ${requested}`)
    }
    return requested
}
