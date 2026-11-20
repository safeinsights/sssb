import { existsSync, realpathSync } from 'node:fs'
import path from 'node:path'
import { expect } from 'vitest'
import { realAuthProvider } from './auth-provider'
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
    'real-auth-provider': realAuthProvider,
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

/** The nearest directory at or above `file` that holds a package.json, or null. */
function packageDirOf(file: string): string | null {
    for (let dir = path.dirname(file); ; dir = path.dirname(dir)) {
        if (existsSync(path.join(dir, 'package.json'))) return dir
        if (path.dirname(dir) === dir) return null
    }
}

const realOrNull = (dir: string) => {
    try {
        // The native call: on a case-insensitive file system it answers the name as stored, where the JS one keeps
        // the caller's casing, so `/apps/Starter` and `/apps/starter` would compare unequal.
        return realpathSync.native(dir)
    } catch {
        return null
    }
}

/**
 * Why `appDir` is not the app whose suite file `testPath` is, or null when it is. The app is the nearest directory at
 * or above the test file that holds a package.json; both sides are compared by native real path, so `..`, symbolic
 * links and (on a case-insensitive file system) letter case do not matter. A suite file in one app pointed at another would otherwise run every file-reading check over the
 * other app's files and pass.
 */
export function appDirMismatch(appDir: string, testPath: string): string | null {
    const own = packageDirOf(realOrNull(testPath) ?? testPath)
    const given = realOrNull(path.resolve(appDir))
    const ownReal = own === null ? null : realOrNull(own)
    if (given !== null && ownReal !== null && given === ownReal) return null
    return (
        `conformanceSuite: appDir is ${path.resolve(appDir)}, but the suite file ${testPath} belongs to ` +
        `${own ?? 'no package (no package.json above it)'}; appDir must be the directory of the app that runs it`
    )
}

/** Registers the conformance suite in the calling test file. Call it once, at the file's top level. */
export function conformanceSuite(options: ConformanceOptions): void {
    // Only the two published options are read: anything else an app passes is ignored, so nothing it writes can turn
    // the appDir check below off.
    registerConformanceSuite({ appDir: options.appDir, ...(options.optOut ? { optOut: options.optOut } : {}) })
}

/**
 * SSSB's own entry, not a published subpath (`@sssb/kit/testing` exports `conformanceSuite` only): the suite with
 * `appDirOutsideCaller`, the reason `appDir` is not the calling test file's package. The kit runs the suite against
 * its fixture, `packages/kit/test-fixture`, from a test file in `packages/kit`; an app never has a reason to.
 */
export function registerConformanceSuite(options: ConformanceOptions & { appDirOutsideCaller?: string }): void {
    const optOut = options.optOut ?? {}
    checkOptOut('conformanceSuite', 'unit', optOut)
    if (typeof options.appDir !== 'string' || options.appDir === '') {
        throw new Error('conformanceSuite: appDir must name the app directory')
    }
    // Refused while the file is collected, before anything is registered.
    const outside = options.appDirOutsideCaller
    if (outside !== undefined) {
        if (typeof outside !== 'string' || !outside.trim()) {
            throw new Error('conformanceSuite: appDirOutsideCaller needs a reason')
        }
    } else {
        const testPath = expect.getState().testPath
        if (!testPath) throw new Error('conformanceSuite: call it at the top level of a Vitest test file')
        const mismatch = appDirMismatch(options.appDir, testPath)
        if (mismatch) throw new Error(mismatch)
    }
    // Before the checks, so the scratch directories' cleanup is this file's own, at its top level, and runs after the
    // checks' teardown, even under `isolate: false`, where the helper loads once per worker (../tmp-dir.ts).
    registerTestTmpDirCleanup()
    const context: CheckContext = { appDir: path.resolve(options.appDir) }
    registerChecks({ caller: 'conformanceSuite', runner: 'unit', implementations: IMPLEMENTATIONS, optOut, context })
}
