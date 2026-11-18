import { fileURLToPath } from 'node:url'
import { portFor } from '@sssb/tools/ports'
import { defineConfig } from 'vitest/config'
import { contractApps } from './tests/support/contract-apps'

/**
 * Contract tests against real Postgres — slower, separate from the fast unit suite.
 *
 * ONE PROJECT PER APP, PLUS THE FRAMEWORK'S OWN SEAM, each with its own database. Two migration sets cannot share
 * one contract database: they share the framework's 0001–0999 but differ from 1001 up, so running the second
 * set's `migrateToLatest` over a database the first has migrated makes Kysely report corrupted migrations. A
 * project therefore means its OWN aliases AND its own database, which is what each app's contract test gets from the
 * contract runner it calls (`contractSuite` from `@sssb/kit/testing/contract`, over a `<slug>_contract` database of
 * the seam's slug, and `<slug>_contract_data_api` for its Data API pass) and what the `kit` project below does
 * (`sssb_contract`, `sssb_data_api_contract`). Every app's per-app migrations meet real Postgres, and the fakes are
 * held to the real engine for each of them.
 *
 * The apps are DISCOVERED (every `apps/*` with a `tests/contract`, tests/support/contract-apps.ts), not named
 * here, so renaming an app or ejecting the showcase needs no edit to this file. An app that registers
 * migrations and has no contract suite is a failure of tests/tooling/app-scaffold.test.ts, not a silent gap.
 */
const at = (relative: string) => fileURLToPath(new URL(relative, import.meta.url))

const appProject = (app: string) => ({
    resolve: {
        alias: {
            '@sssb/app-config': at(`./apps/${app}/src/app-config`),
            // the framework package (ADR-0012) — aliased rather than resolved through its exports
            // map so vitest loads the SAME source files the app's tsconfig paths resolve to
            '@sssb/kit': at('./packages/kit/src'),
            '@': at(`./apps/${app}/src`),
        },
    },
    test: {
        name: app,
        include: [`apps/${app}/tests/contract/**/*.test.ts`],
        testTimeout: 120_000,
        hookTimeout: 120_000,
    },
})

export default defineConfig({
    test: {
        // Every project uses one embedded-postgres port (@sssb/tools/ports: the apps pass portFor('contractPg') to
        // the runner, the kit project below gets it as CONTRACT_PG_PORT), so their files run one at a time rather
        // than racing for it.
        fileParallelism: false,
        projects: [
            ...contractApps(at('./')).map(appProject),
            {
                // The framework's OWN seam (packages/kit/test-fixture), as vitest.config.ts's `kit`
                // project uses — names no app, so ejecting or renaming one never touches it. Each of its
                // harnesses makes its own database: db.contract.test.ts (the `pg` driver) and
                // rds-data.contract.test.ts (the RDS Data API driver, through its emulator), both in
                // packages/kit/src/adapters/real. The framework takes no @sssb/tools (ADR-0014, rule 4), so its
                // server reads the port from the environment.
                resolve: {
                    alias: {
                        '@sssb/app-config': at('./packages/kit/test-fixture/app-config'),
                        '@sssb/kit': at('./packages/kit/src'),
                    },
                },
                test: {
                    name: 'kit',
                    include: ['packages/*/src/**/*.contract.test.ts'],
                    env: { CONTRACT_PG_PORT: String(portFor('contractPg')) },
                    testTimeout: 120_000,
                    hookTimeout: 120_000,
                },
            },
        ],
    },
})
