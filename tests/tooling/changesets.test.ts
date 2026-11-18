import { spawnSync } from 'node:child_process'
import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { changesetDir } from '../support/changeset-files'
import { lintChangeset } from '../support/changeset-shape'
import { makeTestTmpDir } from '../support/tmp-dir'

/**
 * Two guards on changesets (.changeset/README.md):
 *   1. every changeset in the tree has the body shape adopters' release notes are written from;
 *   2. `.github/scripts/require-changeset.sh`, the gate CI's `changeset-required` job runs, driven against real
 *      git repositories, each case a PR shape.
 * The cases are the "seen to fail" proof: each names the break it must catch, and each of the script's moving
 * parts (cutover rule, merge-base, first-parent, add-only filter, rename handling) was mutated to confirm a case
 * goes red.
 */
const ROOT = fileURLToPath(new URL('../..', import.meta.url))
const GATE = path.join(ROOT, '.github/scripts/require-changeset.sh')
const GATE_REL = '.github/scripts/require-changeset.sh'

const GOOD = `---
'@sssb/kit': minor
---

### A seam gains a hook

**Kind.** seam

**Action.** required

**What changed.** The registry takes a hook.

**To adopt.** Register it in \`apps/<app>/src/app-config/hooks.ts\`.

**Now deletable.** A hand-rolled wrapper around the registry.
`

