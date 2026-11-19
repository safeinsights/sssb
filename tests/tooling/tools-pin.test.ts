import { spawnSync } from 'node:child_process'
import { mkdirSync, readFileSync, realpathSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { pinReport } from '../../packages/tools/src/commands/doctor-checks.js'
import { planPins } from '../../packages/tools/src/commands/pin.js'
import { makeTestTmpDir } from '../support/tmp-dir'

/**
 * `sssb pin` (packages/tools/src/commands/pin.js, adoption review follow-up 7): one command that raises the workflow's
 * `uses:` pin and the plugin marketplace's `ref` to the installed kit's release commit. Driven as a child process in a
 * scratch workspace laid out as pnpm lays an adopter's out (the kit installed under the app's `node_modules`, so the
 * command finds it the way `sssb doctor` does), and the files it leaves are judged by doctor's own pin report.
 */
const SSSB = path.resolve(__dirname, '../../packages/tools/bin/sssb.js')
const NEW = 'c'.repeat(40)
const OLD = 'a'.repeat(40)
const REPOSITORY = { type: 'git', url: 'git+https://github.com/safeinsights/sssb.git' }

type Run = { status: number | null; stdout: string; stderr: string }

function sssb(cwd: string, args: string[]): Run {
    const result = spawnSync(process.execPath, [SSSB, ...args], {
        cwd,
        encoding: 'utf8',
        env: { ...process.env, GITHUB_OUTPUT: '', GITHUB_ACTIONS: '' },
    })
    return { status: result.status, stdout: result.stdout, stderr: result.stderr }
}

function write(file: string, text: string) {
    mkdirSync(path.dirname(file), { recursive: true })
    writeFileSync(file, text)
}

const read = (ws: string, file: string) => readFileSync(path.join(ws, file), 'utf8')

const WORKFLOW = [
    'name: checks',
    'on:',
    '    pull_request:',
    'jobs:',
    '    sssb:',
    `        uses: safeinsights/sssb/.github/workflows/app-checks.yml@${OLD} # @sssb/create 0.2.0`,
    '        permissions:',
    '            contents: read',
    '    secret-scan:',
    '        uses: someone/else/.github/workflows/scan.yml@main',
    '',
].join('\n')

/** Multi-line, 4-space, with an inline array: what Prettier leaves, which a re-print of the JSON would not. */
const settings = (ref: string | null) =>
    [
        '{',
        '    "extraKnownMarketplaces": {',
        '        "sssb": {',
        '            "source": {',
        '                "source": "github",',
        `                "repo": "safeinsights/sssb"${ref === null ? '' : ','}`,
        ...(ref === null ? [] : [`                "ref": "${ref}"`]),
        '            }',
        '        }',
        '    },',
        '    "enabledPlugins": { "sssb@sssb": true },',
        '    "permissions": { "allow": ["Bash(pnpm:*)", "Bash(git:*)"] }',
        '}',
        '',
    ].join('\n')

type Options = {
    stamp?: string | null
    repository?: unknown
    workflow?: string | null
    settings?: string | null
}

/** A workspace with one app that installs a stand-in `@sssb/kit` 0.3.0, and the two pins at `OLD`. */
function workspace(prefix: string, options: Options = {}) {
    const ws = realpathSync(makeTestTmpDir(`sssb-pin-${prefix}-`))
    write(path.join(ws, 'pnpm-workspace.yaml'), "packages:\n  - 'apps/*'\n")
    write(path.join(ws, 'package.json'), JSON.stringify({ name: 'ws', private: true }))
    write(path.join(ws, 'apps', 'web', 'package.json'), JSON.stringify({ name: 'web' }))
    const kit = path.join(ws, 'apps', 'web', 'node_modules', '@sssb', 'kit')
    write(
        path.join(kit, 'package.json'),
        JSON.stringify({ name: '@sssb/kit', version: '0.3.0', repository: options.repository ?? REPOSITORY }),
    )
    const stamp = options.stamp === undefined ? `${JSON.stringify({ commit: NEW })}\n` : options.stamp
    if (stamp !== null) write(path.join(kit, 'dist', 'release.json'), stamp)
    if (options.workflow !== null)
        write(path.join(ws, '.github', 'workflows', 'checks.yml'), options.workflow ?? WORKFLOW)
    if (options.settings !== null) write(path.join(ws, '.claude', 'settings.json'), options.settings ?? settings(OLD))
    return { ws, kit }
}

const WORKFLOW_FILE = '.github/workflows/checks.yml'
const SETTINGS_FILE = '.claude/settings.json'

/** What doctor's pin report says of the files the workspace holds now. */
function doctorsReport(ws: string) {
    return pinReport({
        inRepo: false,
        version: '0.3.0',
        stamp: `${JSON.stringify({ commit: NEW })}\n`,
        repository: 'safeinsights/sssb',
        workflows: [{ file: WORKFLOW_FILE, text: read(ws, WORKFLOW_FILE) }],
        settings: { file: SETTINGS_FILE, text: read(ws, SETTINGS_FILE) },
    })
}

describe('sssb pin: raising both pins', () => {
    it('writes the kit’s release commit into the workflow and the marketplace, and says where, from which commit', () => {
        const { ws } = workspace('raise')
        const out = sssb(ws, ['pin'])
        expect(out.stderr).toBe('')
        expect(out.status).toBe(0)
        expect(out.stdout).toContain(`sssb pin: @sssb/kit 0.3.0, release commit ${NEW}`)
        expect(out.stdout).toContain(
            `.github/workflows/checks.yml:6 (.github/workflows/app-checks.yml): ${OLD} -> ${NEW}`,
        )
        expect(out.stdout).toContain(`.claude/settings.json (marketplace sssb): ${OLD} -> ${NEW}`)
        expect(out.stdout).toContain(`Raised 2 pin(s) to ${NEW}`)
        // Nothing else in either file moves: the other workflow's `uses:`, the formatting, the inline array. The
        // comment that names the version moves with the pin, so it does not name the release the pin has left.
        expect(read(ws, WORKFLOW_FILE)).toBe(
            WORKFLOW.replace(OLD, NEW).replace('@sssb/create 0.2.0', '@sssb/create 0.3.0'),
        )
        expect(read(ws, SETTINGS_FILE)).toBe(settings(OLD).replace(OLD, NEW))
    })

    it('leaves `sssb doctor`’s pin report with nothing to say, where it had two pins to name', () => {
        const { ws } = workspace('doctor')
        const before = doctorsReport(ws)
        expect(before.status).toBe('report')
        expect(before.title).toContain('2 pin(s) differ')
        expect(sssb(ws, ['pin']).status).toBe(0)
        const after = doctorsReport(ws)
        expect(after.status).toBe('ok')
        expect(after.title).toContain(`release commit ${NEW}`)
    })

    it('is a no-op when both pins are already the commit: the files are not rewritten, and it says so', () => {
        const { ws } = workspace('idempotent')
        expect(sssb(ws, ['pin']).status).toBe(0)
        const files = [read(ws, WORKFLOW_FILE), read(ws, SETTINGS_FILE)]
        // a file the run rewrites, even to the same bytes, gets a new modification time
        const past = new Date('2020-01-01T00:00:00Z')
        for (const file of [WORKFLOW_FILE, SETTINGS_FILE]) utimesSync(path.join(ws, file), past, past)
        const again = sssb(ws, ['pin'])
        expect(again.status).toBe(0)
        expect(again.stdout).toContain(
            `.github/workflows/checks.yml:6 (.github/workflows/app-checks.yml): already ${NEW}`,
        )
        expect(again.stdout).toContain(`.claude/settings.json (marketplace sssb): already ${NEW}`)
        expect(again.stdout).toContain('Every pin was already the release commit: nothing changed.')
        expect(again.stdout).not.toContain('Raised')
        expect([read(ws, WORKFLOW_FILE), read(ws, SETTINGS_FILE)]).toEqual(files)
        for (const file of [WORKFLOW_FILE, SETTINGS_FILE])
            expect(statSync(path.join(ws, file)).mtimeMs, `${file} was rewritten`).toBe(past.getTime())
    })

    it('raises the one that is behind and leaves the one that is current', () => {
        const { ws } = workspace('one-behind', { settings: settings(NEW) })
        const out = sssb(ws, ['pin'])
        expect(out.stdout).toContain(`.claude/settings.json (marketplace sssb): already ${NEW}`)
        expect(out.stdout).toContain(`checks.yml:6 (.github/workflows/app-checks.yml): ${OLD} -> ${NEW}`)
        expect(out.stdout).toContain(`Raised 1 pin(s)`)
        expect(read(ws, SETTINGS_FILE)).toBe(settings(NEW))
    })

    it('replaces a tag or a branch, which is no commit, and every workflow file that calls SSSB’s', () => {
        const { ws } = workspace('tag', {
            workflow: WORKFLOW.replace(OLD, 'v0.2.0').replace('@sssb/create 0.2.0', 'v0.2.0'),
        })
        write(
            path.join(ws, '.github', 'workflows', 'more.yaml'),
            '- uses: "SafeInsights/SSSB/.github/workflows/app-checks.yml@main"\n',
        )
        const out = sssb(ws, ['pin'])
        expect(out.status).toBe(0)
        expect(out.stdout).toContain(`checks.yml:6 (.github/workflows/app-checks.yml): v0.2.0 -> ${NEW}`)
        expect(out.stdout).toContain(`more.yaml:1 (.github/workflows/app-checks.yml): main -> ${NEW}`)
        expect(read(ws, WORKFLOW_FILE)).toContain(`app-checks.yml@${NEW} # v0.3.0\n`)
        expect(read(ws, '.github/workflows/more.yaml')).toBe(
            `- uses: "SafeInsights/SSSB/.github/workflows/app-checks.yml@${NEW}"\n`,
        )
    })

    it('leaves a comment of the adopter’s own alone', () => {
        const { ws } = workspace('comment', {
            workflow: WORKFLOW.replace('# @sssb/create 0.2.0', '# bumped by hand, see #12'),
        })
        expect(sssb(ws, ['pin']).status).toBe(0)
        expect(read(ws, WORKFLOW_FILE)).toContain(`app-checks.yml@${NEW} # bumped by hand, see #12\n`)
    })

    it('says when only the version in a comment was behind, and moves it', () => {
        const { ws } = workspace('comment-only', { workflow: WORKFLOW.replace(OLD, NEW) })
        const out = sssb(ws, ['pin'])
        expect(out.stdout).toContain(`already ${NEW}; the version in its comment is now 0.3.0`)
        expect(read(ws, WORKFLOW_FILE)).toContain(`@${NEW} # @sssb/create 0.3.0\n`)
    })

    it('adds the `ref` a marketplace that follows the default branch does not have, as its own formatting writes one', () => {
        const { ws } = workspace('no-ref', { settings: settings(null) })
        const out = sssb(ws, ['pin'])
        expect(out.stdout).toContain('.claude/settings.json (marketplace sssb): no ref ->')
        expect(read(ws, SETTINGS_FILE)).toBe(settings(NEW))
        expect(doctorsReport(ws).status).toBe('ok')

        const inline = workspace('no-ref-inline', {
            settings: '{"extraKnownMarketplaces":{"sssb":{"source":{"source":"github","repo":"safeinsights/sssb"}}}}',
        })
        expect(sssb(inline.ws, ['pin']).status).toBe(0)
        expect(JSON.parse(read(inline.ws, SETTINGS_FILE))).toEqual({
            extraKnownMarketplaces: { sssb: { source: { source: 'github', repo: 'safeinsights/sssb', ref: NEW } } },
        })
    })

    it('raises a marketplace declared as a git source, and every one from SSSB’s repository, and no other', () => {
        const { ws } = workspace('git-source', {
            settings: JSON.stringify({
                extraKnownMarketplaces: {
                    mine: { source: { source: 'github', repo: 'me/market', ref: OLD } },
                    sssb: { source: { source: 'github', repo: 'safeinsights/sssb', ref: OLD } },
                    fork: { source: { source: 'git', url: 'https://github.com/safeinsights/sssb.git', ref: OLD } },
                },
            }),
        })
        expect(sssb(ws, ['pin']).stdout).toContain('Raised 3 pin(s)')
        const { extraKnownMarketplaces } = JSON.parse(read(ws, SETTINGS_FILE))
        expect(extraKnownMarketplaces.mine.source.ref).toBe(OLD)
        expect(extraKnownMarketplaces.sssb.source.ref).toBe(NEW)
        expect(extraKnownMarketplaces.fork.source.ref).toBe(NEW)
    })

    it('raises the workflow alone, and says why, for a workspace whose people do not use Claude Code', () => {
        const { ws } = workspace('no-settings', { settings: null })
        const out = sssb(ws, ['pin'])
        expect(out.status).toBe(0)
        expect(out.stdout).toContain('no .claude/settings.json: no plugin marketplace pin to raise')
        expect(read(ws, WORKFLOW_FILE)).toContain(`@${NEW}`)
    })

    it('finds the app from the workspace root, from the app’s directory, and from --app', () => {
        const { ws } = workspace('where')
        expect(sssb(path.join(ws, 'apps', 'web'), ['pin']).status).toBe(0)
        write(path.join(ws, WORKFLOW_FILE), WORKFLOW)
        expect(sssb(ws, ['pin', '--app', 'apps/web']).status).toBe(0)
        expect(read(ws, WORKFLOW_FILE)).toContain(`@${NEW}`)
    })
})

describe('sssb pin: refusing, and writing nothing', () => {
    function refused(ws: string, args: string[] = ['pin']) {
        const files = [read(ws, WORKFLOW_FILE), read(ws, SETTINGS_FILE)]
        const out = sssb(ws, args)
        expect(out.status, out.stdout).toBe(1)
        expect(out.stdout).not.toContain('Raised')
        expect([read(ws, WORKFLOW_FILE), read(ws, SETTINGS_FILE)], 'a refused run wrote a file').toEqual(files)
        return out.stderr
    }

    it('refuses a kit with no release stamp (packed by hand), naming what is missing', () => {
        const { ws } = workspace('no-stamp', { stamp: null })
        const message = refused(ws)
        expect(message).toContain('@sssb/kit 0.3.0 carries no release stamp (dist/release.json)')
        expect(message).toContain('no release commit to pin SSSB to. Nothing was changed')
    })

    it('refuses a stamp that names no commit', () => {
        for (const stamp of ['{}', '{"commit":"v0.3.0"}', '{"commit":"abc"}', 'not json']) {
            const { ws } = workspace('bad-stamp', { stamp })
            expect(refused(ws), stamp).toContain('has a release stamp (dist/release.json) that names no commit')
        }
    })

    it('refuses SSSB’s own repository, where the kit is source, even with a stamp a pack left behind', () => {
        const { ws } = workspace('in-repo')
        // an app whose `@sssb/kit` is the workspace's own package, linked as `workspace:*` installs it
        const own = path.join(ws, 'packages', 'kit')
        write(
            path.join(own, 'package.json'),
            JSON.stringify({ name: '@sssb/kit', version: '0.3.0', repository: REPOSITORY }),
        )
        write(path.join(own, 'dist', 'release.json'), `${JSON.stringify({ commit: NEW })}\n`)
        write(path.join(ws, 'pnpm-workspace.yaml'), "packages:\n  - 'apps/*'\n  - 'packages/*'\n")
        write(path.join(ws, 'apps', 'api', 'package.json'), JSON.stringify({ name: 'api' }))
        mkdirSync(path.join(ws, 'apps', 'api', 'node_modules', '@sssb'), { recursive: true })
        symlinkSync(own, path.join(ws, 'apps', 'api', 'node_modules', '@sssb', 'kit'), 'dir')
        const message = refused(ws, ['pin', '--app', 'apps/api'])
        expect(message).toContain("is this workspace's own source, which carries no release stamp")
        expect(message).toContain('Nothing was changed')
    })

    it('refuses a kit whose package.json names no GitHub repository', () => {
        const { ws } = workspace('no-repo', { repository: 'https://example.com/x.git' })
        expect(refused(ws)).toContain(
            "package.json names no GitHub repository, so this cannot tell which pins are SSSB's",
        )
    })

    it('refuses when no workflow calls SSSB’s reusable workflow, and does not raise the marketplace either', () => {
        const { ws } = workspace('no-workflow', {
            workflow: 'jobs:\n    x:\n        uses: other/repo/.github/workflows/a.yml@main\n',
        })
        const message = refused(ws)
        expect(message).toContain('no workflow under .github/workflows calls a reusable workflow of safeinsights/sssb')
        expect(message).toContain('not raising any pin')
    })

    it('refuses when there is no workflow directory at all', () => {
        const { ws } = workspace('no-dir', { workflow: null })
        const out = sssb(ws, ['pin'])
        expect(out.status).toBe(1)
        expect(out.stderr).toContain('no workflow under .github/workflows calls a reusable workflow')
        expect(read(ws, SETTINGS_FILE)).toBe(settings(OLD))
    })

    it('refuses settings that are not JSON, and does not raise the workflow either', () => {
        const { ws } = workspace('bad-json', { settings: '{ "extraKnownMarketplaces": ' })
        expect(refused(ws)).toMatch(/\.claude\/settings\.json is not JSON this command can read/)
    })

    it('refuses settings with no marketplace from SSSB’s repository, as when it is another one’s', () => {
        for (const text of [
            '{}',
            '[]',
            '{"extraKnownMarketplaces":{}}',
            '{"extraKnownMarketplaces":{"x":{"source":{"source":"github","repo":"me/market","ref":"main"}}}}',
            '{"extraKnownMarketplaces":{"x":{"source":{"source":"directory","path":"."}}}}',
            '{"extraKnownMarketplaces":{"x":"safeinsights/sssb"}}',
        ]) {
            const { ws } = workspace('other-market', { settings: text })
            expect(refused(ws), text).toContain(
                '.claude/settings.json declares no marketplace from safeinsights/sssb: there is no plugin pin to raise',
            )
        }
    })

    it('refuses a `ref` that is not a string', () => {
        const { ws } = workspace('ref-number', {
            settings:
                '{"extraKnownMarketplaces":{"sssb":{"source":{"source":"github","repo":"safeinsights/sssb","ref":7}}}}',
        })
        expect(refused(ws)).toContain('its `ref` is not a string, so it is not a pin')
    })

    it('refuses an argument it does not take', () => {
        const { ws } = workspace('args')
        expect(refused(ws, ['pin', '--force'])).toContain('unknown argument --force')
    })
})

describe('sssb pin: files as they are found', () => {
    const source = (extra: string) =>
        `{"extraKnownMarketplaces":{"sssb":{"source":{"source":"github","repo":"safeinsights/sssb"${extra}}}},"enabledPlugins":{"sssb@sssb":true}}`

    it('raises the `ref` JSON.parse reads when a key repeats, as doctor and Claude Code read it', () => {
        const { ws } = workspace('dup-keys', { settings: source(`,"ref":"${OLD}","ref":"${'b'.repeat(40)}"`) })
        expect(sssb(ws, ['pin']).status).toBe(0)
        expect(JSON.parse(read(ws, SETTINGS_FILE)).extraKnownMarketplaces.sssb.source.ref).toBe(NEW)
        expect(doctorsReport(ws).status).toBe('ok')
    })

    it('adds a missing `ref` to a CRLF settings file with CRLF, so its endings stay one kind', () => {
        const crlf = settings(null).replaceAll('\n', '\r\n')
        const { ws } = workspace('crlf', { settings: crlf })
        expect(sssb(ws, ['pin']).status).toBe(0)
        const after = read(ws, SETTINGS_FILE)
        expect(after).toBe(settings(NEW).replaceAll('\n', '\r\n'))
        expect(after.replaceAll('\r\n', '')).not.toContain('\n')
    })

    it('moves the version comment of a quoted `uses:` line too', () => {
        const quoted = WORKFLOW.replace(
            `app-checks.yml@${OLD} # @sssb/create 0.2.0`,
            `app-checks.yml@${OLD}" # @sssb/create 0.2.0`,
        ).replace('uses: safeinsights', 'uses: "safeinsights')
        const { ws } = workspace('quoted', { workflow: quoted })
        expect(sssb(ws, ['pin']).status).toBe(0)
        expect(read(ws, WORKFLOW_FILE)).toContain(`@${NEW}" # @sssb/create 0.3.0\n`)
    })
})

describe('planPins', () => {
    const input = {
        commit: NEW,
        version: '0.3.0',
        repository: 'safeinsights/sssb',
        workflows: [{ file: WORKFLOW_FILE, text: WORKFLOW }],
        settings: { file: SETTINGS_FILE, text: settings(OLD) },
    }

    it('plans every file that holds a pin and nothing else, reading and writing no file', () => {
        const plan = planPins(input)
        expect(plan.refusals).toEqual([])
        expect(plan.files.map((f) => f.file)).toEqual([WORKFLOW_FILE, SETTINGS_FILE])
        expect(plan.files.flatMap((f) => f.changes.map((c) => [c.from, c.to]))).toEqual([
            [OLD, NEW],
            [OLD, NEW],
        ])
    })

    it('is a fixed point: planning over its own result changes no text', () => {
        const once = planPins(input)
        const again = planPins({
            ...input,
            workflows: [{ file: WORKFLOW_FILE, text: once.files[0]!.text }],
            settings: { file: SETTINGS_FILE, text: once.files[1]!.text },
        })
        expect(again.files.map((f) => f.text)).toEqual(once.files.map((f) => f.text))
    })

    it('keeps a CRLF workflow’s line endings', () => {
        const crlf = WORKFLOW.replaceAll('\n', '\r\n')
        const plan = planPins({ ...input, workflows: [{ file: WORKFLOW_FILE, text: crlf }] })
        expect(plan.files[0]!.text).toBe(crlf.replace(OLD, NEW).replace('0.2.0', '0.3.0'))
    })

    it('returns a refusal for the settings beside the workflow’s plan, which the caller (the CLI) drops unwritten', () => {
        const plan = planPins({ ...input, settings: { file: SETTINGS_FILE, text: '{}' } })
        expect(plan.refusals).toHaveLength(1)
        expect(plan.files.map((f) => f.file)).toEqual([WORKFLOW_FILE])
    })
})
