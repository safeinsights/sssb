import path from 'node:path'
import { authzMutations } from './authz'
import { appRolesCheck, migrationOrder, rlsPglite } from './db'
import { demoPresets } from './demo-presets'
import { i18nParity, i18nPartition } from './i18n'
import { checkOptOut, registerChecks } from './register'
import { seamMap } from './seam-map'
import type { CheckContext, CheckImpl } from './types'
import { registerTestTmpDirCleanup } from '../tmp-dir'

/**
 * THE CONFORMANCE SUITE (ADR-0014 part 3, step P5): the framework's checks that must hold for EVERY app, run
 * against the app's own seam from the app's own tree. Each app carries `src/sssb.conformance.test.ts`, which calls
 *
 *     conformanceSuite({ appDir: path.resolve(import.meta.dirname, '..'), optOut: {} })
 *
 * and nothing else. A file in the app's tree is what makes it run by default: an `include` of a file under
 * `node_modules` never runs (Vitest's default `exclude` drops it, and an app extending that exclude drops it again).
 *
 * WHAT IT REGISTERS is fixed by `../checks.json` (exported as `@sssb/kit/testing/checks.json`, which `sssb doctor`
 * reads without loading the kit): its `unit` checks, each a `describe('[sssb:<id>] <title>')` holding exactly the
 * named `it`s. The registration, the opt-outs (`optOut: { '<id>': '<why>' }`, refused while the file is collected
 * when the id is unknown or the reason empty, and listed as `[sssb:opt-out:<id>] <why>`) and the skip guard (the run
 * fails if a check that is not opted out did not run) are ./register.ts's, which the contract runner
 * (`@sssb/kit/testing/contract`) shares.
 */

/** The unit checks' implementations, by id. The contract checks are `@sssb/kit/testing/contract`'s. */
const IMPLEMENTATIONS: Readonly<Record<string, CheckImpl>> = {
    'authz-mutations': authzMutations,
    'i18n-partition': i18nPartition,
    'i18n-parity': i18nParity,
    'rls-pglite': rlsPglite,
    'migration-order': migrationOrder,
    'app-roles': appRolesCheck,
    'demo-presets': demoPresets,
    'seam-map': seamMap,
}

export interface ConformanceOptions {
    /** The app's directory (the one holding its `package.json` and `src/`), absolute or relative to the working directory. */
    appDir: string
    /** Checks this app leaves out, each with the reason: `{ '<check id>': '<why>' }`. */
    optOut?: Readonly<Record<string, string>>
}

/** Registers the conformance suite in the calling test file. Call it once, at the file's top level. */
export function conformanceSuite(options: ConformanceOptions): void {
    // First, so the scratch directories' cleanup is this file's own, at its top level, and runs after the checks'
    // teardown, even under `isolate: false`, where the helper loads once per worker (../tmp-dir.ts).
    registerTestTmpDirCleanup()
    const optOut = options.optOut ?? {}
    checkOptOut('conformanceSuite', 'unit', optOut)
    if (typeof options.appDir !== 'string' || options.appDir === '') {
        throw new Error('conformanceSuite: appDir must name the app directory')
    }
    const context: CheckContext = { appDir: path.resolve(options.appDir) }
    registerChecks({ caller: 'conformanceSuite', runner: 'unit', implementations: IMPLEMENTATIONS, optOut, context })
}
