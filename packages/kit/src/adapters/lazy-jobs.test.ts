import { describe, expect, it } from 'vitest'
import type { JobsPort, SubmittedJob } from '../ports/jobs'
import { lazyJobs } from './lazy-jobs'

const JOB: SubmittedJob = { id: 'j', kind: 'k', tenantId: 't', orgId: null, payload: {} }

describe('lazyJobs', () => {
    it('loads nothing until the first call, then loads once and passes every call through', async () => {
        const calls: string[] = []
        let loads = 0
        const port = lazyJobs(async () => {
            loads += 1
            const runner: JobsPort = {
                start: async (job) => void calls.push(`start ${job.id}`),
                sweep: async () => (calls.push('sweep'), 2),
            }
            return runner
        })
        expect(loads).toBe(0)
        await port.start(JOB)
        expect(await port.sweep?.(new Date())).toBe(2)
        await port.start(JOB)
        expect(loads).toBe(1)
        expect(calls).toEqual(['start j', 'sweep', 'start j'])
    })

    it('tries the load again after one that failed', async () => {
        let loads = 0
        const port = lazyJobs(async () => {
            loads += 1
            if (loads === 1) throw new Error('not yet')
            return { start: async () => {} }
        })
        await expect(port.start(JOB)).rejects.toThrow('not yet')
        await expect(port.start(JOB)).resolves.toBeUndefined()
        expect(await port.sweep?.(new Date())).toBe(0) // a runner with no sweep sweeps nothing
        expect(loads).toBe(2)
    })
})
