import { describe, expect, expectTypeOf, it } from 'vitest'
import { encodeKeysetCursor } from '../core/keyset'
import { keysetPage, parseDbKeysetCursor, type KeysetOrderColumn } from './keyset'

// Compile-time only: `tsc` (the root program covers this file) is the assertion, and nothing here
// touches a database. The SQL behaviour of `orderBy` is proven where a real engine is — the app half
// of the composed RLS suite (packages/kit/test-fixture/app-config/db/rls-proofs.ts), on pglite and Postgres.
describe('KeysetOrderColumn', () => {
    it('admits a table’s NOT NULL columns, and only those', () => {
        type DocketOrder = KeysetOrderColumn<'dockets'>
        expectTypeOf<'created_at'>().toExtend<DocketOrder>()
        expectTypeOf<'last_touched_at'>().toExtend<DocketOrder>()
        // `due_on` is nullable: a NULL key makes the row-value comparison never true, so it is refused.
        expectTypeOf<'due_on'>().not.toExtend<DocketOrder>()
        // Not a column of this table (it belongs to `jobs`).
        expectTypeOf<'result_key'>().not.toExtend<DocketOrder>()
        expectTypeOf<'no_such_column'>().not.toExtend<DocketOrder>()
    })

    it('is the type of keysetPage’s trailing, optional parameter', () => {
        expectTypeOf(keysetPage<'dockets', { id: string }>)
            .parameter(3)
            .toEqualTypeOf<KeysetOrderColumn<'dockets'> | undefined>()
    })
})

describe('parseDbKeysetCursor', () => {
    const id = '00000000-0000-4000-8000-000000000000'

    it('accepts a cursor whose instant Postgres can hold', () => {
        expect(parseDbKeysetCursor(encodeKeysetCursor({ at: '2026-01-01T00:00:00Z', id })).kind).toBe('after')
        expect(parseDbKeysetCursor(encodeKeysetCursor({ at: '0001-01-01T00:00:00Z', id })).kind).toBe('after')
    })

    it('refuses year 0000, which timestamptz has no value for (it was a 500 inside the query)', () => {
        expect(parseDbKeysetCursor(encodeKeysetCursor({ at: '0000-01-01T00:00:00Z', id }))).toEqual({ kind: 'invalid' })
    })

    it('refuses an id that is not a uuid', () => {
        expect(parseDbKeysetCursor(encodeKeysetCursor({ at: '2026-01-01T00:00:00Z', id: 'not-a-uuid' }))).toEqual({
            kind: 'invalid',
        })
    })
})
