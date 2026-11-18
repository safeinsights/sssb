/**
 * scripts/release-app (`pnpm release-app`), driven end to end against a FAKE GitHub: `fetch` is a router over
 * canned answers and `gh` is a fake that keeps the repository's environment and rulesets in memory. The test
 * plays the browser too, by reading the creation form and calling the loopback redirect itself. Nothing here
 * reaches the network, creates an App or writes a secret.
 */
import { generateKeyPairSync } from 'node:crypto'
import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { makeTestTmpDir } from '../support/tmp-dir'
import {
    bypassCommand,
    createCommand,
    startCallbackServer,
    verifyCommand,
    type Deps,
} from '../../scripts/release-app/commands'
import { appJwt, redact, type GhResult } from '../../scripts/release-app/github'
import {
    RELEASE_APP_PERMISSIONS,
    appManifest,
    appSlug,
    creationForm,
    installationFindings,
    permissionFindings,
} from '../../scripts/release-app/manifest'
import {
    MAIN_CHECKS,
    MAIN_HISTORY,
    TAGS_CREATE,
    TAGS_IMMUTABLE,
    externalGates,
    planBypass,
    type Ruleset,
} from '../../scripts/release-app/rulesets'

const { privateKey: PEM } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' },
})
const APP_ID = 4242
const CLIENT_ID = 'Iv23liFAKEclientid'
const REPO = 'repos/safeinsights/sssb'

/** The repository's rulesets as they stood when the release environments were made (2026-11-17). */
function liveRulesets(): Ruleset[] {
    return [
        {
            id: 7484436,
            name: 'require-pr',
            source_type: 'Organization',
            target: 'branch',
            enforcement: 'active',
            conditions: { ref_name: { include: ['~DEFAULT_BRANCH'], exclude: [] } },
            rules: [
                { type: 'deletion' },
                { type: 'non_fast_forward' },
                { type: 'pull_request', parameters: { required_approving_review_count: 1 } },
            ],
            bypass_actors: [{ actor_id: 4038189, actor_type: 'Integration', bypass_mode: 'always' }],
        },
        {
            id: 27509996,
            name: MAIN_CHECKS,
            source_type: 'Repository',
            target: 'branch',
            enforcement: 'active',
            conditions: { ref_name: { include: ['~DEFAULT_BRANCH'], exclude: [] } },
            rules: [
                {
                    type: 'required_status_checks',
                    parameters: {
                        strict_required_status_checks_policy: true,
                        required_status_checks: [{ context: 'checks' }],
                    },
                },
            ],
            bypass_actors: [],
        },
        {
            id: 27509998,
            name: TAGS_CREATE,
            source_type: 'Repository',
            target: 'tag',
            enforcement: 'active',
            conditions: { ref_name: { include: ['refs/tags/v*'], exclude: [] } },
            rules: [{ type: 'creation' }, { type: 'update' }, { type: 'deletion' }, { type: 'non_fast_forward' }],
            bypass_actors: [],
        },
    ]
}

type Call = { args: string[]; input?: string }

/** The organisation's installations as `gh api orgs/safeinsights/installations` lists them. */
const INSTALLATIONS = [
    {
        id: 99,
        app_id: APP_ID,
        app_slug: 'safeinsights-sssb-release',
        client_id: CLIENT_ID,
        repository_selection: 'selected',
        suspended_at: null,
        account: { login: 'safeinsights' },
        permissions: { ...RELEASE_APP_PERMISSIONS },
    },
    {
        id: 98,
        app_id: 4038189,
        app_slug: 'other-bot',
        client_id: 'Iv23other',
        repository_selection: 'selected',
        suspended_at: null,
        account: { login: 'safeinsights' },
        permissions: { contents: 'write', metadata: 'read' },
    },
]

/**
 * What GitHub stores and serves back for a ruleset body: its own key order, extra fields, `exclude` before
 * `include`, and the rules in another order. So a plan that converges here does not converge only because the
 * fake stores what it was sent.
 */
function asGitHubStores(body: Ruleset, id: number): Ruleset {
    return {
        id,
        source_type: 'Repository',
        source: 'safeinsights/sssb',
        node_id: `RRS_${id}`,
        current_user_can_bypass: 'never',
        _links: { self: { href: `https://api.github.com/${REPO}/rulesets/${id}` } },
        created_at: '2026-11-17T00:00:00Z',
        bypass_actors: body.bypass_actors.map((a) => ({
            bypass_mode: a.bypass_mode,
            actor_type: a.actor_type,
            actor_id: a.actor_id,
        })),
        rules: [...body.rules].reverse(),
        conditions: {
            ref_name: { exclude: body.conditions.ref_name.exclude, include: body.conditions.ref_name.include },
        },
        enforcement: body.enforcement,
        target: body.target,
        name: body.name,
    } as Ruleset
}

