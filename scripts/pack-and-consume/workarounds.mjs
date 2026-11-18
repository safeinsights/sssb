// THE WORKAROUND REGISTER for pack and consume (ADR-0014 P2).
//
// The consumer workspace this job builds is meant to need nothing an adopter would not have. Today it
// does: SSSB still leans on its own repository in the places below, and each step of ADR-0014's plan
// removes some of them. Every one is a NAMED entry here, applied at exactly one site in
// scripts/pack-and-consume.mjs through `applyWorkaround(id)`, and printed in the job's summary, so none of
// them is a silent patch. Grep for an id to find where it is applied; delete the entry and its call in
// the step that names it in `removedBy`.
//
// A run fails if an entry here is never applied, so the register cannot outlive the patch it describes.

/** @typedef {{ removedBy: string, what: string }} Workaround */

/** @type {Record<string, Workaround>} */
export const WORKAROUNDS = {
    'in-repo-tsconfig-stripped': {
        removedBy: 'P12',
        what: "each app's tsconfig.json is the starter's, which extends @sssb/tools' base, with what reaches into this repo taken out: the `paths` that send @sssb/kit and the seam to source (inside this repo resolution goes through aliases, ADR-0014 part 1) and the include of packages/kit/src that makes the starter the framework's falsifier (P12: @sssb/create writes the template's tsconfig without them)",
    },
    'seam-package-written': {
        removedBy: 'P12',
        what: "each app's src/app-config/package.json (the seam package and its exports) and its `link:` dependency are written by the script (P12: @sssb/create writes both)",
    },
    'root-devdeps-picked': {
        removedBy: 'P12',
        what: "the workspace root's devDependencies (typescript, vitest, esbuild, tsx, the @types and the rest) are picked by hand, at this repo's ranges (P12: @sssb/create writes them)",
    },
    'contract-test-dropped': {
        removedBy: 'P5',
        what: "each app's tests/contract is deleted from the copy: the real-Postgres contract test runs through this repo's tests/support harness (P5: the conformance suite's contract runner)",
    },
    'conformance-by-include': {
        removedBy: 'P5',
        what: "the framework's seam-conformance suites are reached by including their test files under node_modules, with Vitest's default node_modules exclude dropped for that (P5: src/sssb.conformance.test.ts calls @sssb/kit/testing)",
    },
    'allow-builds-copied': {
        removedBy: 'P12',
        what: "the consumer's pnpm-workspace.yaml takes allowBuilds from this repo's, so a build script a kit dependency newly needs is approved here before an adopter would have to (P12: @sssb/create writes allowBuilds)",
    },
    'eslint-configs-written': {
        removedBy: 'P12',
        what: "each app's eslint.config.mjs (the @sssb/eslint-plugin preset), the console's lint-exceptions.mjs and the workspace root's eslint.config.mjs are written by the script, and eslint is added to each app's devDependencies (P12: @sssb/create writes them; the starter in this repo is linted by the repo's root config)",
    },
    'dedupe-peer-dependents-written': {
        removedBy: 'P12',
        what: "the consumer's pnpm-workspace.yaml sets dedupePeerDependents: false, so each importer of @sssb/kit gets an instance with its own seam (ADR-0014 part 5); an adopter's workspace has it only if they set it (P12: @sssb/create writes it; P5's sssb doctor advises when it is missing)",
    },
}

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
