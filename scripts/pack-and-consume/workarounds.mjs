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
        what: "each app declares @types/pg itself: @sssb/kit's source imports pg's types, and the package does not declare them (they are a devDependency of SSSB's workspace root). The framework's copy finds them only through pnpm's hidden hoist (node_modules/.pnpm/node_modules), which is also how an adopter's would",
    },
    'undeclared-typescript': {
        removedBy: 'P3',
        what: "src/authz/route-scan.ts imports `typescript`, which @sssb/kit does not declare; it resolves only through the consumer's own typescript and pnpm's hoist (P3 makes typescript a peer)",
    },
    'demo-presets-seam-skipped': {
        removedBy: 'P3',
        what: 'demo-presets-seam.test.ts is not run from the tarball: it imports ../../../../tests/support/tmp-dir, a path outside the package, so it cannot load from node_modules',
    },
    'strict-flags-kit-baseline': {
        removedBy: 'P3',
        what: "the strict-flag typecheck tolerates exactly STRICT_KIT_ERROR_BASELINE errors inside @sssb/kit's own source (scripts/pack-and-consume.mjs); the apps' own code must be clean",
    },
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
        what: "tests/support/tmp-dir.ts and its marker module are copied into the consumer, because the starter's cron route test imports them by a repo-relative path (P4: makeTestTmpDir from @sssb/tools)",
    },
    'vitest-config-written': {
        removedBy: 'P4',
        what: "the consumer's root vitest.config.ts (a project per app, each with its own `@` alias) and its setup file (jest-dom's matchers) are written by the script (P4: the Vitest preset carries both)",
    },
    'tsconfig-written': {
        removedBy: 'P4',
        what: "each app's tsconfig.json is written by the script, at the ES2022 floor with only the app's `@/` path: the starter's extends this repo's root tsconfig and includes packages/kit/src (P4: the app extends @sssb/tools' tsconfig base)",
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
