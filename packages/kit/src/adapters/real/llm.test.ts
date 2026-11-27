// @vitest-environment node
import Anthropic from '@anthropic-ai/sdk'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { LlmUnavailableError } from '../../ports/errors'
import type { LlmRequest, LlmToolLoopRequest } from '../../ports/llm'
import { createRealLlm } from './llm'

/**
 * The real LLM adapter's deadline and error mapping (`safeinsights/sssb#98`). No network: the global `fetch` the SDK
 * client picks up is replaced, so the SDK's own retry, `Retry-After`, abort and error-class code runs for real against
 * canned responses, and a test that forgets to stub it fails instead of calling the provider.
 */
const request: LlmRequest = { purpose: 'unit', messages: [{ role: 'user', content: 'hi' }] }

const messageBody = (content: object[], stopReason = 'end_turn') => ({
    id: 'msg_1',
    type: 'message',
    role: 'assistant',
    model: 'claude-sonnet-5',
    content,
    stop_reason: stopReason,
    stop_sequence: null,
    usage: { input_tokens: 1, output_tokens: 1 },
})
const textMessage = (text: string) => messageBody([{ type: 'text', text }])
const json = (status: number, body: object, headers: Record<string, string> = {}) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } })
const errorBody = (type: string) => ({ type: 'error', error: { type, message: `${type} from the provider` } })

function stubFetch(handler: (init: RequestInit, call: number) => Response | Promise<Response>) {
    const fetchMock = vi.fn((_url: unknown, init?: RequestInit) => {
        // The deadline's signal reaches the HTTP call, the way an abort reaches a real `fetch`.
        return new Promise<Response>((resolve, reject) => {
            const signal = init?.signal
            const onAbort = () => reject(new DOMException('This operation was aborted', 'AbortError'))
            if (signal?.aborted) return onAbort()
            signal?.addEventListener('abort', onAbort, { once: true })
            Promise.resolve(handler(init ?? {}, fetchMock.mock.calls.length)).then(resolve, reject)
        })
    })
    vi.stubGlobal('fetch', fetchMock)
    return fetchMock
}
/** A response that never comes, until the signal aborts the call. */
const hang = () => new Promise<Response>(() => {})

beforeEach(() => {
    vi.stubGlobal('fetch', () => Promise.reject(new Error('the test forgot to stub fetch')))
})
afterEach(() => {
    vi.unstubAllGlobals()
    vi.useRealTimers()
})

async function rejection(promise: Promise<unknown>): Promise<unknown> {
    try {
        await promise
    } catch (error) {
        return error
    }
    throw new Error('expected the call to reject')
}

