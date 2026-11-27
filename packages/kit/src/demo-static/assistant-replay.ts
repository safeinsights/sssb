import { LlmUnavailableError, type LlmUnavailableReason } from '../ports/errors'

/**
 * Static-demo twin of the fake llm's runToolLoop (../adapters/fake/llm.ts, ADR-0006/-0009). That
 * adapter reads its fixture off disk with node:fs, which no `file://` bundle can do — so the twin
 * takes the already-imported fixture as data and replays it in the browser.
 *
 * The committed fixture holds the recorded MODEL turns; replay drives them one at a time and runs the
 * caller's `execute` LIVE for each tool_use, so the tool RESULT comes from the in-memory demo world —
 * canned utterances, live effects, exactly the replay-honesty split the server makes. Which fixture
 * (and which tools) is APP vocabulary; the replay mechanism is not, so only the mechanism lives here.
 */

/** One content block of a recorded assistant turn — `text` for an utterance, `tool_use` for a call. */
interface FixtureBlock {
    type: string
    text?: string
    name?: string
    /** A recorded tool_use's arguments. Relayed to `execute` so a tool that TAKES input behaves the
     *  same in the browser twin as it does on the server. */
    input?: unknown
}

/** One recorded fixture entry. `request: null` marks the purpose's default/fallback answer. */
interface FixtureEntry {
    request: { messages?: { role: string; content: string }[] } | null
    response?: string | null
    conversation?: { role: string; content: FixtureBlock[] }[]
    /** The fake adapter's failure form (`LlmFixtureEntry.failure`): the final answer is a thrown error instead. */
    failure?: { reason: LlmUnavailableReason } | null
}

/** The shape of a committed fixtures/llm/*.json file, as far as browser replay cares. */
export interface AssistantFixture {
    entries: FixtureEntry[]
}

/**
 * Replay `question` against `fixture`, running `execute(toolName, input)` for every recorded tool_use before
 * returning the turn's text. The entry that answers is the one recorded for the question or, when none is, the
 * default entry (`request: null`), whose recorded `conversation` is replayed with its tools exactly as a matched
 * entry's is, or, with none, its `response` as a one-turn answer: the fake adapter's tool loop makes the same choice
 * (`lookupToolLoop`), so an unrecorded question is answered rather than thrown at a demo audience, and the demo's tool
 * effects are the server's (`safeinsights/sssb#241`). An entry with a `failure` runs its recorded tool calls and then
 * throws `LlmUnavailableError` in place of the answer, as the fake adapter's tool loop does, so the demo's failure
 * path is the server's. A fixture with no usable entry answers `fixture missing`.
 */
export async function replayAssistant(
    fixture: AssistantFixture,
    question: string,
    execute: (toolName: string, input: unknown) => Promise<string>,
): Promise<string> {
    const matched = fixture.entries.find(
        (e) => e.conversation && e.conversation.length > 0 && e.request?.messages?.[0]?.content === question,
    )
    const answering = matched ?? fixture.entries.find((e) => e.request === null)
    const failure = answering?.failure?.reason
    const conversation = answering?.conversation?.length
        ? answering.conversation
        : typeof answering?.response === 'string'
          ? [{ role: 'assistant', content: [{ type: 'text', text: answering.response }] }]
          : undefined
    if (!conversation) return 'fixture missing'
    let lastText = ''
    for (const turn of conversation) {
        const toolUses = turn.content.filter((b) => b.type === 'tool_use')
        for (const call of toolUses) await execute(call.name ?? '', call.input)
        lastText = turn.content
            .filter((b) => b.type === 'text')
            .map((b) => b.text ?? '')
            .join('')
        if (toolUses.length === 0) break
    }
    // The failure replaces the final answer, wherever the recorded turns ran out.
    if (failure) throw new LlmUnavailableError(failure)
    return lastText
}
