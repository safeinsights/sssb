/**
 * The letters an avatar shows for a person (or an org): the first letters of the first and last words
 * of `name` that start with a letter (Unicode `\p{L}`), uppercased. One such word gives one letter.
 * Punctuation or digits that open a word never count, so `Ana (Bea) Cruz` is `AC`, not `A(`, which
 * is what Mantine's own `name` prop would show.
 *
 * With no such word the first letter (or digit) of `fallback`, the email where a caller has one, is
 * used; with neither, the result is empty and the `Avatar` draws its placeholder icon.
 */
export function avatarInitials(name: string, fallback = ''): string {
    const letterWords = name.split(/\s+/).filter((word) => /^\p{L}/u.test(word))
    if (letterWords.length > 0) {
        const first = letterWords[0]!
        const last = letterWords[letterWords.length - 1]!
        // `Array.from` takes a code point, so a letter outside the BMP is not split in half.
        return (Array.from(first)[0]! + (letterWords.length > 1 ? Array.from(last)[0]! : '')).toUpperCase()
    }
    const lead = fallback.match(/[\p{L}\p{N}]/u)?.[0]
    return lead ? lead.toUpperCase() : ''
}
