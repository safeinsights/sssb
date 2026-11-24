import { randomUUID } from 'node:crypto'
import {
    BeginTransactionCommand,
    CommitTransactionCommand,
    ExecuteStatementCommand,
    RollbackTransactionCommand,
    type BeginTransactionCommandOutput,
    type CommitTransactionCommandOutput,
    type ExecuteStatementCommandOutput,
} from '@aws-sdk/client-rds-data'
import {
    AbortedTransactionError,
    CompiledQuery,
    PostgresAdapter,
    sql,
    PostgresIntrospector,
    PostgresQueryCompiler,
    type DatabaseConnection,
    type ColumnMetadata,
    type DatabaseIntrospector,
    type DatabaseMetadataOptions,
    type Dialect,
    type Driver,
    type Kysely,
    type QueryResult,
    type SchemaMetadata,
    type TableMetadata,
    type TransactionSettings,
} from 'kysely'
import { DEFAULT_MIGRATION_LOCK_TABLE, DEFAULT_MIGRATION_TABLE } from 'kysely/migration'
import {
    castPlaceholder,
    commitOutcome,
    decodeRow,
    describableSql,
    leadingKeyword,
    normalizeDatabaseError,
    RdsDataUnsupportedError,
    rewritePlaceholders,
    toSqlParameter,
    unsupportedStatement,
} from './rds-data-codec'
import { DatabaseUnavailableError } from '../../ports/errors'
import { RESUME_BUDGET_MS, ResumeWait, unavailable, unavailableReason, wasCancelledUnrun } from './rds-data-resume'

/** The four calls this dialect makes. `RDSDataClient` satisfies it, and so does the test emulator. */
export type RdsDataCommand =
    BeginTransactionCommand | CommitTransactionCommand | RollbackTransactionCommand | ExecuteStatementCommand

export interface RdsDataClientLike {
    send(command: RdsDataCommand): Promise<unknown>
    destroy?(): void
}

export interface RdsDataDialectConfig {
    client: RdsDataClientLike
    /** The Aurora cluster's ARN (the Data API must be enabled on it). */
    resourceArn: string
    /** The Secrets Manager secret holding the database user's credentials. */
    secretArn: string
    database: string
    /** How long a SQL shape's inferred parameter types are trusted; `TYPE_CACHE_TTL_MS` when omitted. */
    typeCacheTtlMs?: number | undefined
    /**
     * How long one call waits for a paused cluster to resume, in milliseconds, counted from its first refusal or its
     * first wait; `RESUME_BUDGET_MS` when omitted, and 0 to fail at once. It bounds the wait, not the calls themselves.
     */
    resumeBudgetMs?: number | undefined
}

/**
 * Kysely over the Amazon RDS Data API: Postgres's adapter, compiler and introspector, with a driver that
 * speaks HTTPS to the Data API instead of the wire protocol to a socket. ADR-0002's addendum of
 * 2026-11-16 records why it exists (a Lambda outside any VPC, with no NAT, reaching Aurora) and why it is
 * written here rather than taken from the community `kysely-data-api`.
 *
 * A "connection" is a handle with an optional transaction id; there is no socket and nothing to pool.
 * Statements outside a transaction are independent HTTPS calls, each autocommitted, and the Data API
 * resets the session (`DISCARD ALL`) between them — so session state exists only inside a transaction,
 * which is the one place SSSB ever sets it (`runWithTenant`'s one statement setting `role` and
 * `app.current_tenant`, both with `set_config(…, true)`). What it cannot do fails loudly: streaming
 * (`RdsDataConnection.streamQuery` below), and (./rds-data-codec.ts, `unsupportedStatement`) transaction
 * control in SQL and session state outside a transaction (session-level advisory locks included — which is
 * why the migrator runs in one transaction, ./db-data-api.ts).
 *
 * AUTHORED — CUTOVER (`data-api`): proven against real Postgres through a strict emulator
 * (./rds-data-emulator.ts, `pnpm test:contract`); never run against the Data API itself.
 */
export class RdsDataDialect implements Dialect {
    private readonly config: RdsDataDialectConfig

    constructor(config: RdsDataDialectConfig) {
        this.config = config
    }