/** A fake `gh` over an in-memory repository. Records every call with its stdin. */
function fakeGh(
    options: {
        secret?: boolean
        variable?: string
        admin?: boolean
        failSecretSet?: number
        installations?: Record<string, unknown>[]
    } = {},
) {
    const state = {
        rulesets: new Map(liveRulesets().map((r) => [r.id, structuredClone(r)])),
        secrets: options.secret ? ['RELEASE_BOT_PRIVATE_KEY'] : ([] as string[]),
        variables: new Map<string, string>(options.variable ? [['RELEASE_BOT_CLIENT_ID', options.variable]] : []),
        nextId: 30000000,
        secretSetFailures: options.failSecretSet ?? 0,
    }
    const calls: Call[] = []
    const ok = (value: unknown): GhResult => ({ code: 0, stdout: JSON.stringify(value), stderr: '' })
    const gh = async (args: string[], input?: string): Promise<GhResult> => {
        calls.push({ args, input })
        const [verb, ...rest] = args
        if (verb === 'secret' && rest[0] === 'set') {
            if (state.secretSetFailures-- > 0) return { code: 1, stdout: '', stderr: `HTTP 502 echoing ${input ?? ''}` }
            state.secrets.push(rest[1])
            return { code: 0, stdout: '', stderr: '' }
        }
        if (verb === 'variable' && rest[0] === 'set') {
            state.variables.set(rest[1], rest[rest.indexOf('--body') + 1])
            return { code: 0, stdout: '', stderr: '' }
        }
        if (verb !== 'api') return { code: 1, stdout: '', stderr: `unexpected gh ${args.join(' ')}` }
        if (rest[0] === '-X') {
            const [, method, apiPath] = rest
            const body = JSON.parse(input ?? '{}') as Ruleset
            if (method === 'POST' && apiPath === `${REPO}/rulesets`) {
                const id = state.nextId++
                state.rulesets.set(id, asGitHubStores(body, id))
                return ok({ id })
            }
            const id = Number(apiPath.split('/').pop())
            if (method === 'PUT' && state.rulesets.has(id)) {
                state.rulesets.set(id, asGitHubStores(body, id))
                return ok({ id })
            }
            return { code: 1, stdout: '', stderr: `unexpected ${method} ${apiPath}` }
        }
        const apiPath = rest[0].split('?')[0]
        if (apiPath === 'user') return ok({ login: 'jpslav' })
        if (apiPath === REPO) return ok({ permissions: { admin: options.admin ?? true } })
        if (apiPath === 'user/memberships/orgs/safeinsights') return ok({ role: 'admin' })
        if (apiPath === 'orgs/safeinsights/installations')
            return ok({ total_count: 2, installations: options.installations ?? INSTALLATIONS })
        if (apiPath === `${REPO}/environments/release`)
            return ok({
                can_admins_bypass: false,
                deployment_branch_policy: { custom_branch_policies: true, protected_branches: false },
            })
        if (apiPath === `${REPO}/environments/release/deployment-branch-policies`)
            return ok({ branch_policies: [{ name: 'main', type: 'branch' }] })
        if (apiPath === `${REPO}/environments/release/secrets`)
            return ok({ secrets: state.secrets.map((name) => ({ name })) })
        if (apiPath === `${REPO}/environments/release/variables`)
            return ok({ variables: [...state.variables].map(([name, value]) => ({ name, value })) })
        if (apiPath === `${REPO}/rulesets`)
            return ok([...state.rulesets.values()].map((r) => ({ id: r.id, source_type: r.source_type })))
        const rulesetId = /^repos\/safeinsights\/sssb\/rulesets\/(\d+)$/.exec(apiPath)?.[1]
        if (rulesetId && state.rulesets.has(Number(rulesetId))) return ok(state.rulesets.get(Number(rulesetId)))
        if (apiPath === `${REPO}/rules/branches/main`) {
            return ok(
                [...state.rulesets.values()]
                    .filter((r) => r.target === 'branch')
                    .flatMap((r) =>
                        r.rules.map((rule) => ({
                            type: rule.type,
                            ruleset_id: r.id,
                            ruleset_source_type: r.source_type,
                            ruleset_source: r.source_type === 'Organization' ? 'safeinsights' : 'safeinsights/sssb',
                        })),
                    ),
            )
        }
        return { code: 1, stdout: '', stderr: `unexpected gh api ${rest[0]}` }
    }
    return { gh, calls, state }
}

