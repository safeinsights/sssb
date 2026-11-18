/**
 * Finds the `uses:` references in a workflow or composite action that are not pinned to a full commit SHA.
 * A tag or branch is repointable by whoever owns the action's repository, so a compromised maintainer
 * account swaps attacker code into a workflow on its next run; a 40-character commit SHA is not. Adapted
 * from CanopyCMS's scripts/check-action-pins.mjs, but the YAML is PARSED (the `yaml` package), never grepped:
 * a `uses:` inside a `run:` block or a comment is not a reference.
 *
 * Read: `jobs.*.steps[*].uses`, `jobs.*.uses` (a reusable workflow) and a composite action's
 * `runs.steps[*].uses`. Exempt: `./...` (it resolves inside this repository at the same commit, so there is no
 * third party). Flagged: `docker://...` (a floating image tag has the same mutability problem), a reference
 * with no `@`, and any ref that is not exactly 40 lowercase hex digits.
 */
import { parse } from 'yaml'

const FULL_SHA = /^[0-9a-f]{40}$/

function isPinned(reference: string): boolean {
    if (reference.startsWith('./')) return true
    if (reference.startsWith('docker://')) return false
    const at = reference.lastIndexOf('@')
    return at > 0 && FULL_SHA.test(reference.slice(at + 1))
}

function usesOf(steps: unknown): unknown[] {
    return Array.isArray(steps) ? steps.map((step) => (step as { uses?: unknown } | null)?.uses) : []
}

function asRecord(value: unknown): Record<string, unknown> {
    return value !== null && typeof value === 'object' && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : {}
}

/** Every `uses:` value in the YAML text that is not pinned to a full commit SHA, in document order. */
export function unpinnedActionRefs(yamlText: string): string[] {
    const document = asRecord(parse(yamlText))
    const found: unknown[] = []
    for (const job of Object.values(asRecord(document.jobs))) {
        const { uses, steps } = asRecord(job)
        found.push(uses, ...usesOf(steps))
    }
    found.push(...usesOf(asRecord(document.runs).steps))
    return found.filter((reference): reference is string => typeof reference === 'string' && !isPinned(reference))
}
