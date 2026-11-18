import { readFileSync } from 'node:fs'
import path from 'node:path'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'
import {
    conformanceProblems,
    CONFORMANCE_SUITES,
    kitIntegrities,
    lockfileMoves,
    lockfileProblems,
    seamPeerProblems,
    shippedFileProblems,
    tscErrors,
    undeclaredImports,
} from '../../scripts/pack-and-consume/checks.mjs'
import { applyWorkaround, WORKAROUNDS } from '../../scripts/pack-and-consume/workarounds.mjs'

/**
 * scripts/pack-and-consume.mjs is a CI gate (ADR-0014 P2) whose checks read what pnpm, tsc and Vitest
 * wrote. Each check is pinned here against an input that must FAIL, so none of them can pass by not
 * recognising what it was given.
 */

/** A pnpm 11 lockfile (v9) cut down to every place an @sssb package appears, as the job's install writes them. */
const GOOD_LOCKFILE = `lockfileVersion: '9.0'

importers:

  apps/console:
    dependencies:
      '@sssb/app-config':
        specifier: link:./src/app-config
        version: link:src/app-config
      '@sssb/kit':
        specifier: file:../../../tarballs/sssb-kit-0.1.0.tgz
        version: file:../tarballs/sssb-kit-0.1.0.tgz(@sssb/app-config@apps+console+src+app-config)(react@19.2.9)

packages:

  '@sssb/kit@file:../tarballs/sssb-kit-0.1.0.tgz':
    resolution: {integrity: sha512-abc, tarball: file:../tarballs/sssb-kit-0.1.0.tgz}
    version: 0.1.0
    peerDependencies:
      '@sssb/app-config': '*'
      react: ~19.2.8
    peerDependenciesMeta:
      '@sssb/app-config':
        optional: true

snapshots:

  '@sssb/kit@file:../tarballs/sssb-kit-0.1.0.tgz(@sssb/app-config@apps+console+src+app-config)(react@19.2.9)':
    dependencies:
      '@sssb/app-config': link:apps/console/src/app-config
      react: 19.2.9
`

describe('lockfileProblems', () => {
    it('accepts the tarball and the link, and sees each', () => {
        const { problems, seen } = lockfileProblems(GOOD_LOCKFILE)
        expect(problems).toEqual([])
        expect(seen).toEqual(
            expect.arrayContaining([
                'importers: @sssb/app-config -> link:src/app-config',
                'importers: @sssb/kit -> file:../tarballs/sssb-kit-0.1.0.tgz',
                'packages: @sssb/kit@file:../tarballs/sssb-kit-0.1.0.tgz',
                'snapshots: @sssb/app-config -> link:apps/console/src/app-config',
            ]),
        )
    })

    it('fails a framework resolved from the registry, in every place pnpm records it', () => {
        const registry = GOOD_LOCKFILE.replaceAll('file:../tarballs/sssb-kit-0.1.0.tgz', '0.1.0').replace(
            'specifier: 0.1.0',
            'specifier: ^0.1.0',
        )
        const { problems } = lockfileProblems(registry)
        expect(problems.some((p) => p.includes('importers') && p.includes('@sssb/kit resolves to 0.1.0'))).toBe(true)
        expect(problems.some((p) => p.includes('packages') && p.includes('@sssb/kit@0.1.0'))).toBe(true)
        expect(problems.some((p) => p.includes('snapshots') && p.includes('@sssb/kit@0.1.0'))).toBe(true)
    })

    it('fails a seam that is anything but a link', () => {
        const fetched = GOOD_LOCKFILE.replace('version: link:src/app-config', 'version: 1.0.0').replace(
            "'@sssb/app-config': link:apps/console/src/app-config",
            "'@sssb/app-config': file:../app-config.tgz",
        )
        const { problems } = lockfileProblems(fetched)
        expect(problems).toHaveLength(2)
        expect(problems.every((p) => p.includes('@sssb/app-config'))).toBe(true)
    })

    it("fails the framework linked rather than installed from the tarball (a link would be this repo's source)", () => {
        const linked = GOOD_LOCKFILE.replace(
            'version: file:../tarballs/sssb-kit-0.1.0.tgz(@sssb/app-config@apps+console+src+app-config)(react@19.2.9)',
            'version: link:../../packages/kit',
        )
        expect(lockfileProblems(linked).problems).toEqual([
            expect.stringContaining('@sssb/kit resolves to link:../../packages/kit'),
        ])
    })

    it('fails closed on an @sssb line it cannot classify', () => {
        const odd = GOOD_LOCKFILE.replace('lockfileVersion', "overrides:\n  '@sssb/kit': 0.0.9\n\nlockfileVersion")
        expect(lockfileProblems(odd).problems).toEqual([expect.stringContaining('cannot classify')])
    })
})

