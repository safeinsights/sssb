import Anthropic, { type APIError } from '@anthropic-ai/sdk'
import { LLM_MODELS } from '../../core/llm-models'
import { llmTimeoutMs } from '../../core/llm-timeout'
import { LlmUnavailableError, type LlmUnavailableReason } from '../../ports/errors'
import type { LlmContentBlock, LlmPort, LlmRequest, LlmToolLoopRequest, LlmTurn } from '../../ports/llm'

/**
 * AUTHORED — CUTOVER (`llm-key`): typechecked, never run against the real API. Also used by each
 * app's own `scripts/llm-record.ts` to (re)record fixtures. The `llm-key` cutover row's deferred
 * verification covers BOTH: re-recording the conversation fixtures AND running one live tool loop
 * (`runToolLoop` below — tool_use/tool_result blocks, loop until end_turn or maxTurns).
 */

/** What an app that builds the adapter itself (a recording script, an adapter of its own) can tune. */
export interface RealLlmOptions {
    /** The deadline of a call that names none, in milliseconds. Default `LLM_DEFAULT_TIMEOUT_MS`, 25 s. */
    timeoutMs?: number
    /**
     * How often the adapter repeats a call the provider refused (429, 529, 5xx), that dropped its connection or whose
     * stream failed before its first text, when the wait fits in what is left of the deadline. Default 1.
     */
    maxRetries?: number
}

/** The two options every SDK call takes from the deadline: the signal that bounds it, the per-attempt timeout. */
interface CallLimits {
    signal: AbortSignal
    timeout: number
}

/**
 * Every call runs under one deadline (`timeoutMs` on the request, else `options.timeoutMs`, else 25 s), enforced with
 * an abort signal on each SDK call (the SDK's own `timeout` is per attempt, and its default is ten minutes), and on
 * the app's `execute` in a tool loop, which the loop stops waiting for when the deadline passes. The SDK's own retries
 * are off, because it sleeps a provider's whole `Retry-After` and so hides it: the adapter retries itself, once by
 * default, only when the wait fits in what is left of the deadline, and otherwise answers at once with the provider's
 * own figure. What the provider says (429, 529, a mid-stream overload) or a call that outruns the deadline becomes
 * `LlmUnavailableError` (`@sssb/kit/ports/errors`); any other error, the app's `execute` throwing included, passes
 * through as it is. `safeinsights/sssb#98`, `docs/decision-log.md`, "The LLM adapter has a deadline".
 */
export function createRealLlm(apiKey: string, options: RealLlmOptions = {}): LlmPort {
    const defaultTimeoutMs = llmTimeoutMs(options.timeoutMs)
    const maxRetries = options.maxRetries ?? 1
    if (!Number.isInteger(maxRetries) || maxRetries < 0) {
        throw new RangeError(`llm maxRetries must be a non-negative integer, got ${maxRetries}`)
    }
    const client = new Anthropic({ apiKey, maxRetries: 0 })

    const toParams = (request: LlmRequest) => ({
        model: request.model ?? LLM_MODELS.default,
        ...(request.system === undefined ? {} : { system: request.system }),
        messages: request.messages,
        max_tokens: request.maxTokens ?? 1024,
    })

    /** Calls `call` again after a failure worth repeating, while the wait fits in the deadline; else throws it. */
    async function retrying<T>(deadline: Deadline, call: () => Promise<T>): Promise<T> {
        for (let retry = 0; ; retry++) {
            try {
                return await call()
            } catch (error) {
                const wait = retry < maxRetries ? retryWaitMs(error, retry) : undefined
                if (wait === undefined || wait >= deadline.remainingMs()) throw error
                await deadline.pause(wait)
            }
        }
    }

    /** Runs `body` under the request's deadline, and turns what ends it into the port's error. */
    async function underDeadline<T>(
        requested: number | undefined,
        body: (deadline: Deadline) => Promise<T>,
    ): Promise<T> {
        const deadline = startDeadline(llmTimeoutMs(requested, defaultTimeoutMs))
        try {
            return await body(deadline)
        } catch (error) {
            throw portError(error, deadline)
        } finally {
            deadline.release()
        }
    }

    return {
        complete(request) {
            return underDeadline(request.timeoutMs, async (deadline) => {
                const message = await retrying(deadline, () =>
                    client.messages.create(toParams(request), deadline.limits),
                )
                const text = message.content
                    .filter((block): block is Anthropic.TextBlock => block.type === 'text')
                    .map((block) => block.text)
                    .join('')
                return { text }
            })
        },

        async *stream(request) {
            // A generator body runs on first iteration, so the deadline starts when the stream is consumed, and
            // `finally` ends it (and the request, if the consumer stopped early) wherever the loop is left.
            const deadline = startDeadline(llmTimeoutMs(request.timeoutMs, defaultTimeoutMs))
            try {
                for (let retry = 0; ; retry++) {
                    let delivered = false
                    try {
                        const stream = client.messages.stream(toParams(request), deadline.limits)
                        for await (const chunk of stream) {
                            if (chunk.type === 'content_block_delta' && chunk.delta.type === 'text_delta') {
                                delivered = true
                                yield chunk.delta.text
                            }
                        }
                        // The SDK ends the iteration quietly, with no error, when the signal aborts while the consumer
                        // is busy between chunks: a stream cut off by the deadline must not read as a complete one.
                        if (stream.aborted) throw new Anthropic.APIUserAbortError()
                        return
                    } catch (error) {
                        // Only a stream that has delivered nothing can start again: a consumer has the rest.
                        const wait = delivered || retry >= maxRetries ? undefined : retryWaitMs(error, retry)
                        if (wait === undefined || wait >= deadline.remainingMs()) throw error
                        await deadline.pause(wait)
                    }
                }
            } catch (error) {
                throw portError(error, deadline)
            } finally {
                deadline.release()
            }
        },

        runToolLoop(request) {
            return underDeadline(request.timeoutMs, (deadline) =>
                toolLoop(request, deadline, (params) =>
                    retrying(deadline, () => client.messages.create(params, deadline.limits)),
                ),
            )
        },
    }
}

