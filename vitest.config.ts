import { fileURLToPath } from 'node:url'
import { appTestProject } from '@sssb/tools/vitest'
import react from '@vitejs/plugin-react'
import { configDefaults, defineConfig, type ViteUserConfig } from 'vitest/config'

const at = (relative: string) => fileURLToPath(new URL(relative, import.meta.url))

/**
 * THE APP LIST — the whole of this file's app knowledge; everything below derives from it.
 * `scripts/init-app.ts` rewrites exactly this literal when an adopter renames an app or ejects the
 * showcase, which is why it is spelled out here rather than discovered from `apps/`.
 *
 * There used to be a second constant here, FRAMEWORK_SUITE_APP, naming the app SSSB's own suite ran
 * under. There is no such app any more: the framework's tests run against the framework's OWN seam
 * (packages/kit/test-fixture — see the `kit` project below), so ejecting the demo cannot take
 * SSSB's suite down with it.
 */
const APPS = ['showcase', 'starter'] as const

/**
 * ONE PROJECT PER APP, from the preset every SSSB app uses (@sssb/tools/vitest), the reason this file has projects
 * at all. `@sssb/app-config/*` is the seam the framework resolves app vocabulary through (ADR-0012), and it is a
 * BARE SPECIFIER: a single global alias can only ever point at one app. With two apps a shared alias would silently
 * bind the framework's tests to whichever app happened to be listed first, and the other app's registrations would
 * never execute. So each app gets its own project, rooted at the app, with its own seam passed explicitly, and each
 * app's conformance suite (below) runs against that app's seam.
 *
 * What this repo adds to the preset: `@sssb/kit` aliased to the framework's source, so Vitest loads the SAME source
 * files the app's tsconfig `paths` resolve to (ADR-0014 part 1: inside this repo resolution goes through aliases, an
 * adopter's through the seam link).
 */
/**
 * The framework checks that must hold for EVERY app (the authorization scan of its route tree, i18n
 * partition and parity over its MERGED catalog, the pglite RLS suite over its own tables, migration
 * order, its demo presets, the seam map) are the CONFORMANCE SUITE, `@sssb/kit/testing` (ADR-0014 P5).
 * This file does not list them: each app runs the suite from its own tree, `apps/<app>/src/sssb.conformance.test.ts`,
 * which the app project's own `src/**` include picks up like any other app test, as an adopter's does. Running
 * them per app is the point: they are what proves the seam is honest against real apps rather than only
 * against the fixture. The `kit` project below runs the same suite against the framework's own fixture seam
 * (packages/kit/src/testing/conformance.test.ts), and the REST of SSSB's suite once, against that seam.
 */

// The first test to touch the fake DB cold-migrates + seeds pglite in-process; under full-suite
// parallel load that can exceed vitest's 5s default and flake the unit job (which, unlike e2e, has no
// CI retry). 20s gives generous headroom without masking a genuinely hung test.
const TEST_TIMEOUT_MS = 20_000

const projectFor = (app: string) =>
    appTestProject({
        appDir: at(`./apps/${app}`),
        alias: { '@sssb/kit': at('./packages/kit/src') },
        // The fake LLM adapter resolves fixtures from the working directory, which for `next dev` is the app, but
        // this suite runs from the REPO ROOT, so every project points the adapter at its OWN fixtures (same
        // override shape as APP_DATA_DIR). An app with no fixtures dir simply never asks for one.
        env: { APP_FIXTURES_DIR: at(`./apps/${app}/fixtures`) },
        testTimeout: TEST_TIMEOUT_MS,
    })

/**
 * THE FRAMEWORK'S OWN PROJECT — SSSB's suite (and any other package's), run against SSSB's own
 * conforming seam in `packages/kit/test-fixture` rather than against a host app's.
 *
 * That fixture is why this project exists and why it names no app: the framework's tests need a seed
 * world, an app table, an app job/webhook/notification kind and a route tree to assert against, and
 * borrowing a host app's meant `pnpm init-app --eject-showcase` left the suite red. The fixture's
 * vocabulary is deliberately none of the apps' (`harbor`/`dockets`/`fixture-*`), so a regression back
 * to app coupling fails loudly instead of passing by coincidence.
 *
 * It no longer carries a cross-app scan: each app's route tree is scanned by that app's own conformance
 * suite (`authz-mutations`), and authorized-mutations.test.ts here scans the fixture's reference tree.
 */
const kitProject = {
    plugins: [react()],
    resolve: {
        alias: {
            '@sssb/app-config': at('./packages/kit/test-fixture/app-config'),
            '@sssb/kit': at('./packages/kit/src'),
        },
    },
    test: {
        name: 'kit',
        environment: 'happy-dom',
        include: ['packages/*/src/**/*.test.{ts,tsx}'],
        // Real-Postgres proofs belong to `pnpm test:contract` (vitest.contract.config.ts), not the unit run.
        exclude: [...configDefaults.exclude, '**/*.contract.test.ts'],
        setupFiles: [at('./tests/vitest.setup.ts')],
        // The fake LLM adapter resolves fixtures from the working directory, which for `next dev` is
        // the app — but this suite runs from the REPO ROOT, so it points the adapter at the fixture's
        // own fixtures (same override shape as APP_DATA_DIR).
        env: { APP_FIXTURES_DIR: at('./packages/kit/test-fixture/fixtures') },
        testTimeout: TEST_TIMEOUT_MS,
    },
}

export default defineConfig(async (): Promise<ViteUserConfig> => ({
    test: {
        projects: [
            ...(await Promise.all(APPS.map(projectFor))),
            kitProject,
            {
                // Repo hygiene, not app scope — and deliberately alias-free, so nothing here can
                // quietly come to depend on one app being "the" app. Everything under `tests/` is
                // repo-scoped by construction (app tests are colocated in `apps/*/src`), so this
                // matches the whole directory rather than enumerating each subject: docs path
                // integrity, and the tooling that shapes local/CI runs (ports, worker counts).
                test: {
                    name: 'repo',
                    environment: 'node',
                    include: ['tests/**/*.test.ts'],
                    testTimeout: TEST_TIMEOUT_MS,
                },
            },
        ],
        coverage: {
            provider: 'v8',
            // Extension-bound: an extension-less glob hands v8 the two `src/**/README.md` files
            // (adapters, ports), which esbuild then fails to parse — two stack traces in every CI
            // run of `test:coverage`, looking exactly like real failures while the job exits 0.
            include: ['apps/*/src/**/*.{ts,tsx}', 'packages/*/src/**/*.{ts,tsx}'],
            exclude: [
                'apps/*/src/demo-static/**',
                'apps/*/src/styles/generated/**',
                '**/*.stories.tsx',
                '**/*.test.{ts,tsx}',
            ],
            reporter: ['text-summary', 'json-summary'],
            // thresholds intentionally absent — a ratchet (thresholds + autoUpdate) lands after CI baselines
        },
    },
}))
