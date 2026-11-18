import { execFile, spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createServer, type IncomingMessage, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
    DEFAULT_TIMEOUT_SECONDS,
    TICK_PATH,
    TickError,
    parseLoopbackOrigin,
    parseTickArgs,
    secretFilePath,
    summarizeTick,
    tickDidWork,
    tickOnce,
} from '../../scripts/tick.mjs'
import { parseDevArgs, resolveDevTick } from '../../scripts/dev-tick.mjs'
import { MAX_INTERVAL_SECONDS, createTicker, intervalProblem } from '../../scripts/ticker.mjs'
import {
    assertNoLiveDevTicker,
    liveTickerMarker,
    removeTickerMarker,
    tickerMarkerPath,
    writeTickerMarker,
} from '../../scripts/ticker-marker.mjs'
import { makeTestTmpDir } from '../support/tmp-dir'

/**
 * `pnpm tick` and the opt-in dev ticker (scripts/tick.mjs, scripts/dev-tick.mjs). The claims worth pinning: a bad
 * command line and a failed tick both exit non-zero (and differently), the dev secret only ever goes to this
 * machine, and the ticker is off unless asked and refuses to run where it must not.
 */
const TICK = fileURLToPath(new URL('../../scripts/tick.mjs', import.meta.url))
const DEV_TICK = fileURLToPath(new URL('../../scripts/dev-tick.mjs', import.meta.url))
const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url))

const GOOD_BODY = { ok: true, spawned: 2, failed: 0, deliveries: { delivered: 1, failed: 0, dead: 0 } }

describe('parseTickArgs', () => {
    it('needs a known app, and says which are known', () => {
        expect(() => parseTickArgs([])).toThrow(/which app/)
        expect(() => parseTickArgs(['ladle'])).toThrow(/unknown app "ladle" \(known: showcase, starter\)/)
        expect(() => parseTickArgs(['showcase', 'starter'])).toThrow(/unexpected argument "starter"/)
    })

    it('marks a bad command line as usage, which is not the same failure as a tick that failed', () => {
        for (const argv of [[], ['nope'], ['showcase', '--bogus'], ['showcase', '--timeout', '0']]) {
            expect(() => parseTickArgs(argv)).toThrow(TickError)
            try {
                parseTickArgs(argv)
            } catch (error) {
                expect((error as TickError).usage).toBe(true)
            }
        }
    })

    it('defaults the origin to this checkout’s port for the app, and the timeout to a minute', () => {
        const before = { s: process.env.SHOWCASE_PORT, t: process.env.STARTER_PORT }
        process.env.SHOWCASE_PORT = '3210'
        process.env.STARTER_PORT = '3211'
        try {
            expect(parseTickArgs(['showcase'])).toEqual({
                app: 'showcase',
                origin: 'http://localhost:3210',
                timeoutMs: DEFAULT_TIMEOUT_SECONDS * 1000,
            })
            expect(parseTickArgs(['starter']).origin).toBe('http://localhost:3211')
        } finally {
            for (const [key, value] of [
                ['SHOWCASE_PORT', before.s],
                ['STARTER_PORT', before.t],
            ] as const) {
                if (value === undefined) delete process.env[key]
                else process.env[key] = value
            }
        }
    })

    it('takes --url and --timeout in both spellings', () => {
        const spaced = parseTickArgs(['showcase', '--url', 'http://127.0.0.1:4000', '--timeout', '5'])
        const joined = parseTickArgs(['--url=http://127.0.0.1:4000', '--timeout=5', 'showcase'])
        expect(spaced).toEqual({ app: 'showcase', origin: 'http://127.0.0.1:4000', timeoutMs: 5000 })
        expect(joined).toEqual(spaced)
    })

    it('rejects a flag with no value rather than swallowing the next flag', () => {
        expect(() => parseTickArgs(['showcase', '--url'])).toThrow(/--url needs a value/)
        expect(() => parseTickArgs(['showcase', '--url', '--timeout', '5'])).toThrow(/--url needs a value/)
        expect(() => parseTickArgs(['showcase', '--timeout='])).toThrow(/--timeout needs a value/)
        for (const bad of ['soon', '0', '0.0001', '3601', '99999999', '-1']) {
            expect(() => parseTickArgs(['showcase', '--timeout', bad]), bad).toThrow(
                /--timeout must be between 0.1 and 3600/,
            )
        }
    })
})