    createAdapter() {
        return new RdsDataPostgresAdapter()
    }
    createDriver(): Driver {
        return new RdsDataDriver(this.config)
    }
    createQueryCompiler() {
        return new PostgresQueryCompiler()
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- kysely's Dialect interface signature
    createIntrospector(db: Kysely<any>) {
        return new RdsDataIntrospector(db)
    }
}

/**
 * Kysely's Postgres introspector, with the one column the Data API cannot return cast to text. Kysely's `getTables`
 * selects `pg_class.relkind`, a one-byte `"char"`, which the Data API refuses whole ("The result contains the
 * unsupported data type "CHAR"", ./rds-data-emulator.ts's `REFUSED_RESULT_TYPES`), and its Migrator calls it before
 * anything else, to see whether its own tables exist. So this is Kysely 0.29's query and its reading of the rows, with
 * `relkind::text` for `relkind`; `getSchemas` reads only `nspname`, a `name`, and is Kysely's own. The contract suite
 * (./rds-data.contract.test.ts) holds it to Kysely's introspector on the same database, so an upgrade of Kysely that
 * changes what `getTables` returns fails there.
 */
export class RdsDataIntrospector implements DatabaseIntrospector {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- kysely's Dialect interface signature
    readonly #db: Kysely<any>
    readonly #postgres: PostgresIntrospector

    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- kysely's Dialect interface signature
    constructor(db: Kysely<any>) {
        this.#db = db
        this.#postgres = new PostgresIntrospector(db)
    }

    getSchemas(): Promise<SchemaMetadata[]> {
        return this.#postgres.getSchemas()
    }

    async getTables(options: DatabaseMetadataOptions = { withInternalKyselyTables: false }): Promise<TableMetadata[]> {
        let query = this.#db
            .selectFrom('pg_catalog.pg_attribute as a')
            .innerJoin('pg_catalog.pg_class as c', 'a.attrelid', 'c.oid')
            .innerJoin('pg_catalog.pg_namespace as ns', 'c.relnamespace', 'ns.oid')
            .innerJoin('pg_catalog.pg_type as typ', 'a.atttypid', 'typ.oid')
            .innerJoin('pg_catalog.pg_namespace as dtns', 'typ.typnamespace', 'dtns.oid')
            .select([
                'a.attname as column',
                'a.attnotnull as not_null',
                'a.atthasdef as has_default',
                'c.relname as table',
                sql<string>`c.relkind::text`.as('table_type'),
                'ns.nspname as schema',
                'typ.typname as type',
                'dtns.nspname as type_schema',
                sql<string | null>`col_description(a.attrelid, a.attnum)`.as('column_description'),
                sql<
                    string | null
                >`pg_get_serial_sequence(quote_ident(ns.nspname) || '.' || quote_ident(c.relname), a.attname)`.as(
                    'auto_incrementing',
                ),
            ])
            .where('c.relkind', 'in', ['r', 'v', 'p', 'f'])
            .where('ns.nspname', '!~', '^pg_')
            .where('ns.nspname', '!=', 'information_schema')
            .where('ns.nspname', '!=', 'crdb_internal')
            .where(sql<boolean>`has_schema_privilege(ns.nspname, 'USAGE')`)
            .where('a.attnum', '>=', 0)
            .where('a.attisdropped', '!=', true)
            .orderBy('ns.nspname')
            .orderBy('c.relname')
            .orderBy('a.attnum')
            .$castTo<IntrospectedColumn>()
        if (!options.withInternalKyselyTables) {
            query = query
                .where('c.relname', '!=', DEFAULT_MIGRATION_TABLE)
                .where('c.relname', '!=', DEFAULT_MIGRATION_LOCK_TABLE)
        }
        const tables: TableMetadata[] = []
        const bySchema = new Map<string, Map<string, TableMetadata>>()
        for (const column of await query.execute()) {
            let schema = bySchema.get(column.schema)
            if (!schema) bySchema.set(column.schema, (schema = new Map()))
            let table = schema.get(column.table)
            if (!table) {
                table = Object.freeze({
                    columns: [],
                    isForeign: column.table_type === 'f',
                    isView: column.table_type === 'v',
                    name: column.table,
                    schema: column.schema,
                })
                schema.set(column.table, table)
                tables.push(table)
            }
            table.columns.push(
                // `comment` present and undefined on an uncommented column, as Kysely's is: the cast is
                // exactOptionalPropertyTypes', which Kysely's own type does not satisfy either.
                Object.freeze({
                    comment: column.column_description ?? undefined,
                    dataType: column.type,
                    dataTypeSchema: column.type_schema,
                    hasDefaultValue: column.has_default,
                    isAutoIncrementing: column.auto_incrementing !== null,
                    isNullable: !column.not_null,
                    name: column.column,
                } as ColumnMetadata),
            )
        }
        return tables
    }
}

interface IntrospectedColumn {
    column: string
    not_null: boolean
    has_default: boolean
    table: string
    table_type: string
    schema: string
    type: string
    type_schema: string
    column_description: string | null
    auto_incrementing: string | null
}

/** Kysely's own Postgres migration-lock id, so a `pg` migrator and a Data API one exclude each other. */
const MIGRATION_LOCK_ID = '3853314791062309107'

/**
 * Postgres's adapter with a TRANSACTION-scoped migration lock. Kysely's takes a session-level
 * `pg_advisory_lock` on `db.connection()`, outside the migration transaction — which on the Data API is a
 * separate autocommitted call whose lock the connection reset (`DISCARD ALL`) drops at once, so two
 * migrators would not exclude each other at all. Here the lock is `pg_advisory_xact_lock`, taken inside
 * the one transaction the migrations run in (./db-data-api.ts hands the Migrator a Transaction), and
 * released by its commit or rollback, so there is nothing to release by hand — and no unlock statement to
 * fail in an aborted transaction and replace the migration's own error.
 */
class RdsDataPostgresAdapter extends PostgresAdapter {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- kysely's DialectAdapter signature
    override async acquireMigrationLock(db: Kysely<any>): Promise<void> {
        // Outside a transaction a transaction-scoped lock autocommits and is gone at once, so a Migrator
        // handed the plain db (an adopter's own migrate-down script, say) would run unlocked. Refuse it.
        if (!db.isTransaction) {
            throw new RdsDataUnsupportedError(
                'run the Migrator inside one transaction on the Data API (the db port’s migrateToLatest does), or its lock is released at once',
            )
        }
        await lockMigrations(db)
    }

