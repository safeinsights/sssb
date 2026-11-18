import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { makeTestTmpDir } from '../../../../../../../tests/support/tmp-dir'
import { createTicker } from '../../../../../../../scripts/ticker.mjs'
import { createDevTickerControl, DEFAULT_INTERVAL_SECONDS, type DevTickerControl } from './dev-ticker'

const stops: DevTickerControl[] = []
afterEach(async () => {
    await Promise.all(stops.splice(0).map((control) => control.stop()))
})

/** A control over the REAL ticker module, ticking a stub instead of HTTP, with its marker in a scratch directory. */
function makeControl(readMarker?: (file: string) => { pid: number; seconds: number } | null) {
    const markerFile = path.join(makeTestTmpDir('dev-ticker-'), 'dev-ticker.json')
    const tick = vi.fn(async () => ({ ok: true, spawned: 0, failed: 0, deliveries: {} }))
    const ticker = createTicker({
        origin: 'http://localhost:1',
        markerFile,
        tick,
        log: () => {},
        // Every interval elapses at once, so a running ticker ticks without a real wait.
        sleep: () => new Promise((resolve) => setTimeout(resolve, 1)),
    })
    const control = createDevTickerControl({
        ticker,
        markerFile,
        pid: process.pid,
        ...(readMarker ? { readMarker } : {}),
    })
    stops.push(control)
    return { control, markerFile, tick }
}

describe('the dev ticker control', () => {
    it('starts stopped, with the bounds and default the field offers', () => {
        const { control } = makeControl()
        expect(control.status()).toEqual({
            running: false,
            seconds: null,
            ticks: 0,
            lastTickAt: null,
            lastError: null,
            elsewhere: null,
            minSeconds: 1,
            maxSeconds: 86_400,
            defaultSeconds: DEFAULT_INTERVAL_SECONDS,
        })
    })

    it.each([0, 1.5, 86_401, '30', null, undefined])('refuses %j as an interval, and stays stopped', (seconds) => {
        const { control, markerFile } = makeControl()
        const result = control.start(seconds)
        expect(result).toMatchObject({ ok: false, error: 'invalid-interval', status: { running: false } })
        expect(existsSync(markerFile)).toBe(false)
    })

    it('starts, ticks, leaves the marker under this pid, and stop removes it', async () => {
        const { control, markerFile, tick } = makeControl()
        const started = control.start(5)
        expect(started).toMatchObject({ ok: true, status: { running: true, seconds: 5, elsewhere: null } })
        expect(JSON.parse(readFileSync(markerFile, 'utf8'))).toMatchObject({ pid: process.pid, seconds: 5 })

        await vi.waitFor(() => expect(control.status().ticks).toBeGreaterThan(0))
        expect(tick).toHaveBeenCalled()
        expect(control.status().lastTickAt).not.toBeNull()

        const stopped = await control.stop()
        expect(stopped).toMatchObject({ running: false, seconds: 5 })
        expect(existsSync(markerFile)).toBe(false)
    })

    it('refuses to start beside a ticker another process left live on this world, and names it', () => {
        const other = { pid: process.pid + 1, seconds: 30 }
        const { control, markerFile } = makeControl(() => other)
        expect(control.status().elsewhere).toEqual(other)
        expect(control.start(5)).toMatchObject({
            ok: false,
            error: 'running-elsewhere',
            status: { running: false, elsewhere: other },
        })
        expect(existsSync(markerFile)).toBe(false)
    })

    it('does not count its own marker as another ticker', () => {
        const { control } = makeControl((file) => {
            try {
                return JSON.parse(readFileSync(file, 'utf8')) as { pid: number; seconds: number }
            } catch {
                return null
            }
        })
        expect(control.start(5).ok).toBe(true)
        expect(control.status().elsewhere).toBeNull()
        // A second start while running is the ticker's no-op, not a refusal: the interval stays what it was.
        expect(control.start(9)).toMatchObject({ ok: true, status: { running: true, seconds: 5 } })
    })
})
