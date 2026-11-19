// @ts-check
// THE ADOPTER'S OWN SETTINGS, REPORTED (`sssb doctor`, adoption review follow-up 8). The settings only the adopter can
// make: on the workspace's GitHub repository, that `sssb / all-checks` is a required check on the default branch, that
// private vulnerability reporting is on, and, for a private repository in an organization, that the organization's
// Actions policy lets it call SSSB's reusable workflow; and on this machine, that the Claude Code plugin the workspace
// enables is installed. Never a failure, never a write, never a prompt:
//
//   - GitHub is read with `gh api --method GET <path>` and nothing else (`ghGet`), with a short timeout, stdin closed
//     and prompts off. A `gh` that is missing, signed out, offline, or refused for a setting yields "not checked" with
//     the reason, and doctor moves on.
//   - Neither is looked at when `CI` is set: CI's token is the job's `GITHUB_TOKEN`, which cannot read these settings
//     (it would only ever answer "not checked"), CI has no Claude Code, and the check would add network calls to the
//     gate that runs doctor on every PR. The line says so, so a log is not silent about it.
//
// The functions here judge what they are handed; `settingsReports` reads the world and hands it over.
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, realpathSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { githubRepositoryOf } from './doctor-checks.js'

/** The check an adopter requires: SSSB's reusable workflow, called by a job named `sssb`, ends in `all-checks`. */
export const REQUIRED_CHECK = 'sssb / all-checks'

/** @typedef {Record<string, string | undefined>} Env an environment: `process.env`'s shape without Node's `NODE_ENV` typing */
/** @typedef {{ status: 'ok' | 'report', title: string, lines?: string[] }} Report */
/**
 * @typedef {{ ok: false, kind: 'missing' | 'auth' | 'network' | 'timeout' | 'forbidden' | 'not-found' | 'error', http: number | null, message: string }} GhFailure
 * @typedef {{ ok: true, json: any }} GhSuccess
 * @typedef {(apiPath: string) => GhSuccess | GhFailure} Gh one read-only GET of GitHub's API
 */

/** Seconds `gh` has to answer one request: doctor stays fast, and a hung network is "not checked". */
const GH_TIMEOUT_MS = 8000

/**
 * Whether the environment says this is CI (`CI` is set by GitHub Actions and most other runners), the way tools read it:
 * set, and not `0` or `false`.
 * @param {Env} env
 */
export const isCi = (env) => {
    const value = (env.CI ?? '').trim().toLowerCase()
    return value !== '' && value !== '0' && value !== 'false'
}

/**
 * The real `Gh`: `gh api --method GET <path>`. Nothing but a GET ever goes through here, and a request that would
 * prompt (a login, an update notice) cannot: stdin is closed and `gh`'s prompts are off.
 * @param {Env} [env]
 * @returns {Gh}
 */
export function ghGet(env = process.env) {
    return (apiPath) => {
        const result = spawnSync('gh', ['api', '--method', 'GET', apiPath], {
            encoding: 'utf8',
            timeout: GH_TIMEOUT_MS,
            stdio: ['ignore', 'pipe', 'pipe'],
            env: Object.assign(/** @type {NodeJS.ProcessEnv} */ ({}), env, {
                GH_PROMPT_DISABLED: '1',
                GH_NO_UPDATE_NOTIFIER: '1',
                GH_SPINNER_DISABLED: '1',
                GH_HOST: 'github.com',
            }),
        })
        const error = /** @type {NodeJS.ErrnoException | undefined} */ (result.error)
        if (error?.code === 'ENOENT') return { ok: false, kind: 'missing', http: null, message: 'gh is not installed' }
        if (error?.code === 'ETIMEDOUT' || result.signal === 'SIGTERM')
            return {
                ok: false,
                kind: 'timeout',
                http: null,
                message: `gh did not answer within ${GH_TIMEOUT_MS / 1000} seconds`,
            }
        if (error) return { ok: false, kind: 'error', http: null, message: error.message }
        const stdout = result.stdout ?? ''
        if (result.status === 0) {
            try {
                return { ok: true, json: JSON.parse(stdout) }
            } catch {
                return {
                    ok: false,
                    kind: 'error',
                    http: null,
                    message: 'GitHub answered with something that is not JSON',
                }
            }
        }
        return failureOf(result.stderr ?? '', stdout)
    }
}

