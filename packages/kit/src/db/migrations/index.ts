import { appMigrations } from '@sssb/app-config/db/migrations'
import type { Migration } from 'kysely/migration'
import * as m0001 from './0001_tenants'
import * as m0003 from './0003_organizations'
import * as m0004 from './0004_jobs'
import * as m0005 from './0005_service_keys'
import * as m0008 from './0008_audit_events'
import * as m0009 from './0009_job_schedules'
import * as m0010 from './0010_webhooks'
import * as m0011 from './0011_notifications'
import * as m0012 from './0012_inbound_email'
import * as m0013 from './0013_agreements'
import * as m0014 from './0014_audit_credential'
import * as m0015 from './0015_app_user_grant'
import * as m0016 from './0016_audit_detail'
import * as m0017 from './0017_job_requester'
import * as m0019 from './0019_job_attempts'
import * as m0020 from './0020_job_runner_ref'
import * as m0021 from './0021_schedule_failures'

/**
 * Static migration registry (no filesystem scanning — bundles cleanly into the Lambda migrator and
 * runs identically on pglite, embedded-postgres, and Aurora). Composes the FRAMEWORK migrations
 * (0001–0999) with the app's registered migrations (src/app-config/db/migrations, ≥1001) exactly like
 * the schema composes framework tables with AppTables (ADR-0012). Kysely runs the merged set
 * name-sorted, so framework tables exist before any app table references them. Add new framework
 * migrations here in order; never edit an applied one.
 *
 * ORDER INDEPENDENCE. A database that already ran app migrations applies a NEW framework migration
 * AFTER them (../migrate.ts runs unordered for exactly that), while a fresh database runs it before
 * them. So a framework migration must have the same effect in either position. It names the objects it
 * touches, and never sweeps the catalog (`GRANT … ON ALL TABLES`, `ALTER DEFAULT PRIVILEGES`), which
 * would reach app tables on one path and not the other. The conformance suite's `migration-order` check
 * (../../testing/conformance/db.ts) compares the two schemas, and holds every app to its side of the numbering:
 * ≥1001, colliding with no framework name.
 */
export const frameworkMigrations: Record<string, Migration> = {
    '0001_tenants': m0001,
    '0003_organizations': m0003,
    '0004_jobs': m0004,
    '0005_service_keys': m0005,
    '0008_audit_events': m0008,
    '0009_job_schedules': m0009,
    '0010_webhooks': m0010,
    '0011_notifications': m0011,
    '0012_inbound_email': m0012,
    '0013_agreements': m0013,
    '0014_audit_credential': m0014,
    '0015_app_user_grant': m0015,
    '0016_audit_detail': m0016,
    '0017_job_requester': m0017,
    '0019_job_attempts': m0019,
    '0020_job_runner_ref': m0020,
    '0021_schedule_failures': m0021,
}

export const migrations: Record<string, Migration> = { ...frameworkMigrations, ...appMigrations }
