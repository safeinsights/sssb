import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager'
import { databaseSsl, databaseTransport } from './database-transport'
import { createRealDb } from './db'

/** How long the migrator waits for a paused cluster: no user is waiting, and its Lambda has five minutes (SssbApp). */
const MIGRATOR_RESUME_BUDGET_MS = 120_000

/**
 * Migrator Lambda handler (ADR-0001): runs the same migration registry the app, unit tests, and
 * contract tests use. Invoked by the CD pipeline before each release shifts traffic.
 * AUTHORED — CUTOVER (`cloud-accounts`; `data-api` for the Data API path).
 *
 * ROLES. The credentials here are the migrator's, and migration 0015 grants that role the switch to
 * `app_user`. If the application connects as a DIFFERENT role, that role needs the switch too. It cannot
 * grant itself that; this role, which created `app_user` and so holds ADMIN on it, or any other role with
 * ADMIN on `app_user`, runs:  GRANT app_user TO <app role> WITH SET TRUE, INHERIT TRUE;
 * A SECOND database's owner on the same cluster (staging beside production) has no ADMIN on the
 * `app_user` the first one created: its run stops at 0015 and prints the GRANT to run; see the same row.
 * (the `db-role-not-superuser` row in docs/cutover-checklist.md; ADR-0004, 2026-11-16 addendum).
 *
 * The transport follows the app's switch (`DATABASE_TRANSPORT`, ./index.ts), and the Data API one is a
 * dynamic import here too. On the Data API, Kysely's Migrator runs every pending migration in ONE Data
 * API transaction, as it does on `pg` (Postgres DDL is transactional). Two limits follow, and both fail
 * loudly rather than half-apply: the transaction dies after an hour (AWS's BeginTransaction API
 * reference) or three idle minutes, and any single statement still running at 45 seconds is cancelled. A
 * migration that cannot fit — a long backfill, an index on a large table — needs the `pg` transport, from
 * inside the VPC: a deployment on the `data-api` network shape has no other way in to run it.
 *
 * @public
 */
export async function handler(): Promise<{ ok: true }> {
    if (databaseTransport() === 'data-api') {
        const { DATABASE_CLUSTER_ARN, DATABASE_SECRET_ARN, DATABASE_NAME } = process.env
        if (!DATABASE_CLUSTER_ARN || !DATABASE_SECRET_ARN || !DATABASE_NAME) {
            throw new Error('DATABASE_CLUSTER_ARN, DATABASE_SECRET_ARN and DATABASE_NAME must be set for the Data API')
        }
        const { createRealDataApiDb } = await import('./db-data-api')
        const db = createRealDataApiDb({
            resourceArn: DATABASE_CLUSTER_ARN,
            secretArn: DATABASE_SECRET_ARN,
            database: DATABASE_NAME,
            resumeBudgetMs: MIGRATOR_RESUME_BUDGET_MS,
        })
        await db.migrateToLatest()
        return { ok: true }
    }

    const secretArn = process.env['DB_SECRET_ARN']
    if (!secretArn) throw new Error('DB_SECRET_ARN is not set')
    // TLS is the server's, from the same variables (DATABASE_SSL_MODE, DATABASE_SSL_ROOT_CERT), read before the secret
    // so a wrong setting fails first. The URL built below carries no `sslmode`, and ./db.ts refuses one that does.
    const ssl = databaseSsl()

    const client = new SecretsManagerClient({})
    const secret = await client.send(new GetSecretValueCommand({ SecretId: secretArn }))
    const { host, port, username, password, dbname } = JSON.parse(secret.SecretString ?? '{}') as {
        host: string
        port: number
        username: string
        password: string
        dbname?: string
    }

    // The deployment names the database (SSSB's construct sets DATABASE_NAME); the secret's `dbname` is the fallback
    // for infra that does not, and is there only if the cluster's secret attachment added it.
    const database = process.env['DATABASE_NAME'] ?? dbname
    if (!database) throw new Error('neither DATABASE_NAME nor the secret names the database to migrate')
    // Every part a secret or a deployment supplies is encoded: a database name with a `/`, `?`, `#` or `%`
    // would otherwise be read as a path, a query or an escape, and connect to a different database.
    const db = createRealDb(
        `postgres://${encodeURIComponent(username)}:${encodeURIComponent(password)}@${host}:${port}/${encodeURIComponent(database)}`,
        ssl,
    )
    await db.migrateToLatest()
    return { ok: true }
}
