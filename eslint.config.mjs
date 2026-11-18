import { join } from 'node:path'
import js from '@eslint/js'
import nextPlugin from '@next/eslint-plugin-next'
import sssb from '@sssb/eslint-plugin'
import prettierConfig from 'eslint-config-prettier'
import jsxA11y from 'eslint-plugin-jsx-a11y'
import reactPlugin from 'eslint-plugin-react'
import reactHooksPlugin from 'eslint-plugin-react-hooks'
import typescriptEslint from 'typescript-eslint'

// SSSB's OWN LINT CONFIG. The fences are rules of @sssb/eslint-plugin (packages/eslint-plugin, ADR-0014 part 4 and
// step P6), and this file only says where each holds:
//  - BOTH APPS get exactly what an adopter's app gets, `sssb.configs.app({ root })`, with `apps/*` as the root, so
//    every app-side fence is proved against both apps before an adopter sees it. Each app's own exceptions are
//    `apps/<app>/lint-exceptions.mjs`, which the preset reads.
//  - THE FRAMEWORK (packages/kit, its src/ and its test fixture) and the repo's other packages get the same fences
//    where they apply to them, plus the SSSB-internal ones: the framework/app fence, the package's edge, core's
//    framework ban, and SSSB's public surface. No preset enables those; they ship in the same plugin object because
//    flat config refuses two `sssb` plugins for one file (`Cannot redefine plugin "sssb"`), and the preset's blocks
//    and these both match the apps.
// No fence is a no-restricted-imports or no-restricted-syntax setting: a later block that sets either rule REPLACES
// the earlier one for the files it matches (the merge trap), so every fence has a rule id of its own instead.
//
// Rules that need this repository's files (the kit's package.json, the repo root) take it as `{ root }` and read it
// when they run, never when the plugin loads, so the plugin loads in an adopter's config too.

// EVERY extension ESLint lints here, for globs that name a directory (see SRC_EXT in the plugin's patterns.js).
const SRC_EXT = '{ts,tsx,mts,cts,js,jsx,mjs,cjs}'
const TEST_FILES = '**/*.test.{ts,tsx}'
const STORY_FILES = '**/*.stories.{js,jsx,ts,tsx}'
const KIT_ADAPTERS_GLOB = 'packages/kit/src/adapters/**'
const FRAMEWORK_FILES_GLOB = `packages/kit/src/**/*.${SRC_EXT}`
const FRAMEWORK_COMPONENTS_GLOB = `packages/kit/src/components/**/*.${SRC_EXT}`
const FRAMEWORK_DEMO_STATIC_GLOB = `packages/kit/src/demo-static/**/*.${SRC_EXT}`
const KIT_ADAPTER_FILES_GLOB = `${KIT_ADAPTERS_GLOB}/*.${SRC_EXT}`
// Every workspace package's source, the framework's included; packages/seed is the app's seed data.
const PACKAGE_FILES_GLOB = `packages/*/src/**/*.${SRC_EXT}`
// SSSB's OWN app seam (ADR-0012): packages/kit/test-fixture is app-SHAPED code inside the framework package, and the
// seam the root program resolves `@sssb/app-config/*` through. It is NOT under src/, so it is named explicitly
// wherever a rule is about a FRAMEWORK invariant: it was once the one directory in packages/kit where importing an
// app's `@/*` alias or `@app/seed` was legal, which passed lint, typecheck and vitest and broke only at
// `pnpm init-app --eject-showcase`.
const FIXTURE_FILES_GLOB = `packages/kit/test-fixture/**/*.${SRC_EXT}`

// The anchor the internal rules read when they run.
const REPO = { root: import.meta.dirname }

