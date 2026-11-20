/**
 * `pnpm release-app <create|verify|bypass>`: makes SSSB's release app by GitHub's App-manifest flow, stores
 * its key where release.yml reads it, reads the result back, and makes it the only bypass on the rulesets
 * for `main` and the release tags. Borrowed from CanopyCMS's `src/cli/init-github-app.ts`; see
 * docs/runbooks/release-app.md for the steps JP follows.
 *
 * Run by an owner of the safeinsights organisation, on their own machine, in a terminal. Nothing in CI runs
 * it, and it is never run on JP's behalf.
 *
 * THE KEY. GitHub hands the private key to this process once, in the manifest exchange. It goes straight to
 * `gh secret set` on STDIN, so it never touches disk and never appears in argv, a log or the terminal. If
 * that fails, the operator can retry while the key is still in memory; giving up loses nothing that matters,
 * since a fresh key can be generated on the App's page. The only file this writes is the creation form (the
 * manifest, no key), in a private temporary directory it removes.
 *
 * THE APP'S REACH. `RELEASE_APP_PERMISSIONS` (contents: write, metadata: read) on one repository, checked
 * in the manifest, in the exchange's answer (before the key is stored), on the installation read back as the
 * App after JP installs it, and in the organisation's list of installations (`identifyApp`, which also gates
 * `bypass` and `verify`). Its rulesets are in rulesets.ts.
 */
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import {
    APP_NAME_MAX_LENGTH,
    CLIENT_ID_VARIABLE,
    DEFAULT_APP_NAME,
    KEY_SECRET,
    NPM_PUBLISH_ENVIRONMENT,
    RELEASE_APP_PERMISSIONS,
    RELEASE_ENVIRONMENT,
    RELEASE_REPO,
    appManifest,
    appSlug,
    creationForm,
    installationFindings,
    manifestPostUrl,
    permissionFindings,
    resultPage,
    type InstallationSummary,
} from './manifest'
import { describeChange, externalGates, planBypass, type ActiveRule, type Ruleset } from './rulesets'
import { appJwt, errorMessage, ghJson, githubRequest, redact, type FetchFn, type GhRunner } from './github'

const CALLBACK_TIMEOUT_MS = 10 * 60 * 1000
const REPO = `${RELEASE_REPO.owner}/${RELEASE_REPO.repo}`

type Io = {
    out: (text: string) => void
    err: (text: string) => void
    /** One line from the operator; `null` once their input has ended. */
    ask: (question: string) => Promise<string | null>
}

export type Deps = {
    fetch: FetchFn
    gh: GhRunner
    io: Io
    isTTY: boolean
    /** Where the creation form's private directory is made. */
    tmpRoot: string
    callbackTimeoutMs?: number
}

type CallbackServer = { port: number; code: Promise<string>; close: () => void }

/**
 * A one-request loopback server for GitHub's redirect, bound to 127.0.0.1 only. A request with the wrong
 * `state` or no `code` is answered and ignored, never fatal: ending the run on a stray request could come
 * before GitHub's real redirect and leave an App whose key nobody holds. Every path through the handler is
 * inside the try, because a throw there would end the process while it holds the key.
 */
export function startCallbackServer(state: string, timeoutMs = CALLBACK_TIMEOUT_MS): Promise<CallbackServer> {
    let settle: (value: string) => void = () => {}
    let fail: (error: Error) => void = () => {}
    const code = new Promise<string>((resolve, reject) => {
        settle = resolve
        fail = reject
    })
    // Marks `code` handled without consuming it, so a failure before anyone awaits it is not reported as an
    // unhandled rejection.
    code.catch(() => {})
    let stopListening = () => {}

    const server = createServer((req, res) => {
        try {
            const url = new URL(req.url ?? '/', 'http://127.0.0.1')
            if (url.pathname !== '/callback') {
                res.writeHead(404).end()
                return
            }
            if (url.searchParams.get('state') !== state) {
                res.writeHead(400, { 'content-type': 'text/html' }).end(
                    resultPage('Not this flow', 'Ignoring this request; still waiting.'),
                )
                return
            }
            const received = url.searchParams.get('code')
            if (!received) {
                res.writeHead(400, { 'content-type': 'text/html' }).end(
                    resultPage('No code', 'Ignoring this request; still waiting.'),
                )
                return
            }
            res.writeHead(200, { 'content-type': 'text/html', connection: 'close' }).end(
                resultPage('App created', 'Return to the terminal.'),
            )
            settle(received)
            // Closed here, not later: the install step that follows waits on a human for as long as it takes,
            // and a loopback listener is reachable by every user on the machine.
            stopListening()
        } catch {
            try {
                res.writeHead(400).end()
            } catch {
                // The socket is already gone.
            }
        }
    })

    return new Promise<CallbackServer>((resolve, reject) => {
        let listening = false
        server.on('error', (err) => (listening ? fail(err) : reject(err)))
        server.listen(0, '127.0.0.1', () => {
            listening = true
            const timer = setTimeout(() => fail(new Error('timed out waiting for the GitHub redirect')), timeoutMs)
            timer.unref()
            stopListening = () => {
                clearTimeout(timer)
                server.close()
            }
            resolve({ port: (server.address() as AddressInfo).port, code, close: () => stopListening() })
        })
    })
}

