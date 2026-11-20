import { staffOrgSlug } from '@sssb/app-config/abilities'
import type { AuthPort } from '../../ports/auth'
import { authSettings } from '../auth-tenancy'
import { orgNameForSlugs } from '../../db/org-lookup'
import { configuredAuth } from '../configured-auth'
import { fakeAuth, fakeIdentitySource } from './auth'
import { fakeDb } from './db'

let cached: AuthPort | undefined

/**
 * The simulated world's auth port: the fake, placed as the environment's auth settings say (`AUTH_TENANCY`,
 * `AUTH_ORG_SOURCE`: ../auth-tenancy.ts), and the bare fake on the defaults. Every simulated consumer takes it from
 * here, the registry (../index.ts), the fake job runner's handlers and notifications (./jobs.ts) and the conformance
 * suite's preset replay, so an app's `pnpm dev` places people as its deployment does everywhere, not only on the
 * request path. Read on first use, so only in simulated mode: the registry imports the fakes in real mode too, where
 * a misconfigured setting is the boot check's to report.
 *
 * The conformance suite's preset replay takes this too, deliberately: a preset that invites someone under a fixed org
 * source, or signs in a person of another tenant under a single tenancy, describes a world the deployment cannot
 * reach, and the replay says so.
 */
export function simulatedAuth(): AuthPort {
    if (cached === undefined) {
        cached = configuredAuth(fakeAuth, authSettings(), fakeIdentitySource, staffOrgSlug, (tenant, org) =>
            orgNameForSlugs(fakeDb, tenant, org),
        )
    }
    return cached
}