describe('changeset shape', () => {
    it('every changeset in this tree is well formed', () => {
        const dir = path.join(ROOT, '.changeset')
        // In pre mode `.changeset/pre/` holds the changesets a candidate consumed: Changesets' own record, moved byte for
        // byte, not linted again (see tests/support/changeset-files.ts). Anything else that is a directory is a stray.
        const { pending, problems } = changesetDir(dir)
        expect(problems).toEqual([])
        for (const file of pending) {
            expect(lintChangeset(readFileSync(path.join(dir, file), 'utf8')), file).toEqual([])
        }
    })

    it('reads a tree in pre mode: the consumed changesets in pre/ are not strays, and anything else there is', () => {
        const dir = makeTestTmpDir('changeset-dir-')
        mkdirSync(path.join(dir, 'pre'))
        writeFileSync(path.join(dir, 'a.md'), GOOD)
        writeFileSync(path.join(dir, 'README.md'), 'x')
        writeFileSync(path.join(dir, 'pre.json'), '{"mode":"pre","tag":"rc"}')
        writeFileSync(path.join(dir, 'pre', 'b.md'), GOOD)
        expect(changesetDir(dir)).toEqual({ pending: ['a.md'], consumed: ['pre/b.md'], problems: [] })
        // what does not belong: another directory, a non-markdown file or a subdirectory inside pre/
        mkdirSync(path.join(dir, 'other'))
        writeFileSync(path.join(dir, 'pre', 'notes.txt'), 'x')
        mkdirSync(path.join(dir, 'pre', 'deeper'))
        mkdirSync(path.join(dir, 'pre', 'folder.md'))
        expect(changesetDir(dir).problems).toEqual([
            expect.stringMatching(/\.changeset\/other\/ is a directory/),
            expect.stringMatching(/\.changeset\/pre\/deeper is not a consumed changeset/),
            expect.stringMatching(/\.changeset\/pre\/folder\.md is not a consumed changeset/),
            expect.stringMatching(/\.changeset\/pre\/notes\.txt is not a consumed changeset/),
        ])
    })

    it('accepts the template, an empty changeset, and a none-kind patch', () => {
        expect(lintChangeset(GOOD)).toEqual([])
        expect(lintChangeset('---\n---\n')).toEqual([])
        expect(
            lintChangeset(
                `---\n'@sssb/kit': patch\n---\n\n### A fix\n\n**Kind.** none\n\n**Action.** none\n\n**What changed.** A wrong label.\n`,
            ),
        ).toEqual([])
    })

    it('accepts an additive entry as a patch, and shell comments in a code block in To adopt', () => {
        const additive = GOOD.replace('minor', 'patch').replace('**Action.** required', '**Action.** optional')
        expect(lintChangeset(additive)).toEqual([])
        const withSnippet = GOOD.replace(
            '**To adopt.** Register it',
            '**To adopt.**\n\n```bash\n# from the app root\npnpm up @sssb/kit\n```\n\nRegister it',
        )
        expect(lintChangeset(withSnippet)).toEqual([])
        expect(lintChangeset(withSnippet.replace(/\n/g, '\r\n'))).toEqual([])
    })

    it.each([
        ['no frontmatter', '### T\n', 'no frontmatter'],
        ['a major', GOOD.replace('minor', 'major'), 'patch or minor'],
        ['a non-@sssb package', GOOD.replace("'@sssb/kit'", "'showcase'"), 'not an @sssb/* package'],
        ['no title', GOOD.replace('### A seam gains a hook', 'Words.'), '`### title`'],
        ['an h2 title', GOOD.replace('### A seam', '## A seam'), '`### title`'],
        ['no kind', GOOD.replace('**Kind.** seam\n\n', ''), 'missing `**Kind.**`'],
        ['an unknown kind', GOOD.replace('**Kind.** seam', '**Kind.** api'), 'must be one of'],
        ['a comma list of kinds', GOOD.replace('**Kind.** seam', '**Kind.** seam, migration'), 'must be one of'],
        ['no action', GOOD.replace('**Action.** required\n\n', ''), 'missing `**Action.**`'],
        ['an unknown action', GOOD.replace('**Action.** required', '**Action.** maybe'), 'must be one of'],
        ['no what-changed', GOOD.replace('**What changed.**', '**Changed.**'), 'What changed'],
        ['no to-adopt on an acting entry', GOOD.replace(/\*\*To adopt\.\*\*.*\n\n/, ''), 'needs `**To adopt.**`'],
        ['a patch for a required action', GOOD.replace('minor', 'patch'), 'is a minor'],
        ['kind none with an action', GOOD.replace('**Kind.** seam', '**Kind.** none'), 'its action is none'],
        ['a body on an empty changeset', '---\n---\n\nSome text.\n', 'has no body'],
        ['a Kind given twice', GOOD.replace('**Kind.** seam', '**Kind.** seam\n\n**Kind.** none'), 'appears 2 times'],
        ['a heading outside a code block', GOOD + '\n# Notes\n', 'no `#` or `##` heading'],
    ])('rejects %s', (_name, text, expected) => {
        expect(lintChangeset(text).join('\n')).toContain(expected)
    })

    it('does not read a field or a heading inside a code block', () => {
        // A fenced `**Kind.** none` must not stand in for, or add to, the real Kind line.
        const fenced = GOOD.replace('**What changed.**', '```md\n**Kind.** none\n# a comment\n```\n\n**What changed.**')
        expect(lintChangeset(fenced)).toEqual([])
        // ...and a Kind that exists only inside a fence is no Kind.
        const onlyFenced = GOOD.replace('**Kind.** seam\n\n', '').replace(
            '**What changed.**',
            '```md\n**Kind.** seam\n```\n\n**What changed.**',
        )
        expect(lintChangeset(onlyFenced).join('\n')).toContain('missing `**Kind.**`')
    })

    it("pins the gate to the kit manifest's files allowlist", () => {
        const manifest = JSON.parse(readFileSync(path.join(ROOT, 'packages/kit/package.json'), 'utf8')) as {
            files: string[]
        }
        const gate = readFileSync(GATE, 'utf8')
        // No test file ships since ADR-0014 P5 (the conformance suite is `@sssb/kit/testing`, ordinary source), so
        // the gate's test-file exclusion holds for the whole of `src`.
        expect(manifest.files.filter((f) => /\.test\./.test(f) && !f.startsWith('!'))).toEqual([])
        // `dist` is built when the package is packed and is gitignored, so it is never in a diff; what builds it,
        // packages/kit/scripts/, is what the gate counts in its place.
        expect(gate).toContain('packages/kit/scripts/*')
        // The gate knows `src`, its exclusions and `dist`. A new entry (an app guide, a bin) ships files the gate does
        // not look at, so it fails here until the gate and this list both learn it.
        const known = (f: string) => f === 'src' || f.startsWith('!src/') || f === 'dist'
        expect(manifest.files.filter((f) => !known(f))).toEqual([])
    })
})