describe('seamPeerProblems', () => {
    const pinned = { name: '@sssb/kit', peerDependenciesMeta: { '@sssb/app-config': { optional: true } } }

    it('accepts the seam as an optional peer in peerDependenciesMeta alone', () => {
        expect(seamPeerProblems(pinned)).toEqual([])
    })

    it('fails the seam listed in peerDependencies, which makes pnpm 11 fetch it', () => {
        expect(seamPeerProblems({ ...pinned, peerDependencies: { '@sssb/app-config': '*' } })).toEqual([
            expect.stringContaining('fetch it from the registry'),
        ])
    })

    it('fails a seam that is not an optional peer at all, and a manifest of another name', () => {
        expect(seamPeerProblems({ name: '@sssb/core' })).toHaveLength(2)
    })
})

describe('tscErrors', () => {
    it("tells the framework's errors from the app's by the framework's place in the store", () => {
        const output = [
            "../../node_modules/.pnpm/@sssb+kit@file+..+tarballs+sssb-kit-0.1.0.tgz_abc/node_modules/@sssb/kit/src/db/keyset.ts(3,1): error TS2532: Object is possibly 'undefined'.",
            "src/app/[locale]/page.tsx(9,2): error TS4111: Property 'CI' comes from an index signature.",
            // An app file NAMED like the framework is still the app's.
            'src/vendor/@sssb/kit/shim.ts(1,1): error TS2307: Cannot find module.',
            "error TS6053: File 'missing.ts' not found.",
            'a line that is not an error',
        ].join('\n')
        expect(tscErrors(output).map((e) => [e.owner, e.code])).toEqual([
            ['kit', 'TS2532'],
            ['app', 'TS4111'],
            ['app', 'TS2307'],
            ['app', 'TS6053'],
        ])
    })
})

describe('conformanceProblems', () => {
    const kitDirs = {
        console: ['/ws/apps/console/node_modules/@sssb/kit', '/ws/node_modules/.pnpm/kit-a/node_modules/@sssb/kit'],
    }
    const ran = (dir: string, statuses: string[]) =>
        CONFORMANCE_SUITES.map((suite) => ({
            name: `${dir}/${suite}`,
            assertionResults: statuses.map((status) => ({ status })),
        }))

    it('accepts every suite run from the app’s own copy, by either spelling of its path', () => {
        expect(conformanceProblems({ testResults: ran(kitDirs.console[1], ['passed']) }, kitDirs)).toEqual([])
        expect(conformanceProblems({ testResults: ran(kitDirs.console[0], ['passed']) }, kitDirs)).toEqual([])
    })

    it("fails a suite that ran only from ANOTHER app's copy", () => {
        const problems = conformanceProblems(
            { testResults: ran('/ws/node_modules/.pnpm/kit-b/node_modules/@sssb/kit', ['passed']) },
            kitDirs,
        )
        expect(problems).toHaveLength(CONFORMANCE_SUITES.length)
    })

    it('fails a suite that was skipped whole, collected nothing, or failed', () => {
        expect(conformanceProblems({ testResults: ran(kitDirs.console[1], ['skipped']) }, kitDirs)).toHaveLength(
            CONFORMANCE_SUITES.length,
        )
        expect(conformanceProblems({ testResults: ran(kitDirs.console[1], []) }, kitDirs)).toHaveLength(
            CONFORMANCE_SUITES.length,
        )
        expect(
            conformanceProblems({ testResults: ran(kitDirs.console[1], ['passed', 'failed']) }, kitDirs),
        ).toHaveLength(CONFORMANCE_SUITES.length)
    })

    it("fails an app's own required test that did not run, even when the kit suites all passed", () => {
        const own = '/ws/apps/console/src/seam-identity.test.ts'
        const kitRan = ran(kitDirs.console[1], ['passed'])
        expect(conformanceProblems({ testResults: kitRan }, kitDirs, { console: [own] })).toEqual([
            'console: seam-identity.test.ts did not run',
        ])
        const withOwn = [...kitRan, { name: own, assertionResults: [{ status: 'passed' }] }]
        expect(conformanceProblems({ testResults: withOwn }, kitDirs, { console: [own] })).toEqual([])
    })

    it('fails an empty report', () => {
        expect(conformanceProblems({}, kitDirs)).toHaveLength(CONFORMANCE_SUITES.length)
    })
})