type Answer = { status: number; body?: unknown }
type FetchCall = { method: string; path: string; authorization?: string; body?: unknown }

/** A fake api.github.com. `overrides` replaces the answer for one "METHOD /path". */
function fakeFetch(overrides: Record<string, Answer> = {}) {
    const calls: FetchCall[] = []
    const installation = {
        id: 99,
        account: { login: 'safeinsights' },
        repository_selection: 'selected',
        permissions: { ...RELEASE_APP_PERMISSIONS },
        suspended_at: null,
    }
    const answers: Record<string, Answer> = {
        [`GET /apps/${appSlug('SafeInsights SSSB release')}`]: { status: 404, body: { message: 'Not Found' } },
        'POST /app-manifests/the-code/conversions': {
            status: 201,
            body: {
                id: APP_ID,
                slug: 'safeinsights-sssb-release',
                client_id: CLIENT_ID,
                client_secret: 'never-printed-client-secret',
                webhook_secret: null,
                pem: PEM,
                owner: { login: 'safeinsights' },
                permissions: { ...RELEASE_APP_PERMISSIONS },
            },
        },
        'GET /app': {
            status: 200,
            body: {
                id: APP_ID,
                client_id: CLIENT_ID,
                owner: { login: 'safeinsights' },
                permissions: { ...RELEASE_APP_PERMISSIONS },
            },
        },
        'GET /repos/safeinsights/sssb/installation': { status: 200, body: installation },
        'GET /app/installations': { status: 200, body: [{ id: 99 }] },
        'POST /app/installations/99/access_tokens': { status: 201, body: { token: 'ghs_listingtoken' } },
        'GET /installation/repositories': {
            status: 200,
            body: { total_count: 1, repositories: [{ full_name: 'safeinsights/sssb' }] },
        },
        'DELETE /installation/token': { status: 204 },
        ...overrides,
    }
    const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
        const url = new URL(String(input))
        const method = init?.method ?? 'GET'
        const headers = (init?.headers ?? {}) as Record<string, string>
        calls.push({
            method,
            path: url.pathname,
            authorization: headers.authorization,
            body: init?.body ? JSON.parse(String(init.body)) : undefined,
        })
        const answer = answers[`${method} ${url.pathname}`]
        if (!answer) return new Response(JSON.stringify({ message: 'no fake for this' }), { status: 500 })
        return new Response(answer.status === 204 ? null : JSON.stringify(answer.body), { status: answer.status })
    }) as typeof fetch
    return { fetchFn, calls }
}

/** Plays the operator's browser: opens the form it was shown and follows GitHub's redirect to the loopback. */
async function playBrowser(tmpRoot: string, code = 'the-code') {
    const [dir] = readdirSync(tmpRoot).filter((name) => name.startsWith('sssb-release-app-'))
    const [file] = readdirSync(path.join(tmpRoot, dir))
    const form = readFileSync(path.join(tmpRoot, dir, file), 'utf8')
    const unescape = (s: string) =>
        s
            .replace(/&quot;/g, '"')
            .replace(/&#39;/g, "'")
            .replace(/&lt;/g, '<')
            .replace(/&gt;/g, '>')
            .replace(/&amp;/g, '&')
    const action = unescape(/action="([^"]+)"/.exec(form)?.[1] ?? '')
    const manifest = JSON.parse(unescape(/name="manifest" value="([^"]+)"/.exec(form)?.[1] ?? '')) as {
        redirect_url: string
    }
    const state = new URL(action).searchParams.get('state') ?? ''
    // A stray request first: answered and ignored, never fatal.
    const stray = await fetch(`${manifest.redirect_url}?state=wrong&code=evil`)
    expect(stray.status).toBe(400)
    const real = await fetch(`${manifest.redirect_url}?state=${encodeURIComponent(state)}&code=${code}`)
    expect(real.status).toBe(200)
    return { action, manifest }
}

function harness(
    options: {
        gh?: ReturnType<typeof fakeGh>
        fetch?: ReturnType<typeof fakeFetch>
        answers?: string[]
        tty?: boolean
    } = {},
) {
    const tmpRoot = makeTestTmpDir('release-app-')
    const gh = options.gh ?? fakeGh()
    const http = options.fetch ?? fakeFetch()
    const output: string[] = []
    const answers = [...(options.answers ?? [])]
    let browser: Promise<unknown> | undefined
    const deps: Deps = {
        fetch: http.fetchFn,
        gh: gh.gh,
        io: {
            out: (text) => {
                output.push(text)
                if (text.includes('Waiting for GitHub')) browser = playBrowser(tmpRoot)
            },
            err: (text) => output.push(text),
            ask: async (question) => {
                output.push(question)
                await browser
                return answers.length > 0 ? (answers.shift() ?? null) : ''
            },
        },
        isTTY: options.tty ?? true,
        tmpRoot,
        callbackTimeoutMs: 5000,
    }
    return { deps, gh, http, output, tmpRoot, text: () => output.join('\n'), browser: () => browser }
}

