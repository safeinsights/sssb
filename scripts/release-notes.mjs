#!/usr/bin/env node
// SSSB's release notes, assembled from the pending changesets (ADR-0014 part 10 and P7; `.changeset/README.md` is the
// writer's side). A changeset is a release-note entry with a fixed body, and this turns the set of them into the notes
// an adopter reads: "Seam changes", "Framework migrations", "Operator actions" and "Scaffold changes to apply by hand"
// (the Kind of each entry), then "Other changes", each entry with its What changed, To adopt and Now deletable. With a
// version, "Upgrading to this release" comes first (`upgradeSection`): the steps every upgrade takes, whatever the
// entries say.
//
//   node scripts/release-notes.mjs [--version <v>] [--since <ref>] [--at <rev>] [--out <file>] [--check]
//
//   (no flags)    every pending changeset in the working tree's `.changeset/` (out of pre mode, `pre/` too), to stdout
//   --since <ref> only the changesets ADDED after <ref> (a tag or a commit) that are still there, and, as "Corrections
//                 to earlier notes", those EDITED since: a release candidate's notes are what is new since the previous
//                 candidate. Read from git (`--at`, default HEAD), not the working tree
//   --at <rev>    read `.changeset/` as of <rev> instead of the working tree. A release deletes the changesets it
//                 consumes (in pre mode, which was every release until P14, it moves them to `.changeset/pre/`), so
//                 `--at <release commit>^` regenerates a release's notes after the fact
//
// Which changesets are read is what Changesets would consume: in pre mode (`.changeset/pre.json` with `"mode": "pre"`)
// the files directly in `.changeset/`; out of it, those and the ones earlier candidates moved to `.changeset/pre/`, which
// the next release takes and deletes. So the first plain release's notes (ADR-0014 P14) carry every change since the
// first candidate, and `--since <the last candidate's tag>` what is new since it.
//   --version <v> the heading's version
//   --out <file>  write the notes there instead of stdout
//   --check       judge the changesets and print nothing but the problems
//
// Exits 1, naming each file and its problems, when any changeset has the wrong shape: the notes are never assembled
// from a changeset that could not be read. The same shape lint is run over every changeset in the tree by
// tests/tooling/changesets.test.ts, and by `release.mjs check` on every PR and `release.mjs prepare` before
// `changeset version` deletes the files.
//
// DEPENDENCY-FREE, and loaded by `release.mjs` only when it needs it: release.yml's `push` and `publish` jobs run a
// lone copy of release.mjs with no node_modules, so that file must not import this one statically.
import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/** The release-note sections in the order the notes list them (ADR-0014 part 10), by the `Kind` that files into each. */
export const SECTIONS = [
    { kind: 'seam', heading: 'Seam changes' },
    { kind: 'migration', heading: 'Framework migrations' },
    { kind: 'operator', heading: 'Operator actions' },
    { kind: 'scaffold', heading: 'Scaffold changes to apply by hand' },
    { kind: 'none', heading: 'Other changes' },
]
const KINDS = SECTIONS.map((s) => s.kind)
/** `required` breaks an adopter who does nothing (ADR-0014 part 10's "breaking"); `optional` is new and additive. */
const ACTIONS = ['required', 'optional', 'none']
const BUMPS = ['patch', 'minor']
const PACKAGE = /^@sssb\/[a-z0-9-]+$/

/** The heading of the standing upgrade section: every release's notes carry it, so `withUpgradeSection` finds it by it. */
export const UPGRADE_HEADING = 'Upgrading to this release'
/** The repository whose tag names a release's commit, when `upgradeSection` is not told another. */
const RELEASE_REPOSITORY = 'safeinsights/sssb'
const RC_VERSION = /-rc\.\d+$/
const COMMIT = /^[0-9a-f]{40}$/

/**
 * The standing "Upgrading to this release" section (`docs/adopting-reference.md`, "Upgrading, step by step", says why each step is
 * there): what every release asks of a workspace, whatever its entries say, with the commands and this release's version
 * filled in. The release commit's SHA is filled in only when the caller has it. The notes are a file IN the release
 * commit, so `prepare` cannot know it, and the pins do not need it: `sssb pin` reads it from the installed kit's release
 * stamp (`dist/release.json`) and writes both. `release.mjs candidate-notes`, which runs on the tag with the SHA in hand,
 * names it in the step. The pin is a SHA, never the tag: `sssb doctor` reports a pin that is "a branch or tag, not a
 * commit" as differing from the release commit, and `sssb pin` writes the SHA.
 * @param {{ version: string, sha?: string, repo?: string }} options
 * @returns {string} markdown, no trailing newline, starting at its `##` heading
 */