/**
 * Classify a failed `gh api` call from what it printed.
 * @param {string} stderr
 * @param {string} stdout the response body, when GitHub sent one
 * @returns {GhFailure}
 */
export function failureOf(stderr, stdout) {
    const http = Number(/HTTP (\d{3})/.exec(stderr)?.[1] ?? NaN) || null
    let body = ''
    try {
        const parsed = JSON.parse(stdout)
        if (typeof parsed?.message === 'string') body = parsed.message
    } catch {
        // No body: stderr says enough.
    }
    const text = stderr.trim().split('\n')[0] ?? ''
    if (http === 401 || /gh auth login|not logged in|authentication required|GH_TOKEN/i.test(stderr))
        return { ok: false, kind: 'auth', http, message: 'gh is not signed in (run `gh auth login`)' }
    if (
        /error connecting|dial tcp|no such host|could not resolve|i\/o timeout|network is unreachable|connection refused/i.test(
            stderr,
        )
    )
        return { ok: false, kind: 'network', http, message: 'GitHub could not be reached' }
    if (http === 403)
        return { ok: false, kind: 'forbidden', http, message: `GitHub refused (HTTP 403${body ? `: ${body}` : ''})` }
    if (http === 404) return { ok: false, kind: 'not-found', http, message: body || 'GitHub says not found (HTTP 404)' }
    return { ok: false, kind: 'error', http, message: body || text || 'gh failed' }
}

/**
 * The `owner/name` of the workspace's own GitHub repository: its `origin` remote, read with git, or null.
 * @param {string} root
 */
export function originRepository(root) {
    const result = spawnSync('git', ['-C', root, 'config', '--get', 'remote.origin.url'], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
        timeout: 5000,
    })
    return result.status === 0 ? githubRepositoryOf(result.stdout.trim()) : null
}

/**
 * Every `uses:` of a reusable workflow of `repository` in the workflow files, whole: `owner/name/.github/workflows/
 * file.yml@ref`, which an organization's Actions policy is written against.
 * @param {string} repository `owner/name`, lowercased
 * @param {{ file: string, text: string }[]} workflows
 * @returns {string[]}
 */