describe('parseLoopbackOrigin: the dev secret goes to this machine only', () => {
    it('accepts the three loopback spellings over http, and drops any path', () => {
        expect(parseLoopbackOrigin('http://localhost:3000')).toBe('http://localhost:3000')
        expect(parseLoopbackOrigin('http://127.0.0.1:3000/anything')).toBe('http://127.0.0.1:3000')
        expect(parseLoopbackOrigin('http://[::1]:3000')).toBe('http://[::1]:3000')
    })

    it('refuses a remote host, https, a lookalike, and userinfo that hides the real host', () => {
        for (const bad of [
            'https://localhost:3000',
            'http://example.com',
            'http://localhost.example.com',
            'http://localhost@example.com',
            'http://10.0.0.5:3000',
            'localhost:3000',
            '',
        ]) {
            expect(() => parseLoopbackOrigin(bad), bad).toThrow(TickError)
        }
    })
})

describe('summarizeTick', () => {
    it('says what ran, and shows failures without calling the tick failed', () => {
        expect(summarizeTick(GOOD_BODY)).toBe(
            'ticked: 2 job(s) spawned from due schedules, 0 schedule(s) failed; webhook deliveries: 1 delivered, 0 failed, 0 dead',
        )
        expect(summarizeTick({ ok: true })).toContain('0 job(s) spawned')
    })

    it('knows whether anything moved', () => {
        expect(tickDidWork(GOOD_BODY)).toBe(true)
        expect(tickDidWork({ ok: true, spawned: 0, failed: 0, deliveries: { delivered: 0, failed: 0, dead: 0 } })).toBe(
            false,
        )
        expect(tickDidWork({ ok: true, spawned: 0, failed: 0, deliveries: { delivered: 0, failed: 1, dead: 0 } })).toBe(
            true,
        )
    })
})

describe('secretFilePath', () => {
    it('is where the kit keeps it: APP_DATA_DIR, else .data under the app directory', () => {
        expect(secretFilePath({}, '/apps/x')).toBe(path.join('/apps/x', '.data', 'auth', 'webhook-secret'))
        expect(secretFilePath({ APP_DATA_DIR: '/data' }, '/apps/x')).toBe(path.join('/data', 'auth', 'webhook-secret'))
    })
})

