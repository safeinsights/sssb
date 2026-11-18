#!/usr/bin/env node
// SSSB's release notes, assembled from the pending changesets (ADR-0014 part 10 and P7; `.changeset/README.md` is the
// writer's side). A changeset is a release-note entry with a fixed body, and this turns the set of them into the notes
// an adopter reads: "Seam changes", "Framework migrations", "Operator actions" and "Scaffold changes to apply by hand"
// (the Kind of each entry), then "Other changes", each entry with its What changed, To adopt and Now deletable.
//
//   node scripts/release-notes.mjs [--version <v>] [--since <ref>] [--at <rev>] [--out <file>] [--check]
//
//   (no flags)    every changeset in the working tree's `.changeset/`, to stdout
//   --since <ref> only the changesets ADDED after <ref> (a tag or a commit) that are still there: a release
//                 candidate's notes are what is new since the previous candidate
//   --at <rev>    read `.changeset/` as of <rev> instead of the working tree. A release deletes the changesets it
//                 consumes, so `--at <release commit>^` regenerates a release's notes after the fact
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
 * The frontmatter's `"name": bump` lines and the body, read without a YAML parser (this module has no dependency): one
 * package per line, and anything else is a problem rather than a guess.
 * @param {string} text
 * @returns {{ packages: { name: string, bump: string }[], body: string, problems: string[] } | null} null when there is
 *   no frontmatter at all
 */
function split(text) {
    const match = /^---\r?\n([\s\S]*?)\r?\n?---\r?\n?([\s\S]*)$/.exec(text)
    if (!match) return null
    const problems = []
    const packages = []
    for (const line of match[1].split(/\r?\n/)) {
        if (!line.trim()) continue
        const m = /^\s*(["']?)([^"'\s:][^"']*?)\1\s*:\s*(\S+)\s*$/.exec(line)
        if (!m)
            problems.push(
                `cannot read the frontmatter line \`${line.trim()}\`: one \`'@sssb/<package>': minor\` per line`,
            )
        else packages.push({ name: m[2], bump: m[3] })
    }
    return { packages, body: match[2], problems }
}

/** The body with fenced code blocks blanked, so a heading or a field inside a snippet is not read as structure. */
function withoutFences(body) {
    /** @type {string[]} */
    const out = []
    /** @type {string | null} */
    let fence = null
    for (const line of body.split(/\r?\n/)) {
        const open = /^ {0,3}(`{3,}|~{3,})/.exec(line)
        if (fence === null) {
            if (open) fence = open[1]
            out.push(open ? '' : line)
        } else {
            if (open && open[1][0] === fence[0] && open[1].length >= fence.length && /^ {0,3}[`~]+\s*$/.test(line)) {
                fence = null
            }
            out.push('')
        }
    }
    return out.join('\n')
}

