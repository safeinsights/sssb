import { parse } from 'yaml'

/**
 * The shape a changeset in `.changeset/` must have, which `.changeset/README.md` states for writers. A changeset is
 * both Changesets' input and an adopter-facing release note (ADR-0014 P7's notes are written from them), so the body
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
 *   **Action.** required
 *
 *   **What changed.** One or two sentences.
 *
 *   **To adopt.** The steps, with the import path and the call shape.
 *
 *   **Now deletable.** The PATTERN of local code this supersedes.
 *
 * Kind says which release-note section the entry belongs to; Action says whether the adopter must do something, and
 * only Action sets the bump. An empty changeset (two lines, `---` and `---`) says "no adopter-visible effect" and has
 * no body.
 */

/** P7's four release-note sections, in the order the notes list them, then `none` for a fix with no section. */
const KINDS = ['seam', 'migration', 'operator', 'scaffold', 'none']
/** `required` breaks an adopter who does nothing (ADR-0014 part 10's "breaking"); `optional` is new and additive. */
const ACTIONS = ['required', 'optional', 'none']
const BUMPS = ['patch', 'minor']
const PACKAGE = /^@sssb\/[a-z0-9-]+$/

/** The body with fenced code blocks blanked, so a heading or a field inside a snippet is not read as structure. */
function withoutFences(body: string): string {
    const out: string[] = []
    let fence: string | null = null
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

/** Every problem with one changeset's text, in reading order; empty when it is well formed. */
export function lintChangeset(text: string): string[] {
    const problems: string[] = []
    const match = /^---\r?\n([\s\S]*?)\r?\n?---\r?\n?([\s\S]*)$/.exec(text)
    if (!match) return ['no frontmatter: the file must start with a `---` block naming the packages and their bump']
    const [, front, rawBody] = match

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
        if (rawBody.trim() !== '')
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

    const body = withoutFences(rawBody)
    const first = body.split('\n').find((line) => line.trim() !== '')
    if (!first || !/^### \S/.test(first)) problems.push('the body starts with a `### title` line')
    if (/^#{1,2} /m.test(body)) {
        problems.push('the body has no `#` or `##` heading outside a code block: the title is `###`')
    }

    const field = (label: string) => new RegExp(`^\\*\\*${label}\\.\\*\\*`, 'm').exec(body)
    const value = (label: string, allowed: string[]): string | undefined => {
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
        for (const [name, bump] of packages) {
            if (bump !== 'minor') {
                problems.push(
                    `${name}: action required breaks an adopter who does nothing, so it is a minor (a patch must be compatible)`,
                )
            }
        }
    }
    return problems
}
