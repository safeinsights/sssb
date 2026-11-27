import { createHash } from 'node:crypto'
import { existsSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import path from 'node:path'
import { llmTimeoutMs } from '../../core/llm-timeout'
import { LlmUnavailableError, type LlmUnavailableReason } from '../../ports/errors'
import type { LlmMessage, LlmPort, LlmRequest, LlmToolDef, LlmToolLoopRequest, LlmTurn } from '../../ports/llm'
import { writeJsonAtomic } from './atomic-write'
import { dataDir } from './data-dir'

/**
 * Deterministic replay of versioned fixtures (ADR-0009). Fixture files live in fixtures/llm/
 * (committed).
 *
 * Single-turn (`complete`/`stream`): lookup by exact hash of {model, system, messages} -> the
 * entry's `response`; else the purpose's default `response`; else a loud "record" error.
 *
 * Tool loops (`runToolLoop`): entries grow an optional `conversation` — the recorded
 * sequence of model outputs (assistant turns, incl. tool_use requests). REPLAY drives those turns
 * one at a time; between them the APP's `execute` runs LIVE against the fake world, so the tool
 * RESULTS are real even though the model's utterances are canned (the replay-honesty split). The
 * fixture never stores tool results. Matching is the same purpose+hash idea, extended to cover the
 * tools + messages shape, with the same default-entry fallback (a `response`-only default becomes
 * a one-turn text conversation).
 *
 * REQUEST CATCH: before any fixture lookup, every request is also written to .data/llm-requests/
 * (the same port-as-catch-point shape as the fake email adapter, ADR-0011). A fixture proves what
 * the app does with an answer; the catch proves what the app put into the prompt. It is recorded
 * first so a request that matches no fixture — and so throws — is still inspectable.
 */

interface LlmFixtureEntry {
    name: string
    /** Free-form provenance (e.g. "hand-authored pending re-record") — ignored by replay. */
    note?: string
    /** null request = the purpose's default/fallback. */
    request: { model?: string; system?: string; messages: LlmMessage[]; tools?: LlmToolDef[] } | null
    /** Single-turn answer for complete/stream. */
    response: string | null
    /** Recorded model outputs for a tool loop (assistant turns incl. tool_use), turn by turn. */
    conversation?: LlmTurn[] | null
    /**
     * Replay a call that FAILS: the entry's answer is delivered as far as a real failure would have delivered it, then
     * the call throws `LlmUnavailableError(reason)`, as the real adapter does when the provider fails mid-answer
     * (`safeinsights/sssb#145`). `complete` throws before returning any text; `stream` yields `response` (the partial
     * answer), then throws; `runToolLoop` runs every recorded tool call, live, then throws in place of the final
     * answer. A fixture for the failure path of a screen or a route: its `request` is matched like any other entry's.
     */
    failure?: { reason: LlmUnavailableReason } | null
}

export interface LlmFixtureFile {
    purpose: string
    entries: LlmFixtureEntry[]
}

export interface CaughtLlmRequest {
    id: string
    at: string
    purpose: string
    system: string | null
    messages: LlmMessage[]
    /** Tool loops only: the model-facing tool definitions. The app's `execute` closure is never caught. */
    tools: LlmToolDef[] | null
}

let counter = 0

/** Writes the request into the catch store. Ids sort oldest-first as strings; the counter breaks ties
 *  within one millisecond of one process (its six-digit pad keeps a long-lived process's ids sorting
 *  numerically), and the pid keeps two processes sharing one `.data` (a dev server and a script) from
 *  minting the same id and overwriting each other's catch. */
async function catchRequest(
    request: { purpose: string; system?: string; messages: LlmMessage[] },
    tools: LlmToolDef[] | null,
): Promise<void> {
    const caught: CaughtLlmRequest = {
        id: `${Date.now()}-${process.pid}-${(counter++).toString().padStart(6, '0')}`,
        at: new Date().toISOString(),
        purpose: request.purpose,
        system: request.system ?? null,
        messages: request.messages,
        tools: tools && tools.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })),
    }
    await writeJsonAtomic(path.join(dataDir('llm-requests'), `${caught.id}.json`), caught)
}

function hashLlmRequest(request: LlmRequest): string {
    const canonical = JSON.stringify({
        model: request.model ?? null,
        system: request.system ?? null,
        messages: request.messages,
    })
    return createHash('sha256').update(canonical).digest('hex')
}

/** Tool loops hash the tools + messages shape too, so an entry is matched to the request that
 *  built its tool set. Tools are canonicalized to their serializable {name, description,
 *  inputSchema} so the app's `execute` closure never enters the hash. */