async function toolLoop(
    request: LlmToolLoopRequest,
    deadline: Deadline,
    create: (params: Anthropic.MessageCreateParamsNonStreaming) => Promise<Anthropic.Message>,
): Promise<{ text: string; turns: LlmTurn[] }> {
    const tools: Anthropic.Tool[] = request.tools.map((t) => ({
        name: t.name,
        description: t.description,
        input_schema: t.inputSchema,
    }))
    // Running SDK message history (assistant + tool_result turns), fed back each round.
    const messages: Anthropic.MessageParam[] = request.messages.map((m) => ({
        role: m.role,
        content: m.content,
    }))
    // Port-shaped view of the same conversation (serializes to the fixture format).
    const turns: LlmTurn[] = []
    const maxTurns = request.maxTurns ?? 6

    for (let round = 0; round < maxTurns; round++) {
        const message = await create({
            model: request.model ?? LLM_MODELS.default,
            ...(request.system === undefined ? {} : { system: request.system }),
            messages,
            tools,
            max_tokens: request.maxTokens ?? 1024,
        })

        const assistantBlocks: LlmContentBlock[] = []
        for (const block of message.content) {
            if (block.type === 'text') assistantBlocks.push({ type: 'text', text: block.text })
            else if (block.type === 'tool_use')
                assistantBlocks.push({ type: 'tool_use', id: block.id, name: block.name, input: block.input })
            // Other block types (thinking, server tools) aren't used by this surface.
        }
        turns.push({ role: 'assistant', content: assistantBlocks })
        messages.push({ role: 'assistant', content: message.content })

        if (message.stop_reason !== 'tool_use') {
            return { text: textOf(assistantBlocks), turns }
        }

        // Relay each tool_use to the app's executor LIVE, then feed all results back at once.
        const toolResults: Anthropic.ToolResultBlockParam[] = []
        const resultBlocks: LlmContentBlock[] = []
        for (const block of message.content) {
            if (block.type !== 'tool_use') continue
            // Defense-in-depth mirror of the fake adapter: never execute a tool_use whose
            // name the app didn't supply — the model is untrusted (see the port trust model).
            const known = request.tools.some((t) => t.name === block.name)
            // `execute` takes no signal, so a slow one cannot be stopped: the loop stops waiting for it when the
            // deadline passes (the tool runs on) and the call ends as timed-out.
            const result = known
                ? await deadline.race(request.execute({ name: block.name, input: block.input }))
                : `unknown tool: ${block.name}`
            toolResults.push({ type: 'tool_result', tool_use_id: block.id, content: result })
            resultBlocks.push({ type: 'tool_result', toolUseId: block.id, content: result })
        }
        messages.push({ role: 'user', content: toolResults })
        turns.push({ role: 'user', content: resultBlocks })
    }

    // Hit maxTurns without an end_turn: return the last assistant text.
    const lastAssistant = [...turns].reverse().find((t) => t.role === 'assistant')
    return { text: lastAssistant ? textOf(lastAssistant.content) : '', turns }
}

/** One call's deadline: an abort signal that fires when `ms` have passed, and whether it was that timer that fired it. */
interface Deadline {
    readonly limits: CallLimits
    readonly ms: number
    readonly expired: boolean
    remainingMs(): number
    /** Resolves after `ms`, or at once when the deadline passes or the call is released. */
    pause(ms: number): Promise<void>
    /** `promise`'s outcome, or a rejection with the SDK's abort error when the deadline passes first. */
    race<T>(promise: Promise<T>): Promise<T>
    /** Stops the timer and any request still in flight: always called when the call is left, early exits included. */
    release(): void
}

