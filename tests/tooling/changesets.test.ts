import { spawnSync } from 'node:child_process'
import { copyFileSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { lintChangeset } from '../support/changeset-shape'
import { makeTestTmpDir } from '../support/tmp-dir'

/**
 * Two guards on changesets (.changeset/README.md):
 *   1. every changeset in the tree has the body shape adopters' release notes are assembled from;
 *   2. `.github/scripts/require-changeset.sh`, the gate CI's `changeset-required` job runs, driven against real
 *      git repositories, each case a PR shape.
 * The mutation cases are the "seen to fail" proof: each names the break it must catch.
 */
const ROOT = fileURLToPath(new URL('../..', import.meta.url))
const GATE = path.join(ROOT, '.github/scripts/require-changeset.sh')
const GATE_REL = '.github/scripts/require-changeset.sh'

const GOOD = `---
'@sssb/kit': minor
---

### A seam gains a hook

**Kind.** seam

**What changed.** The registry takes a hook.

**To adopt.** Register it in \`apps/<app>/src/app-config/hooks.ts\`.

**Now deletable.** A hand-rolled wrapper around the registry.
`

describe('changeset shape', () => {
    it('every changeset in this tree is well formed', () => {
        const dir = path.join(ROOT, '.changeset')
        const files = readdirSync(dir).filter(
            (f) => /^[^.].*\.md$/.test(f) && !/^(README|AGENTS|CLAUDE|GEMINI)\.md$/i.test(f),
        )
        for (const file of files) {
            expect(lintChangeset(readFileSync(path.join(dir, file), 'utf8')), file).toEqual([])
        }
    })

    it('accepts the template, an empty changeset, and a none-kind patch', () => {
        expect(lintChangeset(GOOD)).toEqual([])
        expect(lintChangeset('---\n---\n')).toEqual([])
        expect(
            lintChangeset(
                `---\n'@sssb/kit': patch\n---\n\n### A fix\n\n**Kind.** none\n\n**What changed.** A wrong label.\n`,
            ),
        ).toEqual([])
    })

    it.each([
        ['no frontmatter', '### T\n', 'no frontmatter'],
        ['a major', GOOD.replace('minor', 'major'), 'patch or minor'],
        ['a non-@sssb package', GOOD.replace("'@sssb/kit'", 'showcase'), 'not an @sssb/* package'],
        ['no title', GOOD.replace('### A seam gains a hook', 'Words.'), '`### title`'],
        ['an h2 title', GOOD.replace('### A seam', '## A seam'), '`### title`'],
        ['no kind', GOOD.replace('**Kind.** seam\n\n', ''), 'missing `**Kind.**`'],
        ['an unknown kind', GOOD.replace('**Kind.** seam', '**Kind.** api'), 'must be one of'],
        ['no what-changed', GOOD.replace('**What changed.**', '**Changed.**'), 'What changed'],
        ['no to-adopt on an acting kind', GOOD.replace(/\*\*To adopt\.\*\*.*\n\n/, ''), 'needs `**To adopt.**`'],
        ['a patch for an acting kind', GOOD.replace('minor', 'patch'), 'is a minor'],
        ['a body on an empty changeset', '---\n---\n\nSome text.\n', 'has no body'],
    ])('rejects %s', (_name, text, expected) => {
        expect(lintChangeset(text).join('\n')).toContain(expected)
    })

    it("the shape names the kit manifest's shipped tests in the gate", () => {
        const manifest = JSON.parse(readFileSync(path.join(ROOT, 'packages/kit/package.json'), 'utf8')) as {
            files: string[]
        }
        const gate = readFileSync(GATE, 'utf8')
        const shippedTests = manifest.files.filter((f) => /\.test\./.test(f) && !f.startsWith('!'))
        expect(shippedTests.length).toBeGreaterThan(0)
        for (const f of shippedTests) {
            // the gate spells a path as a regex alternative under `src/`: `i18n/namespaces\.test\.ts`
            const alternative = f.replace(/^src\//, '').replace(/\./g, '\\.')
            expect(gate, f).toContain(alternative)
        }
    })
})

type Pr = {
    /** Files the PR changes: path to content, or null to delete a file the base has. */
    files: Record<string, string | null>
    baseRef?: string
    headRef?: string
    actor?: string
    /** When the PR was opened; the gate landed on the base at 2026-01-10. */
    createdAt?: string
    /** The gate is absent from the base. */
    noGate?: boolean
    /** Files present on the base before the PR. */
    baseFiles?: Record<string, string>
}

function git(cwd: string, ...args: string[]) {
    const r = spawnSync('git', args, {
        cwd,
        encoding: 'utf8',
        env: {
            ...process.env,
            GIT_AUTHOR_NAME: 't',
            GIT_AUTHOR_EMAIL: 't@example.test',
            GIT_COMMITTER_NAME: 't',
            GIT_COMMITTER_EMAIL: 't@example.test',
            GIT_COMMITTER_DATE: '2026-01-10T12:00:00Z',
            GIT_AUTHOR_DATE: '2026-01-10T12:00:00Z',
        },
    })
    if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`)
    return r.stdout
}

function write(cwd: string, files: Record<string, string | null>) {
    for (const [rel, content] of Object.entries(files)) {
        const file = path.join(cwd, rel)
        if (content === null) rmSync(file)
        else {
            mkdirSync(path.dirname(file), { recursive: true })
            writeFileSync(file, content)
        }
    }
}

/** Builds base and PR commits in a scratch repository and runs the gate on it. */
function runGate(pr: Pr) {
    const cwd = makeTestTmpDir('require-changeset-')
    const baseRef = pr.baseRef ?? 'integration'
    git(cwd, 'init', '-q', '-b', 'main')
    write(cwd, { 'README.md': 'x\n', ...(pr.baseFiles ?? {}) })
    git(cwd, 'add', '-A')
    git(cwd, 'commit', '-q', '-m', 'base')
    if (!pr.noGate) {
        mkdirSync(path.join(cwd, '.github/scripts'), { recursive: true })
        copyFileSync(GATE, path.join(cwd, GATE_REL))
        git(cwd, 'add', '-A')
        git(cwd, 'commit', '-q', '-m', 'add the gate')
    }
    git(cwd, 'update-ref', `refs/remotes/origin/${baseRef}`, 'HEAD')
    git(cwd, 'switch', '-q', '-c', 'work')
    write(cwd, pr.files)
    git(cwd, 'add', '-A')
    git(cwd, 'commit', '-q', '-m', 'the PR')
    // A base without the gate still runs it: the PR's own workflow file carries it, as an untracked copy here.
    mkdirSync(path.join(cwd, '.github/scripts'), { recursive: true })
    copyFileSync(GATE, path.join(cwd, GATE_REL))
    const r = spawnSync('bash', [path.join(cwd, GATE_REL)], {
        cwd,
        encoding: 'utf8',
        env: {
            ...process.env,
            BASE_REF: baseRef,
            HEAD_REF: pr.headRef ?? 'work',
            ACTOR: pr.actor ?? 'someone',
            CREATED_AT: pr.createdAt ?? '2026-02-01T00:00:00Z',
        },
    })
    return { status: r.status, out: r.stdout + r.stderr }
}

const CS = { '.changeset/a-change.md': GOOD }

describe('require-changeset gate', () => {
    it.each([
        ['a kit source change', { 'packages/kit/src/core/x.ts': 'a' }],
        ['a kit manifest change', { 'packages/kit/package.json': '{}' }],
        ['a kit seam-conformance test (it ships)', { 'packages/kit/src/db/rls-pglite.test.ts': 'a' }],
        ['a starter change', { 'apps/starter/src/app-config/x.ts': 'a' }],
        ['a starter test (the scaffold carries it)', { 'apps/starter/tests/e2e/x.spec.ts': 'a' }],
        ['a message catalog edit', { 'packages/kit/src/i18n/messages/en.json': '{}' }],
    ])('fails %s with no changeset', (_name, files) => {
        const r = runGate({ files })
        expect(r.status, r.out).toBe(1)
        expect(r.out).toContain('adds no changeset')
    })

    it('fails a file moved out of the kit', () => {
        const r = runGate({
            baseFiles: { 'packages/kit/src/core/x.ts': 'a' },
            files: { 'packages/kit/src/core/x.ts': null, 'docs/x.md': 'a' },
        })
        expect(r.status, r.out).toBe(1)
    })

    it('names the files that need the changeset', () => {
        const r = runGate({ files: { 'packages/kit/src/core/x.ts': 'a' } })
        expect(r.out).toContain('packages/kit/src/core/x.ts')
    })

    it.each([
        ['a kit source change with a changeset', { 'packages/kit/src/core/x.ts': 'a', ...CS }],
        [
            'a kit source change with an empty changeset',
            { 'packages/kit/src/core/x.ts': 'a', '.changeset/none.md': '---\n---\n' },
        ],
        ['a starter change with a changeset', { 'apps/starter/src/x.ts': 'a', ...CS }],
    ])('passes %s', (_name, files) => {
        const r = runGate({ files })
        expect(r.status, r.out).toBe(0)
        expect(r.out).toContain('changeset file')
    })

    it.each([
        ['a kit unit test', { 'packages/kit/src/core/x.test.ts': 'a' }],
        ['a kit story', { 'packages/kit/src/components/x.stories.tsx': 'a' }],
        ['the kit test fixture', { 'packages/kit/test-fixture/x.ts': 'a' }],
        ['the showcase', { 'apps/showcase/src/x.ts': 'a' }],
        ['the seed package', { 'packages/seed/src/x.ts': 'a' }],
        ['docs, scripts and CI', { 'docs/x.md': 'a', 'scripts/x.mjs': 'a', '.github/workflows/x.yml': 'a' }],
        ['the lockfile', { 'pnpm-lock.yaml': 'a' }],
    ])('passes %s with no changeset', (_name, files) => {
        const r = runGate({ files })
        expect(r.status, r.out).toBe(0)
        expect(r.out).toContain('ships')
    })

    it('does not count the README, an agent file or a dotfile as a changeset', () => {
        for (const f of [
            '.changeset/README.md',
            '.changeset/readme.md',
            '.changeset/CLAUDE.md',
            '.changeset/.hidden.md',
        ]) {
            const r = runGate({ files: { 'packages/kit/src/core/x.ts': 'a', [f]: GOOD } })
            expect(r.status, `${f}: ${r.out}`).toBe(1)
        }
    })

    it('does not count a changeset the PR did not add or change', () => {
        const r = runGate({ baseFiles: { '.changeset/old.md': GOOD }, files: { 'packages/kit/src/core/x.ts': 'a' } })
        expect(r.status, r.out).toBe(1)
    })

    it('is exempt for the release merge, dependabot, a base without the gate, and a PR opened before the gate', () => {
        const kit = { 'packages/kit/src/core/x.ts': 'a' }
        expect(runGate({ files: kit, headRef: 'integration', baseRef: 'main' }).status).toBe(0)
        expect(runGate({ files: kit, actor: 'dependabot[bot]' }).status).toBe(0)
        expect(runGate({ files: kit, noGate: true }).out).toContain('does not require changesets yet')
        expect(runGate({ files: kit, createdAt: '2026-01-09T00:00:00Z' }).out).toContain('Opened before')
    })
})
