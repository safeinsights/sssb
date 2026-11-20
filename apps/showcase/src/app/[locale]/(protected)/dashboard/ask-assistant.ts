import type { AssistantSources } from '@/components/dashboard-screen'

/**
 * The dashboard's assistant call: POST the question, stream the NDJSON answer into `onDelta`, answer the sources.
 *
 * A failure REJECTS, and the dashboard shows its own translated `assistantError`: a refused request (403, a missing
 * key) and an error the stream reports are the server's English words, never copy for the reader. Text already
 * streamed before an error stays on screen.
 */
export async function askAssistant(question: string, onDelta: (chunk: string) => void): Promise<AssistantSources> {
    const response = await fetch('/api/assistant', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ question }),
    })
    if (!response.ok || !response.body) throw new Error(`POST /api/assistant answered ${response.status}`)
    // NDJSON: one JSON object per line. The first carries the sources (pass 1 has already finished by the time a
    // byte is written); every line after it is a text delta. Buffer across chunk boundaries — a network read can
    // split a line anywhere.
    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    let sources: string[] = []
    let failed: string | null = null
    const consume = (line: string) => {
        if (!line.trim()) return
        let event: { sources?: string[]; delta?: string; error?: string }
        try {
            event = JSON.parse(line) as { sources?: string[]; delta?: string; error?: string }
        } catch {
            // A dropped connection can truncate the final line mid-object — skip it rather than throwing out of the
            // whole ask.
            return
        }
        if (event.sources) sources = event.sources
        if (event.delta) onDelta(event.delta)
        if (event.error) failed = event.error
    }
    for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        const lines = buffer.split('\n')
        buffer = lines.pop() ?? ''
        for (const line of lines) consume(line)
    }
    consume(buffer)
    if (failed !== null) throw new Error(`the assistant stream reported: ${failed}`)
    return { sources }
}
