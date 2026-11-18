import type { ESLint, Linter, Rule } from 'eslint'

export interface AppConfigOptions {
    /**
     * The app's directory, as an absolute path: `import.meta.dirname` from the app's own `eslint.config.mjs`, or
     * `join(import.meta.dirname, 'apps/<app>')` from a workspace root. A last segment of `*` means every app in
     * that directory.
     */
    root: string
}

export interface SssbPlugin extends ESLint.Plugin {
    meta: { name: string; version: string; namespace: 'sssb' }
    rules: Record<string, Rule.RuleModule>
    configs: {
        /** The base config and every app-side fence, each block anchored at `root` (`basePath`). */
        app(options: AppConfigOptions): Promise<Linter.Config[]>
    }
}

declare const plugin: SssbPlugin
export default plugin