type CreatedApp = {
    id: number
    slug: string
    clientId: string
    pem: string
    owner: string | null
    permissions: Record<string, string>
}

/**
 * The manifest exchange: the one call that returns the private key. Only the fields this needs are lifted
 * out; the answer also carries `client_secret` and `webhook_secret`, which are never kept or printed.
 */
async function convertManifest(fetchFn: FetchFn, code: string): Promise<{ app: CreatedApp | null; status: number }> {
    const response = await githubRequest<{
        id?: unknown
        slug?: unknown
        client_id?: unknown
        pem?: unknown
        owner?: { login?: unknown }
        permissions?: unknown
    }>(fetchFn, `/app-manifests/${encodeURIComponent(code)}/conversions`, { method: 'POST' })
    if (!response.ok || !response.body) return { app: null, status: response.status }
    const { id, slug, client_id: clientId, pem, owner, permissions } = response.body
    if (typeof id !== 'number' || typeof slug !== 'string' || typeof clientId !== 'string' || typeof pem !== 'string')
        return { app: null, status: response.status }
    const app = {
        id,
        slug,
        clientId,
        pem,
        owner: typeof owner?.login === 'string' ? owner.login : null,
        permissions: isStringRecord(permissions) ? permissions : {},
    }
    return { app, status: response.status }
}

function isStringRecord(value: unknown): value is Record<string, string> {
    return (
        typeof value === 'object' &&
        value !== null &&
        !Array.isArray(value) &&
        Object.values(value).every((v) => typeof v === 'string')
    )
}

type Environment = {
    can_admins_bypass?: boolean
    deployment_branch_policy?: { custom_branch_policies?: boolean; protected_branches?: boolean } | null
}

/** Each environment release.yml uses, and the one deployment ref its header says it allows. */
const ENVIRONMENT_RULES = [
    { name: RELEASE_ENVIRONMENT, ref: 'branch:main', described: 'the branch main' },
    { name: NPM_PUBLISH_ENVIRONMENT, ref: 'tag:v*', described: 'the tags v*' },
] as const

/**
 * What is wrong with one of release.yml's environments, as findings. release.yml's header says what each must be:
 * `release` deploys from `main` only and `npm-publish` from `v*` tags only, administrators not exempt in either. A
 * secret stored in, or a trusted publisher naming, an environment without that rule is in reach of a workflow on any
 * ref. An environment that cannot be read (one not created yet included) is a finding too.
 */
async function environmentFindings(gh: GhRunner, rule: (typeof ENVIRONMENT_RULES)[number]): Promise<string[]> {
    const base = `repos/${REPO}/environments/${rule.name}`
    const env = await ghJson<Environment>(gh, base)
    if (!env.value) return [`could not read the "${rule.name}" environment: ${env.error}`]
    const findings: string[] = []
    if (env.value.can_admins_bypass !== false) findings.push('administrators can bypass its rules; they must not')
    const policy = env.value.deployment_branch_policy
    if (!policy || policy.custom_branch_policies !== true || policy.protected_branches !== false) {
        findings.push('it does not restrict deployments to selected branches and tags')
    } else {
        const branches = await ghJson<{ branch_policies?: { name?: string; type?: string }[] }>(
            gh,
            `${base}/deployment-branch-policies?per_page=100`,
        )
        const listed = (branches.value?.branch_policies ?? []).map((p) => `${p.type ?? 'branch'}:${p.name}`)
        if (!branches.value) findings.push(`could not read its deployment branches: ${branches.error}`)
        else if (listed.length !== 1 || listed[0] !== rule.ref)
            findings.push(`its deployment refs are ${JSON.stringify(listed)}; expected only ${rule.described}`)
    }
    return findings.map((finding) => `environment "${rule.name}": ${finding}`)
}

/** Every environment's findings, in ENVIRONMENT_RULES' order. */
async function allEnvironmentFindings(gh: GhRunner): Promise<string[]> {
    const findings: string[] = []
    for (const rule of ENVIRONMENT_RULES) findings.push(...(await environmentFindings(gh, rule)))
    return findings
}

type Credentials = { secret: boolean; variable: string | null; error: string }

