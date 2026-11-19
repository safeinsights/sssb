import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { check as prettierCheck, resolveConfig } from 'prettier'
import { describe, expect, it } from 'vitest'
import { WORKFLOW_USES } from '../../packages/tools/src/commands/doctor-checks.js'
import { candidateNotes } from '../../scripts/release.mjs'
import {
    assembleNotes,
    releaseNotes,
    UPGRADE_HEADING,
    upgradeSection,
    withUpgradeSection,
} from '../../scripts/release-notes.mjs'
import { makeTestTmpDir } from '../support/tmp-dir'

/**
 * The standing "Upgrading to this release" section of every release's notes (scripts/release-notes.mjs, written into
 * the notes `release.mjs prepare` commits and, with the commit's SHA, into a candidate's prerelease by
 * `release.mjs candidate-notes`): the steps every upgrade takes whatever its entries say, as commands with the
 * release's version filled in. A step an adopter hit and the notes did not list is a test here: the guide copy that
 * `sssb doctor` fails on, the two pins that must be the release commit (`sssb pin` writes them: tools-pin.test.ts), a
 * vendor SDK knip flags once the code that used it is deleted.
 */
const ROOT = fileURLToPath(new URL('../..', import.meta.url))
const SHA = 'c'.repeat(40)
const HEADING = `## ${UPGRADE_HEADING}`

/** The `lang` fenced blocks of a markdown text, in order. */
function blocks(markdown: string, lang: string): string[] {
    return [...markdown.matchAll(new RegExp('^```' + lang + '\\n([\\s\\S]*?)\\n```$', 'gm'))].map((m) => m[1])
}