describe('createRealLlm: what the provider says', () => {
    it('maps a 429 to rate-limited, with the provider error as its cause and its Retry-After as ours', async () => {
        stubFetch(() => json(429, errorBody('rate_limit_error'), { 'retry-after': '7' }))
        const error = await rejection(createRealLlm('key', { maxRetries: 0 }).complete(request))
        expect(error).toBeInstanceOf(LlmUnavailableError)
        expect(error).toMatchObject({ reason: 'rate-limited', retryAfterSeconds: 7 })
        expect((error as LlmUnavailableError).cause).toBeInstanceOf(Anthropic.RateLimitError)
    })

    it('maps a 529 to overloaded, and says to ask again in 10 s when the provider named no time', async () => {
        stubFetch(() => json(529, errorBody('overloaded_error')))
        const error = await rejection(createRealLlm('key', { maxRetries: 0 }).complete(request))
        expect(error).toMatchObject({ name: 'LlmUnavailableError', reason: 'overloaded', retryAfterSeconds: 10 })
    })

    it('clamps a Retry-After to two minutes, and ignores one that is neither seconds nor a date', async () => {
        stubFetch(() => json(429, errorBody('rate_limit_error'), { 'retry-after': '86400' }))
        expect(await rejection(createRealLlm('key', { maxRetries: 0 }).complete(request))).toMatchObject({
            retryAfterSeconds: 120,
        })
        stubFetch(() => json(429, errorBody('rate_limit_error'), { 'retry-after': 'soon' }))
        expect(await rejection(createRealLlm('key', { maxRetries: 0 }).complete(request))).toMatchObject({
            retryAfterSeconds: 10,
        })
    })

    it('leaves every other provider error as the SDK threw it', async () => {
        stubFetch(() => json(400, errorBody('invalid_request_error')))
        expect(await rejection(createRealLlm('key', { maxRetries: 0 }).complete(request))).toBeInstanceOf(
            Anthropic.BadRequestError,
        )
        stubFetch(() => json(500, errorBody('api_error')))
        expect(await rejection(createRealLlm('key', { maxRetries: 0 }).complete(request))).toBeInstanceOf(
            Anthropic.InternalServerError,
        )
    })

    it('maps the same way from stream and runToolLoop', async () => {
        stubFetch(() => json(529, errorBody('overloaded_error')))
        const llm = createRealLlm('key', { maxRetries: 0 })
        const streamed = rejection(
            (async () => {
                for await (const chunk of llm.stream(request)) void chunk
            })(),
        )
        expect(await streamed).toMatchObject({ reason: 'overloaded' })
        const loop: LlmToolLoopRequest = { ...request, tools: [], execute: async () => '' }
        expect(await rejection(llm.runToolLoop(loop))).toMatchObject({ reason: 'overloaded' })
    })

    it('retries once by default, inside the deadline, so a brief 529 never reaches the caller', async () => {
        const fetchMock = stubFetch((_init, call) =>
            call === 1
                ? json(529, errorBody('overloaded_error'), { 'retry-after-ms': '1' })
                : json(200, textMessage('ok')),
        )
        expect(await createRealLlm('key').complete(request)).toEqual({ text: 'ok' })
        expect(fetchMock).toHaveBeenCalledTimes(2)
    })

    it('gives up after that one retry', async () => {
        const fetchMock = stubFetch(() => json(529, errorBody('overloaded_error'), { 'retry-after-ms': '1' }))
        expect(await rejection(createRealLlm('key').complete(request))).toMatchObject({ reason: 'overloaded' })
        expect(fetchMock).toHaveBeenCalledTimes(2)
    })
})

