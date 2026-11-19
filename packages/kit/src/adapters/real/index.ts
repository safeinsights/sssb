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
 * What the adapter registry hands the real ports: how to build the in-process job runner (`JOBS_RUNNER=in-process`).
 * The runner runs the app's registered job handlers, so it reaches the app's seam, and through it whatever the app's
 * handlers import, the registry included. This module must reach none of that: the registry loads it while being
 * evaluated, and `sssb check-real-env` bundles it on its own, as CommonJS, which refuses the registry's top-level
 * await. So the registry builds the runner (./jobs-in-process.ts) and hands it in, already given its notifier.
 * Optional, so a caller that builds the real ports itself is unchanged; such a caller gets a named error at boot if it
 * selects the in-process runner without handing one in.
 */
interface RealPortsHooks {
    inProcessJobs?: (ports: { db: DbPort; storage: StoragePort; email: EmailPort; llm: LlmPort }) => Promise<JobsPort>
}

export async function createRealPorts(hooks: RealPortsHooks = {}): Promise<RealPorts> {
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
              ? await inProcessJobs(hooks, { db, storage, email, llm })
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

function inProcessJobs(
    hooks: RealPortsHooks,
    ports: { db: DbPort; storage: StoragePort; email: EmailPort; llm: LlmPort },
): Promise<JobsPort> {
    if (!hooks.inProcessJobs) {
        throw new Error(
            'JOBS_RUNNER=in-process needs the adapter registry to build the runner: take the ports from ' +
                '@sssb/kit/adapters/index, or pass createRealPorts an inProcessJobs hook',
        )
    }
    return hooks.inProcessJobs(ports)
}
