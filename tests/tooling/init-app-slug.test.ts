import { spawnSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * `pnpm init-app <slug>` names the app's directory, its package and its contract database after the slug, so a
 * slug that is already a name in the workspace collides. These pin the refusals that exist because of the two
 * namespaces an app slug shares: Vitest project names (`vitest.config.ts`, where Vitest refuses two projects of
 * one name) and workspace package names (where `pnpm --filter <slug>` would match two packages).
 *
 * Every run passes `--dry-run`, which validates the slug first and then writes nothing, so running it in the
 * real tree is safe even when the guard under test is the thing that is broken.
 */
const ROOT = path.resolve(import.meta.dirname, '../..')

function initApp(slug: string) {
    const tsx = path.join(ROOT, 'node_modules/.bin/tsx')
    return spawnSync(tsx, [path.join(ROOT, 'scripts/init-app.ts'), slug, '--dry-run'], {
        cwd: ROOT,
        encoding: 'utf8',
    })
}

/** Every literal `name: '…'` a vitest config gives a project (apps get theirs from `apps/*`, not a literal). */
function projectNames(): string[] {
    const names = new Set<string>()
    for (const config of ['vitest.config.ts', 'vitest.contract.config.ts']) {
        const source = readFileSync(path.join(ROOT, config), 'utf8')
        for (const match of source.matchAll(/\bname:\s*'([^']+)'/g)) names.add(match[1])
    }
    return [...names].sort()
}

/**
 * The package names of the apps' deployments (`apps/<app>/infra`), read from the tree the suite runs in: in the
 * adoption probe's renamed and ejected tree there is no `showcase-infra`, and the survivor's is `<slug>-infra`.
 */
function infraPackageNames(): string[] {
    return readdirSync(path.join(ROOT, 'apps'))
        .map((app) => path.join(ROOT, 'apps', app, 'infra/package.json'))
        .filter((file) => existsSync(file))
        .map((file) => (JSON.parse(readFileSync(file, 'utf8')) as { name: string }).name)
        .sort()
}

describe('init-app slug refusals', () => {
    it('reads the infra package names it is about to check, so an empty list cannot pass for success', () => {
        expect(infraPackageNames().length).toBeGreaterThan(0)
    })

    it.each(infraPackageNames())('refuses "%s", the name of an app\'s infra package', (slug) => {
        const result = initApp(slug)
        expect(result.status).toBe(1)
        expect(result.stderr).toContain(`"${slug}"`)
    })

    it('reads the project names it is about to check, so an empty list cannot pass for success', () => {
        expect(projectNames()).toEqual(expect.arrayContaining(['kit', 'repo']))
    })

    it.each(projectNames())('refuses "%s", a vitest project name', (slug) => {
        const result = initApp(slug)
        expect(result.status).toBe(1)
        expect(result.stderr).toMatch(/reserved/)
    })

    it.each(['repo', 'sssb', 'spike-kysely-pglite'])('refuses "%s"', (slug) => {
        const result = initApp(slug)
        expect(result.status).toBe(1)
        expect(result.stderr).toContain(`"${slug}"`)
    })

    // The deployed database is named from the slug (`databaseNameFor`, packages/cdk/src/database-name.js), and Aurora
    // refuses a name over 63 characters or one its engine reserves, so init-app refuses those slugs up front.
    it.each(['user', 'select', 'rdsadmin', 'a'.repeat(64)])('refuses "%s", which cannot name the database', (slug) => {
        const result = initApp(slug)
        expect(result.status).toBe(1)
        expect(result.stderr).toContain("cannot name the app's database")
    })

    it('takes a dashed slug, whose database name is the slug with underscores', () => {
        const result = initApp('acme-corp')
        expect(result.status, result.stderr).toBe(0)
    })

    it('still takes an ordinary slug (the positive control: a refusal test that cannot fail proves nothing)', () => {
        const result = initApp('acme')
        expect(result.status).toBe(0)
        expect(result.stderr).not.toMatch(/reserved|workspace package/)
    })
})
