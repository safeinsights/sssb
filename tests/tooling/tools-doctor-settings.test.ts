import { spawnSync } from 'node:child_process'
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
    claudeConfigDir,
    failureOf,
    ghGet,
    githubReports,
    isCi,
    originRepository,
    pluginReport,
    requiredCheckReport,
    requiredContexts,
    REQUIRED_CHECK,
    reusableWorkflowCalls,
    reusableWorkflowReport,
    settingsReports,
    vulnerabilityReportingReport,
} from '../../packages/tools/src/commands/doctor-settings.js'
import { makeTestTmpDir } from '../support/tmp-dir'

/**
 * `sssb doctor`'s reports of the adopter's own settings (packages/tools/src/commands/doctor-settings.js, adoption
 * review follow-up 8): each report line is driven with `gh` stubbed, either as a function standing in for one GitHub
 * GET or, for the process boundary, as a real executable on PATH.
 */

type Answer = { ok: true; json: unknown } | { ok: false; kind: string; http: number | null; message: string }
const yes = (json: unknown): Answer => ({ ok: true, json })
const no = (kind: string, message: string, http: number | null = null): Answer => ({ ok: false, kind, http, message })

/** A `gh` that answers from a table by API path, and records every path it was asked for. */
function stubGh(table: Record<string, Answer>) {
    const asked: string[] = []
    const gh = (apiPath: string) => {
        asked.push(apiPath)
        return (table[apiPath] ?? no('not-found', 'Not Found', 404)) as never
    }
    return { gh, asked }
}

const REPO = 'acme-org/acme'
const RULES = `repos/${REPO}/rules/branches/main`
const PROTECTION = `repos/${REPO}/branches/main/protection/required_status_checks`
const ruleset = (...contexts: string[]) => [
    { type: 'deletion' },
    {
        type: 'required_status_checks',
        parameters: { required_status_checks: contexts.map((context) => ({ context })) },
    },
]
const NOT_PROTECTED = no('not-found', 'Branch not protected', 404)

describe('isCi', () => {
    it.each([
        [{ CI: 'true' }, true],
        [{ CI: '1' }, true],
        [{ CI: 'false' }, false],
        [{ CI: '0' }, false],
        [{ CI: '' }, false],
        [{}, false],
    ])('%j -> %s', (env, expected) => {
        expect(isCi(env)).toBe(expected)
    })
})

describe('failureOf: what a failed `gh api` call means', () => {
    it('signed out', () => {
        expect(failureOf('To get started with GitHub CLI, please run:  gh auth login', '')).toMatchObject({
            kind: 'auth',
        })
        expect(failureOf('gh: Bad credentials (HTTP 401)', '{"message":"Bad credentials"}')).toMatchObject({
            kind: 'auth',
            http: 401,
        })
    })
    it('offline', () => {
        expect(failureOf('error connecting to api.github.com', '')).toMatchObject({ kind: 'network' })
        expect(
            failureOf('Get "https://api.github.com/x": dial tcp: lookup api.github.com: no such host', ''),
        ).toMatchObject({ kind: 'network' })
    })
    it('forbidden, with GitHub’s own words', () => {
        expect(
            failureOf(
                'gh: Resource not accessible (HTTP 403)',
                '{"message":"Resource not accessible by personal access token"}',
            ),
        ).toEqual({
            ok: false,
            kind: 'forbidden',
            http: 403,
            message: 'GitHub refused (HTTP 403: Resource not accessible by personal access token)',
        })
    })
    it('not found, keeping the body (the two 404s differ)', () => {
        expect(failureOf('gh: Branch not protected (HTTP 404)', '{"message":"Branch not protected"}')).toMatchObject({
            kind: 'not-found',
            message: 'Branch not protected',
        })
        expect(failureOf('gh: Not Found (HTTP 404)', '')).toMatchObject({ kind: 'not-found', http: 404 })
    })
    it('anything else keeps gh’s first line', () => {
        expect(failureOf('gh: boom (HTTP 500)\nmore', '')).toMatchObject({
            kind: 'error',
            message: 'gh: boom (HTTP 500)',
        })
    })
})

