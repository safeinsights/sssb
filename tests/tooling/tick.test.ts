import { execFile } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createServer, type IncomingMessage, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
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
import { parseDevArgs, resolveDevTick, runTicker } from '../../scripts/dev-tick.mjs'
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
        expect(() => parseTickArgs(['showcase', '--timeout', 'soon'])).toThrow(/positive number of seconds/)
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
    })

    it('is invalid for anything else, rather than quietly off', () => {
        for (const bad of ['0', '-5', '1.5', 'soon', 'true', '30s']) {
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

describe('runTicker', () => {
    /** Runs `ticks` rounds, answering each from `answers`, then stops. */
    async function drive(answers: (Record<string, unknown> | Error)[]) {
        const stop = new AbortController()
        const log: string[] = []
        let round = 0
        await runTicker({
            origin: 'http://localhost:1',
            seconds: 5,
            signal: stop.signal,
            log: (line) => log.push(line),
            sleep: async () => {
                if (round === answers.length) stop.abort()
            },
            tick: (async () => {
                const answer = answers[round++]
                if (answer instanceof Error) throw answer
                return answer
            }) as never,
        })
        return log
    }

    const idle = { ok: true, spawned: 0, failed: 0, deliveries: { delivered: 0, failed: 0, dead: 0 } }

    it('stays quiet while nothing is due, and speaks when something ran', async () => {
        const log = await drive([idle, GOOD_BODY, idle])
        expect(log).toEqual([`[tick] ${summarizeTick(GOOD_BODY)}`])
    })

    it('says an unreachable server once, then that it recovered, rather than once per interval', async () => {
        const down = new TickError('could not reach http://localhost:1/api/webhooks/cron (ECONNREFUSED)')
        const log = await drive([down, down, down, idle])
        expect(log).toEqual([`[tick] ${down.message} (will keep trying every 5s)`, '[tick] ok again'])
    })

    it('does not tick at all once told to stop', async () => {
        const stop = new AbortController()
        stop.abort()
        let ticks = 0
        await runTicker({
            origin: 'http://localhost:1',
            seconds: 5,
            signal: stop.signal,
            tick: (async () => (ticks++, idle)) as never,
        })
        expect(ticks).toBe(0)
    })
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

    const SLEEP_AND_EXIT = ['showcase', '--', process.execPath, '-e', 'setTimeout(() => process.exit(7), 1600)']

    it('is a pass-through when the variable is unset: runs the command, exits with its code, and never calls the route', async () => {
        const dataDir = makeTestTmpDir('sssb-devtick-')
        const { port, hits } = await listen(dataDir, () => ({ status: 200, body: JSON.stringify(GOOD_BODY) }))
        const result = await run(DEV_TICK, SLEEP_AND_EXIT, { APP_DATA_DIR: dataDir, SHOWCASE_PORT: String(port) })
        expect(result.code).toBe(7)
        expect(result.out).not.toContain('[tick]')
        expect(hits).toEqual([])
    })

    it('with DEV_TICK_SECONDS set, ticks the route while the command runs, and stops when it exits', async () => {
        const dataDir = makeTestTmpDir('sssb-devtick-')
        const { port, hits } = await listen(dataDir, () => ({ status: 200, body: JSON.stringify(GOOD_BODY) }))
        const result = await run(DEV_TICK, SLEEP_AND_EXIT, {
            APP_DATA_DIR: dataDir,
            SHOWCASE_PORT: String(port),
            DEV_TICK_SECONDS: '1',
        })
        expect(result.code).toBe(7)
        expect(result.out).toContain(`DEV_TICK_SECONDS=1`)
        expect(result.out).toContain('2 job(s) spawned')
        expect(hits.some((hit) => hit.authorization === 'Bearer abc123')).toBe(true)
        const seen = hits.length
        await new Promise((resolve) => setTimeout(resolve, 1200))
        expect(hits.length, 'a ticker that outlives the server it wraps').toBe(seen)
    })

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
        expect(result.err).toContain('DEV_TICK_SECONDS must be a whole number')
        expect(result.out).not.toContain('started')
    })
})
