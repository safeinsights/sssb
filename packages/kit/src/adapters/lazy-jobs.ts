import type { JobsPort } from '../ports/jobs'

/**
 * A jobs port that loads its runner on first use, not when it is made. The adapter registry builds the in-process
 * runner with this (./index.ts): loading it means loading the app's job handlers (`@sssb/app-config/jobs`), and a handler
 * that imports the registry (for `isSimulated`, say) would make the registry's top-level await wait on a module that
 * waits on the registry, so the server would never finish loading. By the first `start` or `sweep` the registry has.
 * A failed load is not kept: the next call tries again.
 */
export function lazyJobs(load: () => Promise<JobsPort>): JobsPort {
    let runner: Promise<JobsPort> | undefined
    const get = () =>
        (runner ??= load().catch((error: unknown) => {
            runner = undefined
            throw error
        }))
    return {
        async start(job) {
            await (await get()).start(job)
        },
        async sweep(now, budget) {
            return (await (await get()).sweep?.(now, budget)) ?? 0
        },
    }
}
