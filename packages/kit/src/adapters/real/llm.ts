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
     * How often the SDK repeats a call the provider refused (429, 5xx) or that timed out, within the call's deadline.
     * Default 1: the SDK's own 2 would spend a third of the deadline on a provider that is not answering.
     */
    maxRetries?: number
}

/** The two options every SDK call takes from the deadline: the signal that bounds its retries, the per-attempt timeout. */
interface CallLimits {
    signal: AbortSignal
    timeout: number
}

/**
 * Every call runs under one deadline (`timeoutMs` on the request, else `options.timeoutMs`, else 25 s): the SDK's
 * retries, a stream's last chunk and a tool loop's every turn and `execute` all count against it, enforced with an
 * abort signal on each SDK call, because the SDK's own `timeout` is per attempt and its default is ten minutes. What
 * the provider says (429, 529) or a call that outruns the deadline becomes `LlmUnavailableError`
 * (`@sssb/kit/ports/errors`); any other error, the app's `execute` throwing included, passes through as it is.
 * `safeinsights/sssb#98`, `docs/decision-log.md`, "The LLM adapter has a deadline".
 */
export function createRealLlm(apiKey: string, options: RealLlmOptions = {}): LlmPort {
    const defaultTimeoutMs = llmTimeoutMs(options.timeoutMs)
    const client = new Anthropic({ apiKey, maxRetries: options.maxRetries ?? 1 })

    const toParams = (request: LlmRequest) => ({
        model: request.model ?? LLM_MODELS.default,
        ...(request.system === undefined ? {} : { system: request.system }),
        messages: request.messages,
        max_tokens: request.maxTokens ?? 1024,
    })

    /** Runs `body` under the request's deadline, and turns what ends it into the port's error. */
    async function underDeadline<T>(
        requested: number | undefined,
        body: (limits: CallLimits) => Promise<T>,
    ): Promise<T> {
        const deadline = startDeadline(llmTimeoutMs(requested, defaultTimeoutMs))
        try {
            return await body(deadline.limits)
        } catch (error) {
            throw portError(error, deadline)
        } finally {
            deadline.release()
        }
    }

    return {
        complete(request) {
            return underDeadline(request.timeoutMs, async (limits) => {
                const message = await client.messages.create(toParams(request), limits)
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
                const stream = client.messages.stream(toParams(request), deadline.limits)
                for await (const chunk of stream) {
                    if (chunk.type === 'content_block_delta' && chunk.delta.type === 'text_delta') {
                        yield chunk.delta.text
                    }
                }
            } catch (error) {
                throw portError(error, deadline)
            } finally {
                deadline.release()
            }
        },

        runToolLoop(request) {
            return underDeadline(request.timeoutMs, (limits) => toolLoop(client, request, limits))
        },
    }
}

async function toolLoop(
    client: Anthropic,
    request: LlmToolLoopRequest,
    limits: CallLimits,
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
        const message = await client.messages.create(
            {
                model: request.model ?? LLM_MODELS.default,
                ...(request.system === undefined ? {} : { system: request.system }),
                messages,
                tools,
                max_tokens: request.maxTokens ?? 1024,
            },
            limits,
        )

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
            const result = known
                ? await request.execute({ name: block.name, input: block.input })
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
    /** Stops the timer and any request still in flight: always called when the call is left, early exits included. */
    release(): void
}

function startDeadline(ms: number): Deadline {
    const controller = new AbortController()
    let expired = false
    const timer = setTimeout(() => {
        expired = true
        controller.abort()
    }, ms)
    return {
        // The per-attempt timeout is the whole deadline: the signal is what ends a call that retries.
        limits: { signal: controller.signal, timeout: ms },
        ms,
        get expired() {
            return expired
        },
        release() {
            clearTimeout(timer)
            controller.abort()
        },
    }
}

/** What the provider's `Retry-After` asks for, in whole seconds within 1 to 120, or `undefined` (a date or nonsense). */
function retryAfterSeconds(error: APIError): number | undefined {
    const seconds = Number(error.headers?.get('retry-after'))
    return Number.isFinite(seconds) && seconds > 0 ? Math.min(120, Math.ceil(seconds)) : undefined
}

/**
 * The port's error for what ended a call: a rate limit (429) and an overloaded provider (529) by their status, a
 * deadline (the adapter's own signal, or the SDK's per-attempt timeout) as `timed-out`. Anything else, the app's own
 * `execute` throwing among it, is returned as it is: an abort that the deadline did not cause is not a timeout.
 */
function portError(error: unknown, deadline: Deadline): unknown {
    if (error instanceof LlmUnavailableError) return error
    if (
        error instanceof Anthropic.APIConnectionTimeoutError ||
        (error instanceof Anthropic.APIUserAbortError && deadline.expired)
    ) {
        return new LlmUnavailableError('timed-out', `llm call did not finish within ${deadline.ms} ms`, {
            cause: error,
        })
    }
    if (error instanceof Anthropic.APIError) {
        const reason: LlmUnavailableReason | undefined =
            error.status === 429 ? 'rate-limited' : error.status === 529 ? 'overloaded' : undefined
        if (reason !== undefined) {
            const after = retryAfterSeconds(error)
            return new LlmUnavailableError(reason, `llm ${reason} (HTTP ${error.status})`, {
                cause: error,
                ...(after === undefined ? {} : { retryAfterSeconds: after }),
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
