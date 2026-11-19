import { describe, expect, it } from 'vitest'
import { sameOriginPath } from './same-origin-path'

describe('sameOriginPath', () => {
    it.each([
        ['/en/dashboard', '/en/dashboard'],
        ['/es/dockets?open=1#top', '/es/dockets?open=1#top'],
        ['/es/caf%C3%A9', '/es/caf%C3%A9'],
        ['/', '/'],
        ['/en/./dashboard', '/en/dashboard'],
        ['/en/a/../dashboard', '/en/dashboard'],
        ['/en/search?q=a\\b', '/en/search?q=a\\b'],
        ['/en#a\\b', '/en#a\\b'],
        ['/en/search?q=a b', '/en/search?q=a%20b'],
    ])('keeps a path on this origin: %j', (value, path) => {
        expect(sameOriginPath(value)).toBe(path)
    })

    it.each([
        'https://elsewhere.example/',
        'http:elsewhere.example',
        '//elsewhere.example/',
        '/\\elsewhere.example/',
        '/\t/elsewhere.example/',
        '/\n/elsewhere.example/',
        '/en?\t',
        '/.//elsewhere.example/',
        '/en/../..//elsewhere.example/',
        'javascript:alert(1)',
        'en/dashboard',
        '',
        42,
        null,
    ])('refuses what would leave the origin or is not a path: %j', (value) => {
        expect(sameOriginPath(value)).toBeNull()
    })
})