/**
 * Every problem with one changeset's text, in reading order; empty when it is well formed. An empty changeset (no
 * packages, no body) says "no adopter-visible effect" and is well formed.
 * @param {string} text
 * @param {{ judgePackages?: boolean }} [options] `judgePackages: false` leaves the package names and bumps to the
 *   caller, which judges them with more context (`release.mjs check` does, against the fixed group and the version)
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

    const body = withoutFences(parts.body)
    const first = body.split('\n').find((line) => line.trim() !== '')
    if (!first || !/^### \S/.test(first)) problems.push('the body starts with a `### title` line')
    if (/^#{1,2} /m.test(body)) {
        problems.push('the body has no `#` or `##` heading outside a code block: the title is `###`')
    }

    const field = (/** @type {string} */ label) => new RegExp(`^\\*\\*${label}\\.\\*\\*`, 'm').exec(body)
    const value = (/** @type {string} */ label, /** @type {string[]} */ allowed) => {
        const lines = [...body.matchAll(new RegExp(`^\\*\\*${label}\\.\\*\\*(.*)$`, 'gm'))]
        if (lines.length === 0) {
            problems.push(`missing \`**${label}.**\`, one of ${allowed.join(', ')}`)
            return undefined
        }
        if (lines.length > 1) problems.push(`\`**${label}.**\` appears ${lines.length} times: one value per entry`)
        const v = lines[0][1].trim()
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
 * One well-formed changeset, ready to file into a section. Call only on text `lintChangeset` accepted.
 * @param {string} file
 * @param {string} text
 */
function entryOf(file, text) {
    const parts = /** @type {NonNullable<ReturnType<typeof split>>} */ (split(text))
    if (parts.packages.length === 0) return null
    // Everything after the title, less the Kind and Action lines (the entry's header says them), fences kept as written.
    const lines = parts.body.split(/\r?\n/)
    const title = (lines.find((l) => l.trim() !== '') ?? '').replace(/^### /, '').trim()
    const fences = withoutFences(parts.body).split('\n')
    const kept = []
    let titleSeen = false
    for (let i = 0; i < lines.length; i++) {
        if (!titleSeen) {
            if (lines[i].trim() !== '') titleSeen = true
            continue
        }
        if (fences[i] !== '' && /^\*\*(Kind|Action)\.\*\*/.test(fences[i])) continue
        kept.push(lines[i])
    }
    const text2 = kept
        .join('\n')
        .replace(/\n{3,}/g, '\n\n')
        .trim()
    const kind = /^\*\*Kind\.\*\*[ \t]*(\S+)/m.exec(withoutFences(parts.body))?.[1] ?? 'none'
    const action = /^\*\*Action\.\*\*[ \t]*(\S+)/m.exec(withoutFences(parts.body))?.[1] ?? 'none'
    return { file, title, kind, action, packages: parts.packages, text: text2 }
}

/**
 * The notes for these changesets (`{ file, text }` each), as markdown. Within a section the entries an adopter must act
 * on come first (action required, then optional, then none), then by file name. No dates, so the same changesets always
 * give the same bytes. Throws, naming each file and its problems, if any changeset is malformed.
 * @param {{ file: string, text: string }[]} changesets
 * @param {{ version?: string }} [options]
 */
export function assembleNotes(changesets, { version } = {}) {
    const problems = []
    for (const { file, text } of changesets) for (const p of lintChangeset(text)) problems.push(`${file}: ${p}`)
    if (problems.length > 0) throw new ChangesetProblems(problems)

    const entries = []
    let empty = 0
    for (const { file, text } of [...changesets].sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0))) {
        const entry = entryOf(file, text)
        if (entry) entries.push(entry)
        else empty++
    }
    const rank = (/** @type {string} */ action) => ACTIONS.indexOf(action)
    const out = [`# Release notes${version ? `: v${version}` : ''}`, '']
    out.push(
        entries.length === 0
            ? 'No change in this release asks anything of an adopter.'
            : `${entries.length} ${entries.length === 1 ? 'change' : 'changes'} for adopters.` +
                  (empty > 0
                      ? ` ${empty} more ${empty === 1 ? 'change has' : 'changes have'} no adopter-visible effect and ${empty === 1 ? 'is' : 'are'} not listed.`
                      : ''),
    )
    for (const { kind, heading } of SECTIONS) {
        const inSection = entries.filter((e) => e.kind === kind).sort((a, b) => rank(a.action) - rank(b.action))
        // Seam changes and Framework migrations are always present, empty or not (ADR-0014 part 10).
        if (inSection.length === 0 && kind === 'none') continue
        out.push('', `## ${heading}`, '')
        if (inSection.length === 0) out.push('None.')
        for (const e of inSection) {
            out.push(
                `### ${e.title}`,
                '',
                `Action: ${e.action} · ${e.packages.map((p) => `\`${p.name}\` ${p.bump}`).join(', ')}`,
                '',
                e.text,
                '',
            )
        }
    }
    return {
        markdown:
            out
                .join('\n')
                .replace(/\n{3,}/g, '\n\n')
                .trimEnd() + '\n',
        entries: entries.length,
        empty,
    }
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
    return execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
}

/**
 * The changesets to read, as `{ file, text }`: the working tree's, or `at`'s, or those added after `since` that are
 * still there.
 * @param {string} root
 * @param {{ since?: string, at?: string }} [options]
 */
export function readChangesets(root, { since, at } = {}) {
    /** @type {string[]} */
    let names
    /** @type {(name: string) => string} */
    let read
    if (at === undefined && since === undefined) {
        const dir = path.join(root, '.changeset')
        names = existsSync(dir) ? readdirSync(dir).filter(isChangesetName) : []
        read = (name) => readFileSync(path.join(dir, name), 'utf8')
    } else {
        const rev = at ?? 'HEAD'
        const listed = git(root, ['ls-tree', '-z', '--name-only', rev, '.changeset/']).split('\0').filter(Boolean)
        names = listed.map((f) => path.posix.basename(f)).filter(isChangesetName)
        if (since !== undefined) {
            const added = new Set(
                git(root, [
                    'diff',
                    '--name-only',
                    '--no-renames',
                    '--diff-filter=A',
                    '-z',
                    since,
                    rev,
                    '--',
                    '.changeset/',
                ])
                    .split('\0')
                    .filter(Boolean)
                    .map((f) => path.posix.basename(f)),
            )
            names = names.filter((n) => added.has(n))
        }
        read = (name) => git(root, ['show', `${rev}:.changeset/${name}`])
    }
    return names.sort().map((name) => ({ file: `.changeset/${name}`, text: read(name) }))
}

/**
 * Every problem with the changesets under `root` (the working tree's, or `at`'s), one line each naming its file.
 * @param {string} root
 * @param {{ since?: string, at?: string, judgePackages?: boolean }} [options]
 */
export function lintChangesets(root, options) {
    const { judgePackages, ...where } = options ?? {}
    return readChangesets(root, where).flatMap(({ file, text }) =>
        lintChangeset(text, { judgePackages }).map((p) => `${file}: ${p}`),
    )
}

/**
 * The release notes for the changesets under `root`. Throws `ChangesetProblems` if any is malformed.
 * @param {string} root
 * @param {{ since?: string, at?: string, version?: string }} [options]
 */
export function releaseNotes(root, { since, at, version } = {}) {
    return assembleNotes(readChangesets(root, { since, at }), { version })
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
            if (value === undefined || value.startsWith('--')) throw new Error(`${arg} needs a value`)
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
