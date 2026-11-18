import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import seamSpecifiers from '../seam-specifiers.json'
import { makeTestTmpDir } from '../tmp-dir'
import { seamMap } from './seam-map'

/**
 * The `seam-map` check's first half on scratch seam PACKAGES: no app in this repo has one (each resolves its seam
 * through an alias), so this is where an `exports` map is seen to pass and to fail. Every scratch seam has a `.ts`
 * file per specifier and a map that reaches them all through `./*`; each case changes one entry.
 */

const check = seamMap.tests["through the exports map of the app's seam package, when it has one"]!

/** A scratch app whose seam package maps `./*` to `./*.ts`, plus `overrides`, with `extraFiles` written too. */
function appWithSeam(overrides: Record<string, unknown>, extraFiles: string[] = []): string {
    const appDir = makeTestTmpDir('seam-map-')
    const seamDir = path.join(appDir, 'src/app-config')
    const files = [...seamSpecifiers.specifiers.map((s) => `${s.slice('@sssb/app-config/'.length)}.ts`), ...extraFiles]
    for (const file of files) {
        mkdirSync(path.dirname(path.join(seamDir, file)), { recursive: true })
        writeFileSync(path.join(seamDir, file), 'export {}\n')
    }
    const manifest = { name: '@sssb/app-config', exports: { './*': './*.ts', ...overrides } }
    writeFileSync(path.join(seamDir, 'package.json'), JSON.stringify(manifest))
    return appDir
}

const run = (appDir: string) => () => check({ appDir })

describe('seam-map, through a seam package', () => {
    it('passes a map that reaches a file for every specifier', () => {
        expect(run(appWithSeam({}))).not.toThrow()
    })

    it('fails an entry whose target is a directory', () => {
        // `db/migrations` is a directory here (it holds index.ts), as a directory module's is.
        const appDir = appWithSeam({ './db/migrations': './db/migrations' }, ['db/migrations/index.ts'])
        expect(run(appDir)).toThrow(/maps \.\/db\/migrations to \.\/db\/migrations, which is not a file/)
    })

    it('fails an entry that only `types` resolves: nothing loads it at run time', () => {
        const appDir = appWithSeam({ './identity': { types: './identity.ts' } })
        expect(run(appDir)).toThrow(/@sssb\/app-config\/identity: no `exports` entry for \.\/identity that resolves/)
    })

    it("walks an entry's conditions in its own key order, as Node does", () => {
        // Node takes `default` here, the first key it matches, and never reaches `import`.
        const defaultFirst = appWithSeam({ './jobs': { default: './missing.ts', import: './jobs.ts' } })
        expect(run(defaultFirst)).toThrow(/maps \.\/jobs to \.\/missing\.ts, which is not a file/)
        const importFirst = appWithSeam({ './jobs': { import: './jobs.ts', default: './missing.ts' } })
        expect(run(importFirst)).not.toThrow()
    })

    it('falls through a condition whose nested target matches nothing, to the next', () => {
        const appDir = appWithSeam({ './seed': { import: { browser: './browser-seed.ts' }, default: './seed.ts' } })
        expect(run(appDir)).not.toThrow()
    })

    it('stops at an explicit null, as Node does', () => {
        const appDir = appWithSeam({ './seed': { import: null, default: './seed.ts' } })
        expect(run(appDir)).toThrow(/@sssb\/app-config\/seed: no `exports` entry/)
    })

    it('between patterns with the same prefix, takes the LONGER key, as Node does (PATTERN_KEY_COMPARE)', () => {
        // Both `./*` and `./*ty` match ./identity with the prefix `./`; Node takes `./*ty`, whatever the key order.
        const appDir = appWithSeam({ './*ty': './nowhere/*ty.ts' })
        expect(run(appDir)).toThrow(/maps \.\/identity to \.\/nowhere\/identity\.ts, which is not a file/)
    })

    it('never matches a pattern with an empty `*`, as Node does', () => {
        // `./identity*` does not match ./identity (Node requires a non-empty match), so `./*` resolves it.
        const appDir = appWithSeam({ './identity*': './nowhere*.ts' })
        expect(run(appDir)).not.toThrow()
    })

    it.each([
        ['a target that does not start with ./', 'identity.ts', 'src/app-config/identity.ts'],
        ['a target that leaves the package', '../identity.ts', 'src/identity.ts'],
        ['a target with a .. segment', './db/../identity.ts', 'src/app-config/identity.ts'],
        ['a target through node_modules', './node_modules/x/identity.ts', 'src/app-config/node_modules/x/identity.ts'],
        ['a target with a percent-encoded .. segment', './db/%2e%2e/identity.ts', 'src/app-config/identity.ts'],
    ])('refuses %s, as Node does, even when a file is there', (_name, target, file) => {
        const appDir = appWithSeam({ './identity': target })
        mkdirSync(path.dirname(path.join(appDir, file)), { recursive: true })
        writeFileSync(path.join(appDir, file), 'export {}\n')
        expect(run(appDir)).toThrow(
            /@sssb\/app-config\/identity: `exports` maps \.\/identity to .*, which Node refuses/,
        )
    })

    it('refuses an absolute target', () => {
        const appDir = appWithSeam({})
        const absolute = path.join(appDir, 'src/app-config/identity.ts')
        writeFileSync(
            path.join(appDir, 'src/app-config/package.json'),
            JSON.stringify({
                name: '@sssb/app-config',
                exports: { './*': './*.ts', './identity': absolute },
            }),
        )
        expect(run(appDir)).toThrow(/which Node refuses: it does not start with "\.\/"/)
    })

    it('skips an invalid target in a fallback array, as Node does', () => {
        const appDir = appWithSeam({ './identity': ['../identity.ts', './identity.ts'] })
        expect(run(appDir)).not.toThrow()
    })

    // Each expectation below is what Node 24's own resolver gives for the same map (`import.meta.resolve`, checked by
    // hand against fixture packages when these were written).
    it('goes past a null item in a fallback array, as Node does', () => {
        const appDir = appWithSeam({ './identity': [null, './identity.ts'] })
        expect(run(appDir)).not.toThrow()
    })

    it('reports the invalid item when a fallback array ends on one after a null, as Node does', () => {
        const appDir = appWithSeam({ './identity': [null, '../identity.ts'] })
        expect(run(appDir)).toThrow(/maps \.\/identity to \.\.\/identity\.ts, which Node refuses/)
    })

    it('falls through a condition whose array matches nothing, to the next condition, as Node does', () => {
        const appDir = appWithSeam({ './seed': { import: [{ browser: './browser-seed.ts' }], default: './seed.ts' } })
        expect(run(appDir)).not.toThrow()
    })

    it('matches `module-sync`, which Node 24 matches by default', () => {
        const appDir = appWithSeam({ './jobs': { 'module-sync': './missing.ts', default: './jobs.ts' } })
        expect(run(appDir)).toThrow(/maps \.\/jobs to \.\/missing\.ts, which is not a file/)
    })
})
