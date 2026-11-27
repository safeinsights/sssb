import { staffOrgSlug } from '@sssb/app-config/abilities'
import type { AnalyticsPort } from '../../ports/analytics'
import type { AuthPort } from '../../ports/auth'
import type { DbPort } from '../../ports/db'
import type { EmailPort } from '../../ports/email'
import { CutoverPendingError } from '../../ports/errors'
import type { JobsPort } from '../../ports/jobs'
import type { FailLostJob } from './jobs'
import type { LlmPort } from '../../ports/llm'
import type { StoragePort } from '../../ports/storage'
import { absentEmail, absentJobs, absentLlm, absentStorage } from './absent'
import { authRequiredEnv, authSettings, fixedOrgProblem } from '../auth-tenancy'
import { configuredAuth } from '../configured-auth'
import { orgNameForSlugs } from '../../db/org-lookup'
import { clerkIdentitySource, realAuth } from './auth'
import { clerkAuthorizedParties } from './clerk-authorized-parties'
import {
    DATABASE_ENV,
    databaseResumeBudgetMs,
    databaseSsl,
    databaseTransport,
    refuseTlsInUrl,
} from './database-transport'
import { noAnalytics } from './no-analytics'
import { optionalPortsEnv, portChoice } from './optional-ports'
import { assertEndpoint, parseForcePathStyle, parseUploadTarget } from './storage-settings'

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
 * (LLM, outbound and inbound email, the job runner, storage) follow their switches (./optional-ports.ts).
 */
const REQUIRED_ENV: Record<string, string> = {
    NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: 'auth-dev',
    CLERK_SECRET_KEY: 'auth-dev',
    // The shared secret the cron route (the scheduled tick) and the jobs webhook verify (`withWebhookSecret`).
    WEBHOOK_SECRET: 'job-runner',
}

/**
 * The Data API transport's region. Not in DATABASE_ENV, whose every variable SssbApp sets on the server: on Lambda the
 * runtime sets AWS_REGION, a variable a function may not set itself. The optional ports that call AWS require it too
 * (./optional-ports.ts).
 */
const DATA_API_REGION_ENV: Record<string, string> = { AWS_REGION: 'cloud-accounts' }

export function assertRealEnv(): void {
    const transport = databaseTransport()
    const required = {
        ...REQUIRED_ENV,
        ...DATABASE_ENV[transport],
        ...(transport === 'data-api' ? DATA_API_REGION_ENV : {}),
        ...optionalPortsEnv(),
        ...authRequiredEnv(),
    }
    const missing = Object.keys(required).filter((name) => !process.env[name])
    if (missing.length > 0) {
        const rows = [...new Set(missing.map((name) => required[name]))]
        throw new CutoverPendingError(
            rows as string[],
            `Missing env: ${missing.join(', ')}. See docs/cutover-checklist.md.`,
        )
    }
    // Present is not enough for the settings that choose behaviour: refuse here what the adapter would refuse at boot,
    // in the same form (a CutoverPendingError, which `sssb check-real-env` prints), naming the row that holds them.
    if (portChoice('storage') === 's3-compatible') {
        try {
            parseUploadTarget(process.env['STORAGE_UPLOAD_TARGET'] ?? '')
            parseForcePathStyle(process.env['STORAGE_FORCE_PATH_STYLE'])
            assertEndpoint(process.env['STORAGE_ENDPOINT'] ?? '')
        } catch (error) {
            throw new CutoverPendingError(['storage-compatible-store'], (error as Error).message)
        }
    }
    if (transport === 'data-api') {
        try {
            databaseResumeBudgetMs()
        } catch (error) {
            throw new CutoverPendingError(['data-api'], (error as Error).message)
        }
    } else {
        // The TLS settings and a URL that would override them, as createRealDb refuses both. The root file is not read
        // here: the path `SssbApp` sets (the Lambda runtime's bundle) exists only there, and `sssb check-real-env` runs
        // anywhere; createRealDb reads it when the pool is built.
        try {
            databaseSsl()
            refuseTlsInUrl(process.env['DATABASE_URL'] ?? '')
        } catch (error) {
            throw new CutoverPendingError(['db-tls'], (error as Error).message)
        }
    }
    // The auth settings: an unknown choice, a malformed slug, key or role, a setting its choice does not use, or a fixed
    // org source that would hand everyone the staff org's manage-all.
    let problem: string | null
    try {
        problem = fixedOrgProblem(authSettings().orgSource, staffOrgSlug)
    } catch (error) {
        problem = (error as Error).message
    }
    if (problem) throw new CutoverPendingError(['auth-tenancy'], problem)
    // The origins Clerk accepts session tokens from, optional: Clerk's middleware refuses a malformed list when it loads
    // (./clerk-proxy.ts), and this refuses it too, so `sssb check-real-env` reports it before a deploy.
    try {
        clerkAuthorizedParties(process.env['CLERK_AUTHORIZED_PARTIES'])
    } catch (error) {
        throw new CutoverPendingError(['auth-dev'], (error as Error).message)
    }
}