/** Whether the environment holds the App's key (a name only: secrets cannot be read back) and client id. */
async function readCredentials(gh: GhRunner): Promise<Credentials> {
    const base = `repos/${REPO}/environments/${RELEASE_ENVIRONMENT}`
    const secrets = await ghJson<{ secrets?: { name?: string }[] }>(gh, `${base}/secrets?per_page=100`)
    const variables = await ghJson<{ variables?: { name?: string; value?: string }[] }>(
        gh,
        `${base}/variables?per_page=30`,
    )
    if (!secrets.value || !variables.value) {
        return { secret: false, variable: null, error: secrets.error || variables.error }
    }
    const variable = (variables.value.variables ?? []).find((v) => v.name === CLIENT_ID_VARIABLE)
    return {
        secret: (secrets.value.secrets ?? []).some((s) => s.name === KEY_SECRET),
        variable: typeof variable?.value === 'string' ? variable.value : null,
        error: '',
    }
}

/** Read-only checks before anything is created. Every finding stops the run. */
async function preflight(deps: Deps): Promise<string[]> {
    const { gh } = deps
    const findings: string[] = []
    const user = await ghJson<{ login?: string }>(gh, 'user')
    if (!user.value?.login) return [`gh is not signed in to github.com (${user.error}); run \`gh auth login\``]
    const repo = await ghJson<{ permissions?: { admin?: boolean } }>(gh, `repos/${REPO}`)
    if (repo.value?.permissions?.admin !== true) {
        findings.push(`${user.value.login} is not an administrator of ${REPO}, so cannot set the environment's secret`)
    }
    const membership = await ghJson<{ role?: string }>(gh, `user/memberships/orgs/${RELEASE_REPO.owner}`)
    if (membership.value?.role !== 'admin') {
        deps.io.out(
            `! ${user.value.login} does not appear to be an owner of ${RELEASE_REPO.owner} ` +
                `(${membership.value?.role ?? membership.error}). Creating an organisation App needs an owner or an ` +
                'App manager; GitHub will say so at the form if neither.\n',
        )
    }
    findings.push(...(await allEnvironmentFindings(gh)))
    const credentials = await readCredentials(gh)
    if (credentials.error) findings.push(`could not read the environment's secrets and variables: ${credentials.error}`)
    if (credentials.secret || credentials.variable !== null) {
        findings.push(
            `the "${RELEASE_ENVIRONMENT}" environment already holds ${KEY_SECRET} or ${CLIENT_ID_VARIABLE}, so a ` +
                'release app may already exist. Check it with `pnpm release-app verify`; to start over, delete ' +
                'the App and both values first.',
        )
    }
    return findings
}

/**
 * Hand the key to `gh secret set` on stdin, and keep offering a retry while it is still in memory. Only the
 * operator ends the loop without storing it.
 */
async function storeKey(deps: Deps, pem: string): Promise<boolean> {
    for (;;) {
        const result = await deps.gh(['secret', 'set', KEY_SECRET, '--env', RELEASE_ENVIRONMENT, '--repo', REPO], pem)
        if (result.code === 0) return true
        deps.io.err(
            `\n  THE PRIVATE KEY WAS NOT STORED: gh exited ${result.code}: ${redact(result.stderr.trim())}\n` +
                '  This process holds the only copy of the key. Fix gh in another terminal if you can.',
        )
        const answer = await deps.io.ask('  Press Enter to try again, or type "give up" to discard the key.')
        if (answer === null || answer.trim().toLowerCase() === 'give up') return false
    }
}

async function storeClientId(deps: Deps, clientId: string): Promise<boolean> {
    for (;;) {
        const result = await deps.gh([
            'variable',
            'set',
            CLIENT_ID_VARIABLE,
            '--env',
            RELEASE_ENVIRONMENT,
            '--repo',
            REPO,
            '--body',
            clientId,
        ])
        if (result.code === 0) return true
        deps.io.err(`\n  The client id was not stored: gh exited ${result.code}: ${redact(result.stderr.trim())}`)
        const answer = await deps.io.ask('  Press Enter to try again, or type "skip" to set it by hand later.')
        if (answer === null || answer.trim().toLowerCase() === 'skip') return false
    }
}

/**
 * Read the App and its installation back AS THE APP, with the key in memory: what it may do, where it is
 * installed, and what that installation reaches. Every check fails closed; "could not read" never passes.
 */