function hashToolLoop(request: {
    model?: string
    system?: string
    messages: LlmMessage[]
    tools?: LlmToolDef[]
}): string {
    const canonical = JSON.stringify({
        model: request.model ?? null,
        system: request.system ?? null,
        messages: request.messages,
        tools: (request.tools ?? []).map((t) => ({
            name: t.name,
            description: t.description,
            inputSchema: t.inputSchema,
        })),
    })
    return createHash('sha256').update(canonical).digest('hex')
}

function fixturePath(purpose: string, fixturesDir?: string): string {
    if (!/^[a-z0-9-]+$/.test(purpose)) throw new Error(`invalid llm purpose: ${purpose}`)
    // Fixtures are app-scoped (apps/<app>/fixtures), and the working directory IS the app for every
    // command that runs the app (next dev/build, pnpm llm:record). APP_FIXTURES_DIR overrides that for
    // runners whose cwd is the repo root — the unit suite runs every app's tests in one pass from
    // there. Same override shape as APP_DATA_DIR.
    const root = fixturesDir ?? process.env['APP_FIXTURES_DIR'] ?? path.join(process.cwd(), 'fixtures')
    return path.join(root, 'llm', `${purpose}.json`)
}

function readFixture(purpose: string, fixturesDir?: string): LlmFixtureFile {
    const file = fixturePath(purpose, fixturesDir)
    if (!existsSync(file)) {
        throw new Error(`no llm fixtures for purpose "${purpose}" — create ${file} and run pnpm llm:record`)
    }
    return JSON.parse(readFileSync(file, 'utf8')) as LlmFixtureFile
}

/** What a single-turn replay answers: the text, and the failure the entry says ends it, if any. */
interface Answer {
    text: string
    failure: LlmUnavailableReason | undefined
}

function lookup(request: LlmRequest, fixturesDir?: string): Answer {
    const fixture = readFixture(request.purpose, fixturesDir)
    const hash = hashLlmRequest(request)
    for (const entry of fixture.entries) {
        if (entry.request && entry.response !== null) {
            const entryHash = hashLlmRequest({ ...entry.request, purpose: request.purpose } as LlmRequest)
            if (entryHash === hash) return { text: entry.response, failure: entry.failure?.reason }
        }
    }
    const fallback = fixture.entries.find((e) => e.request === null && e.response !== null)
    // An empty answer is a real one for a failing entry: a call that fails before its first word.
    if (fallback && typeof fallback.response === 'string') {
        return { text: fallback.response, failure: fallback.failure?.reason }
    }
    throw new Error(
        `no matching llm fixture in ${fixturePath(request.purpose, fixturesDir)} (hash ${hash.slice(0, 12)}…) and no default entry`,
    )
}

/** Resolve the recorded conversation (assistant model-outputs) for a tool-loop request. A default
 *  entry may carry a full `conversation` OR a single `response`, which becomes a one-turn text
 *  conversation — so a general question (no matching entry) still replays the deterministic answer. */
function lookupToolLoop(
    request: LlmToolLoopRequest,
    fixturesDir?: string,
): { conversation: LlmTurn[]; failure: LlmUnavailableReason | undefined } {
    const fixture = readFixture(request.purpose, fixturesDir)
    const hash = hashToolLoop(request)
    for (const entry of fixture.entries) {
        if (entry.request && entry.conversation && entry.conversation.length > 0) {
            if (hashToolLoop(entry.request) === hash) {
                return { conversation: entry.conversation, failure: entry.failure?.reason }
            }
        }
    }
    const fallback = fixture.entries.find((e) => e.request === null)
    const failure = fallback?.failure?.reason
    if (fallback?.conversation && fallback.conversation.length > 0) {
        return { conversation: fallback.conversation, failure }
    }
    if (fallback && typeof fallback.response === 'string') {
        return { conversation: [{ role: 'assistant', content: [{ type: 'text', text: fallback.response }] }], failure }
    }
    throw new Error(
        `no matching llm tool-loop fixture in ${fixturePath(request.purpose, fixturesDir)} (hash ${hash.slice(0, 12)}…) and no default entry`,
    )
}

function textOf(turn: LlmTurn): string {
    return turn.content
        .filter((b): b is Extract<typeof b, { type: 'text' }> => b.type === 'text')
        .map((b) => b.text)
        .join('')
}

/** The error a failing fixture entry replays as: the one the real adapter throws for the same provider failure. */
const fixtureFailure = (reason: LlmUnavailableReason) =>
    new LlmUnavailableError(reason, `llm ${reason} (the fixture entry says the call fails)`)

