import { afterEach, describe, expect, it, vi } from 'vitest'
import { askAssistant } from './ask-assistant'

/** The assistant's failures reject, so the dashboard shows its translated error, never the server's English words. */

afterEach(() => {
    vi.unstubAllGlobals()
})

function answer(response: Response) {
    vi.stubGlobal(
        'fetch',
        vi.fn(() => Promise.resolve(response)),
    )
}

async function ask() {
    const deltas: string[] = []
    const result = askAssistant('why?', (chunk) => deltas.push(chunk))
    return { result, deltas }
}

describe('askAssistant', () => {
    it('streams the answer and returns its sources', async () => {
        answer(new Response('{"sources":["t1"]}\n{"delta":"Hel"}\n{"delta":"lo"}\n'))
        const { result, deltas } = await ask()
        await expect(result).resolves.toEqual({ sources: ['t1'] })
        expect(deltas.join('')).toBe('Hello')
    })

    it('rejects a refused request, printing nothing of its body', async () => {
        answer(Response.json({ error: 'forbidden' }, { status: 403 }))
        const { result, deltas } = await ask()
        await expect(result).rejects.toThrow()
        expect(deltas).toEqual([])
    })

    it('rejects a refused request whose body is not JSON', async () => {
        answer(new Response('Bad Gateway', { status: 502 }))
        await expect((await ask()).result).rejects.toThrow()
    })

    it('rejects an error the stream reports, keeping the text before it and printing nothing of the error', async () => {
        answer(new Response('{"sources":[]}\n{"delta":"Partial"}\n{"error":"provider overloaded"}\n'))
        const { result, deltas } = await ask()
        await expect(result).rejects.toThrow()
        expect(deltas).toEqual(['Partial'])
    })
})