async function readBack(
    deps: Deps,
    appId: string,
    pem: string,
    clientId: string | null,
): Promise<{ ok: boolean; installationId: number | null }> {
    const { fetch: fetchFn, io } = deps
    let jwt: string
    try {
        jwt = appJwt(appId, pem)
    } catch (err) {
        io.err(`\nThe private key could not sign a JWT: ${redact(errorMessage(err))}`)
        return { ok: false, installationId: null }
    }
    const findings: string[] = []

    const app = await githubRequest<{
        id?: number
        client_id?: string
        owner?: { login?: string }
        permissions?: Record<string, string>
    }>(fetchFn, '/app', { jwt })
    if (!app.ok || !app.body) {
        io.err(
            app.status === 0
                ? `\nCould not reach api.github.com: ${app.message}`
                : `\nThe App could not AUTHENTICATE (HTTP ${app.status}: ${app.message}). Either the key is not ` +
                      "this App's, or the App id is wrong.",
        )
        return { ok: false, installationId: null }
    }
    if (String(app.body.id) !== appId) findings.push(`the key belongs to App ${app.body.id}, not ${appId}`)
    if (app.body.owner?.login !== RELEASE_REPO.owner) {
        findings.push(`the App is owned by ${JSON.stringify(app.body.owner?.login ?? null)}, not ${RELEASE_REPO.owner}`)
    }
    findings.push(...permissionFindings(app.body.permissions ?? {}).map((f) => `the App's own ${f}`))
    if (clientId !== null && app.body.client_id !== clientId) {
        findings.push(`${CLIENT_ID_VARIABLE} is ${JSON.stringify(clientId)}, but this App's client id is not that`)
    }

    const found = await githubRequest<InstallationSummary>(fetchFn, `/repos/${REPO}/installation`, { jwt })
    if (!found.ok || !found.body) {
        findings.push(
            found.status === 404
                ? `the App is not installed on ${REPO}`
                : `could not read the App's installation on ${REPO} (HTTP ${found.status}: ${found.message})`,
        )
        report(io, findings)
        return { ok: false, installationId: null }
    }
    const installation = found.body

    const listed = await githubRequest<unknown[]>(fetchFn, '/app/installations?per_page=100', { jwt })
    if (!listed.ok || !Array.isArray(listed.body)) {
        findings.push('could not list the App\'s installations, so "installed once" is UNCHECKED')
    } else if (listed.body.length !== 1) {
        findings.push(
            `the App is installed ${listed.body.length} times; its key is App-level and reaches every installation`,
        )
    }

    // A token for listing only: metadata read and nothing else, not narrowed to one repository (narrowing it
    // would hide exactly the extra repositories this is looking for), revoked at once.
    let repositories: string[] | null = null
    const minted = await githubRequest<{ token?: string }>(
        fetchFn,
        `/app/installations/${installation.id}/access_tokens`,
        {
            jwt,
            method: 'POST',
            body: { permissions: { metadata: 'read' } },
        },
    )
    if (minted.ok && typeof minted.body?.token === 'string') {
        const token = minted.body.token
        const repos = await githubRequest<{ total_count?: number; repositories?: { full_name?: string }[] }>(
            fetchFn,
            '/installation/repositories?per_page=100',
            { token },
        )
        if (repos.ok && repos.body && Array.isArray(repos.body.repositories)) {
            const names = repos.body.repositories.map((r) => String(r.full_name))
            repositories = repos.body.total_count === names.length ? names : null
        }
        const revoked = await githubRequest<unknown>(fetchFn, '/installation/token', { method: 'DELETE', token })
        if (revoked.status !== 204)
            io.err(`  ! the listing token was NOT revoked (HTTP ${revoked.status}); it expires within the hour`)
    } else {
        findings.push(`could not mint an installation token (HTTP ${minted.status}: ${minted.message})`)
    }
    findings.push(...installationFindings(installation, repositories))

    io.out(`\n  App ${appId}, installation ${installation.id} on ${REPO}`)
    if (findings.length === 0) {
        io.out('  ✓ owned by safeinsights, installed once, on this repository only, with exactly:')
        for (const [name, level] of Object.entries(RELEASE_APP_PERMISSIONS)) io.out(`    ✓ ${name}: ${level}`)
    }
    report(io, findings)
    return { ok: findings.length === 0, installationId: installation.id }
}

function report(io: Io, findings: string[]): void {
    for (const finding of findings) io.err(`    ✗ ${finding}`)
}

/** Every ruleset that applies to the repository, the organisation's included, each read in full. */
async function readRulesets(gh: GhRunner): Promise<{ rulesets: Ruleset[] | null; error: string }> {
    const list = await ghJson<{ id: number }[]>(gh, `repos/${REPO}/rulesets?per_page=100&includes_parents=true`)
    if (!list.value) return { rulesets: null, error: list.error }
    const rulesets: Ruleset[] = []
    for (const entry of list.value) {
        const detail = await ghJson<Ruleset>(gh, `repos/${REPO}/rulesets/${entry.id}`)
        if (!detail.value) return { rulesets: null, error: detail.error }
        rulesets.push(detail.value)
    }
    return { rulesets, error: '' }
}

type OrgInstallation = {
    id?: number
    app_id?: number
    app_slug?: string
    client_id?: string
    repository_selection?: string
    suspended_at?: string | null
    account?: { login?: string }
    permissions?: Record<string, string>
}

/**
 * Whether the installation list still agrees with a vouch that App `appId` cannot reach this repository: the App is
 * installed in the organisation exactly once, on selected repositories, and not suspended. Which repositories are
 * selected is not shown to this tool, so that part stays the vouch's; what can drift without anyone noticing (the
 * App moved to all repositories, installed twice) is caught here. Returns what no longer holds, or null.
 */
