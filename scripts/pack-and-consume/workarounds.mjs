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
    'types-pg': {
        removedBy: 'P3',
        what: "each app declares @types/pg itself: @sssb/kit's source imports pg's types, and the package does not declare them (they are a devDependency of SSSB's workspace root)",
    },
    'demo-presets-seam-skipped': {
        removedBy: 'P3',
        what: 'demo-presets-seam.test.ts is not run from the tarball: it imports ../../../../tests/support/tmp-dir, a path outside the package, so it cannot load from node_modules',
    },
    'strict-flags-kit-baseline': {
        removedBy: 'P3',
        what: "the strict-flag typecheck tolerates errors inside @sssb/kit's own source, up to a counted baseline per flag; the apps' own code must be clean",
    },
    'prune-plugin-copied': {
        removedBy: 'P4',
        what: "scripts/vite-prune-mantine-css.ts is copied into the consumer, because the static demo's Vite config imports it from the repo's scripts/ (P4 moves it into @sssb/tools' Vite preset)",
    },
    'ports-copied': {
        removedBy: 'P4',
        what: "scripts/ports.mjs and scripts/print-port.mjs are copied into the consumer, because the apps' dev scripts and Playwright config import them (P4: `sssb port` and the ports module in @sssb/tools)",
    },
    'check-demo-size-copied': {
        removedBy: 'P4',
        what: "scripts/check-demo-size.mjs is copied into the consumer, because the apps' check:demo-size script runs it (P4: `sssb check-demo-size`)",
    },
    'tmp-dir-helper-copied': {
        removedBy: 'P4',
        what: "tests/support/tmp-dir.ts and its marker module are copied into the consumer, because the starter's cron route test imports them by a repo-relative path (P4: makeTestTmpDir from @sssb/tools)",
    },
    'vitest-setup-copied': {
        removedBy: 'P4',
        what: "the consumer's Vitest setup file (jest-dom's matchers) is written by hand, as tests/vitest.setup.ts is in this repo (P4: the Vitest preset carries it)",
    },
    'next-intl-request-path': {
        removedBy: 'P4',
        what: "each app's next.config.ts points next-intl at ./node_modules/@sssb/kit/src/i18n/request.ts, a path into the package's internal layout (P4: the Next preset resolves the published subpath)",
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
