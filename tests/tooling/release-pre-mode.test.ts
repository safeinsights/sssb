import { execFileSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { candidateNotes, check, prepare, publishable, verifyRelease } from '../../scripts/release.mjs'
import { lintChangesets, readChangesets, releaseNotes } from '../../scripts/release-notes.mjs'
import { changesetDir } from '../support/changeset-files'
import { makeTestTmpDir } from '../support/tmp-dir'

/**
 * THE TOOLS THAT READ `.changeset/`, over a tree that has been through a release in pre mode.
 *
 * The first release candidate (v0.2.0-rc.0) was cut by the release flow, and its commit failed CI: in pre mode
 * `changeset version` MOVES each changeset it consumes to `.changeset/pre/` and keeps `.changeset/pre.json`, and a
 * test that walked `.changeset/` read `pre` as a stray directory. `release.mjs` already knew about pre/ (P7); one
 * test did not, and nothing ran the tools together over such a tree. This does: a fixture workspace is prepared (the
 * `plan` job), staged and checked (the `push` job's `verifyRelease`), committed, and then the tools that enumerate
 * `.changeset/` (the directory reader the shape test uses, `release.mjs check`, the notes tool) are run over the committed
 * tree, as the CI run on the release commit and on every later PR does, and the next candidate is cut from it. The
 * `changeset-required` gate (a shell script that diffs two commits) is pinned for a release commit's merge-back in
 * tests/tooling/changesets.test.ts. Written from the shape of that commit, so the next rc cannot meet it unprepared.
 */
const REPO = fileURLToPath(new URL('../..', import.meta.url))
const CONFIG = path.join(REPO, '.changeset/config.json')
const NO_REGISTRY = async () => ({ status: 404, ok: false, json: async () => ({}) }) as Response

const entry = (title: string, kind: string, action: string, bump: string) =>
    `---\n"@sssb/kit": ${bump}\n---\n\n### ${title}\n\n**Kind.** ${kind}\n\n**Action.** ${action}\n\n` +
    `**What changed.** ${title}.\n` +
    (action === 'none' ? '' : `\n**To adopt.** Do it.\n`)

/** A git workspace the way this repository has it before its first candidate: a private fixed group, pre mode on. */
function candidateWorkspace(changesets: Record<string, string>) {
    const root = makeTestTmpDir('sssb-pre-mode-')
    const writeJson = (file: string, value: unknown) => {
        mkdirSync(path.dirname(file), { recursive: true })
        writeFileSync(file, JSON.stringify(value, null, 4) + '\n')
    }
    writeJson(path.join(root, 'package.json'), { name: 'fixture', private: true, version: '0.0.0' })
    writeFileSync(path.join(root, 'pnpm-workspace.yaml'), 'packages:\n    - packages/*\n')
    writeJson(path.join(root, 'packages/kit/package.json'), {
        name: '@sssb/kit',
        version: '0.1.0',
        private: true,
        repository: { url: 'git+https://github.com/safeinsights/sssb.git' },
    })
    mkdirSync(path.join(root, '.changeset'))
    copyFileSync(CONFIG, path.join(root, '.changeset/config.json'))
    writeJson(path.join(root, '.changeset/pre.json'), { mode: 'pre', tag: 'rc' })
    for (const [name, text] of Object.entries(changesets)) writeFileSync(path.join(root, '.changeset', name), text)
    git(root, 'init', '-q', '-b', 'main')
    commit(root, 'init')
    return root
}

function git(root: string, ...args: string[]) {
    return execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', ...args], {
        cwd: root,
        encoding: 'utf8',
        env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' },
    }).trim()
}
function commit(root: string, message: string) {
    git(root, 'add', '-A')
    git(root, 'commit', '-q', '--no-verify', '-m', message)
    return git(root, 'rev-parse', 'HEAD')
}

