import type { CSSOptions, Plugin, PluginOption, UserConfig } from 'vite'

export interface StaticDemoOptions {
    /** The app's directory (`__dirname` in its vite.demo.config.ts). */
    appDir: string
    /** Aliases beside the preset's `@sssb/app-config` and `@`: a workspace package the demo reaches by source. */
    alias?: Record<string, string>
    /** Plugins of the app's own, placed after React's and before the pruning and the single-file inlining. */
    plugins?: PluginOption[]
    /** Vite's `css` options (an app with its own PostCSS pipeline points `css.postcss` at its directory). */
    css?: CSSOptions
}

/** The static demo's whole Vite config: single-file, file://-safe, pruned, with the app's seam passed explicitly. */
export declare function staticDemoConfig(options: StaticDemoOptions): Promise<UserConfig>

export interface PruneResult {
    css: string
    /** Rules removed because a hashed class they need ships nowhere. */
    removedRules: number
    /** Rules left, counting every one nested in an at-rule. */
    keptRules: number
}

/**
 * The hashed Mantine classes a selector REQUIRES: those written outside every `(...)` and `[...]`. `.m_a .m_b > i`
 * yields both; `.m_a:not(.m_b)` yields only `m_a`; `[data-x='.m_c']` yields none.
 */
export declare function requiredHashedClasses(selector: string): string[]

/** The hashed class names written in `shipped`: the JavaScript and HTML the stylesheet is shipped with. */
export declare function shippedHashedClasses(shipped: string): Set<string>

/** Removes every rule of `css` that needs a hashed class not in `shipped`. Pure; throws on CSS postcss cannot parse. */
export declare function pruneUnreachableRules(css: string, shipped: ReadonlySet<string>): PruneResult

/** The Vite plugin that prunes the demo's stylesheet against what the demo ships. `staticDemoConfig` includes it. */
export declare function pruneMantineCss(): Plugin
