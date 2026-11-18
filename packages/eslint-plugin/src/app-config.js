// THE APP PRESET: `await sssb.configs.app({ root })` (ADR-0014, part 4). An app's own `eslint.config.mjs` composes
// it with whatever else it wants:
//
//     import sssb from '@sssb/eslint-plugin'
//     export default [...(await sssb.configs.app({ root: import.meta.dirname })), ...myOwnBlocks]
//
// `root` is the app's directory, as an ABSOLUTE path: a relative one would be relative to wherever ESLint was
// started, so the preset refuses it. Every block it returns carries `basePath: root`, and its globs are relative to
// the app (`src/**`), so the same preset works from the app's own config, from a workspace-root config that passes
// `join(import.meta.dirname, 'apps/console')`, and whether ESLint runs from the app or from the workspace root. A
// root whose last segment is `*` (`join(import.meta.dirname, 'apps/*')`) means every app in that directory; SSSB's
// own repository lints both of its apps that way.
//
// It returns the base config an app needs (JavaScript, TypeScript, React, hooks, a11y and Next, with the carve-outs
// for CommonJS files and migrations, and Prettier's turn-offs last) and every app-side fence, each a rule with an id
// of its own, so nothing an adopter writes after it in an ordinary `no-restricted-imports` or
// `no-restricted-syntax` block can replace a fence. What CAN change one (turning an sssb/* rule off, a later block's
// `ignores`, a nested config file) is what `sssb check-fences` compares against this preset.
//
// It is async because it reads the app's own `lint-exceptions.mjs` (below), an ES module.
import { existsSync, readdirSync, statSync } from 'node:fs'
import { basename, dirname, isAbsolute, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import js from '@eslint/js'
import nextPlugin from '@next/eslint-plugin-next'
import prettierConfig from 'eslint-config-prettier'
import jsxA11y from 'eslint-plugin-jsx-a11y'
import reactPlugin from 'eslint-plugin-react'
import reactHooksPlugin from 'eslint-plugin-react-hooks'
import typescriptEslint from 'typescript-eslint'
import { SRC_EXT, STORY_FILES, TEST_FILES } from './patterns.js'

// APP-OWNED LINT EXCEPTIONS. A fence that takes named exceptions should not make an adopter edit SSSB's config, so
// each app lists its own in `lint-exceptions.mjs` at its root, by path relative to the app, and the preset reads it.
// The file's default export maps a rule id to entries of `{ file, reason }`; only the rules in APP_EXCEPTION_RULES
// take one.
//
// Each entry names ONE existing file under the app's src/ and says why. Anything else fails the config load, naming
// the app's file and the entry: a glob, a directory, a path out of the app, a missing reason, a rule that takes no
// exceptions, or a file that no longer exists. So an exception cannot quietly widen or outlive the file it names (one
// that outlives its NEED is still the app's to delete). The path is matched literally (a Next route's `[locale]` is
// not a glob).
const APP_EXCEPTION_RULES = ['sssb/no-raw-db-handle']
const GLOB_SPECIALS = /[*?[\]{}()!+@]/g

/**
 * One app's exceptions, as `ignores` entries relative to the app (glob specials escaped), by rule id.
 * @param {string} appDir
 * @returns {Promise<Record<string, string[]>>}
 */
export async function loadAppLintExceptions(appDir) {
    const ignoresByRule = Object.fromEntries(APP_EXCEPTION_RULES.map((rule) => [rule, []]))
    const source = join(appDir, 'lint-exceptions.mjs')
    if (!existsSync(source)) return ignoresByRule
    const fail = (why) => {
        throw new Error(`${source}: ${why}`)
    }
    // Keyed by the file's mtime, so when a config runs again in one process it reads the file as it is now, not the
    // module it cached the first time. ESLint re-runs a config only when the config file itself changes, so an
    // editor's lint server still needs a restart to see an edit to lint-exceptions.mjs.
    const { default: exceptions } = await import(`${pathToFileURL(source).href}?mtime=${statSync(source).mtimeMs}`)
    if (!exceptions || typeof exceptions !== 'object' || Array.isArray(exceptions)) {
        fail('its default export must be an object mapping a rule id to its entries')
    }
    for (const [rule, entries] of Object.entries(exceptions)) {
        if (!APP_EXCEPTION_RULES.includes(rule)) {
            fail(`\`${rule}\` takes no app exceptions (only ${APP_EXCEPTION_RULES.join(', ')} does)`)
        }
        if (!Array.isArray(entries)) fail(`\`${rule}\` must map to an array of { file, reason } entries`)
        for (const entry of entries) {
            const { file, reason } = entry ?? {}
            if (typeof file !== 'string' || file.trim() === '') fail(`an entry under \`${rule}\` names no file`)
            if (/[*?]/.test(file)) fail(`\`${file}\` is a glob: an exception names one file`)
            if (!file.startsWith('src/') || file.includes('\\') || file.split('/').includes('..')) {
                fail(`\`${file}\` must be a path under the app's src/, relative to the app, with / separators`)
            }
            const target = join(appDir, file)
            if (!existsSync(target) || !statSync(target).isFile()) {
                fail(`\`${file}\` names no file: an exception names one existing file, never a directory`)
            }
            if (typeof reason !== 'string' || reason.trim() === '') fail(`\`${file}\` needs a reason`)
            ignoresByRule[rule].push(file.replace(GLOB_SPECIALS, '\\$&'))
        }
    }
    return ignoresByRule
}

/**
 * Where the preset's blocks are anchored, and the apps under it: `{ basePath, prefix, apps }`, where `prefix` is
 * prepended to every app-relative glob and `apps` lists each app's directory and its prefix.
 * @param {string} root
 */
function resolveRoot(root) {
    if (typeof root !== 'string' || !isAbsolute(root)) {
        throw new Error(
            "@sssb/eslint-plugin: configs.app({ root }) takes the app's directory as an ABSOLUTE path " +
                `(import.meta.dirname from the app's eslint.config.mjs), not ${JSON.stringify(root)}: a relative ` +
                'root would be relative to wherever ESLint was started.',
        )
    }
    if (basename(root) !== '*') return { basePath: root, prefix: '', apps: [{ dir: root, prefix: '' }] }
    const parent = dirname(root)
    if (parent.includes('*')) throw new Error(`@sssb/eslint-plugin: only a last segment of \`*\` is a glob (${root})`)
    const apps = existsSync(parent)
        ? readdirSync(parent, { withFileTypes: true })
              .filter((entry) => entry.isDirectory())
              .map((entry) => entry.name)
              .sort()
              .map((name) => ({ dir: join(parent, name), prefix: `${name}/` }))
        : []
    return { basePath: parent, prefix: '*/', apps }
}

// Next loads its config from these four names and no other (CONFIG_FILES in next's shared/lib/constants).
const NEXT_CONFIG = 'next.config.{ts,mts,js,mjs}'

/**
 * @param {import('eslint').ESLint.Plugin} plugin the one plugin object (./index.js)
 * @param {{ root: string, vendors?: string[] }} options `vendors`: the app's own adapters' SDKs, added to SSSB's vendor
 *     list in the same gitignore-style patterns (`stripe`, `stripe/*`). It only ever adds.
 * @returns {Promise<import('eslint').Linter.Config[]>}
 */
export async function appConfig(plugin, { root, vendors } = /** @type {any} */ ({})) {
    const { basePath, prefix: P, apps } = resolveRoot(root)
    if (
        vendors !== undefined &&
        (!Array.isArray(vendors) || !vendors.every((v) => typeof v === 'string' && v.trim()))
    ) {
        throw new Error(
            '@sssb/eslint-plugin: configs.app({ vendors }) takes a list of package patterns, such as ["stripe", "stripe/*"]',
        )
    }
    const vendorBan = vendors?.length ? ['error', { vendors }] : 'error'
    const exceptions = { 'sssb/no-raw-db-handle': [] }
    for (const app of apps) {
        const loaded = await loadAppLintExceptions(app.dir)
        for (const [rule, files] of Object.entries(loaded)) {
            exceptions[rule].push(...files.map((file) => `${app.prefix}${file}`))
        }
    }
    const src = (dir) => `${P}src/${dir}`
    // Every file under each app-relative directory, every extension; '' is the whole app.
    const files = (...dirs) => dirs.map((dir) => `${P}${dir ? `${dir}/` : ''}**/*.${SRC_EXT}`)
    const sssb = { sssb: plugin }
    /** @type {(name: string, block: import('eslint').Linter.Config) => import('eslint').Linter.Config} */
    const at = (name, block) => ({ ...block, name: `sssb/app/${name}`, basePath })

    return [
        at('ignores', {
            ignores: [
                '**/node_modules/**',
                '**/.next/**',
                '**/.data/**',
                '**/next-env.d.ts',
                '**/.ladle/dist/**',
                '**/dist-demo/**',
                '**/test-results/**',
                '**/playwright-report/**',
                '**/coverage/**',
                // What Panda 2's codegen writes there (`.js` and `.d.ts`, its default `outExtension`): a hand-written
                // `.ts`, `.mjs` or any other extension in that directory is fenced like any other module. A
                // hand-written `.js` is not, since it has the extension of Panda's own output.
                `${src('styles/generated')}/**/*.{js,d.ts}`,
            ],
        }),

        // ---- the base config ---------------------------------------------------------------------------------
        at('js', js.configs.recommended),
        // typescript-eslint's `configs.recommended` is a getter that records the calling config file's directory as a
        // candidate tsconfigRootDir, and its parser refuses to guess once there are two (a workspace-root config and an
        // app's own, loaded by one ESLint run). So the preset reads the same objects from the raw plugin, which records
        // nothing, and names the root itself.
        ...typescriptEslint.plugin.configs['flat/recommended'].map((block, i) => at(`typescript-${i}`, block)),
        at('typescript-root', { languageOptions: { parserOptions: { tsconfigRootDir: basePath } } }),
        at('commonjs', {
            files: ['**/*.cjs'],
            languageOptions: {
                sourceType: 'commonjs',
                globals: { module: 'writable', require: 'readonly', __dirname: 'readonly', process: 'readonly' },
            },
        }),
        // Kysely migrations are conventionally typed Kysely<any> (the schema evolves under them).
        at('migrations', { files: ['**/migrations/**/*.ts'], rules: { '@typescript-eslint/no-explicit-any': 'off' } }),
        // Every extension: sssb/no-jsx-literals runs react's rule, and a `.mjs` screen renders copy too.
        at('react', {
            files: [`**/*.${SRC_EXT}`],
            plugins: { react: reactPlugin, 'react-hooks': reactHooksPlugin, 'jsx-a11y': jsxA11y },
            rules: {
                ...reactPlugin.configs.recommended.rules,
                ...reactPlugin.configs['jsx-runtime'].rules,
                ...reactHooksPlugin.configs.recommended.rules,
                ...jsxA11y.configs.recommended.rules,
                'react/prop-types': 'off',
            },
            // Explicit version: eslint-plugin-react's 'detect' path uses context.getFilename, which ESLint 10
            // removed. Bump alongside React upgrades.
            settings: { react: { version: '19.2' } },
        }),
        at('next', {
            files: files('src'),
            plugins: { '@next/next': nextPlugin },
            rules: nextPlugin.configs.recommended.rules,
        }),

        // ---- the fences ----------------------------------------------------------------------------------------
        // THE TENANCY BAN (ADR-0004), deny-by-default: no module in the app's src/ takes the raw db handle, so every
        // tenant-scoped query goes through withTenant and RLS tenant context is always set. A directory nobody has
        // thought of yet is inside, and what needs the raw client is a named exception in the app's
        // lint-exceptions.mjs, with a reason. Tests are exempt (a test resolving seed ids by slug to arrange a case
        // is not a request path), except a route's or a screen's, which drives the code a request runs (the next
        // block).
        at('tenancy', {
            files: files('src'),
            ignores: [TEST_FILES, ...exceptions['sssb/no-raw-db-handle']],
            plugins: sssb,
            rules: { 'sssb/no-raw-db-handle': 'error' },
        }),
        at('tenancy-in-screen-tests', {
            files: ['app', 'components', 'demo-static'].map((dir) => `${src(dir)}/${TEST_FILES}`),
            plugins: sssb,
            rules: { 'sssb/no-raw-db-handle': 'error' },
        }),
        // PARAMS CENTRALIZATION: process.env is read ONLY inside an app's own real adapters (and SSSB's). Every other
        // module imports the resolved value: the app's config/params.ts for deployment params, isSimulated/isDemoMode
        // from @sssb/kit/adapters for the run mode. config/ too: params.ts records names and placeholders and never
        // reads the environment, and without it the directory beside src/ was the obvious place for a helper that
        // hands the registry its own reading of APP_MODE. Exempt: real/, Next's two instrumentation hooks under the
        // default pageExtensions (NEXT_PUBLIC_* needs literal inlining; `instrumentation-helpers.ts` is an ordinary
        // module), and tests (which set APP_DATA_DIR for isolation). The app-root tool configs (Playwright, Vite,
        // Ladle) may read it.
        at('process-env', {
            files: files('src', 'config'),
            ignores: [`${src('adapters/real')}/**`, `${src('instrumentation{,-client}')}.{ts,tsx,js,jsx}`, TEST_FILES],
            plugins: sssb,
            rules: { 'sssb/no-process-env': 'error' },
        }),
        // An app's REAL adapters read their own configuration from process.env, but never the run mode.
        at('run-mode', {
            files: files('src/adapters/real'),
            ignores: [TEST_FILES],
            plugins: sssb,
            rules: { 'sssb/no-run-mode-env': 'error' },
        }),
        // Accessible names, placeholders, titles and alt text are copy (ADR-0008). Routes, screens and the adapters
        // directory, where a real-mode-only component (a vendor widget) or a fake renders copy. Stories render
        // fixtures, not shipped copy.
        at('a11y-copy', {
            files: files('src/app', 'src/components', 'src/adapters'),
            ignores: [TEST_FILES, STORY_FILES],
            plugins: sssb,
            rules: { 'sssb/no-literal-a11y-copy': 'error' },
        }),
        // i18n: UI code holds no hard-coded strings (ADR-0008). demo-static is included: the `file://` shell and the
        // app's static twin are user-visible UI that ships to whoever is handed dist-demo/index.html.
        at('jsx-literals', {
            files: files('src/app', 'src/components', 'src/demo-static', 'src/adapters'),
            plugins: sssb,
            rules: { 'sssb/no-jsx-literals': 'error' },
        }),
        // THE PORTS BOUNDARY: vendor SDKs only in the app's real adapters (ADR-0012, addendum 2026-11-16), in every
        // file of the app, not only src/: `config/app.ts` is on the runtime module graph and `config/params.ts` is
        // imported by `next.config.ts`. The two carve-outs are the only files that legitimately reach a vendor
        // directly, and both are outside the request path: `next.config.*` composes the Sentry BUILD plugin
        // (`withSentryConfig`), a bundler wrapper rather than an SDK call (ADR-0010); `tests/contract/**` drives real
        // Postgres through `pg` on purpose, which IS the anti-drift proof. The registry and fakes are NOT carved out:
        // they are what keep `pnpm dev` hermetic, so they keep the ban.
        at('vendor', {
            files: files(''),
            ignores: [`${src('adapters/real')}/**`, `${P}${NEXT_CONFIG}`, `${P}tests/contract/**`],
            plugins: sssb,
            rules: { 'sssb/no-vendor-import': vendorBan, 'sssb/no-dynamic-vendor-import': vendorBan },
        }),
        // Hermetic dev, everywhere in the app.
        at('next-font', { files: files(''), plugins: sssb, rules: { 'sssb/no-next-font-google': 'error' } }),
        // Outside the adapters directory, the app's real adapters are reached through its registry. The same two
        // carve-outs as the vendor ban.
        at('real-adapters-via-registry', {
            files: files(''),
            ignores: [`${src('adapters')}/**`, `${P}${NEXT_CONFIG}`, `${P}tests/contract/**`],
            plugins: sssb,
            rules: { 'sssb/no-real-adapter-import': 'error' },
        }),
        // Inside it, the registry and the fakes: no static import of real/ (the registry's import() is the only way
        // in), and none of SSSB's real adapters.
        at('registry-and-fakes', {
            files: files('src/adapters'),
            ignores: [`${src('adapters/real')}/**`],
            plugins: sssb,
            rules: { 'sssb/no-static-real-adapter-import': 'error', 'sssb/no-kit-real-adapter-import': 'error' },
        }),
        // ...and only the registry loads real/ dynamically. The registry is `index.ts` and nothing else, as the
        // recipe names it: an `index.mjs` beside it is one more module that may not load real/. Stories keep it: a
        // fake's story that did `import('../real/kv')` would put the vendor SDK in the workshop.
        at('only-the-registry-loads-real', {
            files: files('src/adapters'),
            ignores: [`${src('adapters/real')}/**`, `${src('adapters')}/index.ts`, TEST_FILES],
            plugins: sssb,
            rules: { 'sssb/no-dynamic-real-adapter-import': 'error' },
        }),
        // No raw mkdtemp in tests: every unit test, and everything under tests/ (Playwright's default testMatch picks
        // up `.spec.mjs` and `.test.js`, and a support helper can be either).
        at('no-direct-mkdtemp', {
            files: [`${P}${TEST_FILES}`, ...files('tests')],
            plugins: sssb,
            rules: { 'sssb/no-direct-mkdtemp': 'error' },
        }),

        at('prettier', prettierConfig),
    ]
}