function vouchProblem(appId: number, installations: OrgInstallation[]): string | null {
    const its = installations.filter((installation) => installation.app_id === appId)
    if (its.length !== 1) return `App ${appId} has ${its.length} installations in ${RELEASE_REPO.owner}, not one`
    const [installation] = its
    if (installation.repository_selection !== 'selected')
        return `App ${appId} is installed on ${JSON.stringify(installation.repository_selection ?? null)} repositories`
    if (installation.suspended_at) return `App ${appId}'s installation is suspended`
    return null
}

/**
 * Whether `appId` is the release app, judged with the operator's own `gh` (no key needed): installed once in
 * the organisation, on selected repositories, with exactly the App's permissions, and with the client id
 * stored in the `release` environment. `bypass` and `verify` take the id on the command line, and a typo or
 * another App's id must not become the bypass on main.
 */
async function identifyApp(gh: GhRunner, appId: number, clientId: string | null): Promise<string[]> {
    const listed = await ghJson<{ installations?: OrgInstallation[] }>(
        gh,
        `orgs/${RELEASE_REPO.owner}/installations?per_page=100`,
    )
    if (!listed.value) return [`could not list ${RELEASE_REPO.owner}'s App installations: ${listed.error}`]
    const mine = (listed.value.installations ?? []).filter((installation) => installation.app_id === appId)
    if (mine.length !== 1) {
        return [
            `App ${appId} has ${mine.length} installations in ${RELEASE_REPO.owner}; the release app has exactly one`,
        ]
    }
    const [installation] = mine
    const findings: string[] = []
    if (clientId === null) findings.push(`there is no ${CLIENT_ID_VARIABLE} to tell which App is the release app`)
    else if (installation.client_id !== clientId)
        findings.push(
            `App ${appId} (${installation.app_slug}) is not the App whose client id is in ${CLIENT_ID_VARIABLE}`,
        )
    if (installation.suspended_at) findings.push(`App ${appId}'s installation is suspended`)
    if (installation.repository_selection !== 'selected')
        findings.push(
            `App ${appId} is installed on ${JSON.stringify(installation.repository_selection ?? null)} repositories, not selected ones`,
        )
    findings.push(...permissionFindings(installation.permissions ?? {}).map((f) => `App ${appId}'s installation: ${f}`))
    return findings
}

/**
 * Show the ruleset changes and, only when `apply` is set and the operator types "apply", make them. Returns
 * whether everything is in place afterwards, the organisation's rulesets included.
 */
