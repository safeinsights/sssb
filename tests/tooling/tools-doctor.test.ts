import { mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
    aliasProblems,
    cutoverReport,
    importerSeamProblems,
    isInRepoKit,
    missingTests,
    packageDirFrom,
    parseWorkspaceYaml,
    singletonProblems,
    sssbPackagesOf,
    versionProblems,
    workspacePackages,
} from '../../packages/tools/src/commands/doctor-checks.js'
import { projectsRunning, vitestRunsFor } from '../../packages/tools/src/commands/doctor-vitest.js'
import { kitDirOf } from '../../packages/tools/src/kit.js'
import { makeTestTmpDir } from '../support/tmp-dir'

/**
 * `sssb doctor` (packages/tools/src/commands/doctor.js, ADR-0014 part 5): its checks, each driven with what must fail.
 * The layouts are built on disk the way pnpm lays a workspace out (a virtual store under node_modules/.pnpm, each
 * importer's node_modules linking into it), so the checks read real symlinks, not a description of them.
 */

function write(file: string, text: string) {
    mkdirSync(path.dirname(file), { recursive: true })
    writeFileSync(file, text)
}

const json = (file: string, value: unknown) => write(file, JSON.stringify(value))

/** `link` -> `target`, making the link's parent. */
function link(at: string, target: string) {
    mkdirSync(path.dirname(at), { recursive: true })
    symlinkSync(target, at, 'dir')
}

/** A package directory with a package.json. */
function pkg(dir: string, manifest: Record<string, unknown>) {
    json(path.join(dir, 'package.json'), manifest)
    return dir
}

describe('parseWorkspaceYaml', () => {
    it('reads the packages globs (plain, quoted, commented, negated) and dedupePeerDependents', () => {
        const yaml = [
            'packages:',
            '    - apps/*',
            "    - 'packages/*' # the libraries",
            '',
            '    - "!packages/legacy"',
            '    - infra',
            '',
            'allowBuilds:',
            '    esbuild: true',
            'dedupePeerDependents: false # one instance per importer',
        ].join('\n')
        expect(parseWorkspaceYaml(yaml)).toEqual({
            packages: ['apps/*', 'packages/*', '!packages/legacy', 'infra'],
            dedupePeerDependents: false,
        })
        expect(parseWorkspaceYaml('packages: [apps/*, "tools"]\n')).toEqual({
            packages: ['apps/*', 'tools'],
            dedupePeerDependents: undefined,
        })
    })
})

describe('missingTests, over a `vitest list --json` sample', () => {
    const registry = {
        checks: [
            { id: 'alpha', runner: 'unit', title: 'the alpha check', tests: ['one', 'two'] },
            { id: 'beta', runner: 'unit', title: 'the beta check', tests: ['three'] },
            { id: 'gamma', runner: 'unit', title: 'the gamma check', tests: ['four'] },
            { id: 'delta', runner: 'contract', title: 'the delta check', tests: ['five'] },
        ],
    }
    // As Vitest 4 lists them: `{ name, file, projectName }`, the describe and the test joined by ` > `.
    const sample = [
        {
            name: '[sssb:alpha] the alpha check > one',
            file: '/ws/apps/a/src/sssb.conformance.test.ts',
            projectName: 'a',
        },
        { name: '[sssb:opt-out:beta] the app has no beta', file: '/ws/apps/a/src/sssb.conformance.test.ts' },
        { name: 'an app test > that happens to say [sssb:gamma]', file: '/ws/apps/a/src/x.test.ts' },
        { name: '[sssb:opt-out:delta] a contract opt-out in the unit listing', file: '/ws/apps/a/src/y.test.ts' },
    ].map((test) => test.name)

    it('names each expected test that is not listed, and honours an opt-out marker for its own runner only', () => {
        expect(missingTests(sample, registry, 'unit')).toEqual({
            missing: ['[sssb:alpha] the alpha check > two', '[sssb:gamma] the gamma check > four'],
            optedOut: ['beta'],
            expected: 3,
        })
        // The delta marker opts the contract check out when the CONTRACT listing carries it.
        expect(missingTests(sample, registry, 'contract')).toEqual({ missing: [], optedOut: ['delta'], expected: 0 })
    })

    it('finds an opt-out marker under a describe too, and an empty listing misses everything', () => {
        expect(missingTests(['wrapper > [sssb:opt-out:alpha] why'], registry, 'unit').optedOut).toEqual(['alpha'])
        expect(missingTests([], registry, 'unit').missing).toHaveLength(4)
    })
})

