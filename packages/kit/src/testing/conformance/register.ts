import { aroundAll, describe, it, type RunnerTask } from 'vitest'
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
 * THE SKIP GUARD fails the run if any registered test (opt-outs aside) did not run. It is a file-level `aroundAll`
 * that checks once the file's whole run, its `afterAll` hooks included, has returned: an `afterAll` would be one of
 * the file's own, which Vitest runs in turn and abandons at the first that throws, so a guard that fired there could
 * leave the contract server running and the file's scratch directories on disk, under every `sequence.hooks` order.
 * It runs whenever at least one test in the file runs, so an `it.only` beside the suite, or a `-t` filter that
 * matches part of it, fails the run instead of skipping checks quietly. Its message names the cause it can tell: a
 * check skipped because a setup hook failed (a `beforeAll` of the file or of the check, a `beforeEach`) is reported as
 * that; one that was still to run when the file started and was stopped during it (`--bail`, an interrupted run) as a
 * cancelled run; only the rest, skipped before the file ran, as a filter, an `.only` or a `.skip`. Each check's
 * tests run in order (`describe.sequential`), under `sequence.concurrent` too. When EVERY test in the
 * file is skipped no hook runs, and Vitest exits 0: that half is `sssb doctor`'s, which asks `vitest list --json`
 * whether every check would run.
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
        // SEQUENTIAL whatever the adopter's config says: under `sequence.concurrent` two of a check's tests would run
        // at once, and Vitest's mocker hands an import made while a `vi.doMock` factory is still running the REAL
        // module (demo-presets' registry mock), besides the checks' shared state (the data root, the fake world).
        // `describe.sequential` changes no name, so `sssb doctor` reads the same list.
        describe.sequential(describeName, () => {
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

    // eslint-disable-next-line no-empty-pattern -- Vitest reads this parameter as the hook's fixtures and refuses anything but a destructuring pattern; the guard uses none, only the file (the third)
    aroundAll(async (runSuite, {}, file) => {
        // Which tests were still to run once the file was collected: a filter, an `.only` or a `.skip` has already
        // marked the rest skipped by now, so a test that was to run and did not was stopped DURING the run.
        const toRun = new Set<string>()
        visitTests(file, (name, test) => {
            if (test.mode === 'run') toRun.add(name)
        })
        await runSuite()
        const skipped = expected.filter((name) => !ran.has(name))
        if (skipped.length === 0) return
        const underFailedHook = testsUnderAFailedSetup(file)
        const blocked = skipped.filter((name) => underFailedHook.has(name))
        const cancelled = skipped.filter((name) => !underFailedHook.has(name) && toRun.has(name))
        const dropped = skipped.filter((name) => !underFailedHook.has(name) && !toRun.has(name))
        const suite = runner === 'unit' ? 'conformance suite' : 'contract suite'
        const parts: string[] = []
        if (blocked.length > 0) {
            parts.push(
                `the SSSB ${suite} did not run ${blocked.length} of its checks because a hook failed (its error is ` +
                    `reported above; fix that and they run):\n  ${blocked.join('\n  ')}`,
            )
        }
        if (cancelled.length > 0) {
            parts.push(
                `the SSSB ${suite} did not run ${cancelled.length} of its checks because the run was cancelled ` +
                    'while this file ran (`--bail` stops the run after a failure, reported above; an interrupted run, or a ' +
                    `hook that called \`skip()\`, does the same):\n  ${cancelled.join('\n  ')}`,
            )
        }
        if (dropped.length > 0) {
            parts.push(
                `the SSSB ${suite} did not run ${dropped.length} of its checks, and none of them is opted out:\n  ` +
                    `${dropped.join('\n  ')}\nA check is left out only by naming it in ${caller}({ optOut: { <id>: ` +
                    '<reason> } }); an `.only`, a `.skip` or a test-name filter that drops one fails the run.',
            )
        }
        throw new Error(parts.join('\n'))
    })
}

/** Calls `visit` on every test under `file`, named `<describe> > <test>` as `expected` names them. */
function visitTests(file: RunnerTask, visit: (name: string, test: RunnerTask) => void): void {
    const walk = (task: RunnerTask, parent: string | undefined) => {
        if (task.type === 'suite') {
            for (const child of task.tasks) walk(child, task === file ? undefined : task.name)
        } else if (parent !== undefined) {
            visit(`${parent} > ${task.name}`, task)
        }
    }
    walk(file, undefined)
}

/** True when a test under `task` (itself, if it is one) began: it has a pass or fail result of its own. */
function anyTestStarted(task: RunnerTask): boolean {
    if (task.type === 'suite') return task.tasks.some(anyTestStarted)
    return task.result?.state === 'pass' || task.result?.state === 'fail'
}

/**
 * The tests (`<describe> > <test>`, as `expected` names them) that a SETUP hook which failed kept from running: one
 * whose own result carries an error (its `beforeEach` threw), or one under a suite whose result carries an error
 * while no test under that suite began (its `beforeAll` threw, which skips every test below it). An error on a suite
 * where tests did begin came after them (an `afterAll`), and it skipped nothing.
 */
function testsUnderAFailedSetup(file: RunnerTask): Set<string> {
    const names = new Set<string>()
    const visit = (task: RunnerTask, failed: boolean, parent: string | undefined) => {
        const errored = (task.result?.errors?.length ?? 0) > 0
        if (task.type === 'suite') {
            const here = failed || (errored && !anyTestStarted(task))
            for (const child of task.tasks) visit(child, here, task === file ? undefined : task.name)
        } else if ((failed || errored) && parent !== undefined) {
            names.add(`${parent} > ${task.name}`)
        }
    }
    visit(file, false, undefined)
    return names
}
