// THE SHARED RESOLVER of ADR-0014's rule 4, for any SSSB package that must reach the framework from an app (the
// CLI, the presets, @sssb/cdk's construct). Each throws an Error whose message names the app when it cannot answer.

/**
 * The real directory of the `@sssb/kit` an app resolves: the first `node_modules/@sssb/kit` walking up from the app's
 * directory, as Node's lookup finds it, never through NODE_PATH (which pnpm points at the hoisted store).
 */
export declare function kitDirOf(appDir: string): string

/** The version in the package.json of the `@sssb/kit` an app resolves (`kitDirOf`). */
export declare function kitVersionOf(appDir: string): string

/**
 * The shared real-path check: `file` must be part of the `@sssb/kit` that `appDir` resolves. Throws for anything
 * else (the hoisted copy, another app's instance, a framework source tree reached by a path). Returns the file's real
 * path.
 */
export declare function assertAppsKitFile(appDir: string, file: string): string

/**
 * A published subpath of `@sssb/kit` (`i18n/request`, `adapters/real/migrate-handler`), resolved from the app's
 * directory through the framework's `exports` map and checked with `assertAppsKitFile`. Returns the real path. Throws
 * when the app has no framework, or when the framework does not publish the subpath.
 */
export declare function resolveAppsKit(appDir: string, subpath: string): string
