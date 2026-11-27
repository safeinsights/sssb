import { describe, expect, it } from 'vitest'
import { LLM_DEFAULT_TIMEOUT_MS, llmTimeoutMs } from './llm-timeout'

describe('llmTimeoutMs', () => {
    it('defaults to 25 s, which leaves the 30 s server function room to answer', () => {
        expect(LLM_DEFAULT_TIMEOUT_MS).toBe(25_000)
        expect(llmTimeoutMs(undefined)).toBe(25_000)
    })

    it('uses the fallback it is given, and a request`s own value over either', () => {
        expect(llmTimeoutMs(undefined, 90_000)).toBe(90_000)
        expect(llmTimeoutMs(300_000, 90_000)).toBe(300_000)
        expect(llmTimeoutMs(0.5)).toBe(0.5)
        expect(llmTimeoutMs(2 ** 31 - 1)).toBe(2 ** 31 - 1)
    })

    it('refuses what a timer would read as "never" or "now"', () => {
        for (const bad of [
            0,
            -1,
            Number.NaN,
            Infinity,
            -Infinity,
            2 ** 31,
            '5' as unknown as number,
            null as unknown as number,
        ]) {
            expect(() => llmTimeoutMs(bad)).toThrow(RangeError)
        }
    })
})