describe('where doctor runs Vitest, and which projects it selects', () => {
    const ws = realpathSync(makeTestTmpDir('sssb-doctor-runs-'))
    const app = pkg(path.join(ws, 'apps', 'a'), { name: 'a' })
    write(path.join(ws, 'pnpm-workspace.yaml'), 'packages:\n  - apps/*\n')

    it('runs the unit suite on Vitest defaults from the app when nothing configures it, and finds no contract run', () => {
        expect(vitestRunsFor(ws, app, 'unit')).toEqual([{ cwd: app, config: null }])
        expect(vitestRunsFor(ws, app, 'contract')).toEqual([])
    })

    it("prefers the workspace root's config, keeping the app's own as the fallback", () => {
        write(path.join(ws, 'vitest.config.ts'), 'export default {}\n')
        write(path.join(app, 'vitest.contract.config.mts'), 'export default {}\n')
        expect(vitestRunsFor(ws, app, 'unit')).toEqual([{ cwd: ws, config: path.join(ws, 'vitest.config.ts') }])
        expect(vitestRunsFor(ws, app, 'contract')).toEqual([
            { cwd: app, config: path.join(app, 'vitest.contract.config.mts') },
        ])
    })

    it('selects the projects that run a file inside the app, and no project that only shares a prefix', () => {
        const files = [
            { file: path.join(app, 'src/x.test.ts'), projectName: 'a' },
            { file: path.join(ws, 'apps/a-two/src/y.test.ts'), projectName: 'a-two' },
            { file: path.join(app, 'tests/contract/z.test.ts'), projectName: 'a-contract' },
            { file: path.join(ws, 'packages/kit/src/k.test.ts'), projectName: 'kit' },
        ]
        expect(projectsRunning(files, app)).toEqual(['a', 'a-contract'])
    })
})

describe('one copy of each singleton', () => {
    // A virtual store with two copies of react; the kit links one, the app the other.
    const ws = realpathSync(makeTestTmpDir('sssb-doctor-singletons-'))
    const store = path.join(ws, 'node_modules', '.pnpm')
    const react1 = pkg(path.join(store, 'react@19.3.1', 'node_modules', 'react'), { name: 'react', version: '19.3.1' })
    const react2 = pkg(path.join(store, 'react@19.2.9', 'node_modules', 'react'), { name: 'react', version: '19.2.9' })
    const types = pkg(path.join(store, '@types+react@19.3.0', 'node_modules', '@types', 'react'), {
        name: '@types/react',
    })
    const kitHome = path.join(store, '@sssb+kit@0.1.0', 'node_modules')
    const kit = pkg(path.join(kitHome, '@sssb', 'kit'), { name: '@sssb/kit', version: '0.1.0' })
    link(path.join(kitHome, 'react'), react1)
    link(path.join(kitHome, '@types', 'react'), types)
    const app = pkg(path.join(ws, 'apps', 'a'), { name: 'a' })
    link(path.join(app, 'node_modules', '@sssb', 'kit'), kit)
    link(path.join(app, 'node_modules', '@types', 'react'), types)

    const check = (appReact: string) => {
        link(path.join(app, 'node_modules', 'react'), appReact)
        return singletonProblems({
            peers: ['react', '@types/react', 'next', 'vitest'],
            optional: new Set(['vitest']),
            fromKit: (name) => packageDirFrom(kit, name),
            fromApp: (name) => packageDirFrom(app, name),
        })
    }

    it('fails a second copy, naming both, and a required peer the kit cannot find; an optional one neither has is a note', () => {
        const { problems, notes, same } = check(react2)
        expect(problems).toEqual([
            `TWO COPIES  react: @sssb/kit loads ${react1}, the app ${react2}`,
            'next: @sssb/kit cannot find it',
        ])
        expect(same).toEqual(['@types/react'])
        expect(notes).toEqual(['vitest: an optional peer neither installs'])
    })
})

/**
 * A workspace as pnpm lays it out with `dedupePeerDependents: false`, or without it (`shared`): two apps, each with an
 * instance of @sssb/kit whose seam is linked beside it, a package that uses only the tools, and a SEAMLESS importer.
 */
