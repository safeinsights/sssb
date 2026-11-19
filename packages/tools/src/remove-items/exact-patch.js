// @ts-check
// A unified diff applied EXACTLY, for `sssb remove-items`: a hunk applies only where every line it names (context and
// removed alike) is found, once, in the file as it is. There is no fuzz and no guessing: a file the adopter has
// edited inside a hunk is refused, never patched around, and a file that is not found, or is found twice, is
// refused too. A hunk may move (the adopter added lines above it); it may not change.
//
// Why this and not `git apply`: it must work where there is no repository (a tarball, a scratch copy), name what it
// would refuse before it touches a file.
//
// The patches are `git diff --no-renames -U3 --relative=<app>` between the starter and the starter with the Items
// slice taken out; `tests/tooling/remove-items.test.ts` proves they apply to the starter, and to a workspace
// generated from it, and leave no Items behind.

/** One line of a hunk: ' ' (context, kept), '-' (removed) or '+' (added). @typedef {{ op: ' ' | '-' | '+', text: string }} HunkLine */
/** @typedef {{ lines: HunkLine[] }} Hunk */
/** @typedef {{ path: string, status: 'modify' | 'delete' | 'add', hunks: Hunk[] }} FilePatch */

/**
 * @param {string} text a unified diff, as `git diff --no-renames` writes it
 * @returns {FilePatch[]}
 */
export function parsePatch(text) {
    /** @type {FilePatch[]} */
    const files = []
    /** @type {FilePatch | null} */
    let file = null
    /** @type {Hunk | null} */
    let hunk = null
    for (const line of text.split('\n')) {
        if (line.startsWith('diff --git ')) {
            file = { path: '', status: 'modify', hunks: [] }
            files.push(file)
            hunk = null
        } else if (file === null) {
            continue
        } else if (hunk === null && line.startsWith('new file mode')) {
            file.status = 'add'
        } else if (hunk === null && line.startsWith('deleted file mode')) {
            file.status = 'delete'
        } else if (hunk === null && line.startsWith('--- ')) {
            if (line !== '--- /dev/null') file.path = unprefix(line.slice(4), 'a/')
        } else if (hunk === null && line.startsWith('+++ ')) {
            if (line !== '+++ /dev/null' && file.path === '') file.path = unprefix(line.slice(4), 'b/')
        } else if (line.startsWith('@@ ')) {
            hunk = { lines: [] }
            file.hunks.push(hunk)
        } else if (hunk !== null && (line[0] === ' ' || line[0] === '-' || line[0] === '+')) {
            hunk.lines.push({ op: /** @type {' ' | '-' | '+'} */ (line[0]), text: line.slice(1) })
        }
    }
    for (const parsed of files) {
        if (parsed.path === '' || parsed.hunks.length === 0)
            throw new Error(`a malformed patch: ${parsed.path || '(no path)'}`)
    }
    return files
}

/**
 * @param {string} value
 * @param {string} prefix
 */
function unprefix(value, prefix) {
    if (!value.startsWith(prefix)) throw new Error(`a malformed patch path: ${value}`)
    return value.slice(prefix.length)
}

/**
 * Applies one file's hunks to its text. Returns the new text, or null when the patch removes the file.
 * @param {string | null} original the file's text, null when it does not exist
 * @param {FilePatch} patch
 * @returns {{ ok: true, content: string | null } | { ok: false, reason: string }}
 */
export function applyFilePatch(original, patch) {
    if (patch.status === 'add') {
        if (original !== null) return { ok: false, reason: 'it already exists (the patch would add it)' }
        const added = patch.hunks.flatMap((h) => h.lines.filter((l) => l.op === '+').map((l) => l.text))
        return { ok: true, content: `${added.join('\n')}\n` }
    }
    if (original === null) return { ok: false, reason: 'it is not there' }
    const endsWithNewline = original.endsWith('\n')
    let lines = original.split('\n')
    if (endsWithNewline) lines.pop()
    for (const hunk of patch.hunks) {
        const from = hunk.lines.filter((l) => l.op !== '+').map((l) => l.text)
        const to = hunk.lines.filter((l) => l.op !== '-').map((l) => l.text)
        const at = matches(lines, from)
        if (at.length !== 1) {
            if (patch.status === 'delete' && at.length === 0)
                return { ok: false, reason: 'it is not the file the starter wrote (the slice deletes it whole)' }
            const first =
                hunk.lines.find((l) => l.op === '-' && l.text.trim() !== '')?.text.trim() ?? from.join(' ').trim()
            return {
                ok: false,
                reason:
                    at.length === 0
                        ? `it differs from the starter's where the patch edits it, near: ${first.slice(0, 80)}`
                        : `the place the patch edits is ambiguous (${at.length} matches), near: ${first.slice(0, 80)}`,
            }
        }
        lines = [...lines.slice(0, at[0]), ...to, ...lines.slice(at[0] + from.length)]
    }
    if (patch.status === 'delete')
        return lines.length === 0
            ? { ok: true, content: null }
            : { ok: false, reason: 'it holds more than the starter wrote' }
    return { ok: true, content: lines.join('\n') + (endsWithNewline ? '\n' : '') }
}

/**
 * Where `from` (a hunk's context and removed lines) is found in `lines`.
 * @param {string[]} lines
 * @param {string[]} from
 * @returns {number[]}
 */
function matches(lines, from) {
    /** @type {number[]} */
    const found = []
    for (let i = 0; i + from.length <= lines.length; i++) {
        if (from.every((text, k) => lines[i + k] === text)) found.push(i)
    }
    return found
}
