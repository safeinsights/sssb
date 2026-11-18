import { parse } from 'yaml'

/**
 * The shape a changeset in `.changeset/` must have, which `.changeset/README.md` states for writers. A changeset is
 * both Changesets' input and an adopter-facing release note (ADR-0014 P7 assembles the notes from them), so the body
 * has a fixed form. Changesets itself checks only the frontmatter, and `scripts/release.mjs check` only the packages
 * and the bump; neither reads the body.
 *
 *   ---
 *   '@sssb/kit': minor
 *   ---
 *
 *   ### Short title
 *
 *   **Kind.** seam
 *
 *   **What changed.** One or two sentences.
 *
 *   **To adopt.** The steps, with the import path and the call shape.
 *
 *   **Now deletable.** The PATTERN of local code this supersedes.
 *
 * An empty changeset (two lines, `---` and `---`) says "no adopter-visible effect" and has no body.
 */

/** P7's four release-note sections, in the order the notes list them, then `none` for a fix adopters need not act on. */
const KINDS = ['seam', 'migration', 'operator', 'scaffold', 'none'] as const
type ChangesetKind = (typeof KINDS)[number]

const BUMPS = ['patch', 'minor']
const PACKAGE = /^@sssb\/[a-z0-9-]+$/

/** Every problem with one changeset's text, in reading order; empty when it is well formed. */
export function lintChangeset(text: string): string[] {
    const problems: string[] = []
    const match = /^---\r?\n([\s\S]*?)\r?\n?---\r?\n?([\s\S]*)$/.exec(text)
    if (!match) return ['no frontmatter: the file must start with a `---` block naming the packages and their bump']
    const [, front, body] = match

    let frontmatter: unknown
    try {
        frontmatter = parse(front)
    } catch {
        return ['the frontmatter is not valid YAML']
    }
    const packages =
        frontmatter === null || frontmatter === undefined
            ? []
            : typeof frontmatter === 'object' && !Array.isArray(frontmatter)
              ? Object.entries(frontmatter as Record<string, unknown>)
              : null
    if (packages === null) return ['the frontmatter must map package names to bumps']

    if (packages.length === 0) {
        if (body.trim() !== '')
            problems.push('an empty changeset (no packages) has no body: name a package or drop the text')
        return problems
    }
    for (const [name, bump] of packages) {
        if (!PACKAGE.test(name)) problems.push(`\`${name}\` is not an @sssb/* package`)
        if (typeof bump !== 'string' || !BUMPS.includes(bump)) {
            problems.push(
                `${name}: bump \`${String(bump)}\` must be patch or minor (on 0.x a breaking change is a minor, never a major)`,
            )
        }
    }

    const lines = body.split(/\r?\n/)
    const first = lines.find((line) => line.trim() !== '')
    if (!first || !/^### \S/.test(first)) problems.push('the body starts with a `### title` line')
    if (/^#{1,2} /m.test(body)) problems.push('the body has no `#` or `##` heading: the title is `###`')

    const field = (label: string) => new RegExp(`^\\*\\*${label}\\.\\*\\*`, 'm').exec(body)
    const kindLine = /^\*\*Kind\.\*\*[ \t]*(\S*)[ \t]*$/m.exec(body)
    const kind = kindLine?.[1] as ChangesetKind | undefined
    if (!kindLine) problems.push('missing `**Kind.**`, one of ' + KINDS.join(', '))
    else if (!KINDS.includes(kind as ChangesetKind)) {
        problems.push(`\`**Kind.** ${kindLine[1]}\` must be one of ${KINDS.join(', ')}`)
    }
    if (!field('What changed')) problems.push('missing `**What changed.**`')
    if (kind !== 'none' && KINDS.includes(kind as ChangesetKind) && !field('To adopt')) {
        problems.push(`kind ${kind} needs \`**To adopt.**\`: say what the adopter does`)
    }
    if (kind && kind !== 'none' && KINDS.includes(kind)) {
        for (const [name, bump] of packages) {
            if (bump !== 'minor')
                problems.push(
                    `${name}: kind ${kind} asks adopters to act, so it is a minor (a patch must be compatible)`,
                )
        }
    }
    return problems
}