    override async releaseMigrationLock(): Promise<void> {}
}

/**
 * Takes the migration lock for the rest of the current transaction. ./db-data-api.ts calls it as the
 * migration transaction's FIRST statement, because Kysely creates its own bookkeeping tables before it
 * asks the adapter for the lock — and two migrators doing that inside two open transactions collide on
 * the catalog, which aborts the loser's transaction (Kysely's tolerance for that race assumes autocommit).
 * Advisory locks stack within a transaction, so the adapter taking it again is harmless.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- any Kysely or Transaction will do
export async function lockMigrations(db: Kysely<any>): Promise<void> {
    await sql`select pg_advisory_xact_lock(${sql.raw(MIGRATION_LOCK_ID)})`.execute(db)
}

/** How many SQL texts' parameter types are remembered before the cache starts over. */
const TYPE_CACHE_LIMIT = 2000

/**
 * How long a SQL shape's inferred types are trusted: five minutes. A cached type outlives a schema change
 * SILENTLY — a `date` column changed to `timestamptz` goes on receiving midnight through a warm cache,
 * where node-postgres stores the instant (ADR-0002's addendum of 2026-11-16 states the limit) — so the
 * cache must forget. Five minutes bounds that window to about the time a deploy's migration takes to
 * settle, and costs one describe per shape per five minutes per warm process (three extra calls inside a
 * transaction, five outside): for three hundred shapes all in use, one describe a second. Shorter buys
 * little and spends round trips on every request; longer leaves an out-of-band migration's mismatch live.
 */
const TYPE_CACHE_TTL_MS = 5 * 60 * 1000

class RdsDataDriver implements Driver {
    readonly #types = new Map<string, { readonly types: readonly string[]; readonly at: number }>()

    /** Transactions in which a statement has run, so their sessions have existed. */
    readonly #usedTransactions = new Set<string>()
    readonly #resume: ResumeWait

