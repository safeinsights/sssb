import {
    BeginTransactionCommand,
    CommitTransactionCommand,
    ExecuteStatementCommand,
    RollbackTransactionCommand,
} from '@aws-sdk/client-rds-data'
import { Kysely, sql } from 'kysely'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DatabaseUnavailableError } from '../../ports/errors'
import { RdsDataDialect, type RdsDataCommand } from './rds-data-dialect'
import { RESUME_BUDGET_MS, unavailableReason } from './rds-data-resume'

const RESUMING = 'The Aurora DB instance db-1 is resuming after being auto-paused. Please wait a few seconds and retry.'

function named(name: string, message = name, cause?: unknown): Error {
    const error = new Error(message, cause === undefined ? undefined : { cause })
    error.name = name
    return error
}
const resuming = () => named('DatabaseResumingException', RESUMING)
const throttled = () =>
    named('ThrottlingException', 'The request was throttled because of insufficient resources on the database')

type Kind = 'begin' | 'commit' | 'rollback' | 'probe' | 'statement'
interface Call {
    kind: Kind
    at: number
    sql: string | undefined
    transactionId: string | undefined
}

const PROBE = 'SELECT 1'

function kindOf(command: RdsDataCommand): Kind {
    if (command instanceof BeginTransactionCommand) return 'begin'
    if (command instanceof CommitTransactionCommand) return 'commit'
    if (command instanceof RollbackTransactionCommand) return 'rollback'
    return command.input.sql === PROBE ? 'probe' : 'statement'
}

/** A client that answers what `fail` does not throw at, and records every call with the time it was made. */
function harness(fail: (call: Call, nth: number) => Error | undefined, resumeBudgetMs?: number) {
    const started = Date.now()
    const calls: Call[] = []
    let transactions = 0
    const send = async (command: RdsDataCommand): Promise<unknown> => {
        const call: Call = {
            kind: kindOf(command),
            at: Date.now() - started,
            sql: command instanceof ExecuteStatementCommand ? command.input.sql : undefined,
            transactionId: 'transactionId' in command.input ? command.input.transactionId : undefined,
        }
        calls.push(call)
        const error = fail(call, calls.length)
        if (error) throw error
        switch (call.kind) {
            case 'begin':
                return { transactionId: `tx-${++transactions}` }
            case 'commit':
                return { transactionStatus: 'Transaction Committed' }
            default:
                return { records: [], columnMetadata: [] }
        }
    }
    const db = new Kysely<Record<string, never>>({
        dialect: new RdsDataDialect({
            client: { send },
            resourceArn: 'r',
            secretArn: 's',
            database: 'd',
            resumeBudgetMs,
        }),
    })
    const run = (text: string) => sql.raw(text).execute(db)
    const at = (kind: Kind) => calls.filter((call) => call.kind === kind).map((call) => call.at)
    const sent = (text: string) => calls.filter((call) => call.sql === text).length
    return { db, run, calls, at, sent, now: () => Date.now() - started }
}

const until = (ms: number, error: () => Error) => (call: Call) => (call.at < ms ? error() : undefined)

/** Settled, so that a rejection the test is about never goes unhandled while the timers run. */
function outcome<T>(promise: Promise<T>): Promise<{ error?: unknown; value?: T }> {
    return promise.then(
        (value) => ({ value }),
        (error: unknown) => ({ error }),
    )
}

beforeEach(() => void vi.useFakeTimers())
afterEach(() => void vi.useRealTimers())

