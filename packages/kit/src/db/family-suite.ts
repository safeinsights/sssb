import type { Kysely } from 'kysely'
import type { Migration } from 'kysely/migration'
// TYPE-ONLY (erased): the proof runner reads the app's seam, and only the loader below may bring it in.
import type { runRlsProofs } from './rls-proof-runner'
import type { DB } from './schema'

/**
 * The SUITE half of the database family (the runtime half, and what a family is, are `./family.ts`): what the
 * conformance suite (`../testing/conformance/db.ts`) and the contract runner (`../testing/contract.ts`) load to migrate
 * a database and prove its isolation. Nothing on the request path imports it, so the proofs, the app's among them,
 * never enter a server build.
 *
 * Every member is a LOADER, not a value. The migration registry composes the app's migrations and the proof runner the
 * app's proofs, both through `@sssb/app-config/*`, and collecting a test must not reach the seam: the suites import
 * this module when they are collected, and it imports nothing at all until a loader runs.
 *
 * The proofs are in two halves: the framework's (`./rls-proofs.ts`, `./rls-coverage.ts`, `./owner-pass.ts`, composed
 * by `./rls-proof-runner.ts`) and the app's (`src/app-config/db/rls-proofs.ts`, through the seam), which belongs to
 * the app's family too: it switches roles and sets the tenant the way this family's scope does, so an app on another
 * database writes its proofs for that database.
 */
export interface DbFamilySuite {
    /** Loads the framework's migrations, and the registry composing them with the app's. */
    migrations(): Promise<{
        frameworkMigrations: Record<string, Migration>
        migrations: Record<string, Migration>
    }>
    /** Loads the migrator, which applies the composed registry (or any registry it is given). */
    migrator(): Promise<{
        migrateToLatest(db: Kysely<DB>): Promise<void>
        migrateRegistryToLatest(db: Kysely<DB>, registry: Record<string, Migration>): Promise<void>
    }>
    /** Loads the isolation proof suite: the framework's proofs and the app's, as one run. */
    proofs(): Promise<{ runRlsProofs: typeof runRlsProofs }>
}

/** The Postgres family's suite half, for the family `./family.ts` runs on. */
export const familySuite: DbFamilySuite = {
    migrations: () => import('./migrations/index'),
    migrator: () => import('./migrate'),
    proofs: () => import('./rls-proof-runner'),
}