    private readonly config: RdsDataDialectConfig

    constructor(config: RdsDataDialectConfig) {
        this.config = config
        const { client, resourceArn, secretArn, database } = config
        this.#resume = new ResumeWait(() =>
            client.send(new ExecuteStatementCommand({ resourceArn, secretArn, database, sql: 'SELECT 1' })),
        )
    }

    async init(): Promise<void> {}

    async acquireConnection(): Promise<DatabaseConnection> {
        return new RdsDataConnection(this)
    }

    async releaseConnection(): Promise<void> {}

    async beginTransaction(connection: DatabaseConnection, settings: TransactionSettings): Promise<void> {
        const conn = asConnection(connection)
        if (conn.transactionId) throw new RdsDataUnsupportedError('a transaction is already open on this connection')
        const { resourceArn, secretArn, database } = this.config
        const begun = (await this.call(
            new BeginTransactionCommand({ resourceArn, secretArn, database }),
        )) as BeginTransactionCommandOutput
        if (!begun.transactionId) throw new Error('RDS Data API: BeginTransaction returned no transaction id')
        conn.transactionId = begun.transactionId
        conn.failed = false
        // BeginTransaction takes no isolation level or access mode; Postgres accepts them as the
        // transaction's first statement instead. If that fails, Kysely never learns the transaction began
        // and will not roll it back — so this does, rather than strand it for the three idle minutes.
        const modes = [
            settings.isolationLevel ? `isolation level ${settings.isolationLevel}` : '',
            settings.accessMode ?? '',
        ].filter(Boolean)
        if (modes.length > 0) {
            try {
                await conn.executeQuery(CompiledQuery.raw(`set transaction ${modes.join(' ')}`))
            } catch (error) {
                await this.rollbackTransaction(conn).catch(() => undefined)
                throw error
            }
        }
    }

    /**
     * A commit can fail — a deferred constraint, a serialization failure, a transaction the Data API
     * already timed out — and Kysely then calls rollbackTransaction. Whatever that call does must not
     * replace the commit's own error, whose `code` callers act on. Two defences, either one sufficient:
     * the id is cleared only after a successful commit (so the rollback finds the transaction, and a
     * "gone" answer is swallowed), and a rollback with no id is a no-op. The contract suite's deferred-
     * constraint case goes red only when both are undone as the bug they replaced had it: the id cleared
     * before the commit, AND a rollback with no id that throws. Merely deleting the no-op leaves it green,
     * because the emulator answers a rollback with no id as TransactionNotFoundException, which is swallowed.
     */
    async commitTransaction(connection: DatabaseConnection): Promise<void> {
        const conn = asConnection(connection)
        const transactionId = conn.transactionId
        if (!transactionId) throw new Error('RDS Data API: no transaction is open on this connection')
        // A statement failed and the caller carried on (it caught the error). Postgres has aborted the
        // transaction, and a COMMIT would quietly roll it back — node-postgres sees that as a ROLLBACK tag
        // and Kysely's pg driver throws. The Data API's answer to such a commit is unknown, so this does not
        // ask it: it rolls back and throws the same error the pg driver does.
        if (conn.failed) {
            await this.rollbackTransaction(conn)
            throw new AbortedTransactionError()
        }
        const { resourceArn, secretArn } = this.config
        const answer = (await this.call(
            new CommitTransactionCommand({ resourceArn, secretArn, transactionId }),
        )) as CommitTransactionCommandOutput
        conn.transactionId = undefined
        // The call returning is not the transaction committing: the answer says which it did. Either way the
        // transaction is over, so the id is cleared first and Kysely's follow-up rollback is a no-op.
        const outcome = commitOutcome(answer.transactionStatus)
        if (outcome === 'rolled back') throw new AbortedTransactionError()
        if (outcome === 'unknown') {
            throw new Error(
                `RDS Data API: CommitTransaction answered ${JSON.stringify(answer.transactionStatus)}, not "Transaction Committed" — the transaction's writes may not be saved`,
            )
        }
    }

