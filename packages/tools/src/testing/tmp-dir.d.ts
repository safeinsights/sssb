/**
 * Make a scratch directory, `<tmpdir>/<prefix>XXXXXX`, that is removed when the test file finishes. Synchronous
 * variant. Import this module before anything else in the file that registers hooks.
 */
export declare function makeTestTmpDir(prefix: string): string

/** Make a scratch directory that is removed when the test file finishes. Async variant. */
export declare function makeTestTmpDirAsync(prefix: string): Promise<string>

/** Remove a directory this module made, and its marker, now rather than when the test file finishes. */
export declare function removeTestTmpDir(dir: string): void
