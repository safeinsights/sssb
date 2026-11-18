import type { NextConfig } from 'next'

export interface SssbNextOptions {
    /**
     * The app's directory (`__dirname` in its next.config.ts). Defaults to the working directory, which is the app's
     * when Next loads the config, but not when another tool does, so pass it.
     */
    appDir?: string
}

/**
 * The app's Next config with what every SSSB app needs: the framework transpiled, next-intl pointed at the
 * framework's request config (resolved from the app), the standalone output, the native server packages external,
 * and `next dev` kept hermetic. The app's own settings win where they overlap, and its lists are extended.
 */
export declare function withSssb(nextConfig?: NextConfig, options?: SssbNextOptions): NextConfig
