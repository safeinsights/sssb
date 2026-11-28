import { describe, expect, it } from 'vitest'
import { mailLinkTarget } from './mail-link'

const PAGE = 'http://localhost:3000/en/dashboard'

describe('mailLinkTarget', () => {
    it.each([
        ['/en/accept-invite?token=t', '/en/accept-invite?token=t'],
        ['http://localhost:3000/en/org#members', '/en/org#members'],
    ])('follows a link on this origin: %j', (href, path) => {
        expect(mailLinkTarget(href, PAGE)).toEqual({ path })
    })

    it.each(['/\\evil.example', '/\t/evil.example', '/.//evil.example', '//evil.example/x', 'https://evil.example/'])(
        'never follows a link a browser would read as another origin: %j',
        (href) => {
            expect(mailLinkTarget(href, PAGE)).not.toHaveProperty('path')
        },
    )

    it('names the foreign origin it refused, and calls an origin-less link unusable', () => {
        expect(mailLinkTarget('https://evil.example/x', PAGE)).toEqual({
            refused: 'origin',
            origin: 'https://evil.example',
        })
        expect(mailLinkTarget('mailto:a@b.test', PAGE)).toEqual({ refused: 'unusable' })
        expect(mailLinkTarget('not a url', PAGE)).toEqual({ refused: 'unusable' })
    })
})
