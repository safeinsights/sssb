/**
 * SSSB's optional ports in a real deployment: the ones an app may not use at all. Each has a switch, a deployment
 * parameter each app records under `params.ports` in its `config/params.ts` (@sssb/cdk's `SssbApp` sets the variables
 * from it, as it sets DATABASE_TRANSPORT from `params.database.transport`):
 *
 * - `LLM_PROVIDER`: `anthropic` (the default) or `none`. The `llm` port.
 * - `EMAIL_PROVIDER`: `mailgun` (the default) or `none`. The `email` port, which the framework's invitations and
 *   notifications send through too.
 * - `INBOUND_EMAIL_PROVIDER`: `mailgun` (the default) or `none`. The signing key the inbound email route verifies
 *   with (`@sssb/kit/service-auth/mailgun`). Without it that route refuses every request, as it always has.
 * - `JOBS_RUNNER`: `codebuild` (the default), `in-process` or `none`. The `jobs` port: a CodeBuild build per job, the
 *   job's handler run in the server itself (./jobs-in-process.ts), or no jobs at all.
 * - `STORAGE_PROVIDER`: `s3` (the default), `s3-compatible` or `none`. The `storage` port: an S3 bucket
 *   (./s3-storage.ts), the same adapter on another store that speaks the S3 API (Cloudflare R2, MinIO, Backblaze B2),
 *   or no object storage at all. The framework itself stores nothing; an app's attachments, uploads and job artifacts
 *   do. `s3-compatible` is a choice of its own, not `s3` reading an endpoint when one is set: which settings happen
 *   to be set never picks behaviour (below). Beyond the required settings it reads `STORAGE_FORCE_PATH_STYLE`
 *   (`true` or `false`; unset leaves the SDK's own, virtual-hosted addressing), and requires `STORAGE_UPLOAD_TARGET`:
 *   `post` if the store accepts a presigned POST, `put` if it takes a presigned PUT instead (R2 does not accept a
 *   POST), or `none` for an app that takes no browser upload, so that `createUploadTarget` fails naming the setting.
 *   A PUT upload target signs the file's exact size into the URL (`UploadConstraints.sizeBytes`). Explicit and with no default, because either default
 *   would be a guess that fails on some store only when a browser first uploads.
 *
 * `AWS_REGION` is required by the choices that call AWS (`s3`, `codebuild`) and by the Data API transport
 * (./index.ts), not by every deployment: one on `pg` with no storage and no CodeBuild runner calls no AWS API.
 * `s3-compatible` reads `STORAGE_REGION` and its own key pair instead of `AWS_REGION` and the AWS keys, which Lambda
 * reserves for the function's own role and region.
 *
 * An unset switch is its default, which is what real mode required before the switches existed, so a deployment that
 * sets none of them boots as it did. `none` makes the port ABSENT (./absent.ts): its settings are not required, its
 * SDK is never loaded, and a call through it throws an error that names the switch. Never fill an unused port's
 * settings with placeholder values instead: a placeholder reaches the vendor and fails there, far from the cause.
 *
 * An explicit switch, never inferred from which settings happen to be set (the DATABASE_TRANSPORT rule): a
 * deployment that half-configures a port must fail at boot, not quietly lose it.
 */
export const OPTIONAL_PORTS = {
    llm: {
        variable: 'LLM_PROVIDER',
        default: 'anthropic',
        env: { anthropic: { ANTHROPIC_API_KEY: 'llm-key' }, none: {} },
    },
    email: {
        variable: 'EMAIL_PROVIDER',
        default: 'mailgun',
        env: {
            mailgun: {
                MAILGUN_DOMAIN: 'email-outbound',
                MAILGUN_API_KEY: 'email-outbound',
                EMAIL_FROM: 'email-outbound',
            },
            none: {},
        },
    },
    inboundEmail: {
        variable: 'INBOUND_EMAIL_PROVIDER',
        default: 'mailgun',
        // The key Mailgun signs inbound-route webhooks with, verified by the inbound email route at request time.
        env: { mailgun: { MAILGUN_WEBHOOK_SIGNING_KEY: 'email-inbound' }, none: {} },
    },
    jobs: {
        variable: 'JOBS_RUNNER',
        default: 'codebuild',
        env: {
            codebuild: { JOBS_CODEBUILD_PROJECT: 'job-runner', AWS_REGION: 'cloud-accounts' },
            'in-process': {},
            none: {},
        },
    },
    storage: {
        variable: 'STORAGE_PROVIDER',
        default: 's3',
        env: {
            s3: { STORAGE_BUCKET: 'cloud-accounts', AWS_REGION: 'cloud-accounts' },
            's3-compatible': {
                STORAGE_BUCKET: 'storage-compatible-store',
                STORAGE_ENDPOINT: 'storage-compatible-store',
                STORAGE_REGION: 'storage-compatible-store',
                STORAGE_UPLOAD_TARGET: 'storage-compatible-store',
                STORAGE_ACCESS_KEY_ID: 'storage-compatible-credentials',
                STORAGE_SECRET_ACCESS_KEY: 'storage-compatible-credentials',
            },
            none: {},
        },
    },
} as const satisfies Record<
    string,
    { variable: string; default: string; env: Record<string, Readonly<Record<string, string>>> }
>

export type OptionalPort = keyof typeof OPTIONAL_PORTS
export type PortChoice<P extends OptionalPort> = keyof (typeof OPTIONAL_PORTS)[P]['env'] & string

/** The deployment's choice for one optional port: its switch, or the default when unset. Fails on an unknown value. */
export function portChoice<P extends OptionalPort>(port: P): PortChoice<P> {
    const { variable, default: fallback, env } = OPTIONAL_PORTS[port]
    const choices = Object.keys(env)
    const value = process.env[variable] || fallback
    if (!choices.includes(value)) {
        throw new Error(`${variable} must be one of ${choices.join(', ')} (got "${value}")`)
    }
    return value as PortChoice<P>
}

/** The variables the deployment's optional-port choices require, each mapped to its cutover row. */
export function optionalPortsEnv(): Record<string, string> {
    const required: Record<string, string> = {}
    for (const port of Object.keys(OPTIONAL_PORTS) as OptionalPort[]) {
        const env: Record<string, Readonly<Record<string, string>>> = OPTIONAL_PORTS[port].env
        Object.assign(required, env[portChoice(port)])
    }
    return required
}