describe('createRealLlm: the deadline', () => {
    it('ends a call that does not answer in `timeoutMs` as timed-out, with the deadline in its message', async () => {
        const fetchMock = stubFetch(hang)
        const started = Date.now()
        const error = await rejection(createRealLlm('key').complete({ ...request, timeoutMs: 40 }))
        expect(error).toBeInstanceOf(LlmUnavailableError)
        expect(error).toMatchObject({ reason: 'timed-out', message: 'llm call did not finish within 40 ms' })
        expect(Date.now() - started).toBeLessThan(2000)
        // The request was aborted, not left running.
        expect(fetchMock.mock.calls[0]?.[1]?.signal?.aborted).toBe(true)
    })

    it('answers at once when the provider`s Retry-After does not fit in the deadline, with the provider`s own figure', async () => {
        const fetchMock = stubFetch(() => json(429, errorBody('rate_limit_error'), { 'retry-after': '60' }))
        const started = Date.now()
        const error = await rejection(createRealLlm('key').complete({ ...request, timeoutMs: 300 }))
        expect(error).toMatchObject({ reason: 'rate-limited', retryAfterSeconds: 60 })
        expect(Date.now() - started).toBeLessThan(250)
        expect(fetchMock).toHaveBeenCalledTimes(1)
    })

    it('counts the retry and its wait against the deadline', async () => {
        const fetchMock = stubFetch((_init, call) =>
            call === 1 ? json(529, errorBody('overloaded_error'), { 'retry-after-ms': '20' }) : hang(),
        )
        const started = Date.now()
        const error = await rejection(createRealLlm('key').complete({ ...request, timeoutMs: 100 }))
        expect(error).toMatchObject({ reason: 'timed-out' })
        expect(Date.now() - started).toBeLessThan(1500)
        expect(fetchMock).toHaveBeenCalledTimes(2)
    })

    it('repeats a 500 and a dropped connection once, and nothing else the provider refuses', async () => {
        const refused = stubFetch((_init, call) =>
            call === 1 ? json(500, errorBody('api_error'), { 'retry-after-ms': '1' }) : json(200, textMessage('ok')),
        )
        expect(await createRealLlm('key').complete(request)).toEqual({ text: 'ok' })
        expect(refused).toHaveBeenCalledTimes(2)
        const dropped = stubFetch((_init, call) =>
            call === 1 ? Promise.reject(new TypeError('fetch failed')) : json(200, textMessage('ok')),
        )
        expect(await createRealLlm('key').complete(request)).toEqual({ text: 'ok' })
        expect(dropped).toHaveBeenCalledTimes(2)
        const bad = stubFetch(() => json(400, errorBody('invalid_request_error')))
        await rejection(createRealLlm('key').complete(request))
        expect(bad).toHaveBeenCalledTimes(1)
    })

    it('ends a deadline that passes while the response body is still being read as timed-out, not a bare AbortError', async () => {
        stubFetch((init) => {
            const body = new ReadableStream<Uint8Array>({
                start(controller) {
                    init.signal?.addEventListener('abort', () =>
                        controller.error(new DOMException('aborted', 'AbortError')),
                    )
                },
            })
            return new Response(body, { status: 200, headers: { 'content-type': 'application/json' } })
        })
        expect(await rejection(createRealLlm('key').complete({ ...request, timeoutMs: 50 }))).toMatchObject({
            name: 'LlmUnavailableError',
            reason: 'timed-out',
        })
    })

    it('takes a fractional timeoutMs, which the SDK`s own timeout option would refuse', async () => {
        stubFetch(() => json(200, textMessage('ok')))
        expect(await createRealLlm('key').complete({ ...request, timeoutMs: 1500.5 })).toEqual({ text: 'ok' })
    })

    it('takes the default from the options, and the request overrides it', async () => {
        stubFetch(hang)
        const llm = createRealLlm('key', { timeoutMs: 30 })
        expect(await rejection(llm.complete(request))).toMatchObject({
            message: 'llm call did not finish within 30 ms',
        })
        expect(await rejection(llm.complete({ ...request, timeoutMs: 50 }))).toMatchObject({
            message: 'llm call did not finish within 50 ms',
        })
    })

    it('is 25 s when nothing says otherwise, 5 s under the server function', async () => {
        vi.useFakeTimers()
        stubFetch(hang)
        const settled = rejection(createRealLlm('key').complete(request))
        await vi.advanceTimersByTimeAsync(24_999)
        let done = false
        void settled.then(() => (done = true))
        await vi.advanceTimersByTimeAsync(0)
        expect(done).toBe(false)
        await vi.advanceTimersByTimeAsync(1)
        expect(await settled).toMatchObject({ reason: 'timed-out', message: 'llm call did not finish within 25000 ms' })
    })

    it('refuses a timeoutMs that is not a positive finite number, before any call', async () => {
        const fetchMock = stubFetch(() => json(200, textMessage('x')))
        const llm = createRealLlm('key')
        for (const bad of [0, -1, Number.NaN, Infinity, '5' as unknown as number]) {
            expect(await rejection(llm.complete({ ...request, timeoutMs: bad }))).toBeInstanceOf(RangeError)
        }
        expect(() => createRealLlm('key', { timeoutMs: 0 })).toThrow(RangeError)
        expect(fetchMock).not.toHaveBeenCalled()
    })

    it('leaves no timer behind when a call finishes', async () => {
        vi.useFakeTimers()
        stubFetch(() => json(200, textMessage('done')))
        expect(await createRealLlm('key').complete(request)).toEqual({ text: 'done' })
        expect(vi.getTimerCount()).toBe(0)
    })

    /** A stream that sends one text chunk and then goes quiet until the signal aborts it. */
    const quietAfterOneChunk = (init: RequestInit) => {
        const sse = (event: string, data: object) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
        const encoder = new TextEncoder()
        const body = new ReadableStream<Uint8Array>({
            start(controller) {
                const start = { ...messageBody([]), content: [], stop_reason: null }
                const block = { type: 'text', text: '' }
                const delta = { type: 'text_delta', text: 'partial ' }
                controller.enqueue(
                    encoder.encode(
                        sse('message_start', { type: 'message_start', message: start }) +
                            sse('content_block_start', {
                                type: 'content_block_start',
                                index: 0,
                                content_block: block,
                            }) +
                            sse('content_block_delta', { type: 'content_block_delta', index: 0, delta }),
                    ),
                )
                init.signal?.addEventListener('abort', () =>
                    controller.error(new DOMException('aborted', 'AbortError')),
                )
            },
        })
        return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } })
    }

    it('bounds a stream: chunks that stop coming end it as timed-out, and the chunks that came are delivered', async () => {
        stubFetch(quietAfterOneChunk)
        const received: string[] = []
        const error = await rejection(
            (async () => {
                for await (const chunk of createRealLlm('key').stream({ ...request, timeoutMs: 80 }))
                    received.push(chunk)
            })(),
        )
        expect(received).toEqual(['partial '])
        expect(error).toMatchObject({ name: 'LlmUnavailableError', reason: 'timed-out' })
    })

    it('does not let a deadline that passes while the consumer is busy read as a complete stream', async () => {
        stubFetch(quietAfterOneChunk)
        const received: string[] = []
        const error = await rejection(
            (async () => {
                for await (const chunk of createRealLlm('key').stream({ ...request, timeoutMs: 50 })) {
                    received.push(chunk)
                    await new Promise((resolve) => setTimeout(resolve, 150))
                }
            })(),
        )
        expect(received).toEqual(['partial '])
        expect(error).toMatchObject({ name: 'LlmUnavailableError', reason: 'timed-out' })
    })

    it('maps an overload the provider reports in the middle of a stream, where no status comes with it', async () => {
        const sse = `event: error\ndata: ${JSON.stringify(errorBody('overloaded_error'))}\n\n`
        stubFetch(() => new Response(sse, { status: 200, headers: { 'content-type': 'text/event-stream' } }))
        const error = await rejection(
            (async () => {
                for await (const chunk of createRealLlm('key', { maxRetries: 0 }).stream(request)) void chunk
            })(),
        )
        expect(error).toMatchObject({ name: 'LlmUnavailableError', reason: 'overloaded' })
    })

    it('starts a stream again after a refusal before its first text, never after text was delivered', async () => {
        const ok = () =>
            new Response(
                `event: message_start\ndata: ${JSON.stringify({ type: 'message_start', message: { ...messageBody([]), content: [], stop_reason: null } })}\n\n` +
                    `event: content_block_start\ndata: ${JSON.stringify({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } })}\n\n` +
                    `event: content_block_delta\ndata: ${JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'hello' } })}\n\n` +
                    `event: message_stop\ndata: ${JSON.stringify({ type: 'message_stop' })}\n\n`,
                { status: 200, headers: { 'content-type': 'text/event-stream' } },
            )
        const fetchMock = stubFetch((_init, call) =>
            call === 1 ? json(529, errorBody('overloaded_error'), { 'retry-after-ms': '1' }) : ok(),
        )
        const received: string[] = []
        for await (const chunk of createRealLlm('key').stream(request)) received.push(chunk)
        expect(received).toEqual(['hello'])
        expect(fetchMock).toHaveBeenCalledTimes(2)
    })

    it('stops the request when a stream consumer leaves early', async () => {
        const fetchMock = stubFetch(quietAfterOneChunk)
        for await (const chunk of createRealLlm('key').stream({ ...request, timeoutMs: 5000 })) {
            expect(chunk).toBe('partial ')
            break
        }
        expect(fetchMock.mock.calls[0]?.[1]?.signal?.aborted).toBe(true)
    })
})

