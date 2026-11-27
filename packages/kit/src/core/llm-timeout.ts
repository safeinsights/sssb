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

/** The longest a timer can wait: Node fires one set for more than this after 1 ms. */
const LLM_MAX_TIMEOUT_MS = 2 ** 31 - 1

/**
 * The deadline for a call: what the request asked for, else `fallback`. A value that is not a positive number of
 * milliseconds a timer can wait (up to 2^31 - 1, about 24 days) is a bug in the caller, so it throws a `RangeError`
 * instead of becoming a call with no bound or one that ends at once (`0` and `Infinity` would be "now" and "never").
 */
export function llmTimeoutMs(requested: number | undefined, fallback: number = LLM_DEFAULT_TIMEOUT_MS): number {
    if (requested === undefined) return fallback
    if (!Number.isFinite(requested) || requested <= 0 || requested > LLM_MAX_TIMEOUT_MS) {
        throw new RangeError(
            `llm timeoutMs must be a positive number of milliseconds no more than ${LLM_MAX_TIMEOUT_MS}, got ${requested}`,
        )
    }
    return requested
}
