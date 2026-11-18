// @ts-check
// THE VITEST PRESET: one app's test project (ADR-0014 part 3).
//
//     // vitest.config.ts, at the workspace root or in the app
//     import { defineConfig } from 'vitest/config'
//     import { appTestProject } from '@sssb/tools/vitest'
//     export default defineConfig({ test: { projects: [await appTestProject({ appDir: 'apps/console' })] } })
//
// One project per app, because the seam is a bare specifier: whatever resolves `@sssb/app-config` can name only one
// app (ADR-0012's reason for a project per app). The project's root is the app, its tests are the app's colocated
// `src/**/*.test.{ts,tsx}`, it runs in happy-dom with jest-dom's matchers, and, as every SSSB builder does, it passes
// the seam explicitly (`@sssb/app-config` to the app's `src/app-config`), beside the app's own `@` alias. The React
// plugin and jest-dom are the app's own copies, loaded from the app's directory.
// A guard plugin (framework-guard.js) fails a test file that loads framework source from any instance but the app's.
import path from 'node:path'
import { frameworkGuard } from './framework-guard.js'
import { importFromApp, resolveFromApp } from './kit.js'

/**
 * The first test to touch the fake database cold-migrates and seeds pglite in-process; under full-suite parallel
 * load that can exceed Vitest's 5s default and flake a unit run (which, unlike e2e, has no retry). 20s gives
 * generous headroom without masking a hung test.
 */
const TEST_TIMEOUT_MS = 20_000

/** @type {import('./vitest.d.ts').appTestProject} */
export async function appTestProject({ appDir, name, include = [], alias = {}, env, setupFiles = [], testTimeout }) {
    const root = path.resolve(appDir)
    const reactPlugin = await importFromApp(root, '@vitejs/plugin-react', "the app's component tests need")
    const react = /** @type {() => import('vite').PluginOption} */ (reactPlugin['default'])
    // Checked here for a clear error, but handed to Vitest as the bare specifier: Vitest resolves a setup file from
    // the project's root (the app) with the `import` condition, and gets jest-dom's ES module. Resolved here instead,
    // through Node's `require` conditions, it would be the CommonJS build, which cannot load Vitest.
    resolveFromApp(root, '@testing-library/jest-dom/vitest', "the app's DOM assertions need")
    return {
        plugins: [frameworkGuard(root), react()],
        resolve: {
            alias: {
                '@sssb/app-config': path.join(root, 'src', 'app-config'),
                '@': path.join(root, 'src'),
                ...alias,
            },
        },
        test: {
            name: name ?? path.basename(root),
            root,
            environment: 'happy-dom',
            include: ['src/**/*.test.{ts,tsx}', ...include],
            setupFiles: ['@testing-library/jest-dom/vitest', ...setupFiles],
            testTimeout: testTimeout ?? TEST_TIMEOUT_MS,
            ...(env === undefined ? {} : { env }),
        },
    }
}