describe('createRealLlm: runToolLoop', () => {
    const toolUse = messageBody([{ type: 'tool_use', id: 'tu_1', name: 'lookup', input: { q: 1 } }], 'tool_use')
    const tools: LlmToolLoopRequest['tools'] = [{ name: 'lookup', description: 'd', inputSchema: { type: 'object' } }]

    it('runs the loop to its final text, every turn under the deadline', async () => {
        const fetchMock = stubFetch((_init, call) => json(200, call === 1 ? toolUse : textMessage('final')))
        const result = await createRealLlm('key').runToolLoop({
            ...request,
            tools,
            execute: async () => 'found',
        })
        expect(result.text).toBe('final')
        expect(result.turns).toHaveLength(3)
        expect(fetchMock.mock.calls.map(([, init]) => init?.signal instanceof AbortSignal)).toEqual([true, true])
    })

    it('stops waiting for a slow `execute` when the deadline passes: the call ends on time as timed-out', async () => {
        const fetchMock = stubFetch(() => json(200, toolUse))
        const started = Date.now()
        const error = await rejection(
            createRealLlm('key').runToolLoop({
                ...request,
                tools,
                timeoutMs: 40,
                execute: () => new Promise((resolve) => setTimeout(() => resolve('late'), 600)),
            }),
        )
        expect(error).toMatchObject({ name: 'LlmUnavailableError', reason: 'timed-out' })
        expect(Date.now() - started).toBeLessThan(400)
        expect(fetchMock).toHaveBeenCalledTimes(1)
    })

    it('does not turn the app`s own error into an LLM error', async () => {
        stubFetch(() => json(200, toolUse))
        const boom = new Error('the tool broke')
        const error = await rejection(
            createRealLlm('key').runToolLoop({
                ...request,
                tools,
                execute: async () => {
                    throw boom
                },
            }),
        )
        expect(error).toBe(boom)
    })
})

