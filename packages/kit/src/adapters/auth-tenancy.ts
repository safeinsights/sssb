/**
 * How the auth adapters place a signed-in person in a tenant and an org: the deployment's choice, read here from the
 * environment, which `SssbApp` sets from the app's `params.auth` (an app's own infra sets it itself). Both adapters read
 * it, the fake as well as Clerk, so a simulated world runs the same mode as the deployment when its environment says so.
 *
 * - `AUTH_TENANCY`: `multi` (the default, what every deployment did before the switch existed) or `single`. An explicit
 *   switch, never inferred from which settings happen to be set, so a deployment that half-configures the mode fails
 *   at boot instead of quietly changing who sees what.
 * - **multi:** the tenant is the user's own claim, in their identity provider's public metadata under
 *   `AUTH_TENANT_METADATA_KEY` (default `tenantSlug`); the org and the role are the provider's memberships (ADR-0003).
 * - **single:** `AUTH_TENANT_SLUG` and `AUTH_HOME_ORG_SLUG` fix the tenant and the home org. Every signed-in user of the
 *   identity provider is placed there, with role `none`, which grants nothing a membership would
 *   (../core/roles.ts `hasStanding`): the app's own rules decide everything else. No provider organization and no
 *   tenant metadata is needed. A user whose metadata names a DIFFERENT tenant under the metadata key is refused, so
 *   switching a multi-tenant instance to this mode by mistake cannot pour every tenant's users into one.
 *
 * On a provider instance shared with another product, single mode admits every user of that product as a signed-in
 * person of this app. The app's own rules are what keep them out of anything.
 */

export type AuthTenancy =
    | { kind: 'multi'; tenantMetadataKey: string }
    | { kind: 'single'; tenantSlug: string; homeOrgSlug: string; tenantMetadataKey: string }

export const AUTH_TENANCY_CHOICES = ['multi', 'single'] as const

const DEFAULT_TENANT_METADATA_KEY = 'tenantSlug'
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
const METADATA_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/

/** The settings single mode requires, each mapped to its cutover row. */
const SINGLE_TENANT_ENV: Readonly<Record<string, string>> = {
    AUTH_TENANT_SLUG: 'auth-tenancy',
    AUTH_HOME_ORG_SLUG: 'auth-tenancy',
}

/**
 * The deployment's auth tenancy, from `env` (the process's own by default). Throws on an unknown mode, a malformed
 * slug or key, or a setting the mode does not use; a missing setting single mode needs is the boot check's to report
 * (`assertRealEnv`), and throws here only when the mode is read without it.
 */
export function authTenancy(env: Readonly<Record<string, string | undefined>> = process.env): AuthTenancy {
    const mode = env['AUTH_TENANCY'] || 'multi'
    if (!(AUTH_TENANCY_CHOICES as readonly string[]).includes(mode)) {
        throw new Error(`AUTH_TENANCY must be one of ${AUTH_TENANCY_CHOICES.join(', ')} (got "${mode}")`)
    }
    const tenantMetadataKey = env['AUTH_TENANT_METADATA_KEY'] || DEFAULT_TENANT_METADATA_KEY
    if (!METADATA_KEY.test(tenantMetadataKey)) {
        throw new Error(`AUTH_TENANT_METADATA_KEY must be a plain identifier (got "${tenantMetadataKey}")`)
    }
    if (mode === 'multi') {
        const stray = Object.keys(SINGLE_TENANT_ENV).filter((name) => env[name])
        if (stray.length > 0) {
            throw new Error(
                `${stray.join(' and ')} ${stray.length > 1 ? 'are' : 'is'} set but AUTH_TENANCY is multi: set ` +
                    'AUTH_TENANCY=single to use them, or remove them',
            )
        }
        return { kind: 'multi', tenantMetadataKey }
    }
    const tenantSlug = env['AUTH_TENANT_SLUG'] ?? ''
    const homeOrgSlug = env['AUTH_HOME_ORG_SLUG'] ?? ''
    for (const [name, value] of [
        ['AUTH_TENANT_SLUG', tenantSlug],
        ['AUTH_HOME_ORG_SLUG', homeOrgSlug],
    ] as const) {
        if (!SLUG.test(value)) throw new Error(`AUTH_TENANCY=single needs ${name}, a slug (got "${value}")`)
    }
    return { kind: 'single', tenantSlug, homeOrgSlug, tenantMetadataKey }
}

/** The settings the deployment's tenancy requires, each mapped to its cutover row: single mode's two slugs, or none. */
export function authTenancyEnv(
    env: Readonly<Record<string, string | undefined>> = process.env,
): Record<string, string> {
    return (env['AUTH_TENANCY'] || 'multi') === 'single' ? { ...SINGLE_TENANT_ENV } : {}
}
