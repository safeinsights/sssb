import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { type RunFacts, simulatedDevServer } from './dev-server'

const devServer: RunFacts = { isSimulated: true, nodeEnv: 'development', isDemoMode: false, isE2eBuild: false }

describe('simulatedDevServer', () => {
    it('is true for a simulated `next dev` with neither build switch', () => {
        expect(simulatedDevServer(devServer)).toBe(true)
    })

    it.each<[string, Partial<RunFacts>]>([
        ['real mode (a deployment, or dev:real)', { isSimulated: false }],
        ['a production build (deployed, the hosted demo, CI e2e)', { nodeEnv: 'production' }],
        ['Vitest', { nodeEnv: 'test' }],
        ['no NODE_ENV at all', { nodeEnv: undefined }],
        ['DEMO_MODE, even under next dev', { isDemoMode: true }],
        ['E2E_BUILD, even under next dev', { isE2eBuild: true }],
    ])('is false for %s', (_, change) => {
        expect(simulatedDevServer({ ...devServer, ...change })).toBe(false)
    })
})

describe('adapters/index.ts', () => {
    // index.ts evaluates at module load and imports the real adapters in real mode, so (like production-guard.test.ts)
    // the wiring is read from source: the exported flag must be this function over the SAME flags the guard uses.
    const source = readFileSync(path.join(__dirname, 'index.ts'), 'utf8')

    it('exports isSimulatedDevServer from the run-mode flags it reads itself', () => {
        expect(source.replace(/\s+/g, ' ')).toContain(
            'export const isSimulatedDevServer = simulatedDevServer({ isSimulated, nodeEnv: process.env.NODE_ENV, isDemoMode, isE2eBuild, })',
        )
    })
})
