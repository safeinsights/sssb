import { writeFileSync } from 'node:fs'
import path from 'node:path'
import pg from 'pg'
import { describe, expect, it } from 'vitest'
import { makeTestTmpDir } from '../../testing/tmp-dir'
import { createRealDb, pgSslOptions } from './db'

/**
 * The `pg` transport's TLS, offline: what the pool is handed for each mode, and the URLs it refuses. That a server is
 * really reached over TLS, and refused when its certificate is not trusted, is ./db-tls.contract.test.ts.
 */

const VERIFY = { mode: 'verify-full' } as const

describe('pgSslOptions', () => {
    it('disable is no TLS, and verify-full checks the chain against Node’s roots or the root file alone', () => {
        expect(pgSslOptions({ mode: 'disable' })).toBe(false)
        expect(pgSslOptions(VERIFY)).toEqual({ rejectUnauthorized: true })
        expect(pgSslOptions({ mode: 'verify-full', rootCert: undefined })).toEqual({ rejectUnauthorized: true })
        const file = path.join(makeTestTmpDir('db-ssl-'), 'roots.pem')
        writeFileSync(file, '-----BEGIN CERTIFICATE-----\nroots\n-----END CERTIFICATE-----\n')
        expect(pgSslOptions({ mode: 'verify-full', rootCert: file })).toEqual({
            rejectUnauthorized: true,
            ca: '-----BEGIN CERTIFICATE-----\nroots\n-----END CERTIFICATE-----\n',
        })
    })

    it('a root file that cannot be read fails when the pool is built, naming the path', () => {
        const missing = path.join(makeTestTmpDir('db-ssl-'), 'absent.pem')
        expect(() => pgSslOptions({ mode: 'verify-full', rootCert: missing })).toThrow(
            `cannot read the database's root certificates at ${missing}`,
        )
        expect(() =>
            createRealDb('postgres://u:p@db.internal:5432/app', { mode: 'verify-full', rootCert: missing }),
        ).toThrow(missing)
    })
})

describe('createRealDb refuses a URL that sets its own TLS', () => {
    // Why it must: pg merges what it parses from the URL OVER the config it is given, so the URL's mode would win.
    it('pg lets the URL replace the ssl option (the reason for the refusal)', () => {
        const client = new pg.Client({
            connectionString: 'postgres://u:p@db.internal:5432/app?sslmode=disable',
            ssl: { rejectUnauthorized: true },
        }) as unknown as { connectionParameters: { ssl: unknown } }
        expect(client.connectionParameters.ssl).toBe(false)
    })

    it.each([
        ['sslmode', 'postgres://u:secret@db.internal:5432/app?sslmode=disable', 'sslmode'],
        ['ssl', 'postgres://u:secret@db.internal:5432/app?ssl=true', 'ssl'],
        ['no-verify', 'postgres://u:secret@db.internal:5432/app?sslmode=no-verify', 'sslmode'],
        ['sslrootcert', 'postgres://u:secret@db.internal:5432/app?sslrootcert=/tmp/x.pem', 'sslrootcert'],
        ['sslnegotiation', 'postgres://u:secret@db.internal:5432/app?sslnegotiation=direct', 'sslnegotiation'],
        ['uselibpqcompat', 'postgres://u:secret@db.internal:5432/app?uselibpqcompat=true', 'uselibpqcompat'],
        ['another case', 'postgres://u:secret@db.internal:5432/app?SSLMode=require', 'SSLMode'],
        ['an escaped name', 'postgres://u:secret@db.internal:5432/app?%73slmode=disable', 'sslmode'],
        ['no host', 'postgres://u:secret@/app?sslmode=disable', 'sslmode'],
        ['a space', 'postgres://u:sec ret@db.internal:5432/app?sslmode=disable', 'sslmode'],
        [
            'two of them',
            'postgres://u:secret@db.internal/app?application_name=x&sslmode=disable&sslcert=/c',
            'sslmode, sslcert',
        ],
    ])('%s', (_label, url, names) => {
        let message = ''
        try {
            createRealDb(url, VERIFY)
        } catch (error) {
            message = (error as Error).message
        }
        expect(message).toContain(`the database URL sets ${names};`)
        expect(message).toContain('DATABASE_SSL_MODE')
        // The message names parameters, never the URL, which holds the password.
        expect(message).not.toContain('secret')
        expect(message).not.toContain('sec ret')
    })

    it('a URL with no TLS of its own, or other parameters, builds a pool (which connects lazily)', async () => {
        for (const url of [
            'postgres://u:p@db.internal:5432/app',
            'postgres://u:p@db.internal:5432/app?application_name=sssb&options=-c%20statement_timeout%3D5000',
            '/var/run/postgresql app',
        ]) {
            for (const ssl of [VERIFY, { mode: 'disable' } as const]) {
                const db = createRealDb(url, ssl)
                await db.getDb().destroy()
            }
        }
    })
})