describe('the workaround register', () => {
    it('refuses a workaround nobody registered', () => {
        expect(() => applyWorkaround('not-registered')).toThrow(/unregistered workaround/)
    })

    it('ties every workaround to a step of ADR-0014 that removes it', () => {
        for (const [id, workaround] of Object.entries(WORKAROUNDS)) {
            expect(workaround.removedBy, id).toMatch(/^P\d+$/)
            expect(workaround.what.length, id).toBeGreaterThan(40)
        }
    })

    it('holds no workaround a step that has landed was to remove', () => {
        // P3 removed its four (types-pg, undeclared-typescript, demo-presets-seam-skipped,
        // strict-flags-kit-baseline). Raise this as each later step lands.
        const landed = new Set(['P1', 'P1b', 'P2', 'P3'])
        for (const [id, workaround] of Object.entries(WORKAROUNDS))
            expect(landed.has(workaround.removedBy), id).toBe(false)
    })
})

describe('shippedFileProblems', () => {
    const shipped = ['package.json', 'LICENSE', 'src/theme.ts', 'src/testing/tmp-dir.ts', ...CONFORMANCE_SUITES]

    it('accepts source plus exactly the conformance suites', () => {
        expect(shippedFileProblems(shipped)).toEqual([])
    })

    it('refuses any other test or story file, and anything of the fixture', () => {
        expect(
            shippedFileProblems([
                ...shipped,
                'src/core/roles.test.ts',
                'src/components/app-header.stories.tsx',
                'src/demo-static/world-invite.test.tsx',
                'src/adapters/real/db.contract.test.ts',
                'test-fixture/app-config/seed.ts',
            ]),
        ).toHaveLength(5)
    })

    it('refuses a tarball missing a conformance suite', () => {
        expect(shippedFileProblems(shipped.filter((file) => file !== CONFORMANCE_SUITES[0]))).toEqual([
            `${CONFORMANCE_SUITES[0]}: a conformance suite is not shipped`,
        ])
    })

    it("matches packages/kit/package.json's files allowlist, which re-includes exactly the suites", () => {
        const manifest = JSON.parse(
            readFileSync(path.resolve(import.meta.dirname, '../../packages/kit/package.json'), 'utf8'),
        ) as { files: string[] }
        const negated = manifest.files.filter((entry) => entry.startsWith('!'))
        const reincluded = manifest.files.slice(Math.max(...negated.map((entry) => manifest.files.indexOf(entry))) + 1)
        expect(manifest.files[0]).toBe('src')
        expect(negated).toEqual(['!src/**/*.test.ts', '!src/**/*.test.tsx', '!src/**/*.stories.tsx'])
        expect([...reincluded].sort()).toEqual([...CONFORMANCE_SUITES].sort())
    })
})

