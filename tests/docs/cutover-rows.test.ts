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
            rows: Array<{ id: string; what: string; scope?: 'sssb' }>
        }
    ).rows

    it('reads the checklist (a heading rename finds no rows)', () => {
        expect(doc.length).toBeGreaterThan(10)
    })

    it("holds exactly docs/cutover-checklist.md's rows, in order, each with its id and what it is", () => {
        expect(
            shipped,
            'packages/kit/src/cutover/rows.json has drifted from the "## Rows" table of docs/cutover-checklist.md',
        ).toEqual(doc.map((row) => expect.objectContaining(row)))
        expect(shipped.map((row) => Object.keys(row).sort())).toEqual(
            shipped.map((row) => (row.scope === undefined ? ['id', 'what'] : ['id', 'scope', 'what'])),
        )
    })

    it("marks `scope: 'sssb'` exactly the rows the checklist calls SSSB's own (sssb doctor does not look for them)", () => {
        // The field is what doctor reads; the checklist's wording is what a reader sees. Held together here, so
        // neither can say a row is an adopter's while the other says it is not.
        const ownBySentence = doc.filter((row) => /^SSSB's own repository only\b/.test(row.what)).map((row) => row.id)
        expect(shipped.filter((row) => row.scope === 'sssb').map((row) => row.id)).toEqual(ownBySentence)
        expect(shipped.every((row) => row.scope === undefined || row.scope === 'sssb')).toBe(true)
        expect(ownBySentence.length).toBeGreaterThan(0)
    })

    it('names each row once', () => {
        const ids = shipped.map((row) => row.id)
        expect(ids.filter((id, i) => ids.indexOf(id) !== i)).toEqual([])
    })
})