describe('waiting out a resume', () => {
    it.each([12_200, 13_600, 7_500, 15_900])('sees a resume that ends at %i ms within a second', async (ends) => {
        const h = harness(until(ends, resuming))
        const done = outcome(h.run('select 2').then(() => h.now()))
        await vi.advanceTimersByTimeAsync(30_000)
        const { value } = await done
        expect(value).toBeGreaterThanOrEqual(ends)
        expect(value! - ends).toBeLessThanOrEqual(1000)
    })

    it('probes after 1, 2, 4 and then every 1 s, sending the statement itself twice', async () => {
        const h = harness(until(9_500, resuming))
        const done = h.run('insert into t default values')
        await vi.advanceTimersByTimeAsync(30_000)
        await done
        expect(h.at('probe')).toEqual([1000, 3000, 7000, 8000, 9000, 10_000])
        expect(h.at('statement')).toEqual([0, 10_000])
    })

    it('concurrent calls share one wait', async () => {
        const h = harness(until(8_500, resuming))
        const done = Promise.all(['select 2', 'select 3', 'select 4', 'select 5'].map((text) => h.run(text)))
        await vi.advanceTimersByTimeAsync(30_000)
        await done
        expect(h.at('probe')).toEqual([1000, 3000, 7000, 8000, 9000])
        expect(h.at('statement')).toEqual([0, 0, 0, 0, 9000, 9000, 9000, 9000])
    })

    it('a call made during the wait is not sent until it ends, and starts none of its own', async () => {
        const h = harness(until(8_500, resuming))
        const first = h.run('select 2')
        await vi.advanceTimersByTimeAsync(5000)
        const second = h.run('select 3')
        const third = h.db.transaction().execute(async (trx) => sql.raw('select 4').execute(trx))
        await vi.advanceTimersByTimeAsync(30_000)
        await Promise.all([first, second, third])
        expect(h.at('probe')).toEqual([1000, 3000, 7000, 8000, 9000])
        expect(h.sent('select 3')).toBe(1)
        expect(h.at('begin')).toEqual([9000])
    })

    it('back-to-back calls pay for one wait', async () => {
        const h = harness(until(8_500, resuming))
        const done = (async () => {
            for (const text of ['select 2', 'select 3', 'select 4']) await h.run(text)
            return h.now()
        })()
        await vi.advanceTimersByTimeAsync(30_000)
        expect(await done).toBe(9000)
        expect(h.at('statement')).toEqual([0, 9000, 9000, 9000])
    })

    it('a probe that fails for another reason ends the wait, and the call gets its own answer', async () => {
        const h = harness((call) =>
            call.kind === 'probe'
                ? named('AccessDeniedException', 'no')
                : call.at < 1000
                  ? resuming()
                  : named('DatabaseErrorException', 'ERROR: relation "t" does not exist; SQLState: 42P01'),
        )
        const done = outcome(h.run('select * from t'))
        await vi.advanceTimersByTimeAsync(30_000)
        expect((await done).error).toMatchObject({ code: '42P01' })
        expect(h.at('probe')).toEqual([1000])
    })

    it('a probe that answers while the statement still says resuming never spins', async () => {
        const h = harness((call) => (call.kind === 'probe' ? undefined : resuming()), 4500)
        const done = outcome(h.run('select 2'))
        await vi.advanceTimersByTimeAsync(30_000)
        expect((await done).error).toBeInstanceOf(DatabaseUnavailableError)
        expect(h.at('statement')).toEqual([0, 1000, 2000, 3000, 4000])
    })
})

