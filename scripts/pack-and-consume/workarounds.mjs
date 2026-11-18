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
    'prune-plugin-copied': {
        removedBy: 'P4',
        what: "scripts/vite-prune-mantine-css.ts is copied into the consumer, because the static demo's Vite config imports it from the repo's scripts/ (P4 moves it into @sssb/tools' Vite preset)",
    },
    'ports-copied': {
        removedBy: 'P4',
        what: "scripts/ports.mjs and scripts/print-port.mjs are copied into the consumer, because the apps' dev scripts and Playwright config import them (P4: `sssb port` and the ports module in @sssb/tools)",
    },
    'tick-scripts-copied': {
        removedBy: 'P4',
        what: "scripts/tick.mjs, dev-tick.mjs, ticker.mjs and ticker-marker.mjs are copied into the consumer, because the apps' dev and tick scripts run them and their Playwright config imports ticker-marker (P4: `sssb tick` and the ticker module in @sssb/tools)",
    },
    'check-demo-size-copied': {
        removedBy: 'P4',
        what: "scripts/check-demo-size.mjs is copied into the consumer, because the apps' check:demo-size script runs it (P4: `sssb check-demo-size`)",
    },
    'tmp-dir-helper-copied': {
        removedBy: 'P4',
        what: "the scratch-directory helper and its marker module (packages/kit/src/testing) are copied into the consumer's tests/support, because the starter's cron route test imports them by a repo-relative path (P4: makeTestTmpDir from @sssb/tools)",
    },
    'vitest-config-written': {
        removedBy: 'P4',
        what: "the consumer's root vitest.config.ts (a project per app, each with its own `@` alias) and its setup file (jest-dom's matchers) are written by the script (P4: the Vitest preset carries both)",
    },
    'tsconfig-written': {
        removedBy: 'P4',
        what: "each app's tsconfig.json is written by the script, at the ES2022 floor with only the app's `@/` path: the starter's extends this repo's root tsconfig and includes packages/kit/src. It also sets what @sssb/kit's source needs beyond the strict set and is written nowhere an adopter reads yet: strict, moduleResolution bundler, jsx react-jsx, dom in lib, skipLibCheck (packages/kit/tsconfig.strict.json's header) (P4: the app extends @sssb/tools' tsconfig base)",
    },
    'vite-aliases-removed': {
        removedBy: 'P4',
        what: "the `@sssb/app-config` and `@sssb/kit` aliases are cut out of each app's vite.demo.config.ts, which point into this repo in the starter (P4: the Vite preset)",
    },
    'seam-package-written': {
        removedBy: 'P12',
        what: "each app's src/app-config/package.json (the seam package and its exports) and its `link:` dependency are written by the script (P12: @sssb/create writes both)",
    },
    'root-devdeps-picked': {
        removedBy: 'P12',
        what: "the workspace root's devDependencies (typescript, vitest, esbuild, tsx, the @types and the rest) are picked by hand, at this repo's ranges (P12: @sssb/create writes them)",
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