describe('tickOnce', () => {
    const ORIGIN = 'http://localhost:3000'
    const ENDPOINT = `${ORIGIN}${TICK_PATH}`

    function secretFile(contents?: string) {
        const file = path.join(makeTestTmpDir('sssb-tick-'), 'auth', 'webhook-secret')
        if (contents !== undefined) {
            mkdirSync(path.dirname(file), { recursive: true })
            writeFileSync(file, contents)
        }
        return file
    }

    function recorder(answer: (call: number) => Response | Error) {
        const calls: { url: string; method?: string; authorization?: string }[] = []
        const fetchImpl = (async (url: string, init: RequestInit) => {
            calls.push({
                url,
                method: init.method,
                authorization: (init.headers as Record<string, string>).authorization,
            })
            const result = answer(calls.length)
            if (result instanceof Error) throw result
            return result
        }) as unknown as typeof fetch
        return { calls, fetchImpl }
    }

    it('POSTs the route once with the secret as a bearer and returns its body', async () => {
        const { calls, fetchImpl } = recorder(() => Response.json(GOOD_BODY))
        const body = await tickOnce({ origin: ORIGIN, timeoutMs: 1000, secretFile: secretFile('s3cret'), fetchImpl })
        expect(body).toEqual(GOOD_BODY)
        expect(calls).toEqual([{ url: ENDPOINT, method: 'POST', authorization: 'Bearer s3cret' }])
    })

    it('with no secret yet, first makes the server create it (a throwaway bearer), then ticks with the real one', async () => {
        const file = secretFile()
        const { calls, fetchImpl } = recorder((call) => {
            if (call === 1) {
                mkdirSync(path.dirname(file), { recursive: true })
                writeFileSync(file, 'fresh-secret')
                return Response.json({ error: 'unauthorized' }, { status: 401 })
            }
            return Response.json(GOOD_BODY)
        })
        await tickOnce({ origin: ORIGIN, timeoutMs: 1000, secretFile: file, fetchImpl })
        expect(calls.map((call) => call.authorization)).toEqual(['Bearer x', 'Bearer fresh-secret'])
    })

    it('says so when the server did not create a secret (real mode, or another data dir), and never ticks without one', async () => {
        const { calls, fetchImpl } = recorder(() => Response.json({ error: 'unauthorized' }, { status: 401 }))
        await expect(
            tickOnce({ origin: ORIGIN, timeoutMs: 1000, secretFile: secretFile(), fetchImpl }),
        ).rejects.toThrow(/did not create a dev secret/)
        expect(calls).toHaveLength(1)
    })

    it('fails on a 401 with the real-mode hint', async () => {
        const { fetchImpl } = recorder(() => Response.json({ error: 'unauthorized' }, { status: 401 }))
        await expect(
            tickOnce({ origin: ORIGIN, timeoutMs: 1000, secretFile: secretFile('old'), fetchImpl }),
        ).rejects.toThrow(/answered 401.*WEBHOOK_SECRET/)
    })

    it('fails on a 500 and on a body that is not the tick’s JSON', async () => {
        const secret = secretFile('s')
        const broken = recorder(() => new Response('boom', { status: 500 }))
        await expect(
            tickOnce({ origin: ORIGIN, timeoutMs: 1000, secretFile: secret, fetchImpl: broken.fetchImpl }),
        ).rejects.toThrow(/answered 500: boom/)
        const html = recorder(() => new Response('<html>', { status: 200 }))
        await expect(
            tickOnce({ origin: ORIGIN, timeoutMs: 1000, secretFile: secret, fetchImpl: html.fetchImpl }),
        ).rejects.toThrow(/not the tick's JSON/)
    })

    it('says to start the dev server when nothing is listening, and names a timeout as one', async () => {
        const refused = Object.assign(new TypeError('fetch failed'), {
            cause: Object.assign(new Error('x'), { code: 'ECONNREFUSED' }),
        })
        const down = recorder(() => refused)
        await expect(
            tickOnce({ origin: ORIGIN, timeoutMs: 1000, secretFile: secretFile('s'), fetchImpl: down.fetchImpl }),
        ).rejects.toThrow(/could not reach .*ECONNREFUSED.*pnpm dev/)
        const slow = recorder(() => Object.assign(new Error('t'), { name: 'TimeoutError' }))
        await expect(
            tickOnce({ origin: ORIGIN, timeoutMs: 1, secretFile: secretFile('s'), fetchImpl: slow.fetchImpl }),
        ).rejects.toThrow(/before the timeout/)
    })
})

// -------------------------------------------------------------------------------------------------------------
// The command itself, end to end against a server that plays the route's part: exit codes are the contract.
// -------------------------------------------------------------------------------------------------------------

interface Hit {
    authorization: string | undefined
}

let server: Server | undefined

afterEach(async () => {
    await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()))
    server = undefined
})

/** A stand-in dev server: writes the secret on the first request (as the kit does), then answers `respond`. */
async function listen(dataDir: string, respond: (hit: Hit) => { status: number; body: string }) {
    const hits: Hit[] = []
    const secret = path.join(dataDir, 'auth', 'webhook-secret')
    server = createServer((req: IncomingMessage, res) => {
        if (!existsSync(secret)) {
            mkdirSync(path.dirname(secret), { recursive: true })
            writeFileSync(secret, 'abc123')
        }
        const hit = { authorization: req.headers.authorization }
        hits.push(hit)
        const answer = req.method === 'POST' && req.url === TICK_PATH ? respond(hit) : { status: 404, body: 'no' }
        res.writeHead(answer.status, { 'content-type': 'application/json' }).end(answer.body)
    })
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve))
    return { port: (server.address() as AddressInfo).port, hits }
}