describe('requiredContexts', () => {
    it('reads a ruleset’s required checks and branch protection’s contexts and checks', () => {
        expect(
            requiredContexts(
                yes(ruleset('a', 'b')) as never,
                yes({ contexts: ['c'], checks: [{ context: 'c' }, { context: 'd' }] }) as never,
            ),
        ).toEqual({ fromRules: ['a', 'b'], fromProtection: ['c', 'd'] })
    })
    it('reads nothing from a failure', () => {
        expect(requiredContexts(no('error', 'x') as never, NOT_PROTECTED as never)).toEqual({
            fromRules: [],
            fromProtection: [],
        })
    })
})

describe('requiredCheckReport: is `sssb / all-checks` required on the default branch', () => {
    it('is ok when a ruleset requires it', () => {
        const { gh } = stubGh({ [RULES]: yes(ruleset(REQUIRED_CHECK)), [PROTECTION]: NOT_PROTECTED })
        expect(requiredCheckReport(REPO, 'main', gh)).toEqual({
            status: 'ok',
            title: 'github: sssb / all-checks is a required check on main (a ruleset requires it)',
        })
    })

    it('is ok when branch protection requires it (by contexts, or by checks)', () => {
        for (const protection of [
            { contexts: [REQUIRED_CHECK] },
            { checks: [{ context: REQUIRED_CHECK, app_id: 15368 }] },
        ]) {
            const { gh } = stubGh({ [RULES]: yes([]), [PROTECTION]: yes(protection) })
            expect(requiredCheckReport(REPO, 'main', gh)).toEqual({
                status: 'ok',
                title: 'github: sssb / all-checks is a required check on main (branch protection requires it)',
            })
        }
    })

    it('reports, never fails, that it is NOT required when nothing is protected', () => {
        const { gh } = stubGh({ [RULES]: yes([]), [PROTECTION]: NOT_PROTECTED })
        const report = requiredCheckReport(REPO, 'main', gh)
        expect(report.status).toBe('report')
        expect(report.title).toMatch(
            /^github: sssb \/ all-checks is a required check on main: it is not \(reported, not failed:/,
        )
        expect(report.lines).toEqual(['nothing is a required check on main'])
    })

    it('reports that it is not required when other checks are, and names them', () => {
        const { gh } = stubGh({
            [RULES]: yes(ruleset('secret-scan')),
            [PROTECTION]: yes({ contexts: ['workspace-checks'], checks: [{ context: 'workspace-checks' }] }),
        })
        const report = requiredCheckReport(REPO, 'main', gh)
        expect(report.title).toMatch(/: it is not \(reported, not failed:/)
        expect(report.lines).toEqual(['required today: secret-scan, workspace-checks'])
    })

    it('does not claim "not required" when branch protection could not be read', () => {
        const { gh } = stubGh({
            [RULES]: yes([]),
            [PROTECTION]: no('forbidden', 'GitHub refused (HTTP 403: Resource not accessible)', 403),
        })
        const report = requiredCheckReport(REPO, 'main', gh)
        expect(report.status).toBe('report')
        expect(report.title).toMatch(/: not confirmed: no ruleset requires it, but not everything could be read$/)
        expect(report.lines).toEqual(['branch protection: GitHub refused (HTTP 403: Resource not accessible)'])
    })

    it('does not claim "not required" when the rulesets could not be read', () => {
        const { gh } = stubGh({ [RULES]: no('error', 'gh failed'), [PROTECTION]: NOT_PROTECTED })
        expect(requiredCheckReport(REPO, 'main', gh).lines).toEqual(['rulesets: gh failed'])
    })

    it('still finds it in branch protection when the rulesets could not be read', () => {
        const { gh } = stubGh({ [RULES]: no('error', 'gh failed'), [PROTECTION]: yes({ contexts: [REQUIRED_CHECK] }) })
        expect(requiredCheckReport(REPO, 'main', gh).status).toBe('ok')
    })

    it('asks about the branch it is given, encoded', () => {
        const { gh, asked } = stubGh({})
        requiredCheckReport(REPO, 'release/1', gh)
        expect(asked).toEqual([
            `repos/${REPO}/rules/branches/release%2F1`,
            `repos/${REPO}/branches/release%2F1/protection/required_status_checks`,
        ])
    })
})

describe('vulnerabilityReportingReport', () => {
    const PVR = `repos/${REPO}/private-vulnerability-reporting`
    it('is ok when it is on', () => {
        const { gh } = stubGh({ [PVR]: yes({ enabled: true }) })
        expect(vulnerabilityReportingReport(REPO, gh)).toEqual({
            status: 'ok',
            title: 'github: private vulnerability reporting is on',
        })
    })
    it('reports, never fails, that it is off', () => {
        const { gh } = stubGh({ [PVR]: yes({ enabled: false }) })
        const report = vulnerabilityReportingReport(REPO, gh)
        expect(report.status).toBe('report')
        expect(report.title).toMatch(/^github: private vulnerability reporting is off \(reported, not failed:/)
    })
    it('says "not checked", with the reason, when it cannot be read', () => {
        const { gh } = stubGh({ [PVR]: no('forbidden', 'GitHub refused (HTTP 403)', 403) })
        expect(vulnerabilityReportingReport(REPO, gh)).toEqual({
            status: 'report',
            title: 'github: private vulnerability reporting: not checked: GitHub refused (HTTP 403)',
        })
    })
})

describe('reusableWorkflowReport: can a private organization repository call SSSB’s reusable workflow', () => {
    const CALL = 'safeinsights/sssb/.github/workflows/app-checks.yml@' + 'a'.repeat(40)
    const ORG = 'orgs/acme-org/actions/permissions'
    const REPOSITORY = `repos/${REPO}/actions/permissions`
    const allAllowed = { enabled: true, allowed_actions: 'all' }

    it('is ok when both levels allow everything', () => {
        const { gh } = stubGh({ [ORG]: yes(allAllowed), [REPOSITORY]: yes(allAllowed) })
        const report = reusableWorkflowReport(REPO, [CALL], gh)
        expect(report.status).toBe('ok')
        expect(report.title).toBe("github: this private repository can call SSSB's reusable workflow: yes")
    })

    it('reports that it cannot when the organization allows only its own', () => {
        const { gh } = stubGh({
            [ORG]: yes({ enabled: true, allowed_actions: 'local_only' }),
            [REPOSITORY]: yes(allAllowed),
        })
        const report = reusableWorkflowReport(REPO, [CALL], gh)
        expect(report.status).toBe('report')
        expect(report.title).toMatch(
            /: it cannot \(reported, not failed: allow public reusable workflows in the organization/,
        )
        expect(report.lines?.[0]).toBe(
            "the organization's Actions policy: only actions and reusable workflows in its own organization",
        )
    })

    it('reports that it cannot when Actions are not enabled for the repository', () => {
        const { gh } = stubGh({ [ORG]: yes(allAllowed), [REPOSITORY]: yes({ enabled: false }) })
        const report = reusableWorkflowReport(REPO, [CALL], gh)
        expect(report.title).toMatch(/: it cannot/)
        expect(report.lines?.[1]).toBe("the repository's Actions policy: Actions are not enabled")
    })

    it('judges a selected-actions policy by its patterns', () => {
        const selected = yes({ enabled: true, allowed_actions: 'selected' })
        const allowing = stubGh({
            [ORG]: selected,
            [`${ORG}/selected-actions`]: yes({
                patterns_allowed: ['actions/*', 'safeinsights/sssb/.github/workflows/*@*'],
            }),
            [REPOSITORY]: yes(allAllowed),
        })
        expect(reusableWorkflowReport(REPO, [CALL], allowing.gh).status).toBe('ok')
        const blocking = stubGh({
            [ORG]: selected,
            [`${ORG}/selected-actions`]: yes({ patterns_allowed: ['actions/*', 'someone/else@*'] }),
            [REPOSITORY]: yes(allAllowed),
        })
        const report = reusableWorkflowReport(REPO, [CALL], blocking.gh)
        expect(report.status).toBe('report')
        expect(report.lines?.[0]).toBe(
            `the organization's Actions policy: selected actions only, and none of its 2 pattern(s) matches ${CALL}`,
        )
    })

    it('does not guess when neither level can be read', () => {
        const { gh } = stubGh({
            [ORG]: no('forbidden', 'GitHub refused (HTTP 403)', 403),
            [REPOSITORY]: yes({ enabled: true, allowed_actions: 'selected' }),
            [`repos/${REPO}/actions/permissions/selected-actions`]: no('forbidden', 'GitHub refused (HTTP 403)', 403),
        })
        const report = reusableWorkflowReport(REPO, [CALL], gh)
        expect(report.status).toBe('report')
        expect(report.title).toMatch(/: not checked: neither policy could be read$/)
    })

    it('is ok “as far as read” when only one level could be read', () => {
        const { gh } = stubGh({
            [ORG]: no('forbidden', 'GitHub refused (HTTP 403)', 403),
            [REPOSITORY]: yes(allAllowed),
        })
        const report = reusableWorkflowReport(REPO, [CALL], gh)
        expect(report.status).toBe('ok')
        expect(report.title).toMatch(/: yes, as far as the policies that could be read go$/)
        expect(report.lines?.[0]).toBe("the organization's Actions policy: not read: GitHub refused (HTTP 403)")
    })

    it('says "not checked" when no workflow calls one', () => {
        const { gh, asked } = stubGh({})
        expect(reusableWorkflowReport(REPO, [], gh)).toEqual({
            status: 'report',
            title: "github: this private repository can call SSSB's reusable workflow: not checked: no workflow under .github/workflows calls one",
        })
        expect(asked).toEqual([])
    })
})

describe('reusableWorkflowCalls', () => {
    it('lists the whole `uses` of each call of the repository’s workflows, once', () => {
        const text = [
            'jobs:',
            '    sssb:',
            '        uses: Safeinsights/SSSB/.github/workflows/app-checks.yml@' + 'b'.repeat(40) + ' # note',
            '    again:',
            '        uses: safeinsights/sssb/.github/workflows/app-checks.yml@' + 'b'.repeat(40),
            '    other:',
            '        steps:',
            '            - uses: actions/checkout@v4',
            '            - uses: elsewhere/sssb/.github/workflows/x.yml@main',
        ].join('\n')
        expect(reusableWorkflowCalls('safeinsights/sssb', [{ file: 'a.yml', text }])).toEqual([
            'Safeinsights/SSSB/.github/workflows/app-checks.yml@' + 'b'.repeat(40),
            'safeinsights/sssb/.github/workflows/app-checks.yml@' + 'b'.repeat(40),
        ])
    })
})

describe('githubReports', () => {
    const workflows = [
        { file: 'w.yml', text: 'uses: safeinsights/sssb/.github/workflows/app-checks.yml@' + 'c'.repeat(40) },
    ]
    const input = (gh: never) => ({ gh, workflows, kitRepository: 'safeinsights/sssb' })
    const tables = (repo: unknown) => ({
        [`repos/${REPO}`]: yes(repo),
        [`repos/${REPO}/rules/branches/trunk`]: yes(ruleset(REQUIRED_CHECK)),
        [`repos/${REPO}/branches/trunk/protection/required_status_checks`]: NOT_PROTECTED,
        [`repos/${REPO}/private-vulnerability-reporting`]: yes({ enabled: true }),
        [`orgs/acme-org/actions/permissions`]: yes({ enabled: true, allowed_actions: 'all' }),
        [`repos/${REPO}/actions/permissions`]: yes({ enabled: true, allowed_actions: 'all' }),
    })

    it('says "not checked", with the reason, once, when the repository itself cannot be read', () => {
        for (const [failure, reason] of [
            [no('missing', 'gh is not installed'), 'gh is not installed'],
            [no('auth', 'gh is not signed in (run `gh auth login`)'), 'gh is not signed in (run `gh auth login`)'],
            [no('network', 'GitHub could not be reached'), 'GitHub could not be reached'],
            [no('timeout', 'gh did not answer within 8 seconds'), 'gh did not answer within 8 seconds'],
            [no('not-found', 'Not Found', 404), 'Not Found'],
        ] as const) {
            const { gh, asked } = stubGh({ [`repos/${REPO}`]: failure })
            expect(githubReports(REPO, input(gh as never))).toEqual([
                { status: 'report', title: `github settings of ${REPO}: not checked: ${reason}` },
            ])
            expect(asked).toEqual([`repos/${REPO}`])
        }
    })

    it('reads the default branch, and checks the Actions policy only for a private repository in an organization', () => {
        const cases = [
            [{ default_branch: 'trunk', private: true, owner: { type: 'Organization' } }, 3],
            [{ default_branch: 'trunk', private: false, owner: { type: 'Organization' } }, 2],
            [{ default_branch: 'trunk', private: true, owner: { type: 'User' } }, 2],
        ] as const
        for (const [repo, count] of cases) {
            const { gh } = stubGh(tables(repo) as never)
            const reports = githubReports(REPO, input(gh as never))
            expect(reports).toHaveLength(count)
            expect(reports[0]).toMatchObject({
                status: 'ok',
                title: expect.stringContaining('required check on trunk'),
            })
            expect(reports[1]).toMatchObject({ status: 'ok', title: 'github: private vulnerability reporting is on' })
        }
    })

    it('asks only for the settings it reports on', () => {
        const { gh, asked } = stubGh(
            tables({ default_branch: 'trunk', private: false, owner: { type: 'User' } }) as never,
        )
        githubReports(REPO, input(gh as never))
        expect([...asked].sort()).toEqual(
            [
                `repos/${REPO}`,
                `repos/${REPO}/rules/branches/trunk`,
                `repos/${REPO}/branches/trunk/protection/required_status_checks`,
                `repos/${REPO}/private-vulnerability-reporting`,
            ].sort(),
        )
    })
})

describe('pluginReport: is the plugin the workspace enables installed', () => {
    const root = makeTestTmpDir('sssb-plugin-report-')
    const settings = (enabledPlugins: unknown) => ({
        file: '.claude/settings.json',
        text: JSON.stringify({ enabledPlugins }),
    })
    const installed = (plugins: unknown) => ({
        file: '/home/x/.claude/plugins/installed_plugins.json',
        text: JSON.stringify({ version: 2, plugins }),
    })
    const entry = (over: Record<string, unknown>) => [{ scope: 'user', version: '0.2.0', ...over }]

    it('has nothing to say when the workspace enables nothing, or has no settings', () => {
        expect(pluginReport({ settings: null, installed: null, root })).toBeNull()
        expect(pluginReport({ settings: settings({ 'sssb@sssb': false }), installed: null, root })).toBeNull()
        expect(pluginReport({ settings: settings({}), installed: null, root })).toBeNull()
    })

    it('is ok for a user-scope install, or one for this very workspace', () => {
        const user = pluginReport({
            settings: settings({ 'sssb@sssb': true }),
            installed: installed({ 'sssb@sssb': entry({}) }),
            root,
        })
        expect(user).toEqual({
            status: 'ok',
            title: 'claude plugin: sssb@sssb is installed',
            lines: ['sssb@sssb: installed (0.2.0), scope user'],
        })
        const project = pluginReport({
            settings: settings({ 'sssb@sssb': true }),
            installed: installed({ 'sssb@sssb': entry({ scope: 'project', projectPath: root }) }),
            root,
        })
        expect(project?.status).toBe('ok')
    })

    it('reports, never fails, a plugin installed only for another folder', () => {
        const report = pluginReport({
            settings: settings({ 'sssb@sssb': true }),
            installed: installed({ 'sssb@sssb': entry({ scope: 'project', projectPath: '/elsewhere/clone' }) }),
            root,
        })
        expect(report?.status).toBe('report')
        expect(report?.title).toMatch(
            /^claude plugin: sssb@sssb is enabled by \.claude\/settings\.json but not installed \(reported, not failed:/,
        )
        expect(report?.lines).toEqual([
            'sssb@sssb: not installed for this workspace (installed only for /elsewhere/clone): claude plugin install sssb@sssb --scope project',
        ])
    })

    it('reports a plugin the machine has no record of, with the command', () => {
        const absent = pluginReport({
            settings: settings({ 'sssb@sssb': true }),
            installed: installed({ 'other@x': entry({}) }),
            root,
        })
        expect(absent?.status).toBe('report')
        expect(absent?.lines).toEqual([
            'sssb@sssb: not installed for this workspace: claude plugin install sssb@sssb --scope project',
        ])
        const noRecord = pluginReport({ settings: settings({ 'sssb@sssb': true }), installed: null, root })
        expect(noRecord?.status).toBe('report')
        expect(noRecord?.title).toMatch(
            /but not installed: this machine has no plugin install record \(reported, not failed:/,
        )
        expect(noRecord?.lines).toEqual(['claude plugin install sssb@sssb --scope project'])
    })

    it('names only the plugins that are missing, and counts every enabled one (an array of constraints is on)', () => {
        const report = pluginReport({
            settings: settings({ 'sssb@sssb': true, 'two@m': ['>=1'], 'off@m': false }),
            installed: installed({ 'sssb@sssb': entry({}) }),
            root,
        })
        expect(report?.title).toMatch(/^claude plugin: two@m is enabled by/)
        expect(report?.lines).toEqual([
            'sssb@sssb: installed (0.2.0), scope user',
            'two@m: not installed for this workspace: claude plugin install two@m --scope project',
        ])
    })

    it('says "not checked" for settings or a record it cannot read', () => {
        expect(pluginReport({ settings: { file: '.claude/settings.json', text: '{' }, installed: null, root })).toEqual(
            {
                status: 'report',
                title: 'claude plugin: not checked: .claude/settings.json is not JSON doctor can read',
            },
        )
        expect(
            pluginReport({
                settings: settings({ 'sssb@sssb': true }),
                installed: { file: 'installed_plugins.json', text: '{' },
                root,
            }),
        ).toEqual({
            status: 'report',
            title: 'claude plugin: not checked: installed_plugins.json is not JSON doctor can read',
        })
    })
})

describe('claudeConfigDir', () => {
    it('is CLAUDE_CONFIG_DIR, else ~/.claude', () => {
        expect(claudeConfigDir({ CLAUDE_CONFIG_DIR: '/c' })).toBe('/c')
        expect(claudeConfigDir({ HOME: '/h' })).toBe('/h/.claude')
    })
})

/** A `gh` executable: answers each path from `<dir>/answers/<path with / as _>.json`, failing with `.fail`'s text; logs argv. */
function fakeGh(dir: string, answers: Record<string, { body?: unknown; fail?: string }>) {
    const bin = path.join(dir, 'bin')
    mkdirSync(bin, { recursive: true })
    const data = path.join(dir, 'answers')
    mkdirSync(data, { recursive: true })
    for (const [apiPath, { body, fail }] of Object.entries(answers)) {
        const key = apiPath.replace(/\//g, '_')
        if (body !== undefined) writeFileSync(path.join(data, `${key}.json`), JSON.stringify(body))
        if (fail !== undefined) writeFileSync(path.join(data, `${key}.fail`), fail)
    }
    const log = path.join(dir, 'gh.log')
    writeFileSync(log, '')
    const script = path.join(bin, 'gh')
    writeFileSync(
        script,
        `#!/bin/sh
echo "$@" >> '${log}'
for last; do :; done
key=$(printf %s "$last" | tr / _)
[ -f '${data}'/"$key".json ] && cat '${data}'/"$key".json
if [ -f '${data}'/"$key".fail ]; then cat '${data}'/"$key".fail >&2; exit 1; fi
if [ -f '${data}'/"$key".json ]; then exit 0; fi
echo 'gh: Not Found (HTTP 404)' >&2
exit 1
`,
    )
    chmodSync(script, 0o755)
    return { bin, log }
}

const PATH = process.env.PATH ?? ''

describe('ghGet: the process boundary, with a stand-in `gh` on PATH', () => {
    it('runs `gh api --method GET <path>` and parses the answer', () => {
        const dir = makeTestTmpDir('sssb-gh-get-')
        const { bin, log } = fakeGh(dir, { 'repos/a/b': { body: { default_branch: 'main' } } })
        expect(ghGet({ PATH: `${bin}:${PATH}` })('repos/a/b')).toEqual({ ok: true, json: { default_branch: 'main' } })
        expect(readFileSync(log, 'utf8')).toBe('api --method GET repos/a/b\n')
    })

    it('classifies a failure from what gh printed', () => {
        const dir = makeTestTmpDir('sssb-gh-get-fail-')
        const { bin } = fakeGh(dir, {
            'repos/a/signedout': { fail: 'To get started with GitHub CLI, please run:  gh auth login\n' },
            'repos/a/forbidden': {
                body: { message: 'Resource not accessible' },
                fail: 'gh: Resource not accessible (HTTP 403)\n',
            },
        })
        const gh = ghGet({ PATH: `${bin}:${PATH}` })
        expect(gh('repos/a/signedout')).toMatchObject({ ok: false, kind: 'auth' })
        expect(gh('repos/a/forbidden')).toMatchObject({ ok: false, kind: 'forbidden', http: 403 })
        expect(gh('repos/a/unknown')).toMatchObject({ ok: false, kind: 'not-found', http: 404 })
    })

    it('says gh is not installed when there is none on PATH', () => {
        const dir = makeTestTmpDir('sssb-gh-get-missing-')
        mkdirSync(path.join(dir, 'empty'))
        expect(ghGet({ PATH: path.join(dir, 'empty') })('repos/a/b')).toEqual({
            ok: false,
            kind: 'missing',
            http: null,
            message: 'gh is not installed',
        })
    })
})

describe('settingsReports: everything, read from a workspace and a machine', () => {
    function workspace(prefix: string, origin: string | null) {
        const dir = makeTestTmpDir(prefix)
        const root = path.join(dir, 'ws')
        mkdirSync(path.join(root, '.claude'), { recursive: true })
        if (origin !== null) {
            spawnSync('git', ['init', '-q', root])
            spawnSync('git', ['-C', root, 'remote', 'add', 'origin', origin])
        }
        writeFileSync(
            path.join(root, '.claude', 'settings.json'),
            JSON.stringify({ enabledPlugins: { 'sssb@sssb': true } }),
        )
        return { dir, root }
    }
    const workflows = [
        { file: 'w.yml', text: 'uses: safeinsights/sssb/.github/workflows/app-checks.yml@' + 'd'.repeat(40) },
    ]
    const answers = {
        'repos/acme-org/acme': { body: { default_branch: 'main', private: true, owner: { type: 'Organization' } } },
        'repos/acme-org/acme/rules/branches/main': { body: ruleset(REQUIRED_CHECK) },
        'repos/acme-org/acme/private-vulnerability-reporting': { body: { enabled: false } },
        'orgs/acme-org/actions/permissions': { body: { enabled: true, allowed_actions: 'all' } },
        'repos/acme-org/acme/actions/permissions': { body: { enabled: true, allowed_actions: 'all' } },
    }

    it('reads the origin remote, asks GitHub with GETs only, and reads the plugin record of CLAUDE_CONFIG_DIR', () => {
        const { dir, root } = workspace('sssb-settings-', 'git@github.com:Acme-Org/acme.git')
        const { bin, log } = fakeGh(dir, answers)
        const config = path.join(dir, 'claude')
        mkdirSync(path.join(config, 'plugins'), { recursive: true })
        writeFileSync(
            path.join(config, 'plugins', 'installed_plugins.json'),
            JSON.stringify({
                version: 2,
                plugins: { 'sssb@sssb': [{ scope: 'project', projectPath: root, version: '0.2.0' }] },
            }),
        )
        const reports = settingsReports({
            root,
            env: { PATH: `${bin}:${PATH}`, CLAUDE_CONFIG_DIR: config },
            workflows,
            kitRepository: 'safeinsights/sssb',
        })
        expect(reports.map(({ status, title }) => `${status} ${title}`)).toEqual([
            'ok github: sssb / all-checks is a required check on main (a ruleset requires it)',
            expect.stringMatching(/^report github: private vulnerability reporting is off/),
            "ok github: this private repository can call SSSB's reusable workflow: yes",
            'ok claude plugin: sssb@sssb is installed',
        ])
        const calls = readFileSync(log, 'utf8').trim().split('\n')
        expect(calls.length).toBeGreaterThan(5)
        for (const call of calls) expect(call).toMatch(/^api --method GET [\w/%.-]+$/)
    })

    it('reports not-required, and a plugin this machine does not have, without failing anything', () => {
        const { dir, root } = workspace('sssb-settings-not-', 'https://github.com/acme-org/acme')
        const { bin } = fakeGh(dir, {
            ...answers,
            'repos/acme-org/acme': { body: { default_branch: 'main', private: false, owner: { type: 'User' } } },
            'repos/acme-org/acme/rules/branches/main': { body: [] },
            'repos/acme-org/acme/branches/main/protection/required_status_checks': {
                body: { message: 'Branch not protected' },
                fail: 'gh: Branch not protected (HTTP 404)\n',
            },
        })
        const reports = settingsReports({
            root,
            env: { PATH: `${bin}:${PATH}`, CLAUDE_CONFIG_DIR: path.join(dir, 'no-claude') },
            workflows,
            kitRepository: 'safeinsights/sssb',
        })
        expect(reports.map(({ status }) => status)).toEqual(['report', 'report', 'report'])
        expect(reports[0]?.title).toMatch(/is a required check on main: it is not \(reported, not failed:/)
        expect(reports[2]?.title).toMatch(
            /^claude plugin: sssb@sssb is enabled by .* but not installed: this machine has no plugin install record/,
        )
    })

    it('says "not checked" when gh is signed out, and still reports the plugin', () => {
        const { dir, root } = workspace('sssb-settings-signedout-', 'https://github.com/acme-org/acme.git')
        const { bin } = fakeGh(dir, {
            'repos/acme-org/acme': { fail: 'To get started with GitHub CLI, please run:  gh auth login\n' },
        })
        const reports = settingsReports({
            root,
            env: { PATH: `${bin}:${PATH}`, CLAUDE_CONFIG_DIR: path.join(dir, 'no-claude') },
            workflows,
            kitRepository: 'safeinsights/sssb',
        })
        expect(reports[0]).toEqual({
            status: 'report',
            title: 'github settings of acme-org/acme: not checked: gh is not signed in (run `gh auth login`)',
        })
        expect(reports).toHaveLength(2)
    })

    it('says "not checked" when the workspace has no GitHub origin, and asks gh nothing', () => {
        for (const origin of [null, 'https://gitlab.com/acme-org/acme.git']) {
            const { dir, root } = workspace('sssb-settings-noorigin-', origin)
            const { bin, log } = fakeGh(dir, answers)
            const reports = settingsReports({ root, env: { PATH: `${bin}:${PATH}` }, workflows, kitRepository: null })
            expect(reports[0]?.title).toMatch(
                /^github settings: not checked: the workspace has no `origin` remote on github\.com/,
            )
            expect(readFileSync(log, 'utf8')).toBe('')
        }
    })

    it('is skipped in CI, with a line that says so, and asks gh nothing', () => {
        const { dir, root } = workspace('sssb-settings-ci-', 'https://github.com/acme-org/acme.git')
        const { bin, log } = fakeGh(dir, answers)
        const reports = settingsReports({
            root,
            env: { PATH: `${bin}:${PATH}`, CI: 'true' },
            workflows,
            kitRepository: null,
        })
        expect(reports).toHaveLength(1)
        expect(reports[0]).toMatchObject({ status: 'report' })
        expect(reports[0]?.title).toMatch(/^github settings and plugin install: not checked: CI is set/)
        expect(readFileSync(log, 'utf8')).toBe('')
    })

    it('has no plugin line for a workspace that enables none', () => {
        const { dir, root } = workspace('sssb-settings-noplugin-', null)
        writeFileSync(path.join(root, '.claude', 'settings.json'), '{}')
        const { bin } = fakeGh(dir, answers)
        const reports = settingsReports({ root, env: { PATH: `${bin}:${PATH}` }, workflows, kitRepository: null })
        expect(reports.map(({ title }) => title)).toEqual([expect.stringMatching(/^github settings: not checked/)])
    })
})

describe('originRepository', () => {
    it('is the owner/name of a GitHub origin, lowercased, else null', () => {
        const dir = makeTestTmpDir('sssb-origin-')
        spawnSync('git', ['init', '-q', dir])
        expect(originRepository(dir)).toBeNull()
        spawnSync('git', ['-C', dir, 'remote', 'add', 'origin', 'https://github.com/Acme/App.git'])
        expect(originRepository(dir)).toBe('acme/app')
    })
})