describe('a tree that has been through a release in pre mode', () => {
    it('is read alike by the tools that enumerate .changeset/, and cuts the next candidate', async () => {
        const root = candidateWorkspace({
            'a-seam.md': entry('A seam gains a hook', 'seam', 'required', 'minor'),
            'b-operator.md': entry('A secret is needed', 'operator', 'optional', 'patch'),
            'c-nothing.md': '---\n---\n',
        })

        // THE PLAN JOB, then the push job's check of what it staged: rc.0, the three changesets moved to pre/, the notes
        await prepare(root, { fetchImpl: NO_REGISTRY })
        git(root, 'add', '-A')
        expect(() => verifyRelease(root, '0.2.0-rc.0')).not.toThrow()
        const rc0 = commit(root, 'chore: release v0.2.0-rc.0')
        git(root, 'tag', 'v0.2.0-rc.0')
        const dir = path.join(root, '.changeset')
        expect(existsSync(path.join(dir, 'pre.json'))).toBe(true)

        // THE TAG RUN's `candidate` job, on that commit: the prerelease's notes, which are the file the release commit carries (the changesets are gone from `.changeset/` by then)
        const prerelease = candidateNotes(root, '0.2.0-rc.0', 'safeinsights/sssb', rc0, [])
        expect(prerelease).toMatch(/^# Release notes: v0\.2\.0-rc\.0\n/)
        expect(prerelease).toMatch(/### A seam gains a hook/)
        expect(prerelease).toMatch(/## Installing this release candidate/)

        // THE CI RUN ON THAT COMMIT. The directory is read as Changesets leaves it: nothing pending, three consumed,
        // `pre` not a stray.
        expect(changesetDir(dir)).toEqual({
            pending: [],
            consumed: ['pre/a-seam.md', 'pre/b-operator.md', 'pre/c-nothing.md'],
            problems: [],
        })
        // `release.mjs check` (CI's `release-plan`): fine, and nothing to release
        const judged = await check(root)
        expect(judged.problems).toEqual([])
        expect(judged.changesets).toBe(0)
        // the shape lint and the notes tool: nothing pending to refuse, and the notes of nothing say so
        expect(lintChangesets(root)).toEqual([])
        expect(releaseNotes(root).markdown).toMatch(/No change in this release asks anything of an adopter\./)
        // and nothing pending means no release, until a changeset is added
        expect(await prepare(root, { fetchImpl: NO_REGISTRY })).toEqual({
            release: false,
            reason: 'no changesets are pending',
        })

        // THE NEXT CANDIDATE: a new changeset is the only pending one; its notes carry it alone
        writeFileSync(path.join(dir, 'd-fix.md'), entry('A label is fixed', 'none', 'none', 'patch'))
        commit(root, 'feat: a fix')
        expect(changesetDir(dir).pending).toEqual(['d-fix.md'])
        expect((await check(root)).problems).toEqual([])
        const result = await prepare(root, { fetchImpl: NO_REGISTRY })
        expect(result).toMatchObject({ release: true, version: '0.2.0-rc.1', notes: 'docs/releases/v0.2.0-rc.1.md' })
        git(root, 'add', '-A')
        expect(() => verifyRelease(root, '0.2.0-rc.1')).not.toThrow()
        const rc1 = commit(root, 'chore: release v0.2.0-rc.1')
        git(root, 'tag', 'v0.2.0-rc.1')
        const notes = readFileSync(path.join(root, 'docs/releases/v0.2.0-rc.1.md'), 'utf8')
        expect(notes).toMatch(/### A label is fixed/)
        expect(notes).not.toMatch(/A seam gains a hook/)

        // after rc.1 the directory still reads cleanly, with all four consumed
        expect(changesetDir(dir)).toEqual({
            pending: [],
            consumed: ['pre/a-seam.md', 'pre/b-operator.md', 'pre/c-nothing.md', 'pre/d-fix.md'],
            problems: [],
        })
        // rc.1's notes can be regenerated from the commit before it (the release commit moved the changeset they come from)
        expect(releaseNotes(root, { at: `${rc1}^`, version: '0.2.0-rc.1' }).markdown).toBe(notes)
        // and since the changeset moved to pre/, nothing is pending from rc.0 to the rc.1 commit: `--since` reads
        // `.changeset/`, so a finished candidate's notes are the file its release commit carries, or `--at <commit>^`
        expect(releaseNotes(root, { since: 'v0.2.0-rc.0', at: 'v0.2.0-rc.1' }).entries).toBe(0)
        // rc.0's own notes, from the commit before it
        expect(readChangesets(root, { at: `${rc0}^` }).map((c: { file: string }) => c.file)).toEqual([
            '.changeset/a-seam.md',
            '.changeset/b-operator.md',
            '.changeset/c-nothing.md',
        ])
    }, 120_000)
})

/** A candidate workspace cut through rc.0 and rc.1, as this repository was before P14 (it stopped at rc.2). */
async function throughTwoCandidates() {
    const root = candidateWorkspace({
        'a-seam.md': entry('A seam gains a hook', 'seam', 'required', 'minor'),
        'b-operator.md': entry('A secret is needed', 'operator', 'optional', 'patch'),
        'c-nothing.md': '---\n---\n',
    })
    for (const [version, add] of [
        ['0.2.0-rc.0', null],
        ['0.2.0-rc.1', 'd-fix.md'],
    ] as const) {
        if (add) {
            writeFileSync(path.join(root, '.changeset', add), entry('A label is fixed', 'none', 'none', 'patch'))
            commit(root, `feat: ${add}`)
        }
        await prepare(root, { fetchImpl: NO_REGISTRY })
        git(root, 'add', '-A')
        verifyRelease(root, version)
        commit(root, `chore: release v${version}`)
        git(root, 'tag', `v${version}`)
    }
    return root
}

/** ADR-0014 P14's change, as its PR makes it: pre mode left by deleting pre.json, `private` off, one changeset. */
function leavePreMode(root: string) {
    rmSync(path.join(root, '.changeset/pre.json'))
    const manifest = path.join(root, 'packages/kit/package.json')
    const parsed = JSON.parse(readFileSync(manifest, 'utf8'))
    delete parsed.private
    writeFileSync(manifest, JSON.stringify(parsed, null, 4) + '\n')
    writeFileSync(
        path.join(root, '.changeset/e-public.md'),
        entry('The packages are public', 'scaffold', 'optional', 'patch'),
    )
    return commit(root, 'feat: the first public release')
}

/**
 * LEAVING PRE MODE (ADR-0014 P14, `.claude/future-tasks/resolved/p14-leave-pre-mode.md`). The candidates' changesets sit
 * in `.changeset/pre/`; once `pre.json` is gone, Changesets counts them as pending again and its next `changeset
 * version` releases and DELETES them, with the new ones, at the version the candidates were heading for. The tools
 * here must agree with it at every step, run against the real CLI: `check` judges them, the notes carry them, `prepare`
 * versions to the plain release, and `verify-release` accepts their deletion and nothing else.
 */
describe('leaving pre mode: the first plain release (ADR-0014 P14)', () => {
    it('releases the version the candidates were heading for, with every candidate change in its notes', async () => {
        const root = await throughTwoCandidates()
        leavePreMode(root)
        const dir = path.join(root, '.changeset')

        // EVERY PR AFTER THE CHANGE: the four consumed changesets are pending again, and judged, with the new one
        const judged = await check(root)
        expect(judged.problems).toEqual([])
        expect(judged.changesets).toBe(5)
        expect(judged.plan.map((r: { newVersion: string }) => r.newVersion)).toEqual(['0.2.0'])
        expect(lintChangesets(root)).toEqual([])
        expect(readChangesets(root).map((c: { file: string }) => c.file)).toEqual([
            '.changeset/e-public.md',
            '.changeset/pre/a-seam.md',
            '.changeset/pre/b-operator.md',
            '.changeset/pre/c-nothing.md',
            '.changeset/pre/d-fix.md',
        ])

        // THE PLAN JOB on the merge to main: 0.2.0, not a candidate, with the whole series in the notes
        const result = await prepare(root, { fetchImpl: NO_REGISTRY })
        expect(result).toMatchObject({ release: true, version: '0.2.0', notes: 'docs/releases/v0.2.0.md' })
        const notes = readFileSync(path.join(root, 'docs/releases/v0.2.0.md'), 'utf8')
        for (const title of [
            'A seam gains a hook',
            'A secret is needed',
            'A label is fixed',
            'The packages are public',
        ]) {
            expect(notes).toContain(`### ${title}`)
        }
        expect(notes).toMatch(/^# Release notes: v0\.2\.0\n\n4 changes, 1 requiring action\. 1 change has no/)
        // Changesets deleted every one, `pre/` included, and pre.json stays gone
        expect(changesetDir(dir)).toEqual({ pending: [], consumed: [], problems: [] })
        // (Changesets deletes the files and leaves the directory, empty, which git does not track)
        expect(existsSync(path.join(dir, 'pre')) ? readdirSync(path.join(dir, 'pre')) : []).toEqual([])
        expect(JSON.parse(readFileSync(path.join(root, 'packages/kit/package.json'), 'utf8')).version).toBe('0.2.0')

        // THE PUSH JOB: the staged release is exactly that, the consumed candidates' deletions included
        git(root, 'add', '-A')
        expect(() => verifyRelease(root, '0.2.0')).not.toThrow()
        const release = commit(root, 'chore: release v0.2.0')
        git(root, 'tag', 'v0.2.0')
        // THE TAG's pack job: the public group, at the tag's version
        expect(await publishable(root, '0.2.0')).toEqual([{ name: '@sssb/kit', dir: 'packages/kit' }])
        // the notes regenerate from the commit before the release, which still had the candidates' changesets
        expect(releaseNotes(root, { at: `${release}^`, version: '0.2.0' }).markdown).toBe(notes)
        // and what is new since the last candidate is only the P14 change
        expect(
            readChangesets(root, { since: 'v0.2.0-rc.1', at: `${release}^` }).map((c: { file: string }) => c.file),
        ).toEqual(['.changeset/e-public.md'])

        // AFTER IT: nothing pending, and the next release is a plain patch, never a candidate
        expect(await prepare(root, { fetchImpl: NO_REGISTRY })).toEqual({
            release: false,
            reason: 'no changesets are pending',
        })
        writeFileSync(path.join(dir, 'f-fix.md'), entry('Another fix', 'none', 'none', 'patch'))
        commit(root, 'fix: another')
        expect(await prepare(root, { fetchImpl: NO_REGISTRY })).toMatchObject({ release: true, version: '0.2.1' })
    }, 180_000)

    it('takes a candidate to its own version, never another: a patch or a minor is 0.2.0, a major refused', async () => {
        const root = await throughTwoCandidates()
        leavePreMode(root)
        for (const [bump, version] of [
            ['patch', '0.2.0'],
            ['minor', '0.2.0'],
        ]) {
            writeFileSync(path.join(root, '.changeset/g-more.md'), entry('More', 'none', 'none', bump))
            const judged = await check(root)
            expect(judged.problems).toEqual([])
            expect(new Set(judged.plan.map((r: { newVersion: string }) => r.newVersion))).toEqual(new Set([version]))
        }
        writeFileSync(path.join(root, '.changeset/g-more.md'), '---\n"@sssb/kit": major\n---\n')
        expect((await check(root)).problems.join('\n')).toMatch(/files a major for @sssb\/kit/)
    }, 180_000)

    it('refuses a release that keeps a consumed candidate, or a public group still in pre mode or in exit mode', async () => {
        const root = await throughTwoCandidates()
        leavePreMode(root)
        await prepare(root, { fetchImpl: NO_REGISTRY })
        git(root, 'add', '-A')
        // the push job, had the plan job left one of the candidates' changesets behind
        git(root, 'reset', '-q', '--', '.changeset/pre/a-seam.md')
        git(root, 'checkout', '--', '.changeset/pre/a-seam.md')
        expect(() => verifyRelease(root, '0.2.0')).toThrow(/\.changeset\/pre\/a-seam\.md is not consumed/)
        git(root, 'reset', '-q', '--hard')

        // pre.json put back on a public group: refused on the PR, and Changesets' own way out (`exit`) refused too
        writeFileSync(path.join(root, '.changeset/pre.json'), JSON.stringify({ mode: 'pre', tag: 'rc' }))
        expect((await check(root)).problems.join('\n')).toMatch(/the fixed group is public: leave pre mode/)
        writeFileSync(path.join(root, '.changeset/pre.json'), JSON.stringify({ mode: 'exit', tag: 'rc' }))
        await expect(check(root)).rejects.toThrow(/pre\.json must be exactly/)
    }, 180_000)
})

/**
 * THIS REPOSITORY'S OWN TREE, released on a copy: its manifests and `.changeset/` as committed, through `prepare` (the
 * plan job, with the real Changesets CLI) and `verify-release` (the push job). The version it releases is the one the
 * group's version leads to, which at a candidate (`0.2.0-rc.2`, where P14 found it) is that candidate's own release,
 * `0.2.0`: patch and minor both take a prerelease to its version, and a major (1.0.0) is refused before this. Read with
 * the workflow, which publishes only from a tag the release run on `main` cut, this is why the merge of int-p14 into
 * main can publish 0.2.0 and nothing else.
 */
describe("this repository's own tree", () => {
    it('releases the version its group is heading for, and the push job accepts it', async () => {
        const tracked = execFileSync('git', ['ls-files', '-z'], { cwd: REPO, encoding: 'utf8' }).split('\0')
        const copied = tracked.filter(
            (f) =>
                f === 'package.json' ||
                f === 'pnpm-workspace.yaml' ||
                f.startsWith('.changeset/') ||
                /^(apps|packages|spikes)\/[^/]+\/(package\.json|CHANGELOG\.md)$/.test(f) ||
                /^apps\/[^/]+\/infra\/package\.json$/.test(f),
        )
        const root = makeTestTmpDir('sssb-own-tree-')
        for (const f of copied) {
            mkdirSync(path.dirname(path.join(root, f)), { recursive: true })
            copyFileSync(path.join(REPO, f), path.join(root, f))
        }
        git(root, 'init', '-q', '-b', 'main')
        commit(root, 'the tree')
        const group = copied
            .filter((f) => /^packages\/[^/]+\/package\.json$/.test(f))
            .map((f) => JSON.parse(readFileSync(path.join(root, f), 'utf8')))
            .filter((m) => m.name.startsWith('@sssb/'))
        const [current] = new Set(group.map((m) => m.version))
        expect(group.every((m) => m.private === undefined)).toBe(true)

        // UNTIL 0.2.0 IS OUT, THE NEXT RELEASE IS 0.2.0 AND NOTHING ELSE. A hand-edited manifest version (0.3.0-rc.0,
        // or a plain 0.2.0) would plan another version that `check` accepts, so it is pinned here, by the release
        // commit's own notes file: once `docs/releases/v0.2.0.md` exists the pin has done its work and steps aside.
        // tracked, not merely present: a local `prepare` leaves an untracked one behind
        const firstRelease = !tracked.includes('docs/releases/v0.2.0.md')
        if (firstRelease) expect(current).toBe('0.2.0-rc.2')

        const result = await prepare(root, { fetchImpl: NO_REGISTRY })
        if (firstRelease) expect(result).toMatchObject({ release: true, version: '0.2.0' })
        if (!result.release) return // nothing pending: nothing to release, which is also nothing published
        // a candidate's group releases its own version; a released one moves on from it
        if (/-rc\.\d+$/.test(current)) expect(result.version).toBe(current.split('-')[0])
        git(root, 'add', '-A')
        expect(() => verifyRelease(root, result.version)).not.toThrow()
        expect((await publishable(root, result.version)).map((p: { name: string }) => p.name)).toEqual(
            group.map((m) => m.name).sort(),
        )
    }, 180_000)
})
