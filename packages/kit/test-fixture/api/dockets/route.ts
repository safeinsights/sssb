import { authorize } from '@sssb/kit/authz/authorize'
import type { AuthUser } from '@sssb/kit/ports/auth'
import { listDockets } from '../stand-ins'

/**
 * FIXTURE ROUTE — SCANNED, NEVER SERVED.
 *
 * `packages/kit/test-fixture/api/` is a route tree that exists only to be READ by
 * @sssb/kit/authz/authorized-mutations.test.ts's bypass-catcher scan. It sits outside every app's
 * `src/app`, so Next.js never routes to it and nothing here is reachable at runtime. Each file is the
 * thinnest thing that still carries the property the scan asserts about its class of route.
 *
 * THIS FILE is the scan's non-vacuity anchor: a mutating route that is NOT exempt and therefore has to
 * call `authorize(...)` for real. Without one, every per-handler assertion could be satisfied by the
 * exemption branch and the whole suite would prove nothing.
 */
const CALLER: AuthUser = {
    id: 'fixture-lead',
    name: 'Ada Keeper',
    email: 'ada.keeper@example.test',
    role: 'admin',
    locale: 'en',
    tenantSlug: 'harbor',
    orgSlug: 'depot',
    restricted: false,
}

/**
 * The scan's READ anchor: a read of org-scoped rows that is not exempt, so it has to authorize the read for real. It
 * calls a stand-in read, so without its `authorize(...)` it would fail: a read handler that named only inert globals
 * would read nothing and pass without one.
 */
export async function GET(): Promise<Response> {
    authorize(CALLER, 'depot', 'read', { type: 'Docket', orgId: 'depot' })
    return Response.json({ dockets: await listDockets('depot') })
}

export async function POST(): Promise<Response> {
    authorize(CALLER, 'depot', 'create', { type: 'Docket', orgId: 'depot' })
    return Response.json({ ok: true })
}
