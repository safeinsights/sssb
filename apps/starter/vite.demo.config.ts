import { staticDemoConfig } from '@sssb/tools/vite'

/**
 * Builds the hash-routed static demo shell (src/demo-static) that runs from file://, as one file. The preset
 * (@sssb/tools/vite) passes this app's own seam explicitly, which is what makes the framework bundle resolve against
 * this app's registrations rather than any other app's.
 */
export default staticDemoConfig({ appDir: __dirname })
