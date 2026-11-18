import { execFileSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { candidateNotes, check, prepare, verifyRelease } from '../../scripts/release.mjs'
import { lintChangesets, readChangesets, releaseNotes } from '../../scripts/release-notes.mjs'
import { changesetDir } from '../support/changeset-files'
import { makeTestTmpDir } from '../support/tmp-dir'

/**
 * THE WHOLE SET OF TOOLS THAT READ `.changeset/`, over a tree that has been through a release in pre mode.
 *
 * The first release candidate (v0.2.0-rc.0) was cut by the release flow, and its commit failed CI: in pre mode
 * `changeset version` MOVES each changeset it consumes to `.changeset/pre/` and keeps `.changeset/pre.json`, and a
 * test that walked `.changeset/` read `pre` as a stray directory. `release.mjs` already knew about pre/ (P7); one
 * test did not, and nothing ran the tools together over such a tree. This does: a fixture workspace is prepared (the
 * `plan` job), staged and checked (the `push` job's `verifyRelease`), committed, and then every tool that enumerates
 * `.changeset/` is run over the committed tree, as the CI run on the release commit and on every later PR does, and the
 * next candidate is cut from it. Written from the shape of that commit, so the next rc cannot meet it unprepared.
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
    it('is read alike by every tool that enumerates .changeset/, and cuts the next candidate', async () => {
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
        expect(lintChangesets(root, { consumed: true })).toEqual([])
        expect(releaseNotes(root).markdown).toMatch(/No change in this release asks anything of an adopter\./)
        // the consumed changesets are still there to read, as the notes of everything the series carried
        const series = releaseNotes(root, { consumed: true, version: '0.2.0' }).markdown
        expect(series).toMatch(/### A seam gains a hook/)
        expect(series).toMatch(/### A secret is needed/)
        expect(series).toMatch(/2 changes, 1 requiring action\. 1 change has no adopter-visible effect/)
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
        // rc.1's notes can be regenerated from the commit before it, and from the tag after it (what moved since rc.0)
        expect(releaseNotes(root, { at: `${rc1}^`, version: '0.2.0-rc.1' }).markdown).toBe(notes)
        const since = releaseNotes(root, { since: 'v0.2.0-rc.0', at: 'v0.2.0-rc.1', consumed: true })
        expect(since.markdown).toMatch(/^# Release notes\n\nChanges since v0\.2\.0-rc\.0\.\n/)
        expect(since.markdown).toMatch(/### A label is fixed/)
        expect(since.markdown).not.toMatch(/A seam gains a hook/)
        // without `consumed`, since the changeset moved, nothing was added since rc.0 that is still pending
        expect(releaseNotes(root, { since: 'v0.2.0-rc.0', at: 'v0.2.0-rc.1' }).entries).toBe(0)
        // rc.0's own notes, from the commit before it
        expect(readChangesets(root, { at: `${rc0}^` }).map((c: { file: string }) => c.file)).toEqual([
            '.changeset/a-seam.md',
            '.changeset/b-operator.md',
            '.changeset/c-nothing.md',
        ])
    }, 120_000)
})
