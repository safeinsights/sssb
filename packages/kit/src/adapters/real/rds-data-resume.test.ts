import {
    BeginTransactionCommand,
    CommitTransactionCommand,
    ExecuteStatementCommand,
    RollbackTransactionCommand,
} from '@aws-sdk/client-rds-data'
import { Kysely, sql } from 'kysely'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { runWithTenant } from '../../db/with-tenant'
import type { DB } from '../../db/schema'
import { DatabaseUnavailableError, ForbiddenError } from '../../ports/errors'
import { RdsDataDialect, type RdsDataCommand } from './rds-data-dialect'
import { PROBE_ABORT_MS, RESUME_BUDGET_MS, unavailableReason } from './rds-data-resume'

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

type Send = (command: RdsDataCommand, options?: { abortSignal?: AbortSignal }) => Promise<unknown>

function database(send: Send, resumeBudgetMs?: number) {
    const dialect = new RdsDataDialect({
        client: { send },
        resourceArn: 'r',
        secretArn: 's',
        database: 'd',
        resumeBudgetMs,
    })
    return new Kysely<Record<string, never>>({ dialect })
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
                // The dialect's read of a statement's parameter types (one, for the tenant scope's `set_config`).
                if (call.sql?.includes('format_type(w.oid')) {
                    return { records: [[{ arrayValue: { stringValues: ['text'] } }]], columnMetadata: [] }
                }
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
        await vi.advanceTimersByTimeAsync(9000)
        expect((await first).error).toBeInstanceOf(DatabaseUnavailableError)
        // The first has given up; the wait goes on for the second, and a third still joins it.
        const third = outcome(h.run('select 4'))
        await vi.advanceTimersByTimeAsync(60_000)
        expect((await second).error).toBeUndefined()
        expect((await third).error).toBeUndefined()
        expect([h.sent('select 3'), h.sent('select 4')]).toEqual([1, 1])
        const probes = h.at('probe')
        expect(new Set(probes).size).toBe(probes.length)
        expect(probes.at(-1)).toBe(21_000)
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

    it('fails at the last answer’s reason, not the first', async () => {
        const h = harness((call) => (call.at < 4000 ? resuming() : throttled()))
        const done = outcome(h.run('select 2'))
        await vi.advanceTimersByTimeAsync(60_000)
        expect((await done).error).toMatchObject({ reason: 'throttled', cause: { name: 'ThrottlingException' } })
    })

    it('leaves no timer behind after a wait that ended well', async () => {
        const h = harness(until(2500, resuming))
        const done = h.run('select 2')
        await vi.advanceTimersByTimeAsync(3000)
        await done
        expect(vi.getTimerCount()).toBe(0)
    })

    it('a call made just after everyone left a wait is sent at once', async () => {
        const h = harness(until(1500, resuming), 1500)
        const first = outcome(h.run('select 2'))
        await vi.advanceTimersByTimeAsync(1500)
        expect((await first).error).toBeInstanceOf(DatabaseUnavailableError)
        await h.run('select 3')
        expect(h.now()).toBe(1500)
    })

    it('the poll of a wait everyone left does not end the next one', async () => {
        let answer = (): void => {}
        let probes = 0
        const send = (command: RdsDataCommand): Promise<unknown> => {
            if (kindOf(command) !== 'probe') return Promise.reject(resuming())
            probes += 1
            return probes === 1 ? new Promise((resolve) => (answer = () => resolve({}))) : Promise.reject(resuming())
        }
        const db = database(send, 1500)
        const first = outcome(sql.raw('select 2').execute(db))
        await vi.advanceTimersByTimeAsync(1500)
        expect((await first).error).toBeInstanceOf(DatabaseUnavailableError)
        const second = outcome(sql.raw('select 3').execute(db))
        await vi.advanceTimersByTimeAsync(500)
        answer()
        await vi.advanceTimersByTimeAsync(100)
        // Still the second's wait: a third joins it rather than starting another, so both see one probe.
        const third = outcome(sql.raw('select 4').execute(db))
        await vi.advanceTimersByTimeAsync(1400)
        expect(probes).toBe(2)
        await vi.advanceTimersByTimeAsync(5000)
        expect((await second).error).toBeInstanceOf(DatabaseUnavailableError)
        expect((await third).error).toBeInstanceOf(DatabaseUnavailableError)
    })
})