function seamWorkspace(prefix: string, seamless: 'shared' | 'own-instance' | 'none') {
    const ws = realpathSync(makeTestTmpDir(prefix))
    write(path.join(ws, 'pnpm-workspace.yaml'), 'packages:\n    - apps/*\n    - packages/*\n')
    pkg(ws, { name: 'root', private: true, devDependencies: { '@sssb/tools': 'file:tools.tgz' } })
    const store = path.join(ws, 'node_modules', '.pnpm')
    const instance = (key: string, seam: string | null) => {
        const home = path.join(store, `@sssb+kit@file+kit.tgz_${key}`, 'node_modules')
        const kit = pkg(path.join(home, '@sssb', 'kit'), { name: '@sssb/kit', version: '0.1.0' })
        if (seam) link(path.join(home, '@sssb', 'app-config'), seam)
        return kit
    }
    const app = (name: string) => {
        const dir = pkg(path.join(ws, 'apps', name), {
            name,
            dependencies: { '@sssb/kit': 'file:../../kit.tgz', '@sssb/app-config': 'link:./src/app-config' },
        })
        const seam = pkg(path.join(dir, 'src', 'app-config'), { name: '@sssb/app-config' })
        link(path.join(dir, 'node_modules', '@sssb', 'kit'), instance(name, seam))
        link(path.join(dir, 'node_modules', '@sssb', 'app-config'), seam)
        return dir
    }
    const console_ = app('console')
    app('ledger')
    pkg(path.join(ws, 'packages', 'gate'), { name: 'gate', devDependencies: { '@sssb/tools': 'file:../../tools.tgz' } })
    if (seamless !== 'none') {
        const dir = pkg(path.join(ws, 'packages', 'seamless'), {
            name: 'seamless',
            dependencies: { '@sssb/kit': 'file:../../kit.tgz' },
        })
        const kit =
            seamless === 'shared'
                ? realpathSync(path.join(console_, 'node_modules', '@sssb', 'kit'))
                : instance('seamless', null)
        link(path.join(dir, 'node_modules', '@sssb', 'kit'), kit)
    }
    return ws
}

describe('one SSSB per importer, with its own seam', () => {
    it('passes a workspace whose every importer links its own seam, and walks only importers', () => {
        const ws = seamWorkspace('sssb-doctor-seams-ok-', 'none')
        expect(importerSeamProblems(ws, kitDirOf)).toEqual({ problems: [], importers: ['apps/console', 'apps/ledger'] })
    })

    it("NAMES a seamless importer that silently shares another app's instance (pnpm's default dedupe)", () => {
        const ws = seamWorkspace('sssb-doctor-seams-shared-', 'shared')
        const { problems } = importerSeamProblems(ws, kitDirOf)
        expect(problems).toHaveLength(1)
        expect(problems[0]).toMatch(
            /^packages\/seamless: takes @sssb\/kit but declares no seam link \(@sssb\/app-config\); the instance it resolves \(node_modules\/\.pnpm\/@sssb\+kit@file\+kit\.tgz_console\/node_modules\/@sssb\/kit\) has apps\/console's seam apps\/console\/src\/app-config linked$/,
        )
    })

    it('names a seamless importer with an instance of its own and no seam (dedupePeerDependents: false)', () => {
        const ws = seamWorkspace('sssb-doctor-seams-own-', 'own-instance')
        expect(importerSeamProblems(ws, kitDirOf).problems).toEqual([
            'packages/seamless: takes @sssb/kit but declares no seam link (@sssb/app-config); the instance it resolves (node_modules/.pnpm/@sssb+kit@file+kit.tgz_seamless/node_modules/@sssb/kit) has no seam linked',
        ])
    })

    it('fails an app whose instance carries another app’s seam, and an importer that resolves no kit', () => {
        const ws = seamWorkspace('sssb-doctor-seams-swapped-', 'none')
        // The ledger's link now points at the console's instance.
        const ledgerKit = path.join(ws, 'apps', 'ledger', 'node_modules', '@sssb', 'kit')
        rmSync(ledgerKit)
        symlinkSync(realpathSync(path.join(ws, 'apps', 'console', 'node_modules', '@sssb', 'kit')), ledgerKit, 'dir')
        // A package that declares the framework but has none installed (nothing above the workspace installs one).
        pkg(path.join(ws, 'packages', 'orphan'), { name: 'orphan', dependencies: { '@sssb/kit': 'file:x.tgz' } })
        const { problems } = importerSeamProblems(ws, kitDirOf)
        expect(problems).toContain(
            "apps/ledger: its @sssb/kit (node_modules/.pnpm/@sssb+kit@file+kit.tgz_console/node_modules/@sssb/kit) has apps/console's seam apps/console/src/app-config linked, not its own apps/ledger/src/app-config",
        )
        expect(problems.some((p) => p.startsWith('packages/orphan: depends on @sssb/kit but resolves none'))).toBe(true)
    })
})

