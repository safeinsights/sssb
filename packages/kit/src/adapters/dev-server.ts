/** The run-mode facts `simulatedDevServer` decides from, all read once in ./index.ts (where process.env is read). */
export interface RunFacts {
    isSimulated: boolean
    /** `process.env.NODE_ENV`: `next dev` sets `development`; every `next build` (deployed, demo, e2e) is `production`. */
    nodeEnv: string | undefined
    isDemoMode: boolean
    isE2eBuild: boolean
}

/**
 * Whether this server is a developer's own `next dev` of a simulated world: the one place a dev-only Simulator
 * affordance (the dev ticker control, `apps/showcase/src/app/api/simulator/ticker`) may exist.
 *
 * Every condition is load-bearing, and each is a place the affordance must never reach: real mode (a deployment,
 * or `dev:real` against cloud resources); a production build, which is what a deployment, the hosted demo and CI's
 * e2e run all are; and the demo and e2e switches themselves, so `DEMO_MODE=1 next dev` or `E2E_BUILD=1 next dev`
 * stays out too. The static demo has no server, so it never asks.
 */
export function simulatedDevServer(run: RunFacts): boolean {
    return run.isSimulated && run.nodeEnv === 'development' && !run.isDemoMode && !run.isE2eBuild
}
