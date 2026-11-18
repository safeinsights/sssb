import { withSssb } from '@sssb/tools/next'

/**
 * This app's Next config, deliberately shorter than SSSB's reference app's: no Sentry wrapper (that is a cutover row,
 * and the adapter is inert without a DSN), no Panda/PostCSS pipeline (Mantine ships its own reset). What every SSSB
 * app needs (the framework transpiled, next-intl pointed at the framework's request config, the standalone output,
 * a hermetic `next dev`) comes from the preset, @sssb/tools/next.
 */
export default withSssb({ typedRoutes: true }, { appDir: __dirname })
