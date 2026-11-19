/**
 * The run mode, read once. Everything imports it from the registry (./index.ts), which re-exports it; this module
 * exists so code that must not load the registry (the request proxy, ./proxy.ts; the digest job handler,
 * ../jobs/digest-email.ts, which the registry itself loads) can ask the mode without its ports and their fakes.
 *
 * `APP_MODE` only ever tests for `'real'`, so an older `APP_MODE=fake` still resolves to `simulated`
 * and no deployed config breaks.
 */
export type AppMode = 'simulated' | 'real'
export const appMode: AppMode = process.env['APP_MODE'] === 'real' ? 'real' : 'simulated'
export const isSimulated = appMode === 'simulated'
