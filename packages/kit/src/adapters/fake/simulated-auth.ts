import type { AuthPort } from '../../ports/auth'
import { authTenancy } from '../auth-tenancy'
import { singleTenantAuth } from '../single-tenant-auth'
import { fakeAuth, fakeIdentitySource } from './auth'

let cached: AuthPort | undefined

/**
 * The simulated world's auth port: the fake, or the fake as single-tenant auth when the environment sets
 * `AUTH_TENANCY=single` (../auth-tenancy.ts). Every simulated consumer takes it from here, the registry
 * (../index.ts), the fake job runner's handlers and notifications (./jobs.ts) and the conformance suite's preset
 * replay, so a single-tenant app's `pnpm dev` places people as its deployment does everywhere, not only on the
 * request path. Read on first use, so only in simulated mode: the registry imports the fakes in real mode too, where
 * a misconfigured switch is the boot check's to report.
 *
 * The conformance suite's preset replay takes this too, deliberately: a preset that invites someone, or signs in a
 * person of another tenant, describes a world single-tenant auth cannot reach, and the replay says so.
 */
export function simulatedAuth(): AuthPort {
    if (cached === undefined) {
        const tenancy = authTenancy()
        cached = tenancy.kind === 'single' ? singleTenantAuth(fakeAuth, tenancy, fakeIdentitySource) : fakeAuth
    }
    return cached
}