/**
 * What the adapter registry hands the real ports: how to build the in-process job runner (`JOBS_RUNNER=in-process`).
 * The runner runs the app's registered job handlers, so it reaches the app's seam, and through it whatever the app's
 * handlers import, the registry included. This module must reach none of that: the registry loads it while being
 * evaluated, and `sssb check-real-env` bundles it on its own, as CommonJS, which refuses the registry's top-level
 * await. So the registry hands in a hook that returns the runner (./jobs-in-process.ts, given its notifier) wrapped
 * to load on its first use (../lazy-jobs.ts): the hook is called while the registry is still being evaluated, so it
 * must not load the handlers then.
 * Optional, so a caller that builds the real ports itself is unchanged; such a caller gets a named error at boot if it
 * selects the in-process runner without handing one in.
 */
interface RealPortsHooks {
    /**
     * How the CodeBuild runner's sweep fails a job whose build was lost (safeinsights/sssb#231): handed in for the same
     * reason as `inProcessJobs` (failing a job reaches the job modules and the app's seam). Without it the runner has
     * no sweep, as before.
     */
    failLostJob?: FailLostJob
    inProcessJobs?: (ports: {
        db: DbPort
        storage: StoragePort
        email: EmailPort
        llm: LlmPort
        auth: AuthPort
    }) => Promise<JobsPort>
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
    // Each database transport, PostHog and every optional adapter below is a dynamic import, so a deployment loads
    // the SDK of what it chose and nothing else: a `pg` deployment never loads the RDS Data SDK and a Data API one never
    // loads `pg`, PostHog loads only with a key, and a port switched off (`none`) never loads its vendor's (storage's
    // S3 SDK included). Auth (Clerk) serves every deployment, so it is imported as this module is.
    const db =
        databaseTransport() === 'data-api'
            ? (await import('./db-data-api')).createRealDataApiDb({
                  resourceArn: need('DATABASE_CLUSTER_ARN'),
                  secretArn: need('DATABASE_SECRET_ARN'),
                  database: need('DATABASE_NAME'),
                  region: need('AWS_REGION'),
                  resumeBudgetMs: databaseResumeBudgetMs(),
              })
            : (await import('./db')).createRealDb(need('DATABASE_URL'), databaseSsl())
    // Clerk, placed as the auth settings say (../auth-tenancy.ts), and Clerk itself on the defaults. Every port that
    // reaches the people (the in-process runner's job context included) is handed this one. A fixed org source names
    // its home org from the database's org row.
    const auth: AuthPort = configuredAuth(realAuth, authSettings(), clerkIdentitySource, staffOrgSlug, (tenant, org) =>
        orgNameForSlugs(db, tenant, org),
    )
    const storageChoice = portChoice('storage')
    const storage =
        storageChoice === 's3'
            ? (await import('./storage')).createRealStorage(need('STORAGE_BUCKET'), need('AWS_REGION'))
            : storageChoice === 's3-compatible'
              ? (await import('./storage')).createCompatibleStorage({
                    bucket: need('STORAGE_BUCKET'),
                    endpoint: need('STORAGE_ENDPOINT'),
                    region: need('STORAGE_REGION'),
                    accessKeyId: need('STORAGE_ACCESS_KEY_ID'),
                    secretAccessKey: need('STORAGE_SECRET_ACCESS_KEY'),
                    uploadTarget: need('STORAGE_UPLOAD_TARGET'),
                    forcePathStyle: env['STORAGE_FORCE_PATH_STYLE'],
                })
              : absentStorage
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
            ? (await import('./jobs')).createRealJobs(
                  need('JOBS_CODEBUILD_PROJECT'),
                  need('AWS_REGION'),
                  db,
                  hooks.failLostJob,
              )
            : runner === 'in-process'
              ? await inProcessJobs(hooks, { db, storage, email, llm, auth })
              : absentJobs
    // PostHog only where a key is configured (staging/prod per ADR-0010); a no-op otherwise (./no-analytics.ts), never
    // the simulated world's fake, which writes under `.data/`.
    const analytics = env['POSTHOG_KEY']
        ? (await import('./analytics')).createRealAnalytics(env['POSTHOG_KEY'], env['POSTHOG_HOST'] ?? '')
        : noAnalytics
    return {
        auth,
        db,
        storage,
        llm,
        email,
        jobs,
        analytics,
    }
}

function inProcessJobs(
    hooks: RealPortsHooks,
    ports: { db: DbPort; storage: StoragePort; email: EmailPort; llm: LlmPort; auth: AuthPort },
): Promise<JobsPort> {
    if (!hooks.inProcessJobs) {
        throw new Error(
            'JOBS_RUNNER=in-process needs the adapter registry to build the runner: take the ports from ' +
                '@sssb/kit/adapters/index, or pass createRealPorts an inProcessJobs hook',
        )
    }
    return hooks.inProcessJobs(ports)
}
