import type { AnalyticsPort } from '@sssb/kit/ports/analytics'
import type { AuthPort } from '@sssb/kit/ports/auth'
import type { LlmPort } from '@sssb/kit/ports/llm'
import type { ServiceIdentity } from '@sssb/kit/service-auth/verify'

/**
 * STAND-INS for the fixture routes in this tree, which are scanned and never served (see ./dockets/route.ts).
 *
 * The authorization scan counts an exemption's gate only when its name is IMPORTED into the route, under the name
 * it is exported by (@sssb/kit/authz/route-scan.ts): a local `const isSimulated = true` or `const withWebhookSecret =
 * (h) => h` is a look-alike, not the gate, and a handler that relies on one fails its exemption. So the fixture's
 * routes import their stand-ins from here, as an app's routes import the real ones.
 *
 * Why stand-ins at all: the real ones cannot be imported into this tree. `isSimulated`, `auth`, `llm` and
 * `analytics` come from @sssb/kit/adapters, which pulls the whole adapter registry and `server-only`;
 * `acceptInvite` is the fake auth adapter's own entry point; and the wrappers are app-side machinery, each
 * app composing them over its own respond helpers. `auth`, `llm` and `analytics` are typed against the
 * ports they stand for, so a port rename breaks the build here instead of leaving an exemption's gate pointed at a
 * call that no longer exists.
 */

/** Annotated `boolean` so `if (!isSimulated)` is not narrowed away. */
export const isSimulated: boolean = true

export const auth: Pick<AuthPort, 'updateProfile' | 'setActiveOrg' | 'signOut'> = {
    updateProfile: async () => {
        throw new Error('fixture route — never served')
    },
    setActiveOrg: async () => {},
    signOut: async () => {},
}

export const llm: Pick<LlmPort, 'complete'> = { complete: async () => ({ text: '' }) }

export const analytics: Pick<AnalyticsPort, 'capture'> = { capture: async () => {} }

/**
 * Not typed against a port, because it is not on one: redeeming an invite token is the fake auth adapter's
 * own entry point (@sssb/kit/adapters/fake/auth), which real mode replaces with the provider's hosted ticket flow.
 */
export const acceptInvite = async (inviteId: string): Promise<{ id: string }> => ({ id: inviteId })

/** Returns the handler Next would call, as the apps' wrapper does. */
export const withWebhookSecret =
    (handler: () => Promise<Response>): ((request: Request) => Promise<Response>) =>
    () =>
        handler()

/** Verifies nothing; hands the handler an empty verified message, as the real wrapper hands it the one it verified. */
export const withStandardWebhookSignature: (
    handler: (ctx: { webhook: { id: string; timestamp: number; body: string } }) => Promise<Response>,
    options: { secretEnv: string },
) => (request: Request) => Promise<Response> = (handler) => () =>
    handler({ webhook: { id: 'fixture-message', timestamp: 0, body: '' } })

const IDENTITY: ServiceIdentity = {
    kind: 'org-service',
    keyId: 'wharf-key',
    tenantId: 'harbor',
    tenantSlug: 'harbor',
    orgId: 'wharf',
    orgSlug: 'wharf',
}

/** Verifies nothing; hands the handler the identity a verified service key would carry, as `ctx.identity`. */
export const withServiceCaller =
    (handler: (ctx: { identity: ServiceIdentity }) => Promise<Response>): ((request: Request) => Promise<Response>) =>
    () =>
        handler({ identity: IDENTITY })
