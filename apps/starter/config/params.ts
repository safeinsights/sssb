/**
 * Single source of truth for deployment and external-service parameters.
 *
 * Every PLACEHOLDER_ value maps to a row in docs/cutover-checklist.md describing what fills it and
 * when. Fields ending in `Name` are the names of secrets (env var / Secrets Manager entry) — secret
 * VALUES never live in the repo.
 *
 * WHAT IS LINT-ENFORCED (`sssb/no-process-env`, @sssb/eslint-plugin): `process.env` is read ONLY
 * inside SSSB's own adapters (@sssb/kit/adapters) and an app's own real adapters (apps/<app>/src/adapters/real, which
 * may not read the run mode) — every other module imports the resolved value (this file for
 * deployment/service params; `isSimulated`/`isDemoMode` from @sssb/kit/adapters for run mode). Exemptions:
 * instrumentation files (NEXT_PUBLIC needs literal inlining) and the two secret readers
 * (service-auth/{webhook,mailgun}.ts). This file may not read process.env itself (the ban covers config/).
 * An app-owned adapter's non-secret parameters and secret NAMES are recorded here too, with their cutover
 * rows (SSSB's recipe for an app-owned adapter, docs/recipes/app-owned-adapter.md in SSSB's repository).
 * NOT enforced: that a param's literal VALUE appears nowhere else in the repo — that stays a convention,
 * not a scanner.
 */

export const params = {
    aws: {
        // cutover: cloud-accounts
        devAccountId: 'PLACEHOLDER_AWS_DEV_ACCOUNT_ID',
        prodAccountId: 'PLACEHOLDER_AWS_PROD_ACCOUNT_ID',
        region: 'PLACEHOLDER_AWS_REGION',
    },
    domains: {
        // cutover: domains-and-certs — first deploys use *.cloudfront.net
        staging: 'PLACEHOLDER_STAGING_DOMAIN',
        production: 'PLACEHOLDER_PRODUCTION_DOMAIN',
        demo: 'PLACEHOLDER_DEMO_DOMAIN',
        certificateArn: 'PLACEHOLDER_ACM_CERTIFICATE_ARN',
    },
    database: {
        // cutover: data-api — how the app reaches Postgres; infra/ (SssbApp) builds the matching network shape
        // and sets DATABASE_TRANSPORT from it.
        // 'pg' (the default): node-postgres from a Lambda inside the database's VPC. 'data-api' (opt-in):
        // the RDS Data API from a Lambda outside any VPC, with no NAT (ADR-0002, addendum 2026-11-16).
        transport: 'pg' as 'pg' | 'data-api',
    },
    ports: {
        // Which of SSSB's optional ports this app uses in a deployment; infra/ (SssbApp) sets LLM_PROVIDER,
        // EMAIL_PROVIDER, INBOUND_EMAIL_PROVIDER, JOBS_RUNNER and STORAGE_PROVIDER from it. `none` leaves the port
        // absent: real mode requires none of its settings (and its cutover row does not apply), and a call through it
        // fails naming the switch. Never fill an unused port's settings with placeholder values instead.
        // No model calls: set 'anthropic' when the app adds one (cutover: llm-key)
        llm: 'none' as 'anthropic' | 'none',
        // cutover: email-outbound — invitations, notifications, digests
        email: 'mailgun' as 'mailgun' | 'none',
        // No inbound email route: set 'mailgun' when the app adds /api/webhooks/email (cutover: email-inbound)
        inboundEmail: 'none' as 'mailgun' | 'none',
        // Each job's handler runs in the server, within its time limit, so no CodeBuild project is needed; 'codebuild'
        // (cutover: job-runner) runs each job as a build instead, completed through a jobs webhook route
        jobs: 'in-process' as 'codebuild' | 'in-process' | 'none',
        // No object storage: set 's3' when the app stores files, and SssbApp builds its bucket (cutover:
        // cloud-accounts); 's3-compatible' keeps them in another store (R2, MinIO, B2) and builds none (cutover:
        // storage-compatible-store)
        storage: 'none' as 's3' | 's3-compatible' | 'none',
    },
    auth: {
        // How sign-in places people; SssbApp sets AUTH_TENANCY and AUTH_ORG_SOURCE from it. cutover: auth-tenancy
        // Two independent choices. `tenancy`, where the tenant comes from: 'multi', each user's claim in their identity
        // provider's public metadata (under `tenantMetadataKey`, `tenantSlug` when left out); or 'single' (add
        // `tenantSlug`), fixed by the deployment, which changes nothing else. `orgSource`, where orgs and roles come
        // from: 'provider', the identity provider's organizations and each membership's role; or 'fixed' (needs
        // 'single'; add `homeOrgSlug`, and `defaultRole` 'none' or 'restricted', 'none' when left out), for a provider
        // used without organizations: everyone it signs in is placed in that org with that role, and your own rules
        // grant the rest.
        // On a provider instance shared with another product, every user of that product then signs in to this one.
        tenancy: 'multi' as const,
        orgSource: 'provider' as const,
    },
    clerk: {
        // cutover: auth-dev (development instance), auth-prod (production instance)
        publishableKeyName: 'PLACEHOLDER_CLERK_PUBLISHABLE_KEY_NAME',
        secretKeyName: 'PLACEHOLDER_CLERK_SECRET_KEY_NAME',
    },
    mailgun: {
        // cutover: email-outbound
        domain: 'PLACEHOLDER_MAILGUN_DOMAIN',
        apiKeyName: 'PLACEHOLDER_MAILGUN_API_KEY_NAME',
        // cutover: email-inbound — the HMAC signing key Mailgun signs inbound webhooks with
        webhookSigningKeyName: 'PLACEHOLDER_MAILGUN_WEBHOOK_SIGNING_KEY_NAME',
    },
    sentry: {
        // cutover: errors — the Sentry wiring is inert until a DSN is set
        dsn: 'PLACEHOLDER_SENTRY_DSN',
        org: 'PLACEHOLDER_SENTRY_ORG',
        project: 'PLACEHOLDER_SENTRY_PROJECT',
    },
    posthog: {
        // cutover: analytics — real adapter is enabled in staging/prod only
        projectKey: 'PLACEHOLDER_POSTHOG_PROJECT_KEY',
        host: 'PLACEHOLDER_POSTHOG_HOST',
    },
    anthropic: {
        // cutover: llm-key — unlocks `pnpm llm:record`
        apiKeyName: 'PLACEHOLDER_ANTHROPIC_API_KEY_NAME',
    },
} as const

export type Params = typeof params
