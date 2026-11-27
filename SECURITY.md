# Security policy

## Reporting a vulnerability

Report privately through **[GitHub Security Advisories](https://github.com/safeinsights/sssb/security/advisories/new)**.
Please do not open a public issue for a vulnerability.

Include what you did, what happened, and what you expected. A failing test or a `curl` is worth more
than a paragraph. You will get an acknowledgement within a week.

This is a small project maintained in spare time. There is no bounty, and no guaranteed fix window.
What you will get is a straight answer about whether it is a real issue and what is going to happen
about it.

## What is in scope

SSSB's whole point is that a security-relevant shape is built in rather than bolted on, so
the interesting reports are about that shape being wrong:

- **Tenant isolation.** SSSB's own tenant-scoped content tables carry `tenant_id` — a
  convention, not the guarantee; the guarantee is the reachability check described below. Postgres
  row-level
  security enforces it with `ENABLE` + `FORCE ROW LEVEL SECURITY` and both a `USING` and a `WITH CHECK`
  clause. All access runs inside `db.withTenant()`, which first sets the role to `app_user` for the
  transaction (`set_config('role', 'app_user', true)`, the same as `SET LOCAL ROLE`) so the policy
  cannot be bypassed by a superuser connection. **A way to read or write across tenants is the
  most serious thing you can find here.** The proofs live in `packages/kit/src/db/rls-proofs.ts` and
  run against pglite, against real Postgres, and against real Postgres through the RDS Data API
  transport's emulator.

    **The word "every" above is enforced, not asserted.** `packages/kit/src/db/rls-coverage.ts` reads
    the database catalog after the registered migrations have run and fails if **anything `app_user`
    can reach** — in any schema, of any relation kind — lacks RLS, lacks `FORCE`, has no policy, or
    has a policy that never reads the tenant setting. It asks about reachability rather than about a
    `tenant_id` column on purpose: a naming convention is not a mechanism, and a table keyed on
    `org_id`, a table in another schema, and a view over a protected table were each demonstrated to
    leak while a convention-based check stayed green. Reachability is the INHERITED kind: privileges
    pass through role membership, so the check asks `pg_has_role` rather than matching grants written
    directly to `app_user` — a table granted to a role `app_user` merely belongs to was demonstrated
    to leak while an earlier, direct-grant version of this same check stayed green. A view or
    materialized view cannot carry RLS at all, so a reachable one must be named as a deliberate
    exemption. The check runs on both engines.

    It exists because it was needed: a tenant-scoped table created without its six-line RLS block
    previously passed every gate while permitting cross-tenant reads and writes.

    **A precondition SSSB cannot check for you.** RLS — including `FORCE` — is bypassed
    outright by a role holding `SUPERUSER` or `BYPASSRLS`. The `SssbApp` construct (`packages/cdk/src/sssb-app.js`) wires `DATABASE_URL` to the
    database's master credentials, so on that path the application connects as the table owner and
    `FORCE` is what stands between it and every tenant's rows. Confirm the role you deploy with has
    neither attribute — `SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user` —
    and see the `db-role-not-superuser` row in `docs/cutover-checklist.md`. A report that RLS is
    bypassable by a superuser connection is a known non-finding; a report that SSSB encourages
    deploying as one is very much in scope.

    **Three framework tables are deliberately exempt from tenant isolation on READS**, and a report
    that any tenant can read them is a known non-finding. All are INFRA tables read while resolving who
    is calling — before a tenant context exists — so `app_user` holds a cross-tenant `SELECT` on each
    that no policy narrows: `tenants` (`packages/kit/src/db/migrations/0001_tenants.ts`), the tenant
    registry itself; `organizations` (`packages/kit/src/db/migrations/0003_organizations.ts`), which
    holds a team's slug and display name; and `service_keys`
    (`packages/kit/src/db/migrations/0005_service_keys.ts`), which holds only PUBLIC key material —
    its boundary is cryptographic, a caller proving possession of the matching private key.

    `tenants` and `service_keys` are `SELECT`-only. `organizations` also grants `INSERT` (of a team's
    tenant, slug and name), `UPDATE` (of its name) and `DELETE`, so a request can create, rename and
    delete teams (`packages/kit/src/db/migrations/0018_organizations_write.ts`), and those writes are
    NOT exempt: row-level security confines each to the request's own tenant (a write with no tenant
    context lands nowhere), a new team may not take a slug another tenant's team holds (a team's slug
    is its inbound mail address, resolved across tenants; the gaps that remain are
    safeinsights/sssb#211), and `TRUNCATE`, which ignores row-level security, is not granted. Which person may write which team of their tenant is
    `authorize()`'s decision (below). The table's owner is not held to those policies (RLS is enabled,
    not forced): it is the privileged path that seeds teams, and a request never writes as it.

    The coverage check proves all of this from the catalog. An exempt table may hold no privilege but
    `SELECT` unless its entry declares the write, and each declared write must be held, on a table with
    row-level security enabled and an owner whose privileges `app_user` does not hold, admitted by some
    permissive policy, and every permissive policy that admits it must read the tenant setting in each
    expression that write evaluates. It reads the ACLs —
    table grants **and column grants**, every privilege other than `SELECT` — rather than
    `has_table_privilege`, because that function reports table-level privileges only, and a
    column-level `GRANT UPDATE (name)` was demonstrated to let `app_user` rewrite every row of the
    tenant registry while the check reported nothing. The exemption list, with each table's declared
    writes, lives in that same file and is pinned by an assertion, so changing either fails until this
    section is updated too. A way to make any of them leak something beyond the above — to write
    another tenant's team, or to reach tenant CONTENT through them — is very much in scope.