export function reusableWorkflowCalls(repository, workflows) {
    const uses = /^\s*(?:-\s+)?uses:\s*['"]?(([\w.-]+\/[\w.-]+)\/\.github\/workflows\/[^@\s'"]+@[^\s'"#]+)/
    const calls = new Set()
    for (const { text } of workflows)
        for (const line of text.split('\n')) {
            const match = uses.exec(line)
            if (match?.[2]?.toLowerCase() === repository) calls.add(/** @type {string} */ (match[1]))
        }
    return [...calls]
}

/** @param {string} what @param {GhFailure} failure */
const notChecked = (what, failure) => `${what}: not checked: ${failure.message}`

/** @param {unknown} value @returns {any[]} the value when GitHub sent a list, else none */
const listOf = (value) => (Array.isArray(value) ? value : [])

/**
 * The classic and ruleset sides of "is this check required on this branch": the contexts a ruleset requires (the
 * rules that apply to the branch, an organization's included), and the ones branch protection requires.
 * @param {GhSuccess | GhFailure} rules `GET repos/{r}/rules/branches/{branch}`
 * @param {GhSuccess | GhFailure} protection `GET repos/{r}/branches/{branch}/protection/required_status_checks`
 */
export function requiredContexts(rules, protection) {
    /** @type {string[]} */
    const fromRules = []
    if (rules.ok && Array.isArray(rules.json))
        for (const rule of rules.json)
            if (rule?.type === 'required_status_checks')
                for (const check of listOf(rule.parameters?.required_status_checks))
                    if (typeof check?.context === 'string') fromRules.push(check.context)
    /** @type {string[]} */
    const fromProtection = []
    if (protection.ok) {
        for (const context of listOf(protection.json?.contexts))
            if (typeof context === 'string') fromProtection.push(context)
        for (const check of listOf(protection.json?.checks))
            if (typeof check?.context === 'string') fromProtection.push(check.context)
    }
    return { fromRules, fromProtection: [...new Set(fromProtection)] }
}

/**
 * IS `sssb / all-checks` REQUIRED on the default branch, by a ruleset or by branch protection. Rulesets are readable by
 * anyone who can read the repository, branch protection only by an admin: the answer is "not required" only when the
 * rulesets were read and branch protection answered "not protected" or was read too; a protection the account may not
 * read leaves it unconfirmed, and the line says so rather than claiming either way.
 * @param {string} repository
 * @param {string} branch
 * @param {Gh} gh
 * @returns {Report}
 */
export function requiredCheckReport(repository, branch, gh) {
    const what = `github: ${REQUIRED_CHECK} is a required check on ${branch}`
    const encoded = encodeURIComponent(branch)
    // 100 a page: a branch can carry more than the default 30 rules, and the one that matters can be on page two.
    const rules = gh(`repos/${repository}/rules/branches/${encoded}?per_page=100`)
    const protection = gh(`repos/${repository}/branches/${encoded}/protection/required_status_checks`)
    const read = requiredContexts(rules, protection)
    const { fromRules } = read
    let { fromProtection } = read
    // Two 404s say nothing is required by branch protection: the branch is not protected, or it is protected without
    // required status checks.
    const unprotected =
        !protection.ok &&
        protection.kind === 'not-found' &&
        /not protected|required status checks not enabled/i.test(protection.message)
    // Branch protection's own endpoint is admin-only. The branch itself is readable by anyone who can read the
    // repository, and says whether it is protected and, when it is, what it requires.
    let protectionRead = protection.ok || unprotected
    if (!protectionRead) {
        const branchInfo = gh(`repos/${repository}/branches/${encoded}`)
        const info = branchInfo.ok ? branchInfo.json : null
        if (info?.protected === false) protectionRead = true
        // A protected branch counts as read only when the answer carries its required checks: without them it says
        // nothing about what is required, and "not required" would be a guess.
        else if (info?.protected === true && typeof info.protection?.required_status_checks === 'object') {
            const checks = info.protection.required_status_checks
            protectionRead = true
            if (checks !== null && checks.enforcement_level !== 'off') {
                const contexts = [...listOf(checks.contexts), ...listOf(checks.checks).map((check) => check?.context)]
                fromProtection = [...new Set(contexts.filter((c) => typeof c === 'string'))]
            }
        }
    }
    if (fromRules.includes(REQUIRED_CHECK)) return { status: 'ok', title: `${what} (a ruleset requires it)` }
    if (fromProtection.includes(REQUIRED_CHECK))
        return { status: 'ok', title: `${what} (branch protection requires it)` }

    const required = [...new Set([...fromRules, ...fromProtection])]
    if (rules.ok && Array.isArray(rules.json) && protectionRead)
        return {
            status: 'report',
            title:
                `${what}: it is not (reported, not failed: it fails unless every one of SSSB's jobs ran and passed, so ` +
                `require it in a ruleset or branch protection on ${branch}; changing a setting stays yours)`,
            lines: [
                required.length > 0
                    ? `required today: ${required.join(', ')}`
                    : `nothing is a required check on ${branch}`,
            ],
        }
    /** @type {string[]} */
    const unread = []
    if (!rules.ok) unread.push(`rulesets: ${rules.message}`)
    else if (!Array.isArray(rules.json)) unread.push('rulesets: GitHub answered with something that is not a list')
    if (!protectionRead && !protection.ok) unread.push(`branch protection: ${protection.message}`)
    return {
        status: 'report',
        title: `${what}: not confirmed: no ruleset requires it, but not everything could be read`,
        lines: unread,
    }
}

/**
 * PRIVATE VULNERABILITY REPORTING, which `SECURITY.md` and `CODE_OF_CONDUCT.md` send reporters to.
 * @param {string} repository
 * @param {Gh} gh
 * @returns {Report}
 */
export function vulnerabilityReportingReport(repository, gh) {
    const what = 'github: private vulnerability reporting'
    const answer = gh(`repos/${repository}/private-vulnerability-reporting`)
    if (!answer.ok) return { status: 'report', title: notChecked(what, answer) }
    if (answer.json?.enabled === true) return { status: 'ok', title: `${what} is on` }
    return {
        status: 'report',
        title:
            `${what} is off (reported, not failed: until it is on, the security and conduct policies point reporters to a ` +
            'private channel that does not exist; Settings → Code security)',
    }
}

/** A glob over an action pattern: `*` is any run of characters, all else literal, case-insensitive like GitHub's names. */
const globMatches = (/** @type {string} */ pattern, /** @type {string} */ value) =>
    new RegExp(`^${pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`, 'i').test(value)

/**
 * One level's (organization's or repository's) Actions policy, read, and whether it lets the workflows through.
 * @param {string} scope `orgs/{o}` or `repos/{o}/{r}`
 * @param {string[]} calls the reusable workflows the workspace calls
 * @param {Gh} gh
 * @returns {{ allows: boolean | null, line: string }} `allows` null: not read
 */
function actionsPolicy(scope, calls, gh) {
    const name = scope.startsWith('orgs/') ? "the organization's" : "the repository's"
    const permissions = gh(`${scope}/actions/permissions`)
    if (!permissions.ok) return { allows: null, line: `${name} Actions policy: not read: ${permissions.message}` }
    const { enabled, enabled_repositories: enabledRepositories, allowed_actions: allowed } = permissions.json ?? {}
    // A repository's answer is `enabled`; an organization's is `enabled_repositories`.
    if (enabled === false) return { allows: false, line: `${name} Actions policy: Actions are not enabled` }
    if (enabledRepositories === 'none')
        return { allows: false, line: `${name} Actions policy: Actions are enabled for no repository` }
    // Which repositories an organization enabled is a list this does not read: say so rather than say "yes".
    if (enabledRepositories === 'selected')
        return {
            allows: null,
            line: `${name} Actions policy: Actions are enabled for selected repositories only; whether this one is among them was not read`,
        }
    if (allowed === 'all' || typeof allowed !== 'string')
        return { allows: true, line: `${name} Actions policy: all actions and workflows allowed` }
    // The organization's own actions and reusable workflows are always allowed: only a call into another owner is held
    // to the policy.
    const owner = scope.split('/')[1] ?? ''
    const foreign = calls.filter((call) => call.split('/')[0]?.toLowerCase() !== owner.toLowerCase())
    if (foreign.length === 0)
        return {
            allows: true,
            line: `${name} Actions policy: ${allowed}, and ${calls.join(', ')} is the organization's own`,
        }
    if (allowed === 'local_only')
        return {
            allows: false,
            line: `${name} Actions policy: only the organization's own actions and reusable workflows, and ${foreign.join(', ')} is not`,
        }
    const selected = gh(`${scope}/actions/permissions/selected-actions`)
    if (!selected.ok)
        return {
            allows: null,
            line: `${name} Actions policy: selected actions only; the list was not read: ${selected.message}`,
        }
    /** @type {string[]} */
    const patterns = Array.isArray(selected.json?.patterns_allowed) ? selected.json.patterns_allowed : []
    // A pattern that blocks (`!owner/*`) overrides the ones that allow, and the matching here only knows the allowing ones.
    if (patterns.some((pattern) => pattern.startsWith('!')))
        return {
            allows: null,
            line: `${name} Actions policy: selected actions only, with a blocking pattern (!…) that was not evaluated`,
        }
    const blocked = foreign.filter((call) => !patterns.some((pattern) => globMatches(pattern, call)))
    return blocked.length === 0
        ? {
              allows: true,
              line: `${name} Actions policy: selected actions only, and its patterns match ${foreign.join(', ')}`,
          }
        : {
              allows: false,
              line: `${name} Actions policy: selected actions only, and none of its ${patterns.length} pattern(s) matches ${blocked.join(', ')}`,
          }
}

/**
 * CAN A PRIVATE REPOSITORY IN AN ORGANIZATION CALL SSSB'S REUSABLE WORKFLOW: the organization's Actions policy (and the
 * repository's) must allow it. Read where GitHub lets the account read it (an admin's), so each level is judged on its
 * own and one that is not readable is named, never guessed.
 * @param {string} repository
 * @param {string[]} calls
 * @param {Gh} gh
 * @returns {Report}
 */
export function reusableWorkflowReport(repository, calls, gh) {
    const what = "github: this private repository can call SSSB's reusable workflow"
    if (calls.length === 0)
        return { status: 'report', title: `${what}: not checked: no workflow under .github/workflows calls one` }
    const levels = [
        actionsPolicy(`orgs/${repository.split('/')[0]}`, calls, gh),
        actionsPolicy(`repos/${repository}`, calls, gh),
    ]
    const lines = levels.map(({ line }) => line)
    if (levels.some(({ allows }) => allows === false))
        return {
            status: 'report',
            title:
                `${what}: it cannot (reported, not failed: allow public reusable workflows in the organization's Actions ` +
                'settings, or the called workflow never runs)',
            lines,
        }
    if (levels.every(({ allows }) => allows === null))
        return { status: 'report', title: `${what}: not checked: neither policy could be read`, lines }
    if (levels.some(({ allows }) => allows === null))
        return { status: 'ok', title: `${what}: yes, as far as the policies that could be read go`, lines }
    return { status: 'ok', title: `${what}: yes`, lines }
}

/**
 * Every GitHub setting doctor reports, for the repository `repository`.
 * @param {string} repository `owner/name`, lowercased
 * @param {{ gh: Gh, workflows: { file: string, text: string }[], kitRepository: string | null }} input
 * @returns {Report[]}
 */
export function githubReports(repository, { gh, workflows, kitRepository }) {
    const repo = gh(`repos/${repository}`)
    if (!repo.ok) return [{ status: 'report', title: `github settings of ${repository}: not checked: ${repo.message}` }]
    const branch = typeof repo.json?.default_branch === 'string' ? repo.json.default_branch : 'main'
    /** @type {Report[]} */
    const reports = [requiredCheckReport(repository, branch, gh), vulnerabilityReportingReport(repository, gh)]
    if (repo.json?.private === true && repo.json?.owner?.type === 'Organization')
        reports.push(
            reusableWorkflowReport(
                repository,
                kitRepository === null ? [] : reusableWorkflowCalls(kitRepository, workflows),
                gh,
            ),
        )
    return reports
}

/**
 * Where Claude Code keeps its plugins: `CLAUDE_CONFIG_DIR`, else `~/.claude`.
 * @param {Env} env
 */
export const claudeConfigDir = (env) => env.CLAUDE_CONFIG_DIR || path.join(env.HOME || os.homedir(), '.claude')

/** @param {string} dir the real path of `dir`, or its resolved path when it is gone */
const real = (dir) => {
    try {
        return realpathSync(dir)
    } catch {
        return path.resolve(dir)
    }
}

/**
 * THE PLUGIN THE WORKSPACE ENABLES IS INSTALLED. Enabling is the workspace's (`enabledPlugins` in its shared
 * `.claude/settings.json`) and installing is the person's, once per clone (`claude plugin install <plugin> --scope
 * project`), so a workspace can enable a plugin nobody has. Claude Code records each install in
 * `<config dir>/plugins/installed_plugins.json`, under `plugins["<plugin>@<marketplace>"]`, with the scope and, for a
 * project or local one, the project's path: installed for this workspace when it is a user-scope install, or one for
 * this very directory.
 * @param {{
 *   settings: { file: string, text: string } | null,
 *   installed: { file: string, text: string } | null,
 *   root: string,
 * }} input `installed`: the install record, null when this machine has none
 * @returns {Report | null} null: the workspace enables no plugin, so there is nothing to report
 */
export function pluginReport({ settings, installed, root }) {
    const what = 'claude plugin'
    if (settings === null) return null
    /** @type {unknown} */
    let parsed
    try {
        parsed = JSON.parse(settings.text)
    } catch {
        return { status: 'report', title: `${what}: not checked: ${settings.file} is not JSON doctor can read` }
    }
    const enabledPlugins = /** @type {any} */ (parsed)?.enabledPlugins
    const enabled = Object.entries(typeof enabledPlugins === 'object' && enabledPlugins ? enabledPlugins : {})
        .filter(([, on]) => on === true || (Array.isArray(on) && on.length > 0))
        .map(([key]) => key)
    if (enabled.length === 0) return null
    const names = enabled.join(', ')
    const install = enabled.map((key) => `claude plugin install ${key} --scope project`)
    if (installed === null)
        return {
            status: 'report',
            title:
                `${what}: ${names} ${enabled.length === 1 ? 'is' : 'are'} enabled by ${settings.file} but not installed: this ` +
                'machine has no plugin install record (reported, not failed: enabling installs nothing; ' +
                'ignore it when nobody here uses Claude Code)',
            lines: install,
        }
    /** @type {any} */
    let record
    try {
        record = JSON.parse(installed.text)
    } catch {
        return { status: 'report', title: `${what}: not checked: ${installed.file} is not JSON doctor can read` }
    }
    const plugins = typeof record?.plugins === 'object' && record.plugins ? record.plugins : {}
    const here = real(root)
    /** @type {string[]} */
    const missing = []
    /** @type {string[]} */
    const lines = []
    for (const key of enabled) {
        // An older record keeps one entry, not a list, for a plugin: a user-level install.
        const recorded = plugins[key]
        const entries = Array.isArray(recorded)
            ? recorded
            : typeof recorded === 'object' && recorded
              ? [{ scope: 'user', ...recorded }]
              : []
        const mine = entries.filter(
            (/** @type {any} */ entry) =>
                entry?.scope === 'user' ||
                entry?.scope === 'managed' ||
                (typeof entry?.projectPath === 'string' && real(entry.projectPath) === here),
        )
        if (mine.length > 0) {
            lines.push(
                `${key}: installed${typeof mine[0].version === 'string' && mine[0].version ? ` (${mine[0].version})` : ''}, scope ${mine[0].scope}`,
            )
            continue
        }
        missing.push(key)
        const elsewhere = entries
            .map((/** @type {any} */ entry) => entry?.projectPath)
            .filter((/** @type {unknown} */ p) => typeof p === 'string')
        lines.push(
            `${key}: not installed for this workspace` +
                (elsewhere.length > 0 ? ` (installed only for ${elsewhere.join(', ')})` : '') +
                `: claude plugin install ${key} --scope project`,
        )
    }
    return missing.length === 0
        ? { status: 'ok', title: `${what}: ${names} ${enabled.length === 1 ? 'is' : 'are'} installed`, lines }
        : {
              status: 'report',
              title:
                  `${what}: ${missing.join(', ')} ${missing.length === 1 ? 'is' : 'are'} enabled by ${settings.file} but not ` +
                  'installed (reported, not failed: enabling installs nothing, so run the command once per clone, after ' +
                  'trusting the folder; ignore it when nobody here uses Claude Code)',
              lines,
          }
}

/**
 * Everything this module reports for a workspace: read here, judged above.
 * @param {{
 *   root: string,
 *   env?: Env,
 *   gh?: Gh,
 *   workflows: { file: string, text: string }[],
 *   kitRepository: string | null,
 * }} input
 * @returns {Report[]}
 */
export function settingsReports({ root, env = process.env, gh = ghGet(env), workflows, kitRepository }) {
    const title = 'github settings and plugin install'
    if (isCi(env))
        return [
            {
                status: 'report',
                title:
                    `${title}: not checked: CI is set (a CI token cannot read an adopter's repository settings and CI has no ` +
                    'Claude Code; run `sssb doctor` on your own machine)',
            },
        ]
    /** @type {Report[]} */
    const reports = []
    // Nothing in here may stop doctor: a file that cannot be read, or an answer shaped unlike GitHub's documents, is a
    // line that says so.
    reports.push(
        ...guarded('github settings', () => {
            const repository = originRepository(root)
            return repository === null
                ? [
                      {
                          status: /** @type {const} */ ('report'),
                          title: 'github settings: not checked: the workspace has no `origin` remote on github.com to read the settings of',
                      },
                  ]
                : githubReports(repository, { gh, workflows, kitRepository })
        }),
    )
    reports.push(
        ...guarded('claude plugin', () => {
            const read = (/** @type {string} */ file) => (existsSync(file) ? readFileSync(file, 'utf8') : null)
            const settingsText = read(path.join(root, '.claude', 'settings.json'))
            const installedFile = path.join(claudeConfigDir(env), 'plugins', 'installed_plugins.json')
            const installedText = read(installedFile)
            const plugin = pluginReport({
                settings: settingsText === null ? null : { file: '.claude/settings.json', text: settingsText },
                installed: installedText === null ? null : { file: installedFile, text: installedText },
                root,
            })
            return plugin === null ? [] : [plugin]
        }),
    )
    return reports
}

/**
 * Run one group of reports; an error it throws is the group's one line, "not checked", with the error's message.
 * @param {string} what
 * @param {() => Report[]} produce
 * @returns {Report[]}
 */
function guarded(what, produce) {
    try {
        return produce()
    } catch (error) {
        return [{ status: 'report', title: `${what}: not checked: ${error instanceof Error ? error.message : error}` }]
    }
}
