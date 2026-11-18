import type { TestProjectInlineConfiguration } from 'vitest/config'

export interface AppTestProjectOptions {
    /** The app's directory, absolute or relative to the working directory. */
    appDir: string
    /** The project's name. Defaults to the app directory's name. */
    name?: string
    /** Test globs beside `src/**\/*.test.{ts,tsx}`, relative to the app. */
    include?: string[]
    /** Aliases beside the preset's `@sssb/app-config` and `@`. */
    alias?: Record<string, string>
    /** Environment variables for the project's tests. */
    env?: Record<string, string>
    /** Setup files run after jest-dom's matchers are installed. */
    setupFiles?: string[]
    /** Per-test timeout; defaults to 20s (the first test cold-migrates pglite). */
    testTimeout?: number
}

/** One app's Vitest project: rooted at the app, happy-dom, jest-dom, and the app's seam passed explicitly. */
export declare function appTestProject(options: AppTestProjectOptions): Promise<TestProjectInlineConfiguration>
