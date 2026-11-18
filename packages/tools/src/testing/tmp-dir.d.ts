/**
 * Make a scratch directory, `<tmpdir>/<prefix>XXXXXX`, that is removed when the test file finishes. Synchronous
 * variant. Import this module before anything else in the file that registers hooks.
 */
export declare function makeTestTmpDir(prefix: string): string

/** Make a scratch directory that is removed when the test file finishes. Async variant. */
export declare function makeTestTmpDirAsync(prefix: string): Promise<string>

/**
 * Remove a directory this module made, and its marker, now rather than when the test file finishes. Does nothing for a
 * path it did not make, or has already removed.
 */
export declare function removeTestTmpDir(dir: string): void

/**
 * Register the current test file's cleanup hook, if it has none: what the setup module `@sssb/tools/testing/tmp-dir-setup`
 * does before every file. Call it at a file's top level, never from a hook or a test.
 */
export declare function registerTestTmpDirCleanup(): void
