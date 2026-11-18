/**
 * Every third-party action this repository runs is pinned to a full commit SHA, and this keeps it so. Today
 * each one already is, so the gate fixes nothing; it stops a job merged in from a sibling branch (or a
 * Dependabot bump to a tag) from arriving mutable with nothing noticing. Borrowed from CanopyCMS's
 * scripts/check-action-pins.mjs; the finder is tests/support/action-pins.ts.
 *
 * The mutation cases below show the finder failing on each way a reference can be unpinned, so the real-file
 * check is not a gate that has only ever passed.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { unpinnedActionRefs } from '../support/action-pins'

const GITHUB = fileURLToPath(new URL('../../.github/', import.meta.url))
const SHA = '3d3c42e5aac5ba805825da76410c181273ba90b1'

function yamlFilesIn(dir: string, name: RegExp): string[] {
    if (!existsSync(dir)) return []
    return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
        const full = path.join(dir, entry.name)
        if (entry.isDirectory()) return yamlFilesIn(full, name)
        return name.test(entry.name) ? [full] : []
    })
}

const workflows = yamlFilesIn(path.join(GITHUB, 'workflows'), /\.ya?ml$/)
const compositeActions = yamlFilesIn(path.join(GITHUB, 'actions'), /^action\.ya?ml$/)

describe('every action reference in .github is pinned to a full commit SHA', () => {
    it('finds the workflows it is meant to read', () => {
        // An empty list would make the loop below vacuous.
        expect(workflows.length).toBeGreaterThan(0)
    })

    it.each([...workflows, ...compositeActions].map((file) => [path.relative(GITHUB, file), file]))(
        '%s has no unpinned `uses:`',
        (_name, file) => {
            expect(unpinnedActionRefs(readFileSync(file, 'utf8'))).toEqual([])
        },
    )
})

describe('unpinnedActionRefs (mutations: each unpinned form is caught)', () => {
    const inJob = (uses: string) =>
        `jobs:\n    x:\n        runs-on: ubuntu-latest\n        steps:\n            - uses: ${uses}\n`

    it.each([
        ['a version tag', 'actions/checkout@v4'],
        ['a branch', 'actions/checkout@main'],
        ['no version at all', 'actions/checkout'],
        ['a docker image tag', 'docker://alpine:3'],
        ['a docker image even with a 40-hex @ref (docker refs are never accepted)', `docker://x@${SHA}`],
        ['a dot-prefixed path that is not ./ (only a local ./ ref is exempt)', '.github/actions/x@v1'],
        ['a 39-hex ref', `actions/checkout@${SHA.slice(1)}`],
        ['an uppercase-hex ref', `actions/checkout@${SHA.toUpperCase()}`],
        ['a 41-hex ref', `actions/checkout@${SHA}0`],
        ['a short SHA', `actions/checkout@${SHA.slice(0, 7)}`],
    ])('flags %s', (_name, uses) => {
        expect(unpinnedActionRefs(inJob(uses))).toEqual([uses])
    })

    it('passes a 40-hex SHA with a trailing version comment', () => {
        expect(unpinnedActionRefs(inJob(`actions/checkout@${SHA} # v1`))).toEqual([])
    })

    it('passes a local action', () => {
        expect(unpinnedActionRefs(inJob('./.github/actions/x'))).toEqual([])
    })

    it('flags an unpinned reusable workflow called from a job', () => {
        const text = `jobs:\n    x:\n        uses: org/repo/.github/workflows/w.yml@main\n`
        expect(unpinnedActionRefs(text)).toEqual(['org/repo/.github/workflows/w.yml@main'])
    })

    it('passes a pinned reusable workflow', () => {
        const text = `jobs:\n    x:\n        uses: org/repo/.github/workflows/w.yml@${SHA}\n`
        expect(unpinnedActionRefs(text)).toEqual([])
    })

    it("flags an unpinned step in a composite action's `runs.steps`", () => {
        const text = `name: x\nruns:\n    using: composite\n    steps:\n        - uses: actions/cache@v4\n        - uses: actions/cache@${SHA}\n`
        expect(unpinnedActionRefs(text)).toEqual(['actions/cache@v4'])
    })

    it('reads parsed YAML, not text: a `uses:` in a run block or a comment is not a reference', () => {
        const text = `jobs:\n    x:\n        steps:\n            # uses: actions/checkout@v4\n            - run: |\n                  echo "uses: actions/checkout@v4"\n`
        expect(unpinnedActionRefs(text)).toEqual([])
    })

    it('a line INSIDE a run block that starts with `uses:` is not a reference (a line-grep would flag it)', () => {
        const text = `jobs:\n    x:\n        steps:\n            - run: |\n                  echo hi\n                  uses: x@v1\n                  - uses: y@v1\n`
        expect(unpinnedActionRefs(text)).toEqual([])
    })

    it('reports every unpinned reference, in order, across jobs', () => {
        const text = `jobs:\n    a:\n        steps:\n            - uses: one/a@v1\n    b:\n        steps:\n            - uses: two/b@${SHA}\n            - uses: three/c@v2\n`
        expect(unpinnedActionRefs(text)).toEqual(['one/a@v1', 'three/c@v2'])
    })
})
