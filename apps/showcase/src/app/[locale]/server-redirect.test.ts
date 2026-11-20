import { describe, expect, it } from 'vitest'
import { serverRedirectPath } from './server-redirect'

describe('serverRedirectPath', () => {
    it('follows a path on this origin', () => {
        expect(serverRedirectPath({ redirectTo: '/en/dashboard' })).toBe('/en/dashboard')
    })

    it.each([
        { redirectTo: '//evil.example' },
        { redirectTo: '/\\evil.example' },
        { redirectTo: 'https://evil.example/' },
        { redirectTo: 42 },
        {},
        null,
        'not an object',
    ])('stays put for anything else: %j', (body) => {
        expect(serverRedirectPath(body)).toBeNull()
    })
})
