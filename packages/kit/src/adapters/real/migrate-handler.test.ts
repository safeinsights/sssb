import { afterEach, describe, expect, test, vi } from 'vitest'
import { handler } from './migrate-handler'

const h = vi.hoisted(() => ({
    secret: {} as Record<string, unknown>,
    urls: [] as string[],
    ssl: [] as unknown[],
    dataApi: [] as object[],
}))
vi.mock('@aws-sdk/client-secrets-manager', () => ({
    SecretsManagerClient: class {
        async send(): Promise<{ SecretString: string }> {
            return { SecretString: JSON.stringify(h.secret) }
        }
    },
    GetSecretValueCommand: class {},
}))
vi.mock('./db', () => ({
    createRealDb: (url: string, ssl: unknown) => {
        h.urls.push(url)
        h.ssl.push(ssl)
        return { migrateToLatest: async () => undefined }
    },
}))
vi.mock('./db-data-api', () => ({
    createRealDataApiDb: (config: object) => {
        h.dataApi.push(config)
        return { migrateToLatest: async () => undefined }
    },
}))

afterEach(() => {
    vi.unstubAllEnvs()
    h.urls.length = 0
    h.ssl.length = 0
    h.dataApi.length = 0
})

describe('the migrator handler (pg transport)', () => {
    test('encodes the user, the password and the database name into the URL', async () => {
        vi.stubEnv('DATABASE_TRANSPORT', 'pg')
        vi.stubEnv('DB_SECRET_ARN', 'arn:aws:secretsmanager:us-east-1:000000000000:secret:migrator')
        vi.stubEnv('DATABASE_NAME', 'app/stage?x#y%z')
        h.secret = { host: 'db.internal', port: 5432, username: 'own@er', password: 'p:w/d' }
        expect(await handler()).toEqual({ ok: true })
        expect(h.urls).toEqual(['postgres://own%40er:p%3Aw%2Fd@db.internal:5432/app%2Fstage%3Fx%23y%25z'])
        expect(new URL(h.urls[0] ?? '').pathname).toBe('/app%2Fstage%3Fx%23y%25z')
    })

    test("connects with the server's TLS settings, verify-full when none is set, and refuses a bad one first", async () => {
        vi.stubEnv('DATABASE_TRANSPORT', 'pg')
        vi.stubEnv('DB_SECRET_ARN', 'arn:aws:secretsmanager:us-east-1:000000000000:secret:migrator')
        vi.stubEnv('DATABASE_NAME', 'app')
        h.secret = { host: 'db.internal', port: 5432, username: 'owner', password: 'pw' }
        vi.stubEnv('DATABASE_SSL_MODE', undefined)
        vi.stubEnv('DATABASE_SSL_ROOT_CERT', undefined)
        await handler()
        vi.stubEnv('DATABASE_SSL_MODE', 'verify-full')
        vi.stubEnv('DATABASE_SSL_ROOT_CERT', '/var/runtime/ca-cert.pem')
        await handler()
        expect(h.ssl).toEqual([
            { mode: 'verify-full', rootCert: undefined },
            { mode: 'verify-full', rootCert: '/var/runtime/ca-cert.pem' },
        ])
        vi.stubEnv('DATABASE_SSL_MODE', 'require')
        await expect(handler()).rejects.toThrow(/DATABASE_SSL_MODE must be one of verify-full, disable/)
        vi.stubEnv('DATABASE_SSL_MODE', undefined)
        vi.stubEnv('NODE_PG_FORCE_NATIVE', '1')
        await expect(handler()).rejects.toThrow(/NODE_PG_FORCE_NATIVE is set/)
        expect(h.urls).toHaveLength(2)
    })
})

describe('the migrator handler (Data API transport)', () => {
    test('waits two minutes for a paused cluster, whatever the server is set to', async () => {
        vi.stubEnv('DATABASE_TRANSPORT', 'data-api')
        vi.stubEnv('DATABASE_CLUSTER_ARN', 'cluster')
        vi.stubEnv('DATABASE_SECRET_ARN', 'secret')
        vi.stubEnv('DATABASE_NAME', 'app')
        vi.stubEnv('DATABASE_RESUME_BUDGET_MS', '1000')
        expect(await handler()).toEqual({ ok: true })
        expect(h.dataApi).toEqual([
            { resourceArn: 'cluster', secretArn: 'secret', database: 'app', resumeBudgetMs: 120_000 },
        ])
    })
})
