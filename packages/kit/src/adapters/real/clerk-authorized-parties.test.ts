import { describe, expect, test } from 'vitest'
import { clerkAuthorizedParties } from './clerk-authorized-parties'

describe('clerkAuthorizedParties (CLERK_AUTHORIZED_PARTIES)', () => {
    test('is undefined when unset, which leaves Clerk accepting a session token from any origin', () => {
        expect(clerkAuthorizedParties(undefined)).toBeUndefined()
    })

    test('reads a comma-separated list of origins, with space around each', () => {
        expect(clerkAuthorizedParties('https://app.example.org')).toEqual(['https://app.example.org'])
        expect(
            clerkAuthorizedParties(
                ' https://app.example.org , https://preview.example.org:8443,http://localhost:3000 ',
            ),
        ).toEqual(['https://app.example.org', 'https://preview.example.org:8443', 'http://localhost:3000'])
    })

    test('takes http for the loopback hosts alone', () => {
        expect(clerkAuthorizedParties('http://localhost:3000,http://127.0.0.1:3000,http://[::1]:3000')).toEqual([
            'http://localhost:3000',
            'http://127.0.0.1:3000',
            'http://[::1]:3000',
        ])
    })

    test.each([
        ['an empty value', '', /"" is empty/],
        ['a value of spaces', '  ', /"" is empty/],
        ['an empty entry', 'https://app.example.org,,https://b.example.org', /"" is empty/],
        ['a trailing comma', 'https://app.example.org,', /"" is empty/],
        ['a wildcard', 'https://*.example.org', /is a wildcard/],
        ['a bare wildcard', '*', /is a wildcard/],
        ['a host with no scheme', 'app.example.org', /is not a URL/],
        ['space-separated origins', 'https://a.example.org https://b.example.org', /is not a URL/],
        ['plain http', 'http://app.example.org', /is not https/],
        ['another scheme', 'ftp://app.example.org', /is not https/],
        ['http for another address', 'http://10.0.0.5:3000', /is not https/],
        ['http for a subdomain of localhost', 'http://app.localhost:3000', /is not https/],
        [
            'a trailing slash',
            'https://app.example.org/',
            /is not a bare origin: write it as https:\/\/app\.example\.org\./,
        ],
        ['a path', 'https://app.example.org/en', /write it as https:\/\/app\.example\.org/],
        ['a query', 'https://app.example.org?x=1', /write it as https:\/\/app\.example\.org/],
        ['upper case', 'https://App.Example.org', /write it as https:\/\/app\.example\.org/],
        ['the default port', 'https://app.example.org:443', /write it as https:\/\/app\.example\.org/],
        ['user info', 'https://me@app.example.org', /write it as https:\/\/app\.example\.org/],
        ['an unencoded international name', 'https://bücher.example', /write it as https:\/\/xn--bcher-kva\.example/],
        ['a duplicate', 'https://app.example.org,https://app.example.org', /is listed twice/],
    ])(
        'refuses %s, naming the entry, rather than leave the check off or sign everyone out',
        (_case, value, problem) => {
            expect(() => clerkAuthorizedParties(value)).toThrow(problem)
            expect(() => clerkAuthorizedParties(value)).toThrow(/^CLERK_AUTHORIZED_PARTIES: .*or unset it/)
        },
    )

    test('names every bad entry at once', () => {
        expect(() => clerkAuthorizedParties('https://a.example.org/,http://b.example.org')).toThrow(
            /"https:\/\/a\.example\.org\/" is not a bare origin.*; "http:\/\/b\.example\.org" is not https/,
        )
    })
})