function run(script: string, args: string[], env: Record<string, string>) {
    return new Promise<{ code: number | null; out: string; err: string }>((resolve) => {
        execFile(
            process.execPath,
            [script, ...args],
            { cwd: REPO_ROOT, env: { PATH: process.env.PATH ?? '', ...env } as unknown as NodeJS.ProcessEnv },
            (error, out, err) => resolve({ code: error ? ((error as { code?: number }).code ?? 1) : 0, out, err }),
        )
    })
}

describe('node scripts/tick.mjs', () => {
    it('exits 0 and prints what ran when the route answers, having authenticated with the dev secret', async () => {
        const dataDir = makeTestTmpDir('sssb-tick-cli-')
        const { port, hits } = await listen(dataDir, (hit) =>
            hit.authorization === 'Bearer abc123'
                ? { status: 200, body: JSON.stringify(GOOD_BODY) }
                : { status: 401, body: '{}' },
        )
        const result = await run(TICK, ['showcase', '--url', `http://127.0.0.1:${port}`], { APP_DATA_DIR: dataDir })
        expect(result).toMatchObject({ code: 0, err: '' })
        expect(result.out).toContain('2 job(s) spawned')
        expect(hits.map((hit) => hit.authorization)).toEqual(['Bearer x', 'Bearer abc123'])
        expect(readFileSync(path.join(dataDir, 'auth', 'webhook-secret'), 'utf8')).toBe('abc123')
    })

    it('exits 1, with the status in the message, when the route fails', async () => {
        const dataDir = makeTestTmpDir('sssb-tick-cli-')
        const { port } = await listen(dataDir, () => ({ status: 500, body: 'tick exploded' }))
        const result = await run(TICK, ['showcase', '--url', `http://127.0.0.1:${port}`], { APP_DATA_DIR: dataDir })
        expect(result.code).toBe(1)
        expect(result.err).toMatch(/tick: .*answered 500: tick exploded/)
    })

    it('exits 1 when the server rejects the secret', async () => {
        const dataDir = makeTestTmpDir('sssb-tick-cli-')
        const { port } = await listen(dataDir, () => ({ status: 401, body: '{"error":"unauthorized"}' }))
        const result = await run(TICK, ['showcase', '--url', `http://127.0.0.1:${port}`], { APP_DATA_DIR: dataDir })
        expect(result.code).toBe(1)
        expect(result.err).toMatch(/answered 401/)
    })

    it('exits 1 when nothing is listening', async () => {
        const dataDir = makeTestTmpDir('sssb-tick-cli-')
        mkdirSync(path.join(dataDir, 'auth'), { recursive: true })
        writeFileSync(path.join(dataDir, 'auth', 'webhook-secret'), 'abc123')
        // a port that was just free: nothing listens, so the connection is refused (port 9 would be fetch's "bad port")
        const probe = createServer()
        await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve))
        const { port } = probe.address() as AddressInfo
        await new Promise<void>((resolve) => probe.close(() => resolve()))
        const result = await run(TICK, ['showcase', '--url', `http://127.0.0.1:${port}`], { APP_DATA_DIR: dataDir })
        expect(result.code).toBe(1)
        expect(result.err).toMatch(/could not reach/)
    })

    it('exits 2 and prints usage for a bad command line, and never makes a request', async () => {
        const dataDir = makeTestTmpDir('sssb-tick-cli-')
        const { port, hits } = await listen(dataDir, () => ({ status: 200, body: JSON.stringify(GOOD_BODY) }))
        for (const args of [
            [],
            ['nope'],
            ['showcase', '--url', `https://127.0.0.1:${port}`],
            ['showcase', '--url', 'http://example.com'],
        ]) {
            const result = await run(TICK, args, { APP_DATA_DIR: dataDir })
            expect(result.code, args.join(' ')).toBe(2)
            expect(result.err).toContain('usage: pnpm tick')
        }
        expect(hits).toEqual([])
    })
})

// -------------------------------------------------------------------------------------------------------------
// The opt-in ticker.
// -------------------------------------------------------------------------------------------------------------

