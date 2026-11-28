import type { Exemption, Gate, ScanPolicy } from './route-scan'

/**
 * THE FRAMEWORK'S AUTHORIZATION POLICY: the exemptions and gates the authorization scan applies to every route
 * tree it walks. Every exported route handler, a read (GET/HEAD/OPTIONS) as well as a mutation
 * (POST/PUT/PATCH/DELETE), must reach `authorize(...)` on its own path (./route-scan.ts judges that), or its route must
 * sit in the justified exemption map below AND the handler must pass that exemption's gate. A read handler may also
 * pass by reading nothing (./route-scan.ts `readsNothing`: naming nothing from outside itself but inert globals,
 * primitive consts, a few named imports and its request), which needs no entry here. An entry applies to every verb of the routes it names, each judged against its gate on its own.
 *
 * It lives in source, not in a test, because two scans apply it: the kit's own (`authorized-mutations.test.ts`, over
 * the framework's reference tree `packages/kit/test-fixture/api`, which is also what keeps every entry here from
 * going stale) and the conformance suite's `authz-mutations` check (`@sssb/kit/testing`), over each app's own
 * `src/app`. An app cannot edit this map; it names exemptions of its own in `<app>/authz-exemptions.mjs`
 * (./app-exemptions.ts), which may not collide with an entry here.
 *
 * Exemption keys are paths relative to a root's `exemptDir` (an app's `src/app/api`, or the fixture's `api/`), each
 * with the reason it needs no per-actor authorize(...) call. Blanket by prefix (whole dirs) or exact by file. Keep
 * this list honest: a new route that isn't genuinely one of these must call authorize(...), not be added
 * here. Every entry is backed by a file in the fixture tree, which is what keeps the staleness checks meaningful.
 *
 * EVERY exemption names the gate its reason rests on as `mustMatch`, and the scan checks it on EVERY exempted
 * HANDLER, per verb, so the claim is ENFORCED, not prose: a guarded POST does not carry an open DELETE
 * beside it. `mustMatch` is REQUIRED (`isGate` below, which the kit's test applies to every entry) because a bare
 * exemption is matched by RELATIVE PATH IN EVERY ROOT, including an adopter's app. Without a gate,
 * `profile/route.ts` would exempt any file at that path from authorize(...): an adopter's PUT that updated any user
 * by id would ship un-authorized and the gate would stay green. With one, that handler has to reach
 * `auth.updateProfile(` — a port call that takes no user id and so cannot express "update someone else" — to inherit
 * the exemption.
 *
 * A framework gate is one of three kinds (./route-scan.ts, `Gate`; a fourth, `reads-only`, is for an app's entries), and the kind is the entry's statement of what "guarded"
 * means for its reason:
 *
 * - `wrapped-by`: the guard WRAPS the handler, so the handler must BE the call (`export const POST =
 *   withWebhookSecret(…)`). Reaching the guard somewhere inside is not enough.
 * - `calls`: the reason rests on a port call the handler makes, so the handler must reach that call.
 * - `opens-with-simulated-404`: the handler's FIRST statement is `if (!isSimulated) return …`.
 *
 * What a gate does NOT promise: it proves the exempted route is the KIND of route the reason describes, not that
 * the reason's full claim holds. `llm.complete(` proves a handler is the model-calling route; it cannot prove the
 * route persists nothing. The gates are strongest where the reason is mechanical (a simulated-mode 404, a signature
 * wrapper, a self-only port call) and weakest where it is about intent. See ADR-0012 for the trade-off in full.
 */
const SIMULATED_404: Gate = { kind: 'opens-with-simulated-404' }

// No `service/` entry, deliberately. A service caller used to be exempt here as "org-scoped by
// construction"; it is now a MACHINE actor (@sssb/kit/core/abilities `MachineActor`) and its mutations call
// authorize(...) like any other route, so the per-action check replaced the blanket one (ADR-0012
// addendum, 2026-11-16). The fixture's service/jobs/route.ts is that machine route. What the old entry
// ALSO guaranteed (that a service route verifies its caller) is kept, below.
export const EXEMPT_PREFIXES: Readonly<Record<string, Exemption>> = {
    'webhooks/': {
        reason:
            'authenticated by a machine caller, not a user session — a shared webhook secret ' +
            '(withWebhookSecret), the Mailgun inbound signature (withMailgunSignature) or a Standard Webhooks ' +
            'signature (withStandardWebhookSignature) — so no per-actor ability applies',
        mustMatch: {
            kind: 'wrapped-by',
            callees: ['withWebhookSecret', 'withMailgunSignature', 'withStandardWebhookSignature'],
        },
    },
    'simulator/': {
        reason: 'simulated-world surface, simulated-mode-gated (404 in real) — never a product mutation path',
        mustMatch: SIMULATED_404,
    },
}