function startDeadline(ms: number): Deadline {
    const controller = new AbortController()
    const { signal } = controller
    const startedAt = Date.now()
    let expired = false
    const timer = setTimeout(() => {
        expired = true
        controller.abort()
    }, ms)
    return {
        // The per-attempt timeout is the whole deadline, rounded up (the SDK wants an integer): the signal is what
        // ends a call that retries.
        limits: { signal, timeout: Math.ceil(ms) },
        ms,
        get expired() {
            return expired
        },
        remainingMs: () => ms - (Date.now() - startedAt),
        pause: (wait) =>
            new Promise<void>((resolve) => {
                if (signal.aborted) return resolve()
                const done = () => {
                    clearTimeout(waiting)
                    signal.removeEventListener('abort', done)
                    resolve()
                }
                const waiting = setTimeout(done, wait)
                signal.addEventListener('abort', done, { once: true })
            }),
        race: (promise) =>
            new Promise((resolve, reject) => {
                const onAbort = () => reject(new Anthropic.APIUserAbortError())
                if (signal.aborted) return onAbort()
                signal.addEventListener('abort', onAbort, { once: true })
                const settled = () => signal.removeEventListener('abort', onAbort)
                promise.then(
                    (value) => (settled(), resolve(value)),
                    (error: unknown) => (settled(), reject(error)),
                )
            }),
        release() {
            clearTimeout(timer)
            controller.abort()
        },
    }
}

/** How a provider error counts for the port, or `undefined` when it is none of the port's. */
function reasonOf(error: APIError): LlmUnavailableReason | undefined {
    // A mid-stream overload arrives as an SSE `error` event on a 200, with no status of its own, only a type.
    if (error.status === 429 || error.type === 'rate_limit_error') return 'rate-limited'
    if (error.status === 529 || error.type === 'overloaded_error') return 'overloaded'
    return undefined
}

/** What the provider asked us to wait, in ms, from `Retry-After-Ms` or `Retry-After` in seconds, or `undefined`. */
function providerWaitMs(error: APIError): number | undefined {
    const ms = Number(error.headers?.get('retry-after-ms'))
    if (Number.isFinite(ms) && ms > 0) return ms
    const seconds = Number(error.headers?.get('retry-after'))
    return Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : undefined
}

/**
 * How long to wait before repeating a call that failed with `error`, or `undefined` when it is not worth repeating: the
 * provider's own wait, else 0.5 s doubling to 8 s. Worth repeating is what the SDK's own policy repeats: 408, 409, 429
 * and 5xx, and a connection that dropped, plus a provider's rate limit or overload however it arrived. Never a call
 * that timed out or was aborted, which is the deadline, and never one the provider marked `x-should-retry: false`.
 */
function retryWaitMs(error: unknown, retry: number): number | undefined {
    if (error instanceof Anthropic.APIUserAbortError || error instanceof Anthropic.APIConnectionTimeoutError) {
        return undefined
    }
    const backoff = Math.min(500 * 2 ** retry, 8000)
    if (error instanceof Anthropic.APIConnectionError) return backoff
    if (!(error instanceof Anthropic.APIError)) return undefined
    if (error.headers?.get('x-should-retry') === 'false') return undefined
    const status = error.status
    const worth =
        status === 408 ||
        status === 409 ||
        status === 429 ||
        (status !== undefined && status >= 500) ||
        reasonOf(error) !== undefined
    return worth ? (providerWaitMs(error) ?? backoff) : undefined
}

/**
 * The port's error for what ended a call: a rate limit and an overloaded provider by their status or type, a deadline
 * (the adapter's own signal, however the SDK or the platform reports the abort, or the SDK's per-attempt timeout) as
 * `timed-out`. Anything else, the app's own `execute` throwing among it, is returned as it is: an abort that the
 * deadline did not cause is not a timeout.
 */
function portError(error: unknown, deadline: Deadline): unknown {
    if (error instanceof LlmUnavailableError) return error
    if (
        error instanceof Anthropic.APIConnectionTimeoutError ||
        (deadline.expired &&
            (error instanceof Anthropic.APIUserAbortError || (error instanceof Error && error.name === 'AbortError')))
    ) {
        return new LlmUnavailableError('timed-out', `llm call did not finish within ${deadline.ms} ms`, {
            cause: error,
        })
    }
    if (error instanceof Anthropic.APIError) {
        const reason = reasonOf(error)
        if (reason !== undefined) {
            const wait = providerWaitMs(error)
            return new LlmUnavailableError(reason, `llm ${reason} (${error.status ?? error.type})`, {
                cause: error,
                ...(wait === undefined ? {} : { retryAfterSeconds: Math.min(120, Math.ceil(wait / 1000)) }),
            })
        }
    }
    return error
}

function textOf(blocks: LlmContentBlock[]): string {
    return blocks
        .filter((b): b is Extract<LlmContentBlock, { type: 'text' }> => b.type === 'text')
        .map((b) => b.text)
        .join('')
}