describe('resolveDevTick: off unless asked, and not where it must not run', () => {
    it('is off with the variable unset or blank', () => {
        expect(resolveDevTick({})).toEqual({ mode: 'off' })
        expect(resolveDevTick({ DEV_TICK_SECONDS: '' })).toEqual({ mode: 'off' })
        expect(resolveDevTick({ DEV_TICK_SECONDS: '  ' })).toEqual({ mode: 'off' })
    })

    it('is on for a whole number of seconds', () => {
        expect(resolveDevTick({ DEV_TICK_SECONDS: '30' })).toEqual({ mode: 'on', seconds: 30 })
        expect(resolveDevTick({ DEV_TICK_SECONDS: '1' })).toEqual({ mode: 'on', seconds: 1 })
        expect(resolveDevTick({ DEV_TICK_SECONDS: String(MAX_INTERVAL_SECONDS) })).toMatchObject({ mode: 'on' })
    })

    it('is invalid for anything else, rather than quietly off', () => {
        for (const bad of ['0', '-5', '1.5', 'soon', 'true', '30s', String(MAX_INTERVAL_SECONDS + 1), '9999999']) {
            expect(resolveDevTick({ DEV_TICK_SECONDS: bad }), bad).toMatchObject({ mode: 'invalid' })
        }
    })

    it('is refused under the e2e build and the demo build, even when asked', () => {
        expect(resolveDevTick({ DEV_TICK_SECONDS: '30', E2E_BUILD: '1' })).toMatchObject({
            mode: 'refused',
            reason: /E2E_BUILD/,
        })
        expect(resolveDevTick({ DEV_TICK_SECONDS: '30', DEMO_MODE: '1' })).toMatchObject({
            mode: 'refused',
            reason: /DEMO_MODE/,
        })
    })
})

describe('the e2e servers are started with the ticker blanked', () => {
    it.each(['showcase', 'starter'])('apps/%s/playwright.config.ts', (app) => {
        const config = readFileSync(path.join(REPO_ROOT, 'apps', app, 'playwright.config.ts'), 'utf8')
        expect(config).toMatch(/env:\s*\{\s*DEV_TICK_SECONDS:\s*''\s*\}/)
    })

    it.each(['showcase', 'starter'])('apps/%s `dev` goes through the wrapper and has a `tick` script', (app) => {
        const scripts = JSON.parse(readFileSync(path.join(REPO_ROOT, 'apps', app, 'package.json'), 'utf8')).scripts
        expect(scripts.dev).toContain(`node ../../scripts/dev-tick.mjs ${app} -- next dev --port`)
        expect(scripts.tick).toBe(`node ../../scripts/tick.mjs ${app}`)
    })
})

