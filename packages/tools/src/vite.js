// @ts-check
// THE VITE PRESET for an app's single-file static demo (ADR-0014 parts 3 and 6), and the Mantine CSS pruning it
// carries.
//
//     // apps/<app>/vite.demo.config.ts
//     import { staticDemoConfig } from '@sssb/tools/vite'
//     export default staticDemoConfig({ appDir: __dirname })
//
// It builds the hash-routed demo shell (`src/demo-static`) that runs from file://, ALWAYS as one file: Chrome blocks
// external `type="module"` scripts on the file:// origin (CORS), but inline module scripts run, so everything is
// inlined into one index.html, which is also one shareable file.
//
// THE SEAM IS PASSED EXPLICITLY: `@sssb/app-config` is aliased to the app's own `src/app-config`, as every SSSB
// builder passes it (ADR-0014 part 1). In an adopter's app that is the same directory pnpm links, so it changes
// nothing; in SSSB's own repository, where the seam is not linked, it is the only thing that makes the framework
// resolve against this app's registrations rather than another's. `@` is the app's own `src`. The framework itself
// resolves as a package, through its `exports` map.
//
// Vite loads this file with Node, which is why it is JavaScript (part 2), and the Vite plugins it configures are
// the app's own copies, loaded from the app's directory, so the preset never brings a second Vite of its own.
import path from 'node:path'
import { importFromApp } from './kit.js'
import { pruneMantineCss } from './prune-mantine-css.js'

export {
    pruneMantineCss,
    pruneUnreachableRules,
    requiredHashedClasses,
    shippedHashedClasses,
} from './prune-mantine-css.js'

/** @type {import('./vite.d.ts').staticDemoConfig} */
export async function staticDemoConfig({ appDir, alias = {}, plugins = [], css }) {
    const root = path.resolve(appDir)
    const reactPlugin = await importFromApp(root, '@vitejs/plugin-react', "the static demo's React transform needs")
    const singleFile = await importFromApp(root, 'vite-plugin-singlefile', 'the single-file static demo needs')
    const react = /** @type {() => import('vite').PluginOption} */ (reactPlugin['default'])
    const viteSingleFile = /** @type {() => import('vite').PluginOption} */ (
        singleFile['viteSingleFile'] ?? /** @type {Record<string, unknown>} */ (singleFile['default'])['viteSingleFile']
    )
    return {
        root: path.join(root, 'src', 'demo-static'),
        base: './',
        // The pruning runs before vite-plugin-singlefile, the other `post` plugin, so the inlined stylesheet is the
        // pruned one (prune-mantine-css.js says why the order is load-bearing).
        plugins: [react(), ...plugins, pruneMantineCss(), viteSingleFile()],
        ...(css === undefined ? {} : { css }),
        resolve: {
            alias: {
                '@sssb/app-config': path.join(root, 'src', 'app-config'),
                '@': path.join(root, 'src'),
                ...alias,
            },
        },
        build: {
            outDir: path.join(root, 'dist-demo'),
            emptyOutDir: true,
        },
    }
}