describe('createRealLlm: what ends a stream, and which refusals are repeated', () => {
    const sse = (event: string, data: object) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
    const opening = (text: string) =>
        sse('message_start', {
            type: 'message_start',
            message: { ...messageBody([]), content: [], stop_reason: null },
        }) +
        sse('content_block_start', {
            type: 'content_block_start',
            index: 0,
            content_block: { type: 'text', text: '' },
        }) +
        sse('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } })
    const overload = sse('error', errorBody('overloaded_error'))
    /** A stream that sends `first`, then `rest` after `afterMs`, and ends. */
    const streamOf = (first: string, rest: string, afterMs: number) => () => {
        const encoder = new TextEncoder()
        const body = new ReadableStream<Uint8Array>({
            start(controller) {
                controller.enqueue(encoder.encode(first))
                setTimeout(() => {
                    controller.enqueue(encoder.encode(rest))
                    controller.close()
                }, afterMs)
            },
        })
        return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } })
    }
    const consume = async (llm: ReturnType<typeof createRealLlm>, busyMs: number, timeoutMs?: number) => {
        const received: string[] = []
        const error = await rejection(
            (async () => {
                for await (const chunk of llm.stream({ ...request, ...(timeoutMs ? { timeoutMs } : {}) })) {
                    received.push(chunk)
                    await new Promise((resolve) => setTimeout(resolve, busyMs))
                }
            })(),
        )
        return { received, error }
    }

    it('does not let an overload that arrives while the consumer is busy read as a complete stream', async () => {
        stubFetch(streamOf(opening('partial '), overload, 20))
        const { received, error } = await consume(createRealLlm('key'), 100)
        expect(received).toEqual(['partial '])
        expect(error).toMatchObject({ name: 'LlmUnavailableError', reason: 'overloaded' })
    })

    it('never starts a stream again once it has delivered text, so no text is sent twice', async () => {
        const fetchMock = stubFetch(streamOf(opening('partial '), overload, 20))
        const { received, error } = await consume(createRealLlm('key'), 0)
        expect(received).toEqual(['partial '])
        expect(error).toMatchObject({ reason: 'overloaded' })
        expect(fetchMock).toHaveBeenCalledTimes(1)
    })

    it('answers at once, with the provider`s figure, when its Retry-After only just fits the deadline', async () => {
        const fetchMock = stubFetch(() => json(429, errorBody('rate_limit_error'), { 'retry-after-ms': '280' }))
        const started = Date.now()
        const error = await rejection(createRealLlm('key').complete({ ...request, timeoutMs: 300 }))
        expect(error).toMatchObject({ reason: 'rate-limited', retryAfterSeconds: 1 })
        expect(Date.now() - started).toBeLessThan(150)
        expect(fetchMock).toHaveBeenCalledTimes(1)
    })

    it('reads a Retry-After that is an HTTP date', async () => {
        stubFetch(() =>
            json(429, errorBody('rate_limit_error'), { 'retry-after': new Date(Date.now() + 90_000).toUTCString() }),
        )
        const error = (await rejection(
            createRealLlm('key', { maxRetries: 0 }).complete(request),
        )) as LlmUnavailableError
        expect(error.retryAfterSeconds).toBeGreaterThanOrEqual(88)
        expect(error.retryAfterSeconds).toBeLessThanOrEqual(91)
    })

    it('repeats a 408 and a connect timeout, but not a 500 the provider marked x-should-retry: false', async () => {
        const timedOut = stubFetch((_init, call) =>
            call === 1 ? json(408, errorBody('api_error'), { 'retry-after-ms': '1' }) : json(200, textMessage('ok')),
        )
        expect(await createRealLlm('key').complete(request)).toEqual({ text: 'ok' })
        expect(timedOut).toHaveBeenCalledTimes(2)
        const connect = stubFetch((_init, call) =>
            call === 1 ? Promise.reject(new Error('connect ETIMEDOUT 203.0.113.7:443')) : json(200, textMessage('ok')),
        )
        expect(await createRealLlm('key').complete(request)).toEqual({ text: 'ok' })
        expect(connect).toHaveBeenCalledTimes(2)
        const final = stubFetch(() => json(500, errorBody('api_error'), { 'x-should-retry': 'false' }))
        await rejection(createRealLlm('key').complete(request))
        expect(final).toHaveBeenCalledTimes(1)
    })

    it('refuses a maxRetries that is not a non-negative integer', () => {
        for (const bad of [-1, 1.5, Number.NaN])
            expect(() => createRealLlm('key', { maxRetries: bad })).toThrow(RangeError)
        expect(() => createRealLlm('key', { maxRetries: 0 })).not.toThrow()
    })
})

