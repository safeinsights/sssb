/**
 * FIXTURE ROUTE — SCANNED, NEVER SERVED. See ../dockets/route.ts for what this tree is.
 *
 * THIS FILE is a read that READS NOTHING: a liveness probe, which names nothing but inert globals (`Response`,
 * `Date`). The scan passes such a read handler without `authorize(...)` and without an exemption, since no port, database,
 * helper or network is in its reach (@sssb/kit/authz/route-scan.ts, `readsNothing`). A probe that checks the database
 * names an import, and authorizes or names an exemption like any other read.
 */
export async function GET(): Promise<Response> {
    return Response.json({ ok: true, at: new Date().toISOString() })
}
