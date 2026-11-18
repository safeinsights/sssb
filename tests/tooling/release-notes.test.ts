import { execFileSync, spawnSync } from 'node:child_process'
import { copyFileSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { isChangesetName as releaseIsChangesetName } from '../../scripts/release.mjs'
import {
    assembleNotes,
    isChangesetName,
    lintChangeset,
    lintChangesets,
    main,
    readChangesets,
    releaseNotes,
} from '../../scripts/release-notes.mjs'
import { makeTestTmpDir } from '../support/tmp-dir'

/**
 * scripts/release-notes.mjs assembles ADR-0014 P7's release notes from `.changeset/*.md`: the four sections an adopter
 * reads, then "Other changes", each entry with its What changed, To adopt and Now deletable. Fixtures are changesets
 * in every shape that matters, including the empty "no adopter effect" one and invalid ones; the git cases drive
 * `--since` and `--at` against real repositories, which is how a release candidate's notes and a finished release's
 * notes are regenerated after `changeset version` has deleted the files.
 */
const ROOT = fileURLToPath(new URL('../..', import.meta.url))
const SCRIPT = path.join(ROOT, 'scripts/release-notes.mjs')

type Entry = {
    pkg?: string
    bump?: string
    title?: string
    kind: string
    action: string
    changed?: string
    adopt?: string
    deletable?: string
    extra?: string
}

/** A changeset in the shape `.changeset/README.md` gives. */
function changeset({
    pkg = '@sssb/kit',
    bump = 'minor',
    title = 'A change',
    kind,
    action,
    changed = 'It changed.',
    adopt = action === 'none' ? undefined : 'Do the thing.',
    deletable,
    extra = '',
}: Entry) {
    return [
        '---',
        `'${pkg}': ${bump}`,
        '---',
        '',
        `### ${title}`,
        '',
        `**Kind.** ${kind}`,
        '',
        `**Action.** ${action}`,
        '',
        `**What changed.** ${changed}`,
        ...(adopt ? ['', `**To adopt.** ${adopt}`] : []),
        ...(deletable ? ['', `**Now deletable.** ${deletable}`] : []),
        ...(extra ? ['', extra] : []),
        '',
    ].join('\n')
}

const EMPTY = '---\n---\n'

const asList = (files: Record<string, string>) => Object.entries(files).map(([file, text]) => ({ file, text }))

describe('assembleNotes', () => {
    const files = {
        '.changeset/a-seam.md': changeset({ kind: 'seam', action: 'required', title: 'A seam gains a hook' }),
        '.changeset/b-migration.md': changeset({ kind: 'migration', action: 'optional', title: 'A table is added' }),
        '.changeset/c-operator.md': changeset({ kind: 'operator', action: 'required', title: 'A secret is required' }),
        '.changeset/d-scaffold.md': changeset({ kind: 'scaffold', action: 'required', title: 'The starter moved' }),
        '.changeset/e-other.md': changeset({ kind: 'none', action: 'none', bump: 'patch', title: 'A label is fixed' }),
        '.changeset/f-nothing.md': EMPTY,
    }

    it('files each entry under its Kind, in the order ADR-0014 part 10 lists the sections', () => {
        const { markdown } = assembleNotes(asList(files), { version: '0.2.0' })
        const headings = [...markdown.matchAll(/^## (.+)$/gm)].map((m) => m[1])
        expect(headings).toEqual([
            'Seam changes',
            'Framework migrations',
            'Operator actions',
            'Scaffold changes to apply by hand',
            'Other changes',
        ])
        const section = (name: string) => markdown.split(new RegExp(`^## ${name}$`, 'm'))[1].split(/^## /m)[0]
        expect(section('Seam changes')).toMatch(/### A seam gains a hook/)
        expect(section('Framework migrations')).toMatch(/### A table is added/)
        expect(section('Operator actions')).toMatch(/### A secret is required/)
        expect(section('Scaffold changes to apply by hand')).toMatch(/### The starter moved/)
        expect(section('Other changes')).toMatch(/### A label is fixed/)
        expect(markdown).toMatch(/^# Release notes: v0\.2\.0\n/)
    })

    it('says what the adopter does: the entry keeps What changed, To adopt and Now deletable, and drops Kind and Action', () => {
        const { markdown } = assembleNotes(
            asList({
                '.changeset/x.md': changeset({
                    kind: 'seam',
                    action: 'required',
                    changed: 'The registry takes a hook.',
                    adopt: 'Register it in `app-config/hooks.ts`.',
                    deletable: 'A wrapper around the registry.',
                }),
            }),
        )
        expect(markdown).toMatch(/Action: required · `@sssb\/kit`\n/)
        expect(markdown).toMatch(/\*\*What changed\.\*\* The registry takes a hook\./)
        expect(markdown).toMatch(/\*\*To adopt\.\*\* Register it in `app-config\/hooks\.ts`\./)
        expect(markdown).toMatch(/\*\*Now deletable\.\*\* A wrapper around the registry\./)
        expect(markdown).not.toMatch(/\*\*Kind\.\*\*/)
        expect(markdown).not.toMatch(/\*\*Action\.\*\*/)
    })

    it('lists a section that has nothing as "None.", but leaves out an empty "Other changes"', () => {
        const { markdown } = assembleNotes(
            asList({ '.changeset/x.md': changeset({ kind: 'seam', action: 'required' }) }),
        )
        expect(markdown).toMatch(/## Framework migrations\n\nNone\./)
        expect(markdown).toMatch(/## Operator actions\n\nNone\./)
        expect(markdown).not.toMatch(/Other changes/)
    })

    it('counts an empty "no adopter effect" changeset and does not list it', () => {
        const { markdown, entries, empty } = assembleNotes(asList(files))
        expect(entries).toBe(5)
        expect(empty).toBe(1)
        expect(markdown).toMatch(
            /5 changes, 3 requiring action\. 1 change has no adopter-visible effect and is not listed\./,
        )
        // a release of nothing but empty changesets still has all its headings
        const none = assembleNotes(asList({ '.changeset/e.md': EMPTY }))
        expect(none.markdown).toMatch(
            /No change in this release asks anything of an adopter\. 1 change has no adopter-visible effect and is not listed\./,
        )
        expect(none.markdown).toMatch(/## Seam changes\n\nNone\./)
    })

    it('puts what the adopter must do first: required, then optional, then none, then by file name', () => {
        const { markdown } = assembleNotes(
            asList({
                '.changeset/a.md': changeset({ kind: 'operator', action: 'none', bump: 'patch', title: 'Third' }),
                '.changeset/b.md': changeset({ kind: 'operator', action: 'optional', title: 'Second' }),
                '.changeset/c.md': changeset({ kind: 'operator', action: 'required', title: 'First, by action' }),
                '.changeset/d.md': changeset({ kind: 'operator', action: 'required', title: 'First, by name' }),
            }),
        )
        const order = [...markdown.matchAll(/^### (.+)$/gm)].map((m) => m[1])
        expect(order).toEqual(['First, by action', 'First, by name', 'Second', 'Third'])
    })

    it('lists every package an entry names', () => {
        const text = changeset({ kind: 'scaffold', action: 'required' }).replace(
            "'@sssb/kit': minor",
            "'@sssb/tools': minor\n'@sssb/kit': patch",
        )
        // action required with a patch is refused, so this is also the "one entry, two packages" shape
        const ok = text.replace("'@sssb/kit': patch", "'@sssb/kit': minor")
        expect(assembleNotes(asList({ '.changeset/x.md': ok })).markdown).toMatch(
            /Action: required · `@sssb\/tools`, `@sssb\/kit`\n/,
        )
    })

    it('keeps a fenced snippet in To adopt as written, `#` comments and all', () => {
        const snippet = ['```bash', '# from the app root', 'pnpm up @sssb/kit', '```'].join('\n')
        const { markdown } = assembleNotes(
            asList({ '.changeset/x.md': changeset({ kind: 'seam', action: 'required', adopt: `Run:\n\n${snippet}` }) }),
        )
        expect(markdown).toContain(snippet)
        // and a Kind or Action line shown inside a fence is documentation, not the entry's own
        const doc = ['```md', '**Kind.** seam', '**Action.** required', '```'].join('\n')
        const withDoc = assembleNotes(
            asList({ '.changeset/x.md': changeset({ kind: 'seam', action: 'required', extra: doc }) }),
        ).markdown
        expect(withDoc).toContain(doc)
    })

    it('is byte for byte the same on every run, and in any order the files arrive', () => {
        const a = assembleNotes(asList(files), { version: '0.2.0' }).markdown
        const b = assembleNotes(asList(files).reverse(), { version: '0.2.0' }).markdown
        expect(b).toBe(a)
        expect(a).not.toMatch(/20\d\d-\d\d-\d\d/)
        expect(a.endsWith('\n')).toBe(true)
        expect(a.endsWith('\n\n')).toBe(false)
    })

    it('omits the version from the heading when none is given', () => {
        expect(assembleNotes(asList(files)).markdown).toMatch(/^# Release notes\n/)
    })

    describe('refuses a changeset that is not a readable entry, and says which file and why', () => {
        const bad: [string, string, RegExp][] = [
            ['no title', "---\n'@sssb/kit': minor\n---\n\nwords\n", /the body starts with a `### title` line/],
            [
                'an unknown kind',
                changeset({ kind: 'api', action: 'required' }),
                /`\*\*Kind\.\*\* api` must be one of seam, migration, operator, scaffold, none/,
            ],
            [
                'a missing action',
                changeset({ kind: 'seam', action: 'required' }).replace(/\*\*Action\.\*\*.*\n\n/, ''),
                /missing `\*\*Action\.\*\*`/,
            ],
            [
                'a required action with no To adopt',
                changeset({ kind: 'seam', action: 'required', adopt: '' }),
                /action required needs `\*\*To adopt\.\*\*`/,
            ],
            [
                'a required action as a patch',
                changeset({ kind: 'seam', action: 'required', bump: 'patch' }),
                /action required breaks an adopter who does nothing, so it is a minor/,
            ],
            ['a major', changeset({ kind: 'seam', action: 'required', bump: 'major' }), /must be patch or minor/],
            [
                'a package that is not @sssb/*',
                changeset({ kind: 'seam', action: 'required', pkg: 'showcase' }),
                /not an @sssb\/\* package/,
            ],
            [
                'a body on an empty changeset',
                '---\n---\n\nsome text\n',
                /an empty changeset \(no packages\) has no body/,
            ],
            [
                'frontmatter that is not one package per line',
                "---\n'@sssb/kit': minor, '@sssb/tools': minor\n---\n\n### T\n",
                /cannot read the frontmatter line/,
            ],
            ['no frontmatter', '### T\n', /no frontmatter/],
        ]
        it.each(bad)('%s', (_name, text, problem) => {
            let error: Error | undefined
            try {
                assembleNotes(
                    asList({
                        '.changeset/good.md': changeset({ kind: 'seam', action: 'required' }),
                        '.changeset/bad.md': text,
                    }),
                )
            } catch (e) {
                error = e as Error
            }
            expect(error?.name).toBe('ChangesetProblems')
            expect(error?.message).toMatch(problem)
            // every problem names its file, and the good one is not blamed
            expect(error?.message.split('\n').every((l) => l.startsWith('.changeset/bad.md: '))).toBe(true)
        })

        it('reports every bad changeset, not just the first', () => {
            expect(() => assembleNotes(asList({ '.changeset/one.md': '### x', '.changeset/two.md': '### y' }))).toThrow(
                /one\.md: no frontmatter[\s\S]*two\.md: no frontmatter/,
            )
        })
    })
})

describe("this repository's own changesets", () => {
    it('assemble, every one of them lands in a section, and none is blamed', () => {
        expect(lintChangesets(ROOT)).toEqual([])
        const changesets = readChangesets(ROOT)
        const { markdown, entries, empty } = releaseNotes(ROOT)
        expect(entries + empty).toBe(changesets.length)
        for (const { text } of changesets) {
            const title = /^### (.+)$/m.exec(text.split('---').slice(2).join('---'))?.[1]
            if (title) expect(markdown).toContain(`### ${title}`)
        }
    })

    it('reads the same names as release.mjs does: what Changesets itself reads as a changeset', () => {
        for (const name of [
            'a.md',
            'README.md',
            'readme.md',
            'AGENTS.md',
            'CLAUDE.md',
            'GEMINI.md',
            'claude.md',
            '.hidden.md',
            'config.json',
            'notes.txt',
        ]) {
            expect(isChangesetName(name), name).toBe(releaseIsChangesetName(name))
        }
    })
})

/** A repository whose `.changeset/` holds these files, committed; returns helpers to move it along. */
function repo(initial: Record<string, string>) {
    const dir = makeTestTmpDir('sssb-notes-repo-')
    const git = (...args: string[]) =>
        execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', ...args], {
            cwd: dir,
            encoding: 'utf8',
            env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' },
        }).trim()
    const write = (files: Record<string, string | null>) => {
        mkdirSync(path.join(dir, '.changeset'), { recursive: true })
        for (const [name, text] of Object.entries(files)) {
            if (text === null) rmSync(path.join(dir, '.changeset', name))
            else writeFileSync(path.join(dir, '.changeset', name), text)
        }
    }
    const commit = (message: string) => {
        git('add', '-A')
        git('commit', '-q', '--no-verify', '-m', message)
        return git('rev-parse', 'HEAD')
    }
    git('init', '-q', '-b', 'main')
    write(initial)
    commit('first')
    return { dir, git, write, commit }
}

const SEAM = (title: string) => changeset({ kind: 'seam', action: 'required', title })

describe('--since and --at: the notes of a release candidate, and of a release after it deleted its changesets', () => {
    it('--since keeps only the changesets added after the ref, and only those still there', () => {
        const r = repo({ 'old.md': SEAM('Old one'), 'gone.md': SEAM('Gone one') })
        r.git('tag', 'v0.1.0-rc.1')
        r.write({ 'new.md': SEAM('New one'), 'gone.md': null })
        r.commit('second')
        const { markdown } = releaseNotes(r.dir, { since: 'v0.1.0-rc.1' })
        expect(markdown).toMatch(/### New one/)
        expect(markdown).not.toMatch(/Old one/)
        expect(markdown).not.toMatch(/Gone one/)
    })

    it('--since lists a file that is new, and an edited one only as a correction, and says its range', () => {
        const r = repo({ 'old.md': SEAM('Old one') })
        r.git('tag', 'v1')
        r.write({ 'old.md': SEAM('Old one, corrected'), 'later.md': SEAM('Later') })
        r.commit('second')
        const { markdown } = releaseNotes(r.dir, { since: 'v1', version: '2' })
        expect(markdown).toMatch(/^# Release notes: v2\n\nChanges since v1\.\n/)
        const [sections, corrections] = markdown.split('## Corrections to earlier notes')
        expect(sections).toMatch(/### Later/)
        expect(sections).not.toMatch(/Old one/)
        expect(corrections).toMatch(/edited after v1\. If you acted on the earlier text, read them again\./)
        expect(corrections).toMatch(/### Old one, corrected/)
        // nothing edited, no heading
        r.git('tag', 'v2')
        expect(releaseNotes(r.dir, { since: 'v2' }).markdown).not.toMatch(/Corrections/)
    })

    it('--at regenerates a release from the commit before it, after `changeset version` deleted the files', () => {
        const r = repo({ 'a.md': SEAM('A'), 'b.md': changeset({ kind: 'operator', action: 'optional', title: 'B' }) })
        const notes = releaseNotes(r.dir, { version: '0.2.0' }).markdown
        // the release commit: every changeset deleted
        r.write({ 'a.md': null, 'b.md': null })
        r.commit('chore: release v0.2.0')
        expect(readChangesets(r.dir, { at: 'HEAD' })).toEqual([])
        const again = releaseNotes(r.dir, { at: 'HEAD^', version: '0.2.0' }).markdown
        expect(again).toBe(notes)
    })

    it('--at and --since together: what was added between two revisions', () => {
        const r = repo({ 'a.md': SEAM('A') })
        r.git('tag', 'one')
        r.write({ 'b.md': SEAM('B') })
        r.git('tag', '-f', 'one')
        const two = r.commit('b')
        r.write({ 'c.md': SEAM('C') })
        r.commit('c')
        const { markdown } = releaseNotes(r.dir, { since: 'one', at: two })
        expect(markdown).not.toMatch(/### A\n/)
        expect(markdown).toMatch(/### B\n/)
        expect(markdown).not.toMatch(/### C\n/)
    })

    it('judges the revision it reads: a malformed changeset in the past is still refused', () => {
        const r = repo({ 'a.md': '### no frontmatter' })
        expect(() => releaseNotes(r.dir, { at: 'HEAD' })).toThrow(/\.changeset\/a\.md: no frontmatter/)
    })
})

describe('the command line', () => {
    /** A scratch copy of the repository's layout around the script, which finds its root from where it lives. */
    function layout(files: Record<string, string>) {
        const dir = makeTestTmpDir('sssb-notes-cli-')
        mkdirSync(path.join(dir, 'scripts'))
        mkdirSync(path.join(dir, '.changeset'))
        copyFileSync(SCRIPT, path.join(dir, 'scripts', 'release-notes.mjs'))
        for (const [name, text] of Object.entries(files)) writeFileSync(path.join(dir, '.changeset', name), text)
        const run = (...args: string[]) =>
            spawnSync(process.execPath, [path.join(dir, 'scripts', 'release-notes.mjs'), ...args], {
                cwd: dir,
                encoding: 'utf8',
            })
        return { dir, run }
    }

    it('prints the notes, exits 0, and writes them to --out when asked', () => {
        const { dir, run } = layout({ 'a.md': SEAM('A'), 'README.md': 'not a changeset' })
        const printed = run('--version', '0.2.0')
        expect(printed.status).toBe(0)
        expect(printed.stdout).toMatch(/^# Release notes: v0\.2\.0\n[\s\S]*### A\n/)
        const out = path.join(dir, 'out.md')
        const written = run('--version', '0.2.0', '--out', out)
        expect(written.status).toBe(0)
        expect(written.stdout).toBe('')
        expect(readFileSync(out, 'utf8')).toBe(printed.stdout)
    })

    it('exits 1 and names the file when a changeset is malformed, printing no notes', () => {
        const { run } = layout({ 'a.md': SEAM('A'), 'bad.md': '---\n---\n\ntext\n' })
        const result = run()
        expect(result.status).toBe(1)
        expect(result.stdout).toBe('')
        expect(result.stderr).toMatch(/^\.changeset\/bad\.md: an empty changeset \(no packages\) has no body/m)
    })

    it('--check prints nothing for good changesets, and the problems for bad ones', () => {
        expect(layout({ 'a.md': SEAM('A'), 'n.md': EMPTY }).run('--check')).toMatchObject({
            status: 0,
            stdout: '',
            stderr: '',
        })
        const bad = layout({ 'bad.md': '### x' }).run('--check')
        expect(bad.status).toBe(1)
        expect(bad.stderr).toMatch(/bad\.md: no frontmatter/)
    })

    it('exits 1 on an unknown argument or a flag with no value, and an unreadable ref', () => {
        const { run } = layout({ 'a.md': SEAM('A') })
        expect(run('--nope').status).toBe(1)
        expect(run('--version').status).toBe(1)
        expect(run('--since').status).toBe(1)
        // not a git repository at all
        expect(run('--since', 'v1').status).toBe(1)
    })

    it('main takes the root, so the real repository can be judged in-process too', () => {
        expect(main(['--check'], ROOT)).toBe(0)
        expect(readdirSync(path.join(ROOT, '.changeset')).length).toBeGreaterThan(0)
    })
})

describe('the shape lint, where the notes depend on it', () => {
    it('reports only the frontmatter when a frontmatter line cannot be read, not a pile of consequences', () => {
        expect(lintChangeset("---\n'@sssb/kit': minor, '@sssb/tools': minor\n---\n\n### T\n")).toEqual([
            expect.stringMatching(/^cannot read the frontmatter line/),
        ])
    })

    it('puts entries of one section and action in file-name order, whatever order they arrive in', () => {
        const one = changeset({ kind: 'seam', action: 'required', title: 'Alpha' })
        const two = changeset({ kind: 'seam', action: 'required', title: 'Beta' })
        const forward = assembleNotes(asList({ '.changeset/a.md': one, '.changeset/b.md': two })).markdown
        const backward = assembleNotes(asList({ '.changeset/b.md': two, '.changeset/a.md': one })).markdown
        expect(backward).toBe(forward)
        expect(forward.indexOf('### Alpha')).toBeLessThan(forward.indexOf('### Beta'))
    })

    it('closes a fence only with a fence at least as long, so a longer fence can show a shorter one', () => {
        const nested = ['````md', '```bash', '# not a heading', '```', '# nor is this', '````'].join('\n')
        expect(lintChangeset(changeset({ kind: 'seam', action: 'required', adopt: `See:\n\n${nested}` }))).toEqual([])
        // ...and a real heading after the fence closes is still caught
        expect(
            lintChangeset(changeset({ kind: 'seam', action: 'required', adopt: `See:\n\n${nested}\n\n# Real` })),
        ).toEqual([expect.stringMatching(/no `#` or `##` heading/)])
    })
})

describe('what the lint accepts must read the same in the notes', () => {
    it('refuses a body that starts with a fence, which would be cut as the title', () => {
        const text = changeset({ kind: 'seam', action: 'required' }).replace(
            '### A change',
            '```sh\necho hi\n```\n\n### A change',
        )
        expect(lintChangeset(text)).toEqual([expect.stringMatching(/starts with a `### title` line/)])
    })

    it('refuses a code fence that is never closed, which would swallow the entries after it', () => {
        const open = changeset({ kind: 'seam', action: 'required', adopt: 'Run:\n\n```sh\npnpm up' })
        expect(lintChangeset(open)).toEqual([expect.stringMatching(/code fence is never closed/)])
        expect(() => assembleNotes(asList({ '.changeset/a.md': open }))).toThrow(/never closed/)
    })

    it('keeps the blank lines inside a code block as written, and still collapses them outside', () => {
        const code = ['```py', 'def a(): pass', '', '', 'def b(): pass', '```'].join('\n')
        const entry = changeset({ kind: 'seam', action: 'required', adopt: `Run:\n\n${code}\n\n\n\nThen stop.` })
        const { markdown } = assembleNotes(asList({ '.changeset/a.md': entry }))
        expect(markdown).toContain(code)
        // the three blank lines after the closing fence became one
        expect(markdown).toContain('```\n\nThen stop.')
    })

    it('refuses a second `###` heading in a body, which would read as another change', () => {
        const text = changeset({ kind: 'seam', action: 'required', extra: '### Details\n\nmore' })
        expect(lintChangeset(text)).toEqual([expect.stringMatching(/one `###` heading, its title/)])
        expect(lintChangeset(changeset({ kind: 'seam', action: 'required', extra: '#### Details\n\nmore' }))).toEqual(
            [],
        )
    })

    it('reads what Changesets reads: a BOM, a blank line first, comments, a quoted bump', () => {
        const base = changeset({ kind: 'seam', action: 'required' })
        expect(lintChangeset('\uFEFF' + base)).toEqual([])
        expect(lintChangeset('\n\n' + base)).toEqual([])
        expect(lintChangeset(base.replace("'@sssb/kit': minor", "# why\n'@sssb/kit': minor # a comment"))).toEqual([])
        expect(lintChangeset(base.replace("'@sssb/kit': minor", "'@sssb/kit': 'minor'"))).toEqual([])
        // and the notes of a BOM file have a clean entry
        const { markdown } = assembleNotes(asList({ '.changeset/a.md': '\uFEFF' + base }))
        expect(markdown).toMatch(/### A change\n\nAction: required/)
    })

    it('refuses what Changesets refuses: an unquoted @name, a duplicate package, a closing --- with text after it', () => {
        const base = changeset({ kind: 'seam', action: 'required' })
        expect(lintChangeset(base.replace("'@sssb/kit': minor", '@sssb/kit: minor'))).toEqual([
            expect.stringMatching(/cannot read the frontmatter line/),
        ])
        expect(lintChangeset(base.replace("'@sssb/kit': minor", "'@sssb/kit': minor\n'@sssb/kit': minor"))).toEqual([
            expect.stringMatching(/@sssb\/kit is named twice/),
        ])
        expect(lintChangeset(base.replace('---\n\n### A change', '--- ### A change'))).toEqual([
            expect.stringMatching(/no frontmatter/),
        ])
    })

    it('refuses a revision that starts with `-`, which git would read as an option', () => {
        const r = repo({ 'a.md': SEAM('A') })
        expect(() => readChangesets(r.dir, { since: '-R' })).toThrow(/not a revision: -R/)
        expect(() => readChangesets(r.dir, { at: '-r' })).toThrow(/not a revision: -r/)
        expect(main(['--since', '-R'], r.dir)).toBe(1)
    })

    it('says what git said when a revision does not exist', () => {
        const r = repo({ 'a.md': SEAM('A') })
        expect(() => readChangesets(r.dir, { at: 'nope' })).toThrow(/git ls-tree failed: .*nope/)
    })
})
