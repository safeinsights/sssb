/**
 * FIXTURE ROUTE — SCANNED, NEVER SERVED. See ../dockets/route.ts for what this tree is.
 *
 * THIS FILE is a read that READS NOTHING: a liveness probe, whose every call is a global's (`Response.json`,
 * `new Date`). The scan passes such a read handler without `authorize(...)` and without an exemption, since it can
 * reach no data a port, the database or a helper holds (@sssb/kit/authz/route-scan.ts, `readsNothing`). A probe
 * that checks the database calls an import, and authorizes or names an exemption like any other read.
 */
export async function GET(): Promise<Response> {
    return Response.json({ ok: true, at: new Date().toISOString() })
}
