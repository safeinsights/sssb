import path from 'node:path'
import { staticDemoConfig } from '@sssb/tools/vite'

/**
 * Builds the hash-routed static demo shell (src/demo-static) that runs from file://, as one file (the preset,
 * @sssb/tools/vite, says why). The showcase adds its PostCSS pipeline (Panda) and its seed package, which the demo
 * reaches by source.
 */
export default staticDemoConfig({
    appDir: __dirname,
    css: { postcss: __dirname },
    alias: { '@app/seed': path.resolve(__dirname, '../../packages/seed/src/index.ts') },
})
