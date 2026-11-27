import { describe, expect, it } from 'vitest'
import { LlmUnavailableError } from '../ports/errors'
import { type AssistantFixture, replayAssistant } from './assistant-replay'

const conversation = [
    { role: 'assistant', content: [{ type: 'tool_use', name: 'lookup', input: { q: 1 } }] },
    { role: 'assistant', content: [{ type: 'text', text: 'Two tickets are open.' }] },
]
const asked = { messages: [{ role: 'user', content: 'what is open?' }] }

describe('replayAssistant', () => {
    it('runs the recorded tool calls and answers the final text', async () => {
        const fixture: AssistantFixture = { entries: [{ request: asked, conversation }] }
        const calls: unknown[] = []
        const text = await replayAssistant(fixture, 'what is open?', async (name, input) => {
            calls.push([name, input])
            return '{}'
        })
        expect(text).toBe('Two tickets are open.')
        expect(calls).toEqual([['lookup', { q: 1 }]])
    })

    it('answers the default entry to a question nothing recorded', async () => {
        const fixture: AssistantFixture = { entries: [{ request: null, response: 'A general answer.' }] }
        expect(await replayAssistant(fixture, 'anything', async () => '{}')).toBe('A general answer.')
    })

    it('throws LlmUnavailableError in place of the answer for an entry that fails, after its tools ran', async () => {
        const fixture: AssistantFixture = {
            entries: [{ request: asked, conversation, failure: { reason: 'rate-limited' } }],
        }
        const calls: string[] = []
        const error = await replayAssistant(fixture, 'what is open?', async (name) => {
            calls.push(name)
            return '{}'
        }).catch((e: unknown) => e)
        expect(error).toBeInstanceOf(LlmUnavailableError)
        expect(error).toMatchObject({ reason: 'rate-limited' })
        expect(calls).toEqual(['lookup'])
    })

    it('throws for a failing default entry, as the fake adapter does for a question nothing recorded', async () => {
        const fixture: AssistantFixture = {
            entries: [{ request: null, response: '', failure: { reason: 'overloaded' } }],
        }
        await expect(replayAssistant(fixture, 'anything', async () => '{}')).rejects.toMatchObject({
            name: 'LlmUnavailableError',
            reason: 'overloaded',
        })
    })

    it("replays a default entry's conversation with its tools, as the fake adapter does (#241)", async () => {
        const fixture: AssistantFixture = { entries: [{ request: null, response: 'ignored', conversation }] }
        const calls: unknown[] = []
        const text = await replayAssistant(fixture, 'a question nothing recorded', async (name, input) => {
            calls.push([name, input])
            return '{}'
        })
        expect(text).toBe('Two tickets are open.')
        expect(calls).toEqual([['lookup', { q: 1 }]])
    })

    it("runs a failing default entry's tools and then throws, as the fake adapter does", async () => {
        const fixture: AssistantFixture = {
            entries: [{ request: null, response: null, conversation, failure: { reason: 'timed-out' } }],
        }
        const calls: string[] = []
        const error = await replayAssistant(fixture, 'anything', async (name) => {
            calls.push(name)
            return '{}'
        }).catch((e: unknown) => e)
        expect(error).toMatchObject({ name: 'LlmUnavailableError', reason: 'timed-out' })
        expect(calls).toEqual(['lookup'])
    })

    it('answers fixture missing when no entry can answer', async () => {
        expect(await replayAssistant({ entries: [] }, 'q', async () => '{}')).toBe('fixture missing')
    })
})
