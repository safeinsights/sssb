import { readdirSync, statSync } from 'node:fs'
import path from 'node:path'

/**
 * What a `.changeset/` directory may hold, as Changesets and this repository's release flow leave it. In pre mode
 * (release candidates, `.changeset/pre.json`) `changeset version` MOVES each changeset it consumes to
 * `.changeset/pre/<name>.md`, byte for byte, where it is no longer pending (scripts/release.mjs refuses an edit). A
 * check that walks the directory must therefore not read `pre` as a stray subdirectory, and must not hold its files to
 * the rules for pending changesets: they were linted when they were pending, and a rule tightened since must not turn
 * the record of a shipped candidate red.
 *
 * Changesets' own rule for what is not a changeset: README in any case, the agent files by exact case, and dotfiles.
 *
 * @returns `pending`: the changesets still to be released (`x.md`); `consumed`: the ones moved to `pre/` (`pre/x.md`);
 *   `problems`: anything else that does not belong there (another directory, or a file in `pre/` that is not a changeset).
 */
export function changesetDir(dir: string) {
    const pending: string[] = []
    const consumed: string[] = []
    const problems: string[] = []
    const isChangeset = (name: string) =>
        /^[^.].*\.md$/.test(name) &&
        !/^readme\.md$/i.test(name) &&
        !['AGENTS.md', 'CLAUDE.md', 'GEMINI.md'].includes(name)
    for (const entry of readdirSync(dir)) {
        const full = path.join(dir, entry)
        if (!statSync(full).isDirectory()) {
            if (isChangeset(entry)) pending.push(entry)
            continue
        }
        if (entry !== 'pre') {
            problems.push(
                `.changeset/${entry}/ is a directory: Changesets reads only .changeset/pre/, and only in pre mode`,
            )
            continue
        }
        for (const moved of readdirSync(full)) {
            if (statSync(path.join(full, moved)).isFile() && isChangeset(moved)) consumed.push(`pre/${moved}`)
            else
                problems.push(
                    `.changeset/pre/${moved} is not a consumed changeset (a .md file moved by \`changeset version\`)`,
                )
        }
    }
    return { pending: pending.sort(), consumed: consumed.sort(), problems }
}