describe('createTicker: one object owns start, stop, the interval and whether it is running', () => {
    const idle = { ok: true, spawned: 0, failed: 0, deliveries: { delivered: 0, failed: 0, dead: 0 } }

    /**
     * A ticker whose sleeps and ticks are scripted: each `sleep` waits for `step()` (so a test steps the rounds by
     * hand), and each tick answers from `answers` in turn.
     */
    function scripted(answers: (Record<string, unknown> | Error)[], markerFile?: string) {
        const log: string[] = []
        const waiting: (() => void)[] = []
        const signals: AbortSignal[] = []
        let round = 0
        const ticker = createTicker({
            origin: 'http://localhost:1',
            markerFile,
            log: (line) => log.push(line),
            now: () => new Date('2026-11-17T12:00:00.000Z'),
            sleep: (_ms, signal) =>
                new Promise<void>((resolve) => {
                    waiting.push(resolve)
                    signal.addEventListener(
                        'abort',
                        () => {
                            const at = waiting.indexOf(resolve)
                            if (at >= 0) waiting.splice(at, 1)
                            resolve()
                        },
                        { once: true },
                    )
                }),
            tick: (async ({ signal }: { signal: AbortSignal }) => {
                signals.push(signal)
                const answer = answers[round++]
                if (answer instanceof Error) throw answer
                return answer
            }) as never,
        })
        /** Lets the pending sleep finish, then waits for the loop to reach its next sleep. */
        const step = async () => {
            waiting.shift()?.()
            await new Promise((resolve) => setImmediate(resolve))
        }
        return { ticker, log, step, signals }
    }

    it('is not running until started, and reports its interval and what it has done', async () => {
        const { ticker, step } = scripted([idle, GOOD_BODY])
        expect(ticker.status()).toEqual({ running: false, seconds: null, ticks: 0, lastTickAt: null, lastError: null })
        expect(ticker.start(30)).toMatchObject({ running: true, seconds: 30, ticks: 0 })
        await step()
        await step()
        expect(ticker.status()).toEqual({
            running: true,
            seconds: 30,
            ticks: 2,
            lastTickAt: '2026-11-17T12:00:00.000Z',
            lastError: null,
        })
        await ticker.stop()
        expect(ticker.status()).toMatchObject({ running: false, ticks: 2 })
    })

    it('stays quiet while nothing is due, and speaks when something ran', async () => {
        const { ticker, log, step } = scripted([idle, GOOD_BODY, idle])
        ticker.start(5)
        await step()
        await step()
        await step()
        await ticker.stop()
        expect(log).toEqual([`[tick] ${summarizeTick(GOOD_BODY)}`])
    })

    it('says an unreachable server once, then that it recovered, rather than once per interval', async () => {
        const down = new TickError('could not reach http://localhost:1/api/webhooks/cron (ECONNREFUSED)')
        const { ticker, log, step } = scripted([down, down, down, idle])
        ticker.start(5)
        for (let i = 0; i < 4; i++) await step()
        expect(ticker.status().lastError).toBeNull()
        await ticker.stop()
        expect(log).toEqual([`[tick] ${down.message} (will keep trying every 5s)`, '[tick] ok again'])
    })

    it('start is idempotent while running, and refuses an interval that cannot work', async () => {
        const { ticker } = scripted([])
        ticker.start(5)
        expect(ticker.start(60)).toMatchObject({ running: true, seconds: 5 })
        await ticker.stop()
        for (const bad of [0, -1, 1.5, MAX_INTERVAL_SECONDS + 1, Number.NaN, 2 ** 31]) {
            expect(() => ticker.start(bad), String(bad)).toThrow(RangeError)
        }
        expect(ticker.status().running).toBe(false)
        expect(intervalProblem(30)).toBeNull()
    })

    it('can be stopped and started again, and stopping when stopped is harmless', async () => {
        const { ticker, step } = scripted([idle, idle])
        await ticker.stop()
        ticker.start(5)
        await step()
        await ticker.stop()
        ticker.start(10)
        await step()
        expect(ticker.status()).toMatchObject({ running: true, seconds: 10, ticks: 1 })
        await ticker.stop()
    })

    it('stop ticks no more, and cancels a tick in flight', async () => {
        const stepped = scripted([idle])
        stepped.ticker.start(5)
        await stepped.step()
        expect(stepped.signals).toHaveLength(1)
        await stepped.ticker.stop()
        await new Promise((resolve) => setImmediate(resolve))
        expect(stepped.signals).toHaveLength(1)

        // a tick that never answers: stop() must still resolve, by aborting the signal it was handed
        let handed: AbortSignal | undefined
        const hang = createTicker({
            origin: 'http://localhost:1',
            sleep: async () => {},
            log: () => {},
            tick: ((options: { signal: AbortSignal }) =>
                new Promise((_resolve, reject) => {
                    handed = options.signal
                    options.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
                })) as never,
        })
        hang.start(5)
        await new Promise((resolve) => setImmediate(resolve))
        await Promise.race([
            hang.stop(),
            new Promise((_resolve, reject) => setTimeout(() => reject(new Error('stop() did not resolve')), 2000)),
        ])
        expect(handed?.aborted).toBe(true)
    })

    it('records a live ticker in its marker file while it runs, and removes it on stop', async () => {
        const marker = path.join(makeTestTmpDir('sssb-ticker-'), '.data', 'dev-ticker.json')
        const { ticker } = scripted([], marker)
        expect(liveTickerMarker(marker)).toBeNull()
        ticker.start(30)
        expect(liveTickerMarker(marker)).toMatchObject({ pid: process.pid, seconds: 30 })
        await ticker.stop()
        expect(existsSync(marker)).toBe(false)
    })
})

