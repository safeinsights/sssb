/**
 * The two ways this tool talks to GitHub.
 *
 * - `githubRequest`: `fetch` to api.github.com, for the calls that authenticate AS THE APP (a JWT signed with
 *   the key held in memory, or an installation token minted from it) or not at all (the name check, and the
 *   manifest exchange, where the one-hour code is the credential). Plain `fetch`, as CanopyCMS does: an App JWT needs
 *   `Authorization: Bearer`, and nothing here is worth a dependency.
 * - `gh` (see `runGh`): JP's own GitHub CLI login, for what needs a repository admin or an org owner: read the
 *   environment, the rulesets and the organisation's App installations, set the environment's secret and
 *   variable, and change rulesets.
 *
 * Every response or error that reaches a terminal goes through `redact` first.
 */
import { spawn } from 'node:child_process'
import { createSign } from 'node:crypto'

const REQUEST_TIMEOUT_MS = 30_000

/**
 * Strip anything credential-shaped from text about to be printed: a PEM block, a GitHub token, a JWT. A
 * truncated PEM (a response cut at 200 characters) has no END line, so a BEGIN line takes the rest.
 */
export function redact(text: string): string {
    return text
        .replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(-----END [A-Z ]*PRIVATE KEY-----|$)/g, '[REDACTED KEY]')
        .replace(/\bgh[opsu]_[A-Za-z0-9_]+/g, '[REDACTED TOKEN]')
        .replace(/\bgithub_pat_[A-Za-z0-9_]+/g, '[REDACTED TOKEN]')
        .replace(/\beyJ[A-Za-z0-9_-]*\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*/g, '[REDACTED JWT]')
}

export type FetchFn = typeof fetch

export type GitHubResponse<T> = {
    ok: boolean
    /** 0 when the request or the body read never completed. */
    status: number
    body: T | null
    /** On a failure, GitHub's `message` or a redacted prefix of the body; empty on success. */
    message: string
}

/**
 * One call to api.github.com. Every failure is a returned value, never a throw: this runs while the process
 * holds the App's only key, and a throw past that point loses it.
 */
export async function githubRequest<T>(
    fetchFn: FetchFn,
    apiPath: string,
    init: { method?: string; body?: unknown; token?: string; jwt?: string } = {},
): Promise<GitHubResponse<T>> {
    const headers: Record<string, string> = {
        accept: 'application/vnd.github+json',
        'x-github-api-version': '2022-11-28',
        'user-agent': 'sssb-release-app',
    }
    // Bearer for a JWT, never `token`: GitHub answers a JWT sent as `token` with a misleading 401.
    if (init.jwt) headers.authorization = `Bearer ${init.jwt}`
    else if (init.token) headers.authorization = `token ${init.token}`
    if (init.body !== undefined) headers['content-type'] = 'application/json'

    let response: Response
    let text: string
    try {
        response = await fetchFn(`https://api.github.com${apiPath}`, {
            method: init.method ?? 'GET',
            headers,
            signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
            ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
        })
        text = await response.text()
    } catch (err) {
        return { ok: false, status: 0, body: null, message: redact(errorMessage(err)) }
    }
    let body: T | null
    try {
        body = text ? (JSON.parse(text) as T) : null
    } catch {
        body = null
    }
    // Only for a failure: a successful body here can be the App's credentials.
    const record = body as { message?: unknown } | null
    const message = response.ok ? '' : redact(typeof record?.message === 'string' ? record.message : text.slice(0, 200))
    return { ok: response.ok, status: response.status, body, message }
}

/**
 * A short-lived App JWT, RS256 over `node:crypto`. `iat` is backdated 60s (GitHub rejects one in its future,
 * and clock skew is ordinary); `exp` stays under GitHub's ten-minute maximum.
 */
export function appJwt(issuer: string, privateKey: string, now = Math.floor(Date.now() / 1000)): string {
    const encode = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url')
    const unsigned = `${encode({ alg: 'RS256', typ: 'JWT' })}.${encode({ iat: now - 60, exp: now + 420, iss: issuer })}`
    const signer = createSign('RSA-SHA256')
    signer.update(unsigned)
    return `${unsigned}.${signer.sign(privateKey).toString('base64url')}`
}

export function errorMessage(err: unknown): string {
    return err instanceof Error ? err.message : String(err)
}

export type GhResult = { code: number; stdout: string; stderr: string }
/** Runs `gh` with these arguments; `input` goes to its stdin. Injectable so tests never run the real `gh`. */
export type GhRunner = (args: string[], input?: string) => Promise<GhResult>

/**
 * The real `gh`. Arguments go as argv with no shell, and anything secret goes on STDIN, never argv: an
 * argument is visible in `ps`. Output is captured, not inherited, so the caller decides what is printed
 * (and redacts it).
 */
export const runGh: GhRunner = (args, input) =>
    new Promise((resolve) => {
        let stdout = ''
        let stderr = ''
        const child = spawn('gh', args, { stdio: ['pipe', 'pipe', 'pipe'] })
        child.stdout.setEncoding('utf8').on('data', (chunk: string) => (stdout += chunk))
        child.stderr.setEncoding('utf8').on('data', (chunk: string) => (stderr += chunk))
        child.on('error', (err) => resolve({ code: 127, stdout, stderr: `could not run gh: ${errorMessage(err)}` }))
        child.on('close', (code) => resolve({ code: code ?? 1, stdout, stderr }))
        // Not optional: a `gh` that exits before reading its input fails this write with EPIPE, an unhandled
        // stream error that would end the process while it holds the key. The exit code is the verdict.
        child.stdin.on('error', () => {})
        child.stdin.end(input ?? '')
    })

/** `gh api <path>` parsed as JSON; `null` with the redacted reason on any failure. */
export async function ghJson<T>(gh: GhRunner, apiPath: string): Promise<{ value: T | null; error: string }> {
    const result = await gh(['api', apiPath])
    if (result.code !== 0) return { value: null, error: redact(result.stderr.trim() || `gh exited ${result.code}`) }
    try {
        return { value: JSON.parse(result.stdout) as T, error: '' }
    } catch {
        return { value: null, error: `gh api ${apiPath} did not answer JSON` }
    }
}