describe('in-repo mode', () => {
    const ws = realpathSync(makeTestTmpDir('sssb-doctor-in-repo-'))
    write(path.join(ws, 'pnpm-workspace.yaml'), "packages:\n  - 'apps/*'\n  - 'packages/*'\n  - '!packages/old'\n")
    const kit = pkg(path.join(ws, 'packages', 'kit'), { name: '@sssb/kit', version: '0.1.0' })
    pkg(path.join(ws, 'packages', 'old'), { name: 'old' })
    const app = pkg(path.join(ws, 'apps', 'a'), { name: 'a' })
    link(path.join(app, 'node_modules', '@sssb', 'kit'), kit)

    it("is decided by where the app's kit really is: a package of the workspace, not a store copy", () => {
        expect(workspacePackages(ws)).toEqual([app, kit])
        expect(isInRepoKit(kitDirOf(app), ws)).toBe(true)
        const packed = seamWorkspace('sssb-doctor-packed-', 'none')
        expect(isInRepoKit(kitDirOf(path.join(packed, 'apps', 'console')), packed)).toBe(false)
    })

    it("fails an app whose tsconfig or Vitest project aliases another app's seam, or none", () => {
        const own = '/ws/apps/a/src/app-config'
        const other = '/ws/apps/b/src/app-config'
        expect(
            aliasProblems([
                {
                    app: 'apps/a',
                    own,
                    tsconfig: own,
                    projects: [{ config: 'vitest.config.ts', project: 'a', seam: own }],
                },
            ]),
        ).toEqual([])
        expect(
            aliasProblems([
                {
                    app: 'apps/a',
                    own,
                    tsconfig: other,
                    projects: [
                        { config: 'vitest.config.ts', project: 'a', seam: null },
                        { config: 'vitest.contract.config.ts', project: 'a', seam: other },
                    ],
                },
                { app: 'apps/c', own: '/ws/apps/c/src/app-config', tsconfig: null, projects: [] },
            ]),
        ).toEqual([
            `apps/a: its tsconfig sends @sssb/app-config/* to ${other}, not its own ${own}`,
            'apps/a: Vitest project a (vitest.config.ts) has no @sssb/app-config alias',
            `apps/a: Vitest project a (vitest.contract.config.ts) aliases @sssb/app-config to ${other}, not its own ${own}`,
            'apps/c: its tsconfig maps no @sssb/app-config/* path',
            'apps/c: no Vitest project runs its files, so none aliases its seam',
        ])
    })
})

describe('versions in step', () => {
    it('reads every @sssb package the app resolves, nearest first, the seam left out, and fails one out of step', () => {
        const ws = realpathSync(makeTestTmpDir('sssb-doctor-versions-'))
        const app = path.join(ws, 'apps', 'a')
        pkg(path.join(app, 'node_modules', '@sssb', 'kit'), { name: '@sssb/kit', version: '0.2.0' })
        pkg(path.join(app, 'node_modules', '@sssb', 'app-config'), { name: '@sssb/app-config' })
        pkg(path.join(ws, 'node_modules', '@sssb', 'kit'), { name: '@sssb/kit', version: '0.1.0' })
        pkg(path.join(ws, 'node_modules', '@sssb', 'tools'), { name: '@sssb/tools', version: '0.1.0' })
        const found = sssbPackagesOf(app)
        expect([...found]).toEqual([
            ['@sssb/kit', '0.2.0'],
            ['@sssb/tools', '0.1.0'],
        ])
        expect(versionProblems(found)).toEqual(["@sssb/tools 0.1.0 is not @sssb/kit's 0.2.0"])
    })
})

describe('cutoverReport', () => {
    const rows = {
        rows: [
            { id: 'auth-dev', what: 'Managed auth' },
            { id: 'errors', what: 'Error tracking' },
            { id: 'release-app', scope: 'sssb', what: "SSSB's own repository only: the release GitHub App" },
            // The field decides, not the wording: the same sentence without the field is an adopter's row.
            { id: 'look-alike', what: "SSSB's own repository only, says the prose" },
        ],
    }

    it('reports the framework rows the checklist never names in backticks, and sets SSSB-only rows apart', () => {
        expect(cutoverReport(rows, '| ⬜ | `auth-dev` | ... |\nWe track errors elsewhere.')).toEqual({
            unmentioned: ['errors', 'look-alike'],
            sssbOnly: ['release-app'],
        })
        expect(cutoverReport(rows, null).unmentioned).toEqual(['auth-dev', 'errors', 'look-alike'])
    })
})