const keyBody = PEM.split('\n')[1]

describe('release-app create', () => {
    it('creates, stores the key on stdin only, reads back, and shows the ruleset plan without applying it', async () => {
        const h = harness()
        const code = await createCommand(h.deps, { applyBypass: false })
        await h.browser()
        expect(code, h.text()).toBe(0)

        // The key went to `gh secret set` on stdin, and nowhere else: not argv, not output.
        const secretSet = h.gh.calls.filter((c) => c.args[0] === 'secret')
        expect(secretSet).toEqual([
            {
                args: ['secret', 'set', 'RELEASE_BOT_PRIVATE_KEY', '--env', 'release', '--repo', 'safeinsights/sssb'],
                input: PEM,
            },
        ])
        for (const call of h.gh.calls) expect(call.args.join(' ')).not.toContain(keyBody)
        expect(h.text()).not.toContain(keyBody)
        expect(h.text()).not.toContain('never-printed-client-secret')
        expect(h.gh.state.variables.get('RELEASE_BOT_CLIENT_ID')).toBe(CLIENT_ID)

        // The exchange ran once, and the readback authenticated as the App.
        expect(h.http.calls.filter((c) => c.path.includes('/conversions'))).toHaveLength(1)
        expect(h.http.calls.find((c) => c.path === '/app')?.authorization).toMatch(/^Bearer eyJ/)
        // The listing token asked for metadata only, and was revoked.
        expect(h.http.calls.find((c) => c.path.endsWith('/access_tokens'))?.body).toEqual({
            permissions: { metadata: 'read' },
        })
        expect(h.http.calls.some((c) => c.method === 'DELETE' && c.path === '/installation/token')).toBe(true)

        // Shown, not applied.
        expect(h.text()).toContain(`CREATE ruleset "${MAIN_HISTORY}"`)
        expect(h.text()).toContain('Not applied. Re-run with --apply')
        expect(h.gh.calls.some((c) => c.args[1] === '-X')).toBe(false)
        expect(h.text()).toContain('"require-pr" (7484436: deletion, non_fast_forward, pull_request)')
        expect(h.text()).toContain('also lets Integration 4038189 (always) bypass it')
        // The form's private directory is gone.
        expect(readdirSync(h.tmpRoot)).toEqual([])
    })

    it('posts a manifest with exactly the App permissions to the organisation, with the state on the action URL', async () => {
        const h = harness()
        const seen = { action: '', manifest: {} as Record<string, unknown> }
        const out = h.deps.io.out
        h.deps.io.out = (text) => {
            out(text)
            if (text.includes('Waiting for GitHub'))
                void h.browser()?.then((r) => Object.assign(seen, r as typeof seen))
        }
        await createCommand(h.deps, { applyBypass: false })
        expect(seen.action).toMatch(
            /^https:\/\/github\.com\/organizations\/safeinsights\/settings\/apps\/new\?state=[0-9a-f-]{36}$/,
        )
        expect(seen.manifest).toMatchObject({
            public: false,
            default_permissions: { contents: 'write', metadata: 'read' },
            default_events: [],
            hook_attributes: { active: false },
        })
        expect(seen.manifest.redirect_url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/callback$/)
    })

    it('applies the ruleset plan with --apply-bypass once "apply" is typed, no-bypass rulesets first', async () => {
        const h = harness({ answers: ['', 'apply'] })
        const code = await createCommand(h.deps, { applyBypass: true })
        expect(code, h.text()).toBe(0)
        const writes = h.gh.calls
            .filter((c) => c.args[1] === '-X')
            .map((c) => [c.args[2], (JSON.parse(c.input ?? '{}') as Ruleset).name])
        expect(writes).toEqual([
            ['POST', MAIN_HISTORY],
            ['POST', TAGS_IMMUTABLE],
            ['PUT', MAIN_CHECKS],
            ['PUT', TAGS_CREATE],
        ])
        expect(h.text()).toContain('read back: the rulesets match the plan')
        // Applied once, the plan is empty.
        expect(planBypass([...h.gh.state.rulesets.values()], APP_ID).changes).toEqual([])
    })

    it('does not apply when anything but "apply" is typed', async () => {
        const h = harness({ answers: ['', 'yes'] })
        await createCommand(h.deps, { applyBypass: true })
        expect(h.gh.calls.some((c) => c.args[1] === '-X')).toBe(false)
    })

    it('refuses before anything exists when the environment already holds the key', async () => {
        const h = harness({ gh: fakeGh({ secret: true }) })
        expect(await createCommand(h.deps, { applyBypass: false })).toBe(1)
        expect(h.text()).toContain('a release app may already exist')
        expect(h.http.calls).toEqual([])
        expect(h.browser()).toBeUndefined()
    })

    it('refuses when the operator cannot administer the repository', async () => {
        const h = harness({ gh: fakeGh({ admin: false }) })
        expect(await createCommand(h.deps, { applyBypass: false })).toBe(1)
        expect(h.text()).toContain('is not an administrator of safeinsights/sssb')
    })

    it('refuses without a terminal', async () => {
        const h = harness({ tty: false })
        expect(await createCommand(h.deps, { applyBypass: false })).toBe(1)
        expect(h.gh.calls).toEqual([])
    })

    it('refuses a name GitHub would refuse, before anything else', async () => {
        const h = harness()
        expect(await createCommand(h.deps, { name: 'x'.repeat(35), applyBypass: false })).toBe(1)
        expect(h.gh.calls).toEqual([])
    })

    it('does not store the key of an App wider than it asked for', async () => {
        const wide = fakeFetch({
            'POST /app-manifests/the-code/conversions': {
                status: 201,
                body: {
                    id: APP_ID,
                    slug: 's',
                    client_id: CLIENT_ID,
                    pem: PEM,
                    owner: { login: 'safeinsights' },
                    permissions: { contents: 'write', metadata: 'read', pull_requests: 'write' },
                },
            },
        })
        const h = harness({ fetch: wide })
        expect(await createCommand(h.deps, { applyBypass: false })).toBe(1)
        expect(h.gh.calls.some((c) => c.args[0] === 'secret')).toBe(false)
        expect(h.text()).toContain('its key was NOT stored')
        expect(h.text()).toContain('pull_requests: write is held but NOT needed')
    })

    it('does not store the key of an App owned by another account', async () => {
        const elsewhere = fakeFetch({
            'POST /app-manifests/the-code/conversions': {
                status: 201,
                body: {
                    id: APP_ID,
                    slug: 's',
                    client_id: CLIENT_ID,
                    pem: PEM,
                    owner: { login: 'jpslav' },
                    permissions: { ...RELEASE_APP_PERMISSIONS },
                },
            },
        })
        const h = harness({ fetch: elsewhere })
        expect(await createCommand(h.deps, { applyBypass: false })).toBe(1)
        expect(h.gh.calls.some((c) => c.args[0] === 'secret')).toBe(false)
    })

    it('retries storing the key while it is in memory, and redacts it from gh errors', async () => {
        const h = harness({ gh: fakeGh({ failSecretSet: 1 }) })
        expect(await createCommand(h.deps, { applyBypass: false })).toBe(0)
        expect(h.gh.calls.filter((c) => c.args[0] === 'secret')).toHaveLength(2)
        expect(h.text()).toContain('THE PRIVATE KEY WAS NOT STORED')
        expect(h.text()).toContain('[REDACTED KEY]')
        expect(h.text()).not.toContain(keyBody)
    })

    it('retries a failed manifest exchange while the code is still good', async () => {
        let first = true
        const flaky = fakeFetch()
        const real = flaky.fetchFn
        const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
            if (first && String(input).includes('/conversions')) {
                first = false
                return new Response('bad gateway', { status: 502 })
            }
            return real(input, init)
        }) as typeof fetch
        const h = harness({ fetch: { ...flaky, fetchFn } })
        expect(await createCommand(h.deps, { applyBypass: false }), h.text()).toBe(0)
        expect(h.text()).toContain('The manifest exchange failed (HTTP 502)')
        expect(h.gh.calls.filter((c) => c.args[0] === 'secret')).toHaveLength(1)
    })

    it('stops cleanly when the operator gives up on the key', async () => {
        const h = harness({ gh: fakeGh({ failSecretSet: 5 }), answers: ['give up'] })
        expect(await createCommand(h.deps, { applyBypass: false })).toBe(1)
        expect(h.gh.calls.some((c) => c.args[0] === 'variable')).toBe(false)
        expect(h.text()).toContain('the key was discarded')
    })

    it('does not offer the bypass when the installation reaches more than this repository', async () => {
        const all = fakeFetch({
            'GET /installation/repositories': {
                status: 200,
                body: {
                    total_count: 2,
                    repositories: [{ full_name: 'safeinsights/sssb' }, { full_name: 'safeinsights/other' }],
                },
            },
        })
        const h = harness({ fetch: all, answers: ['', 'apply'] })
        expect(await createCommand(h.deps, { applyBypass: true })).toBe(1)
        expect(h.gh.calls.some((c) => c.args[1] === '-X')).toBe(false)
        expect(h.text()).toContain('it must reach safeinsights/sssb and nothing else')
    })
})

