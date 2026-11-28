import { existsSync, readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { makeTestTmpDir } from '../support/tmp-dir'

/**
 * `safeinsights/sssb#258`: the marker is written whole or not at all. A file system call cannot be paused halfway from
 * outside, so the test stands inside it: `writeFileSync` is wrapped to write the first half of what it is given,
 * look at the marker as a reader would, and only then write the rest. Written straight onto the marker, the reader sees
 * half a JSON document; written beside it and renamed onto it, the reader sees the marker it had.
 */
const seen: { target: string; state: 'absent' | 'whole' | 'partial' }[] = []

vi.mock('node:fs', async (importOriginal) => {
    const real = await importOriginal<typeof import('node:fs')>()
    return {
        ...real,
        writeFileSync: (file: string, data: string, ...rest: unknown[]) => {
            const half = Math.ceil(String(data).length / 2)
            ;(real.writeFileSync as (...args: unknown[]) => void)(file, String(data).slice(0, half), ...rest)
            // The marker a reader would look at: the one this write is for.
            const target = path.join(path.dirname(String(file)), 'dev-ticker.json')
            let state: 'absent' | 'whole' | 'partial' = 'absent'
            if (real.existsSync(target)) {
                try {
                    JSON.parse(real.readFileSync(target, 'utf8'))
                    state = 'whole'
                } catch {
                    state = 'partial'
                }
            }
            seen.push({ target, state })
            ;(real.writeFileSync as (...args: unknown[]) => void)(file, data, ...rest)
        },
    }
})

const { writeTickerMarker, liveTickerMarker } = await import('../../packages/tools/src/tick/ticker-marker.js')

describe('writeTickerMarker', () => {
    it('shows a reader the marker it had, or none, while it writes, never half of the new one', () => {
        const file = path.join(makeTestTmpDir('sssb-marker-atomic-'), 'dev-ticker.json')
        seen.length = 0
        writeTickerMarker(file, 5)
        writeTickerMarker(file, 6)
        expect(seen.map((s) => s.state)).toEqual(['absent', 'whole'])
        expect(JSON.parse(readFileSync(file, 'utf8'))).toMatchObject({ pid: process.pid, seconds: 6 })
    })

    it('leaves only the marker behind, and a reader reads it', () => {
        const file = path.join(makeTestTmpDir('sssb-marker-atomic-'), 'dev-ticker.json')
        writeTickerMarker(file, 5)
        expect(readdirSync(path.dirname(file))).toEqual(['dev-ticker.json'])
        expect(existsSync(file)).toBe(true)
        expect(liveTickerMarker(file)).toMatchObject({ pid: process.pid, seconds: 5 })
    })
})