describe('undeclaredImports', () => {
    const manifest = {
        name: '@sssb/kit',
        dependencies: { kysely: '^0.29.7' },
        peerDependencies: { next: '^16.4.6' },
        peerDependenciesMeta: { '@sssb/app-config': { optional: true } },
    }
    const builtins = ['fs', 'path']
    // What the job uses: TypeScript's own reading of a file's imports.
    const specifiersOf = (text: string) => ts.preProcessFile(text, true, true).importedFiles.map((f) => f.fileName)

    it('names an undeclared package, by its package name, with the files that import it', () => {
        const sources = [
            {
                file: 'src/a.ts',
                text: "import { sql } from 'kysely'\nimport ts from 'typescript'\nimport { x } from '@scope/pkg/deep/path'",
            },
            { file: 'src/b.ts', text: "const m = await import('typescript')" },
        ]
        expect(Object.fromEntries(undeclaredImports(sources, manifest, builtins, specifiersOf))).toEqual({
            typescript: ['src/a.ts', 'src/b.ts'],
            '@scope/pkg': ['src/a.ts'],
        })
    })

    it('accepts dependencies, peers, the seam, the package itself, builtins and relative paths', () => {
        const text = [
            "import { cookies } from 'next/headers'",
            "import { Migrator } from 'kysely/migration'",
            "import { appMigrations } from '@sssb/app-config/db/migrations'",
            "import { x } from '@sssb/kit/core/jobs'",
            "import { readFileSync } from 'node:fs'",
            "import path from 'path'",
            "import { y } from './local'",
        ].join('\n')
        expect(undeclaredImports([{ file: 'src/c.ts', text }], manifest, builtins, specifiersOf).size).toBe(0)
    })

    it('ignores test and story files, and module names in comments and strings', () => {
        const sources = [
            { file: 'src/a.test.ts', text: "import { z } from 'vitest'" },
            { file: 'src/a.stories.tsx', text: "import { Story } from '@ladle/react'" },
            {
                file: 'src/d.ts',
                text: "/** e.g. import { a } from 'left-pad' */\n// from 'right-pad'\nconst s = `from '${'x'}'`\nexport const d = s",
            },
        ]
        expect(undeclaredImports(sources, manifest, builtins, specifiersOf).size).toBe(0)
    })

    it('reads the conformance suites, which ship, as source', () => {
        const suite = CONFORMANCE_SUITES[0] as string
        const found = undeclaredImports(
            [{ file: suite, text: "import { z } from 'left-pad'" }],
            manifest,
            builtins,
            specifiersOf,
        )
        expect(Object.fromEntries(found)).toEqual({ 'left-pad': [suite] })
    })

    it('still sees an import after a string that looks like a comment opener', () => {
        // A regex comment-stripper reads '/api/*' as the start of a comment and hides what follows.
        const text = "const glob = '/api/*'\nconst m = await import('left-pad')\nconst end = '*/'"
        const found = undeclaredImports([{ file: 'src/e.ts', text }], manifest, builtins, specifiersOf)
        expect([...found.keys()]).toEqual(['left-pad'])
    })
})

describe('kitIntegrities', () => {
    it("reads the framework tarball's integrity from the packages section only", () => {
        expect(kitIntegrities(GOOD_LOCKFILE)).toEqual(['sha512-abc'])
        expect(kitIntegrities(GOOD_LOCKFILE.replace('integrity: sha512-abc, ', ''))).toEqual(['(no integrity)'])
    })
})

describe('lockfileMoves', () => {
    it("ignores the framework's own entries, which change with every build and release", () => {
        const bumped = GOOD_LOCKFILE.replaceAll('sssb-kit-0.1.0', 'sssb-kit-0.2.0')
            .replace('sha512-abc', 'sha512-def')
            .replace('    version: 0.1.0', '    version: 0.2.0')
        expect(lockfileMoves(GOOD_LOCKFILE, bumped)).toEqual({ added: 0, removed: 0 })
    })

    it('counts any other line that moved, including one that duplicates a line elsewhere', () => {
        // `      react: 19.2.9` already appears in the snapshot; a second copy is still a move.
        const moved = GOOD_LOCKFILE.replace(
            '        version: link:src/app-config\n',
            '        version: link:src/app-config\n      react: 19.2.9\n',
        )
        expect(lockfileMoves(GOOD_LOCKFILE, moved)).toEqual({ added: 1, removed: 0 })
    })
})
