import { describe, expect, it } from 'vitest'
import { authTenancy, authTenancyEnv } from './auth-tenancy'

describe('the auth tenancy settings', () => {
    it('is multi-tenant with the tenantSlug key when nothing is set, as before the switch existed', () => {
        expect(authTenancy({})).toEqual({ kind: 'multi', tenantMetadataKey: 'tenantSlug' })
        expect(authTenancyEnv({})).toEqual({})
    })

    it('reads the tenant metadata key from AUTH_TENANT_METADATA_KEY', () => {
        expect(authTenancy({ AUTH_TENANT_METADATA_KEY: 'siteSlug' })).toEqual({
            kind: 'multi',
            tenantMetadataKey: 'siteSlug',
        })
    })

    it('in single mode, fixes the tenant and the home org from their settings', () => {
        const env = { AUTH_TENANCY: 'single', AUTH_TENANT_SLUG: 'harbor', AUTH_HOME_ORG_SLUG: 'depot' }
        expect(authTenancy(env)).toEqual({
            kind: 'single',
            tenantSlug: 'harbor',
            homeOrgSlug: 'depot',
            tenantMetadataKey: 'tenantSlug',
        })
        expect(Object.keys(authTenancyEnv(env)).sort()).toEqual(['AUTH_HOME_ORG_SLUG', 'AUTH_TENANT_SLUG'])
    })

    it.each([
        ['an unknown mode', { AUTH_TENANCY: 'one' }, /AUTH_TENANCY must be one of multi, single/],
        ['single without its slugs', { AUTH_TENANCY: 'single' }, /needs AUTH_TENANT_SLUG/],
        [
            'single with a malformed org slug',
            { AUTH_TENANCY: 'single', AUTH_TENANT_SLUG: 'harbor', AUTH_HOME_ORG_SLUG: 'Depot Org' },
            /needs AUTH_HOME_ORG_SLUG/,
        ],
        ['a single-mode setting on a multi deployment', { AUTH_TENANT_SLUG: 'harbor' }, /AUTH_TENANCY is multi/],
        ['a key that is not an identifier', { AUTH_TENANT_METADATA_KEY: 'a.b' }, /plain identifier/],
        ["a key naming an object's own machinery", { AUTH_TENANT_METADATA_KEY: '__proto__' }, /plain identifier/],
    ])('refuses %s', (_, env, message) => {
        expect(() => authTenancy(env)).toThrow(message)
    })
})
