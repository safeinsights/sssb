import type { ESLint } from 'eslint'

export interface CheckFencesOptions {
    /** The app's directory. */
    appDir: string
    /** The ESLint class to probe with; by default, the `eslint` the app's directory resolves. */
    ESLint?: typeof ESLint
}

export interface CheckFencesResult {
    /** One line per fence the app's composed config has lost; empty when every fence holds. */
    problems: string[]
    /** How many of the app's source files had their effective config compared with the preset's. */
    files: number
    /** How many virtual files were linted: the fence probes, and two per lint-exceptions.mjs entry. */
    probes: number
}

/** Probe an app's composed lint config against `configs.app({ root: appDir })`. */
export function checkFences(options: CheckFencesOptions): Promise<CheckFencesResult>