async function bypassPhase(deps: Deps, appId: number, apply: boolean): Promise<boolean> {
    const { gh, io } = deps
    const read = await readRulesets(gh)
    if (!read.rulesets) {
        io.err(`\nCould not read ${REPO}'s rulesets: ${read.error}`)
        return false
    }
    const plan = planBypass(read.rulesets, appId)
    if (plan.problems.length > 0) {
        io.err('\nThe rulesets are not in a shape this tool will change. Nothing was applied:')
        report(io, plan.problems)
        return false
    }

    let repoDone = plan.changes.length === 0
    if (repoDone) {
        io.out(`\n  ✓ ${REPO}'s rulesets already make App ${appId} the only bypass on main and the release tags`)
    } else {
        io.out(`\nRuleset changes for ${REPO} (in this order; the rulesets with no bypass come first):\n`)
        for (const change of plan.changes) io.out(describeChange(change) + '\n')
        if (!apply) {
            io.out('  Not applied. Re-run with --apply to make these changes, or make them by hand.')
        } else if ((await io.ask('  Type "apply" to make these changes now.'))?.trim() !== 'apply') {
            io.out('  Not applied.')
        } else {
            for (const change of plan.changes) {
                const args =
                    change.kind === 'create'
                        ? ['api', '-X', 'POST', `repos/${REPO}/rulesets`, '--input', '-']
                        : ['api', '-X', 'PUT', `repos/${REPO}/rulesets/${change.id}`, '--input', '-']
                const result = await gh(args, JSON.stringify(change.kind === 'create' ? change.body : change.after))
                if (result.code !== 0) {
                    io.err(`  ✗ ${args.slice(0, 4).join(' ')} failed: ${redact(result.stderr.trim())}. Stopped here.`)
                    return false
                }
                const name = change.kind === 'create' ? change.body.name : change.before.name
                io.out(`  ✓ ${change.kind === 'create' ? 'created' : 'updated'} "${name}"`)
            }
            const after = await readRulesets(gh)
            const replanned = after.rulesets ? planBypass(after.rulesets, appId) : null
            repoDone = replanned !== null && replanned.problems.length === 0 && replanned.changes.length === 0
            if (repoDone) io.out('  ✓ read back: the rulesets match the plan')
            else io.err('  ✗ read back: the rulesets do not match the plan yet; re-run `pnpm release-app bypass`')
        }
    }

    // Everything else the push meets, read after any change above.
    const rulesets = (await readRulesets(gh)).rulesets
    const active = await ghJson<ActiveRule[]>(gh, `repos/${REPO}/rules/branches/main?per_page=100`)
    if (!rulesets || !active.value) {
        io.err(`\nCould not read the rules that apply to main: ${active.error || 'rulesets unreadable'}`)
        return false
    }
    const gates = externalGates(active.value, rulesets, appId)
    report(io, gates.problems)
    for (const gate of gates.org.filter((g) => g.app === 'listed')) {
        io.out(`  ✓ organisation ruleset "${gate.name}" (${gate.id}) lets App ${appId} bypass it always`)
    }
    const missing = gates.org.filter((gate) => gate.app !== 'listed')
    if (missing.length > 0) {
        io.out(
            `\nOrganisation rulesets the App must bypass. This tool does not change them: they are shared by\n` +
                `every repository in ${RELEASE_REPO.owner} and need admin:org. Do this only AFTER the repository's\n` +
                '`main: history` ruleset exists (the plan above), or for that window the App could delete or force-push\n' +
                `main. For each, an org owner opens https://github.com/organizations/${RELEASE_REPO.owner}/settings/rules/<id>,\n` +
                'adds the App under "Bypass list" as "Always allow" (not "For pull requests only"), and changes\n' +
                'nothing else.\n',
        )
        for (const gate of missing) {
            io.out(
                `  - "${gate.name}" (${gate.id}: ${gate.types.join(', ')})` +
                    (gate.app === 'wrong-mode' ? ': the App is listed, but not as "Always allow"' : ''),
            )
        }
    }
    // release.yml assumes nothing else can push to main or create a release tag past these rules. An actor a person has
    // vouched cannot reach this repository (VOUCHED_ORG_BYPASSES in rulesets.ts) passes while the organisation's
    // installation list still agrees, and is reported with who said so and why; once it does not, it fails.
    const vouchedActors = gates.org.flatMap((gate) => gate.vouched.map((entry) => ({ gate, ...entry })))
    let vouchesHold = true
    if (vouchedActors.length > 0) {
        const listed = await ghJson<{ installations?: OrgInstallation[] }>(
            gh,
            `orgs/${RELEASE_REPO.owner}/installations?per_page=100`,
        )
        for (const { gate, actor, vouch } of vouchedActors) {
            const who = `${actor.actor_type} ${actor.actor_id} (${actor.bypass_mode}) on organisation ruleset "${gate.name}" (${gate.id})`
            const problem = listed.value
                ? vouchProblem(vouch.actorId, listed.value.installations ?? [])
                : `could not list ${RELEASE_REPO.owner}'s App installations: ${listed.error}`
            if (problem === null) {
                io.out(
                    `  ✓ ${who}: vouched for as unable to reach ${REPO}: ${vouch.name}, ${vouch.reason} ` +
                        `(${vouch.vouchedBy}, ${vouch.on})`,
                )
            } else {
                vouchesHold = false
                io.err(
                    `    ✗ ${who} is vouched for (${vouch.name}, ${vouch.vouchedBy}, ${vouch.on}), but ${problem}: ` +
                        're-check the claim, then update or remove its entry in VOUCHED_ORG_BYPASSES',
                )
            }
        }
    }
    const crowded = gates.org.filter((gate) => gate.others.length > 0)
    for (const gate of crowded) {
        io.err(
            `    ✗ organisation ruleset "${gate.name}" (${gate.id}) also lets ${gate.others
                .map((a) => `${a.actor_type} ${a.actor_id ?? ''} (${a.bypass_mode})`.replace(' ()', ''))
                .join(', ')} bypass it; the release app must be the only one`,
        )
    }
    return repoDone && missing.length === 0 && crowded.length === 0 && vouchesHold && gates.problems.length === 0
}

export type CreateOptions = { name?: string; applyBypass: boolean }

