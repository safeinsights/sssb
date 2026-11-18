import { Kysely, sql } from 'kysely'

/**
 * `fixture_docket_clerk` — a cluster-wide role of the fixture's OWN, beside the framework's `app_user`, in the pattern an
 * app's migration that creates a role follows (the app guide, "Data"): created only where it does not exist yet (roles
 * are cluster-wide, so another database's migration may have made it), then granted, altered and granted on by name. It
 * is named in `appRoles` (./index.ts), which is what lets the contract suite's owner pass grant a later owner the ADMIN
 * its creator holds: without that, the ALTER and the GRANT TO app_user below fail on every pass after the first that
 * made the role (@sssb/kit/db/owner-pass.ts). It stays an ordinary role throughout (NOLOGIN, no other attribute, a
 * member of nothing), which the owner pass and the conformance suite's `app-roles` check both hold it to. Every
 * statement is one the RDS Data API runs as one call, and one Aurora's master user (`NOSUPERUSER CREATEROLE`) may make
 * holding ADMIN on the role; the GRANT on its own table needs no ADMIN at all.
 */
export async function up(db: Kysely<any>): Promise<void> {
    await sql`
        DO $$ BEGIN
            IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'fixture_docket_clerk') THEN
                CREATE ROLE fixture_docket_clerk NOLOGIN;
            END IF;
        END $$
    `.execute(db)
    await sql`GRANT SELECT ON dockets TO fixture_docket_clerk`.execute(db)
    await sql`ALTER ROLE fixture_docket_clerk SET statement_timeout = '5s'`.execute(db)
    // A membership, granted by whoever runs the migration (it needs ADMIN on the clerk): the grantor of a membership is
    // a dependency of the grantor's role, which is what the owner pass's teardown must clear before it can drop its
    // owner. It adds nothing to what app_user may do: app_user already holds SELECT on dockets, under its policy.
    await sql`GRANT fixture_docket_clerk TO app_user`.execute(db)
}

export async function down(db: Kysely<any>): Promise<void> {
    await sql`REVOKE fixture_docket_clerk FROM app_user`.execute(db)
    await sql`REVOKE SELECT ON dockets FROM fixture_docket_clerk`.execute(db)
}
