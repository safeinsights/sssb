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

export interface WorkspaceAppProjectsOptions {
    /** The workspace root, whose package.json's `sssb.apps` names the apps (else every `apps/<name>` that is a package). */
    root: string
    /** Each app's options beside its directory, given the app's absolute directory. */
    options?: (appDir: string) => Omit<AppTestProjectOptions, 'appDir'>
}

/**
 * One `appTestProject` per app of the workspace, in the order `sssb.apps` names them: the root's Vitest configs read the
 * workspace's one list of apps rather than keeping a copy. Throws when the workspace names no app.
 */
export declare function workspaceAppProjects(
    options: WorkspaceAppProjectsOptions,
): Promise<TestProjectInlineConfiguration[]>
