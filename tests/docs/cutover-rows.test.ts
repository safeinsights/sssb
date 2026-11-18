import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url))

/**
 * The cutover checklist's rows as data (ADR-0014 part 3): `@sssb/kit/cutover/rows.json`, which `sssb doctor` reads to
 * report a framework row an adopter's own checklist has not recorded. The doc is where the rows are written and
 * argued; the JSON is what ships. So they are held equal here, row for row and in order: each row's id (the
 * backticked item name) and its "What it is" cell, verbatim. Only the table under "## Rows" counts: the one under
 * "The pattern" is a worked example of a row, not a row.
 */
function checklistRows(markdown: string): Array<{ id: string; what: string }> {
    const lines = markdown.split('\n')
    const start = lines.indexOf('## Rows')
    if (start < 0) throw new Error('docs/cutover-checklist.md has no "## Rows" heading')
    const end = lines.findIndex((line, i) => i > start && line.startsWith('## '))
    return lines
        .slice(start, end < 0 ? undefined : end)
        .map((line) => /^\|\s*[^|]*\|\s*`([a-z0-9][a-z0-9-]*)`\s*\|([^|]*)\|/.exec(line))
        .filter((match) => match !== null)
        .map((match) => ({ id: match[1]!, what: match[2]!.trim() }))
}

describe('@sssb/kit/cutover/rows.json', () => {
    const doc = checklistRows(readFileSync(path.join(REPO_ROOT, 'docs/cutover-checklist.md'), 'utf8'))
    const shipped = (
        JSON.parse(readFileSync(path.join(REPO_ROOT, 'packages/kit/src/cutover/rows.json'), 'utf8')) as {
            rows: Array<{ id: string; what: string }>
        }
    ).rows

    it('reads the checklist (a heading rename finds no rows)', () => {
        expect(doc.length).toBeGreaterThan(10)
    })

    it("holds exactly docs/cutover-checklist.md's rows, in order, each with its id and what it is", () => {
        expect(
            shipped,
            'packages/kit/src/cutover/rows.json has drifted from the "## Rows" table of docs/cutover-checklist.md',
        ).toEqual(doc)
    })

    it('names each row once', () => {
        const ids = shipped.map((row) => row.id)
        expect(ids.filter((id, i) => ids.indexOf(id) !== i)).toEqual([])
    })
})
