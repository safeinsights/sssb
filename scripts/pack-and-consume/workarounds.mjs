// THE WORKAROUND REGISTER for pack and consume (ADR-0014 P2).
//
// The consumer workspaces this job builds are meant to need nothing an adopter would not have. Where one
// does, because SSSB still leans on its own repository somewhere, the gap is a NAMED entry here, tied to the
// step of ADR-0014's plan that removes it, applied at exactly one site in scripts/pack-and-consume.mjs through
// `applyWorkaround(id)`, and printed in the job's summary, so none of them is a silent patch. Grep for an id to
// find where it is applied; delete the entry and its call in the step that names it in `removedBy`.
//
// A run fails if an entry here is never applied, so the register cannot outlive the patch it describes.

/** @typedef {{ removedBy: string, what: string }} Workaround */

/**
 * Empty since P12. Its six (in-repo-tsconfig-stripped, seam-package-written, root-devdeps-picked, allow-builds-copied,
 * eslint-configs-written, dedupe-peer-dependents-written) left when the consumer became @sssb/create's output, which
 * writes each of them. A new gap is a new entry here and an `applyWorkaround(id)` at the one site that patches it.
 * @type {Record<string, Workaround>}
 */
export const WORKAROUNDS = {}

/** @type {Set<string>} */
const used = new Set()

/**
 * Marks a workaround as applied at this site. Throws on an unknown id, so a typo cannot apply an
 * unregistered patch.
 * @param {string} id
 */
export function applyWorkaround(id) {
    if (!Object.hasOwn(WORKAROUNDS, id)) throw new Error(`pack-and-consume: unregistered workaround "${id}"`)
    used.add(id)
}

/** The registered workarounds that no site applied: a stale entry, which fails the run. */
export function unusedWorkarounds() {
    return Object.keys(WORKAROUNDS).filter((id) => !used.has(id))
}
