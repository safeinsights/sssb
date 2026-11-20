import { describe, expect, it } from 'vitest'
import { authRequiredEnv, authSettings, fixedOrgProblem } from './auth-tenancy'

const SINGLE = { AUTH_TENANCY: 'single', AUTH_TENANT_SLUG: 'harbor' }

describe('the auth settings', () => {
    it('are multi tenancy and the provider organizations, with the tenantSlug key, when nothing is set', () => {
        expect(authSettings({})).toEqual({
            tenancy: { kind: 'multi' },
            orgSource: { kind: 'provider' },
            tenantMetadataKey: 'tenantSlug',
        })
        expect(authRequiredEnv({})).toEqual({})
    })

    it('read the tenant metadata key from AUTH_TENANT_METADATA_KEY', () => {
        expect(authSettings({ AUTH_TENANT_METADATA_KEY: 'siteSlug' }).tenantMetadataKey).toBe('siteSlug')
    })

    it('a single tenancy fixes the tenant alone: the organizations stay the provider', () => {
        const env = { AUTH_TENANCY: 'single', AUTH_TENANT_SLUG: 'harbor' }
        expect(authSettings(env)).toEqual({
            tenancy: { kind: 'single', tenantSlug: 'harbor' },
            orgSource: { kind: 'provider' },
            tenantMetadataKey: 'tenantSlug',
        })
        expect(authRequiredEnv(env)).toEqual({ AUTH_TENANT_SLUG: 'auth-tenancy' })
    })

    it('a fixed org source places everyone in the home org, with none unless a role is given', () => {
        const env = {
            AUTH_TENANCY: 'single',
            AUTH_TENANT_SLUG: 'harbor',
            AUTH_ORG_SOURCE: 'fixed',
            AUTH_HOME_ORG_SLUG: 'depot',
        }
        expect(authSettings(env)).toEqual({
            tenancy: { kind: 'single', tenantSlug: 'harbor' },
            orgSource: { kind: 'fixed', homeOrgSlug: 'depot', role: 'none' },
            tenantMetadataKey: 'tenantSlug',
        })
        expect(authSettings({ ...env, AUTH_DEFAULT_ROLE: 'restricted' }).orgSource).toEqual({
            kind: 'fixed',
            homeOrgSlug: 'depot',
            role: 'restricted',
        })
        expect(Object.keys(authRequiredEnv(env)).sort()).toEqual(['AUTH_HOME_ORG_SLUG', 'AUTH_TENANT_SLUG'])
        expect(authRequiredEnv({ AUTH_ORG_SOURCE: 'fixed' })).toEqual({ AUTH_HOME_ORG_SLUG: 'auth-tenancy' })
    })

    it('refuse a fixed org source with a multi tenancy: the provider metadata would be all that places a person', () => {
        expect(() => authSettings({ AUTH_ORG_SOURCE: 'fixed', AUTH_HOME_ORG_SLUG: 'depot' })).toThrow(
            /AUTH_ORG_SOURCE=fixed needs AUTH_TENANCY=single/,
        )
    })

    it.each([
        ['an unknown tenancy', { AUTH_TENANCY: 'one' }, /AUTH_TENANCY must be one of multi, single/],
        ['an unknown org source', { AUTH_ORG_SOURCE: 'none' }, /AUTH_ORG_SOURCE must be one of provider, fixed/],
        ['single without its slug', { AUTH_TENANCY: 'single' }, /AUTH_TENANCY=single needs AUTH_TENANT_SLUG/],
        ['fixed without its slug', { AUTH_ORG_SOURCE: 'fixed' }, /AUTH_ORG_SOURCE=fixed needs AUTH_HOME_ORG_SLUG/],
        [
            'a malformed org slug',
            { ...SINGLE, AUTH_ORG_SOURCE: 'fixed', AUTH_HOME_ORG_SLUG: 'Depot Org' },
            /needs AUTH_HOME_ORG_SLUG/,
        ],
        [
            'a default role that writes',
            { ...SINGLE, AUTH_ORG_SOURCE: 'fixed', AUTH_HOME_ORG_SLUG: 'depot', AUTH_DEFAULT_ROLE: 'member' },
            /AUTH_DEFAULT_ROLE must be one of none, restricted/,
        ],
        ['a tenant slug on a multi tenancy', { AUTH_TENANT_SLUG: 'harbor' }, /AUTH_TENANCY is multi/],
        ['a home org on the provider organizations', { AUTH_HOME_ORG_SLUG: 'depot' }, /AUTH_ORG_SOURCE is provider/],
        ['a default role on the provider organizations', { AUTH_DEFAULT_ROLE: 'none' }, /AUTH_ORG_SOURCE is provider/],
        // #90's single mode set both slugs from one switch; that deployment now names the org source too.
        [
            'the home org with a single tenancy alone',
            { AUTH_TENANCY: 'single', AUTH_TENANT_SLUG: 'harbor', AUTH_HOME_ORG_SLUG: 'depot' },
            /AUTH_ORG_SOURCE is provider/,
        ],
        ['a key that is not an identifier', { AUTH_TENANT_METADATA_KEY: 'a.b' }, /plain identifier/],
        ["a key naming an object's own machinery", { AUTH_TENANT_METADATA_KEY: '__proto__' }, /plain identifier/],
    ])('refuse %s', (_, env, message) => {
        expect(() => authSettings(env)).toThrow(message)
    })

    it('refuse a fixed org source that would hand everyone the staff org, unless the role is none', () => {
        const fixed = (role: 'none' | 'restricted', homeOrgSlug = 'depot') =>
            ({ kind: 'fixed', homeOrgSlug, role }) as const
        expect(fixedOrgProblem(fixed('restricted'), 'depot')).toMatch(/would wield manage-all/)
        expect(fixedOrgProblem(fixed('none'), 'depot')).toBeNull()
        expect(fixedOrgProblem(fixed('restricted', 'annex'), 'depot')).toBeNull()
        expect(fixedOrgProblem({ kind: 'provider' }, 'depot')).toBeNull()
    })
})
