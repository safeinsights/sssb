import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { expect, vi } from 'vitest'
import { createFakeLlm } from '../../adapters/fake/llm'
import { replayAssistant } from '../../demo-static/assistant-replay'
import { LlmUnavailableError } from '../../ports/errors'
import type { LlmPort } from '../../ports/llm'
import { makeTestTmpDir, removeTestTmpDir } from '../tmp-dir'
import type { CheckImpl } from './types'

/**
 * `llm-stream-failure` (`safeinsights/sssb#145`): a stream that fails after some of its answer was delivered is
 * VISIBLE to its consumer, as an `LlmUnavailableError` thrown from the iteration, never an end that reads as a complete
 * answer, and the three places that replay a model call agree about it: the real adapter, the fake adapter's fixtures
 * (`failure` on an entry) and the static demo's replay (`replayAssistant`). One scenario, the same in each: an answer
 * that starts, `PARTIAL`, and then the provider reports it is overloaded.
 *
 * The check holds the framework's adapters, not the app's code, so it passes in every app unless the kit regressed; what
 * it buys an app is that the failure form it tests its own stream consumers with (a `failure` entry in its fixtures)
 * is the failure the deployed adapter produces. The real adapter runs against a stubbed `fetch`, so the SDK's own
 * stream code runs and nothing leaves the machine; its consumer is BUSY between chunks (the SDK's iterator drops a
 * failure that arrives while nobody is waiting, which is the bug this check is the regression test for).
 */
const PARTIAL = 'The ticket was escalated and '

/** What a consumer of `stream` saw: the text it was given, and what ended the iteration. */
async function consume(llm: LlmPort, busyMs: number) {
    const chunks: string[] = []
    let ended: unknown = 'ended without an error'
    try {
        for await (const chunk of llm.stream({ purpose: 'conformance-stream', messages: [] })) {
            chunks.push(chunk)
            if (busyMs > 0) await new Promise((resolve) => setTimeout(resolve, busyMs))
        }
    } catch (error) {
        ended = error
    }
    return { text: chunks.join(''), ended }
}

/** Runs `body` with a fixtures directory holding one failing entry, and removes it. */
async function withFailingFixture<T>(body: (fixturesDir: string) => Promise<T>): Promise<T> {
    const dir = makeTestTmpDir('llm-stream-failure-')
    try {
        mkdirSync(path.join(dir, 'llm'), { recursive: true })
        const entry = { name: 'default', request: null, response: PARTIAL, failure: { reason: 'overloaded' } }
        writeFileSync(
            path.join(dir, 'llm', 'conformance-stream.json'),
            JSON.stringify({ purpose: 'conformance-stream', entries: [entry] }),
        )
        return await body(dir)
    } finally {
        removeTestTmpDir(dir)
    }
}

const sse = (event: string, data: object) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`

export const llmStreamFailure: CheckImpl = {
    tests: {
        "the fake adapter's stream delivers a failing entry's partial answer and then throws; complete throws": () =>
            withFailingFixture(async (fixturesDir) => {
                const fake = createFakeLlm({ fixturesDir, catchRequests: false })
                const { text, ended } = await consume(fake, 0)
                expect(text).toBe(PARTIAL)
                expect(ended).toBeInstanceOf(LlmUnavailableError)
                expect(ended).toMatchObject({ reason: 'overloaded' })
                await expect(fake.complete({ purpose: 'conformance-stream', messages: [] })).rejects.toMatchObject({
                    name: 'LlmUnavailableError',
                    reason: 'overloaded',
                })
            }),

        "the static demo's replay runs a failing entry's tool calls and then throws in place of the answer":
            async () => {
                const fixture = {
                    entries: [
                        {
                            request: { messages: [{ role: 'user', content: 'question' }] },
                            conversation: [
                                { role: 'assistant', content: [{ type: 'tool_use', name: 'lookup', input: { q: 1 } }] },
                                { role: 'assistant', content: [{ type: 'text', text: PARTIAL }] },
                            ],
                            failure: { reason: 'overloaded' as const },
                        },
                    ],
                }
                const calls: string[] = []
                const replay = replayAssistant(fixture, 'question', async (name) => {
                    calls.push(name)
                    return '{}'
                })
                await expect(replay).rejects.toBeInstanceOf(LlmUnavailableError)
                await expect(replay).rejects.toMatchObject({ reason: 'overloaded' })
                expect(calls).toEqual(['lookup'])
            },

        'the real adapter throws a failure that follows text, with the consumer busy, and the same reason':
            async () => {
                const encoder = new TextEncoder()
                const opening =
                    sse('message_start', {
                        type: 'message_start',
                        message: {
                            id: 'msg_1',
                            type: 'message',
                            role: 'assistant',
                            model: 'conformance',
                            content: [],
                            stop_reason: null,
                            stop_sequence: null,
                            usage: { input_tokens: 1, output_tokens: 1 },
                        },
                    }) +
                    sse('content_block_start', {
                        type: 'content_block_start',
                        index: 0,
                        content_block: { type: 'text', text: '' },
                    }) +
                    sse('content_block_delta', {
                        type: 'content_block_delta',
                        index: 0,
                        delta: { type: 'text_delta', text: PARTIAL },
                    })
                const failure = sse('error', {
                    type: 'error',
                    error: { type: 'overloaded_error', message: 'overloaded' },
                })
                // The provider's answer: the text, then (while the consumer is still busy with it) an overload.
                const fetchStub = vi.fn(async () => {
                    const body = new ReadableStream<Uint8Array>({
                        start(controller) {
                            controller.enqueue(encoder.encode(opening))
                            setTimeout(() => {
                                controller.enqueue(encoder.encode(failure))
                                controller.close()
                            }, 20)
                        },
                    })
                    return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } })
                })
                // The SDK refuses to build a client where `window` exists (a browser-like test environment), so it is
                // taken away for the check, and every stub is undone either way.
                vi.stubGlobal('fetch', fetchStub)
                vi.stubGlobal('window', undefined)
                try {
                    const { createRealLlm } = await import('../../adapters/real/llm')
                    const { text, ended } = await consume(createRealLlm('conformance-key'), 120)
                    expect(text).toBe(PARTIAL)
                    expect(ended).toBeInstanceOf(LlmUnavailableError)
                    expect(ended).toMatchObject({ reason: 'overloaded' })
                    // Text had been delivered, so the adapter did not start the answer again.
                    expect(fetchStub).toHaveBeenCalledTimes(1)
                } finally {
                    vi.unstubAllGlobals()
                }
            },
    },
}
