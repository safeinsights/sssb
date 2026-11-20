import { afterEach, describe, expect, test, vi } from 'vitest'
import { handler } from './migrate-handler'

const h = vi.hoisted(() => ({ secret: {} as Record<string, unknown>, urls: [] as string[] }))
vi.mock('@aws-sdk/client-secrets-manager', () => ({
    SecretsManagerClient: class {
        async send(): Promise<{ SecretString: string }> {
            return { SecretString: JSON.stringify(h.secret) }
        }
    },
    GetSecretValueCommand: class {},
}))
vi.mock('./db', () => ({
    createRealDb: (url: string) => {
        h.urls.push(url)
        return { migrateToLatest: async () => undefined }
    },
}))

afterEach(() => {
    vi.unstubAllEnvs()
    h.urls.length = 0
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
})