describe('a probe that does not answer', () => {
    it('holds up the next for two seconds, and no call after that, however many overlap', async () => {
        let probes = 0
        const t0 = Date.now()
        const send = (command: RdsDataCommand): Promise<unknown> => {
            if (kindOf(command) === 'probe' && ++probes === 1) return new Promise(() => {})
            return Date.now() - t0 < 2000 ? Promise.reject(resuming()) : Promise.resolve({ records: [] })
        }
        const db = database(send)
        const took: number[] = []
        const run = async (): Promise<void> => {
            const from = Date.now()
            await sql.raw('select 2').execute(db)
            took.push(Date.now() - from)
        }
        const calls = [run()]
        for (let i = 0; i < 3; i += 1) {
            await vi.advanceTimersByTimeAsync(2500)
            calls.push(run())
        }
        await vi.advanceTimersByTimeAsync(60_000)
        await Promise.all(calls)
        // The first probe at 1 s, its turn over at 3 s, the next at 5 s.
        expect(took).toEqual([5000, 2500, 0, 0])
    })

    /** The probe settles 2.8 s after it is sent: past its turn. */
    const late = (settle: (at: number) => Promise<unknown>) => {
        const t0 = Date.now()
        const send = (command: RdsDataCommand): Promise<unknown> => {
            const at = Date.now() - t0
            if (kindOf(command) === 'probe') {
                return new Promise((resolve, reject) => {
                    setTimeout(() => void settle(at).then(resolve, reject), 2800)
                })
            }
            return at < 2000 ? Promise.reject(resuming()) : Promise.resolve({ records: [] })
        }
        const now = () => Date.now() - t0
        return { db: database(send), now }
    }

    it.each([
        ['it answers late', () => Promise.resolve({})],
        ['it fails late for another reason', () => Promise.reject(named('InternalServerErrorException'))],
    ])('ends the wait when %s', async (_label, settle) => {
        const { db, now } = late(settle)
        const done = sql.raw('select 2').execute(db).then(now)
        await vi.advanceTimersByTimeAsync(60_000)
        expect(await done).toBe(3800)
    })

    /** A client whose probes never answer, as the SDK's does when aborted: it rejects with an AbortError. */
    function silent() {
        const counts = { sent: 0, aborted: 0, inFlight: 0, peak: 0, statements: 0 }
        const send: Send = (command, options) => {
            if (kindOf(command) !== 'probe') {
                counts.statements += 1
                return Promise.reject(resuming())
            }
            counts.sent += 1
            counts.inFlight += 1
            counts.peak = Math.max(counts.peak, counts.inFlight)
            return new Promise((_resolve, reject) => {
                options?.abortSignal?.addEventListener(
                    'abort',
                    () => {
                        counts.aborted += 1
                        counts.inFlight -= 1
                        reject(named('AbortError', 'The operation was aborted'))
                    },
                    { once: true },
                )
            })
        }
        return { counts, send }
    }

    // safeinsights/sssb#190: each probe left behind held a socket of the SDK's client until it settled.
    it('leaves at most three in flight under continuous traffic, however long no probe answers', async () => {
        const { counts, send } = silent()
        const done = outcome(sql.raw('select 2').execute(database(send, 120_000)))
        await vi.advanceTimersByTimeAsync(130_000)
        expect((await done).error).toMatchObject({ name: 'DatabaseUnavailableError', reason: 'resuming' })
        // It kept probing the whole wait (one every three seconds or so), and kept three at most out.
        expect(counts.sent).toBeGreaterThan(30)
        expect(counts.peak).toBeLessThanOrEqual(3)
        // None is left behind once the wait is over.
        expect(counts.inFlight).toBe(0)
        expect(counts.aborted).toBe(counts.sent)
    })

    it('aborts a probe PROBE_ABORT_MS after it was sent, and not before', async () => {
        const { counts, send } = silent()
        void outcome(sql.raw('select 2').execute(database(send, 120_000)))
        await vi.advanceTimersByTimeAsync(1000)
        expect(counts.sent).toBe(1)
        await vi.advanceTimersByTimeAsync(PROBE_ABORT_MS - 1)
        expect(counts.aborted).toBe(0)
        await vi.advanceTimersByTimeAsync(1)
        expect(counts.aborted).toBe(1)
        await vi.advanceTimersByTimeAsync(130_000)
    })

    it('does not take its own abort for the database answering: the wait goes on to its budget', async () => {
        const { counts, send } = silent()
        const done = outcome(sql.raw('select 2').execute(database(send, 30_000)))
        await vi.advanceTimersByTimeAsync(40_000)
        expect((await done).error).toMatchObject({ reason: 'resuming' })
        // The statement was sent once: an abort that ended the wait would have sent it again.
        expect(counts.statements).toBe(1)
    })

    it('aborts the probes still out when another answers, so the wait ends with none left', async () => {
        let probes = 0
        let aborted = 0
        const send: Send = (command, options) => {
            if (kindOf(command) !== 'probe') return probes === 0 ? Promise.reject(resuming()) : Promise.resolve({})
            if (++probes === 2) return Promise.resolve({})
            return new Promise((_resolve, reject) => {
                options?.abortSignal?.addEventListener('abort', () => {
                    aborted += 1
                    reject(named('AbortError'))
                })
            })
        }
        const done = sql.raw('select 2').execute(database(send))
        // The first probe (1 s) never answered; the second (5 s) did, and ended the wait with the first still out: 2 s
        // before its own abort (7 s), which has not come.
        await vi.advanceTimersByTimeAsync(5500)
        await done
        expect(probes).toBe(2)
        expect(aborted).toBe(1)
    })

    it('says nothing about the wait when it is refused late', async () => {
        let probes = 0
        const send = (command: RdsDataCommand): Promise<unknown> => {
            if (kindOf(command) !== 'probe') return Promise.reject(resuming())
            probes += 1
            if (probes > 1) return Promise.reject(throttled())
            return new Promise((_resolve, reject) => setTimeout(() => reject(resuming()), 16_500))
        }
        const done = outcome(sql.raw('select 2').execute(database(send)))
        await vi.advanceTimersByTimeAsync(60_000)
        expect((await done).error).toMatchObject({ reason: 'throttled' })
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
        const duplicate = 'duplicate key value violates unique constraint "k" Detail: Key (a)=(db is resuming) exists.'
        for (const message of [
            `ERROR: ${duplicate}`,
            duplicate,
            'something failed: "db is resuming"; SQLState: 22P02',
            'ERROR: invalid input syntax for type uuid: "db is resuming"',
        ]) {
            for (const name of ['DatabaseErrorException', 'BadRequestException']) {
                const h = harness(() => named(name, message, resuming()))
                const { error } = await outcome(h.run('insert into t default values'))
                expect(error).toMatchObject({ name: 'RdsDataDatabaseError', message })
                expect(h.calls).toHaveLength(1)
            }
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

    it('a transaction id that has ended is forgotten', async () => {
        const seen: string[] = []
        let nth = 0
        const send = async (command: RdsDataCommand): Promise<unknown> => {
            const kind = kindOf(command)
            seen.push(kind)
            if (kind === 'begin') return { transactionId: 'same' }
            if (kind === 'commit') return { transactionStatus: 'Transaction Committed' }
            if (kind === 'statement' && ++nth === 2) throw resuming()
            return { records: [] }
        }
        const db = database(send)
        const once = () => db.transaction().execute(async (trx) => sql.raw('select 2').execute(trx))
        await once()
        const again = once()
        await vi.advanceTimersByTimeAsync(5000)
        await again
        expect(seen.filter((kind) => kind === 'statement')).toHaveLength(3)
    })

    it('a rollback answered with a resume is done, and the error that caused it survives', async () => {
        const h = harness((call) => (call.kind === 'rollback' ? resuming() : undefined))
        const mine = new Error('mine')
        const { error } = await outcome(h.db.transaction().execute(() => Promise.reject(mine)))
        expect(error).toBe(mine)
        expect(h.at('rollback')).toHaveLength(1)
    })

    it('a throttled BeginTransaction holds up no other call; a resume it finds does', async () => {
        const h = harness((call) => (call.kind === 'begin' && call.at < 2000 ? throttled() : undefined))
        const begun = h.db.transaction().execute(async (trx) => sql.raw('select 2').execute(trx))
        await vi.advanceTimersByTimeAsync(500)
        await h.run('select 3')
        expect(h.now()).toBe(500)
        await vi.advanceTimersByTimeAsync(5000)
        await begun

        const woken = harness((call) =>
            call.kind === 'begin' && call.at < 1500
                ? throttled()
                : call.kind === 'probe' && call.at < 2500
                  ? resuming()
                  : undefined,
        )
        const waiting = woken.db.transaction().execute(async (trx) => sql.raw('select 2').execute(trx))
        await vi.advanceTimersByTimeAsync(1500)
        const held = woken.run('select 3').then(() => woken.now())
        await vi.advanceTimersByTimeAsync(5000)
        await waiting
        expect(await held).toBe(3000)
    })

    it('a later statement of a transaction is not sent again: the pause ended it, and the whole of it fails', async () => {
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

// safeinsights/sssb#189: a rollback Kysely makes because the work threw must not replace the work's error.
describe('a rollback that fails after the work threw', () => {
    const timedOut = () => named('StatementTimeoutException', 'Statement timed out')
    let warn: ReturnType<typeof vi.spyOn>
    beforeEach(() => {
        warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    })
    afterEach(() => warn.mockRestore())

    const failingRollback = (error: () => Error) => harness((call) => (call.kind === 'rollback' ? error() : undefined))
    const tenant = (h: ReturnType<typeof harness>, fn: Parameters<typeof runWithTenant>[2]) =>
        outcome(runWithTenant(h.db as unknown as Kysely<DB>, 'tenant-1', fn))

    it.each([
        ['a throttled', throttled, 'throttled'],
        ['a timed-out', timedOut, 'timed-out'],
    ])("keeps the work's error through %s rollback, and the rollback's beside it", async (_label, failure, reason) => {
        const h = failingRollback(failure)
        const forbidden = new ForbiddenError('not yours')
        const done = tenant(h, () => Promise.reject(forbidden))
        await vi.advanceTimersByTimeAsync(60_000)
        const { error } = await done
        expect(error).toBe(forbidden)
        expect(h.at('rollback')).toHaveLength(1)
        expect(Object.getOwnPropertyDescriptor(error, 'rollbackError')).toMatchObject({ enumerable: false })
        expect((error as { rollbackError: unknown }).rollbackError).toBeInstanceOf(DatabaseUnavailableError)
        expect((error as { rollbackError: DatabaseUnavailableError }).rollbackError.reason).toBe(reason)
        expect(warn).toHaveBeenCalledWith(
            expect.stringMatching(/rollback failed after its work threw ForbiddenError.*work's error/),
        )
    })

    it("keeps the error of the tenant scope's own statement, when the rollback fails after it", async () => {
        const failed = named('DatabaseErrorException', 'the scope could not be set')
        const h = harness((call) =>
            call.kind === 'rollback' ? throttled() : call.sql?.startsWith('SELECT set_config') ? failed : undefined,
        )
        const done = tenant(h, async () => 'never reached')
        await vi.advanceTimersByTimeAsync(60_000)
        // The dialect words a statement's failure as its own error, which is what the work threw.
        const { error } = await done
        expect(error).toMatchObject({
            name: 'RdsDataDatabaseError',
            message: expect.stringContaining('the scope could not be set'),
        })
        expect(error).not.toBeInstanceOf(DatabaseUnavailableError)
        expect((error as { rollbackError: DatabaseUnavailableError }).rollbackError.reason).toBe('throttled')
    })

    it.each([
        ['a string', 'plain'],
        ['a frozen error', Object.freeze(new Error('frozen'))],
    ])('throws %s the work threw, with nothing attached to it', async (_label, thrown) => {
        const h = failingRollback(throttled)
        const done = tenant(h, () => Promise.reject(thrown))
        await vi.advanceTimersByTimeAsync(60_000)
        expect((await done).error).toBe(thrown)
        expect(warn).toHaveBeenCalledTimes(1)
    })

    it("says nothing when the rollback succeeds, and throws the work's error as before", async () => {
        const h = harness(() => undefined)
        const mine = new Error('mine')
        const { error } = await tenant(h, () => Promise.reject(mine))
        expect(error).toBe(mine)
        expect(warn).not.toHaveBeenCalled()
        expect(Object.hasOwn(mine, 'rollbackError')).toBe(false)
    })

    it("still throws a commit's failure as it was: nothing the work threw is there to keep", async () => {
        const h = harness((call) => (call.kind === 'commit' ? throttled() : undefined))
        const done = tenant(h, async (trx) => sql.raw('select 2').execute(trx))
        await vi.advanceTimersByTimeAsync(60_000)
        expect((await done).error).toBeInstanceOf(DatabaseUnavailableError)
    })

    it('still fails a rollback the caller makes itself, which no work threw behind', async () => {
        const h = failingRollback(throttled)
        const done = outcome(
            (async () => {
                const trx = await h.db.startTransaction().execute()
                await sql.raw('select 2').execute(trx)
                await trx.rollback().execute()
            })(),
        )
        await vi.advanceTimersByTimeAsync(60_000)
        const { error } = await done
        expect(error).toBeInstanceOf(DatabaseUnavailableError)
        expect((error as DatabaseUnavailableError).reason).toBe('throttled')
        expect(warn).not.toHaveBeenCalled()
    })

    it("leaves a plain Kysely transaction as Kysely has it: the rollback's error replaces the work's", async () => {
        // The framework\'s scope is where the work's error is kept; a transaction opened on the raw handle is not.
        const h = failingRollback(throttled)
        const done = outcome(h.db.transaction().execute(() => Promise.reject(new ForbiddenError('not yours'))))
        await vi.advanceTimersByTimeAsync(60_000)
        expect((await done).error).toBeInstanceOf(DatabaseUnavailableError)
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
