import { describe, expect, it } from 'vitest'
import { icuSignature, parityProblems } from './i18n'

/** `i18n-parity` compares what a translation must keep: its arguments, each argument's type, and its tags. */

describe('icuSignature', () => {
    it("reads a plural or select branch's text as text, not as an argument", () => {
        expect(icuSignature('{count, plural, one {item} other {items}}')).toEqual(
            icuSignature('{count, plural, one {elemento} other {elementos}}'),
        )
        expect(icuSignature('{role, select, admin {Administrator} other {Member}}')).toEqual(['role:select'])
        expect(icuSignature('{n, plural, =0 {No tickets} other {# tickets}}')).toEqual(['n:plural'])
    })

    it('reads an argument nested inside a branch, a type, and a tag', () => {
        expect(icuSignature('{n, plural, one {{name} has one} other {{name} has #}}')).toEqual([
            'n:plural',
            'name:argument',
        ])
        expect(icuSignature('{n, number} on {d, date, short}')).toEqual(['d:date', 'n:number'])
        expect(icuSignature('Read <b>this</b>')).toEqual(['<b>'])
    })

    it('does not count a quoted literal as an argument', () => {
        expect(icuSignature("Type '{name}' here")).toEqual([])
    })
})

describe('parityProblems', () => {
    const check = (en: string, es: string) => parityProblems({ m: en }, { m: es })

    it('passes a correct translation of a plural and of a select', () => {
        expect(
            check('{count, plural, one {item} other {items}}', '{count, plural, one {elemento} other {elementos}}'),
        ).toEqual([])
        expect(
            check(
                '{role, select, admin {Administrator} other {Member}}',
                '{role, select, admin {Administrador} other {Miembro}}',
            ),
        ).toEqual([])
    })

    it('fails a renamed argument, one dropped from its branches, a changed type and a dropped tag', () => {
        expect(check('Hi {name}', 'Hola {nombre}')).not.toEqual([])
        expect(
            check('{n, plural, one {{name}: one} other {{name}: #}}', '{n, plural, one {uno} other {#}}'),
        ).not.toEqual([])
        expect(check('{n, number}', '{n, date}')).not.toEqual([])
        expect(check('Read <b>this</b>', 'Lee esto')).not.toEqual([])
    })

    it('fails a message that does not parse, and a key on one side only', () => {
        expect(check('Hi {name}', 'Hola {name')).not.toEqual([])
        expect(parityProblems({ a: 'x' }, { b: 'x' })).not.toEqual([])
    })
})
