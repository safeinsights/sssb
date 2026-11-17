import { describe, expect, it } from 'vitest'
import {
    conformanceProblems,
    CONFORMANCE_SUITES,
    lockfileProblems,
    seamPeerProblems,
    tscErrors,
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
})
