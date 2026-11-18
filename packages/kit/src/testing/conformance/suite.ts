import path from 'node:path'
import { afterAll, describe, it } from 'vitest'
import registry from '../checks.json'
import { authzMutations } from './authz'
import { migrationOrder, rlsPglite } from './db'
import { demoPresets } from './demo-presets'
import { i18nParity, i18nPartition } from './i18n'
import { seamMap } from './seam-map'
import type { CheckContext, CheckImpl } from './types'

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
 * reads without loading the kit): per unit check, `describe('[sssb:<id>] <title>')` holding exactly the named `it`s,
 * never a dynamic name, so every expected full name `[sssb:<id>] <title> > <test>` is computable from the data.
 *
 * OPT-OUTS are the only way to leave a check out: `optOut: { '<id>': '<why>' }`. An unknown id or an empty reason
 * throws while the file is collected, so a typo is a red run, never a silent skip, and an opted-out check registers
 * ONE passing test `[sssb:opt-out:<id>] <why>` in its place, so `vitest list` shows the decision.
 *
 * THE SKIP GUARD: a file-level `afterAll` fails the run if any registered test (opt-outs aside) did not run. It runs
 * whenever at least one test in the file runs, so an `it.only` beside the suite, or a `-t` filter that matches part
 * of it, fails the run instead of skipping checks quietly. When EVERY test in the file is skipped no hook runs, and
 * Vitest exits 0: that half is `sssb doctor`'s, which asks `vitest list --json` whether every check would run.
 */

/** A check id, as `checks.json` names it. */
interface RegisteredCheck {
    id: string
    runner: string
    title: string
    tests: string[]
}

const CHECKS: readonly RegisteredCheck[] = registry.checks

/** The unit checks' implementations, by id. The contract checks are `@sssb/kit/testing/contract`'s. */
const IMPLEMENTATIONS: Readonly<Record<string, CheckImpl>> = {
    'authz-mutations': authzMutations,
    'i18n-partition': i18nPartition,
    'i18n-parity': i18nParity,
    'rls-pglite': rlsPglite,
    'migration-order': migrationOrder,
    'demo-presets': demoPresets,
    'seam-map': seamMap,
}

export interface ConformanceOptions {
    /** The app's directory (the one holding its `package.json` and `src/`), absolute or relative to the working directory. */
    appDir: string
    /** Checks this app leaves out, each with the reason: `{ '<check id>': '<why>' }`. */
    optOut?: Readonly<Record<string, string>>
}

/** The full name a test is listed under: `[sssb:<id>] <title> > <test>`. */
const fullName = (check: RegisteredCheck, test: string) => `${describeName(check)} > ${test}`
const describeName = (check: RegisteredCheck) => `[sssb:${check.id}] ${check.title}`

/** Registers the conformance suite in the calling test file. Call it once, at the file's top level. */
export function conformanceSuite(options: ConformanceOptions): void {
    const unit = CHECKS.filter((check) => check.runner === 'unit')
    const optOut = options.optOut ?? {}
    for (const [id, reason] of Object.entries(optOut)) {
        if (!unit.some((check) => check.id === id)) {
            throw new Error(
                `conformanceSuite: optOut names "${id}", which is not a check this suite registers ` +
                    `(${unit.map((check) => check.id).join(', ')})`,
            )
        }
        if (typeof reason !== 'string' || reason.trim() === '') {
            throw new Error(`conformanceSuite: optOut "${id}" needs a reason`)
        }
    }
    if (typeof options.appDir !== 'string' || options.appDir === '') {
        throw new Error('conformanceSuite: appDir must name the app directory')
    }
    const context: CheckContext = { appDir: path.resolve(options.appDir) }

    const expected: string[] = []
    const ran = new Set<string>()
    for (const check of unit) {
        const reason = optOut[check.id]
        if (reason !== undefined) {
            it(`[sssb:opt-out:${check.id}] ${reason}`, () => {})
            continue
        }
        const impl = IMPLEMENTATIONS[check.id]
        const names = impl ? Object.keys(impl.tests) : []
        if (!impl || names.join('\n') !== check.tests.join('\n')) {
            throw new Error(
                `conformanceSuite: the implementation of "${check.id}" does not register exactly the tests checks.json ` +
                    `names for it (${check.tests.join('; ')})`,
            )
        }
        describe(describeName(check), () => {
            impl.setup?.(context)
            for (const test of check.tests) {
                const name = fullName(check, test)
                expected.push(name)
                const body = impl.tests[test]!
                it(
                    test,
                    async () => {
                        ran.add(name)
                        await body(context)
                    },
                    impl.timeouts?.[test],
                )
            }
        })
    }

    afterAll(() => {
        const skipped = expected.filter((name) => !ran.has(name))
        if (skipped.length > 0) {
            throw new Error(
                `the SSSB conformance suite did not run ${skipped.length} of its checks, and none of them is opted out:\n  ` +
                    `${skipped.join('\n  ')}\n` +
                    'A check is left out only by naming it in conformanceSuite({ optOut: { <id>: <reason> } }); an ' +
                    '`.only`, a `.skip` or a test-name filter that drops one fails the run.',
            )
        }
    })
}