export function upgradeSection({ version, sha, repo = RELEASE_REPOSITORY }) {
    if (sha !== undefined && !COMMIT.test(sha)) throw new Error(`not a commit: '${sha}'`)
    const candidate = RC_VERSION.test(version)
    const tag = `v${version}`
    const move = candidate
        ? [
              `**1. Move every \`@sssb/*\` package to this candidate, together.** A candidate is a GitHub prerelease and nothing`,
              `is on npm: in the root \`package.json\`, each \`apps/<app>/package.json\` and \`apps/<app>/infra/package.json\`, and any`,
              `package of your own that depends on one, point each \`@sssb/*\` dependency at its tarball URL (the prerelease's notes`,
              `list them, under "Installing this release candidate") and install. First make any "Scaffold changes to apply by hand" entry below that touches how packages`,
              `install, or the install keeps the old release. Commit the lockfile.`,
              '',
              '```sh',
              'pnpm install',
              '```',
          ]
        : [
              `**1. Move every \`@sssb/*\` package to ${version}, together.** In the root \`package.json\`, each`,
              `\`apps/<app>/package.json\` and \`apps/<app>/infra/package.json\`, and any package of your own that depends on one,`,
              `change each \`@sssb/*\` version, then install and commit the lockfile. First make any "Scaffold changes to apply by`,
              `hand" entry below that touches how packages install, or the install keeps the old release.`,
              '',
              '```json',
              JSON.stringify(
                  {
                      '@sssb/kit': `^${version}`,
                      '@sssb/tools': `^${version}`,
                      '@sssb/eslint-plugin': `^${version}`,
                      '@sssb/cdk': `^${version}`,
                  },
                  null,
                  4,
              ),
              '```',
              '',
              '```sh',
              'pnpm install',
              '```',
          ]
    const commit = sha === undefined ? '' : ` (\`${sha}\`)`
    // `sssb doctor` names the commit only beside a pin that differs, and not at all for a kit with no stamp, which is
    // one of the two things that make `sssb pin` refuse: the tag names it too.
    const where =
        sha === undefined
            ? `The commit is the one \`sssb doctor\` names beside a pin that differs or, for a kit with no stamp, the one this prints: \`git ls-remote https://github.com/${repo} 'refs/tags/${tag}' 'refs/tags/${tag}^{}' | tail -n 1 | cut -f 1\`.`
            : `The commit is \`${sha}\`.`
    return [
        `## ${UPGRADE_HEADING}`,
        '',
        'Every release asks these of a workspace, whatever its entries say. Make them on a branch, in order, then read the',
        'entries below.',
        '',
        ...move,
        '',
        "**2. Refresh the app guide's copy,** the rules every agent in your repository follows. `sssb doctor` fails until the",
        "copy is the installed kit's; read the diff of `.claude/sssb-guide.md`.",
        '',
        '```sh',
        'pnpm exec sssb guide',
        '```',
        '',
        `**3. Raise both pins to this release's commit${commit}.** The reusable workflow's \`uses:\` in`,
        "`.github/workflows/checks.yml` and the plugin marketplace's `ref` in `.claude/settings.json` are two pins on one commit",
        "of SSSB's repository, and the installed `@sssb/kit` records it. This reads it there and writes both, printing each pin it",
        'changed, and does nothing to one that is already current. It refuses, changing nothing, when the kit carries no release',
        'stamp or a file is not the shape it edits:',
        '',
        '```sh',
        'pnpm exec sssb pin',
        '```',
        '',
        `If it refuses, make the two edits by hand: the \`uses: ${repo}/.github/workflows/app-checks.yml@<commit>\` line and the`,
        `marketplace's \`ref\`. ${where} A pin takes the commit's SHA, never the tag \`${tag}\`, which can be moved.`,
        '',
        'Then each person updates their installed plugin and restarts Claude Code:',
        '',
        '```sh',
        'claude plugin marketplace update sssb',
        'claude plugin update sssb@sssb --scope project',
        '```',
        '',
        '**4. Apply each entry below, then drop what it left unused.** Do each "To adopt" and delete what each "Now deletable"',
        'describes, then run `pnpm knip`. A vendor SDK your app listed only for code you deleted (`@aws-sdk/client-s3` for a',
        "copy of the kit's S3 storage adapter, say) is now flagged as unused, because the kit's adapter that replaces it",
        'carries its own copy: remove it from the `package.json` that lists it, unless other code still imports it.',
        '',
        '```sh',
        'pnpm knip',
        '```',
        '',
        '**5. Check, then push.** Read every line `sssb doctor` reports, not just the last: it fails on versions out of step and',
        'a stale guide copy, and only reports a pin that is not the release commit.',
        '',
        '```sh',
        'pnpm exec sssb doctor',
        'pnpm verify',
        '```',
    ].join('\n')
}