/** The whole creation round trip. */
export async function createCommand(deps: Deps, options: CreateOptions): Promise<number> {
    const { io } = deps
    if (!deps.isTTY) {
        io.err('`release-app create` needs an interactive terminal: it waits while you create and install the App.')
        return 1
    }
    const name = options.name ?? DEFAULT_APP_NAME
    if (name.length > APP_NAME_MAX_LENGTH) {
        io.err(
            `The App's name is ${name.length} characters; GitHub refuses more than ${APP_NAME_MAX_LENGTH}. Pass --name.`,
        )
        return 1
    }

    const findings = await preflight(deps)
    if (findings.length > 0) {
        io.err('Nothing was created. Fix these first:')
        report(io, findings)
        return 1
    }

    const slug = appSlug(name)
    const taken = await githubRequest<unknown>(deps.fetch, `/apps/${encodeURIComponent(slug)}`)
    if (taken.status === 200) {
        io.err(`A GitHub App with the slug "${slug}" already exists (names are global on GitHub). Pass another --name.`)
        return 1
    }
    if (taken.status !== 404) io.out(`! Could not check whether "${name}" is taken (HTTP ${taken.status}).\n`)

    io.out(
        'IF THIS GOES WRONG AFTER YOU CLICK CREATE: the App will exist without its key reaching the environment.\n' +
            '  That is recoverable. Either delete the App and run this again, or open the App, generate a private\n' +
            `  key under "Private keys", and store it with \`gh secret set ${KEY_SECRET} --env ${RELEASE_ENVIRONMENT} ` +
            `--repo ${REPO} < key.pem\`,\n` +
            '  then delete the file. (Not the "client secret": that is for OAuth and fails when used to sign.)\n',
    )

    const state = randomUUID()
    let callback: CallbackServer
    try {
        callback = await startCallbackServer(state, deps.callbackTimeoutMs)
    } catch (err) {
        io.err(`Could not listen on 127.0.0.1 for GitHub's redirect: ${errorMessage(err)}. Nothing was created.`)
        return 1
    }
    let formDir: string | undefined
    try {
        // A private directory, not a guessable name in a shared one: `writeFile` would follow a planted symlink.
        formDir = await mkdtemp(path.join(deps.tmpRoot, 'sssb-release-app-'))
        const formFile = path.join(formDir, `create-${slug}.html`)
        const manifest = appManifest(`http://127.0.0.1:${callback.port}/callback`, name)
        await writeFile(formFile, creationForm(manifestPostUrl(state), manifest), { mode: 0o600, flag: 'wx' })

        io.out(
            `Creating "${name}" in ${RELEASE_REPO.owner}, for ${REPO}. Its permissions, the part that matters:\n\n` +
                `${JSON.stringify(RELEASE_APP_PERMISSIONS, null, 2)}\n\n` +
                '1. Open this in a browser on THIS machine, signed in to GitHub as an owner of ' +
                `${RELEASE_REPO.owner}:\n\n     ${pathToFileURL(formFile).href}\n\n` +
                '   It posts the manifest to GitHub, which shows the App with exactly those permissions. Check them\n' +
                '   and click Create. (An embedded browser that is not signed in appears to do nothing.)\n\n' +
                `Waiting for GitHub to redirect back (up to ${Math.round((deps.callbackTimeoutMs ?? CALLBACK_TIMEOUT_MS) / 60000)} minutes)...`,
        )

        let code: string
        try {
            code = await callback.code
        } catch (err) {
            io.err(`\n${errorMessage(err)}. If you clicked Create, see the recovery note above.`)
            return 1
        }

        // The code stays redeemable for an hour, and only this process holds it, so a network failure or a
        // GitHub error is retried here rather than handing the operator a manual key.
        let exchange = await convertManifest(deps.fetch, code)
        while (!exchange.app && (exchange.status === 0 || exchange.status >= 500)) {
            io.err(`\n  The manifest exchange failed (HTTP ${exchange.status || 'none: no answer'}).`)
            const answer = await io.ask('  Press Enter to try again, or type "give up".')
            if (answer === null || answer.trim().toLowerCase() === 'give up') break
            exchange = await convertManifest(deps.fetch, code)
        }
        const created = exchange.app
        if (!created) {
            io.err(
                '\nThe manifest exchange failed, so this never received the key. Do NOT simply re-run: that would\n' +
                    '  register a second App. Delete the App and start again (safest: the one-time code is in this\n' +
                    "  browser's history until it expires), or use the recovery note above.",
            )
            return 1
        }
        io.out(`\n  created App ${created.slug} (id ${created.id})`)

        // Checked BEFORE the key goes anywhere: a key for an App that is not what this tool asked for must not
        // become what release.yml signs with.
        const wrong = [
            ...(created.owner === RELEASE_REPO.owner
                ? []
                : [`the App is owned by ${JSON.stringify(created.owner)}, not ${RELEASE_REPO.owner}`]),
            ...permissionFindings(created.permissions),
        ]
        if (wrong.length > 0) {
            io.err('\nThe App GitHub created is not the one this tool asked for, so its key was NOT stored:')
            report(io, wrong)
            io.err(
                `  Delete it (https://github.com/organizations/${RELEASE_REPO.owner}/settings/apps/${created.slug}/advanced) and run this again.`,
            )
            return 1
        }

        if (!(await storeKey(deps, created.pem))) {
            io.err(
                `\nStopping: the key was discarded. Generate a new one on the App's page and store it as the recovery\n` +
                    `  note above says, then run \`pnpm release-app verify --app-id ${created.id}\`.`,
            )
            return 1
        }
        io.out(`  ✓ private key stored as the secret ${KEY_SECRET} of the "${RELEASE_ENVIRONMENT}" environment`)
        const clientIdStored = await storeClientId(deps, created.clientId)
        if (clientIdStored) io.out(`  ✓ client id stored as the variable ${CLIENT_ID_VARIABLE}`)
        else
            io.err(
                `  ✗ set it by hand: gh variable set ${CLIENT_ID_VARIABLE} --env ${RELEASE_ENVIRONMENT} --repo ${REPO} --body ${created.clientId}`,
            )

        io.out(
            `\n2. Install it on ${REPO} ONLY:\n\n     https://github.com/apps/${created.slug}/installations/new\n\n` +
                `   Choose the ${RELEASE_REPO.owner} account, then "Only select repositories" and pick ${RELEASE_REPO.repo}.\n`,
        )
        await io.ask('   Press Enter once it is installed.')

        const credentials = await readCredentials(deps.gh)
        const stored = credentials.secret && credentials.variable === created.clientId
        if (!stored) io.err(`    ✗ the environment does not hold both ${KEY_SECRET} and ${CLIENT_ID_VARIABLE} as set`)
        const readback = await readBack(deps, String(created.id), created.pem, created.clientId)

        const identity = readback.ok ? await identifyApp(deps.gh, created.id, created.clientId) : []
        report(io, identity)
        let bypassed = false
        if (readback.ok && identity.length === 0) {
            bypassed = await bypassPhase(deps, created.id, options.applyBypass)
        } else {
            io.err('\nThe ruleset bypass is not offered until the installation reads back clean. Fix it, then run:')
            io.err(`  pnpm release-app bypass --app-id ${created.id}`)
        }

        io.out(
            `\nApp id ${created.id}, slug ${created.slug}. Re-check any time, changing nothing:\n` +
                `  pnpm release-app verify --app-id ${created.id}`,
        )
        if (readback.ok && identity.length === 0 && !bypassed) {
            io.out(
                '\nThe App is made, stored and installed. Still to do: the ruleset steps above (re-run them with\n' +
                    `  \`pnpm release-app bypass --app-id ${created.id} --apply\`), then \`verify\` until it passes.`,
            )
        }
        // The exit code is about what `create` made: the App, its key and client id, and its installation.
        // The rulesets are reported above and `verify` is the check that holds them; the organisation's half is
        // always a hand step, so counting it here would fail every first run.
        return stored && clientIdStored && readback.ok && identity.length === 0 ? 0 : 1
    } finally {
        callback.close()
        if (formDir) await rm(formDir, { recursive: true, force: true }).catch(() => {})
    }
}

