// @ts-check
// THE NEXT PRESET (ADR-0014 parts 2 and 6).
//
//     // apps/<app>/next.config.ts
//     import { withSssb } from '@sssb/tools/next'
//     export default withSssb({ typedRoutes: true }, { appDir: __dirname })
//
// What every SSSB app's Next config needs, with the app's own settings layered over it:
// - `transpilePackages: ['@sssb/kit']`: the framework ships TypeScript source, compiled by the app's build.
// - next-intl's plugin, pointed at the framework's request config. next-intl's default lookup only knows
//   ./src/i18n/request.ts, and SSSB's lives in the framework (ADR-0012). The path is the published subpath
//   `@sssb/kit/i18n/request`, resolved from the app's directory through the shared resolver (rule 4), never a path
//   into the package's internal layout, and handed to the plugin relative to the app, as next-intl and Turbopack
//   read it. The plugin itself is the app's own next-intl, loaded from the app's directory.
// - `output: 'standalone'`: the deployed artifact is the standalone server in a Lambda (ADR-0001).
// - the native and WASM server dependencies kept external, so their runtime file loading keeps working.
// - `agentRules: false` and `experimental.agentUpgrade: false`, so `next dev` stays hermetic: without the first it
//   writes an AGENTS.md into the app whenever it detects an AI coding agent; without the second every `next dev`
//   outside CI queries npm's advisory feed for the installed next, and an agent's run stops when an advisory matches.
//   Both are defined in node_modules/next/dist/docs/01-app/03-api-reference/05-config/01-next-config-js/.
//
// Pass the app's directory: Next loads the config with the app as the working directory, which is the default, but
// another tool that loads it (knip does) may not.
import { createRequire } from 'node:module'
import path from 'node:path'
import { resolveAppsKit, resolveFromApp } from './kit.js'

/** @param {string[] | undefined} list @param {string[]} add */
const union = (list, add) => [...new Set([...(list ?? []), ...add])]

/** @type {import('./next.d.ts').withSssb} */
export function withSssb(nextConfig = {}, { appDir = process.cwd() } = {}) {
    const root = path.resolve(appDir)
    const request = resolveAppsKit(root, 'i18n/request')
    const relative = path.relative(root, request).split(path.sep).join('/')
    const pluginFile = resolveFromApp(root, 'next-intl/plugin', "the framework's i18n needs")
    const plugin = createRequire(pluginFile)(pluginFile)
    /** @type {(path: string) => (config: import('next').NextConfig) => import('next').NextConfig} */
    const createNextIntlPlugin = plugin.default ?? plugin
    const withNextIntl = createNextIntlPlugin(relative.startsWith('.') ? relative : `./${relative}`)

    return withNextIntl({
        output: 'standalone',
        agentRules: false,
        ...nextConfig,
        transpilePackages: union(nextConfig.transpilePackages, ['@sssb/kit']),
        serverExternalPackages: union(nextConfig.serverExternalPackages, ['@electric-sql/pglite', 'pg']),
        experimental: { agentUpgrade: false, ...nextConfig.experimental },
    })
}