- **Authorization.** `authorize()` is the single choke point for resource-level decisions. A build-time
  scan fails any mutating API route that neither calls it nor carries a justified exemption.
- **Service-to-service auth.** RS256 JWTs, audience-pinned, with a required `iat`/`exp` and a maximum
  age. Key material is per-org.
- **Webhook signatures.** Outbound deliveries are signed; inbound webhooks are verified before the
  handler runs, including freshness and single-use tokens. Note the recorded limit on the single-use
  half: the inbound replay store is an in-process map (`packages/kit/src/service-auth/mailgun.ts`), so
  it dedupes within one process, not across a multi-instance deployment. Timestamp freshness is the
  primary, stateless guard; making the token guard global is a cutover item, not a finding.
- **The production fail-closed guard.** A production build refuses to boot with fake adapters. See
  below — this is the one most worth understanding before you report on it.

## The simulated world, and why `/api/simulator/*` is unauthenticated

In simulated mode SSSB ships a **deliberately unauthenticated** developer surface: you can
read any caught email, become any person without a password, jump the world clock, and reset
everything. That is not an oversight — it is what makes the local development loop work with no
credentials and no network, and it is documented behaviour.

It is gated by **mode, not by role**, and the mode is fail-closed:

- A production build (`NODE_ENV=production`) that would use fake adapters **throws on boot** rather
  than serving them (`packages/kit/src/adapters/index.ts`). A deployment must set `APP_MODE=real`.
- The only ways past that guard are `DEMO_MODE=1` and `E2E_BUILD=1`. Both are explicit opt-ins that
  cannot be triggered by forgetting something, and the `SssbApp` construct fails `cdk synth` unless the
  server's final environment pins `APP_MODE=real` and carries neither flag
  (`packages/cdk/src/sssb-app.test.js` sees it fail).

**In scope:** any way to reach a simulator route, or fake adapters generally, in a build that has not
explicitly opted in. That is a real vulnerability and we want to hear about it.

**Not in scope:** the simulator surface being open in a build that _has_ opted in — a demo deployment
is a shared world by construction, and `docs/cutover-checklist.md` carries a row (`demo-url`) requiring
that exposure decision to be recorded before any public demo URL ships.

## Also not in scope

- **Adapters marked `AUTHORED — CUTOVER`.** These are written against a vendor SDK and have never been
  run against the real service. They are typechecked, not verified, and say so in a header comment.
  Their cutover row names the proof each one owes.
- **`PLACEHOLDER_` values** in `apps/showcase/config/params.ts`. They are placeholders, not secrets.
- Findings that require an attacker to already have local filesystem or shell access to a developer's
  machine.
- Dependency CVEs with no demonstrated path to exploitation here — Dependabot already watches those.

## For adopters

If you have built on SSSB, a vulnerability in **your** deployment is yours to handle; this
policy covers SSSB. But if the root cause is a shape SSSB gave you, please report it
here too, because every other adopter has the same shape.