export type VerifyOptions = { appId: number; privateKey?: string }

/**
 * Read everything back and change nothing. Without a key (the stored one cannot be read back out of
 * GitHub), it checks the environment and the rulesets; given one on stdin, it also reads the App and its
 * installation as the App.
 */
export async function verifyCommand(deps: Deps, options: VerifyOptions): Promise<number> {
    const { io, gh } = deps
    const findings = await allEnvironmentFindings(gh)
    const credentials = await readCredentials(gh)
    if (credentials.error) findings.push(`could not read the environment's secrets and variables: ${credentials.error}`)
    if (!credentials.secret) findings.push(`the "${RELEASE_ENVIRONMENT}" environment has no secret ${KEY_SECRET}`)
    if (credentials.variable === null)
        findings.push(`the "${RELEASE_ENVIRONMENT}" environment has no variable ${CLIENT_ID_VARIABLE}`)
    if (findings.length === 0)
        io.out(
            `  ✓ environment "${RELEASE_ENVIRONMENT}": main only, admins not exempt, key and client id present; ` +
                `environment "${NPM_PUBLISH_ENVIRONMENT}": v* tags only, admins not exempt`,
        )
    report(io, findings)

    const identity = await identifyApp(gh, options.appId, credentials.variable)
    if (identity.length === 0)
        io.out(
            `  ✓ App ${options.appId} is the release app: one installation, selected repositories, exactly its permissions`,
        )
    report(io, identity)
    let readbackOk = true
    if (options.privateKey) {
        readbackOk = (await readBack(deps, String(options.appId), options.privateKey, credentials.variable)).ok
    } else {
        io.out('  (no --key-stdin: the App and its installation were not read back)')
    }
    const bypassed = await bypassPhase(deps, options.appId, false)
    const ok = findings.length === 0 && identity.length === 0 && readbackOk && bypassed
    io.out(ok ? '\nAll checks passed. Nothing was changed.' : '\nNot ready to release. See above. Nothing was changed.')
    return ok ? 0 : 1
}

/** Show the ruleset changes for an existing App, and make them with `apply`. */
export async function bypassCommand(deps: Deps, options: { appId: number; apply: boolean }): Promise<number> {
    if (options.apply && !deps.isTTY) {
        deps.io.err('`release-app bypass --apply` asks for confirmation, so it needs an interactive terminal.')
        return 1
    }
    const credentials = await readCredentials(deps.gh)
    const identity = await identifyApp(deps.gh, options.appId, credentials.variable)
    if (identity.length > 0) {
        deps.io.err(`App ${options.appId} is not shown to be the release app, so no ruleset change is planned:`)
        report(deps.io, identity)
        return 1
    }
    return (await bypassPhase(deps, options.appId, options.apply)) ? 0 : 1
}