/** @type {import('eslint').Linter.Config[]} */
const eslintConfig = [
    {
        ignores: [
            '**/node_modules/**',
            '**/.next/**',
            '**/.data/**',
            'out/**',
            'build/**',
            'dist/**',
            '**/next-env.d.ts',
            '.*',
            '!.ladle',
            '!.ladle/**',
            '**/.ladle/dist/**',
            '**/test-results/**',
            '**/playwright-report/**',
            '**/coverage/**',
            'spikes/*/node_modules/**',
            'infra/cdk.out/**',
            '**/dist-demo/**',
        ],
    },
    js.configs.recommended,
    ...typescriptEslint.configs.recommended,
    {
        files: ['**/*.cjs'],
        languageOptions: {
            sourceType: 'commonjs',
            globals: { module: 'writable', require: 'readonly', __dirname: 'readonly', process: 'readonly' },
        },
    },
    {
        files: ['scripts/**/*.{mjs,ts}', 'packages/eslint-plugin/src/**/*.js'],
        languageOptions: {
            globals: {
                process: 'readonly',
                console: 'readonly',
                // tick.mjs and dev-tick.mjs: an HTTP client with a timeout, and a stoppable timer
                URL: 'readonly',
                fetch: 'readonly',
                AbortController: 'readonly',
                AbortSignal: 'readonly',
                setTimeout: 'readonly',
                clearTimeout: 'readonly',
            },
        },
    },
    // Kysely migrations are conventionally typed Kysely<any> (schema evolves under them), and spikes are proof
    // harnesses — relax the any ban there only.
    {
        files: ['**/migrations/**/*.ts', 'spikes/**/*.ts'],
        rules: { '@typescript-eslint/no-explicit-any': 'off' },
    },
    // Every extension: sssb/no-jsx-literals runs react's rule on SSSB's `.mjs` screens too.
    {
        files: [`**/*.${SRC_EXT}`],
        plugins: {
            react: reactPlugin,
            'react-hooks': reactHooksPlugin,
            'jsx-a11y': jsxA11y,
        },
        rules: {
            ...reactPlugin.configs.recommended.rules,
            ...reactPlugin.configs['jsx-runtime'].rules,
            ...reactHooksPlugin.configs.recommended.rules,
            ...jsxA11y.configs.recommended.rules,
            'react/prop-types': 'off',
        },
        settings: {
            // Explicit version: eslint-plugin-react's 'detect' path uses context.getFilename, which ESLint 10
            // removed. Bump alongside React upgrades.
            react: { version: '19.2' },
        },
    },
    {
        files: [FRAMEWORK_FILES_GLOB],
        plugins: { '@next/next': nextPlugin },
        rules: nextPlugin.configs.recommended.rules,
    },

    // ---- BOTH APPS: the preset, exactly as an adopter's app takes it --------------------------------------------
    ...(await sssb.configs.app({ root: join(import.meta.dirname, 'apps/*') })),

    // ---- THE FRAMEWORK and the repo's other packages -------------------------------------------------------------
    // THE TENANCY BAN (ADR-0004) over SSSB's screens (components/ and demo-static/) and its fixture, whose api/ and
    // domain/ files are the app-shaped request path this template teaches. SSSB's own src/ outside its screens is
    // NOT in the zone: @sssb/kit/db's helpers and SSSB's adapters are what open withTenant, the "@sssb/kit/db helper"
    // the rule's message sends request code to. Tests are exempt, except the screens' and the fixture's (the next
    // block).
    {
        files: [FRAMEWORK_COMPONENTS_GLOB, FRAMEWORK_DEMO_STATIC_GLOB, FIXTURE_FILES_GLOB],
        ignores: [TEST_FILES],
        plugins: { sssb },
        rules: { 'sssb/no-raw-db-handle': 'error' },
    },
    {
        files: ['packages/kit/src/components', 'packages/kit/src/demo-static', 'packages/kit/test-fixture'].map(
            (dir) => `${dir}/${TEST_FILES}`,
        ),
        plugins: { sssb },
        rules: { 'sssb/no-raw-db-handle': 'error' },
    },
    // PARAMS CENTRALIZATION: process.env is read only inside SSSB's adapters (and an app's own real adapters). Exempt
    // besides: the two secret readers, by exact file, and tests. The fixture is on the app side of that line, and has
    // no tests of its own to exempt.
    {
        files: [FRAMEWORK_FILES_GLOB],
        ignores: [
            KIT_ADAPTERS_GLOB,
            'packages/kit/src/service-auth/webhook.ts',
            'packages/kit/src/service-auth/mailgun.ts',
            TEST_FILES,
        ],
        plugins: { sssb },
        rules: { 'sssb/no-process-env': 'error' },
    },
    {
        files: [FIXTURE_FILES_GLOB],
        plugins: { sssb },
        rules: { 'sssb/no-process-env': 'error' },
    },
    // i18n (ADR-0008) on SSSB's side of the line: its screens, its static demo, and its adapters, which render copy
    // too (the real sign-in and accept-invite forms). The fixture ships no copy (it has no components tree, and its
    // route files are scanned by authorized-mutations.test.ts, never served), so neither literal ban applies there.
    {
        files: [FRAMEWORK_COMPONENTS_GLOB, KIT_ADAPTER_FILES_GLOB],
        ignores: [TEST_FILES, STORY_FILES],
        plugins: { sssb },
        rules: { 'sssb/no-literal-a11y-copy': 'error' },
    },
    {
        files: [FRAMEWORK_COMPONENTS_GLOB, FRAMEWORK_DEMO_STATIC_GLOB, KIT_ADAPTER_FILES_GLOB],
        plugins: { sssb },
        rules: { 'sssb/no-jsx-literals': 'error' },
    },
    // THE PORTS BOUNDARY: vendor SDKs only inside SSSB's adapters (ADR-0003, -0009, -0010, -0011), in every package's
    // source and the fixture, statically and dynamically; and dev stays hermetic everywhere there.
    {
        files: [PACKAGE_FILES_GLOB, FIXTURE_FILES_GLOB],
        ignores: [KIT_ADAPTERS_GLOB],
        plugins: { sssb },
        rules: { 'sssb/no-vendor-import': 'error', 'sssb/no-dynamic-vendor-import': 'error' },
    },
    {
        files: [PACKAGE_FILES_GLOB, FIXTURE_FILES_GLOB],
        plugins: { sssb },
        rules: { 'sssb/no-next-font-google': 'error' },
    },
    // THE FRAMEWORK/APP FENCE (ADR-0012): the framework package reaches app content only through the
    // @sssb/app-config/* seam, never by alias, `..`, node_modules or path, in declarations or outside them. TWO globs:
    // the framework's source tree, and its own test fixture, which is inside the package and must not be the one door
    // left open.
    {
        files: [FRAMEWORK_FILES_GLOB, FIXTURE_FILES_GLOB],
        plugins: { sssb },
        rules: {
            'sssb/no-app-import': 'error',
            'sssb/no-dynamic-app-import': 'error',
            'sssb/no-path-to-app-code': ['error', REPO],
        },
    },
    // THE PACKAGE'S EDGE: no framework file, fixture included, reaches outside packages/kit by path. Two named
    // exemptions, both P5's: the real-Postgres contract tests start their server through the repo's
    // tests/support/contract-postgres.ts, which reads scripts/ports.mjs and embedded-postgres. P5 moves the contract
    // runner into @sssb/kit/testing; neither file ships (the `files` allowlist keeps tests out).
    {
        files: [FRAMEWORK_FILES_GLOB, FIXTURE_FILES_GLOB],
        ignores: [
            'packages/kit/src/adapters/real/db.contract.test.ts',
            'packages/kit/src/adapters/real/rds-data.contract.test.ts',
        ],
        plugins: { sssb },
        rules: { 'sssb/no-path-out-of-package': ['error', REPO] },
    },
    // @sssb/kit/core stays framework-free (ADR-0006): no framework import in a declaration or outside one, and no JSX,
    // which imports react/jsx-runtime without naming it.
    {
        files: [`packages/kit/src/core/**/*.${SRC_EXT}`],
        plugins: { sssb },
        rules: {
            'sssb/no-framework-import-in-core': 'error',
            'sssb/no-dynamic-framework-import-in-core': 'error',
            'sssb/no-jsx-in-core': 'error',
        },
    },
    // SSSB's PUBLIC SURFACE (ADR-0012). Repo-wide on purpose: apps, repo scripts, infra and the other workspace
    // packages all resolve `@sssb/kit/…` through an alias that bypasses the exports map, so all of them are consumers
    // the map has to hold for. Inside packages/kit the specifier never appears (imports there are relative), so this
    // also catches a self-import through the alias.
    {
        files: [`**/*.${SRC_EXT}`],
        plugins: { sssb },
        rules: { 'sssb/public-surface': ['error', REPO] },
    },
    // No raw mkdtemp in tests, anywhere in the repo (the preset covers the apps' tests/ too).
    // packages/kit/src/testing/tmp-dir.ts is the one place the raw call is meant to live, ignored explicitly so that
    // stays true if the glob is ever widened.
    {
        files: [TEST_FILES, FIXTURE_FILES_GLOB],
        ignores: ['packages/kit/src/testing/tmp-dir.ts'],
        plugins: { sssb },
        rules: { 'sssb/no-direct-mkdtemp': 'error' },
    },
    prettierConfig,
]

export default eslintConfig
