import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { databaseNameFor } from '../../packages/cdk/src/database-name.js'
import { CreateError, parseArgs, RESERVED_DATABASE_NAMES } from '../../packages/create/src/args.js'

/**
 * `@sssb/create`'s command line (packages/create/src/args.js, ADR-0014 P12): what each flag accepts, what it refuses,
 * and what is derived when a flag is left out.
 */
describe('@sssb/create: arguments', () => {
    it('derives the slug from the directory and the display name from the slug', () => {
        const options = parseArgs(['some/where/acme-research'])
        expect(options).toMatchObject({ dir: 'some/where/acme-research', slug: 'acme-research', name: 'Acme Research' })
        expect(options).toMatchObject({ repo: null, owners: [], sssb: null, workflowRef: null, yes: false })
    })

    it('takes every flag, in both spellings', () => {
        const ref = 'a'.repeat(40)
        const options = parseArgs([
            'ws',
            '--slug',
            'console',
            '--name=Pages Console',
            '--repo',
            'acme/pages',
            '--owner',
            'jdoe',
            '--owner=@acme/devs',
            '--owner',
            '@jdoe',
            '--sssb',
            '0.2.0',
            `--workflow-ref=${ref}`,
            '--yes',
        ])
        expect(options).toMatchObject({
            slug: 'console',
            name: 'Pages Console',
            repo: 'acme/pages',
            owners: ['@jdoe', '@acme/devs'],
            sssb: '0.2.0',
            workflowRef: ref,
            yes: true,
        })
    })

    it.each([
        [['My App'], /pass one with --slug/],
        [['ws', '--slug', 'Acme'], /not a valid slug/],
        [['ws', '--slug', '1acme'], /not a valid slug/],
        [['ws', '--slug', 'user'], /a word Aurora PostgreSQL reserves/],
        [['ws', '--slug', `a${'-b'.repeat(40)}`], /too long/],
        [['ws', '--repo', 'research'], /owner\/name/],
        [['ws', '--repo', 'acme/research.git'], /owner\/name/],
        [['ws', '--owner', 'not a handle'], /@user or @org\/team/],
        [['ws', '--workflow-ref', 'main'], /full commit SHA/],
        [['ws', '--slug'], /--slug needs a value/],
        [['ws', '--slug', 'a', '--slug', 'b'], /given twice/],
        [['ws', '--name', ' '], /--name is empty/],
        [['ws', '--frobnicate'], /unknown option/],
        [['ws', 'Acme Research'], /--name "Acme Research"/],
        [[], /name the directory/],
    ])('refuses %j', (argv, message) => {
        expect(() => parseArgs(argv)).toThrow(CreateError)
        expect(() => parseArgs(argv)).toThrow(message)
    })

    it('asks for nothing else with --help', () => {
        expect(parseArgs(['--help']).help).toBe(true)
    })

    // The generator depends on no SSSB package, so it carries a copy of @sssb/cdk's reserved database names; a slug
    // the construct refuses at synth must be refused where it is chosen, and no other.
    it("refuses exactly the database names @sssb/cdk's construct refuses", () => {
        const source = readFileSync(path.resolve(__dirname, '../../packages/cdk/src/database-name.js'), 'utf8')
        const literal = /const RESERVED = new Set\(\[([\s\S]*?)\]\)/.exec(source)?.[1]
        expect(literal).toBeDefined()
        const cdk = new Set([...(literal ?? '').matchAll(/'([^']+)'/g)].map((m) => m[1]))
        expect([...RESERVED_DATABASE_NAMES].sort()).toEqual([...cdk].sort())
        for (const name of RESERVED_DATABASE_NAMES) {
            expect(() => databaseNameFor(name.replaceAll('_', '-'))).toThrow(/reserves/)
            expect(() => parseArgs(['ws', '--slug', name.replaceAll('_', '-')])).toThrow(/reserves/)
        }
    })
})