export interface FakeLlmOptions {
    /** Where `llm/<purpose>.json` is read from. Default `APP_FIXTURES_DIR`, else `fixtures/` under the working directory. */
    fixturesDir?: string
    /** Write each request to the catch store (`.data/llm-requests/`) as the app's own adapter does. Default true. */
    catchRequests?: boolean
}

/**
 * Replay is instant, so it never times out and never rate-limits; what it keeps from the real adapter is the check
 * of `timeoutMs`, so a caller's bad value (`0`, `NaN`, a string) fails under `pnpm dev` and its tests, not first in
 * production, and a fixture entry's `failure`, which makes a call fail the way the real adapter's does after the same
 * text (`LlmFixtureEntry.failure`). A route's 503 for `LlmUnavailableError` is proved with the error thrown by hand, as
 * the app's `respond.test.ts` does.
 */
export function createFakeLlm(options: FakeLlmOptions = {}): LlmPort {
    const { fixturesDir, catchRequests = true } = options
    const caught = async (request: Parameters<typeof catchRequest>[0], tools: LlmToolDef[] | null) => {
        if (catchRequests) await catchRequest(request, tools)
    }
    return {
        async complete(request) {
            llmTimeoutMs(request.timeoutMs)
            await caught(request, null)
            const { text, failure } = lookup(request, fixturesDir)
            if (failure) throw fixtureFailure(failure)
            return { text }
        },

        async *stream(request) {
            // A generator body runs on first iteration, so the catch lands when the stream is consumed —
            // the point a real adapter would open its connection too.
            llmTimeoutMs(request.timeoutMs)
            await caught(request, null)
            const { text, failure } = lookup(request, fixturesDir)
            // Word-chunked so streaming UIs exercise their incremental path deterministically.
            for (const chunk of text.split(/(?<= )/)) yield chunk
            // The text is what the stream delivered before it failed: it ends in an error, never quietly.
            if (failure) throw fixtureFailure(failure)
        },

        async runToolLoop(request) {
            llmTimeoutMs(request.timeoutMs)
            await caught(request, request.tools)
            const { conversation, failure } = lookupToolLoop(request, fixturesDir)
            const turns: LlmTurn[] = []
            const maxTurns = request.maxTurns ?? 6
            for (let i = 0; i < conversation.length && i < maxTurns; i++) {
                const assistantTurn = conversation[i]!
                turns.push(assistantTurn)
                const toolUses = assistantTurn.content.filter(
                    (b): b is Extract<typeof b, { type: 'tool_use' }> => b.type === 'tool_use',
                )
                if (toolUses.length === 0) {
                    if (failure) throw fixtureFailure(failure)
                    return { text: textOf(assistantTurn), turns }
                }
                // Relay each tool_use to the app's executor LIVE — the result is real, not canned.
                const resultBlocks: LlmTurn['content'] = []
                for (const call of toolUses) {
                    // Defense-in-depth: a tool_use naming a tool the app never supplied (a hand-edited
                    // fixture, say) is refused here, before any execute dispatch could mis-route it.
                    const known = request.tools.some((t) => t.name === call.name)
                    const result = known
                        ? await request.execute({ name: call.name, input: call.input })
                        : `unknown tool: ${call.name}`
                    resultBlocks.push({ type: 'tool_result', toolUseId: call.id, content: result })
                }
                turns.push({ role: 'user', content: resultBlocks })
            }
            // The failure replaces the final answer, wherever the recorded turns ran out.
            if (failure) throw fixtureFailure(failure)
            // Ran out of recorded turns (or hit maxTurns) with no terminal text-only turn: return the
            // last assistant text we have rather than throwing — a truncated replay is still honest.
            const lastAssistant = [...turns].reverse().find((t) => t.role === 'assistant')
            return { text: lastAssistant ? textOf(lastAssistant) : '', turns }
        },
    }
}

export const fakeLlm: LlmPort = createFakeLlm()

/** Simulated-mode-only: every caught request, oldest first, optionally narrowed to one purpose (NOT part of LlmPort). */
export function listCaughtLlmRequests(purpose?: string): CaughtLlmRequest[] {
    const dir = dataDir('llm-requests')
    return readdirSync(dir)
        .filter((f) => f.endsWith('.json'))
        .map((f) => JSON.parse(readFileSync(path.join(dir, f), 'utf8')) as CaughtLlmRequest)
        .filter((caught) => purpose === undefined || caught.purpose === purpose)
        .sort((a, b) => (a.id < b.id ? -1 : 1))
}

/** Simulated-mode-only: forget every caught request (NOT part of LlmPort). */
export function clearCaughtLlmRequests(): void {
    const dir = dataDir('llm-requests')
    for (const file of readdirSync(dir)) {
        if (file.endsWith('.json')) rmSync(path.join(dir, file), { force: true })
    }
}