describe('release-app verify and bypass', () => {
    it('verify with the key passes once everything is in place, and changes nothing', async () => {
        const gh = fakeGh({ secret: true, variable: CLIENT_ID })
        const apply = harness({ gh, answers: ['apply'] })
        expect(await bypassCommand(apply.deps, { appId: APP_ID, apply: true })).toBe(1) // the org step is still by hand
        const org = gh.state.rulesets.get(7484436)
        if (org) org.bypass_actors = [{ actor_id: APP_ID, actor_type: 'Integration', bypass_mode: 'always' }]

        const h = harness({ gh })
        const before = gh.calls.length
        expect(await verifyCommand(h.deps, { appId: APP_ID, privateKey: PEM }), h.text()).toBe(0)
        expect(gh.calls.slice(before).filter((c) => c.args[0] !== 'api' || c.args[1] === '-X')).toEqual([])
        expect(h.text()).toContain('All checks passed')
    })

    it("verify fails on a client id that is not the App's", async () => {
        const h = harness({ gh: fakeGh({ secret: true, variable: 'Iv23other' }) })
        expect(await verifyCommand(h.deps, { appId: APP_ID, privateKey: PEM })).toBe(1)
        expect(h.text()).toContain("but this App's client id is not that")
    })

    it('verify without the key still checks the environment and rulesets', async () => {
        const h = harness({ gh: fakeGh() })
        expect(await verifyCommand(h.deps, { appId: APP_ID })).toBe(1)
        expect(h.text()).toContain('has no secret RELEASE_BOT_PRIVATE_KEY')
        expect(h.http.calls).toEqual([])
    })

    it('bypass refuses an App id that is not the release app, before planning anything', async () => {
        for (const appId of [4038189, 12345]) {
            const h = harness({ gh: fakeGh({ secret: true, variable: CLIENT_ID }), answers: ['apply'] })
            expect(await bypassCommand(h.deps, { appId, apply: true })).toBe(1)
            expect(h.text()).toContain('is not shown to be the release app')
            expect(h.gh.calls.some((c) => c.args[1] === '-X')).toBe(false)
            expect(h.gh.calls.some((c) => c.args[1]?.includes('/rulesets'))).toBe(false)
        }
    })

    it('verify without the key fails on an App that is installed on all repositories', async () => {
        const wide = INSTALLATIONS.map((i) => (i.app_id === APP_ID ? { ...i, repository_selection: 'all' } : i))
        const h = harness({ gh: fakeGh({ secret: true, variable: CLIENT_ID, installations: wide }) })
        expect(await verifyCommand(h.deps, { appId: APP_ID })).toBe(1)
        expect(h.text()).toContain('is installed on "all" repositories')
    })

    it('bypass --apply needs a terminal', async () => {
        const h = harness({ tty: false })
        expect(await bypassCommand(h.deps, { appId: APP_ID, apply: true })).toBe(1)
    })
})

