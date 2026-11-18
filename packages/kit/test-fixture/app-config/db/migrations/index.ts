import type { Migration } from 'kysely/migration'
import * as m1001 from './1001_dockets'
import * as m1002 from './1002_dockets_due_on'
import * as m1003 from './1003_dockets_last_touched_at'
import * as m1004 from './1004_fixture_docket_clerk'

/**
 * The APP's migrations (the seam side of @sssb/kit/db/migrations, ADR-0012). Numbering convention: framework
 * 0001–0999, app ≥1001. Composed into the framework registry, which Kysely runs NAME-SORTED — so these
 * run AFTER every framework table exists.
 *
 * This set is the fixture's, and it never meets a host app's: two 1001+ sets over one database make
 * Kysely report corrupted migrations. So on real Postgres it gets a database of its own
 * (`sssb_contract`, @sssb/kit/adapters/real/db.contract.test.ts) beside each app's, and runs the same
 * composed proof runner there that it runs on pglite.
 */
export const appMigrations: Record<string, Migration> = {
    '1001_dockets': m1001,
    '1002_dockets_due_on': m1002,
    '1003_dockets_last_touched_at': m1003,
    '1004_fixture_docket_clerk': m1004,
}

/**
 * The cluster-wide roles these migrations create, beside the framework's `app_user` (@sssb/kit/db/app-roles.ts): the
 * contract suite's owner pass grants a later owner ADMIN on exactly these, and the conformance suite's `app-roles`
 * check fails a role the migrations create that is not named here, or a name here they do not create.
 */
export const appRoles = ['fixture_docket_clerk'] as const
