/**
 * How the auth adapters place a signed-in person: the deployment's two choices, read here from the environment, which
 * `SssbApp` sets from the app's `params.auth` (an app's own infra sets it itself). Both adapters read them, the fake as
 * well as Clerk, so a simulated world runs the same placement as the deployment when its environment says so. The two
 * choices are independent: each answers its own question.
 *
 * **Where the tenant comes from, `AUTH_TENANCY`:**
 * - `multi` (the default, what every deployment did before the switch existed): the tenant is the user's own claim, in
 *   their identity provider's public metadata under `AUTH_TENANT_METADATA_KEY` (default `tenantSlug`).
 * - `single`: `AUTH_TENANT_SLUG` fixes it. No tenant metadata is needed. A user whose metadata names a DIFFERENT tenant
 *   under the key, or holds there something that is not a slug, is refused, so a multi-tenant instance switched to this
 *   mode by mistake cannot pour every tenant's users into one. Nothing else changes: the person's organizations, roles,
 *   invitations and notifications are whatever the org source says.
 *
 * **Where organizations and roles come from, `AUTH_ORG_SOURCE`:**
 * - `provider` (the default, ADR-0003): the identity provider's organizations, and the role on each membership.
 * - `fixed`: for an app that uses the identity provider without its organizations. Every person it signs in is placed
 *   in one org, `AUTH_HOME_ORG_SLUG`, with one role, `AUTH_DEFAULT_ROLE`: `none` (the default), which grants nothing a
 *   membership would (../core/roles.ts `hasStanding`), or `restricted`, which reads what a restricted member reads and
 *   writes nothing org-scoped through SSSB's rules. No role that writes is offered: on an identity-provider instance
 *   shared with another product, everyone that product signs in gets it. The app's own rules grant the rest.
 *
 * One pairing is refused: a fixed org source needs a single tenancy. It reads nothing from the provider about orgs or
 * roles, so with a multi tenancy the tenant claim in the provider's metadata would be the only thing deciding whose
 * data a person reaches, and a credential (`getMember`) could not be checked against the tenant its org belongs to.
 * On an instance shared with another product, that product's operator writes that metadata.
 *
 * Each is an explicit switch, never inferred from which settings happen to be set, so a deployment that
 * half-configures one fails at boot instead of quietly changing who sees what.
 */

export const AUTH_TENANCY_CHOICES = ['multi', 'single'] as const
export const AUTH_ORG_SOURCE_CHOICES = ['provider', 'fixed'] as const
/** The roles a fixed org source may give everyone, lowest first: neither writes anything org-scoped in SSSB's rules. */
export const FIXED_ORG_ROLES = ['none', 'restricted'] as const
export type FixedOrgRole = (typeof FIXED_ORG_ROLES)[number]

export type AuthTenancy = { kind: 'multi' } | { kind: 'single'; tenantSlug: string }
export type AuthOrgSource = { kind: 'provider' } | { kind: 'fixed'; homeOrgSlug: string; role: FixedOrgRole }

export interface AuthSettings {
    tenancy: AuthTenancy
    orgSource: AuthOrgSource
    /** The public-metadata key holding a user's tenant claim: read in multi tenancy, checked in single. */
    tenantMetadataKey: string
}

const DEFAULT_TENANT_METADATA_KEY = 'tenantSlug'
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
const METADATA_KEY = /^(?!(?:__proto__|constructor|prototype)$)[A-Za-z_][A-Za-z0-9_]*$/

type Env = Readonly<Record<string, string | undefined>>

/** Every setting either choice reads, each mapped to its cutover row. */
const SINGLE_TENANCY_ENV: Readonly<Record<string, string>> = { AUTH_TENANT_SLUG: 'auth-tenancy' }
const FIXED_ORG_ENV: Readonly<Record<string, string>> = { AUTH_HOME_ORG_SLUG: 'auth-tenancy' }
/** Optional in a fixed org source (it defaults to `none`), so required nowhere, and refused elsewhere. */
const FIXED_ORG_OPTIONAL = ['AUTH_DEFAULT_ROLE']

function choice<T extends string>(env: Env, name: string, choices: readonly T[]): T {
    const value = env[name] || choices[0]
    if (!(choices as readonly string[]).includes(value as string)) {
        throw new Error(`${name} must be one of ${choices.join(', ')} (got "${value}")`)
    }
    return value as T
}

function strays(env: Env, names: readonly string[], setting: string, needs: string): void {
    const set = names.filter((name) => env[name])
    if (set.length > 0) {
        throw new Error(
            `${set.join(' and ')} ${set.length > 1 ? 'are' : 'is'} set but ${setting}: set ${needs} to use ` +
                `${set.length > 1 ? 'them' : 'it'}, or remove ${set.length > 1 ? 'them' : 'it'}`,
        )
    }
}