describe('the budget', () => {
    it('ends in the typed error, with AWS’s own error as its cause', async () => {
        const h = harness(() => resuming())
        const done = outcome(h.run('select 2').catch((error: unknown) => Promise.reject({ error, at: h.now() })))
        await vi.advanceTimersByTimeAsync(60_000)
        const { error, at } = (await done).error as { error: DatabaseUnavailableError; at: number }
        expect(at).toBe(RESUME_BUDGET_MS)
        expect(error).toBeInstanceOf(DatabaseUnavailableError)
        expect(error).toMatchObject({ reason: 'resuming', retryAfterSeconds: 5 })
        expect(error.cause).toMatchObject({ name: 'DatabaseResumingException' })
    })

    it('is the caller’s to set, and 0 fails at once', async () => {
        const short = harness(() => resuming(), 2500)
        const done = outcome(short.run('select 2').finally(() => expect(short.now()).toBe(2500)))
        await vi.advanceTimersByTimeAsync(60_000)
        expect((await done).error).toBeInstanceOf(DatabaseUnavailableError)

        const none = harness(() => resuming(), 0)
        expect((await outcome(none.run('select 2'))).error).toBeInstanceOf(DatabaseUnavailableError)
        expect(none.calls).toHaveLength(1)
    })

    it('is each call’s own: one that joined late outlives the one that started the wait', async () => {
        const h = harness(until(20_500, resuming))
        const first = outcome(h.run('select 2'))
        await vi.advanceTimersByTimeAsync(10_000)
        const second = outcome(h.run('select 3'))
        await vi.advanceTimersByTimeAsync(60_000)
        expect((await first).error).toBeInstanceOf(DatabaseUnavailableError)
        expect((await second).error).toBeUndefined()
        expect(h.sent('select 3')).toBe(1)
    })

    it('a wait that failed is over: the polling stops, and the next call starts afresh', async () => {
        const h = harness(until(40_000, resuming))
        const first = outcome(h.run('select 2'))
        await vi.advanceTimersByTimeAsync(38_500)
        expect((await first).error).toBeInstanceOf(DatabaseUnavailableError)
        expect(h.calls.at(-1)!.at).toBeLessThanOrEqual(RESUME_BUDGET_MS)
        const second = h.run('select 3')
        await vi.advanceTimersByTimeAsync(30_000)
        await second
        expect(h.calls.filter((call) => call.sql === 'select 3').map((call) => call.at)).toEqual([38_500, 41_500])
    })

    it('a call whose wait is held by a probe that never answers still fails on time, and holds no later call', async () => {
        const answered: string[] = []
        let hang = true
        const send = async (command: RdsDataCommand): Promise<unknown> => {
            const text = command instanceof ExecuteStatementCommand ? command.input.sql! : ''
            if (hang && text === PROBE) return new Promise(() => {})
            if (hang) throw resuming()
            answered.push(text)
            return { records: [] }
        }
        const db = new Kysely<Record<string, never>>({
            dialect: new RdsDataDialect({ client: { send }, resourceArn: 'r', secretArn: 's', database: 'd' }),
        })
        const first = outcome(sql.raw('select 2').execute(db))
        await vi.advanceTimersByTimeAsync(RESUME_BUDGET_MS)
        expect((await first).error).toBeInstanceOf(DatabaseUnavailableError)
        hang = false
        await sql.raw('select 3').execute(db)
        expect(answered).toEqual(['select 3'])
    })
})

