/**
 * The run mode, read once. Everything imports it from the registry (./index.ts), which re-exports it; this module
 * exists so the request proxy (./proxy.ts) can ask the mode without loading the registry, its ports and their fakes.
 *
 * `APP_MODE` only ever tests for `'real'`, so an older `APP_MODE=fake` still resolves to `simulated`
 * and no deployed config breaks.
 */
export type AppMode = 'simulated' | 'real'
export const appMode: AppMode = process.env['APP_MODE'] === 'real' ? 'real' : 'simulated'
export const isSimulated = appMode === 'simulated'
