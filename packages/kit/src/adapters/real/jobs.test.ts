import { beforeEach, describe, expect, test, vi } from 'vitest'

/**
 * The CodeBuild runner with the SDK replaced: what context a build is given. Never run against a real project
 * (cutover row `job-runner`).
 */
const send = vi.fn<(command: unknown) => Promise<object>>(async () => ({}))
vi.mock('@aws-sdk/client-codebuild', () => ({
    CodeBuildClient: class {
        send = send
    },
    StartBuildCommand: class {
        input: unknown
        constructor(input: unknown) {
            this.input = input
        }
    },
}))

beforeEach(() => send.mockClear())

async function overridesFor(orgId: string | null) {
    const { createRealJobs } = await import('./jobs')
    await createRealJobs('proj', 'us-east-1').start({
        id: 'j1',
        kind: 'export-dockets',
        tenantId: 't1',
        orgId,
        payload: { a: 1 },
    })
    expect(send).toHaveBeenCalledTimes(1)
    return (send.mock.calls[0]?.[0] as { input: { projectName: string; environmentVariablesOverride: unknown } }).input
}

describe('the CodeBuild jobs runner', () => {
    test("starts the project's build with the job's whole context, its org included", async () => {
        expect(await overridesFor('o1')).toEqual({
            projectName: 'proj',
            environmentVariablesOverride: [
                { name: 'JOB_ID', value: 'j1', type: 'PLAINTEXT' },
                { name: 'JOB_KIND', value: 'export-dockets', type: 'PLAINTEXT' },
                { name: 'JOB_TENANT_ID', value: 't1', type: 'PLAINTEXT' },
                { name: 'JOB_ORG_ID', value: 'o1', type: 'PLAINTEXT' },
                { name: 'JOB_PAYLOAD', value: '{"a":1}', type: 'PLAINTEXT' },
                { name: 'JOB_ATTEMPT', value: '1', type: 'PLAINTEXT' },
                { name: 'JOB_FIRST_ID', value: 'j1', type: 'PLAINTEXT' },
            ],
        })
    })

    test("a retry's build is told which attempt it is and the first attempt's id (safeinsights/sssb#135)", async () => {
        const { createRealJobs } = await import('./jobs')
        await createRealJobs('proj', 'us-east-1').start({
            id: 'j3',
            kind: 'export-dockets',
            tenantId: 't1',
            orgId: 'o1',
            payload: {},
            attempt: 3,
            firstJobId: 'j1',
        })
        const { environmentVariablesOverride } = (
            send.mock.calls[0]?.[0] as { input: { environmentVariablesOverride: unknown[] } }
        ).input
        expect(environmentVariablesOverride).toContainEqual({ name: 'JOB_ATTEMPT', value: '3', type: 'PLAINTEXT' })
        expect(environmentVariablesOverride).toContainEqual({ name: 'JOB_FIRST_ID', value: 'j1', type: 'PLAINTEXT' })
    })

    test('a job with no org gets an empty JOB_ORG_ID', async () => {
        const { environmentVariablesOverride } = await overridesFor(null)
        expect(environmentVariablesOverride).toContainEqual({ name: 'JOB_ORG_ID', value: '', type: 'PLAINTEXT' })
    })
})
