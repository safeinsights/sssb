import { readFileSync } from 'node:fs'
import path from 'node:path'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'
import {
    checkE2eFailProblems,
    checkE2eOkProblems,
    CONFORMANCE_DATA,
    conformanceProblems,
    createPackageProblems,
    expectedConformanceTests,
    lockfileMoves,
    packagesBeyondSeed,
    lockfileProblems,
    pluginManifestProblems,
    pluginShippedFileProblems,
    seamPeerProblems,
    shippedFileProblems,
    tarballIntegrities,
    toolsManifestProblems,
    toolsShippedFileProblems,
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

    it("accepts the generator's overrides of each @sssb package to its tarball, and fails one to anything else", () => {
        const overridden = GOOD_LOCKFILE.replace(
            'importers:\n',
            "overrides:\n  '@sssb/kit': file:/run/tarballs/sssb-kit-0.1.0.tgz\n\nimporters:\n",
        )
        const { problems, seen } = lockfileProblems(overridden)
        expect(problems).toEqual([])
        expect(seen).toContain('overrides: @sssb/kit -> file:/run/tarballs/sssb-kit-0.1.0.tgz')
        for (const [name, target] of [
            ['@sssb/kit', '0.1.0'],
            ['@sssb/kit', 'link:../kit'],
            ['@sssb/app-config', 'file:/run/app-config.tgz'],
        ]) {
            const bad = overridden.replace("'@sssb/kit': file:/run/tarballs/sssb-kit-0.1.0.tgz", `'${name}': ${target}`)
            expect(lockfileProblems(bad).problems, `${name} -> ${target}`).toEqual([
                expect.stringContaining(`${name} is overridden to ${target}, not a local tarball`),
            ])
        }
    })

    it('fails closed on an @sssb line it cannot classify', () => {
        const odd = GOOD_LOCKFILE.replace(
            'lockfileVersion',
            "time:\n  '@sssb/kit@0.0.9': 2026-01-01\n\nlockfileVersion",
        )
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
    const registry = {
        checks: [
            { id: 'i18n-parity', runner: 'unit', title: 'parity', tests: ['framework', 'merged'] },
            { id: 'seam-map', runner: 'unit', title: 'seam', tests: ['resolves'] },
            { id: 'contract-rls', runner: 'contract', title: 'rls', tests: ['proofs'] },
        ],
    }
    const expected = expectedConformanceTests(registry)
    const files = { console: '/ws/apps/console/src/sssb.conformance.test.ts' }
    /** The conformance file's result, each expected test with the given status unless overridden by name. */
    const ran = (status: string, over: Record<string, string> = {}, fileStatus = 'passed') => [
        {
            name: files.console,
            status: fileStatus,
            assertionResults: expected.map((name) => {
                const [describe, title] = name.split(' > ') as [string, string]
                return { status: over[name] ?? status, ancestorTitles: [describe], title }
            }),
        },
    ]

    it('names every unit check test, and no contract one', () => {
        expect(expected).toEqual([
            '[sssb:i18n-parity] parity > framework',
            '[sssb:i18n-parity] parity > merged',
            '[sssb:seam-map] seam > resolves',
        ])
    })

    it("names the contract runner's tests, and no unit one, when asked for them", () => {
        expect(expectedConformanceTests(registry, 'contract')).toEqual(['[sssb:contract-rls] rls > proofs'])
    })

    it("accepts an app's conformance file that ran and passed every check", () => {
        expect(conformanceProblems({ testResults: ran('passed') }, files, expected)).toEqual([])
    })

    it('fails a check that was skipped, failed or never registered, by name', () => {
        expect(
            conformanceProblems(
                { testResults: ran('passed', { '[sssb:i18n-parity] parity > merged': 'skipped' }) },
                files,
                expected,
            ),
        ).toEqual(['console: [sssb:i18n-parity] parity > merged skipped'])
        const missing = ran('passed')
        missing[0]!.assertionResults.pop()
        expect(conformanceProblems({ testResults: missing }, files, expected)).toEqual([
            'console: [sssb:seam-map] seam > resolves did not run',
        ])
    })

    it("fails a file the suite's skip guard failed, even when every test it lists passed", () => {
        expect(conformanceProblems({ testResults: ran('passed', {}, 'failed') }, files, expected)).toEqual([
            'console: sssb.conformance.test.ts failed',
        ])
    })

    it("fails an app's conformance file that did not run, and an empty report", () => {
        expect(conformanceProblems({}, files, expected)).toEqual(['console: sssb.conformance.test.ts did not run'])
    })

    it("fails an app's own required test that did not run, even when the conformance suite passed", () => {
        const own = '/ws/apps/console/src/seam-identity.test.ts'
        expect(conformanceProblems({ testResults: ran('passed') }, files, expected, { console: [own] })).toEqual([
            'console: seam-identity.test.ts did not run',
        ])
        const withOwn = [...ran('passed'), { name: own, status: 'passed', assertionResults: [{ status: 'passed' }] }]
        expect(conformanceProblems({ testResults: withOwn }, files, expected, { console: [own] })).toEqual([])
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
        // strict-flags-kit-baseline). P5 removed conformance-by-include, and contract-test-dropped with the contract
        // runner. P12 removed its six when the consumer became @sssb/create's output. Raise this as each later step lands.
        const landed = new Set(['P1', 'P1b', 'P2', 'P3', 'P5', 'P12'])
        for (const [id, workaround] of Object.entries(WORKAROUNDS))
            expect(landed.has(workaround.removedBy), id).toBe(false)
    })
})

describe('shippedFileProblems', () => {
    const shipped = ['package.json', 'LICENSE', 'src/theme.ts', 'src/testing/tmp-dir.ts', ...CONFORMANCE_DATA]

    it("accepts source plus the conformance suite's data", () => {
        expect(shippedFileProblems(shipped)).toEqual([])
    })

    it('refuses every test or story file, and anything of the fixture', () => {
        expect(
            shippedFileProblems([
                ...shipped,
                'src/core/roles.test.ts',
                'src/i18n/namespaces.test.ts',
                'src/components/app-header.stories.tsx',
                'src/demo-static/world-invite.test.tsx',
                'src/adapters/real/db.contract.test.ts',
                'test-fixture/app-config/seed.ts',
            ]),
        ).toHaveLength(6)
    })

    it("refuses a tarball missing the conformance suite's data", () => {
        expect(shippedFileProblems(shipped.filter((file) => file !== CONFORMANCE_DATA[0]))).toEqual([
            `${CONFORMANCE_DATA[0]}: the conformance suite's data is not shipped`,
        ])
    })

    it("matches packages/kit/package.json's files allowlist, which re-includes no source file", () => {
        const manifest = JSON.parse(
            readFileSync(path.resolve(import.meta.dirname, '../../packages/kit/package.json'), 'utf8'),
        ) as { files: string[] }
        // `src`, then the two negations; nothing after them names back a file under src/ (a test, above all).
        const [first, ...rest] = manifest.files
        expect(first).toBe('src')
        expect(rest.slice(0, 2)).toEqual(['!src/**/*.test.*', '!src/**/*.stories.*'])
        expect(rest.slice(2).filter((entry) => entry.startsWith('src/'))).toEqual([])
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

    it('reads the conformance suite, which ships as source', () => {
        const suite = 'src/testing/conformance/suite.ts'
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

const TOOLS_ENTRY = `  '@sssb/tools@file:../tarballs/sssb-tools-0.1.0.tgz':
    resolution: {integrity: sha512-tools, tarball: file:../tarballs/sssb-tools-0.1.0.tgz}
    version: 0.1.0
    hasBin: true

`
const WITH_TOOLS = GOOD_LOCKFILE.replace('snapshots:\n', `${TOOLS_ENTRY}snapshots:\n`)

describe('tarballIntegrities', () => {
    it("reads a packed package's integrity from the packages section only, per package", () => {
        expect(tarballIntegrities(GOOD_LOCKFILE)).toEqual(['sha512-abc'])
        expect(tarballIntegrities(GOOD_LOCKFILE.replace('integrity: sha512-abc, ', ''))).toEqual(['(no integrity)'])
        expect(tarballIntegrities(WITH_TOOLS, '@sssb/tools')).toEqual(['sha512-tools'])
        expect(tarballIntegrities(GOOD_LOCKFILE, '@sssb/tools')).toEqual([])
    })
})

describe('toolsManifestProblems', () => {
    const good = { name: '@sssb/tools', bin: { sssb: './bin/sssb.js' }, dependencies: { esbuild: '^0.28.2' } }
    it('passes the shape @sssb/tools must have', () => {
        expect(toolsManifestProblems(good)).toEqual([])
    })
    it('fails any dependency on an SSSB package, in every field (rule 4)', () => {
        for (const field of ['dependencies', 'peerDependencies', 'optionalDependencies', 'peerDependenciesMeta']) {
            expect(toolsManifestProblems({ ...good, [field]: { '@sssb/kit': '0.1.0' } }), field).toEqual([
                `${field} names @sssb/kit: @sssb/tools depends on no SSSB package`,
            ])
        }
    })
    it('fails a missing bin or a wrong name', () => {
        expect(toolsManifestProblems({ ...good, bin: undefined })).toEqual(['the packed manifest has no `sssb` bin'])
        expect(toolsManifestProblems({ ...good, name: '@sssb/kit' })).toHaveLength(1)
    })
})

describe('toolsShippedFileProblems', () => {
    const good = ['package.json', 'tsconfig.base.json', 'bin/sssb.js', 'src/kit.js', 'src/ports.d.ts']
    it('passes JavaScript, declarations and the tsconfig base', () => {
        expect(toolsShippedFileProblems(good)).toEqual([])
    })
    it('fails TypeScript source, a test, a stray file and a missing CLI (ADR-0014 part 2: it ships JavaScript)', () => {
        expect(toolsShippedFileProblems([...good, 'src/vite.ts'])).toEqual([
            'src/vite.ts: neither JavaScript nor a declaration file',
        ])
        expect(toolsShippedFileProblems([...good, 'src/kit.test.js'])).toEqual([
            'src/kit.test.js: a test file is shipped',
        ])
        expect(toolsShippedFileProblems([...good, 'scripts/x.js'])).toEqual(['scripts/x.js: outside bin/ and src/'])
        expect(toolsShippedFileProblems(good.filter((f) => f !== 'bin/sssb.js'))).toEqual([
            'bin/sssb.js: the CLI is not shipped',
        ])
    })
})

describe('pluginManifestProblems', () => {
    const good = {
        name: '@sssb/eslint-plugin',
        dependencies: { ignore: '^5.3.2', 'typescript-eslint': '^8.72.0' },
        peerDependencies: { eslint: '^10.13.0' },
    }
    it('passes the shape @sssb/eslint-plugin must have', () => {
        expect(pluginManifestProblems(good)).toEqual([])
    })
    it('fails any dependency on an SSSB package, in every field (rule 4)', () => {
        for (const field of ['dependencies', 'optionalDependencies', 'peerDependenciesMeta']) {
            expect(pluginManifestProblems({ ...good, [field]: { '@sssb/kit': '0.1.0' } }), field).toEqual([
                `${field} names @sssb/kit: @sssb/eslint-plugin depends on no SSSB package`,
            ])
        }
    })
    it('fails ESLint as anything but a peer, and a wrong name', () => {
        expect(pluginManifestProblems({ ...good, peerDependencies: {} })).toEqual([
            "eslint is not a peer: the plugin must run inside the app's own ESLint",
        ])
        expect(pluginManifestProblems({ ...good, name: '@sssb/tools' })).toHaveLength(1)
    })
})

describe('pluginShippedFileProblems', () => {
    const good = ['package.json', 'src/index.js', 'src/index.d.ts', 'src/check-fences.js', 'src/rules.js']
    it('passes JavaScript and declarations', () => {
        expect(pluginShippedFileProblems(good)).toEqual([])
    })
    it('fails TypeScript source, a test, a stray file and a missing entry', () => {
        expect(pluginShippedFileProblems([...good, 'src/x.ts'])).toEqual([
            'src/x.ts: neither JavaScript nor a declaration file',
        ])
        expect(pluginShippedFileProblems([...good, 'src/rules.test.js'])).toEqual([
            'src/rules.test.js: a test file is shipped',
        ])
        expect(pluginShippedFileProblems([...good, 'tests/x.js'])).toEqual(['tests/x.js: outside src/'])
        expect(pluginShippedFileProblems(good.filter((f) => f !== 'src/check-fences.js'))).toEqual([
            "src/check-fences.js: an export's entry is not shipped",
        ])
    })
})

describe('createPackageProblems', () => {
    const manifest = { name: '@sssb/create', bin: { 'sssb-create': './bin/create.js' } }
    const files = [
        'package.json',
        'bin/create.js',
        'src/generate.js',
        'template/meta.json',
        'template/app/package.json',
        'template/app/src/sssb.conformance.test.ts',
        'template/app/_dot_env.example',
        'template/root/_dot_editorconfig',
    ]

    it('passes the generator with its template and no dependency', () => {
        expect(createPackageProblems(manifest, files)).toEqual([])
    })

    it('fails any dependency at all, a missing bin and a wrong name', () => {
        expect(createPackageProblems({ ...manifest, dependencies: { kleur: '^4.0.0' } }, files)).toEqual([
            'dependencies names kleur: @sssb/create runs with no dependency installed',
        ])
        expect(createPackageProblems({ ...manifest, peerDependencies: { '@sssb/kit': '0.1.0' } }, files)).toHaveLength(
            1,
        )
        expect(createPackageProblems({ name: '@sssb/create' }, files)).toEqual(['the packed manifest has no bin'])
        expect(createPackageProblems({ ...manifest, name: '@sssb/tools' }, files)).toHaveLength(1)
        expect(
            createPackageProblems(
                manifest,
                files.filter((f) => f !== 'bin/create.js'),
            ),
        ).toEqual(['./bin/create.js: the bin is not shipped'])
    })

    it('fails a template that was not packed, or not whole', () => {
        expect(
            createPackageProblems(
                manifest,
                files.filter((f) => !f.startsWith('template/')),
            ),
        ).toEqual([
            'template/meta.json: the template is not packed whole',
            'template/app/package.json: the template is not packed whole',
            'template/app/src/sssb.conformance.test.ts: the template is not packed whole',
        ])
    })

    it("fails a checkout's local state in the template, at any depth, and a stray or test file outside it", () => {
        for (const file of [
            'template/app/node_modules/x/index.js',
            'template/app/_dot_next/server.js',
            'template/app/_dot_data/pglite/base',
            'template/app/_dot_env.local',
            'template/app/infra/cdk.out/manifest.json',
            'template/app/test-results/trace.zip',
            'template/app/tsconfig.tsbuildinfo',
        ]) {
            expect(createPackageProblems(manifest, [...files, file]), file).toEqual([
                expect.stringMatching(new RegExp(`^${file.replaceAll('.', '\\.')}: a checkout's local state`)),
            ])
        }
        expect(createPackageProblems(manifest, [...files, 'src/generate.test.js'])).toEqual([
            'src/generate.test.js: a test file is shipped',
        ])
        expect(createPackageProblems(manifest, [...files, 'scripts/build-template.js'])).toEqual([
            'scripts/build-template.js: outside bin/, src/ and template/',
        ])
    })
})

describe('lockfileMoves', () => {
    it("ignores the framework's own entries, which change with every build and release", () => {
        const bumped = GOOD_LOCKFILE.replaceAll('sssb-kit-0.1.0', 'sssb-kit-0.2.0')
            .replace('sha512-abc', 'sha512-def')
            .replace('    version: 0.1.0', '    version: 0.2.0')
        expect(lockfileMoves(GOOD_LOCKFILE, bumped)).toEqual({ added: 0, removed: 0 })
    })

    it("ignores @sssb/tools' entries the same way", () => {
        const bumped = WITH_TOOLS.replaceAll('sssb-tools-0.1.0', 'sssb-tools-0.2.0').replace('sha512-tools', 'sha512-x')
        expect(lockfileMoves(WITH_TOOLS, bumped)).toEqual({ added: 0, removed: 0 })
    })

    it("ignores @sssb/cdk's entries, and the generator's overrides of every @sssb package, the same way", () => {
        const entry = TOOLS_ENTRY.replaceAll('sssb/tools', 'sssb/cdk')
            .replaceAll('sssb-tools-', 'sssb-cdk-')
            .replace('sha512-tools', 'sha512-cdk')
        const withCdk = GOOD_LOCKFILE.replace('snapshots:\n', `${entry}snapshots:\n`).replace(
            'importers:\n',
            "overrides:\n  '@sssb/cdk': file:/run/tarballs/sssb-cdk-0.1.0.tgz\n  '@sssb/kit': file:/run/tarballs/sssb-kit-0.1.0.tgz\n\nimporters:\n",
        )
        const bumped = withCdk
            .replaceAll('sssb-cdk-0.1.0', 'sssb-cdk-0.2.0')
            .replaceAll('sssb-kit-0.1.0', 'sssb-kit-0.2.0')
            .replace('sha512-cdk', 'sha512-x')
        expect(lockfileMoves(withCdk, bumped)).toEqual({ added: 0, removed: 0 })
    })

    it("ignores @sssb/eslint-plugin's entries the same way", () => {
        const entry = TOOLS_ENTRY.replaceAll('sssb/tools', 'sssb/eslint-plugin')
            .replaceAll('sssb-tools-', 'sssb-eslint-plugin-')
            .replace('sha512-tools', 'sha512-plugin')
        const withPlugin = GOOD_LOCKFILE.replace('snapshots:\n', `${entry}snapshots:\n`)
        const bumped = withPlugin
            .replaceAll('sssb-eslint-plugin-0.1.0', 'sssb-eslint-plugin-0.2.0')
            .replace('sha512-plugin', 'sha512-x')
        expect(lockfileMoves(withPlugin, bumped)).toEqual({ added: 0, removed: 0 })
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

describe('packagesBeyondSeed', () => {
    const seed = `${GOOD_LOCKFILE.replace(
        'snapshots:\n',
        "  react@19.2.9:\n    resolution: {integrity: sha512-r}\n\n  'left-pad@1.3.0':\n    resolution: {integrity: sha512-l}\n\nsnapshots:\n",
    )}  left-pad@1.3.0:\n    optional: true\n`

    it('holds a subset of the seed to it, whatever flags moved and whichever packages went, and the framework aside', () => {
        const subset = seed
            .replace("  'left-pad@1.3.0':\n    resolution: {integrity: sha512-l}\n\n", '')
            .replace('    optional: true\n', '')
            .replaceAll('sssb-kit-0.1.0', 'sssb-kit-0.2.0')
        expect(packagesBeyondSeed(seed, subset)).toEqual([])
    })

    it('names a package version the seed does not hold, quoted or not', () => {
        const moved = seed.replace('  react@19.2.9:', '  react@19.3.1:').replace("'left-pad@1.3.0'", "'left-pad@1.3.1'")
        expect(packagesBeyondSeed(seed, moved)).toEqual(['react@19.3.1', 'left-pad@1.3.1'])
    })
})

describe("the consumer's check-e2e verdicts (sssb check-e2e's own output format)", () => {
    const head =
        'sssb check-e2e: apps/console: 5 file(s) Playwright loads (playwright.config.ts; under tests/e2e); @sssb/kit/testing/e2e is @sssb/kit:dist/testing/e2e.js'
    const spec = 'tests/e2e/kit-entry.spec.ts'
    const through = `ok      ${spec}  (reaches the kit through @sssb/kit/testing/e2e)`
    const green = [
        head,
        'ok      playwright.config.ts',
        through,
        'sssb check-e2e: ok, no file reaches @sssb/kit other than through @sssb/kit/testing/e2e',
    ].join('\n')

    it('accepts a green run that checked the spec through the compiled entry', () => {
        expect(checkE2eOkProblems({ status: 0, stdout: green }, spec)).toEqual([])
    })

    it('fails a vacuous green run, a spec not seen reaching the entry, an entry from source, and a red run', () => {
        expect(checkE2eOkProblems({ status: 0, stdout: green.replace(through, '') }, spec)).toEqual([
            `sssb check-e2e did not report "${through}"`,
        ])
        expect(checkE2eOkProblems({ status: 0, stdout: green.replace(through, `ok      ${spec}`) }, spec)).toHaveLength(
            1,
        )
        const source = green.replace('@sssb/kit:dist/testing/e2e.js', '@sssb/kit:src/testing/e2e.ts (in-repo mode: …)')
        expect(checkE2eOkProblems({ status: 0, stdout: source }, spec)).toHaveLength(2)
        expect(checkE2eOkProblems({ status: 1, stdout: green }, spec)).toEqual(['sssb check-e2e exited 1, not 0'])
        expect(checkE2eOkProblems({ status: 0, stdout: '' }, spec)).toHaveLength(2)
    })

    // In the consumer the kit is TypeScript under node_modules, which Node will not load: a spec reaching it stops
    // Playwright's own listing, so check-e2e fails the CONFIG, with Playwright's error and the kit file it names.
    const kitFile = '@sssb/kit:src/core/webhook-signing.ts'
    const config = 'playwright.config.ts'
    const named = `          a file Playwright loads reaches ${kitFile}, other than through @sssb/kit/testing/e2e`
    const red = [
        head,
        `FAIL    playwright.demo.config.ts could not be listed by Playwright (exit 1): Error: boom`,
        `          a file Playwright loads reaches @sssb/kit:src/core/other.ts, other than through @sssb/kit/testing/e2e`,
        `FAIL    ${config} could not be listed by Playwright (exit 1): Error: Stripping types is currently unsupported for files under node_modules, for "file:///ws/node_modules/.pnpm/@sssb+kit@0.1.0/node_modules/@sssb/kit/src/core/webhook-signing.ts"`,
        named,
        'ok      playwright.config.ts',
        'sssb check-e2e: 2 problem(s)',
    ].join('\n')

    it('accepts a red run that fails the config Playwright cannot list, naming the kit file', () => {
        expect(checkE2eFailProblems({ status: 1, stdout: red }, { config, kitFile })).toEqual([])
    })

    it('fails a run that exits 0, a config it does not fail, and a failure that names another kit file', () => {
        expect(checkE2eFailProblems({ status: 0, stdout: red }, { config, kitFile })).toEqual([
            'sssb check-e2e exited 0, not 1',
        ])
        expect(checkE2eFailProblems({ status: 1, stdout: red }, { config: 'playwright.x.config.ts', kitFile })).toEqual(
            ['sssb check-e2e did not fail playwright.x.config.ts as one Playwright cannot list'],
        )
        // The kit file under another config's FAIL line does not count.
        const elsewhere = red.replace(named, '')
        expect(checkE2eFailProblems({ status: 1, stdout: elsewhere }, { config, kitFile })).toEqual([
            `sssb check-e2e failed ${config} without naming ${kitFile}`,
        ])
    })
})
