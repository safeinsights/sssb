// @ts-check

/**
 * The app's auth settings, as its `params.auth` declares them, and the settings they set in the server's environment
 * (@sssb/kit's `adapters/auth-tenancy.ts`, which the framework reads at boot; this package's test checks the choices
 * agree, through the framework each app resolves). Left out, it sets nothing, and the framework takes its defaults:
 * multi tenancy with the `tenantSlug` metadata key, and the identity provider's organizations.
 *
 * Two choices, one pairing refused:
 * - `tenancy`, where the tenant comes from: `'multi'` (the default), each user's claim in their identity provider's
 *   metadata, under `tenantMetadataKey` when given; or `'single'`, the deployment's `tenantSlug`. A single tenancy
 *   changes nothing else.
 * - `orgSource`, where organizations and roles come from: `'provider'` (the default), the identity provider's
 *   organizations and per-membership roles; or `'fixed'`, for an app that uses the provider without its organizations:
 *   every user it signs in is placed in `homeOrgSlug` with `defaultRole` (`'none'` when left out, or `'restricted'`).
 *   On a provider instance shared with another product, that product's users all sign in.
 *
 * Validated here, at synth, so a deployment never ships a setting the framework would refuse at boot: an unknown key or
 * choice, a slug that is not one, a choice without its slug, a slug or role its choice does not use, or a default role
 * outside the safe set. One check is the framework's alone, at boot: a fixed home org that is the app's staff org with
 * a role other than `'none'`, since only the app's seam names its staff org.
 */
export const AUTH_TENANCY_CHOICES = ['multi', 'single']
export const AUTH_ORG_SOURCE_CHOICES = ['provider', 'fixed']
export const FIXED_ORG_ROLES = ['none', 'restricted']

const KEYS = ['tenancy', 'tenantSlug', 'tenantMetadataKey', 'orgSource', 'homeOrgSlug', 'defaultRole']
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
const METADATA_KEY = /^(?!(?:__proto__|constructor|prototype)$)[A-Za-z_][A-Za-z0-9_]*$/

/**
 * @param {Record<string, unknown>} given
 * @param {string} name
 * @param {string[]} choices
 * @returns {string}
 */
function choiceOf(given, name, choices) {
    const value = given[name] ?? choices[0]
    if (typeof value !== 'string' || !choices.includes(value)) {
        throw new Error(`SssbApp: params.auth.${name} must be ${choices.join(' or ')} (got ${JSON.stringify(value)})`)
    }
    return value
}

/**
 * @param {Record<string, unknown>} given
 * @param {string[]} names
 * @param {string} setting
 * @param {string} needed
 * @param {string} chosen
 */
function refuseStrays(given, names, setting, needed, chosen) {
    const stray = names.filter((name) => given[name] !== undefined)
    if (stray.length > 0) {
        throw new Error(
            `SssbApp: params.auth.${stray.join(' and ')} need ${setting} '${needed}' (${setting} is '${chosen}')`,
        )
    }
}

/**
 * @param {Record<string, unknown>} given
 * @param {string} name
 * @param {string} needer
 * @returns {string}
 */
function slugOf(given, name, needer) {
    const value = given[name]
    if (typeof value !== 'string' || !SLUG.test(value)) {
        throw new Error(`SssbApp: ${needer} needs params.auth.${name}, a slug (got ${JSON.stringify(value)})`)
    }
    return value
}

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
    const tenancy = choiceOf(given, 'tenancy', AUTH_TENANCY_CHOICES)
    const orgSource = choiceOf(given, 'orgSource', AUTH_ORG_SOURCE_CHOICES)
    /** @type {Record<string, string>} */
    const env = { AUTH_TENANCY: tenancy, AUTH_ORG_SOURCE: orgSource }

    const key = given['tenantMetadataKey']
    if (key !== undefined) {
        if (typeof key !== 'string' || !METADATA_KEY.test(key)) {
            throw new Error(
                `SssbApp: params.auth.tenantMetadataKey must be a plain identifier (got ${JSON.stringify(key)})`,
            )
        }
        env['AUTH_TENANT_METADATA_KEY'] = key
    }

    if (tenancy === 'multi') refuseStrays(given, ['tenantSlug'], 'tenancy', 'single', 'multi')
    else env['AUTH_TENANT_SLUG'] = slugOf(given, 'tenantSlug', "tenancy 'single'")

    if (orgSource === 'provider') {
        refuseStrays(given, ['homeOrgSlug', 'defaultRole'], 'orgSource', 'fixed', 'provider')
    } else {
        if (tenancy !== 'single') {
            throw new Error(
                "SssbApp: params.auth.orgSource 'fixed' needs tenancy 'single': with a multi tenancy the tenant claim in " +
                    "the identity provider's metadata would be all that places a person",
            )
        }
        env['AUTH_HOME_ORG_SLUG'] = slugOf(given, 'homeOrgSlug', "orgSource 'fixed'")
        const role = given['defaultRole']
        if (role !== undefined) {
            if (typeof role !== 'string' || !FIXED_ORG_ROLES.includes(role)) {
                throw new Error(
                    `SssbApp: params.auth.defaultRole must be ${FIXED_ORG_ROLES.join(' or ')} (got ` +
                        `${JSON.stringify(role)}): everyone the identity provider signs in gets it, so no role that ` +
                        'writes is offered',
                )
            }
            env['AUTH_DEFAULT_ROLE'] = role
        }
    }
    return env
}
