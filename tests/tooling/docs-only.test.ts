import { spawnSync } from 'node:child_process'
import { mkdirSync, readFileSync, readlinkSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { makeTestTmpDir } from '../support/tmp-dir'

/**
 * `.github/scripts/docs-only.sh`, which decides whether checks.yml's jobs take their fast path, driven against real git
 * repositories. Each case is a pull request: a base commit, a head commit on top of it, and the merge commit
 * actions/checkout leaves for `pull_request` (base first, then head). A wrong `true` lets a change skip e2e, the
 * contract tests, synth and pack and consume with every required check green, so most cases are the ways it must
 * answer false.
 */
const ROOT = fileURLToPath(new URL('../..', import.meta.url))
const SCRIPT = path.join(ROOT, '.github/scripts/docs-only.sh')

function git(dir: string, ...args: string[]): string {
    const result = spawnSync('git', args, { cwd: dir, encoding: 'utf8' })
    if (result.status !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr}`)
    return result.stdout
}

function write(dir: string, file: string, text = `${file}\n`): void {
    mkdirSync(path.dirname(path.join(dir, file)), { recursive: true })
    writeFileSync(path.join(dir, file), text)
}

/** A repository whose HEAD is the merge commit of a pull request that makes `change` on top of a base. */
function pullRequest(change: (dir: string) => void): string {
    const dir = makeTestTmpDir('sssb-docs-only-')
    git(dir, 'init', '-q', '-b', 'pr-base')
    git(dir, 'config', 'user.email', 'test@example.invalid')
    git(dir, 'config', 'user.name', 'test')
    git(dir, 'config', 'commit.gpgsign', 'false')
    for (const file of ['README.md', 'docs/adr/0001.md', 'docs/releases/v0.1.0.md', 'packages/kit/src/a.ts']) {
        write(dir, file)
    }
    git(dir, 'add', '-A')
    git(dir, 'commit', '-q', '-m', 'base')
    git(dir, 'switch', '-q', '-c', 'pr-change')
    change(dir)
    git(dir, 'add', '-A')
    git(dir, 'commit', '-q', '--allow-empty', '-m', 'head')
    git(dir, 'switch', '-q', 'pr-base')
    git(dir, 'merge', '-q', '--no-ff', '--no-edit', 'pr-change')
    return dir
}

function decide(dir: string, event = 'pull_request'): { answer: string; output: string; log: string } {
    const outputFile = path.join(dir, '..', `${path.basename(dir)}.output`)
    rmSync(outputFile, { force: true })
    writeFileSync(outputFile, '')
    const result = spawnSync('bash', [SCRIPT], {
        cwd: dir,
        encoding: 'utf8',
        env: { ...process.env, EVENT_NAME: event, GITHUB_OUTPUT: outputFile },
    })
    expect(result.status, result.stderr).toBe(0)
    const output = readFileSync(outputFile, 'utf8')
    rmSync(outputFile, { force: true })
    return { answer: /^docs-only=(\w+)$/m.exec(result.stdout)?.[1] ?? '', output, log: result.stdout }
}

describe('docs-only.sh', () => {
    it('answers true for a pull request that changes only docs/ and .claude/future-tasks/', () => {
        const dir = pullRequest((d) => {
            write(d, 'docs/adr/0001.md', 'changed\n')
            write(d, 'docs/adr/0015-new.md')
            write(d, '.claude/future-tasks/idea.md')
        })
        const { answer, output, log } = decide(dir)
        expect(answer).toBe('true')
        expect(output).toBe('docs-only=true\n')
        expect(log).toContain('only documentation changed (3 files)')
    })

    it.each([
        ['a package', 'packages/kit/src/a.ts'],
        ['the starter', 'apps/starter/README.md'],
        ['the plugin', 'plugins/sssb/commands/verify.md'],
        ['the guide', 'packages/kit/src/guide.md'],
        ['root markdown', 'CLAUDE.md'],
        ['a workflow', '.github/workflows/checks.yml'],
        ['a changeset', '.changeset/a.md'],
        ["a release's notes", 'docs/releases/v0.2.0.md'],
        ['a docs look-alike', 'docsx/a.md'],
        ['a nested docs directory', 'packages/kit/docs/a.md'],
    ])('answers false when docs change beside %s', (_label, file) => {
        const dir = pullRequest((d) => {
            write(d, 'docs/adr/0001.md', 'changed\n')
            write(d, file, 'changed\n')
        })
        const { answer, output } = decide(dir)
        expect(answer).toBe('false')
        expect(output).toBe('docs-only=false\n')
    })

    it('answers false for a file moved from code into docs/: its old path counts', () => {
        const dir = pullRequest((d) => git(d, 'mv', 'packages/kit/src/a.ts', 'docs/a.ts'))
        expect(decide(dir).answer).toBe('false')
    })

    it('answers false for a deleted file outside docs/', () => {
        const dir = pullRequest((d) => {
            write(d, 'docs/adr/0001.md', 'changed\n')
            rmSync(path.join(d, 'README.md'))
        })
        expect(decide(dir).answer).toBe('false')
    })

    it('answers false for a path git has to quote', () => {
        const dir = pullRequest((d) => write(d, 'docs/café.md'))
        expect(decide(dir).log).toMatch(/^"docs\/caf.*is not documentation/m)
        expect(decide(dir).answer).toBe('false')
    })

    it('answers false for a pull request that changes nothing', () => {
        expect(decide(pullRequest(() => {})).answer).toBe('false')
    })

    it.each(['push', 'workflow_dispatch', ''])(
        'answers false for an event that is not a pull request (%s)',
        (event) => {
            const dir = pullRequest((d) => write(d, 'docs/adr/0001.md', 'changed\n'))
            expect(decide(dir, event).answer).toBe('false')
        },
    )

    it('answers false when HEAD is not a merge commit', () => {
        const dir = pullRequest((d) => write(d, 'docs/adr/0001.md', 'changed\n'))
        git(dir, 'reset', '-q', '--hard', 'pr-change')
        expect(decide(dir).log).toContain("HEAD is not a pull request's merge commit")
        expect(decide(dir).answer).toBe('false')
    })

    it('answers false for a submodule added beside docs, whatever git is configured to ignore', () => {
        const dir = pullRequest((d) => {
            write(d, 'docs/adr/0001.md', 'changed\n')
            // A repository inside the checkout: `git add -A` records it as a gitlink.
            mkdirSync(path.join(d, 'vendor'))
            git(path.join(d, 'vendor'), 'init', '-q')
            git(path.join(d, 'vendor'), 'commit', '-q', '--allow-empty', '-m', 'vendored')
        })
        git(dir, 'config', 'diff.ignoreSubmodules', 'all')
        expect(decide(dir).log).toContain('vendor is not documentation')
        expect(decide(dir).answer).toBe('false')
    })

    // The merge commit is judged against its first parent, the base as it is now: a base that moved on with code is not
    // the pull request's change, and a docs-only head merged over it is still docs-only.
    it('judges the change against the current base, not against where the branch started', () => {
        const dir = pullRequest((d) => write(d, 'docs/adr/0001.md', 'changed\n'))
        git(dir, 'reset', '-q', '--hard', 'HEAD^1')
        write(dir, 'packages/kit/src/a.ts', 'the base moved on\n')
        git(dir, 'add', '-A')
        git(dir, 'commit', '-q', '-m', 'base moves')
        git(dir, 'merge', '-q', '--no-ff', '--no-edit', 'pr-change')
        expect(decide(dir).answer).toBe('true')
    })

    // The fast path trusts that the jobs it skips read nothing under these directories. A tracked symlink into one
    // would let a change there reach code those jobs build, and not count as code.
    it('finds no tracked symlink in this repository that resolves into docs/ or .claude/future-tasks/', () => {
        const links = spawnSync('git', ['ls-files', '-s'], { cwd: ROOT, encoding: 'utf8' })
            .stdout.split('\n')
            .filter((line) => line.startsWith('120000 '))
            .map((line) => line.split('\t')[1]!)
        const into = links.filter((link) => {
            const target = path.relative(
                ROOT,
                path.resolve(ROOT, path.dirname(link), readlinkSync(path.join(ROOT, link))),
            )
            return /^(docs|\.claude\/future-tasks)(\/|$)/.test(target)
        })
        expect(into).toEqual([])
    })
})