    async rollbackTransaction(connection: DatabaseConnection): Promise<void> {
        const conn = asConnection(connection)
        const transactionId = conn.transactionId
        if (!transactionId) return
        conn.transactionId = undefined
        const { resourceArn, secretArn } = this.config
        try {
            await this.call(new RollbackTransactionCommand({ resourceArn, secretArn, transactionId }))
        } catch (error) {
            // Already gone means already rolled back: the Data API rolls a transaction back itself when it
            // idles for three minutes or reaches an hour, and a failed commit ends it too. Rethrowing would
            // only replace the error that made Kysely roll back with one that says nothing about it. A cluster that
            // answers that it is resuming was paused, and a paused one has no open transaction.
            if (isTransactionGone(error)) return
            if (error instanceof DatabaseUnavailableError && error.reason === 'resuming') return
            throw error
        }
    }

    async savepoint(connection: DatabaseConnection, name: string): Promise<void> {
        await connection.executeQuery(CompiledQuery.raw(`savepoint ${quoteIdent(name)}`))
    }

    async rollbackToSavepoint(connection: DatabaseConnection, name: string): Promise<void> {
        await connection.executeQuery(CompiledQuery.raw(`rollback to savepoint ${quoteIdent(name)}`))
        // Rolling back to a savepoint is how Postgres recovers an aborted transaction.
        asConnection(connection).failed = false
    }

    async releaseSavepoint(connection: DatabaseConnection, name: string): Promise<void> {
        await connection.executeQuery(CompiledQuery.raw(`release savepoint ${quoteIdent(name)}`))
    }

    async destroy(): Promise<void> {
        this.config.client.destroy?.()
    }

    async execute(compiled: CompiledQuery, transactionId: string | undefined): Promise<QueryResult<unknown>> {
        const problem = unsupportedStatement(compiled.sql, transactionId !== undefined)
        if (problem) throw new RdsDataUnsupportedError(problem)

        let sql = compiled.sql
        let parameters: ReturnType<typeof toSqlParameter>[] | undefined
        if (compiled.parameters.length > 0) {
            const types = await this.parameterTypes(compiled.sql, transactionId)
            if (types.length !== compiled.parameters.length) {
                throw new Error(
                    `RDS Data API: Postgres reports ${types.length} parameters for a statement sent ${compiled.parameters.length}`,
                )
            }
            sql = rewritePlaceholders(compiled.sql, (n) => castPlaceholder(n, types[n - 1]))
            parameters = compiled.parameters.map((value, i) => toSqlParameter(i + 1, value))
        }

        const out = await this.statement(sql, transactionId, parameters)
        const columns = out.columnMetadata ?? []
        const rows = (out.records ?? []).map((record) => decodeRow(record, columns))
        const keyword = leadingKeyword(compiled.sql)
        const updated = out.numberOfRecordsUpdated
        const isDml = keyword === 'insert' || keyword === 'update' || keyword === 'delete' || keyword === 'merge'
        return {
            rows,
            ...(isDml || (keyword === 'with' && updated !== undefined && updated > 0)
                ? { numAffectedRows: BigInt(updated ?? 0) }
                : {}),
        }
    }