describe('the ticker marker: what keeps a ticking dev server out of the e2e suite', () => {
    it('is ignored when its process is gone (a SIGKILLed wrapper cannot clean up) and when it is not JSON', () => {
        const file = path.join(makeTestTmpDir('sssb-marker-'), 'dev-ticker.json')
        writeFileSync(file, JSON.stringify({ pid: 2 ** 22 + 12345, seconds: 5, startedAt: 'x' }))
        expect(liveTickerMarker(file)).toBeNull()
        writeFileSync(file, 'not json')
        expect(liveTickerMarker(file)).toBeNull()
        expect(liveTickerMarker(path.join(path.dirname(file), 'absent.json'))).toBeNull()
    })

    it('is live for a running process, and only its owner removes it', () => {
        const file = path.join(makeTestTmpDir('sssb-marker-'), 'dev-ticker.json')
        writeFileSync(file, JSON.stringify({ pid: process.ppid, seconds: 5, startedAt: 'x' }))
        expect(liveTickerMarker(file)).toMatchObject({ pid: process.ppid })
        removeTickerMarker(file)
        expect(existsSync(file)).toBe(true)
        writeTickerMarker(file, 7)
        expect(liveTickerMarker(file)).toMatchObject({ pid: process.pid, seconds: 7 })
        removeTickerMarker(file)
        expect(existsSync(file)).toBe(false)
    })

    it('puts the file under APP_DATA_DIR, else .data in the app directory', () => {
        expect(tickerMarkerPath({}, '/apps/x')).toBe(path.join('/apps/x', '.data', 'dev-ticker.json'))
        expect(tickerMarkerPath({ APP_DATA_DIR: '/data' }, '/apps/x')).toBe(path.join('/data', 'dev-ticker.json'))
    })

    it('makes a playwright config refuse to load while a ticker is live, and not otherwise', () => {
        const dataDir = makeTestTmpDir('sssb-marker-')
        expect(() => assertNoLiveDevTicker({ APP_DATA_DIR: dataDir }, '/nowhere')).not.toThrow()
        writeTickerMarker(path.join(dataDir, 'dev-ticker.json'), 30)
        expect(() => assertNoLiveDevTicker({ APP_DATA_DIR: dataDir }, '/nowhere')).toThrow(/a dev ticker is running/)
    })

    it.each(['showcase', 'starter'])(
        'apps/%s/playwright.config.ts really does refuse (the config as Playwright loads it)',
        async (app) => {
            const dataDir = makeTestTmpDir('sssb-marker-pw-')
            const list = () =>
                new Promise<{ code: number | null; out: string; err: string }>((resolve) => {
                    execFile(
                        path.join(REPO_ROOT, 'node_modules/.bin/playwright'),
                        ['test', '--list'],
                        {
                            cwd: path.join(REPO_ROOT, 'apps', app),
                            env: {
                                PATH: process.env.PATH ?? '',
                                APP_DATA_DIR: dataDir,
                            } as unknown as NodeJS.ProcessEnv,
                        },
                        (error, out, err) =>
                            resolve({ code: error ? ((error as { code?: number }).code ?? 1) : 0, out, err }),
                    )
                })
            const without = await list()
            expect(without.err, 'the config loads and lists with no ticker running').not.toContain('dev ticker')
            expect(without.code).toBe(0)
            writeTickerMarker(path.join(dataDir, 'dev-ticker.json'), 30)
            const refused = await list()
            expect(refused.code).not.toBe(0)
            expect(refused.out + refused.err).toContain('a dev ticker is running')
        },
    )
})