type Pr = {
    /** Files the PR changes: path to content, or null to delete a file the base has. */
    files: Record<string, string | null>
    baseRef?: string
    headRef?: string
    actor?: string
    headRepo?: string
    repo?: string
    /** When the PR was opened; the gate landed on the base at 2026-01-10T12:00:00Z. */
    createdAt?: string
    /** The gate is absent from the base. */
    noGate?: boolean
    /** Files present on the base before the PR. */
    baseFiles?: Record<string, string>
    /** The gate script was edited on the base at this date, after it was added. */
    gateEditedAt?: string
    /** The gate reached the base on a side branch (commit 2026-01-05) merged at 2026-01-10. */
    gateViaMerge?: boolean
    /** The base gained these files after the PR branched off. */
    baseAdvance?: Record<string, string>
    /** `main` changed these files after the branches diverged, and the PR merged main in. */
    mergedFromMain?: Record<string, string>
    /** `main` changed these files but the PR never merged it (it may hold a hand-applied copy). */
    mainOnly?: Record<string, string>
    /** `main` changed these files again after the PR last merged it. */
    mainAfterMerge?: Record<string, string>
}

function git(cwd: string, date: string, ...args: string[]) {
    const r = spawnSync('git', args, {
        cwd,
        encoding: 'utf8',
        env: {
            ...process.env,
            // The machine's own git config (signing, hooks, templates) must not reach the scratch repositories.
            GIT_CONFIG_GLOBAL: '/dev/null',
            GIT_CONFIG_SYSTEM: '/dev/null',
            GIT_CONFIG_NOSYSTEM: '1',
            GIT_AUTHOR_NAME: 't',
            GIT_AUTHOR_EMAIL: 't@example.test',
            GIT_COMMITTER_NAME: 't',
            GIT_COMMITTER_EMAIL: 't@example.test',
            GIT_COMMITTER_DATE: date,
            GIT_AUTHOR_DATE: date,
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

const GATE_DATE = '2026-01-10T12:00:00Z'
const KIT_MANIFEST = JSON.stringify({ name: '@sssb/kit', peerDependencies: { react: '^19' } })

/** Builds base and PR commits in a scratch repository and runs the gate on it. */
function runGate(pr: Pr) {
    const cwd = makeTestTmpDir('require-changeset-')
    const baseRef = pr.baseRef ?? 'integration'
    const g = (date: string, ...args: string[]) => git(cwd, date, ...args)
    const commit = (date: string, message: string) => {
        g(date, 'add', '-A')
        g(date, 'commit', '-q', '-m', message)
    }
    const copyGate = () => {
        mkdirSync(path.join(cwd, '.github/scripts'), { recursive: true })
        copyFileSync(GATE, path.join(cwd, GATE_REL))
    }
    g(GATE_DATE, 'init', '-q', '-b', 'main')
    write(cwd, { 'README.md': 'x\n', 'packages/kit/package.json': KIT_MANIFEST, ...(pr.baseFiles ?? {}) })
    commit('2026-01-01T00:00:00Z', 'base')
    if (pr.gateViaMerge) {
        g(GATE_DATE, 'switch', '-q', '-c', 'side')
        copyGate()
        commit('2026-01-05T12:00:00Z', 'add the gate on a side branch')
        g(GATE_DATE, 'switch', '-q', 'main')
        write(cwd, { 'other.txt': 'y\n' })
        commit('2026-01-06T00:00:00Z', 'main moves on')
        g(GATE_DATE, 'merge', '-q', '--no-ff', '-m', 'merge the side branch', 'side')
    } else if (!pr.noGate) {
        copyGate()
        commit(GATE_DATE, 'add the gate')
    }
    if (pr.gateEditedAt) {
        writeFileSync(path.join(cwd, GATE_REL), readFileSync(GATE, 'utf8') + '\n# edited\n')
        commit(pr.gateEditedAt, 'edit the gate')
        copyGate()
    }
    // main and the base start as the same commit; `main` is a ref the gate may compare with
    g(GATE_DATE, 'update-ref', 'refs/remotes/origin/main', 'HEAD')
    g(GATE_DATE, 'update-ref', `refs/remotes/origin/${baseRef}`, 'HEAD')
    g(GATE_DATE, 'switch', '-q', '-c', 'work')
    write(cwd, pr.files)
    commit('2026-02-01T00:00:00Z', 'the PR')
    if (pr.baseAdvance) {
        g(GATE_DATE, 'switch', '-q', '--detach', `refs/remotes/origin/${baseRef}`)
        write(cwd, pr.baseAdvance)
        commit('2026-02-02T00:00:00Z', 'the base moves on')
        g(GATE_DATE, 'update-ref', `refs/remotes/origin/${baseRef}`, 'HEAD')
        g(GATE_DATE, 'switch', '-q', 'work')
    }
    if (pr.mergedFromMain) {
        g(GATE_DATE, 'switch', '-q', '--detach', 'refs/remotes/origin/main')
        write(cwd, pr.mergedFromMain)
        commit('2026-02-02T00:00:00Z', 'main moves on')
        g(GATE_DATE, 'update-ref', 'refs/remotes/origin/main', 'HEAD')
        g(GATE_DATE, 'switch', '-q', 'work')
        g(GATE_DATE, 'merge', '-q', '--no-ff', '-m', 'merge main', 'refs/remotes/origin/main')
    }
    const moveMain = (files: Record<string, string>) => {
        g(GATE_DATE, 'switch', '-q', '--detach', 'refs/remotes/origin/main')
        write(cwd, files)
        commit('2026-02-03T00:00:00Z', 'main moves on again')
        g(GATE_DATE, 'update-ref', 'refs/remotes/origin/main', 'HEAD')
        g(GATE_DATE, 'switch', '-q', 'work')
    }
    if (pr.mainOnly) moveMain(pr.mainOnly)
    if (pr.mainAfterMerge) moveMain(pr.mainAfterMerge)
    // A base without the gate still runs it: the PR's own workflow file carries it, as an untracked copy here.
    copyGate()
    const r = spawnSync('bash', [path.join(cwd, GATE_REL)], {
        cwd,
        encoding: 'utf8',
        env: {
            ...process.env,
            GIT_CONFIG_GLOBAL: '/dev/null',
            GIT_CONFIG_SYSTEM: '/dev/null',
            BASE_REF: baseRef,
            HEAD_REF: pr.headRef ?? 'work',
            ACTOR: pr.actor ?? 'someone',
            HEAD_REPO: pr.headRepo ?? 'org/repo',
            REPO: pr.repo ?? 'org/repo',
            CREATED_AT: pr.createdAt ?? '2026-02-01T00:00:00Z',
        },
    })
    return { status: r.status, out: r.stdout + r.stderr }
}

const CS = { '.changeset/a-change.md': GOOD }
const KIT_SRC = { 'packages/kit/src/core/x.ts': 'a' }

describe('require-changeset gate', () => {
    it.each([
        ['a kit source change', KIT_SRC],
        ['a kit manifest change', { 'packages/kit/package.json': '{"name":"@sssb/kit","version":"1"}' }],
        ['a conformance check (ordinary kit source)', { 'packages/kit/src/testing/conformance/db.ts': 'a' }],
        ['the build of the compiled e2e entry (it makes dist)', { 'packages/kit/scripts/build-testing-e2e.mjs': 'a' }],
        ['a starter change', { 'apps/starter/src/app-config/x.ts': 'a' }],
        ['a starter test (the scaffold carries it)', { 'apps/starter/tests/e2e/x.spec.ts': 'a' }],
        ['a plugin command (adopters load it at their pin)', { 'plugins/sssb/commands/new-x.md': 'a' }],
        ['the plugin marketplace', { '.claude-plugin/marketplace.json': '{}' }],
        ['a message catalog edit', { 'packages/kit/src/i18n/messages/en.json': '{}' }],
        ['a non-ASCII path under the starter', { 'apps/starter/src/café.ts': 'a' }],
        ['a path with a quote under the starter', { 'apps/starter/src/a"b.ts': 'a' }],
        ['a path with a space under the starter', { 'apps/starter/src/a b.ts': 'a' }],
    ])('fails %s with no changeset', (_name, files) => {
        const r = runGate({ files })
        expect(r.status, r.out).toBe(1)
        expect(r.out).toContain('adds no changeset')
    })

    it('covers every @sssb/* package under packages/, not only the kit', () => {
        const pkg = (name: string) => JSON.stringify({ name })
        const tools = { 'packages/tools/package.json': pkg('@sssb/tools') }
        expect(runGate({ baseFiles: tools, files: { 'packages/tools/bin/sssb.js': 'a' } }).status).toBe(1)
        expect(runGate({ baseFiles: tools, files: { 'packages/tools/src/x.test.js': 'a' } }).status).toBe(0)
        expect(runGate({ baseFiles: tools, files: { 'packages/tools/test-fixture/x.js': 'a' } }).status).toBe(0)
        // a package that is not @sssb/* (the showcase's seed world) is not shipped
        const seed = { 'packages/seed/package.json': pkg('@app/seed') }
        expect(runGate({ baseFiles: seed, files: { 'packages/seed/src/x.ts': 'a' } }).status).toBe(0)
        // a package the PR deletes is read from the base
        const gone = runGate({
            baseFiles: { ...tools, 'packages/tools/src/x.js': 'a' },
            files: { 'packages/tools/package.json': null, 'packages/tools/src/x.js': null },
        })
        expect(gone.status, gone.out).toBe(1)
    })

    it('fails a file moved out of the kit', () => {
        const r = runGate({
            baseFiles: { 'packages/kit/src/core/x.ts': 'a' },
            files: { 'packages/kit/src/core/x.ts': null, 'docs/x.md': 'a' },
        })
        expect(r.status, r.out).toBe(1)
    })

    it('names the files that need the changeset', () => {
        const r = runGate({ files: { 'packages/kit/src/core/x.ts': 'a', 'apps/starter/src/café.ts': 'a' } })
        expect(r.out).toContain('packages/kit/src/core/x.ts')
        expect(r.out).toContain('apps/starter/src/café.ts')
    })

    it.each([
        ['a kit source change with a changeset', { ...KIT_SRC, ...CS }],
        ['a kit source change with an empty changeset', { ...KIT_SRC, '.changeset/none.md': '---\n---\n' }],
        ['a starter change with a changeset', { 'apps/starter/src/x.ts': 'a', ...CS }],
        ['a changeset with a non-ASCII name', { ...KIT_SRC, '.changeset/résumé.md': GOOD }],
    ])('passes %s', (_name, files) => {
        const r = runGate({ files })
        expect(r.status, r.out).toBe(0)
        expect(r.out).toContain('changeset file')
    })

    it.each([
        ['a kit unit test', { 'packages/kit/src/core/x.test.ts': 'a' }],
        ['a test of the conformance suite (no test file ships)', { 'packages/kit/src/db/migrate.test.ts': 'a' }],
        ['a kit story', { 'packages/kit/src/components/x.stories.tsx': 'a' }],
        ['the kit test fixture', { 'packages/kit/test-fixture/x.ts': 'a' }],
        ['a kit file the `files` allowlist leaves out', { 'packages/kit/tsconfig.json': '{}' }],
        ['the showcase', { 'apps/showcase/src/x.ts': 'a' }],
        ['docs, scripts and CI', { 'docs/x.md': 'a', 'scripts/x.mjs': 'a', '.github/workflows/x.yml': 'a' }],
        ['the lockfile', { 'pnpm-lock.yaml': 'a' }],
    ])('passes %s with no changeset', (_name, files) => {
        const r = runGate({ files })
        expect(r.status, r.out).toBe(0)
        expect(r.out).toContain('ships')
    })

    it('does not count the README, an agent file, a dotfile or a subdirectory file as a changeset', () => {
        for (const f of [
            '.changeset/README.md',
            '.changeset/readme.md',
            '.changeset/CLAUDE.md',
            '.changeset/AGENTS.md',
            '.changeset/.hidden.md',
            '.changeset/pre/x.md',
        ]) {
            const r = runGate({ files: { ...KIT_SRC, [f]: GOOD } })
            expect(r.status, `${f}: ${r.out}`).toBe(1)
        }
        // Changesets' agent-file rule is exact-case, so `claude.md` IS a changeset
        expect(runGate({ files: { ...KIT_SRC, '.changeset/claude.md': GOOD } }).status).toBe(0)
    })

    it('does not count editing a changeset that is already pending', () => {
        const r = runGate({
            baseFiles: { '.changeset/old.md': GOOD },
            files: { ...KIT_SRC, '.changeset/old.md': GOOD + '\nmore\n' },
        })
        expect(r.status, r.out).toBe(1)
        expect(runGate({ baseFiles: { '.changeset/old.md': GOOD }, files: KIT_SRC }).status).toBe(1)
    })

    it('counts a new changeset even when it replaces a similar one (git would pair them as a rename)', () => {
        const empty = '---\n---\n'
        const r = runGate({
            baseFiles: { '.changeset/old.md': empty },
            files: { ...KIT_SRC, '.changeset/old.md': null, '.changeset/new.md': empty },
        })
        expect(r.status, r.out).toBe(0)
    })

    it('judges the PR against where it branched, not against the moved-on base', () => {
        const r = runGate({ files: { 'docs/x.md': 'a' }, baseAdvance: { 'packages/kit/src/core/new.ts': 'a' } })
        expect(r.status, r.out).toBe(0)
        // ...but the PR's own change still counts
        expect(runGate({ files: KIT_SRC, baseAdvance: { 'docs/other.md': 'a' } }).status).toBe(1)
    })

    it('does not charge a PR for what it merged in from main', () => {
        const fromMain = { 'packages/kit/src/core/hotfix.ts': 'fix' }
        const r = runGate({ files: { 'docs/x.md': 'a' }, mergedFromMain: fromMain })
        expect(r.status, r.out).toBe(0)
        // the PR's own kit change alongside the merge still needs one
        expect(runGate({ files: KIT_SRC, mergedFromMain: fromMain }).status).toBe(1)
    })

    it("lets the release commit come back from main: its version bumps and the changesets it moved to pre/ are not the PR's", () => {
        // `changeset version` in pre mode bumps every package's version, writes the changelogs, moves each consumed
        // changeset to `.changeset/pre/`, and the release flow adds the notes: the commit on `main` that is then merged
        // back into the integration branch.
        const release = {
            'packages/kit/package.json': JSON.stringify({ name: '@sssb/kit', version: '0.2.0-rc.0' }),
            'packages/kit/CHANGELOG.md': '# @sssb/kit\n',
            '.changeset/pre/a-change.md': GOOD,
            'docs/releases/v0.2.0-rc.0.md': '# Release notes: v0.2.0-rc.0\n',
        }
        const r = runGate({ files: { 'docs/x.md': 'a' }, mergedFromMain: release, headRef: 'main' })
        expect(r.status, r.out).toBe(0)
        // a file moved into pre/ is Changesets' own record: it is never the changeset a shipped change must add
        const added = runGate({ files: { ...KIT_SRC, '.changeset/pre/a-change.md': GOOD } })
        expect(added.status, added.out).toBe(1)
    })

    it('does not exempt a hand-applied copy of a main change the PR never merged', () => {
        const hotfix = { 'packages/kit/src/core/hotfix.ts': 'fix' }
        const r = runGate({ files: hotfix, mainOnly: hotfix })
        expect(r.status, r.out).toBe(1)
    })

    it('still exempts what the PR merged from main after main moves on again', () => {
        const fromMain = { 'packages/kit/src/core/hotfix.ts': 'fix' }
        const r = runGate({
            files: { 'docs/x.md': 'a' },
            mergedFromMain: fromMain,
            mainAfterMerge: { 'packages/kit/src/core/hotfix.ts': 'fix 2' },
        })
        // main's newest copy is newer than what the PR merged, but the PR's copy is main's copy as of the merge it took
        expect(r.status, r.out).toBe(0)
    })

    describe('paths and manifests that try to hide a shipped change', () => {
        const pkg = (name: string) => JSON.stringify({ name })
        it('renaming a package away from @sssb/*, or breaking its manifest, is still a shipped change', () => {
            const foo = { 'packages/foo/package.json': pkg('@sssb/foo') }
            const renamed = runGate({
                baseFiles: foo,
                files: { 'packages/foo/package.json': pkg('@app/foo'), 'packages/foo/src/a.ts': 'a' },
            })
            expect(renamed.status, renamed.out).toBe(1)
            const broken = runGate({
                files: { 'packages/kit/package.json': '{"name":"@sssb/kit",}', 'packages/kit/src/a.ts': 'a' },
            })
            expect(broken.status, broken.out).toBe(1)
            // a new package whose manifest does not parse has no base manifest to fall back on
            const added = runGate({ files: { 'packages/new/package.json': '{bad', 'packages/new/src/a.ts': 'a' } })
            expect(added.status, added.out).toBe(1)
        })

        it('a package directory with a space in its name does not hide the kit', () => {
            const r = runGate({ files: { 'packages/a kit/notes.txt': 'a', ...KIT_SRC } })
            expect(r.status, r.out).toBe(1)
        })

        it('a file name holding a newline cannot pass as a test file', () => {
            const foo = { 'packages/foo/package.json': pkg('@sssb/foo') }
            const r = runGate({ baseFiles: foo, files: { 'packages/foo/src/x.test.ts\nb.ts': 'a' } })
            expect(r.status, r.out).toBe(1)
            const kit = runGate({ files: { 'packages/kit/src/x.test.ts\nb.ts': 'a' } })
            expect(kit.status, kit.out).toBe(1)
        })
    })

    describe('the release merge and the other exemptions', () => {
        it('exempts integration into main, in this repository only', () => {
            const same = runGate({ files: KIT_SRC, headRef: 'integration', baseRef: 'main' })
            expect(same.status, same.out).toBe(0)
            expect(same.out).toContain('Release merge')
            // a fork's branch of that name
            const fork = runGate({ files: KIT_SRC, headRef: 'integration', baseRef: 'main', headRepo: 'fork/repo' })
            expect(fork.status).toBe(1)
            // into any other base
            expect(runGate({ files: KIT_SRC, headRef: 'integration', baseRef: 'integration' }).status).toBe(1)
            // an environment that does not say which repository it is
            const unknown = { files: KIT_SRC, headRef: 'integration', baseRef: 'main', repo: '', headRepo: '' }
            expect(runGate(unknown).status).toBe(1)
        })

        it('exempts dependabot unless it changes the kit peer floor', () => {
            const bump = { 'pnpm-lock.yaml': 'a', 'apps/starter/package.json': '{}' }
            const r = runGate({ files: bump, actor: 'dependabot[bot]' })
            expect(r.status, r.out).toBe(0)
            const peers = JSON.stringify({ name: '@sssb/kit', peerDependencies: { react: '^20' } })
            const raised = runGate({ files: { 'packages/kit/package.json': peers }, actor: 'dependabot[bot]' })
            expect(raised.status, raised.out).toBe(1)
            // a dependency bump that leaves the peers alone is exempt
            const deps = JSON.stringify({
                name: '@sssb/kit',
                peerDependencies: { react: '^19' },
                dependencies: { a: '1' },
            })
            expect(runGate({ files: { 'packages/kit/package.json': deps }, actor: 'dependabot[bot]' }).status).toBe(0)
            // and a human changing the same file is not exempt
            expect(runGate({ files: { 'packages/kit/package.json': peers } }).status).toBe(1)
        })

        it('does not check a base that lacks the gate', () => {
            expect(runGate({ files: KIT_SRC, noGate: true }).out).toContain('does not require changesets yet')
        })

        it('does not check a PR opened before the gate, and does check one opened at that instant', () => {
            expect(runGate({ files: KIT_SRC, createdAt: '2026-01-09T00:00:00Z' }).out).toContain('Opened before')
            expect(runGate({ files: KIT_SRC, createdAt: GATE_DATE }).status).toBe(1)
        })

        it('takes the cutover from the commit that ADDED the gate, not its latest edit', () => {
            // Edited on 2026-03-01; a PR opened 2026-02-01 is after the cutover (2026-01-10), so it is checked.
            const r = runGate({ files: KIT_SRC, gateEditedAt: '2026-03-01T00:00:00Z' })
            expect(r.status, r.out).toBe(1)
        })

        it('takes the cutover from the first-parent history: the merge that brought the gate in', () => {
            // The gate was committed on a side branch 2026-01-05 and merged 2026-01-10. A PR opened in between
            // predates the base's requirement.
            const r = runGate({ files: KIT_SRC, gateViaMerge: true, createdAt: '2026-01-07T00:00:00Z' })
            expect(r.out).toContain('Opened before')
            expect(runGate({ files: KIT_SRC, gateViaMerge: true }).status).toBe(1)
        })
    })
})
