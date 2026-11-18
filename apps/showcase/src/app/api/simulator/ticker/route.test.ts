import { afterEach, describe, expect, it, vi } from 'vitest'

const run = vi.hoisted(() => ({ isSimulated: true, isSimulatedDevServer: false }))
vi.mock('@sssb/kit/adapters/index', () => ({
    get isSimulated() {
        return run.isSimulated
    },
    get isSimulatedDevServer() {
        return run.isSimulatedDevServer
    },
}))

const control = vi.hoisted(() => ({
    status: vi.fn(() => ({ running: false })),
    start: vi.fn(),
    stop: vi.fn(async () => ({ running: false })),
}))
vi.mock('./dev-ticker', () => ({ devTickerControl: () => control }))

const { GET, POST } = await import('./route')

function post(body: unknown) {
    return POST(new Request('http://localhost/api/simulator/ticker', { method: 'POST', body: JSON.stringify(body) }))
}

afterEach(() => {
    run.isSimulated = true
    run.isSimulatedDevServer = false
    vi.clearAllMocks()
})

describe('/api/simulator/ticker', () => {
    it.each([
        ['a production build, the demo, e2e or Vitest (not a simulated dev server)', true, false],
        ['real mode', false, false],
    ])('answers 404 to GET and POST in %s, and never touches the ticker', async (_, isSimulated, devServer) => {
        run.isSimulated = isSimulated
        run.isSimulatedDevServer = devServer
        expect((await GET()).status).toBe(404)
        expect((await post({ action: 'start', seconds: 5 })).status).toBe(404)
        expect(control.status).not.toHaveBeenCalled()
        expect(control.start).not.toHaveBeenCalled()
    })

    describe('on a simulated dev server', () => {
        it('GET reads the status', async () => {
            run.isSimulatedDevServer = true
            const response = await GET()
            expect(response.status).toBe(200)
            expect(await response.json()).toEqual({ running: false })
        })

        it('POST start answers the status, 400 for a bad interval and 409 beside another ticker', async () => {
            run.isSimulatedDevServer = true
            control.start.mockReturnValueOnce({ ok: true, status: { running: true } })
            expect(await (await post({ action: 'start', seconds: 5 })).json()).toEqual({ running: true })
            expect(control.start).toHaveBeenCalledWith(5)

            control.start.mockReturnValueOnce({ ok: false, error: 'invalid-interval', status: { running: false } })
            const bad = await post({ action: 'start', seconds: 0 })
            expect(bad.status).toBe(400)
            expect(await bad.json()).toEqual({ error: 'invalid-interval', running: false })

            control.start.mockReturnValueOnce({ ok: false, error: 'running-elsewhere', status: { running: false } })
            expect((await post({ action: 'start', seconds: 5 })).status).toBe(409)
        })

        it('POST stop stops it; anything else is a 400', async () => {
            run.isSimulatedDevServer = true
            expect((await post({ action: 'stop' })).status).toBe(200)
            expect(control.stop).toHaveBeenCalledOnce()
            expect((await post({ action: 'pause' })).status).toBe(400)
            expect((await post('start')).status).toBe(400)
        })
    })
})