export const EXEMPT_FILES: Readonly<Record<string, Exemption>> = {
    'profile/route.ts': {
        reason: 'self-service: the subject is the caller (User.update is self-only), no cross-actor authorization',
        // The port call that MAKES it self-only: updateProfile takes no user id, so a route that
        // updates another user by id cannot be written through it and cannot inherit this exemption.
        mustMatch: { kind: 'calls', callees: ['auth.updateProfile'] },
    },
    'assistant/route.ts': {
        reason:
            'stateless LLM call — creates no persisted, org-scoped resource to authorize. Any read tool it ' +
            "exposes stays inside the caller's OWN active-org scope (filtered inside withTenant by the " +
            'handler-resolved orgId, the same scope as that app’s own list route) — no per-actor product mutation',
        mustMatch: { kind: 'calls', callees: ['llm.complete', 'llm.stream', 'llm.runToolLoop'] },
    },
    'analytics/page-view/route.ts': {
        reason: 'telemetry beacon — records a page view, mutates no product resource',
        mustMatch: { kind: 'calls', callees: ['analytics.capture'] },
    },
    'auth/org/route.ts': {
        reason: 'setActiveOrg enforces membership at the auth port (ForbiddenError for non-members)',
        mustMatch: { kind: 'calls', callees: ['auth.setActiveOrg'] },
    },
    'auth/signout/route.ts': {
        reason: 'session lifecycle (sign-out) — no product resource, runs post-authz',
        mustMatch: { kind: 'calls', callees: ['auth.signOut'] },
    },
    'auth/dev-signin/route.ts': {
        reason: 'session lifecycle (dev sign-in) — pre-authz by definition, simulated-mode only',
        mustMatch: SIMULATED_404,
    },
    'auth/accept-invite/route.ts': {
        reason: 'invite acceptance is authorized by possession of the invite token, before any membership exists',
        mustMatch: { kind: 'calls', callees: ['acceptInvite'] },
    },
    'storage-upload/route.ts': {
        reason:
            'simulated-mode-only (404 in real) upload endpoint — the local twin of an S3 presigned POST (multipart) and of a presigned PUT, ' +
            'authenticated by the server-signed HMAC upload-target fields (like the webhook secret), NOT a user ' +
            'session; the upload TARGET was already authorized by the app route that minted it',
        mustMatch: SIMULATED_404,
    },
    'storage/[...key]/route.ts': {
        reason:
            'simulated-mode-only (404 in real) download endpoint — the local twin of an S3 signed GET URL, serving the ' +
            'fake storage adapter by key; in real mode an object is read through a signed URL that an authorized app ' +
            'route minted',
        mustMatch: SIMULATED_404,
    },
}

/**
 * Gates a handler under a prefix, read or mutation, must pass IN ADDITION to reaching authorize(...). A read that
 * reads nothing (./route-scan.ts `readsNothing`) passes without one: it reads no data, so it has no actor to authorize,
 * and the wrapper that builds the actor adds nothing (an inline-headers CORS preflight). Authorizing an
 * actor means something only if the actor came from a verified credential: `authorize(` alone is satisfied
 * just as well by a `{ kind: 'machine', credential: { kind: 'service-key' } … }` literal built from the
 * request. So a service handler must also BE the wrapper call that verifies its caller and BUILDS that
 * actor. Matched by relative path in every root, like the exemptions, and backed by a fixture route.
 */
export const REQUIRED_ALONGSIDE: Readonly<Record<string, Exemption>> = {
    'service/': {
        reason:
            'a service route verifies its caller with withServiceCaller, which builds the machine actor ' +
            '(ctx.actor) the route should authorize. The gate proves the wrapper is the handler, not that the ' +
            'actor authorized is the one it built (ADR-0012: a gate proves the KIND of route)',
        mustMatch: { kind: 'wrapped-by', callees: ['withServiceCaller'] },
    },
}

/**
 * What the failure says to a route whose caller is not a session, because that is where an author is
 * most likely to look for an exemption, and since 2026-11-16 there is none to find: `service/` routes
 * used to be exempt, and an adopter's old one fails here on taking the update.
 */
const NON_SESSION_HINT =
    'A caller that is not a session authorizes its actor with the three-argument form, ' +
    'authorize(actor, action, subject): a service key via abilityActorFromService (withServiceCaller passes it as ' +
    'ctx.actor), a machine the app verifies via machineActor, or a person holding a non-session credential (a ' +
    'personal API token) via abilityActorFromCredential. The `service/` exemption was retired (ADR-0012 addendum, 2026-11-16).'

/** The framework's policy, as the scan takes it. An app's own exemptions are added by `policyWithApp` (./app-exemptions.ts). */
export const FRAMEWORK_POLICY: ScanPolicy = {
    exemptPrefixes: EXEMPT_PREFIXES,
    exemptFiles: EXEMPT_FILES,
    requiredAlongside: REQUIRED_ALONGSIDE,
    hint: NON_SESSION_HINT,
}

/** A runtime check of the `Gate` shape: an exemption map is data, and a type is not present when a scan runs. */
export function isGate(gate: unknown): gate is Gate {
    if (typeof gate !== 'object' || gate === null || !('kind' in gate)) return false
    if (gate.kind === 'opens-with-simulated-404') return true
    if (gate.kind === 'reads-only') {
        // Names, not dotted callees: an import's exported name.
        return (
            'names' in gate &&
            Array.isArray(gate.names) &&
            gate.names.length > 0 &&
            gate.names.every((name) => typeof name === 'string' && /^[A-Za-z_$][\w$]*$/.test(name))
        )
    }
    if (gate.kind !== 'wrapped-by' && gate.kind !== 'calls') return false
    return (
        'callees' in gate &&
        Array.isArray(gate.callees) &&
        gate.callees.length > 0 &&
        gate.callees.every((callee) => typeof callee === 'string' && callee.length > 0)
    )
}