    /**
     * The types Postgres infers for `sql`'s `$n` placeholders — the same inference node-postgres relies
     * on — read back from `pg_prepared_statements` after a PREPARE, and cached by SQL text (Kysely
     * compiles one text per query shape, so a warm process asks once per shape) for `TYPE_CACHE_TTL_MS`.
     *
     * Inside a transaction it asks there, so a table the transaction has just created is visible to the
     * PREPARE; a PREPARE that fails has found the same error the statement would have, and aborts the
     * transaction exactly as the statement would. Outside one it opens a short transaction of its own,
     * because PREPARE and the read of `pg_prepared_statements` must share a connection.
     */
    private async parameterTypes(sql: string, transactionId: string | undefined): Promise<readonly string[]> {
        const cached = this.#types.get(sql)
        const ttl = this.config.typeCacheTtlMs ?? TYPE_CACHE_TTL_MS
        if (cached && Date.now() - cached.at < ttl) return cached.types

        const name = `sssb_describe_${randomUUID().replace(/-/g, '')}`
        const describe = async (txId: string): Promise<readonly string[]> => {
            await this.statement(`PREPARE ${name} AS ${describableSql(sql)}`, txId)
            // format_type(t, -1), not t::text: regtype prints `character` and `bit`, which a CAST reads as
            // char(1) and bit(1). And a domain is walked down to its base type first: an explicit cast to a
            // domain over char(3) or varchar(3) truncates, where node-postgres's input path errors on the
            // same value. Cast to the length-free base, and storing the value in a column (or passing it to
            // a function) checks length and constraints as it does for node-postgres. An explicit
            // `::domain` cast written in the SQL still truncates: an accepted limit (ADR-0002's addendum).
            const out = await this.statement(
                `WITH RECURSIVE params AS (
                    SELECT u.i, u.t::oid AS oid FROM pg_prepared_statements p,
                        unnest(p.parameter_types) WITH ORDINALITY AS u(t, i) WHERE p.name = '${name}'
                ), walk AS (
                    SELECT i, oid FROM params
                    UNION ALL
                    SELECT w.i, ty.typbasetype FROM walk w JOIN pg_type ty ON ty.oid = w.oid WHERE ty.typtype = 'd'
                )
                SELECT array(
                    SELECT format_type(w.oid, -1) FROM walk w JOIN pg_type ty ON ty.oid = w.oid
                    WHERE ty.typtype <> 'd' ORDER BY w.i
                ) AS types`,
                txId,
            )
            await this.statement(`DEALLOCATE ${name}`, txId)
            const types = out.records?.[0]?.[0]?.arrayValue?.stringValues
            if (!types || types.some((type) => type === null)) {
                throw new Error('RDS Data API: could not read the parameter types Postgres inferred')
            }
            return types as string[]
        }

        let types: readonly string[]
        if (transactionId) {
            types = await describe(transactionId)
        } else {
            const { resourceArn, secretArn, database } = this.config
            const begun = (await this.call(
                new BeginTransactionCommand({ resourceArn, secretArn, database }),
            )) as BeginTransactionCommandOutput
            const txId = begun.transactionId!
            try {
                types = await describe(txId)
            } finally {
                await this.call(new RollbackTransactionCommand({ resourceArn, secretArn, transactionId: txId })).catch(
                    () => undefined,
                )
            }
        }

        if (this.#types.size >= TYPE_CACHE_LIMIT) this.#types.clear()
        this.#types.set(sql, { types, at: Date.now() })
        return types
    }

    private async statement(
        sql: string,
        transactionId: string | undefined,
        parameters?: ReturnType<typeof toSqlParameter>[],
    ): Promise<ExecuteStatementCommandOutput> {
        const { resourceArn, secretArn, database } = this.config
        return (await this.call(
            new ExecuteStatementCommand({
                resourceArn,
                secretArn,
                database,
                sql,
                parameters,
                transactionId,
                includeResultMetadata: true,
                // int8 and numeric come back as strings, as node-postgres returns them, instead of a JS
                // number that silently loses precision past 2^53.
                resultSetOptions: { decimalReturnType: 'STRING', longReturnType: 'STRING' },
            }),
        )) as ExecuteStatementCommandOutput
    }

    /**
     * Sends a command, waiting out a cluster that is resuming (SSSB's non-production stack pauses: min capacity 0). A
     * call that has not been sent yet waits first if a resume is under way. Nothing else is retried, here or in the SDK
     * (`maxAttempts: 1` in ./db-data-api.ts): AWS warns that a retried statement whose first attempt actually finished
     * can write twice.
     */
    private async call(command: RdsDataCommand): Promise<unknown> {
        let deadline: number | undefined
        const wait = (error?: unknown): Promise<void> => {
            deadline ??= Date.now() + (this.config.resumeBudgetMs ?? RESUME_BUDGET_MS)
            return this.#resume.join(deadline, error)
        }
        const opensWork = transactionIdOf(command) === undefined
        for (;;) {
            while (opensWork && this.#resume.resuming) await wait()
            try {
                return await this.send(command)
            } catch (error) {
                if (this.mayResend(command, error)) {
                    await wait(error)
                    continue
                }
                const reason = unavailableReason(error)
                throw reason ? unavailable(reason, error) : normalizeDatabaseError(error)
            }
        }
    }

    private async send(command: RdsDataCommand): Promise<unknown> {
        const transactionId = transactionIdOf(command)
        const runsStatement = command instanceof ExecuteStatementCommand
        try {
            const answer = await this.config.client.send(command)
            if (transactionId && runsStatement) this.#usedTransactions.add(transactionId)
            return answer
        } finally {
            if (transactionId && !runsStatement) this.#usedTransactions.delete(transactionId)
        }
    }

    /**
     * Whether sending `command` again can't repeat anything.
     *
     * - A BeginTransaction runs no statement: at worst the failed attempt left an empty transaction, which the Data API
     *   rolls back after three idle minutes. So it is sent again after any answer that the database is resuming, and
     *   after a throttle, which has been seen while a cluster resumes.
     * - A statement only after `DatabaseResumingException` itself, which AWS documents as cancelled. AWS's Data API
     *   pages do not say that a throttled statement did not run, so a throttled one is not sent again.
     * - In a transaction, only until a statement has succeeded in it. After that the session existed, and a pause has
     *   ended it and the work in it: there is no transaction left to go on with.
     * - A commit or a rollback, never.
     */
    private mayResend(command: RdsDataCommand, error: unknown): boolean {
        if (command instanceof BeginTransactionCommand) {
            const reason = unavailableReason(error)
            return reason === 'resuming' || reason === 'throttled'
        }
        if (!(command instanceof ExecuteStatementCommand) || !wasCancelledUnrun(error)) return false
        const { transactionId } = command.input
        return transactionId === undefined || !this.#usedTransactions.has(transactionId)
    }
}

class RdsDataConnection implements DatabaseConnection {
    transactionId: string | undefined
    /**
     * A statement in the open transaction failed, so Postgres has likely aborted it (see commitTransaction).
     * Not set for a refusal made before any call, nor for the Data API's own request validation, neither of
     * which reaches the database. That validation error is recognised by the name `ValidationException`,
     * which the emulator uses and the SDK does not model; step 4 of docs/runbooks/data-api.md records the
     * name AWS actually sends. Cleared by a successful `ROLLBACK TO SAVEPOINT`, Postgres's way back.
     */
    failed = false

    private readonly driver: RdsDataDriver

    constructor(driver: RdsDataDriver) {
        this.driver = driver
    }

    async executeQuery<R>(compiledQuery: CompiledQuery): Promise<QueryResult<R>> {
        let result: QueryResult<unknown>
        try {
            result = await this.driver.execute(compiledQuery, this.transactionId)
        } catch (error) {
            const neverReachedDatabase =
                error instanceof RdsDataUnsupportedError ||
                (error instanceof Error && error.name === 'ValidationException')
            if (this.transactionId && !neverReachedDatabase) this.failed = true
            throw error
        }
        // Inside a transaction only `ROLLBACK TO SAVEPOINT` gets past unsupportedStatement with this keyword,
        // and when it succeeds the transaction is usable again — whether Kysely's savepoint API sent it or
        // raw SQL did (inside db.transaction() and withTenant, raw SQL is the only way to send it).
        if (this.transactionId && leadingKeyword(compiledQuery.sql) === 'rollback') this.failed = false
        return result as QueryResult<R>
    }

    // eslint-disable-next-line require-yield -- an async generator that refuses before its first chunk
    async *streamQuery(): AsyncIterableIterator<never> {
        throw new RdsDataUnsupportedError('the Data API returns whole result sets (at most 1 MiB); it cannot stream')
    }
}

function asConnection(connection: DatabaseConnection): RdsDataConnection {
    if (!(connection instanceof RdsDataConnection)) throw new Error('not an RDS Data API connection')
    return connection
}

/** TransactionNotFoundException by name, or by the message older Data API versions sent in a BadRequest. */
function isTransactionGone(error: unknown): boolean {
    if (!(error instanceof Error)) return false
    return error.name === 'TransactionNotFoundException' || /transaction\b.*\bnot found/i.test(error.message)
}

function transactionIdOf(command: RdsDataCommand): string | undefined {
    return 'transactionId' in command.input ? command.input.transactionId : undefined
}

function quoteIdent(name: string): string {
    return `"${name.replace(/"/g, '""')}"`
}