describe('planBypass', () => {
    it('plans the four rulesets from the live shape, creates first', () => {
        const plan = planBypass(liveRulesets(), APP_ID)
        expect(plan.problems).toEqual([])
        expect(plan.changes.map((c) => [c.kind, c.kind === 'create' ? c.body.name : c.before.name])).toEqual([
            ['create', MAIN_HISTORY],
            ['create', TAGS_IMMUTABLE],
            ['update', MAIN_CHECKS],
            ['update', TAGS_CREATE],
        ])
        const after = Object.fromEntries(
            plan.changes.map((c) => [
                c.kind === 'create' ? c.body.name : c.after.name,
                c.kind === 'create' ? c.body : c.after,
            ]),
        )
        const app = [{ actor_id: APP_ID, actor_type: 'Integration', bypass_mode: 'always' }]
        expect(after[MAIN_HISTORY]).toMatchObject({
            target: 'branch',
            rules: [{ type: 'deletion' }, { type: 'non_fast_forward' }],
            bypass_actors: [],
        })
        expect(after[TAGS_IMMUTABLE]).toMatchObject({
            target: 'tag',
            conditions: { ref_name: { include: ['refs/tags/v*'] } },
            rules: [{ type: 'update' }, { type: 'deletion' }, { type: 'non_fast_forward' }],
            bypass_actors: [],
        })
        expect(after[TAGS_CREATE]).toMatchObject({ rules: [{ type: 'creation' }], bypass_actors: app })
        // main's checks keep their rules; only the bypass changes.
        expect(after[MAIN_CHECKS].rules).toEqual(liveRulesets()[1].rules)
        expect(after[MAIN_CHECKS].bypass_actors).toEqual(app)
    })

    it('removes any other bypass actor: the App is the ONLY one', () => {
        const rulesets = liveRulesets()
        rulesets[2].bypass_actors = [{ actor_id: 5, actor_type: 'RepositoryRole', bypass_mode: 'always' }]
        const change = planBypass(rulesets, APP_ID).changes.find(
            (c) => c.kind === 'update' && c.before.name === TAGS_CREATE,
        )
        expect(change?.kind === 'update' && change.after.bypass_actors).toEqual([
            { actor_id: APP_ID, actor_type: 'Integration', bypass_mode: 'always' },
        ])
    })

    it('refuses to plan around a missing, duplicated or unexpected ruleset', () => {
        expect(
            planBypass(
                liveRulesets().filter((r) => r.name !== MAIN_CHECKS),
                APP_ID,
            ).problems,
        ).toEqual([`no repository ruleset named "${MAIN_CHECKS}"; it holds main's required checks`])
        const twice = [...liveRulesets(), { ...liveRulesets()[2], id: 1 }]
        expect(planBypass(twice, APP_ID).problems[0]).toMatch(/2 repository rulesets are named/)
        const extra = liveRulesets()
        extra[2].rules.push({ type: 'tag_name_pattern' })
        const plan = planBypass(extra, APP_ID)
        expect(plan.problems[0]).toMatch(/carries rules this tool would drop \(tag_name_pattern\)/)
        expect(plan.changes).toEqual([])
        expect(planBypass(liveRulesets(), 0).problems[0]).toMatch(/positive integer/)
    })

    it('refuses to bypass a main ruleset that carries more than the checks', () => {
        const rulesets = liveRulesets()
        rulesets[1].rules.push({ type: 'pull_request' })
        expect(planBypass(rulesets, APP_ID).problems[0]).toMatch(/the App would bypass all of it/)
    })
})

