import { spawnSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { parse as parseYaml } from 'yaml'
import { describe, expect, it } from 'vitest'
import { makeTestTmpDir } from '../support/tmp-dir'

/**
 * `.github/scripts/secret-scan-range.sh`, which says which commits checks.yml's `secret-scan` job hands gitleaks, driven
 * against a real repository. The failure it exists to end: with no range, gitleaks reads `git log --all`, every branch
 * on the remote, so one branch's secret-like string failed every other pull request. Each case asks the script for a
 * range and reads the commits git then walks for it (`git log <range>`: gitleaks 8.30.1 runs `git log -p -U0 <range>`, the same walk with the diffs added), because a range
 * that parses is not a range that excludes the right branch.
 */
const ROOT = fileURLToPath(new URL('../..', import.meta.url))
const SCRIPT = path.join(ROOT, '.github/scripts/secret-scan-range.sh')
/** git with none of this machine's configuration. */
const GIT_ENV = {
    ...process.env,
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'test',
    GIT_AUTHOR_EMAIL: 'test@example.invalid',
    GIT_COMMITTER_NAME: 'test',
    GIT_COMMITTER_EMAIL: 'test@example.invalid',
}

function git(dir: string, ...args: string[]): string {
    const result = spawnSync('git', args, { cwd: dir, encoding: 'utf8', env: GIT_ENV })
    if (result.status !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr}`)
    return result.stdout.trim()
}

/** Commit `file` with `text` (or delete it, for null) under the subject `subject`; returns the new commit's id. */
function commit(dir: string, subject: string, file: string, text: string | null): string {
    if (text === null) git(dir, 'rm', '-q', file)
    else {
        mkdirSync(path.dirname(path.join(dir, file)), { recursive: true })
        writeFileSync(path.join(dir, file), text)
        git(dir, 'add', file)
    }
    git(dir, 'commit', '-q', '-m', subject)
    return git(dir, 'rev-parse', 'HEAD')
}

function range(dir: string, env: Record<string, string>) {
    const result = spawnSync('bash', [SCRIPT], { cwd: dir, encoding: 'utf8', env: { ...GIT_ENV, ...env } })
    return { status: result.status, out: result.stdout, err: result.stderr }
}

/** The subjects of the commits `git log` walks for a range, which are the commits gitleaks scans. */
function walk(dir: string, logOpts: string): string[] {
    return git(dir, 'log', '--format=%s', ...logOpts.split(' '))
        .split('\n')
        .filter(Boolean)
        .sort()
}

/**
 * main with two commits; the pull request's branch off its tip, which adds a secret-shaped file and deletes it
 * again, then adds an innocent one; and an unrelated branch that carries a commit of its own.
 */
function repository() {
    const dir = makeTestTmpDir('sssb-secret-scan-range-')
    git(dir, 'init', '-q', '-b', 'main')
    git(dir, 'config', 'commit.gpgsign', 'false')
    commit(dir, 'main one', 'a.txt', 'one\n')
    const base = commit(dir, 'main two', 'a.txt', 'two\n')
    git(dir, 'switch', '-q', '-c', 'other')
    commit(dir, 'other leaks', 'other.txt', 'a secret on an unrelated branch\n')
    git(dir, 'switch', '-q', '-c', 'pr', 'main')
    commit(dir, 'pr adds', 'pr.txt', 'a secret on the pull request\n')
    commit(dir, 'pr deletes', 'pr.txt', null)
    const head = commit(dir, 'pr innocent', 'b.txt', 'fine\n')
    return { dir, base, head }
}

describe('secret-scan-range.sh', () => {
    it("pull_request: the pull request's own commits, a commit it added and deleted again included", () => {
        const { dir, base, head } = repository()
        const { status, out } = range(dir, { EVENT_NAME: 'pull_request', BASE_SHA: base, HEAD_SHA: head })
        expect(status).toBe(0)
        // one line, no space: gitleaks splits --log-opts on spaces
        expect(out).toBe(`${base}..${head}\n`)
        expect(walk(dir, out.trim())).toEqual(['pr adds', 'pr deletes', 'pr innocent'])
    })

    it("pull_request: another branch's commits are not in the range, though every branch is in the clone", () => {
        const { dir, base, head } = repository()
        expect(git(dir, 'branch', '--format=%(refname:short)').split('\n').sort()).toEqual(['main', 'other', 'pr'])
        const { out } = range(dir, { EVENT_NAME: 'pull_request', BASE_SHA: base, HEAD_SHA: head })
        expect(walk(dir, out.trim())).not.toContain('other leaks')
        // what gitleaks walked before this script, with no --log-opts, for the same clone
        expect(git(dir, 'log', '--format=%s', '--full-history', '--all')).toContain('other leaks')
    })

    it("pull_request: a branch brought up to date with its base does not scan the base's commits again", () => {
        const { dir, head } = repository()
        git(dir, 'switch', '-q', 'main')
        const base = commit(dir, 'main three', 'a.txt', 'three\n')
        git(dir, 'switch', '-q', 'pr')
        git(dir, 'merge', '-q', '--no-ff', '--no-edit', 'main')
        const merged = git(dir, 'rev-parse', 'HEAD')
        expect(merged).not.toBe(head)
        const { out } = range(dir, { EVENT_NAME: 'pull_request', BASE_SHA: base, HEAD_SHA: merged })
        expect(walk(dir, out.trim())).toEqual(["Merge branch 'main' into pr", 'pr adds', 'pr deletes', 'pr innocent'])
    })

    it("push: HEAD, the pushed branch's whole history, never every branch", () => {
        const { dir } = repository()
        git(dir, 'switch', '-q', 'main')
        const { status, out } = range(dir, { EVENT_NAME: 'push', BASE_SHA: '', HEAD_SHA: '' })
        expect(status).toBe(0)
        expect(out).toBe('HEAD\n')
        expect(walk(dir, out.trim())).toEqual(['main one', 'main two'])
    })

    it('fails, printing no range, for an event it has no range for', () => {
        const { dir, base, head } = repository()
        for (const event of ['workflow_dispatch', 'merge_group', 'schedule', '']) {
            const { status, out, err } = range(dir, { EVENT_NAME: event, BASE_SHA: base, HEAD_SHA: head })
            expect(status, event).toBe(1)
            expect(out, event).toBe('')
            expect(err, event).toContain('no range for the event')
        }
    })

    it('fails, printing no range, for a base or head that is not a commit of this clone', () => {
        const { dir, base, head } = repository()
        const missing = 'f'.repeat(40)
        const cases: [string, string, string, string][] = [
            ['an unset base', '', head, 'BASE_SHA is not a full commit id'],
            ['an unset head', base, '', 'HEAD_SHA is not a full commit id'],
            ['a ref name', 'main', head, 'BASE_SHA is not a full commit id'],
            ['an option', '--all', head, 'BASE_SHA is not a full commit id'],
            ['a short id', base.slice(0, 12), head, 'BASE_SHA is not a full commit id'],
            ['a range', `${base}..${head}`, head, 'BASE_SHA is not a full commit id'],
            ['an id the clone lacks', missing, head, `BASE_SHA (${missing}) is not a commit in this clone`],
            ['a tree, not a commit', git(dir, 'rev-parse', 'HEAD^{tree}'), head, 'is not a commit in this clone'],
        ]
        for (const [label, baseSha, headSha, message] of cases) {
            const { status, out, err } = range(dir, {
                EVENT_NAME: 'pull_request',
                BASE_SHA: baseSha,
                HEAD_SHA: headSha,
            })
            expect(status, label).toBe(1)
            expect(out, label).toBe('')
            expect(err, label).toContain(message)
        }
    })
})

/**
 * The workflow steps that run it. The script's answer reaches gitleaks only if the step asks for it: a step that drops
 * `--log-opts`, or captures the range inside the gitleaks command's arguments (where a failed script does not stop the
 * step, and gitleaks runs with no range, which is `--all`), brings the bug back with this file's cases still green.
 */
describe('the secret-scan step of checks.yml', () => {
    const step = (text: string) => {
        const workflow = parseYaml(text) as {
            jobs: Record<string, { steps: { name?: string; env?: Record<string, string>; run?: string }[] }>
        }
        const found = workflow.jobs['secret-scan']?.steps.find((s) => s.name?.startsWith('gitleaks'))
        if (!found) throw new Error('no gitleaks step')
        return found
    }

    it('names the range script, on its own line before gitleaks, and passes gitleaks the range', () => {
        const found = step(readFileSync(path.join(ROOT, '.github/workflows/checks.yml'), 'utf8'))
        const lines = (found.run ?? '').split('\n').map((line) => line.trim())
        const captured = lines.indexOf('range=$(bash .github/scripts/secret-scan-range.sh)')
        const scan = lines.findIndex((line) => line.startsWith('./gitleaks git'))
        expect(captured).toBeGreaterThanOrEqual(0)
        expect(scan).toBeGreaterThan(captured)
        expect(lines[scan]).toBe('./gitleaks git --redact --config .gitleaks.toml --log-opts="${range:?}"')
        expect(found.env).toEqual({
            EVENT_NAME: '${{ github.event_name }}',
            BASE_SHA: '${{ github.event.pull_request.base.sha }}',
            HEAD_SHA: '${{ github.event.pull_request.head.sha }}',
        })
    })

    it('runs on the events the script has a range for, and no others', () => {
        const workflow = parseYaml(readFileSync(path.join(ROOT, '.github/workflows/checks.yml'), 'utf8')) as {
            on: Record<string, unknown>
        }
        expect(Object.keys(workflow.on).sort()).toEqual(['pull_request', 'push'])
    })
})
