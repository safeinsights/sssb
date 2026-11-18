import { afterAll, describe, it } from 'vitest'
import registry from '../checks.json'
import type { CheckImpl } from './types'

/**
 * THE REGISTRATION BOTH RUNNERS SHARE: the unit suite (`conformanceSuite`, ./suite.ts) and the contract runner
 * (`contractSuite`, ../contract.ts) register their checks, opt-outs and skip guard here, so the two cannot differ in
 * what `sssb doctor` reads back from `vitest list --json`.
 *
 * WHAT IT REGISTERS is fixed by `../checks.json` (exported as `@sssb/kit/testing/checks.json`): per check of the
 * runner, `describe('[sssb:<id>] <title>')` holding exactly the named `it`s, never a dynamic name, so every expected
 * full name `[sssb:<id>] <title> > <test>` is computable from the data.
 *
 * OPT-OUTS are the only way to leave a check out: `optOut: { '<id>': '<why>' }`. An unknown id (another runner's
 * included) or an empty reason throws while the file is collected, so a typo is a red run, never a silent skip, and
 * an opted-out check registers ONE passing test `[sssb:opt-out:<id>] <why>` in its place, so `vitest list` shows the
 * decision.
 *
 * THE SKIP GUARD: a file-level `afterAll` fails the run if any registered test (opt-outs aside) did not run. It runs
 * whenever at least one test in the file runs, so an `it.only` beside the suite, or a `-t` filter that matches part
 * of it, fails the run instead of skipping checks quietly. When EVERY test in the file is skipped no hook runs, and
 * Vitest exits 0: that half is `sssb doctor`'s, which asks `vitest list --json` whether every check would run.
 */

/** A check, as `checks.json` names it. */
interface RegisteredCheck {
    id: string
    runner: string
    title: string
    tests: string[]
}

export type Runner = 'unit' | 'contract'

const CHECKS: readonly RegisteredCheck[] = registry.checks

/** The checks one runner registers, in `checks.json`'s order (which is the order they run in). */
const checksOf = (runner: Runner): readonly RegisteredCheck[] => CHECKS.filter((check) => check.runner === runner)

/**
 * Refuses, while the file is collected, an opt-out that names no check of this runner or gives no reason.
 * `caller` names the function in the message (`conformanceSuite`, `contractSuite`).
 */
export function checkOptOut(caller: string, runner: Runner, optOut: Readonly<Record<string, string>>): void {
    const checks = checksOf(runner)
    for (const [id, reason] of Object.entries(optOut)) {
        if (!checks.some((check) => check.id === id)) {
            throw new Error(
                `${caller}: optOut names "${id}", which is not a check this suite registers ` +
                    `(${checks.map((check) => check.id).join(', ')})`,
            )
        }
        if (typeof reason !== 'string' || reason.trim() === '') {
            throw new Error(`${caller}: optOut "${id}" needs a reason`)
        }
    }
}

/** True when this runner has at least one check `optOut` leaves in: the ones that need setting up. */
export const runsAny = (runner: Runner, optOut: Readonly<Record<string, string>>): boolean =>
    checksOf(runner).some((check) => optOut[check.id] === undefined)

/**
 * Registers one runner's checks in the calling test file, with its opt-outs and the skip guard. Call it once, at the
 * file's top level, after `checkOptOut`.
 */
export function registerChecks<C>(options: {
    caller: string
    runner: Runner
    implementations: Readonly<Record<string, CheckImpl<C>>>
    optOut: Readonly<Record<string, string>>
    context: C
}): void {
    const { caller, runner, implementations, optOut, context } = options
    const expected: string[] = []
    const ran = new Set<string>()
    for (const check of checksOf(runner)) {
        const reason = optOut[check.id]
        if (reason !== undefined) {
            it(`[sssb:opt-out:${check.id}] ${reason}`, () => {})
            continue
        }
        const impl = implementations[check.id]
        const names = impl ? Object.keys(impl.tests) : []
        if (!impl || names.join('\n') !== check.tests.join('\n')) {
            throw new Error(
                `${caller}: the implementation of "${check.id}" does not register exactly the tests checks.json ` +
                    `names for it (${check.tests.join('; ')})`,
            )
        }
        const describeName = `[sssb:${check.id}] ${check.title}`
        describe(describeName, () => {
            impl.setup?.(context)
            for (const test of check.tests) {
                const name = `${describeName} > ${test}`
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
                `the SSSB ${runner === 'unit' ? 'conformance suite' : 'contract suite'} did not run ${skipped.length} of ` +
                    `its checks, and none of them is opted out:\n  ${skipped.join('\n  ')}\n` +
                    `A check is left out only by naming it in ${caller}({ optOut: { <id>: <reason> } }); an ` +
                    '`.only`, a `.skip` or a test-name filter that drops one fails the run.',
            )
        }
    })
}
