import type { JobHandler } from '@sssb/kit/ports/jobs'

/**
 * The handler behind the fixture's two quiet kinds (`sweep-dockets`, `quiet-dockets`): it does nothing and
 * writes nothing, and fails when its payload says `{ fail: true }`, so a test can end a job either way. Their
 * only job is to be a kind whose `jobNotify` is not the default; what a handler does is `export-dockets`' to show.
 */
export const noopDocketsHandler: JobHandler = async (payload) => {
    if (typeof payload === 'object' && payload !== null && 'fail' in payload && payload.fail === true) {
        throw new Error('fixture: asked to fail')
    }
    return {}
}