describe('externalGates', () => {
    const onMain = (rulesets: Ruleset[]) =>
        rulesets
            .filter((r) => r.target === 'branch')
            .flatMap((r) =>
                r.rules.map((rule) => ({
                    type: rule.type,
                    ruleset_id: r.id,
                    ruleset_source_type: r.source_type,
                    ruleset_source: 'x',
                })),
            )

    it('reports the org ruleset on main, whether it lists the App always, and who else bypasses it', () => {
        const rulesets = liveRulesets()
        expect(externalGates(onMain(rulesets), rulesets, APP_ID)).toEqual({
            org: [
                {
                    id: 7484436,
                    name: 'require-pr',
                    types: ['deletion', 'non_fast_forward', 'pull_request'],
                    app: 'missing',
                    others: [{ actor_id: 4038189, actor_type: 'Integration', bypass_mode: 'always' }],
                },
            ],
            problems: [],
        })
        rulesets[0].bypass_actors = [{ actor_id: APP_ID, actor_type: 'Integration', bypass_mode: 'pull_request' }]
        expect(externalGates(onMain(rulesets), rulesets, APP_ID).org[0]).toMatchObject({
            app: 'wrong-mode',
            others: [],
        })
        rulesets[0].bypass_actors = [{ actor_id: APP_ID, actor_type: 'Integration', bypass_mode: 'always' }]
        expect(externalGates(onMain(rulesets), rulesets, APP_ID).org[0].app).toBe('listed')
    })

    it('flags another repository ruleset on main, and any tag ruleset covering a release tag', () => {
        const extra: Ruleset = { ...liveRulesets()[1], id: 5, name: 'main: reviews', rules: [{ type: 'pull_request' }] }
        const orgTags: Ruleset = {
            ...liveRulesets()[2],
            id: 6,
            name: 'org tags',
            source_type: 'Organization',
            conditions: { ref_name: { include: ['~ALL'], exclude: [] } },
            rules: [{ type: 'creation' }],
        }
        const rulesets = [...liveRulesets(), extra, orgTags]
        const gates = externalGates(onMain(rulesets), rulesets, APP_ID)
        expect(gates.problems).toEqual([
            'repository ruleset "main: reviews" (5, pull_request) also applies to the release\'s push, and this tool does not manage it',
        ])
        expect(gates.org.map((g) => [g.name, g.app])).toEqual([
            ['require-pr', 'missing'],
            ['org tags', 'missing'],
        ])
    })

    it('ignores rulesets that cannot refuse the push, and tag rulesets that miss v tags', () => {
        const history: Ruleset = { ...liveRulesets()[0], id: 7, name: 'org history', rules: [{ type: 'deletion' }] }
        const otherTags: Ruleset = {
            ...liveRulesets()[2],
            id: 8,
            name: 'build tags',
            source_type: 'Organization',
            conditions: { ref_name: { include: ['refs/tags/build-*'], exclude: [] } },
        }
        const rulesets = [history, otherTags]
        expect(externalGates(onMain(rulesets), rulesets, APP_ID)).toEqual({ org: [], problems: [] })
    })
})

