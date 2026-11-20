import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'
import { generate } from '../../packages/create/src/generate.js'
import { buildTemplate, filesUnder } from '../../packages/create/src/template.js'
import { applyFilePatch, parsePatch } from '../../packages/tools/src/remove-items/exact-patch.js'
import { makeTestTmpDir } from '../support/tmp-dir'

/**
 * `sssb remove-items` (adoption follow-up 2): the starter's Items slice taken out in one step, as a patch the
 * starter's own tree keeps true. These tests run the real CLI over an app the generator wrote from THIS repository's
 * starter (renamed `acme`, as an adopter's is), because that is the tree the patch has to apply to; the workspace's
 * gates over the result (typecheck, lint, unit and contract, knip, the e2e) are pack-and-consume's `generated` shape.
 */
const REPO = path.resolve(__dirname, '../..')
const CLI = path.join(REPO, 'packages/tools/bin/sssb.js')
const APP = 'apps/acme'

let template = ''
/** A fresh copy of the generated workspace's app, per test. */
let fresh: () => string
const read = (dir: string, file: string) => readFileSync(path.join(dir, file), 'utf8')

beforeAll(() => {
    template = path.join(makeTestTmpDir('remove-items-template-'), 'template')
    buildTemplate({ repoRoot: REPO, outDir: template })
    const ws = path.join(makeTestTmpDir('remove-items-ws-'), 'acme')
    generate({ templateDir: template, target: ws, slug: 'acme', name: "Acme's Research" })
    const pristine = path.join(ws, APP)
    fresh = () => {
        const copy = path.join(makeTestTmpDir('remove-items-app-'), 'acme')
        cpSync(pristine, copy, { recursive: true })
        return copy
    }
}, 120_000)

function removeItems(app: string, ...flags: string[]) {
    const result = spawnSync(process.execPath, [CLI, 'remove-items', '--app', app, ...flags], { encoding: 'utf8' })
    return { status: result.status, out: result.stdout, err: result.stderr }
}

/** Every file under a directory with a hash of what it holds: a refusal must leave this unchanged. */
function snapshot(dir: string) {
    return Object.fromEntries(
        filesUnder(dir).map((file) => [
            file,
            createHash('sha256')
                .update(readFileSync(path.join(dir, file)))
                .digest('hex'),
        ]),
    )
}

/** The files whose text names an item or the items. */
const mentionItems = (dir: string) =>
    filesUnder(dir)
        .filter((file) => !file.startsWith('infra/') && /\bitems?\b/i.test(read(dir, file)))
        .sort()

describe('the exact patch applier', () => {
    const patch = parsePatch(
        [
            'diff --git a/f.txt b/f.txt',
            '--- a/f.txt',
            '+++ b/f.txt',
            '@@ -1,7 +1,6 @@',
            ' a',
            ' b',
            ' c',
            '-DROP',
            ' d',
            ' e',
            ' f',
            '',
        ].join('\n'),
    )[0]!

    it('applies a hunk where it is, even when lines were added above it', () => {
        expect(applyFilePatch('a\nb\nc\nDROP\nd\ne\nf\n', patch)).toEqual({ ok: true, content: 'a\nb\nc\nd\ne\nf\n' })
        expect(applyFilePatch('new\na\nb\nc\nDROP\nd\ne\nf\ng\n', patch)).toEqual({
            ok: true,
            content: 'new\na\nb\nc\nd\ne\nf\ng\n',
        })
    })

    it('refuses a hunk whose lines changed, one that is not there, and one found twice', () => {
        expect(applyFilePatch('a\nb\nc\nCHANGED\nd\ne\nf\n', patch)).toMatchObject({ ok: false })
        expect(applyFilePatch(null, patch)).toMatchObject({ ok: false })
        const twice = 'a\nb\nc\nDROP\nd\ne\nf\na\nb\nc\nDROP\nd\ne\nf\n'
        expect(applyFilePatch(twice, patch)).toMatchObject({ ok: false, reason: expect.stringContaining('ambiguous') })
    })

    it('matches a hunk with less context (a change at the start or end of a file) wherever it now is, once', () => {
        const [head] = parsePatch(
            ['diff --git a/f b/f', '--- a/f', '+++ b/f', '@@ -1,3 +1,2 @@', '-GONE', ' x', ' y', ''].join('\n'),
        )
        expect(applyFilePatch('GONE\nx\ny\n', head!)).toMatchObject({ ok: true, content: 'x\ny\n' })
        expect(applyFilePatch('top\nGONE\nx\ny\nz\n', head!)).toMatchObject({ ok: true, content: 'top\nx\ny\nz\n' })
        expect(applyFilePatch('GONE\nx\ny\nGONE\nx\ny\n', head!)).toMatchObject({ ok: false })
    })

    it('deletes a file only when it holds exactly what the patch removes', () => {
        const [del] = parsePatch(
            [
                'diff --git a/f b/f',
                'deleted file mode 100644',
                '--- a/f',
                '+++ /dev/null',
                '@@ -1,2 +0,0 @@',
                '-one',
                '-two',
                '',
            ].join('\n'),
        )
        expect(applyFilePatch('one\ntwo\n', del!)).toEqual({ ok: true, content: null })
        expect(applyFilePatch('one\ntwo\nthree\n', del!)).toMatchObject({ ok: false })
        expect(applyFilePatch('one\n', del!)).toMatchObject({ ok: false })
    })
})

