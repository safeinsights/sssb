import type { FullResult, Reporter, TestCase, TestResult, TestStep } from '@playwright/test/reporter'

/**
 * TEMPORARY MEASUREMENT (safeinsights/sssb#235): prints each test's wall clock and its slowest waits, one
 * `e2e-timing` line each, so CI's log carries the numbers the suite's timeouts are derived from. Removed
 * by the commit that sets them.
 */
interface Wait {
    title: string
    category: string
    ms: number
    line: number | undefined
}

export default class TimingReporter implements Reporter {
    readonly #waits = new Map<string, Wait[]>()

    onStepEnd(test: TestCase, _result: TestResult, step: TestStep): void {
        if (step.category !== 'expect' && step.category !== 'pw:api') return
        const waits = this.#waits.get(test.id) ?? []
        waits.push({ title: step.title, category: step.category, ms: step.duration, line: step.location?.line })
        this.#waits.set(test.id, waits)
    }

    onTestEnd(test: TestCase, result: TestResult): void {
        const file = test.location.file.split('/tests/e2e/')[1] ?? test.location.file
        const project = test.parent.project()?.name ?? '?'
        console.log(
            `e2e-timing test ${project} ${file} :: ${test.title} :: ${result.status} retry=${result.retry} ${result.duration}ms timeout=${test.timeout}ms`,
        )
        const slowest = (this.#waits.get(test.id) ?? [])
            .sort((a, b) => b.ms - a.ms)
            .filter((wait, i) => i < 4 || wait.ms >= 1000)
        for (const wait of slowest) {
            console.log(
                `e2e-timing wait ${project} ${file}:${wait.line ?? '?'} :: ${wait.category} ${wait.title.slice(0, 90)} ${wait.ms}ms`,
            )
        }
        this.#waits.delete(test.id)
    }

    onEnd(result: FullResult): void {
        console.log(`e2e-timing end ${result.status} ${Math.round(result.duration)}ms`)
    }

    printsToStdio(): boolean {
        return false
    }
}