describe('the pure checks', () => {
    it('permissions match exactly, in both directions', () => {
        expect(permissionFindings({ contents: 'write', metadata: 'read' })).toEqual([])
        expect(permissionFindings({ contents: 'read', metadata: 'read' })).toEqual([
            'permission contents is "read", weaker than the required "write"',
        ])
        expect(permissionFindings({ contents: 'admin', metadata: 'read' })[0]).toMatch(/STRONGER/)
        expect(permissionFindings({ contents: 'write', metadata: 'read', workflows: 'write' })).toEqual([
            'permission workflows: write is held but NOT needed',
        ])
        expect(permissionFindings({ metadata: 'read' })).toEqual(['missing permission contents: write'])
    })

    it('an installation passes only selected, on this repository alone, on safeinsights, not suspended', () => {
        const good = {
            id: 1,
            account: { login: 'safeinsights' },
            repository_selection: 'selected',
            permissions: { ...RELEASE_APP_PERMISSIONS },
        }
        expect(installationFindings(good, ['safeinsights/sssb'])).toEqual([])
        expect(installationFindings({ ...good, repository_selection: 'all' }, ['safeinsights/sssb'])[0]).toMatch(
            /expected "selected"/,
        )
        expect(installationFindings({ ...good, repository_selection: undefined }, ['safeinsights/sssb'])).toHaveLength(
            1,
        )
        expect(installationFindings(good, null)[0]).toMatch(/UNCHECKED/)
        expect(installationFindings(good, ['safeinsights/sssb', 'safeinsights/x'])[0]).toMatch(/nothing else/)
        expect(installationFindings({ ...good, suspended_at: '2026-01-01' }, ['safeinsights/sssb'])[0]).toMatch(
            /SUSPENDED/,
        )
        expect(installationFindings({ ...good, account: { login: 'jpslav' } }, ['safeinsights/sssb'])[0]).toMatch(
            /not safeinsights/,
        )
    })

    it('the manifest asks for exactly the App permissions, privately, with no webhook', () => {
        const manifest = appManifest('http://127.0.0.1:1/callback')
        expect(manifest.default_permissions).toEqual(RELEASE_APP_PERMISSIONS)
        expect(manifest).toMatchObject({
            public: false,
            default_events: [],
            hook_attributes: { active: false },
            request_oauth_on_install: false,
        })
    })

    it('the creation form escapes what it embeds', () => {
        const form = creationForm(
            'https://x/?a=1&b="2"',
            appManifest('http://127.0.0.1:1/callback', '"><script>alert(1)</script>'),
        )
        expect(form).not.toContain('<script>alert')
        expect(form).toContain('&quot;&gt;&lt;script&gt;')
        expect(form).toContain('a=1&amp;b=&quot;2&quot;')
    })

    it('redact strips keys, tokens and JWTs, even a key cut short', () => {
        const jwt = appJwt('1', PEM)
        expect(redact(`a ${PEM.trim()} b ghs_abc123 c ${jwt} d`)).toBe(
            'a [REDACTED KEY] b [REDACTED TOKEN] c [REDACTED JWT] d',
        )
        expect(redact(PEM.slice(0, 120))).toBe('[REDACTED KEY]')
        expect(redact('github_pat_11AAA_bbb')).toBe('[REDACTED TOKEN]')
    })
})

describe('the loopback callback server', () => {
    it('binds 127.0.0.1, ignores the wrong state, a missing code, other paths and malformed requests', async () => {
        const server = await startCallbackServer('s1', 5000)
        try {
            const base = `http://127.0.0.1:${server.port}`
            expect((await fetch(`${base}/elsewhere`)).status).toBe(404)
            expect((await fetch(`${base}/callback?state=s2&code=c`)).status).toBe(400)
            expect((await fetch(`${base}/callback?state=s1`)).status).toBe(400)
            expect((await fetch(`${base}/callback?state=s1&code=c1`)).status).toBe(200)
            expect(await server.code).toBe('c1')
        } finally {
            server.close()
        }
    })

    it('times out rather than waiting forever', async () => {
        const server = await startCallbackServer('s1', 20)
        await expect(server.code).rejects.toThrow(/timed out/)
        server.close()
    })
})