describe('sssb remove-items', () => {
    it('says what it would do with --dry-run, and writes nothing', () => {
        const app = fresh()
        const before = snapshot(app)
        const { status, out } = removeItems(app, '--dry-run')
        expect(status).toBe(0)
        expect(out).toContain('delete src/components/items-card.tsx')
        expect(out).toContain('delete src/app/api/items/route.ts')
        expect(out).toContain('edit   src/app-config/abilities.ts')
        expect(out).not.toContain('1001_items')
        expect(snapshot(app)).toEqual(before)
        expect(removeItems(app, '--dry-run', '--drop-migrations').out).toContain(
            'delete src/app-config/db/migrations/1001_items.ts',
        )
        expect(snapshot(app)).toEqual(before)
    })

    it("takes Next's stale dev type validator with it, which names a route that is gone", () => {
        const app = fresh()
        const validator = path.join(app, '.next/dev/types/validator.ts')
        mkdirSync(path.dirname(validator), { recursive: true })
        writeFileSync(validator, "export type Stale = typeof import('../../../src/app/api/items/route.js')\n")
        expect(removeItems(app, '--dry-run').status).toBe(0)
        expect(existsSync(validator)).toBe(true)
        expect(removeItems(app).status).toBe(0)
        expect(existsSync(path.dirname(validator))).toBe(false)
    })

    it('takes the code out and keeps the database half, registered, by default', () => {
        const app = fresh()
        const { status, out } = removeItems(app)
        expect(status, out).toBe(0)
        for (const gone of [
            'src/components/items-card.tsx',
            'src/app/api/items/route.ts',
            'src/domain/db/items.ts',
            'src/domain',
            'src/app/api/items',
            'tests/e2e/items.spec.ts',
        ])
            expect(existsSync(path.join(app, gone)), gone).toBe(false)
        // The e2e directory keeps a spec (an app with none fails `sssb check-e2e`): the Simulator's, which names no item.
        expect(readdirSync(path.join(app, 'tests/e2e'))).toEqual(['sign-in.spec.ts', 'simulator.spec.ts'])
        // The migrations a database may have recorded stay, registered, with the table's type and its proofs.
        expect(readdirSync(path.join(app, 'src/app-config/db/migrations')).sort()).toEqual([
            '1001_items.ts',
            '1002_items_keyset_index.ts',
            'index.ts',
        ])
        expect(read(app, 'src/app-config/db/migrations/index.ts')).toContain("'1002_items_keyset_index'")
        expect(mentionItems(app)).toEqual([
            'src/app-config/db/migrations/1001_items.ts',
            'src/app-config/db/migrations/1002_items_keyset_index.ts',
            'src/app-config/db/rls-proofs.ts',
            'src/app-config/db/schema.ts',
        ])
        expect(read(app, 'src/app-config/abilities.ts')).toContain('export type AppSubjectType = never')
        expect(out).toContain('The database half stayed')
    })

    it('takes the whole slice out with --drop-migrations, leaving the empty registrations', () => {
        const app = fresh()
        const { status, out } = removeItems(app, '--drop-migrations')
        expect(status, out).toBe(0)
        expect(mentionItems(app)).toEqual([])
        expect(readdirSync(path.join(app, 'src/app-config/db/migrations'))).toEqual(['index.ts'])
        expect(read(app, 'src/app-config/db/migrations/index.ts')).toContain(
            'appMigrations: Record<string, Migration> = {}',
        )
        expect(read(app, 'src/app-config/db/schema.ts')).toContain('export type AppTables = Record<never, never>')
        expect(read(app, 'src/app-config/messages.ts')).toContain("APP_NAMESPACES = ['welcome', 'dashboard'] as const")
        // The catalogs stay key-identical, and hold exactly the namespaces the app registers.
        const en = JSON.parse(read(app, 'messages/en.json'))
        const es = JSON.parse(read(app, 'messages/es.json'))
        expect(Object.keys(en)).toEqual(['welcome', 'dashboard'])
        expect(Object.keys(es)).toEqual(Object.keys(en))
        expect(out).toContain('delete the')
    })

    it('refuses, naming the file and writing nothing, when a file the slice removes was edited', () => {
        const app = fresh()
        writeFileSync(
            path.join(app, 'src/components/items-card.tsx'),
            `${read(app, 'src/components/items-card.tsx')}// mine\n`,
        )
        const before = snapshot(app)
        const { status, err } = removeItems(app, '--drop-migrations')
        expect(status).toBe(1)
        expect(err).toContain('nothing was changed')
        expect(err).toContain('src/components/items-card.tsx: it holds more than the starter wrote')
        expect(snapshot(app)).toEqual(before)
    })

    it('refuses when a line a hunk edits was changed, and when a file is already gone', () => {
        const app = fresh()
        const abilities = read(app, 'src/app-config/abilities.ts')
        expect(abilities).toContain("export type AppSubjectType = 'Item'")
        writeFileSync(
            path.join(app, 'src/app-config/abilities.ts'),
            abilities.replace("export type AppSubjectType = 'Item'", "export type AppSubjectType = 'Item' | 'Project'"),
        )
        rmSync(path.join(app, 'src/app/api/items/route.ts'))
        const before = snapshot(app)
        const { status, err } = removeItems(app)
        expect(status).toBe(1)
        expect(err).toContain('2 files are not what the starter wrote')
        expect(err).toContain('src/app-config/abilities.ts: it differs from the starter')
        expect(err).toContain('src/app/api/items/route.ts: it is not there')
        expect(snapshot(app)).toEqual(before)
    })

    it('keeps an adopter edit made elsewhere in a file it edits, wherever its hunks have moved', () => {
        const app = fresh()
        const abilities = read(app, 'src/app-config/abilities.ts')
        writeFileSync(
            path.join(app, 'src/app-config/abilities.ts'),
            abilities.replace("staffOrgSlug = 'ops'", "staffOrgSlug = 'ops' // mine"),
        )
        const demo = read(app, 'src/demo-static/app.tsx')
        writeFileSync(path.join(app, 'src/demo-static/app.tsx'), `// a header line the adopter added\n${demo}`)
        const { status, out } = removeItems(app, '--drop-migrations')
        expect(status, out).toBe(0)
        expect(read(app, 'src/app-config/abilities.ts')).toContain("staffOrgSlug = 'ops' // mine")
        expect(read(app, 'src/demo-static/app.tsx')).toMatch(/^\/\/ a header line the adopter added\n/)
        expect(mentionItems(app)).toEqual([])
    })

    it('refuses a second run, and --drop-migrations after the code half, without changing anything', () => {
        const app = fresh()
        expect(removeItems(app).status).toBe(0)
        const done = snapshot(app)
        for (const flags of [[], ['--drop-migrations']]) {
            const { status, err } = removeItems(app, ...flags)
            expect(status).toBe(1)
            expect(err).toContain('nothing was changed')
            expect(err).toContain('If the slice is already gone, there is nothing to do.')
        }
        expect(snapshot(app)).toEqual(done)
    })

    it('is told when it is not pointed at an app', () => {
        const dir = makeTestTmpDir('remove-items-empty-')
        writeFileSync(path.join(dir, 'package.json'), '{}')
        const { status, err } = removeItems(dir)
        expect(status).toBe(1)
        expect(err).toContain('is not an SSSB app')
        expect(removeItems(dir, '--surprise').err).toContain('unexpected --surprise')
    })
})
