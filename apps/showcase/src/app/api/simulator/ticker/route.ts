import { isSimulated, isSimulatedDevServer } from '@sssb/kit/adapters/index'
import { withPortErrors } from '../../respond'

/**
 * The Simulator's dev ticker control (Jobs tab): GET reads the server's ticker, POST `{ action: 'start', seconds }` or
 * `{ action: 'stop' }` drives it. It ticks the scheduler on real time by calling this server's own
 * `/api/webhooks/cron` with the dev secret, as `pnpm tick` does (./dev-ticker.ts).
 *
 * It exists only on a developer's own `next dev` of a simulated world: 404 in real mode (the simulator/ gate every
 * route here opens with, which is also what exempts it from the per-actor authorize() scan, as a simulated-world
 * surface reachable signed-out like reset) and 404 in every production build, the hosted demo and CI's e2e build
 * included (`isSimulatedDevServer`). The panel shows the control only when GET answers, so a 404 is how it stays
 * absent there. The ticker module is imported after both gates, so a build that 404s never evaluates it.
 */
export async function GET(): Promise<Response> {
    if (!isSimulated) return new Response(null, { status: 404 })
    if (!isSimulatedDevServer) return new Response(null, { status: 404 })
    return withPortErrors(async () => {
        const { devTickerControl } = await import('./dev-ticker')
        return Response.json(devTickerControl().status())
    })
}

export async function POST(request: Request): Promise<Response> {
    if (!isSimulated) return new Response(null, { status: 404 })
    if (!isSimulatedDevServer) return new Response(null, { status: 404 })
    return withPortErrors(async () => {
        const body = (await request.json().catch(() => null)) as Record<string, unknown> | null
        if (typeof body !== 'object' || body === null) {
            return Response.json({ error: 'invalid-payload' }, { status: 400 })
        }
        const { devTickerControl } = await import('./dev-ticker')
        const control = devTickerControl()
        if (body.action === 'stop') return Response.json(await control.stop())
        if (body.action !== 'start') return Response.json({ error: 'invalid-action' }, { status: 400 })

        const result = control.start(body.seconds)
        if (result.ok) return Response.json(result.status)
        return Response.json(
            { error: result.error, ...result.status },
            { status: result.error === 'invalid-interval' ? 400 : 409 },
        )
    })
}