describe('what is sent again, and what never is', () => {
    const failOnce = (kind: Kind, error: () => Error) => {
        let failed = false
        return (call: Call) => {
            if (call.kind !== kind || failed) return undefined
            failed = true
            return error()
        }
    }

    it.each([
        ['a throttle', throttled],
        ['a resume', resuming],
        ['a BadRequestException saying so', () => named('BadRequestException', RESUMING)],
        ['a resume under another error', () => named('Error', 'wrapped', resuming())],
    ])('a BeginTransaction is sent again after %s: it runs no statement', async (_label, error) => {
        const h = harness(failOnce('begin', error))
        const done = h.db.transaction().execute(async (trx) => sql.raw('insert into t default values').execute(trx))
        await vi.advanceTimersByTimeAsync(5000)
        await done
        expect(h.at('begin')).toEqual([0, 1000])
        expect(h.sent('insert into t default values')).toBe(1)
    })

    it('a throttle during a resume is part of it', async () => {
        const h = harness((call) => (call.at < 3000 ? resuming() : call.at < 8500 ? throttled() : undefined))
        const done = h.db.transaction().execute(async (trx) => sql.raw('select 2').execute(trx))
        await vi.advanceTimersByTimeAsync(30_000)
        await done
        expect(h.at('probe')).toEqual([1000, 3000, 7000, 8000, 9000])
    })

    it.each([
        ['a throttle', throttled, 'throttled'],
        ['a statement timeout', () => named('StatementTimeoutException'), 'timed-out'],
        ['no writer', () => named('DatabaseUnavailableException'), 'unavailable'],
        ['no service', () => named('ServiceUnavailableError'), 'unavailable'],
        ['a BadRequestException saying resuming', () => named('BadRequestException', RESUMING), 'resuming'],
        ['a resume that only caused it', () => named('TimeoutError', 'late', resuming()), 'resuming'],
    ])('a statement is never sent again after %s, and the error is typed', async (_label, error, reason) => {
        const h = harness((call) => (call.kind === 'statement' ? error() : undefined))
        const done = outcome(h.run('insert into t default values'))
        await vi.advanceTimersByTimeAsync(60_000)
        expect((await done).error).toMatchObject({ name: 'DatabaseUnavailableError', reason })
        expect(h.calls).toHaveLength(1)
    })

    it('a BeginTransaction is never sent again after a timeout or any other error', async () => {
        for (const name of [
            'StatementTimeoutException',
            'DatabaseUnavailableException',
            'InternalServerErrorException',
        ]) {
            const h = harness(() => named(name))
            const done = outcome(h.db.transaction().execute(async () => {}))
            await vi.advanceTimersByTimeAsync(60_000)
            expect((await done).error).toBeInstanceOf(Error)
            expect(h.calls).toHaveLength(1)
        }
    })

    it.each(['InternalServerErrorException', 'AccessDeniedException', 'TransactionNotFoundException', 'TimeoutError'])(
        '%s is never retried, and stays itself',
        async (name) => {
            const h = harness(() => named(name))
            const done = outcome(h.run('select 2'))
            await vi.advanceTimersByTimeAsync(60_000)
            expect((await done).error).toMatchObject({ name })
            expect(h.calls).toHaveLength(1)
        },
    )

    it('a SQL error whose text mentions a resume is still a SQL error', async () => {
        const message =
            'ERROR: duplicate key value violates unique constraint "k" Detail: Key (a)=(db is resuming) exists.'
        for (const name of ['DatabaseErrorException', 'BadRequestException']) {
            const h = harness(() => named(name, message, resuming()))
            const { error } = await outcome(h.run('insert into t default values'))
            expect(error).toMatchObject({ name: 'RdsDataDatabaseError', code: '23505' })
            expect(h.calls).toHaveLength(1)
        }
    })

    it('the first statement of a transaction is sent again after a resume, once', async () => {
        const h = harness(failOnce('statement', resuming))
        const done = h.db.transaction().execute(async (trx) => sql.raw('insert into t default values').execute(trx))
        await vi.advanceTimersByTimeAsync(5000)
        await done
        expect(h.sent('insert into t default values')).toBe(2)
        expect(h.at('commit')).toEqual([1000])
    })

    it('a later one is not: the pause ended the transaction, and the whole of it fails', async () => {
        const h = harness((call) => (call.sql === 'update t set a = 1' ? resuming() : undefined))
        const done = outcome(
            h.db.transaction().execute(async (trx) => {
                await sql.raw('insert into t default values').execute(trx)
                await sql.raw('update t set a = 1').execute(trx)
            }),
        )
        await vi.advanceTimersByTimeAsync(60_000)
        expect((await done).error).toMatchObject({ name: 'DatabaseUnavailableError', reason: 'resuming' })
        expect(h.sent('update t set a = 1')).toBe(1)
        expect(h.at('commit')).toEqual([])
        expect(h.at('rollback')).toHaveLength(1)
    })

    it.each([
        ['a resume', resuming],
        ['a throttle', throttled],
    ])('a commit is never sent again after %s', async (_label, error) => {
        const h = harness((call) => (call.kind === 'commit' ? error() : undefined))
        const done = outcome(h.db.transaction().execute(async (trx) => sql.raw('select 2').execute(trx)))
        await vi.advanceTimersByTimeAsync(60_000)
        expect((await done).error).toBeInstanceOf(DatabaseUnavailableError)
        expect(h.at('commit')).toHaveLength(1)
    })

    it('a call in an open transaction does not wait for another call’s resume', async () => {
        const h = harness((call) => (call.sql === 'select 9' || call.kind === 'probe' ? resuming() : undefined))
        const done = h.db.transaction().execute(async (trx) => {
            await sql.raw('select 2').execute(trx)
            void outcome(h.run('select 9'))
            await vi.advanceTimersByTimeAsync(500)
            await sql.raw('select 3').execute(trx)
            return h.now()
        })
        expect(await done).toBe(500)
        expect(h.at('commit')).toEqual([500])
        await vi.advanceTimersByTimeAsync(60_000)
    })
})

describe('reading the reason', () => {
    it('looks through the cause chain, and stops on a cycle', () => {
        const loop = named('Error')
        loop.cause = loop
        expect(unavailableReason(loop)).toBeUndefined()
        const wrapped = named('RdsDataDatabaseError', 'x', named('BadRequestException', RESUMING))
        expect(unavailableReason(named('Error', 'outer', wrapped))).toBe('resuming')
        expect(unavailableReason('DatabaseResumingException')).toBeUndefined()
        expect(unavailableReason(named('constructor'))).toBeUndefined()
    })
})
