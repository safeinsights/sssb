import { CodeBuildClient, StartBuildCommand } from '@aws-sdk/client-codebuild'
import type { JobsPort } from '../../ports/jobs'

/**
 * AUTHORED — CUTOVER (`job-runner`): typechecked against @aws-sdk/client-codebuild, never run
 * against a real project. Starting the build is ALL this seam does — the job stays 'queued' until
 * the build's FINAL step POSTs /api/webhooks/jobs with `x-sssb-webhook-secret: $WEBHOOK_SECRET` (never `Authorization`, which
 * the deployment's CloudFront replaces with its own signature) and
 * `{ jobId, tenantId, status: 'completed' | 'failed', resultKey?, error? }`, which records the
 * terminal transition via packages/kit/src/db/jobs.recordWebhookCompletion (idempotent under redelivery). The
 * build receives its context through environment overrides, mirroring a handler's `JobContext`: JOB_ID, JOB_KIND,
 * JOB_TENANT_ID, which the webhook echoes back as `tenantId` so the completion is scoped to the right tenant without the
 * build having to look it up, JOB_ORG_ID (empty for a job with no org), and JOB_PAYLOAD. Every override is PLAINTEXT,
 * readable in the CodeBuild console and in CloudTrail, so a job's payload must never carry a secret or personal data:
 * pass an id the build reads with its own access instead.
 */
export function createRealJobs(project: string, region: string): JobsPort {
    const client = new CodeBuildClient({ region })

    return {
        async start(job) {
            await client.send(
                new StartBuildCommand({
                    projectName: project,
                    environmentVariablesOverride: [
                        { name: 'JOB_ID', value: job.id, type: 'PLAINTEXT' },
                        { name: 'JOB_KIND', value: job.kind, type: 'PLAINTEXT' },
                        { name: 'JOB_TENANT_ID', value: job.tenantId, type: 'PLAINTEXT' },
                        { name: 'JOB_ORG_ID', value: job.orgId ?? '', type: 'PLAINTEXT' },
                        { name: 'JOB_PAYLOAD', value: JSON.stringify(job.payload ?? {}), type: 'PLAINTEXT' },
                    ],
                }),
            )
        },
    }
}