describe('createRealLlm: a dropped connection (safeinsights/sssb#230)', () => {
    /** What undici gives a body that ends early, and the SDK 1.8.0 wraps: pinned against the SDK's own wrapping. */
    const terminated = () =>
        Object.assign(new TypeError('terminated'), {
            cause: Object.assign(new Error('other side closed'), { code: 'UND_ERR_SOCKET' }),
        })
    const sse = (event: string, data: object) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
    const opening = (text?: string) =>
        sse('message_start', {
            type: 'message_start',
            message: { ...messageBody([]), content: [], stop_reason: null },
        }) +
        (text === undefined
            ? ''
            : sse('content_block_start', {
                  type: 'content_block_start',
                  index: 0,
                  content_block: { type: 'text', text: '' },
              }) +
              sse('content_block_delta', {
                  type: 'content_block_delta',
                  index: 0,
                  delta: { type: 'text_delta', text },
              }))
    /** A streamed response that sends `first`, then dies the way a dropped socket does. */
    const dyingStream = (first: string) => () =>
        new Response(
            new ReadableStream<Uint8Array>({
                start(controller) {
                    if (first) controller.enqueue(new TextEncoder().encode(first))
                    setTimeout(() => controller.error(terminated()), 5)
                },
            }),
            { status: 200, headers: { 'content-type': 'text/event-stream' } },
        )
    const dyingStreamWith = (error: Error) =>
        new Response(
            new ReadableStream<Uint8Array>({
                start(controller) {
                    controller.enqueue(new TextEncoder().encode(opening()))
                    setTimeout(() => controller.error(error), 5)
                },
            }),
            { status: 200, headers: { 'content-type': 'text/event-stream' } },
        )
    const consume = async (llm: ReturnType<typeof createRealLlm>) => {
        const chunks: string[] = []
        const error = await rejection(
            (async () => {
                for await (const chunk of llm.stream(request)) chunks.push(chunk)
            })(),
        )
        return { text: chunks.join(''), error }
    }

    it('the SDK reports a streamed body that dies as a plain AnthropicError, which is why the adapter looks at its cause', async () => {
        stubFetch(dyingStream(opening()))
        const { error } = await consume(createRealLlm('key', { maxRetries: 0 }))
        // The shape the adapter relies on: not an APIError, `terminated` on a TypeError cause with a transport code.
        expect(error).toBeInstanceOf(LlmUnavailableError)
        const raw = (error as LlmUnavailableError).cause as Error
        expect(raw).toBeInstanceOf(Anthropic.AnthropicError)
        expect(raw).not.toBeInstanceOf(Anthropic.APIError)
        expect(raw.message).toBe('terminated')
        expect((raw.cause as Error).message).toBe('terminated')
        expect(((raw.cause as Error).cause as { code?: string }).code).toBe('UND_ERR_SOCKET')
    })

    it('maps a stream that dies before any text to connection-lost once its retry has died too', async () => {
        const fetchMock = stubFetch(dyingStream(opening()))
        const { text, error } = await consume(createRealLlm('key'))
        expect(text).toBe('')
        expect(error).toMatchObject({ name: 'LlmUnavailableError', reason: 'connection-lost', retryAfterSeconds: 10 })
        expect(fetchMock).toHaveBeenCalledTimes(2)
    })

    it('starts a stream that died before any text again, and delivers the answer the second time', async () => {
        const answer = opening('hello') + sse('message_stop', { type: 'message_stop' })
        const fetchMock = stubFetch((_init, call) =>
            call === 1
                ? dyingStream(opening())()
                : new Response(answer, { status: 200, headers: { 'content-type': 'text/event-stream' } }),
        )
        const chunks: string[] = []
        for await (const chunk of createRealLlm('key').stream(request)) chunks.push(chunk)
        expect(chunks.join('')).toBe('hello')
        expect(fetchMock).toHaveBeenCalledTimes(2)
    })

    it('never starts a stream again once it has delivered text, and says connection-lost', async () => {
        const fetchMock = stubFetch(dyingStream(opening('partial ')))
        const { text, error } = await consume(createRealLlm('key'))
        expect(text).toBe('partial ')
        expect(error).toMatchObject({ name: 'LlmUnavailableError', reason: 'connection-lost' })
        expect(fetchMock).toHaveBeenCalledTimes(1)
    })

    it("maps a non-streaming body that dies (undici's bare TypeError) and a fetch that rejects", async () => {
        stubFetch(
            () =>
                new Response(new ReadableStream({ start: (c) => setTimeout(() => c.error(terminated()), 5) }), {
                    status: 200,
                }),
        )
        expect(await rejection(createRealLlm('key', { maxRetries: 0 }).complete(request))).toMatchObject({
            name: 'LlmUnavailableError',
            reason: 'connection-lost',
        })
        stubFetch(() => Promise.reject(terminated()))
        const error = await rejection(createRealLlm('key', { maxRetries: 0 }).complete(request))
        expect(error).toMatchObject({ reason: 'connection-lost' })
        expect(((error as LlmUnavailableError).cause as Error).constructor.name).toBe('APIConnectionError')
    })

    it('repeats a non-streaming call whose body died, once', async () => {
        const fetchMock = stubFetch((_init, call) =>
            call === 1
                ? new Response(new ReadableStream({ start: (c) => setTimeout(() => c.error(terminated()), 5) }), {
                      status: 200,
                  })
                : json(200, textMessage('ok')),
        )
        expect(await createRealLlm('key').complete(request)).toEqual({ text: 'ok' })
        expect(fetchMock).toHaveBeenCalledTimes(2)
    })

    it('leaves an error that carries no transport cause as it is: not every failed body is a dropped connection', async () => {
        const failing = () =>
            new Response(
                new ReadableStream({
                    start: (c) => setTimeout(() => c.error(new Error('the body was not what it said')), 5),
                }),
                {
                    status: 200,
                },
            )
        stubFetch(failing)
        const error = await rejection(createRealLlm('key', { maxRetries: 0 }).complete(request))
        expect(error).not.toBeInstanceOf(LlmUnavailableError)
        stubFetch(() => dyingStreamWith(new Error('the stream was not what it said')))
        const streamed = (await consume(createRealLlm('key', { maxRetries: 0 }))).error
        expect(streamed).not.toBeInstanceOf(LlmUnavailableError)
    })

    it('maps each transport signal on its own: terminated alone, and each code alone', async () => {
        const bodyDying = (error: Error) => () =>
            new Response(new ReadableStream({ start: (c) => setTimeout(() => c.error(error), 5) }), { status: 200 })
        const signals: [string, Error][] = [
            ['terminated, with no cause', new TypeError('terminated')],
            ['ECONNRESET', Object.assign(new Error('reset'), { code: 'ECONNRESET' })],
            ['EPIPE', Object.assign(new Error('broken pipe'), { code: 'EPIPE' })],
            ['an undici code', Object.assign(new Error('body timeout'), { code: 'UND_ERR_BODY_TIMEOUT' })],
            [
                'a code three causes down',
                Object.assign(new Error('a'), {
                    cause: new Error('b', { cause: Object.assign(new Error('c'), { code: 'ECONNREFUSED' }) }),
                }),
            ],
        ]
        for (const [label, error] of signals) {
            stubFetch(bodyDying(error))
            expect(await rejection(createRealLlm('key', { maxRetries: 0 }).complete(request)), label).toMatchObject({
                name: 'LlmUnavailableError',
                reason: 'connection-lost',
            })
        }
    })

    it("never takes an error the app's own tool threw for a dropped connection, whatever it carries", async () => {
        const toolUse = messageBody([{ type: 'tool_use', id: 'tu_1', name: 'lookup', input: {} }], 'tool_use')
        const tools: LlmToolLoopRequest['tools'] = [
            { name: 'lookup', description: 'd', inputSchema: { type: 'object' } },
        ]
        const thrown: Error[] = [
            Object.assign(new Error('pg went away'), { code: 'ECONNRESET' }),
            new TypeError('terminated'),
            Object.assign(new TypeError('fetch failed'), {
                cause: Object.assign(new Error('x'), { code: 'UND_ERR_SOCKET' }),
            }),
        ]
        for (const toolError of thrown) {
            const fetchMock = stubFetch(() => json(200, toolUse))
            const error = await rejection(
                createRealLlm('key').runToolLoop({
                    ...request,
                    tools,
                    execute: async () => {
                        throw toolError
                    },
                }),
            )
            expect(error).toBe(toolError)
            expect(fetchMock).toHaveBeenCalledTimes(1)
        }
        // And one that throws before it returns a promise at all.
        stubFetch(() => json(200, toolUse))
        const sync = Object.assign(new Error('sync reset'), { code: 'ECONNRESET' })
        const error = await rejection(
            createRealLlm('key').runToolLoop({
                ...request,
                tools,
                execute: () => {
                    throw sync
                },
            }),
        )
        expect(error).toBe(sync)
    })
})