describe('node scripts/dev-tick.mjs', () => {
    it('parses `<app> -- <command...>` and rejects anything else', () => {
        expect(parseDevArgs(['showcase', '--', 'next', 'dev', '--port', '3000'])).toEqual({
            app: 'showcase',
            command: ['next', 'dev', '--port', '3000'],
        })
        for (const bad of [[], ['showcase'], ['showcase', 'next', 'dev'], ['nope', '--', 'next'], ['showcase', '--']]) {
            expect(parseDevArgs(bad), bad.join(' ')).toHaveProperty('error')
        }
    })

    const sleepAndExit = (ms: number) => [
        'showcase',
        '--',
        process.execPath,
        '-e',
        `setTimeout(() => process.exit(7), ${ms})`,
    ]
    const SLEEP_AND_EXIT = sleepAndExit(1600)

    it('is a pass-through when the variable is unset: runs the command, exits with its code, and never calls the route', async () => {
        const dataDir = makeTestTmpDir('sssb-devtick-')
        const { port, hits } = await listen(dataDir, () => ({ status: 200, body: JSON.stringify(GOOD_BODY) }))
        const result = await run(DEV_TICK, SLEEP_AND_EXIT, { APP_DATA_DIR: dataDir, SHOWCASE_PORT: String(port) })
        expect(result.code).toBe(7)
        expect(result.out).not.toContain('[tick]')
        expect(hits).toEqual([])
    })

    it('with DEV_TICK_SECONDS set, ticks while the command runs (marker live), and leaves nothing behind when it exits', async () => {
        const dataDir = makeTestTmpDir('sssb-devtick-')
        const markerFile = path.join(dataDir, 'dev-ticker.json')
        const markerSeenByServer: boolean[] = []
        const { port, hits } = await listen(dataDir, () => {
            markerSeenByServer.push(liveTickerMarker(markerFile) !== null)
            return { status: 200, body: JSON.stringify(GOOD_BODY) }
        })
        const result = await run(DEV_TICK, sleepAndExit(3000), {
            APP_DATA_DIR: dataDir,
            SHOWCASE_PORT: String(port),
            DEV_TICK_SECONDS: '1',
        })
        expect(result.code).toBe(7)
        expect(result.out).toContain(`DEV_TICK_SECONDS=1`)
        expect(result.out).toContain('2 job(s) spawned')
        expect(hits.some((hit) => hit.authorization === 'Bearer abc123')).toBe(true)
        expect(markerSeenByServer.length).toBeGreaterThan(0)
        expect(markerSeenByServer.every(Boolean), 'the marker is live whenever a tick arrives').toBe(true)
        expect(existsSync(markerFile), 'removed on exit').toBe(false)
        const seen = hits.length
        await new Promise((resolve) => setTimeout(resolve, 1200))
        expect(hits.length, 'a ticker that outlives the process it wrapped').toBe(seen)
    })

    it.each(['SIGINT', 'SIGTERM', 'SIGHUP'] as const)(
        'passes %s sent to the wrapper alone on to the command, and exits with the command’s code',
        async (signal) => {
            const child = spawn(
                process.execPath,
                [
                    DEV_TICK,
                    'showcase',
                    '--',
                    process.execPath,
                    '-e',
                    `process.on('${signal}', () => process.exit(5)); console.log('ready'); setInterval(() => {}, 1000)`,
                ],
                { cwd: REPO_ROOT, env: { PATH: process.env.PATH ?? '' } as unknown as NodeJS.ProcessEnv },
            )
            let out = ''
            child.stdout.on('data', (chunk) => (out += chunk))
            await vi.waitFor(() => expect(out).toContain('ready'), { timeout: 10_000 })
            const exited = new Promise<number | null>((resolve) => child.on('exit', (code) => resolve(code)))
            child.kill(signal)
            expect(await exited).toBe(5)
        },
    )

    it('does not tick under E2E_BUILD or DEMO_MODE, and says why', async () => {
        for (const blocker of ['E2E_BUILD', 'DEMO_MODE']) {
            const dataDir = makeTestTmpDir('sssb-devtick-')
            const { port, hits } = await listen(dataDir, () => ({ status: 200, body: JSON.stringify(GOOD_BODY) }))
            const result = await run(DEV_TICK, SLEEP_AND_EXIT, {
                APP_DATA_DIR: dataDir,
                SHOWCASE_PORT: String(port),
                DEV_TICK_SECONDS: '1',
                [blocker]: '1',
            })
            expect(result.code, blocker).toBe(7)
            expect(result.err).toContain(`ignored while ${blocker} is set`)
            expect(hits, blocker).toEqual([])
            await new Promise<void>((resolve) => server!.close(() => resolve()))
            server = undefined
        }
    })

    it('refuses an invalid interval before starting the command', async () => {
        const result = await run(DEV_TICK, ['showcase', '--', process.execPath, '-e', 'console.log("started")'], {
            DEV_TICK_SECONDS: 'soon',
        })
        expect(result.code).toBe(2)
        expect(result.err).toContain('DEV_TICK_SECONDS must be a whole number of seconds from 1 to 86400')
        expect(result.out).not.toContain('started')
    })
})
