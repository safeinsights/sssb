import { Kysely, sql } from 'kysely'
import type { Migration } from 'kysely/migration'
import { describe, expect, test } from 'vitest'
import { openPglite, PGliteDialect } from '../adapters/fake/pglite-dialect'
import { buildPreUpdate, schemaOf } from '../testing/conformance/db'
import { migrateRegistryToLatest, migrateToLatest, outOfSequence } from './migrate'
import { frameworkMigrations } from './migrations/index'
import type { DB } from './schema'

/**
 * The upgrade guard's own behaviour. Framework migrations (0001–0999) and the app's (≥1001) are two sequences
 * interleaved by name, so a NEW framework migration arriving in an SSSB update sorts BEFORE app migrations the
 * database already ran. What depends on how an APP's migrations compose with the framework's (the numbering, and the
 * upgrade path to the same schema as a fresh database) is the conformance suite's `migration-order` check
 * (packages/kit/src/testing/conformance/db.ts), which every app runs against its own seam and the kit runs against
 * its fixture. The cases here exercise the guard on the framework's sequence or a synthetic registry, which no app's
 * migrations can change, so they run once, here.
 */

/** A migration from raw SQL, for the synthetic registry below. */
const step = (statement: string): Migration => ({ up: async (db) => void (await sql.raw(statement).execute(db)) })

describe('outOfSequence', () => {
    test('lets a framework migration run after app migrations, and nothing else out of order', () => {
        const executed = ['0001_a', '0013_b', '1001_c', '1006_f']
        expect(outOfSequence(executed, ['0014_new'])).toEqual([])
        expect(outOfSequence(executed, ['1007_g'])).toEqual([])
        // An app migration that sorts before an app migration already applied (two branches' 1005/1006).
        expect(outOfSequence(executed, ['1005_e', '1007_g'])).toEqual(['1005_e'])
        // A framework migration that sorts before one already applied: a renumbered or late framework one.
        expect(outOfSequence(executed, ['0012_late'])).toEqual(['0012_late'])
    })
})

describe('migrateToLatest', () => {
    test(
        'refuses, before running anything, a migration that would run after a later one of its own sequence',
        { timeout: 30_000 },
        async () => {
            // The framework sequence always has several migrations, so the case does not depend on what a seam
            // registers. outOfSequence's unit case covers the app sequence.
            const first = Object.keys(frameworkMigrations).sort()[0]!
            const db = new Kysely<DB>({ dialect: new PGliteDialect(openPglite()) })
            await migrateToLatest(db)
            // The database forgets it ran the FIRST framework migration, as if it had been renumbered below
            // migrations already applied.
            await sql`DELETE FROM kysely_migration WHERE name = ${first}`.execute(db)
            await expect(migrateToLatest(db)).rejects.toThrow(
                new RegExp(`out of order within their sequence: ${first}`),
            )
            await db.destroy()
        },
    )

    test(
        "a renamed migration still gets Kysely's missing-migration error, not the out-of-order one",
        { timeout: 30_000 },
        async () => {
            const renamed = Object.keys(frameworkMigrations).sort()[1]!
            const db = new Kysely<DB>({ dialect: new PGliteDialect(openPglite()) })
            await migrateToLatest(db)
            // The database ran a migration under a name the code no longer has; the code's name is pending.
            await sql`UPDATE kysely_migration SET name = ${`${renamed}_old_name`} WHERE name = ${renamed}`.execute(db)
            await expect(migrateToLatest(db)).rejects.toThrow(
                new RegExp(`previously executed migration ${renamed}_old_name is missing`),
            )
            await db.destroy()
        },
    )

    test(
        'an app migration that builds on the newest framework migration arrives with it, and both apply',
        { timeout: 30_000 },
        async () => {
            // A synthetic registry, so the case does not depend on what SSSB's newest migration happens to
            // be: the app's 1002 indexes a column that only the framework's 0002 adds.
            const registry: Record<string, Migration> = {
                '0001_base': step('CREATE TABLE base (id int)'),
                '0002_newest': step('ALTER TABLE base ADD COLUMN detail text'),
                '1001_app': step('CREATE TABLE app_thing (id int)'),
                '1002_app_on_newest': step('CREATE INDEX base_detail_idx ON base (detail)'),
            }
            const upgraded = new Kysely<DB>({ dialect: new PGliteDialect(openPglite()) })
            expect(await buildPreUpdate(upgraded, registry, '0002_newest')).toEqual(['0001_base', '1001_app'])

            await migrateRegistryToLatest(upgraded, registry)
            const ran = await sql<{ name: string }>`SELECT name FROM kysely_migration`.execute(upgraded)
            expect(ran.rows.map((row) => row.name).sort()).toEqual(Object.keys(registry).sort())

            const fresh = new Kysely<DB>({ dialect: new PGliteDialect(openPglite()) })
            await migrateRegistryToLatest(fresh, registry)
            expect(await schemaOf(upgraded)).toEqual(await schemaOf(fresh))
            await upgraded.destroy()
            await fresh.destroy()
        },
    )
})
