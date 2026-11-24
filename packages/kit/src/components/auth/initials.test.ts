import { describe, expect, it } from 'vitest'
import { avatarInitials } from './initials'

describe('avatarInitials', () => {
    it('takes the first and last words that start with a letter, skipping a parenthesised middle word', () => {
        expect(avatarInitials('Ana (Bea) Cruz')).toBe('AC')
        expect(avatarInitials('Ana Bea Cruz')).toBe('AC')
        expect(avatarInitials('Ana Cruz (Jr)')).toBe('AC')
        expect(avatarInitials('(Dr) Ana Cruz')).toBe('AC')
    })

    it('gives one letter for one word', () => {
        expect(avatarInitials('Ana')).toBe('A')
        expect(avatarInitials('(Ana) Cruz-')).toBe('C')
    })

    it('falls back to the first letter of the email when no word starts with a letter', () => {
        expect(avatarInitials('(  ) 42 -', 'dana@example.test')).toBe('D')
        expect(avatarInitials('', 'dana@example.test')).toBe('D')
        expect(avatarInitials('(1) 2', '9lives@example.test')).toBe('9')
    })

    it('is empty with no letter-word and no usable fallback', () => {
        expect(avatarInitials('(1) 2')).toBe('')
        expect(avatarInitials('', '  ...')).toBe('')
    })

    it('ignores leading, trailing and repeated spaces', () => {
        expect(avatarInitials('   Ana \t Cruz  ')).toBe('AC')
        expect(avatarInitials('  Ana  ')).toBe('A')
    })

    it('handles letters outside Latin', () => {
        expect(avatarInitials('Юлия Петрова')).toBe('ЮП')
        expect(avatarInitials('山田 太郎')).toBe('山太')
        expect(avatarInitials('Éloïse Ōtani')).toBe('ÉŌ')
        expect(avatarInitials('𐐨𐐯𐑅 Ana')).toBe('𐐀A')
    })

    it('uppercases a lowercase name', () => {
        expect(avatarInitials('ana cruz')).toBe('AC')
        expect(avatarInitials('ana')).toBe('A')
    })
})