/**
 * Markdown notes with their upgrade section replaced by `section` (or, when they have none, with it inserted before the
 * first `##` heading outside a code block, or appended). A section runs from its heading to the next `##` heading
 * outside a code block.
 * @param {string} markdown
 * @param {string} section from `upgradeSection`
 */
export function withUpgradeSection(markdown, section) {
    const lines = markdown.replace(/\n+$/, '').split('\n')
    const { inside } = fenceMask(lines)
    const headings = lines.flatMap((l, i) => (!inside[i] && /^## /.test(l) ? [i] : []))
    const start = headings.find((i) => lines[i] === `## ${UPGRADE_HEADING}`)
    const block = section.split('\n')
    if (start !== undefined) {
        const end = headings.find((i) => i > start) ?? lines.length
        lines.splice(start, end - start, ...block, ...(end < lines.length ? [''] : []))
    } else {
        const at = headings[0] ?? lines.length
        // appended after prose that has no `##`: a blank line first, so it stays a heading of its own
        lines.splice(
            at,
            0,
            ...(at === lines.length && lines.length > 0 ? [''] : []),
            ...block,
            ...(at < lines.length ? [''] : []),
        )
    }
    return lines.join('\n') + '\n'
}

/** Whether Changesets (@changesets/read 1.0.1) reads this `.changeset/` file as a changeset. */
export function isChangesetName(name) {
    return (
        name.endsWith('.md') &&
        !name.startsWith('.') &&
        !/^readme\.md$/i.test(name) &&
        !['AGENTS.md', 'CLAUDE.md', 'GEMINI.md'].includes(name)
    )
}

/**
 * The frontmatter's `'name': bump` lines and the body, read without a YAML parser (this module has no dependency): one
 * package per line, the name quoted (YAML reserves a leading `@`), a trailing `# comment` allowed, and anything else
 * a problem rather than a guess. A leading BOM or whitespace is skipped and the closing `---` is on its own line (its
 * trailing spaces are allowed; Changesets also allows leading ones, which are refused here). release.mjs reads the same
 * frontmatter with `changesetReleases`, which must accept everything this accepts: a test holds them together.
 * @param {string} text
 * @returns {{ packages: { name: string, bump: string }[], body: string, problems: string[] } | null} null when there is
 *   no frontmatter at all
 */
function split(text) {
    const match = /^\uFEFF?\s*---\r?\n(?:([\s\S]*?)\r?\n)?---[ \t]*(?:\r?\n|$)([\s\S]*)$/.exec(text)
    if (!match) return null
    const problems = []
    /** @type {{ name: string, bump: string }[]} */
    const packages = []
    for (const line of (match[1] ?? '').split(/\r?\n/)) {
        const bare = line.replace(/\s+#.*$/, '').trim()
        if (!bare || bare.startsWith('#')) continue
        const m = /^(["'])([^"']+)\1\s*:\s*(["']?)(\w+)\3$/.exec(bare)
        if (!m) {
            problems.push(
                `cannot read the frontmatter line \`${line.trim()}\`: one quoted \`'@sssb/<package>': minor\` per line`,
            )
        } else if (packages.some((p) => p.name === m[2])) problems.push(`${m[2]} is named twice`)
        else packages.push({ name: m[2], bump: m[4] })
    }
    return { packages, body: match[2], problems }
}

/**
 * Which lines of a body are inside a fenced code block (the fence lines included), and whether one is left open. A
 * fence closes only on a bare fence line (nothing after it) of the same character at least as long.
 * @param {string[]} lines
 */
function fenceMask(lines) {
    /** @type {boolean[]} */
    const inside = []
    /** @type {string | null} */
    let fence = null
    for (const line of lines) {
        const open = /^\s*(`{3,}|~{3,})/.exec(line)
        if (fence === null) {
            inside.push(Boolean(open))
            if (open) fence = open[1]
        } else {
            inside.push(true)
            if (open && open[1][0] === fence[0] && open[1].length >= fence.length && /^\s*[`~]+\s*$/.test(line)) {
                fence = null
            }
        }
    }
    return { inside, open: fence !== null }
}

/** The body with fenced code blocks blanked, so a heading or a field inside a snippet is not read as structure. */
function withoutFences(body) {
    const lines = body.split(/\r?\n/)
    const { inside } = fenceMask(lines)
    return lines.map((l, i) => (inside[i] ? '' : l)).join('\n')
}

/**
 * Every problem with one changeset's text, in reading order; empty when it is well formed. An empty changeset (no
 * packages, no body) says "no adopter-visible effect" and is well formed.
 * @param {string} text
 * @param {{ judgePackages?: boolean }} [options] `judgePackages: false` leaves the package names and bumps to the
 *   caller, which judges them with more context (`release.mjs check` and `prepare` do, against the fixed group and the
 *   version)
 * @returns {string[]}
 */
export function lintChangeset(text, { judgePackages = true } = {}) {
    const parts = split(text)
    if (!parts) return ['no frontmatter: the file must start with a `---` block naming the packages and their bump']
    const problems = [...parts.problems]
    const { packages } = parts
    if (parts.problems.length > 0) return problems

    if (packages.length === 0) {
        if (parts.body.trim() !== '') {
            problems.push('an empty changeset (no packages) has no body: name a package or drop the text')
        }
        return problems
    }
    for (const { name, bump } of judgePackages ? packages : []) {
        if (!PACKAGE.test(name)) problems.push(`\`${name}\` is not an @sssb/* package`)
        if (!BUMPS.includes(bump)) {
            problems.push(
                `${name}: bump \`${bump}\` must be patch or minor (on 0.x a breaking change is a minor, never a major)`,
            )
        }
    }

    const lines = parts.body.split(/\r?\n/)
    if (fenceMask(lines).open) problems.push('a code fence is never closed: it would swallow the rest of the notes')
    const body = withoutFences(parts.body)
    // The title is the body's first line, a fence included: the notes cut the entry from there.
    const first = lines.find((line) => line.trim() !== '')
    if (!first || !/^### \S/.test(first)) problems.push('the body starts with a `### title` line')
    if (/^#{1,2} /m.test(body)) {
        problems.push('the body has no `#` or `##` heading outside a code block: the title is `###`')
    }
    if (body.split('\n').filter((l) => /^### /.test(l)).length > 1) {
        problems.push(
            'the body has one `###` heading, its title; a sub-heading would read as another change (use `####`)',
        )
    }

    const field = (/** @type {string} */ label) => new RegExp(`^\\*\\*${label}\\.\\*\\*`, 'm').exec(body)
    const value = (/** @type {string} */ label, /** @type {string[]} */ allowed) => {
        const found = [...body.matchAll(new RegExp(`^\\*\\*${label}\\.\\*\\*(.*)$`, 'gm'))]
        if (found.length === 0) {
            problems.push(`missing \`**${label}.**\`, one of ${allowed.join(', ')}`)
            return undefined
        }
        if (found.length > 1) problems.push(`\`**${label}.**\` appears ${found.length} times: one value per entry`)
        const v = found[0][1].trim()
        if (!allowed.includes(v)) {
            problems.push(`\`**${label}.** ${v}\` must be one of ${allowed.join(', ')}`)
            return undefined
        }
        return v
    }
    const kind = value('Kind', KINDS)
    const action = value('Action', ACTIONS)
    if (!field('What changed')) problems.push('missing `**What changed.**`')

    if (kind === 'none' && action !== undefined && action !== 'none') {
        problems.push('kind none has no section to act on: its action is none')
    }
    if (action !== undefined && action !== 'none' && !field('To adopt')) {
        problems.push(`action ${action} needs \`**To adopt.**\`: say what the adopter does`)
    }
    if (action === 'required') {
        for (const { name, bump } of packages) {
            if (bump !== 'minor') {
                problems.push(
                    `${name}: action required breaks an adopter who does nothing, so it is a minor (a patch must be compatible)`,
                )
            }
        }
    }
    return problems
}

/**
 * One well-formed changeset, ready to file into a section. Call only on text `lintChangeset` accepted: the title is its
 * first line, so everything after is the entry, less the Kind and Action lines (the entry's header says them).
 * Blank-line runs are collapsed outside code, never inside it, so a snippet is copied as it was written.
 * @param {string} file
 * @param {string} text
 */
function entryOf(file, text) {
    const parts = /** @type {NonNullable<ReturnType<typeof split>>} */ (split(text))
    if (parts.packages.length === 0) return null
    const lines = parts.body.split(/\r?\n/)
    const { inside } = fenceMask(lines)
    const titleAt = lines.findIndex((l) => l.trim() !== '')
    const title = lines[titleAt].replace(/^### /, '').trim()
    const kept = []
    for (let i = titleAt + 1; i < lines.length; i++) {
        if (!inside[i] && /^\*\*(Kind|Action)\.\*\*/.test(lines[i])) continue
        // A blank line outside code is dropped when it would start the entry or repeat one. A blank inside code is kept:
        // what follows a blank outside code is never code's own blank line (the closing fence is not blank).
        if (!inside[i] && lines[i].trim() === '' && (kept.length === 0 || kept[kept.length - 1].trim() === '')) continue
        kept.push(lines[i])
    }
    while (kept.length > 0 && kept[kept.length - 1].trim() === '') kept.pop()
    const fenced = withoutFences(parts.body)
    const kind = /^\*\*Kind\.\*\*[ \t]*(\S+)/m.exec(fenced)?.[1] ?? 'none'
    const action = /^\*\*Action\.\*\*[ \t]*(\S+)/m.exec(fenced)?.[1] ?? 'none'
    return { file, title, kind, action, packages: parts.packages, text: kept.join('\n') }
}

/** @param {{ file: string, text: string }[]} changesets @param {boolean} [judgePackages] */
function lintAll(changesets, judgePackages) {
    const problems = []
    for (const { file, text } of changesets) {
        for (const p of lintChangeset(text, { judgePackages })) problems.push(`${file}: ${p}`)
    }
    return problems
}

/** @param {{ file: string }} a @param {{ file: string }} b */
const byFile = (a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0)

/** @param {NonNullable<ReturnType<typeof entryOf>>} e */
function render(e) {
    const names = e.packages.map((p) => `\`${p.name}\``).join(', ')
    return [`### ${e.title}`, '', `Action: ${e.action} · ${names}`, '', e.text]
}

/**
 * The notes for these changesets (`{ file, text }` each), as markdown. Within a section the entries an adopter must act
 * on come first (action required, then optional, then none), then by file name. No dates, so the same changesets always
 * give the same bytes. Throws, naming each file and its problems, if any changeset is malformed.
 * @param {{ file: string, text: string }[]} changesets
 * @param {{ version?: string, since?: string, corrections?: { file: string, text: string }[], judgePackages?: boolean }} [options]
 *   `since` says which earlier release these notes are relative to; `corrections` are changesets edited since it, which
 *   are listed again under their own heading
 */
export function assembleNotes(changesets, { version, since, corrections = [], judgePackages } = {}) {
    const problems = lintAll([...changesets, ...corrections], judgePackages)
    if (problems.length > 0) throw new ChangesetProblems(problems)

    const entries = []
    let empty = 0
    for (const { file, text } of [...changesets].sort(byFile)) {
        const entry = entryOf(file, text)
        if (entry) entries.push(entry)
        else empty++
    }
    const corrected = [...corrections].sort(byFile).flatMap(({ file, text }) => entryOf(file, text) ?? [])
    const rank = (/** @type {string} */ action) => ACTIONS.indexOf(action)
    const required = entries.filter((e) => e.action === 'required').length
    const out = [`# Release notes${version ? `: v${version}` : ''}`]
    if (since) out.push('', `Changes since ${since}.`)
    const emptyNote =
        empty > 0
            ? `${empty} ${empty === 1 ? 'change has' : 'changes have'} no adopter-visible effect and ${empty === 1 ? 'is' : 'are'} not listed.`
            : ''
    out.push(
        '',
        entries.length === 0
            ? ['No change in this release asks anything of an adopter.', emptyNote].filter(Boolean).join(' ')
            : [
                  `${entries.length} ${entries.length === 1 ? 'change' : 'changes'}, ${required} requiring action.`,
                  emptyNote,
              ]
                  .filter(Boolean)
                  .join(' '),
    )
    if (version) out.push('', upgradeSection({ version }))
    for (const { kind, heading } of SECTIONS) {
        const inSection = entries.filter((e) => e.kind === kind).sort((a, b) => rank(a.action) - rank(b.action))
        // The four named sections are always present, empty or not (ADR-0014 part 10); "Other changes" only when used.
        if (inSection.length === 0 && kind === 'none') continue
        out.push('', `## ${heading}`)
        if (inSection.length === 0) out.push('', 'None.')
        for (const e of inSection) out.push('', ...render(e))
    }
    if (corrected.length > 0) {
        out.push(
            '',
            '## Corrections to earlier notes',
            '',
            `These entries were edited after ${since ?? 'the earlier notes'}. If you acted on the earlier text, read them again.`,
        )
        for (const e of corrected) out.push('', ...render(e))
    }
    return { markdown: out.join('\n').trimEnd() + '\n', entries: entries.length, empty }
}

/** Thrown when changesets have the wrong shape; `problems` is one line per problem, each naming its file. */
export class ChangesetProblems extends Error {
    /** @param {string[]} problems */
    constructor(problems) {
        super(problems.join('\n'))
        this.name = 'ChangesetProblems'
        this.problems = problems
    }
}

/** @param {string} root @param {string[]} args */
function git(root, args) {
    try {
        return execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
    } catch (error) {
        const stderr = /** @type {{ stderr?: string }} */ (error).stderr?.trim()
        throw new Error(
            `git ${args[0]} failed: ${stderr || (error instanceof Error ? error.message : String(error))}`,
            {
                cause: error,
            },
        )
    }
}

/**
 * Whether a `.changeset/pre.json` (its text, or null when there is none) puts Changesets in pre mode, where a changeset
 * in `.changeset/pre/` is consumed. Out of it (ADR-0014 P14 deleted the file) Changesets releases those too, so they
 * are pending, and in the notes. `release.mjs` judges the file's exact shape; this reads only its mode.
 * @param {string | null} text
 */
function preModeOf(text) {
    if (text === null) return false
    try {
        return JSON.parse(text)?.mode === 'pre'
    } catch {
        throw new Error('.changeset/pre.json is not JSON')
    }
}

/**
 * The changesets Changesets would consume, as paths relative to `.changeset/` (`name.md`, or `pre/name.md` once pre
 * mode is left), from a listing of `.changeset/` and, out of pre mode, of `.changeset/pre/`.
 * @param {string[]} top the names directly in `.changeset/`
 * @param {() => string[]} consumed the names in `.changeset/pre/`, read only when they count
 * @param {boolean} pre
 */
function pendingNames(top, consumed, pre) {
    const names = top.filter(isChangesetName)
    if (!pre)
        names.push(
            ...consumed()
                .filter(isChangesetName)
                .map((name) => `pre/${name}`),
        )
    return names
}

/**
 * Pending changesets under `.changeset/` as of a revision (relative to `.changeset/`), optionally only those a diff
 * from `since` adds (`A`) or edits (`M`) and that are still there.
 * @param {string} root
 * @param {{ since?: string, at: string, filter?: 'A' | 'M' }} where
 */
function namesAt(root, { since, at, filter }) {
    const list = (/** @type {string} */ dir) =>
        git(root, ['ls-tree', '-z', '--name-only', at, `${dir}/`])
            .split('\0')
            .filter(Boolean)
            .map((f) => path.posix.basename(f))
    const top = list('.changeset')
    const pre = top.includes('pre.json') && preModeOf(git(root, ['show', `${at}:.changeset/pre.json`]))
    const names = pendingNames(top, () => list('.changeset/pre'), pre)
    if (since === undefined || filter === undefined) return names
    const changed = new Set(
        git(root, [
            'diff',
            '--name-only',
            '--no-renames',
            `--diff-filter=${filter}`,
            '-z',
            since,
            at,
            '--',
            '.changeset/',
        ])
            .split('\0')
            .filter(Boolean)
            .map((f) => path.posix.relative('.changeset', f)),
    )
    return names.filter((n) => changed.has(n))
}

/**
 * The changesets to read, as `{ file, text }`: the working tree's, or `at`'s, or those added after `since` that are
 * still there (`edited: true`: those edited since instead).
 * @param {string} root
 * @param {{ since?: string, at?: string, edited?: boolean }} [options]
 */
export function readChangesets(root, { since, at, edited = false } = {}) {
    for (const ref of [since, at]) {
        // a value starting with `-` would be read by git as an option
        if (ref !== undefined && ref.startsWith('-')) throw new Error(`not a revision: ${ref}`)
    }
    if (at === undefined && since === undefined) {
        const dir = path.join(root, '.changeset')
        const preJson = path.join(dir, 'pre.json')
        const names = existsSync(dir)
            ? pendingNames(
                  readdirSync(dir),
                  () => (existsSync(path.join(dir, 'pre')) ? readdirSync(path.join(dir, 'pre')) : []),
                  preModeOf(existsSync(preJson) ? readFileSync(preJson, 'utf8') : null),
              )
            : []
        return names
            .sort()
            .map((name) => ({ file: `.changeset/${name}`, text: readFileSync(path.join(dir, name), 'utf8') }))
    }
    const rev = at ?? 'HEAD'
    return namesAt(root, { since, at: rev, filter: edited ? 'M' : 'A' })
        .sort()
        .map((name) => ({ file: `.changeset/${name}`, text: git(root, ['show', `${rev}:.changeset/${name}`]) }))
}

/**
 * Every problem with the changesets under `root` (the working tree's, or `at`'s), one line each naming its file.
 * @param {string} root
 * @param {{ since?: string, at?: string, judgePackages?: boolean }} [options]
 */
export function lintChangesets(root, options) {
    const { judgePackages, ...where } = options ?? {}
    const found = readChangesets(root, where)
    if (where.since !== undefined) found.push(...readChangesets(root, { ...where, edited: true }))
    return lintAll(found, judgePackages)
}

/**
 * The release notes for the changesets under `root`. Throws `ChangesetProblems` if any is malformed.
 * @param {string} root
 * @param {{ since?: string, at?: string, version?: string, judgePackages?: boolean }} [options]
 */
export function releaseNotes(root, { since, at, version, judgePackages } = {}) {
    return assembleNotes(readChangesets(root, { since, at }), {
        version,
        since,
        judgePackages,
        corrections: since === undefined ? [] : readChangesets(root, { since, at, edited: true }),
    })
}

/** @param {string[]} argv */
function parseArgs(argv) {
    /** @type {Record<string, string | boolean>} */
    const opts = {}
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i]
        if (arg === '--check') opts.check = true
        else if (['--version', '--since', '--at', '--out'].includes(arg)) {
            const value = argv[++i]
            if (value === undefined || value.startsWith('-')) throw new Error(`${arg} needs a value`)
            opts[arg.slice(2)] = value
        } else throw new Error(`unknown argument ${arg}`)
    }
    return opts
}

/** @param {string[]} argv */
export function main(argv, root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')) {
    try {
        const opts = parseArgs(argv)
        const options = {
            since: /** @type {string | undefined} */ (opts.since),
            at: /** @type {string | undefined} */ (opts.at),
            version: /** @type {string | undefined} */ (opts.version),
        }
        if (opts.check) {
            const problems = lintChangesets(root, options)
            if (problems.length > 0) throw new ChangesetProblems(problems)
            return 0
        }
        const { markdown } = releaseNotes(root, options)
        if (typeof opts.out === 'string') writeFileSync(opts.out, markdown)
        else process.stdout.write(markdown)
        return 0
    } catch (error) {
        console.error(error instanceof Error ? error.message : String(error))
        return 1
    }
}

/** Whether Node ran this file, by real path: run through a symlink (macOS's /var), a plain comparison would skip `main`. */
function isMain() {
    try {
        return realpathSync(process.argv[1] ?? '') === realpathSync(fileURLToPath(import.meta.url))
    } catch {
        return false
    }
}
if (isMain()) process.exitCode = main(process.argv.slice(2))
