/** What every unit check is handed: the app it is checking. */
export interface CheckContext {
    /** The app's directory: the one holding its `package.json`, `src/app`, `src/app-config` and `messages/`. */
    appDir: string
}

/**
 * One check's implementation: a body per test, under exactly the names `checks.json` gives it (the suite refuses to
 * register a check whose names differ), and an optional `setup` the suite runs while the file is collected, inside
 * the check's `describe`, before any test of the file runs. `C` is what the runner hands each test: the unit suite's
 * `CheckContext`, or the contract runner's server.
 */
export interface CheckImpl<C = CheckContext> {
    setup?: (context: C) => void
    /** Per-test timeouts, by test name, for the ones that migrate a database. */
    timeouts?: Readonly<Record<string, number>>
    tests: Readonly<Record<string, (context: C) => unknown>>
}
