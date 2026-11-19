// @ts-check
// `sssb remove-items [--app <dir>] [--drop-migrations] [--dry-run]`: takes the starter's example Items slice out of an app
// in one step, and leaves the app green. The first thing every adopter does is this sweep by hand over about fifteen
// files (docs/adopting.md, "To remove a slice"); this is that sweep as a patch the starter's own test keeps true.
//
// WHAT IT DOES. Two patches, `remove-items/code.patch` and `remove-items/database.patch` (a unified diff of the starter
// against the starter without Items, applied EXACTLY by ./exact-patch.js). The code half removes everything an app's
// code says about Items: the card, the route, the query, the ability, the catalog namespace, the dashboard's glue, the
// static demo's card, the specs, and the proofs of paging. It adds one e2e spec (sign in, reach the dashboard), because
// an app with no e2e spec fails `sssb check-e2e`. The database half removes the migrations, the table's type and its
// RLS proofs, and only runs with `--drop-migrations`.
//
// THE RULE FOR MIGRATIONS. A database that ran `1001_items` records it, and the migrator refuses to start when a migration
// it recorded is gone from the code (Kysely: "previously executed migration ... is missing"). So this command never
// deletes a migration unless it is told to: `--drop-migrations` is for an app whose database has never run them (a
// workspace just generated: delete the local `.data` too), and without it the migrations, `ItemsTable` and the RLS proofs
// of `items` stay, registered, which keeps every gate green and every recorded migration in place. Both halves are
// one choice, made once: the second half is not available after the first ran on its own.
//
// WHEN IT REFUSES. It computes every edit in memory first and writes only if every one applies. A file the starter wrote
// and the adopter has not touched inside a hunk applies, wherever the hunk has moved to; one they edited, deleted, or
// that is not there is named, with what is wrong, and NOTHING is written. Adopter-written code is never deleted silently.
import { existsSync, mkdirSync, readdirSync, readFileSync, rmdirSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { takeAppDir, takeFlag, UsageError } from '../app.js'
import { applyFilePatch, parsePatch } from '../remove-items/exact-patch.js'

const USAGE = 'usage: sssb remove-items [--app <dir>] [--drop-migrations] [--dry-run]'

/** @param {string} name */
const patchFile = (name) => readFileSync(new URL(`../remove-items/${name}.patch`, import.meta.url), 'utf8')

/**
 * @param {string[]} args
 * @returns {Promise<number>}
 */
export async function run(args) {
    if (args.includes('--help') || args.includes('-h')) {
        console.log(
            [
                USAGE,
                '',
                "Takes the starter's example Items slice out of the app (the card, the route, the query, the ability, the catalog",
                "namespace, the dashboard's and the static demo's card, the specs) and puts in one e2e spec that signs in.",
                '',
                '  --drop-migrations  also remove 1001_items, 1002_items_keyset_index, the table type and its RLS proofs. For an app whose',
                '                     database has never run them: delete the local `.data` after. A database that ran a migration',
                '                     records it, and the migrator refuses to start when it is gone from the code, so without this flag',
                '                     they stay, registered, and the app stays green.',
                '  --dry-run          say what would change, and change nothing.',
                '',
                'It refuses, naming each file, when the slice is not what the starter wrote, and writes nothing.',
            ].join('\n'),
        )
        return 0
    }
    const appDir = takeAppDir(args)
    const drop = takeFlag(args, '--drop-migrations')
    const dry = takeFlag(args, '--dry-run')
    if (args.length > 0) throw new UsageError(`sssb remove-items: unexpected ${args.join(' ')}\n${USAGE}`)
    if (!existsSync(path.join(appDir, 'src/app-config'))) {
        throw new UsageError(`sssb remove-items: ${appDir} has no src/app-config, so it is not an SSSB app\n${USAGE}`)
    }

    /** What each file holds now, as the plan builds on it: null is "not there". @type {Map<string, string | null>} */
    const state = new Map()
    /** @type {Map<string, 'add' | 'edit' | 'delete'>} */
    const actions = new Map()
    /** @param {string} file */
    const current = (file) => {
        if (!state.has(file)) {
            const full = path.join(appDir, file)
            state.set(file, existsSync(full) ? readFileSync(full, 'utf8') : null)
        }
        return /** @type {string | null} */ (state.get(file))
    }

    /** @type {string[]} */
    const problems = []
    for (const half of drop ? ['code', 'database'] : ['code']) {
        for (const patch of parsePatch(patchFile(half))) {
            const before = current(patch.path)
            const result = applyFilePatch(before, patch)
            if (!result.ok) {
                problems.push(`${patch.path}: ${result.reason}`)
                continue
            }
            state.set(patch.path, result.content)
            const was = actions.get(patch.path)
            actions.set(
                patch.path,
                result.content === null ? 'delete' : was === 'add' || before === null ? 'add' : 'edit',
            )
        }
        // The database half is a patch on what the code half leaves; after a refusal that state is a guess.
        if (problems.length > 0) break
    }

    if (problems.length > 0) {
        console.error(
            [
                `sssb remove-items: nothing was changed. ${problems.length === 1 ? 'One file is' : `${problems.length} files are`} not what the starter wrote, so removing the Items slice would mean guessing:`,
                ...problems.map((problem) => `  ${problem}`),
                '',
                'Restore each file and run this again, or take the slice out by hand: docs/adopting.md, "To remove a slice".',
                'If the slice is already gone, there is nothing to do.',
            ].join('\n'),
        )
        return 1
    }

    const where = path.relative(process.cwd(), appDir) || '.'
    const listing = [...actions].map(([file, action]) => `  ${action.padEnd(6)} ${file}`)
    if (dry) {
        console.log(
            [
                `sssb remove-items --dry-run, in ${where}${drop ? ' (--drop-migrations)' : ''}: this would`,
                ...listing,
                '',
                'Nothing was written.',
            ].join('\n'),
        )
        return 0
    }

    for (const [file, action] of actions) {
        const full = path.join(appDir, file)
        if (action === 'delete') {
            rmSync(full)
            pruneEmptyDirectories(path.dirname(full), appDir)
        } else {
            mkdirSync(path.dirname(full), { recursive: true })
            writeFileSync(full, /** @type {string} */ (state.get(file)))
        }
    }
    console.log(
        [
            `sssb remove-items: took the Items slice out of ${where}.`,
            ...listing,
            '',
            ...(drop
                ? [
                      'The migrations and the table are gone too. This is only safe for a database that never ran 1001_items: delete the',
                      `local data directory (${path.join(where, '.data')}) so the dev database starts from the new migration list, and number your`,
                      'first table 1001, as an app with no migrations does.',
                  ]
                : [
                      'The database half stayed: 1001_items, 1002_items_keyset_index, the `items` table type and its RLS proofs. A database',
                      'that ran them records them, and the migrator refuses a recorded migration that is gone. If no database ever did,',
                      'restore the app and run `sssb remove-items --drop-migrations` instead: the two halves are one choice, made once.',
                  ]),
            '',
            'Then run `pnpm verify`.',
        ].join('\n'),
    )
    return 0
}

/**
 * Removes `dir` and its parents while they are empty, stopping before `stop`.
 * @param {string} dir
 * @param {string} stop
 */
function pruneEmptyDirectories(dir, stop) {
    let at = dir
    while (path.resolve(at) !== path.resolve(stop) && existsSync(at) && readdirSync(at).length === 0) {
        rmdirSync(at)
        at = path.dirname(at)
    }
}
