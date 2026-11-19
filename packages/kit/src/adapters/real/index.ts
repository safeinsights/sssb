import type { AnalyticsPort } from '../../ports/analytics'
import type { AuthPort } from '../../ports/auth'
import type { DbPort } from '../../ports/db'
import type { EmailPort } from '../../ports/email'
import { CutoverPendingError } from '../../ports/errors'
import type { JobsPort } from '../../ports/jobs'
import type { LlmPort } from '../../ports/llm'
import type { StoragePort } from '../../ports/storage'
import { fakeAnalytics } from '../fake/analytics'
import { absentEmail, absentJobs, absentLlm } from './absent'
import { createRealAnalytics } from './analytics'
import { realAuth } from './auth'
import { DATABASE_ENV, databaseTransport } from './database-transport'
import { createRealDb } from './db'
import type { NotifyJobTerminal } from './jobs-in-process'
import { optionalPortsEnv, portChoice } from './optional-ports'
import { createRealStorage } from './storage'

interface RealPorts {
    auth: AuthPort
    db: DbPort
    storage: StoragePort
    llm: LlmPort
    email: EmailPort
    analytics: AnalyticsPort
    jobs: JobsPort
}

/**
 * Env var -> cutover-checklist row, for what every real deployment needs. Fails fast with the full list, not one var
 * at a time. The database's variables follow DATABASE_TRANSPORT (./database-transport.ts), and the optional ports'
 * (LLM, outbound and inbound email, the job runner) follow their switches (./optional-ports.ts).
 */
const REQUIRED_ENV: Record<string, string> = {
    NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: 'auth-dev',
    CLERK_SECRET_KEY: 'auth-dev',
    STORAGE_BUCKET: 'cloud-accounts',
    AWS_REGION: 'cloud-accounts',
    // The shared secret the cron route (the scheduled tick) and the jobs webhook verify (`withWebhookSecret`).
    WEBHOOK_SECRET: 'job-runner',
}

export function assertRealEnv(): void {
    const required = { ...REQUIRED_ENV, ...DATABASE_ENV[databaseTransport()], ...optionalPortsEnv() }
    const missing = Object.keys(required).filter((name) => !process.env[name])
    if (missing.length > 0) {
        const rows = [...new Set(missing.map((name) => required[name]))]
        throw new CutoverPendingError(
            rows as string[],
            `Missing env: ${missing.join(', ')}. See docs/cutover-checklist.md.`,
        )
    }
}

/**
 * What the adapter registry hands the real ports. `notifyJobTerminal` is how the in-process job runner notifies a
 * job's org: the notification modules import the registry, so this module, which the registry loads while it is being
 * evaluated, and which `sssb check-real-env` bundles on its own, must never import them.
 */
interface RealPortsHooks {
    notifyJobTerminal: NotifyJobTerminal
}

export async function createRealPorts(hooks: RealPortsHooks): Promise<RealPorts> {
    assertRealEnv()
    const env = process.env
    // assertRealEnv above already proved every required variable is set; this narrows the type.
    const need = (name: string): string => {
        const value = env[name]
        if (value === undefined) throw new Error(`missing env: ${name}`)
        return value
    }
    // Every transport and optional adapter below is a dynamic import, so a deployment loads the SDK of what it uses
    // and nothing else: a `pg` deployment never loads the RDS Data SDK, and a port switched off (`none`) never loads
    // its vendor's.
    const db =
        databaseTransport() === 'data-api'
            ? (await import('./db-data-api')).createRealDataApiDb({
                  resourceArn: need('DATABASE_CLUSTER_ARN'),
                  secretArn: need('DATABASE_SECRET_ARN'),
                  database: need('DATABASE_NAME'),
                  region: need('AWS_REGION'),
              })
            : createRealDb(need('DATABASE_URL'))
    const storage = createRealStorage(need('STORAGE_BUCKET'), need('AWS_REGION'))
    const llm =
        portChoice('llm') === 'anthropic' ? (await import('./llm')).createRealLlm(need('ANTHROPIC_API_KEY')) : absentLlm
    const email =
        portChoice('email') === 'mailgun'
            ? (await import('./email')).createRealEmail(
                  need('MAILGUN_DOMAIN'),
                  need('MAILGUN_API_KEY'),
                  need('EMAIL_FROM'),
              )
            : absentEmail
    const runner = portChoice('jobs')
    const jobs =
        runner === 'codebuild'
            ? (await import('./jobs')).createRealJobs(need('JOBS_CODEBUILD_PROJECT'), need('AWS_REGION'))
            : runner === 'in-process'
              ? (await import('./jobs-in-process')).createInProcessJobs(
                    { db, storage, email, llm },
                    hooks.notifyJobTerminal,
                )
              : absentJobs
    return {
        auth: realAuth,
        db,
        storage,
        llm,
        email,
        jobs,
        // PostHog only where a key is configured (staging/prod per ADR-0010); no-op otherwise.
        analytics: env['POSTHOG_KEY']
            ? createRealAnalytics(env['POSTHOG_KEY'], env['POSTHOG_HOST'] ?? '')
            : fakeAnalytics,
    }
}