/** The upgrade section of some notes: from its heading to the next `##` heading. */
function sectionOf(markdown: string): string {
    const found = markdown.split(new RegExp(`^${HEADING}$`, 'm'))[1]
    expect(found, 'the notes have no upgrade section').toBeDefined()
    return found.split(/^## /m)[0]
}

const entry = [
    '---',
    "'@sssb/kit': patch",
    '---',
    '',
    '### A thing',
    '',
    '**Kind.** none',
    '',
    '**Action.** none',
    '',
    '**What changed.** It changed.',
    '',
].join('\n')
const changesets = [{ file: '.changeset/a.md', text: entry }]

describe('the standing upgrade section, in a plain release', () => {
    const { markdown } = assembleNotes(changesets, { version: '0.2.0' })
    const section = sectionOf(markdown)

    it('is the first section of the notes, ahead of every entry, and there once', () => {
        const headings = [...markdown.matchAll(/^## (.+)$/gm)].map((m) => m[1])
        expect(headings[0]).toBe(UPGRADE_HEADING)
        expect(headings.filter((h) => h === UPGRADE_HEADING)).toHaveLength(1)
        expect(markdown.indexOf(HEADING)).toBeLessThan(markdown.indexOf('### A thing'))
    })

    it('moves every @sssb package to this version, from npm, and installs', () => {
        expect(JSON.parse(blocks(section, 'json')[0])).toEqual({
            '@sssb/kit': '^0.2.0',
            '@sssb/tools': '^0.2.0',
            '@sssb/eslint-plugin': '^0.2.0',
            '@sssb/cdk': '^0.2.0',
        })
        expect(section).toContain('**1. Move every `@sssb/*` package to 0.2.0, together.**')
        expect(blocks(section, 'sh')[0]).toBe('pnpm install')
        expect(section).not.toContain('tarball URL (')
    })

    it('refreshes the guide copy, which `sssb doctor` fails on until it is the installed kit’s', () => {
        expect(section).toMatch(/\*\*2\. Refresh the app guide's copy,\*\*/)
        expect(blocks(section, 'sh')).toContain('pnpm exec sssb guide')
        expect(section).toContain('`sssb doctor` fails until the\ncopy is the installed kit')
        expect(section).toContain('.claude/sssb-guide.md')
    })

    it('raises both pins with `sssb pin`, not by hand, and says what to do when it refuses', () => {
        expect(section).toContain("**3. Raise both pins to this release's commit.**")
        expect(blocks(section, 'sh')).toContain('pnpm exec sssb pin')
        // the hand edits it replaced: no yaml block to copy a `<sha>` into (the json one is the package versions)
        expect(blocks(section, 'yaml')).toEqual([])
        expect(section).not.toContain('<sha>')
        // doctor names no commit for a kit with no stamp, which is a refusal too: the tag is the way to it
        expect(section).toContain("git ls-remote https://github.com/safeinsights/sssb 'refs/tags/v0.2.0'")
        expect(section).toContain('It refuses, changing nothing, when the kit carries no release\nstamp')
        expect(section).toContain('If it refuses, make the two edits by hand')
        expect(section).toContain('never the tag `v0.2.0`')
        expect(blocks(section, 'sh')).toContain(
            'claude plugin marketplace update sssb\nclaude plugin update sssb@sssb --scope project',
        )
    })

    it('puts the command after the install that brings it, and before the entries and the check', () => {
        expect(section.indexOf('pnpm exec sssb pin')).toBeGreaterThan(section.indexOf('pnpm install'))
        expect(section.indexOf('**3.')).toBeGreaterThan(section.indexOf('**2.'))
        expect(section.indexOf('**4.')).toBeGreaterThan(section.indexOf('pnpm exec sssb pin'))
    })

    it('says to drop the vendor SDKs knip now flags, after the entries are applied and before the check', () => {
        expect(section).toContain('**4. Apply each entry below, then drop what it left unused.**')
        expect(section).toContain('`@aws-sdk/client-s3`')
        expect(blocks(section, 'sh')).toContain('pnpm knip')
        expect(section.indexOf('**4.')).toBeGreaterThan(section.indexOf('**3.'))
        expect(section.indexOf('**5.')).toBeGreaterThan(section.indexOf('**4.'))
        expect(blocks(section, 'sh')).toContain('pnpm exec sssb doctor\npnpm verify')
    })

    it('is in the notes of a release whose changesets ask nothing, and in none that names no version', () => {
        const empty = assembleNotes([], { version: '0.2.1' }).markdown
        expect(empty).toMatch(
            /^# Release notes: v0\.2\.1\n\nNo change in this release asks anything of an adopter\.\n\n## Upgrading to this release\n/,
        )
        expect(sectionOf(empty)).toContain('to 0.2.1, together')
        expect(assembleNotes(changesets).markdown).not.toContain(HEADING)
    })

    it('is in the notes `--since` makes, the way a candidate’s notes are', () => {
        const since = assembleNotes(changesets, { version: '0.2.1', since: 'v0.2.0' }).markdown
        expect(since).toContain('Changes since v0.2.0.')
        expect(sectionOf(since)).toContain('to 0.2.1, together')
    })

    it('is byte for byte the same on every run', () => {
        expect(assembleNotes(changesets, { version: '0.2.0' }).markdown).toBe(markdown)
    })

    it('is prettier-clean in the file the release commit carries, with and without the SHA', async () => {
        const target = path.join(ROOT, 'docs/releases/v0.2.0.md')
        const clean = async (text: string) =>
            prettierCheck(text, { ...(await resolveConfig(target, { editorconfig: true })), filepath: target })
        expect(await clean(markdown)).toBe(true)
        expect(await clean(upgradeSection({ version: '0.2.0', sha: SHA }) + '\n')).toBe(true)
        expect(await clean(upgradeSection({ version: '0.2.0-rc.3' }) + '\n')).toBe(true)
    })
})

describe('the standing upgrade section, in a release candidate', () => {
    const section = upgradeSection({ version: '0.2.0-rc.3' })

    it('installs by tarball URL, not from npm, and keeps every other step', () => {
        expect(section).toContain('**1. Move every `@sssb/*` package to this candidate, together.**')
        expect(section).toContain('nothing\nis on npm')
        expect(blocks(section, 'json')).toEqual([]) // no `^0.2.0-rc.3` range to write, and no marketplace pin to copy
        expect(section).not.toContain('^0.2.0-rc.3')
        expect(blocks(section, 'sh')).toContain('pnpm exec sssb pin')
        expect(section).toContain('never the tag `v0.2.0-rc.3`')
        expect(blocks(section, 'sh')).toContain('pnpm exec sssb guide')
        expect(blocks(section, 'sh')).toContain('pnpm knip')
    })
})

describe('the standing upgrade section, with the release commit in hand', () => {
    const section = upgradeSection({ version: '0.2.0', sha: SHA })

    it('names the commit in the step, and still tells the adopter to run the command that writes it', () => {
        expect(section).toContain(`**3. Raise both pins to this release's commit (\`${SHA}\`).**`)
        expect(blocks(section, 'sh')).toContain('pnpm exec sssb pin')
        expect(section).not.toContain('<sha>')
        expect(section).toContain(`The commit is \`${SHA}\`.`)
        expect(section).not.toContain('git ls-remote')
    })

    it('refuses anything but a full commit SHA, which is what doctor’s pin check compares', () => {
        for (const sha of ['v0.2.0', 'main', SHA.slice(1), SHA.toUpperCase(), `${SHA}\n`]) {
            expect(() => upgradeSection({ version: '0.2.0', sha })).toThrow(`not a commit: '${sha}'`)
        }
    })

    it('uses the repository it is given in every place it names one', () => {
        const other = upgradeSection({ version: '0.2.0', sha: SHA, repo: 'someone/else' })
        expect(other).toContain('someone/else/.github/workflows/app-checks.yml@')
        expect(other).not.toContain('safeinsights')
    })
})

describe('the hand edit the section keeps is the pin `sssb pin` and `sssb doctor` read', () => {
    const line = (section: string) => {
        const found = /`uses: (\S+@<commit>)`/.exec(section)
        expect(found, 'the section names no `uses:` line').not.toBeNull()
        return `uses: ${(found as RegExpExecArray)[1].replace('<commit>', SHA)}`
    }

    it('is a `uses:` line of the repository the notes are for, at a commit', () => {
        const match = WORKFLOW_USES.exec(line(upgradeSection({ version: '0.2.0' })))
        expect(match?.[2]).toBe('safeinsights/sssb')
        expect(match?.[3]).toBe('.github/workflows/app-checks.yml')
        expect(match?.[4]).toBe(SHA)
        expect(WORKFLOW_USES.exec(line(upgradeSection({ version: '0.2.0', repo: 'someone/else' })))?.[2]).toBe(
            'someone/else',
        )
    })
})

describe('what the section tells an adopter to run exists', () => {
    it('`sssb guide`, `sssb pin` and `sssb doctor` are commands of the CLI', () => {
        const cli = readFileSync(path.join(ROOT, 'packages/tools/bin/sssb.js'), 'utf8')
        for (const command of ['guide', 'pin', 'doctor']) expect(cli).toMatch(new RegExp(`^    ${command}: \\{`, 'm'))
    })

    it('`pnpm knip` and `pnpm verify` are scripts of the workspace the generator writes', () => {
        const files = readFileSync(path.join(ROOT, 'packages/create/src/files.js'), 'utf8')
        expect(files).toMatch(/^\s+knip: 'knip',$/m)
        expect(files).toMatch(/pnpm:knip/)
        expect(files).toMatch(/^\s+verify: /m)
    })
})

describe('withUpgradeSection', () => {
    const notes = assembleNotes(changesets, { version: '0.2.0' }).markdown

    it('replaces the section in place, once, and leaves every other line as it was', () => {
        const filled = withUpgradeSection(notes, upgradeSection({ version: '0.2.0', sha: SHA }))
        expect(filled.match(/^## Upgrading to this release$/gm)).toHaveLength(1)
        expect(filled).toContain(`**3. Raise both pins to this release's commit (\`${SHA}\`).**`)
        expect(filled).not.toContain('<sha>')
        expect(filled.replace(sectionOf(filled), '')).toBe(notes.replace(sectionOf(notes), ''))
        expect(filled.endsWith('\n')).toBe(true)
        expect(filled.endsWith('\n\n')).toBe(false)
    })

    it('is idempotent', () => {
        const once = withUpgradeSection(notes, upgradeSection({ version: '0.2.0', sha: SHA }))
        expect(withUpgradeSection(once, upgradeSection({ version: '0.2.0', sha: SHA }))).toBe(once)
    })

    it('inserts a section the notes lack, before the first `##`, so notes written before it still get one', () => {
        const bare = notes.replace(`${HEADING}${sectionOf(notes)}`, '')
        expect(bare).not.toContain(HEADING)
        expect(bare).toContain('### A thing')
        const inserted = withUpgradeSection(bare, upgradeSection({ version: '0.2.0', sha: SHA }))
        expect(inserted.indexOf(HEADING)).toBeGreaterThan(inserted.indexOf('# Release notes: v0.2.0'))
        expect(inserted.indexOf(HEADING)).toBeLessThan(inserted.indexOf('### A thing'))
        expect(withUpgradeSection('# Release notes: v0.2.0\n', upgradeSection({ version: '0.2.0' }))).toContain(HEADING)
    })

    it('appends to notes with no `##` after a blank line, so the result is prettier-clean', async () => {
        const out = withUpgradeSection('# Release notes: v0.2.0\n\nSome prose.\n', upgradeSection({ version: '0.2.0' }))
        expect(out).toContain('Some prose.\n\n## Upgrading to this release\n')
        const target = path.join(ROOT, 'docs/releases/v0.2.0.md')
        expect(
            await prettierCheck(out, { ...(await resolveConfig(target, { editorconfig: true })), filepath: target }),
        ).toBe(true)
    })

    it('reads a heading inside a code block as code, never as the section’s end or start', () => {
        const fenced = [
            '# Release notes: v0.2.0',
            '',
            HEADING,
            '',
            'old text',
            '',
            '```md',
            '## Not a heading',
            '```',
            '',
            '## Seam changes',
            '',
            '```md',
            HEADING,
            '```',
            '',
        ].join('\n')
        const out = withUpgradeSection(fenced, 'NEW')
        expect(out).toContain(`\`\`\`md\n${HEADING}\n\`\`\``)
        expect(out).not.toContain('old text')
        expect(out).not.toContain('## Not a heading')
        expect(out).toContain('NEW\n\n## Seam changes')
    })
})

describe('candidateNotes, on the release commit’s own notes file', () => {
    it('writes the commit into the section the file carries, which could not name it', () => {
        const root = makeTestTmpDir('sssb-upgrade-section-')
        execFileSync('git', ['init', '-q'], { cwd: root })
        const committed = assembleNotes(changesets, { version: '0.2.0-rc.3' }).markdown
        mkdirSync(path.join(root, 'docs/releases'), { recursive: true })
        writeFileSync(path.join(root, 'docs/releases/v0.2.0-rc.3.md'), committed)
        expect(committed).not.toContain(SHA) // the notes are a file in the release commit, which cannot name itself
        const notes = candidateNotes(root, '0.2.0-rc.3', 'safeinsights/sssb', SHA, [])
        expect(notes).not.toContain('<sha>')
        expect(notes).toContain(`**3. Raise both pins to this release's commit (\`${SHA}\`).**`)
        expect(notes.match(/^## Upgrading to this release$/gm)).toHaveLength(1)
        // the candidate's own install section still follows the entries
        expect(notes).toContain('## Installing this release candidate')
    })
})

describe("this repository's next release", () => {
    it('opens with the section, at the version asked for', () => {
        const { markdown } = releaseNotes(ROOT, { version: '0.2.0' })
        expect(sectionOf(markdown)).toContain('to 0.2.0, together')
        expect(markdown.indexOf(HEADING)).toBeLessThan(markdown.indexOf('## Seam changes'))
    })
})
