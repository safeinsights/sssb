import { withSentryConfig } from '@sentry/nextjs/config'
import { withSssb } from '@sssb/tools/next'
import { params } from './config/params'

// What every SSSB app needs (the framework transpiled, next-intl pointed at the framework's request config, the
// standalone output, the native server packages external, a hermetic `next dev`) comes from the preset.
const nextConfig = withSssb({
    typedRoutes: true,
    transpilePackages: ['@app/seed'],
})

// Sentry wraps the build ONLY when a DSN exists (cutover row `errors`) — hermetic builds make
// zero network calls and skip sourcemap upload entirely.
export default process.env.NEXT_PUBLIC_SENTRY_DSN
    ? withSentryConfig(nextConfig, {
          org: params.sentry.org,
          project: params.sentry.project,
          silent: true,
      })
    : nextConfig
