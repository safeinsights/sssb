// @ts-check

/**
 * The app's auth tenancy, as its `params.auth` declares it, and the settings it sets in the server's environment
 * (@sssb/kit's `adapters/auth-tenancy.ts`, which the framework reads at boot; this package's test checks the choices
 * agree, through the framework each app resolves). Left out, it sets nothing, and the framework takes multi-tenant
 * auth with the `tenantSlug` metadata key: what every deployment had before the setting existed.
 *
 * - `tenancy: 'multi'` (the default): the tenant is each user's claim in their identity provider's metadata, under
 *   `tenantMetadataKey` when given.
 * - `tenancy: 'single'`: `tenantSlug` and `homeOrgSlug` fix the tenant and the home org, and every user the identity
 *   provider signs in is placed there with role `none`, which grants nothing a membership would. On a provider
 *   instance shared with another product, that product's users all sign in.
 *
 * Validated here, at synth, so a deployment never ships a setting the framework would refuse at boot: an unknown key or
 * tenancy, a slug that is not one, single without both slugs, or a slug given to multi.
 */
export const AUTH_TENANCY_CHOICES = ['multi', 'single']

const KEYS = ['tenancy', 'tenantSlug', 'homeOrgSlug', 'tenantMetadataKey']
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
const METADATA_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/

/**
 * The server's settings for an app's `params.auth`, or a thrown error naming what is wrong.
 * @param {unknown} auth
 * @returns {Record<string, string>}
 */
export function authEnvironment(auth) {
    if (auth === undefined) return {}
    if (typeof auth !== 'object' || auth === null || Array.isArray(auth)) {
        throw new Error(`SssbApp: params.auth must be an object (got ${JSON.stringify(auth)})`)
    }
    const given = /** @type {Record<string, unknown>} */ (auth)
    const unknown = Object.keys(given).filter((key) => !KEYS.includes(key))
    if (unknown.length > 0) {
        throw new Error(`SssbApp: params.auth has no ${unknown.join(', ')} (it takes ${KEYS.join(', ')})`)
    }
    const tenancy = given['tenancy'] ?? 'multi'
    if (typeof tenancy !== 'string' || !AUTH_TENANCY_CHOICES.includes(tenancy)) {
        throw new Error(
            `SssbApp: params.auth.tenancy must be ${AUTH_TENANCY_CHOICES.join(' or ')} (got ${JSON.stringify(tenancy)})`,
        )
    }
    /** @type {Record<string, string>} */
    const env = { AUTH_TENANCY: tenancy }
    const key = given['tenantMetadataKey']
    if (key !== undefined) {
        if (typeof key !== 'string' || !METADATA_KEY.test(key)) {
            throw new Error(
                `SssbApp: params.auth.tenantMetadataKey must be a plain identifier (got ${JSON.stringify(key)})`,
            )
        }
        env['AUTH_TENANT_METADATA_KEY'] = key
    }
    if (tenancy === 'multi') {
        const stray = ['tenantSlug', 'homeOrgSlug'].filter((name) => given[name] !== undefined)
        if (stray.length > 0) {
            throw new Error(`SssbApp: params.auth.${stray.join(' and ')} need tenancy 'single' (tenancy is 'multi')`)
        }
        return env
    }
    for (const name of ['tenantSlug', 'homeOrgSlug']) {
        const value = given[name]
        if (typeof value !== 'string' || !SLUG.test(value)) {
            throw new Error(
                `SssbApp: tenancy 'single' needs params.auth.${name}, a slug (got ${JSON.stringify(value)})`,
            )
        }
    }
    env['AUTH_TENANT_SLUG'] = /** @type {string} */ (given['tenantSlug'])
    env['AUTH_HOME_ORG_SLUG'] = /** @type {string} */ (given['homeOrgSlug'])
    return env
}
