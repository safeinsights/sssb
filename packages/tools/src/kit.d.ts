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

/**
 * Whether `file` is framework source: its nearest named package.json is `@sssb/kit`'s, wherever it sits (an installed
 * instance, a workspace link, or a copy of the framework's tree reached by a relative path).
 */
export declare function isFrameworkFile(file: string): boolean

/** Throws when `file` is framework source that is not the app's own instance; anything else passes. */
export declare function assertNoForeignFramework(appDir: string, file: string): void

/**
 * Another package the app installs, resolved from the app's directory (its own lookup chain, never NODE_PATH), so a
 * preset configures the app's copy of a tool. Throws, saying what it is missing it for, when the app has none.
 */
export declare function resolveFromApp(appDir: string, specifier: string, why: string): string

/** Loads a package the app installs (see `resolveFromApp`) and returns its module namespace. */
export declare function importFromApp(appDir: string, specifier: string, why: string): Promise<Record<string, unknown>>
