import { execFileSync } from 'node:child_process'
import { chmodSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import path from 'node:path'
import { sql } from 'kysely'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { makeTestTmpDir } from '../../testing/tmp-dir'
import type { DatabaseSsl } from './database-transport'
import { createRealDb } from './db'

/**
 * The `pg` transport's TLS against a real Postgres that FORCES it (safeinsights/sssb#96): a server of this file's own,
 * with a certificate made here for `localhost`, whose pg_hba.conf answers a TCP connection only over TLS. It is always
 * an embedded-postgres, even in CI, where the other contract suites share a service container that has no TLS.
 *
 * What it proves: `verify-full` with the server's root migrates and serves, over TLS (`pg_stat_ssl`); `disable` is
 * refused by such a server; and `verify-full` refuses a server whose certificate does not chain to the root it is given
 * (Node's own roots, or another file) or does not name the host connected to. What it cannot: Aurora's certificate
 * against the Lambda runtime's Amazon CA bundle, which only a deployment shows (the cutover row `db-tls`).
 *
 * The certificates are made with the `openssl` CLI, which CI's runners and developers' machines have; Node can parse a
 * certificate and cannot make one.
 */

const PASSWORD = 'tls-contract'
let port = 0
let dir = ''
let serverRoot = ''
let strangerRoot = ''
let server: { stop(): Promise<void> } | null = null

/** A self-signed certificate for `localhost` and its key: the server's root is its own certificate. */
function selfSigned(name: string): { cert: string; key: string } {
    const cert = path.join(dir, `${name}.crt`)
    const key = path.join(dir, `${name}.key`)
    try {
        execFileSync(
            'openssl',
            [
                'req',
                '-x509',
                '-newkey',
                'rsa:2048',
                '-nodes',
                '-days',
                '2',
                '-subj',
                '/CN=localhost',
                '-addext',
                'subjectAltName=DNS:localhost',
                '-keyout',
                key,
                '-out',
                cert,
            ],
            { stdio: 'pipe' },
        )
    } catch (error) {
        throw new Error(
            'this contract test makes its certificates with the `openssl` CLI, which failed or is missing',
            {
                cause: error,
            },
        )
    }
    chmodSync(key, 0o600) // Postgres refuses a key that others can read
    return { cert, key }
}

async function freePort(): Promise<number> {
    return new Promise((resolve, reject) => {
        const probe = createServer()
        probe.once('error', reject)
        probe.listen(0, '127.0.0.1', () => {
            const address = probe.address()
            probe.close(() =>
                typeof address === 'object' && address ? resolve(address.port) : reject(new Error('no port')),
            )
        })
    })
}

const urlTo = (host: string) => `postgres://postgres:${PASSWORD}@${host}:${port}/postgres`

/** The error a connection fails with, or null when `select 1` answers. */
async function connectError(host: string, ssl: DatabaseSsl): Promise<Error | null> {
    const db = createRealDb(urlTo(host), ssl).getDb()
    try {
        await sql`select 1`.execute(db)
        return null
    } catch (error) {
        return error as Error
    } finally {
        await db.destroy()
    }
}

beforeAll(async () => {
    dir = makeTestTmpDir('db-tls-certs-')
    const own = selfSigned('server')
    serverRoot = own.cert
    strangerRoot = selfSigned('stranger').cert
    port = await freePort()

    const { default: EmbeddedPostgres } = await import('embedded-postgres')
    const databaseDir = makeTestTmpDir('db-tls-pg-')
    const pg = new EmbeddedPostgres({
        databaseDir,
        user: 'postgres',
        password: PASSWORD,
        port,
        persistent: false,
        postgresFlags: ['-c', 'ssl=on', '-c', `ssl_cert_file=${own.cert}`, '-c', `ssl_key_file=${own.key}`],
        onLog: () => undefined,
    })
    await pg.initialise()
    // TCP over TLS only: every connection without it is refused, as a cluster with rds.force_ssl refuses it.
    writeFileSync(
        path.join(databaseDir, 'pg_hba.conf'),
        [
            'hostssl all all 127.0.0.1/32 scram-sha-256',
            'hostssl all all ::1/128 scram-sha-256',
            'hostnossl all all 0.0.0.0/0 reject',
            'hostnossl all all ::/0 reject',
            '',
        ].join('\n'),
    )
    await pg.start()
    server = pg
})

afterAll(async () => {
    await server?.stop()
})

describe('the pg transport on a server that forces TLS', () => {
    it('verify-full with the server’s root migrates and serves, over TLS', async () => {
        const real = createRealDb(urlTo('localhost'), { mode: 'verify-full', rootCert: serverRoot })
        try {
            await real.migrateToLatest()
            const { rows } = await sql<{ ssl: boolean }>`
                select ssl from pg_stat_ssl where pid = pg_backend_pid()
            `.execute(real.getDb())
            expect(rows).toEqual([{ ssl: true }])
            const tables = await sql<{ n: number }>`
                select count(*)::int as n from information_schema.tables where table_name = 'tenants'
            `.execute(real.getDb())
            expect(tables.rows).toEqual([{ n: 1 }])
        } finally {
            await real.getDb().destroy()
        }
    })

    it('disable is refused by it', async () => {
        const error = await connectError('localhost', { mode: 'disable' })
        expect(error?.message).toMatch(/no pg_hba\.conf entry|rejects connection/)
    })

    it('verify-full refuses a certificate that does not chain to the roots it trusts', async () => {
        // Node's own roots: the self-signed root is not among them, as Amazon RDS's are not.
        const withNodeRoots = await connectError('localhost', { mode: 'verify-full' })
        expect((withNodeRoots as Error & { code?: string })?.code).toMatch(/SELF_SIGNED|UNABLE_TO_(GET|VERIFY)/)
        // Another root file: what it names is the only root this connection trusts.
        const withStranger = await connectError('localhost', { mode: 'verify-full', rootCert: strangerRoot })
        expect((withStranger as Error & { code?: string })?.code).toMatch(/SELF_SIGNED|UNABLE_TO_(GET|VERIFY)/)
    })

    it('verify-full refuses a certificate that does not name the host connected to', async () => {
        // The same server and root, reached by an address the certificate does not name.
        const error = await connectError('127.0.0.1', { mode: 'verify-full', rootCert: serverRoot })
        expect((error as Error & { code?: string })?.code).toBe('ERR_TLS_CERT_ALTNAME_INVALID')
    })
})
