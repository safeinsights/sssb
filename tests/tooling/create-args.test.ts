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
        // The display name: one line, the characters every file it lands in can carry, from a letter or a digit.
        [['ws', '--name', 'Line\nBreak'], /control character/],
        [['ws', '--name', 'Tab\there'], /control character/],
        [['ws', '--name', 'Bidi\u202Eoverride'], /control character/],
        [['ws', '--name', '*Emph* _und_ `code`'], /uses "\*" "`"/],
        [['ws', '--name', 'A & B <script>x</script>'], /uses "<" ">"/],
        [['ws', '--name', '${injection}'], /uses "\$" "\{" "\}"/],
        [['ws', '--name', 'Back\\slash'], /uses "\\"/],
        [['ws', '--name', '[link](http://evil)'], /uses "\[" "\]"/],
        [['ws', '--name', 'a|b'], /uses "\|"/],
        [['ws', '--name', '# Heading'], /must start with a letter or a digit/],
        // `_`, `~` and `#` only where markdown reads them as text.
        [['ws', '--name', 'Data _und_ Lab'], /a "_" that is not inside a word/],
        [['ws', '--name', 'Lab_'], /a "_" that is not inside a word/],
        [['ws', '--name', 'A ~ B ~ C'], /more than one "~"/],
        [['ws', '--name', 'Lab #'], /ends in a "#" of its own/],
        [['ws', '--name', 'Lab ##'], /ends in a "#" of its own/],
        [['ws', '--name', '-leading'], /must start with a letter or a digit/],
        [['ws', '--name', `''"x"`], /must start with a letter or a digit/],
        [['ws', '--name', "Rock''n roll"], /two apostrophes in a row/],
        [['ws', '--name', 'x'.repeat(61)], /too long: at most 60 columns/],
        [['ws', '--name', '研究'.repeat(16)], /too long/],
        [['ws', '--frobnicate'], /unknown option/],
        [['ws', 'Acme Research'], /--name "Acme Research"/],
        [[], /name the directory/],
    ])('refuses %j', (argv, message) => {
        expect(() => parseArgs(argv)).toThrow(CreateError)
        expect(() => parseArgs(argv)).toThrow(message)
    })

    it('makes a display name one line of single spaces', () => {
        expect(parseArgs(['ws', '--name', '  Acme   Research\u00A0Hub  ']).name).toBe('Acme Research Hub')
        expect(parseArgs(['ws', '--name', 'Ünïcødé 研究 🚀']).name).toBe('Ünïcødé 研究 🚀')
        expect(parseArgs(['ws', '--name', `O'Brien "Labs" R&D: 1/2 (beta)!`]).name).toBe(
            `O'Brien "Labs" R&D: 1/2 (beta)!`,
        )
    })

    // Each lands Prettier-clean and parseable in every file (tests/tooling/create-generate.test.ts generates them).
    it.each(['50% Study', 'A; B', 'Q&A = Help', 'Acme ~ Lab', 'Lab_1', 'snake_case_name', 'C# Lab', 'Lab #1', 'C#'])(
        'accepts %j',
        (name) => {
            expect(parseArgs(['ws', '--name', name]).name).toBe(name)
        },
    )

    // `npm create @sssb <dir> -- --slug x`: npm hands the `--` through.
    it('ignores a bare --', () => {
        expect(parseArgs(['ws', '--', '--slug', 'console', '--yes'])).toMatchObject({
            dir: 'ws',
            slug: 'console',
            yes: true,
        })
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