function slug(env: Env, name: string, needer: string): string {
    const value = env[name] ?? ''
    if (!SLUG.test(value)) throw new Error(`${needer} needs ${name}, a slug (got "${value}")`)
    return value
}

/**
 * The deployment's auth settings, from `env` (the process's own by default). Throws on an unknown choice, a malformed
 * slug, key or role, or a setting its choice does not use; a missing setting a choice needs is the boot check's to
 * report (`assertRealEnv`), and throws here only when the settings are read without it.
 */
export function authSettings(env: Env = process.env): AuthSettings {
    const tenancyKind = choice(env, 'AUTH_TENANCY', AUTH_TENANCY_CHOICES)
    const orgSourceKind = choice(env, 'AUTH_ORG_SOURCE', AUTH_ORG_SOURCE_CHOICES)
    const tenantMetadataKey = env['AUTH_TENANT_METADATA_KEY'] || DEFAULT_TENANT_METADATA_KEY
    if (!METADATA_KEY.test(tenantMetadataKey)) {
        throw new Error(`AUTH_TENANT_METADATA_KEY must be a plain identifier (got "${tenantMetadataKey}")`)
    }

    let tenancy: AuthTenancy
    if (tenancyKind === 'multi') {
        strays(env, Object.keys(SINGLE_TENANCY_ENV), 'AUTH_TENANCY is multi', 'AUTH_TENANCY=single')
        tenancy = { kind: 'multi' }
    } else {
        tenancy = { kind: 'single', tenantSlug: slug(env, 'AUTH_TENANT_SLUG', 'AUTH_TENANCY=single') }
    }

    let orgSource: AuthOrgSource
    if (orgSourceKind === 'provider') {
        strays(
            env,
            [...Object.keys(FIXED_ORG_ENV), ...FIXED_ORG_OPTIONAL],
            'AUTH_ORG_SOURCE is provider',
            'AUTH_ORG_SOURCE=fixed',
        )
        orgSource = { kind: 'provider' }
    } else {
        const homeOrgSlug = slug(env, 'AUTH_HOME_ORG_SLUG', 'AUTH_ORG_SOURCE=fixed')
        const role = env['AUTH_DEFAULT_ROLE'] || FIXED_ORG_ROLES[0]
        if (!(FIXED_ORG_ROLES as readonly string[]).includes(role)) {
            throw new Error(
                `AUTH_DEFAULT_ROLE must be one of ${FIXED_ORG_ROLES.join(', ')} (got "${role}"): everyone the ` +
                    'identity provider signs in gets it, so no role that writes is offered',
            )
        }
        orgSource = { kind: 'fixed', homeOrgSlug, role: role as FixedOrgRole }
        if (tenancy.kind === 'multi') {
            throw new Error(
                'AUTH_ORG_SOURCE=fixed needs AUTH_TENANCY=single: with a multi tenancy the tenant claim in the identity ' +
                    "provider's metadata would be all that places a person",
            )
        }
    }
    return { tenancy, orgSource, tenantMetadataKey }
}

/**
 * The settings the deployment's choices require, each mapped to its cutover row: a single tenancy's tenant slug, a
 * fixed org source's home org slug, or none.
 */
export function authRequiredEnv(env: Env = process.env): Record<string, string> {
    return {
        ...((env['AUTH_TENANCY'] || 'multi') === 'single' ? SINGLE_TENANCY_ENV : {}),
        ...((env['AUTH_ORG_SOURCE'] || 'provider') === 'fixed' ? FIXED_ORG_ENV : {}),
    }
}

/**
 * Why a fixed org source cannot run with this app's staff org, or null. The staff org's members wield manage-all
 * (../core/abilities.ts), and every role a fixed org source offers but `none` has standing, so placing everyone the
 * identity provider signs in in the staff org with one would hand them all manage-all. Checked where the auth port is
 * built, with the seam's `staffOrgSlug`, since only the app knows it (`SssbApp` cannot, at synth).
 */
export function fixedOrgProblem(orgSource: AuthOrgSource, staffOrgSlug: string): string | null {
    if (orgSource.kind !== 'fixed' || orgSource.role === 'none' || orgSource.homeOrgSlug !== staffOrgSlug) return null
    return (
        `AUTH_HOME_ORG_SLUG is the staff org ("${staffOrgSlug}") and AUTH_DEFAULT_ROLE is "${orgSource.role}": ` +
        'everyone the identity provider signs in would wield manage-all. Use another home org, or the role none'
    )
}
