import { execFile, spawnSync } from 'node:child_process'
import {
    chmodSync,
    existsSync,
    mkdirSync,
    readFileSync,
    realpathSync,
    rmSync,
    symlinkSync,
    writeFileSync,
} from 'node:fs'
import path from 'node:path'
import { promisify } from 'node:util'
import { describe, expect, it } from 'vitest'
import {
    aliasProblems,
    aliasRoutes,
    cutoverReport,
    githubRepositoryOf,
    importerSeamProblems,
    isInRepoKit,
    kitImporters,
    knipGaps,
    missingTests,
    nodeLinkerProblem,
    packageDirFrom,
    ownTests,
    parseWorkspaceYaml,
    pinReport,
    portSlotProblems,
    PROBE,
    singletonProblems,
    sssbPackagesOf,
    versionProblems,
    vitestInvocations,
    workspacePackages,
} from '../../packages/tools/src/commands/doctor-checks.js'
import {
    projectsRunning,
    vitestDefaultConfig,
    vitestList,
    vitestRunsFor,
} from '../../packages/tools/src/commands/doctor-vitest.js'
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

    it('reads block entries at column 0 and a flow sequence over several lines', () => {
        expect(parseWorkspaceYaml('packages:\n- apps/*\n- "packages/*"\nallowBuilds:\n  esbuild: true\n')).toEqual({
            packages: ['apps/*', 'packages/*'],
            dedupePeerDependents: undefined,
        })
        expect(parseWorkspaceYaml("packages: [\n    apps/*, # the apps\n    'packages/*',\n]\n").packages).toEqual([
            'apps/*',
            'packages/*',
        ])
        // A quoted `false` is a string in YAML, not the setting.
        expect(parseWorkspaceYaml("dedupePeerDependents: 'false'\n").dedupePeerDependents).toBeUndefined()
    })

    it.each([
        ['an anchor', 'packages: &globs\n  - apps/*\n'],
        ['a scalar, not a list', 'packages: apps/*\n'],
        ['an unquoted `!` (a YAML tag)', 'packages:\n  - !packages/legacy\n'],
        ['a nested list', 'packages:\n  - - apps/*\n'],
        ['a plain scalar continued on the next line', 'packages:\n  - apps/*\n    more\n'],
        ['a top-level flow mapping', '{ packages: [apps/*] }\n'],
        ['a second `packages`', 'packages: [a]\npackages: [b]\n'],
        ['an unclosed flow sequence', 'packages: [apps/*,\n'],
    ])('fails loudly on what it does not understand: %s', (_, yaml) => {
        expect(() => parseWorkspaceYaml(yaml)).toThrow(/pnpm-workspace\.yaml line \d+/)
    })

    it('opens a flow collection only where a value starts with `[` or `{`, and throws on one never closed', () => {
        // A bracket inside another key's plain scalar is text, so the packages after it are still read.
        expect(parseWorkspaceYaml('nodeOptions: --foo[bar\npackages:\n  - apps/*\n').packages).toEqual(['apps/*'])
        expect(parseWorkspaceYaml('scriptShell: x{y\npackages:\n  - apps/*\n').packages).toEqual(['apps/*'])
        expect(parseWorkspaceYaml("publicHoistPattern: [\n  '*eslint*',\n]\npackages:\n  - apps/*\n").packages).toEqual(
            ['apps/*'],
        )
        expect(() => parseWorkspaceYaml("packages:\n  - apps/*\noverrides: { a: '1',\n  b: '2'\n")).toThrow(
            /pnpm-workspace\.yaml line 3: a flow collection/,
        )
    })

    it('reads `dedupePeerDependents` from the next indented line too', () => {
        expect(parseWorkspaceYaml('packages: [a]\ndedupePeerDependents:\n  false\n').dedupePeerDependents).toBe(false)
        expect(parseWorkspaceYaml('dedupePeerDependents:\n  # why\n  true # yes\n').dedupePeerDependents).toBe(true)
        expect(parseWorkspaceYaml('dedupePeerDependents:\n  fal\n  se\n').dedupePeerDependents).toBeUndefined()
    })
})

describe('kitImporters', () => {
    it('counts a package that takes @sssb/kit as a peer or an optional dependency', () => {
        const ws = realpathSync(makeTestTmpDir('sssb-doctor-importers-'))
        write(path.join(ws, 'pnpm-workspace.yaml'), 'packages:\n  - packages/*\n')
        pkg(ws, { name: 'root', private: true })
        pkg(path.join(ws, 'packages', 'peer'), { name: 'peer', peerDependencies: { '@sssb/kit': '*' } })
        pkg(path.join(ws, 'packages', 'optional'), { name: 'optional', optionalDependencies: { '@sssb/kit': '*' } })
        pkg(path.join(ws, 'packages', 'dev'), { name: 'dev', devDependencies: { '@sssb/kit': '*' } })
        pkg(path.join(ws, 'packages', 'none'), { name: 'none' })
        expect(kitImporters(ws).map(({ dir }) => path.basename(dir))).toEqual(['dev', 'optional', 'peer'])
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
            optedOut: [{ id: 'beta', reason: 'the app has no beta' }],
            expected: 3,
        })
        // The delta marker opts the contract check out when the CONTRACT listing carries it.
        expect(missingTests(sample, registry, 'contract')).toEqual({
            missing: [],
            optedOut: [{ id: 'delta', reason: 'a contract opt-out in the unit listing' }],
            expected: 0,
        })
    })

    it('finds an opt-out marker under a describe too, and an empty listing misses everything', () => {
        expect(missingTests(['wrapper > [sssb:opt-out:alpha] why'], registry, 'unit').optedOut).toEqual([
            { id: 'alpha', reason: 'why' },
        ])
        expect(missingTests([], registry, 'unit').missing).toHaveLength(4)
    })
})

describe('ownTests: the names that can prove an app runs its checks', () => {
    const app = '/ws'
    const listed = [
        { name: '[sssb:alpha] the alpha check > one', file: '/ws/src/sssb.conformance.test.ts' },
        { name: '[sssb:opt-out:beta] forged', file: '/ws/src/other.test.ts' },
        { name: '[sssb:alpha] the alpha check > two', file: '/ws/apps/x/src/sssb.conformance.test.ts' },
        { name: '[sssb:delta] the delta check > five', file: '/ws/tests/contract/rls.test.ts' },
        { name: '[sssb:delta] the delta check > six', file: '/ws/apps/x/tests/contract/rls.test.ts' },
        { name: '[sssb:delta] the delta check > seven', file: '/ws/tests/e2e/rls.test.ts' },
    ]

    it("takes the unit names from the app's own src/sssb.conformance.test.ts alone, and contract names from its tests/contract", () => {
        expect(ownTests(listed, app, 'unit', ['/ws/apps/x'])).toEqual(['[sssb:alpha] the alpha check > one'])
        expect(ownTests(listed, app, 'contract', ['/ws/apps/x'])).toEqual(['[sssb:delta] the delta check > five'])
    })
})

describe('vitestInvocations: what package.json scripts pass to vitest', () => {
    it('names every narrowing flag and file filter, and the config each run names', () => {
        expect(
            vitestInvocations({
                plain: 'sssb check-tmpdir-leak vitest run',
                contract: 'vitest run --config vitest.contract.config.ts --coverage',
                narrowed:
                    "vitest run -t 'smoke test' --project=web --exclude '**/slow/**' --shard 1/3 --changed --typecheck.only src/a",
                chained: 'pnpm build && NODE_ENV=test node_modules/vitest/vitest.mjs related src/x.ts',
                wrapped: `sh -c "vitest --dir apps -c ci.config.ts"`,
                other: 'eslint .',
                notAString: 1,
            }),
        ).toEqual([
            { script: 'plain', config: null, narrowing: [] },
            { script: 'contract', config: 'vitest.contract.config.ts', narrowing: [] },
            {
                script: 'narrowed',
                config: null,
                narrowing: [
                    '-t smoke test',
                    '--project=web',
                    '--exclude **/slow/**',
                    '--shard 1/3',
                    '--changed',
                    '--typecheck.only',
                    'src/a',
                ],
            },
            { script: 'chained', config: null, narrowing: ['related', 'src/x.ts'] },
            { script: 'wrapped', config: 'ci.config.ts', narrowing: ['--dir apps'] },
        ])
    })
})

describe('where doctor runs Vitest, and which projects it selects', () => {
    const ws = realpathSync(makeTestTmpDir('sssb-doctor-runs-'))
    const app = pkg(path.join(ws, 'apps', 'a'), { name: 'a' })
    write(path.join(ws, 'pnpm-workspace.yaml'), 'packages:\n  - apps/*\n')

    it("tries Vitest's defaults from the app for the main run when a bare `vitest` there would load no config", () => {
        expect(vitestRunsFor(ws, app)).toEqual({ bare: [{ cwd: app, config: null }], configs: [] })
    })

    it('tries the bare runs from the root, then from the app; lists every config file, vite.config.* only where Vitest loads it', () => {
        for (const name of ['vitest.config.ts', 'vitest.ci.config.ts', 'vite.config.mjs', 'vite.demo.config.ts'])
            write(path.join(ws, name), 'export default {}\n')
        write(path.join(app, 'vitest.contract.config.mts'), 'export default {}\n')
        write(path.join(app, 'vitest-e2e.config.js'), 'export default {}\n')
        write(path.join(app, 'vite.config.ts'), 'export default {}\n')
        // The root's vite.config.mjs sits beside its vitest.config.ts, so Vitest never loads it; the app's vite.config.ts
        // has no vitest.config.* beside it, so a bare `vitest` in the app loads it.
        expect(vitestRunsFor(ws, app)).toEqual({
            bare: [
                { cwd: ws, config: path.join(ws, 'vitest.config.ts') },
                { cwd: app, config: path.join(app, 'vite.config.ts') },
            ],
            configs: [
                { cwd: ws, config: path.join(ws, 'vitest.config.ts') },
                { cwd: ws, config: path.join(ws, 'vitest.ci.config.ts') },
                { cwd: app, config: path.join(app, 'vite.config.ts') },
                { cwd: app, config: path.join(app, 'vitest-e2e.config.js') },
                { cwd: app, config: path.join(app, 'vitest.contract.config.mts') },
            ],
        })
        // Without its own, a bare `vitest` in the app walks up to the root's vitest.config.ts (before vite.config.*).
        rmSync(path.join(app, 'vite.config.ts'))
        expect(vitestDefaultConfig(app)).toBe(path.join(ws, 'vitest.config.ts'))
        expect(vitestRunsFor(ws, app).bare).toEqual([
            { cwd: ws, config: path.join(ws, 'vitest.config.ts') },
            { cwd: app, config: path.join(ws, 'vitest.config.ts') },
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
    write(
        path.join(ws, 'pnpm-workspace.yaml'),
        'packages:\n    - apps/*\n    - apps/*/src/app-config\n    - packages/*\n',
    )
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
            dependencies: { '@sssb/kit': 'file:../../kit.tgz', '@sssb/app-config': `workspace:${name}-app-config@*` },
        })
        const seam = pkg(path.join(dir, 'src', 'app-config'), { name: `${name}-app-config` })
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

    it('fails a seam declared as a `link:`, linked today, and says how to make it a workspace package', () => {
        const ws = seamWorkspace('sssb-doctor-seams-link-', 'none')
        const manifest = path.join(ws, 'apps', 'ledger', 'package.json')
        writeFileSync(
            manifest,
            readFileSync(manifest, 'utf8').replace('"workspace:ledger-app-config@*"', '"link:./src/app-config"'),
        )
        expect(importerSeamProblems(ws, kitDirOf).problems).toEqual([
            'apps/ledger: declares @sssb/app-config as link:./src/app-config, which the next `pnpm add <pkg>`, `remove` or `update <pkg>` for it unlinks from its @sssb/kit. ' +
                "Make the seam a workspace package: list apps/ledger/src/app-config in pnpm-workspace.yaml's packages, name it ledger-app-config in its package.json, " +
                'declare "@sssb/app-config": "workspace:ledger-app-config@*", and run pnpm install',
        ])
    })

    it('fails a seam whose name another workspace package also has, or none does: pnpm links one of them', () => {
        const ws = seamWorkspace('sssb-doctor-seams-dup-', 'none')
        // A copy of the console's seam left under its name, in a package that takes no kit: pnpm links the last one.
        pkg(path.join(ws, 'packages', 'stray'), { name: 'console-app-config' })
        expect(importerSeamProblems(ws, kitDirOf).problems).toEqual([
            'apps/console: declares @sssb/app-config as workspace:console-app-config@*, but 2 workspace packages are named console-app-config (apps/console/src/app-config, packages/stray), and pnpm links one of them: rename the copies',
        ])
        // The seams outside the workspace's globs: no package of that name.
        write(path.join(ws, 'pnpm-workspace.yaml'), 'packages:\n    - apps/*\n')
        expect(importerSeamProblems(ws, kitDirOf).problems).toEqual([
            'apps/console: declares @sssb/app-config as workspace:console-app-config@*, but no workspace package is named console-app-config',
            'apps/ledger: declares @sssb/app-config as workspace:ledger-app-config@*, but no workspace package is named ledger-app-config',
        ])
    })

    // Both directions: the app named is the borrower, whichever of the two the walk reaches first.
    it.each([
        ['ledger', 'console'],
        ['console', 'ledger'],
    ])("fails %s, which declares %s's seam as its own, with an instance of its own linked to it", (app, owner) => {
        const ws = seamWorkspace(`sssb-doctor-seams-borrowed-${app}-`, 'none')
        const ownerSeam = path.join(ws, 'apps', owner, 'src', 'app-config')
        const borrower = path.join(ws, 'apps', app)
        writeFileSync(
            path.join(borrower, 'package.json'),
            readFileSync(path.join(borrower, 'package.json'), 'utf8').replace(
                `${app}-app-config@*`,
                `${owner}-app-config@*`,
            ),
        )
        // pnpm links what the borrower declares: the owner's seam, beside the borrower's own instance too.
        rmSync(path.join(borrower, 'node_modules', '@sssb', 'app-config'))
        link(path.join(borrower, 'node_modules', '@sssb', 'app-config'), ownerSeam)
        const instanceSeam = path.join(
            realpathSync(path.join(borrower, 'node_modules', '@sssb', 'kit')),
            '..',
            'app-config',
        )
        rmSync(instanceSeam)
        link(instanceSeam, ownerSeam)
        expect(importerSeamProblems(ws, kitDirOf).problems).toEqual([
            `apps/${app}: declares @sssb/app-config as workspace:${owner}-app-config@*, which is apps/${owner}'s seam apps/${owner}/src/app-config, not one of its own`,
        ])
    })
})

describe('the installed layout', () => {
    // What pnpm 11 writes: JSON, which is YAML, with the layout it installed.
    const installed = (linker: string | null) => {
        const ws = realpathSync(makeTestTmpDir('sssb-doctor-linker-'))
        if (linker !== null)
            json(path.join(ws, 'node_modules', '.modules.yaml'), { layoutVersion: 5, nodeLinker: linker })
        return ws
    }

    const FIX =
        "SSSB needs nodeLinker isolated, pnpm's default, which gives each app its own @sssb/kit linked to its own seam " +
        "with no Plug'n'Play. Remove the nodeLinker setting from pnpm-workspace.yaml (and any " +
        'pnpm_config_node_linker variable or --config.node-linker flag), delete .pnp.cjs at the workspace root if it is ' +
        'there, then run pnpm install'

    it('passes isolated, pnpm’s default, and a workspace nothing is installed in', () => {
        expect(nodeLinkerProblem(installed('isolated'), {})).toBeNull()
        expect(nodeLinkerProblem(installed(null), {})).toBeNull()
    })

    it.each(['pnp', 'hoisted'])('fails nodeLinker %s, naming it and the fix', (linker) => {
        expect(nodeLinkerProblem(installed(linker), {})).toBe(
            `pnpm installed this workspace with nodeLinker ${linker} (node_modules/.modules.yaml). ${FIX}`,
        )
    })

    it('reads a damaged or YAML record, and fails one it cannot read', () => {
        const truncated = installed(null)
        write(path.join(truncated, 'node_modules', '.modules.yaml'), '{\n  "nodeLinker": "pnp",\n')
        expect(nodeLinkerProblem(truncated, {})).toMatch(/^pnpm installed this workspace with nodeLinker pnp /)
        const yaml = installed(null)
        write(path.join(yaml, 'node_modules', '.modules.yaml'), 'layoutVersion: 5\nnodeLinker: hoisted\n')
        expect(nodeLinkerProblem(yaml, {})).toMatch(/with nodeLinker hoisted /)
        const unreadable = installed(null)
        mkdirSync(path.join(unreadable, 'node_modules', '.modules.yaml'), { recursive: true })
        expect(nodeLinkerProblem(unreadable, {})).toMatch(/^node_modules\/\.modules\.yaml, .* cannot be read \(EISDIR/)
    })

    // Back on isolated, PnP's files outlive the setting, and `pnpm run` still loads them into every script.
    it("fails Plug'n'Play's files left at the root, and a doctor running under them, on an isolated layout", () => {
        const left = installed('isolated')
        write(path.join(left, '.pnp.cjs'), '')
        expect(nodeLinkerProblem(left, {})).toBe(
            `.pnp.cjs at the workspace root makes pnpm run every script under Plug'n'Play, whatever layout it installed. ${FIX}`,
        )
        expect(nodeLinkerProblem(installed('isolated'), { NODE_OPTIONS: '--require=/ws/.pnp.cjs' })).toBe(
            `doctor runs under Plug'n'Play (NODE_OPTIONS loads a .pnp.cjs: --require=/ws/.pnp.cjs). ${FIX}`,
        )
    })
})

describe('vitestList', () => {
    it('stops a listing that never finishes, and every process it started, and says so', async () => {
        const dir = realpathSync(makeTestTmpDir('sssb-doctor-hang-'))
        pkg(dir, { name: 'hang', private: true })
        // A "vitest" that never exits, with a "worker" of its own that never exits either; each run writes both pids down.
        const pidFile = path.join(dir, 'pids')
        pkg(path.join(dir, 'node_modules', 'vitest'), { name: 'vitest', version: '4.0.0', bin: { vitest: 'cli.js' } })
        write(
            path.join(dir, 'node_modules', 'vitest', 'cli.js'),
            "const worker = require('node:child_process').spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'inherit' })\n" +
                `require('node:fs').appendFileSync(${JSON.stringify(pidFile)}, \`\${process.pid} \${worker.pid}\\n\`)\n` +
                'setInterval(() => {}, 1000)\n',
        )
        const pids = () =>
            existsSync(pidFile) ? readFileSync(pidFile, 'utf8').split(/\s+/).filter(Boolean).map(Number) : []
        const alive = (pid: number) => {
            try {
                process.kill(pid, 0)
                return true
            } catch {
                return false
            }
        }
        try {
            const started = Date.now()
            const result = vitestList({ cwd: dir, config: null }, { timeoutMs: 1000 })
            expect(result).toEqual({
                ok: false,
                timedOut: true,
                error: 'vitest list did not finish within 1s, so doctor stopped it (SSSB_DOCTOR_VITEST_TIMEOUT sets the limit, in seconds)',
            })
            expect(Date.now() - started).toBeLessThan(5000)
            // Its worker went with it, rather than living on under init.
            await new Promise((resolve) => setTimeout(resolve, 300))
            expect(pids().filter(alive), 'processes the listing started outlived it').toEqual([])
            // The limit doctor uses, from the environment, in seconds, rounded up to a whole millisecond.
            process.env.SSSB_DOCTOR_VITEST_TIMEOUT = '0.0015'
            expect(vitestList({ cwd: dir, config: null })).toMatchObject({
                ok: false,
                error: expect.stringMatching(/within 0\.002s/),
            })
        } finally {
            delete process.env.SSSB_DOCTOR_VITEST_TIMEOUT
            // Whatever failed above, nothing of the fake's is left running.
            for (const pid of pids().filter(alive)) process.kill(pid, 'SIGKILL')
        }
    }, 20_000)
})

describe('in-repo mode', () => {
    const ws = realpathSync(makeTestTmpDir('sssb-doctor-in-repo-'))
    write(path.join(ws, 'pnpm-workspace.yaml'), "packages:\n  - 'apps/*'\n  - 'packages/*'\n  - '!packages/old'\n")
    const kit = pkg(path.join(ws, 'packages', 'kit'), { name: '@sssb/kit', version: '0.1.0' })
    pkg(path.join(ws, 'packages', 'old'), { name: 'old' })
    const app = pkg(path.join(ws, 'apps', 'a'), { name: 'a' })
    link(path.join(app, 'node_modules', '@sssb', 'kit'), kit)

    it('reads workspace globs with trailing slashes as the globs without them', () => {
        const slashed = realpathSync(makeTestTmpDir('sssb-doctor-slashes-'))
        write(
            path.join(slashed, 'pnpm-workspace.yaml'),
            `packages:\n  - 'apps/*///'\n  - 'packages/*/'\n  - '!packages/old${'/'.repeat(5_000)}'\n`,
        )
        const slashedKit = pkg(path.join(slashed, 'packages', 'kit'), { name: '@sssb/kit', version: '0.1.0' })
        pkg(path.join(slashed, 'packages', 'old'), { name: 'old' })
        const slashedApp = pkg(path.join(slashed, 'apps', 'a'), { name: 'a' })
        expect(workspacePackages(slashed)).toEqual([slashedApp, slashedKit])
    })

    it("is decided by where the app's kit really is: a package of the workspace, not a store copy", () => {
        expect(workspacePackages(ws)).toEqual([app, kit])
        expect(isInRepoKit(kitDirOf(app), ws)).toBe(true)
        const packed = seamWorkspace('sssb-doctor-packed-', 'none')
        expect(isInRepoKit(kitDirOf(path.join(packed, 'apps', 'console')), packed)).toBe(false)
    })

    it("fails an app whose tsconfig or Vitest project aliases another app's seam, or none", () => {
        const own = 'apps/a/src/app-config'
        const other = 'apps/b/src/app-config'
        const route = (find: string, to: string, ...resolved: string[]) => ({ find, to, resolved })
        expect(
            aliasProblems([
                {
                    app: 'apps/a',
                    own,
                    tsconfig: [route('@sssb/app-config/*', `${own}/*`, `${own}/probe`)],
                    projects: [
                        {
                            config: 'vitest.config.ts',
                            project: 'a',
                            routes: [route('@sssb/app-config', own, own, `${own}/probe`)],
                        },
                    ],
                },
            ]),
        ).toEqual([])
        expect(
            aliasProblems([
                {
                    app: 'apps/a',
                    own,
                    // A second target, and a key for the bare seam, are each held to the app's own.
                    tsconfig: [
                        route('@sssb/app-config/*', `${own}/*`, `${own}/probe`),
                        route('@sssb/app-config/*', `${other}/*`, `${other}/probe`),
                        route('@sssb/app-config', 'apps/a/src', 'apps/a/src'),
                    ],
                    projects: [
                        { config: 'vitest.config.ts', project: 'a', routes: [] },
                        {
                            config: 'vitest.contract.config.ts',
                            project: '',
                            routes: [route('/^@sssb\\/app-config\\/(.*)$/', `${other}/$1`, `${other}/probe`)],
                        },
                    ],
                },
                // An app-config look-alike (`apps/a/src/app-configs`) is not inside the seam.
                {
                    app: 'apps/c',
                    own: 'apps/c/src/app-config',
                    tsconfig: [],
                    projects: [
                        {
                            config: 'vitest.config.ts',
                            project: 'c',
                            routes: [route('@sssb', 'apps/c/src', 'apps/c/src/app-configs/probe')],
                        },
                    ],
                },
                { app: 'apps/d', own: 'apps/d/src/app-config', tsconfig: [], projects: [] },
            ]),
        ).toEqual([
            `apps/a: its tsconfig sends @sssb/app-config/* to ${other}/*, not its own ${own}`,
            `apps/a: its tsconfig sends @sssb/app-config to apps/a/src, not its own ${own}`,
            'apps/a: Vitest project a (vitest.config.ts) has no @sssb/app-config alias',
            `apps/a: Vitest the root project (vitest.contract.config.ts) aliases /^@sssb\\/app-config\\/(.*)$/ to ${other}/$1, not its own ${own}`,
            'apps/c: its tsconfig maps no @sssb/app-config path',
            'apps/c: Vitest project c (vitest.config.ts) aliases @sssb to apps/c/src, not its own apps/c/src/app-config',
            'apps/d: its tsconfig maps no @sssb/app-config path',
            'apps/d: no Vitest project runs its files, so none aliases its seam',
        ])
    })

    it('reads every alias that would match a seam specifier, string or RegExp, as Vite would apply it', () => {
        const ws = realpathSync(makeTestTmpDir('sssb-doctor-alias-routes-'))
        const own = pkg(path.join(ws, 'apps', 'a', 'src', 'app-config'), { name: '@sssb/app-config' })
        write(path.join(own, 'registrations.ts'), '')
        const other = path.join(ws, 'apps', 'b', 'src', 'app-config')
        const routes = aliasRoutes(
            [
                { find: '@sssb/kit', replacement: path.join(ws, 'packages', 'kit', 'src') },
                { find: '@sssb/app-config', replacement: own },
                { find: /^@sssb\/app-config\/registrations$/, replacement: path.join(other, 'registrations.ts') },
                { find: '@sssb', replacement: path.join(ws, 'packages') },
                { find: /^\/?@vite\/env/, replacement: '/@fs/env' },
            ],
            own,
        )
        expect(routes.map((r) => r.find)).toEqual([
            '@sssb/app-config',
            '/^@sssb\\/app-config\\/registrations$/',
            '@sssb',
        ])
        expect(routes[0]?.resolved).toContain(path.join(own, PROBE))
        expect(routes[1]?.resolved).toEqual([path.join(other, 'registrations.ts')])
        expect(routes[2]?.resolved).toContain(path.join(ws, 'packages', 'app-config'))
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

/**
 * `sssb doctor` run end to end, as a child process, over a workspace built on disk: a stand-in @sssb/kit that
 * publishes a three-check registry, apps whose test files name the checks the way the suite registers them, and the
 * real Vitest and TypeScript linked in. Each case is a layout a review found doctor passing when it must not.
 */
const REPO = path.resolve(import.meta.dirname, '..', '..')
const SSSB = path.join(REPO, 'packages', 'tools', 'bin', 'sssb.js')
const REGISTRY = {
    checks: [
        { id: 'alpha', runner: 'unit', title: 'the alpha check', tests: ['one', 'two'] },
        { id: 'beta', runner: 'unit', title: 'the beta check', tests: ['three'] },
        { id: 'delta', runner: 'contract', title: 'the delta check', tests: ['five'] },
    ],
}
const KIT_MANIFEST = {
    name: '@sssb/kit',
    version: '0.1.0',
    exports: { './package.json': './package.json', './testing/checks.json': './checks.json' },
}

/** A test file that registers `runner`'s checks as the suite names them, the `optOut` ids as the suite's marker. */
function suiteFile(runner: 'unit' | 'contract', optOut: Record<string, string> = {}, only?: string[]) {
    const lines = ["import { describe, it } from 'vitest'"]
    for (const check of REGISTRY.checks.filter((c) => c.runner === runner && (!only || only.includes(c.id)))) {
        const reason = optOut[check.id]
        if (reason) lines.push(`it(${JSON.stringify(`[sssb:opt-out:${check.id}] ${reason}`)}, () => {})`)
        else {
            lines.push(`describe(${JSON.stringify(`[sssb:${check.id}] ${check.title}`)}, () => {`)
            for (const test of check.tests) lines.push(`    it(${JSON.stringify(test)}, () => {})`)
            lines.push('})')
        }
    }
    return lines.join('\n') + '\n'
}

const UNIT_CONFIG = `import { readdirSync } from 'node:fs'
import path from 'node:path'
const at = (...p) => path.join(import.meta.dirname, ...p)
export default {
    test: {
        projects: readdirSync(at('apps')).map((app) => ({
            resolve: { alias: { '@sssb/app-config': at('apps', app, 'src', 'app-config') } },
            test: { name: app, root: at('apps', app), include: ['src/**/*.test.ts'] },
        })),
    },
}
`
const CONTRACT_CONFIG = `import { readdirSync } from 'node:fs'
import path from 'node:path'
const at = (...p) => path.join(import.meta.dirname, ...p)
export default {
    test: {
        projects: readdirSync(at('apps')).map((app) => ({
            resolve: { alias: { '@sssb/app-config': at('apps', app, 'src', 'app-config') } },
            test: { name: app, include: [\`apps/\${app}/tests/contract/**/*.test.ts\`] },
        })),
    },
}
`

type Mode = 'in-repo' | 'packed'

/** The stand-in framework at `dir`. */
function kitAt(dir: string) {
    pkg(dir, KIT_MANIFEST)
    json(path.join(dir, 'checks.json'), REGISTRY)
    return dir
}

/**
 * An app at `dir` (relative to `ws`): its own seam, a tsconfig that maps it, the unit suite in
 * `src/sssb.conformance.test.ts` (unless `conformance` is false), one other unit test, and the contract suite. In-repo,
 * its @sssb/kit is the workspace's packages/kit; packed, an instance of its own whose seam link is the app's.
 */
function addApp(ws: string, dir: string, mode: Mode, { conformance = true } = {}) {
    const app = path.join(ws, dir)
    pkg(app, {
        ...(dir === '.' ? { name: 'ws', private: true } : { name: path.basename(dir) }),
        dependencies: {
            '@sssb/kit': mode === 'in-repo' ? 'workspace:*' : 'file:kit.tgz',
            '@sssb/app-config': `workspace:${dir === '.' ? 'ws' : path.basename(dir)}-app-config@*`,
        },
    })
    const seam = pkg(path.join(app, 'src', 'app-config'), {
        name: `${dir === '.' ? 'ws' : path.basename(dir)}-app-config`,
    })
    write(path.join(seam, 'index.ts'), 'export const seam = true\n')
    json(path.join(app, 'tsconfig.json'), {
        compilerOptions: { paths: { '@sssb/app-config/*': ['./src/app-config/*'] } },
    })
    if (conformance) write(path.join(app, 'src', 'sssb.conformance.test.ts'), suiteFile('unit'))
    write(path.join(app, 'src', 'thing.test.ts'), "import { it } from 'vitest'\nit('an app test', () => {})\n")
    write(path.join(app, 'tests', 'contract', 'rls.test.ts'), suiteFile('contract'))
    let kit = path.join(ws, 'packages', 'kit')
    if (mode === 'packed') {
        const home = path.join(ws, 'store', dir === '.' ? 'root' : path.basename(dir), 'node_modules')
        kit = kitAt(path.join(home, '@sssb', 'kit'))
        link(path.join(home, '@sssb', 'app-config'), seam)
    }
    link(path.join(app, 'node_modules', '@sssb', 'kit'), kit)
    link(path.join(app, 'node_modules', '@sssb', 'app-config'), seam)
    return app
}

/** A workspace of `apps` under apps/, with root configs that give each app a unit and a contract project. */
function doctorWorkspace(prefix: string, mode: Mode, apps: string[] = ['a', 'b']) {
    const ws = realpathSync(makeTestTmpDir(prefix))
    // Each app's seam is a workspace package, as a generated workspace's is.
    write(
        path.join(ws, 'pnpm-workspace.yaml'),
        'packages:\n    - apps/*\n    - apps/*/src/app-config\n    - packages/*\n',
    )
    pkg(ws, {
        name: 'ws',
        private: true,
        scripts: { 'test:unit': 'vitest run', 'test:contract': 'vitest run --config vitest.contract.config.mjs' },
    })
    link(path.join(ws, 'node_modules', 'vitest'), realpathSync(path.join(REPO, 'node_modules', 'vitest')))
    link(path.join(ws, 'node_modules', 'typescript'), realpathSync(path.join(REPO, 'node_modules', 'typescript')))
    if (mode === 'in-repo') kitAt(path.join(ws, 'packages', 'kit'))
    for (const app of apps) addApp(ws, `apps/${app}`, mode)
    write(path.join(ws, 'vitest.config.mjs'), UNIT_CONFIG)
    write(path.join(ws, 'vitest.contract.config.mjs'), CONTRACT_CONFIG)
    return ws
}

/** `sssb doctor --app <app>`, run as a child process from the workspace root, out of this Vitest's environment. */
async function doctor(ws: string, app: string, extraEnv: Record<string, string> = {}) {
    const env = { ...process.env, ...extraEnv }
    for (const key of Object.keys(env)) if (key.startsWith('VITEST')) delete env[key]
    const run = promisify(execFile)
    try {
        const { stdout, stderr } = await run(process.execPath, [SSSB, 'doctor', '--app', path.join(ws, app)], {
            cwd: ws,
            env,
            maxBuffer: 16 * 1024 * 1024,
        })
        return { code: 0, out: `${stdout}${stderr}` }
    } catch (error) {
        const failed = error as { code?: number; stdout?: string; stderr?: string }
        return { code: failed.code ?? -1, out: `${failed.stdout ?? ''}${failed.stderr ?? ''}` }
    }
}

/** `sssb doctor <args>`, run as a child process from `cwd`, out of this Vitest's environment. */
async function doctorIn(cwd: string, args: string[] = []) {
    const env = { ...process.env }
    for (const key of Object.keys(env)) if (key.startsWith('VITEST')) delete env[key]
    const run = promisify(execFile)
    try {
        const { stdout, stderr } = await run(process.execPath, [SSSB, 'doctor', ...args], {
            cwd,
            env,
            maxBuffer: 16 * 1024 * 1024,
        })
        return { code: 0, out: `${stdout}${stderr}` }
    } catch (error) {
        const failed = error as { code?: number; stdout?: string; stderr?: string }
        return { code: failed.code ?? -1, out: `${failed.stdout ?? ''}${failed.stderr ?? ''}` }
    }
}

const E2E_TIMEOUT = 120_000

describe.concurrent('sssb doctor, end to end over a workspace on disk', () => {
    it(
        'passes a conforming workspace, reporting each opt-out with its reason, the scripts that narrow a vitest run, and the contract script',
        async () => {
            const ws = doctorWorkspace('sssb-doctor-e2e-ok-', 'in-repo')
            write(
                path.join(ws, 'apps', 'a', 'src', 'sssb.conformance.test.ts'),
                suiteFile('unit', { beta: 'a has no beta' }),
            )
            const manifest = JSON.parse(readFileSync(path.join(ws, 'package.json'), 'utf8'))
            manifest.scripts['test:ci'] = "vitest run -t 'smoke' --shard=1/2 apps/a"
            json(path.join(ws, 'package.json'), manifest)
            const { code, out } = await doctor(ws, 'apps/a')
            expect(out).toMatch(/^report +apps\/a: opted out of beta: a has no beta$/m)
            expect(out).toMatch(/^ok +apps\/b: the conformance suite would run/m)
            expect(out).toMatch(/doctor proves what each Vitest configuration would run, not what/)
            expect(out).toMatch(/test:ci: .*-t smoke.*--shard=1\/2.*apps\/a/)
            expect(out).toMatch(
                /^report +.*contract.*\n(.*\n)*.*root script test:contract runs vitest\.contract\.config\.mjs/m,
            )
            expect(code, out).toBe(0)
        },
        E2E_TIMEOUT,
    )

    it(
        "reports, and does not fail, a config beside the main one that runs the app's src/ tests but not the suite (vitest.ci.config.ts); fails when no config a bare `vitest` loads runs them",
        async () => {
            const ws = doctorWorkspace('sssb-doctor-e2e-ci-config-', 'packed', ['web'])
            const ci = path.join(ws, 'vitest.ci.config.ts')
            write(
                ci,
                "import { defineConfig } from 'vitest/config'\nexport default defineConfig({ test: { include: ['apps/*/src/**/*.test.ts'], exclude: ['**/node_modules/**', '**/sssb.*'] } })\n",
            )
            const report =
                /^report +apps\/web: vitest\.ci\.config\.ts runs 1 of its src\/ test files but not src\/sssb\.conformance\.test\.ts: if CI runs it instead of vitest\.config\.mjs, the conformance checks do not run$/m
            const beside = await doctor(ws, 'apps/web')
            expect(beside.out).toMatch(report)
            expect(beside.out).toMatch(/^ok +apps\/web: the conformance suite would run: all 3 tests listed/m)
            expect(beside.code, beside.out).toBe(0)

            // The root has only the ci config: a bare `vitest` from the app then loads no config at all (Vitest walks up
            // and finds none), so Vitest's defaults there are the main run; they list the suite, and the ci config is
            // still a report.
            rmSync(path.join(ws, 'vitest.config.mjs'))
            const alone = await doctor(ws, 'apps/web')
            expect(alone.out).toMatch(
                /^ok +apps\/web: the conformance suite would run: all 3 tests listed \(vitest list from apps\/web, Vitest's defaults\)$/m,
            )
            expect(alone.out).toMatch(/^report +apps\/web: vitest\.ci\.config\.ts runs 1 of its src\/ test files/m)
            expect(alone.code, alone.out).toBe(0)

            // A root vitest.config.* that runs only packages/: the config a bare `vitest` loads (from the root, and from
            // the app, by walking up) runs none of the app's src/ tests, so nothing holds it to the suite.
            write(
                path.join(ws, 'vitest.config.mjs'),
                "export default { test: { include: ['packages/**/*.test.ts'] } }\n",
            )
            const none = await doctor(ws, 'apps/web')
            expect(none.out).toMatch(
                /^FAIL +apps\/web: the conformance suite would run: no config a bare `vitest` would load for apps\/web runs a test file of its src\/ \(tried vitest\.config\.mjs, vitest\.config\.mjs from apps\/web\)/m,
            )
            expect(none.out).toMatch(/^report +apps\/web: vitest\.ci\.config\.ts runs 1 of its src\/ test files/m)
            expect(none.code).toBe(1)
        },
        E2E_TIMEOUT,
    )

    it(
        "reports, and does not fail, the bare `vitest` from the app's directory when the root's is the main run and it would not run the suite",
        async () => {
            const ws = doctorWorkspace('sssb-doctor-e2e-app-dir-bare-', 'packed', ['web'])
            // Root-relative globs: from the root they reach the app's files; a bare `vitest` from apps/web (the app's
            // own `vitest run` script, which a `pnpm -r test` CI runs) walks up to this config, globs from apps/web,
            // finds nothing, and passes on `passWithNoTests`.
            write(
                path.join(ws, 'vitest.config.mjs'),
                "export default { test: { include: ['apps/*/src/**/*.test.ts'], passWithNoTests: true } }\n",
            )
            const web = path.join(ws, 'apps', 'web')
            write(
                path.join(web, 'setup.ts'),
                "import { writeFileSync } from 'node:fs'\nexport default function () { writeFileSync(new URL('./GLOBAL_SETUP_RAN', import.meta.url), 'ran') }\n",
            )
            const { code, out } = await doctor(ws, 'apps/web')
            expect(out).toMatch(
                /^ok +apps\/web: the conformance suite would run: all 3 tests listed \(vitest list from the workspace root --config vitest\.config\.mjs\)$/m,
            )
            expect(out).toMatch(
                /^report +apps\/web: a bare `vitest` from apps\/web loads vitest\.config\.mjs and runs none of its src\/ test files, so not src\/sssb\.conformance\.test\.ts: if CI runs it there \(the app's own scripts, `pnpm -r`\) instead of vitest\.config\.mjs from the root, the conformance checks do not run$/m,
            )
            expect(code, out).toBe(0)

            // That run is only reported: when it reaches the app's tests/contract/ files (its second glob does, from
            // apps/web), it does not join the contract configs, which doctor lists in full.
            write(
                path.join(ws, 'vitest.config.mjs'),
                "export default { test: { include: ['apps/*/src/**/*.test.ts', 'tests/contract/**/*.test.ts'] } }\n",
            )
            const contract = await doctor(ws, 'apps/web')
            expect(contract.out).toMatch(
                /^report +apps\/web: a bare `vitest` from apps\/web loads vitest\.config\.mjs/m,
            )
            expect(contract.out).not.toMatch(/the contract runner's checks would run: .*\(vitest list from apps\/web/)
            expect(contract.code, contract.out).toBe(0)

            // The same, when it runs some of the app's src/ files but not the suite (a globalSetup it must not run).
            write(
                path.join(web, 'vitest.config.mjs'),
                "export default { test: { include: ['src/thing.test.ts'], globalSetup: ['./setup.ts'] } }\n",
            )
            write(
                path.join(ws, 'vitest.config.mjs'),
                "export default { test: { include: ['apps/*/src/**/*.test.ts'] } }\n",
            )
            const partial = await doctor(ws, 'apps/web')
            expect(partial.out).toMatch(
                /^report +apps\/web: a bare `vitest` from apps\/web loads apps\/web\/vitest\.config\.mjs and runs 1 of its src\/ test files but not src\/sssb\.conformance\.test\.ts: if CI runs it there/m,
            )
            expect(partial.code, partial.out).toBe(0)
            expect(existsSync(path.join(web, 'GLOBAL_SETUP_RAN'))).toBe(false)
        },
        E2E_TIMEOUT,
    )

    it(
        "reports, never runs in full, other configs that run some of the app's src/ tests (browser, integration with a globalSetup)",
        async () => {
            const ws = doctorWorkspace('sssb-doctor-e2e-other-configs-', 'packed', ['web'])
            const web = path.join(ws, 'apps', 'web')
            write(
                path.join(web, 'src', 'button.browser.test.ts'),
                "import { it } from 'vitest'\nit('renders', () => {})\n",
            )
            write(
                path.join(web, 'vitest.browser.config.ts'),
                "export default { test: { include: ['src/**/*.browser.test.ts'] } }\n",
            )
            write(path.join(web, 'src', 'db.int.test.ts'), "import { it } from 'vitest'\nit('integrates', () => {})\n")
            write(
                path.join(web, 'setup.ts'),
                "import { writeFileSync } from 'node:fs'\nexport default function () { writeFileSync(new URL('./GLOBAL_SETUP_RAN', import.meta.url), 'ran') }\n",
            )
            write(
                path.join(web, 'vitest.integration.config.ts'),
                "export default { test: { include: ['src/**/*.int.test.ts'], globalSetup: ['./setup.ts'] } }\n",
            )
            const { code, out } = await doctor(ws, 'apps/web')
            expect(out).toMatch(
                /^report +apps\/web: apps\/web\/vitest\.browser\.config\.ts runs 1 of its src\/ test files but not src\/sssb\.conformance\.test\.ts: if CI runs it instead of vitest\.config\.mjs, the conformance checks do not run$/m,
            )
            expect(out).toMatch(
                /^report +apps\/web: apps\/web\/vitest\.integration\.config\.ts runs 1 of its src\/ test files/m,
            )
            expect(code, out).toBe(0)
            // Discovery is `vitest list --filesOnly`, which loads no globalSetup; only the main and contract configs are
            // listed in full.
            expect(existsSync(path.join(web, 'GLOBAL_SETUP_RAN'))).toBe(false)
        },
        E2E_TIMEOUT,
    )

    it(
        'reports a config other than the main one that it cannot list, with the error line, not the banner',
        async () => {
            const ws = doctorWorkspace('sssb-doctor-e2e-unlistable-', 'packed', ['web'])
            write(
                path.join(ws, 'apps', 'web', 'vitest.e2e.config.ts'),
                "if (!process.env.E2E_BASE_URL) throw new Error('set E2E_BASE_URL')\nexport default { test: { include: ['tests/e2e/**/*.test.ts'] } }\n",
            )
            const { code, out } = await doctor(ws, 'apps/web')
            expect(out).toMatch(
                /^report +apps\/web: doctor cannot list apps\/web\/vitest\.e2e\.config\.ts, so it cannot tell what that config runs/m,
            )
            expect(out).toMatch(/vitest list exited 1: Error: set E2E_BASE_URL/)
            expect(out).not.toMatch(/Collect Error/)
            expect(code, out).toBe(0)
        },
        E2E_TIMEOUT,
    )

    it(
        'holds no build-only vite.config.* beside a vitest.config.* to the suite (Vitest never loads it)',
        async () => {
            const ws = doctorWorkspace('sssb-doctor-e2e-vite-build-', 'packed', ['web'])
            rmSync(path.join(ws, 'vitest.config.mjs'))
            const web = path.join(ws, 'apps', 'web')
            // The app's tests need an alias only its vitest.config.ts sets; the vite.config.ts beside it builds.
            write(path.join(web, 'src', 'lib.ts'), 'export const x = 1\n')
            write(
                path.join(web, 'src', 'thing.test.ts'),
                "import { it } from 'vitest'\nimport { x } from '@/lib'\nit('an app test', () => { void x })\n",
            )
            write(
                path.join(web, 'vitest.config.ts'),
                "import path from 'node:path'\nexport default { resolve: { alias: { '@': path.join(import.meta.dirname, 'src') } }, test: { include: ['src/**/*.test.ts'] } }\n",
            )
            write(path.join(web, 'vite.config.ts'), "export default { build: { outDir: 'dist' } }\n")
            const { code, out } = await doctor(ws, 'apps/web')
            expect(out).toMatch(
                /^ok +apps\/web: the conformance suite would run: all 3 tests listed \(.*vitest\.config\.ts/m,
            )
            expect(out).not.toMatch(/vite\.config\.ts/)
            expect(code, out).toBe(0)
        },
        E2E_TIMEOUT,
    )

    it(
        'passes the contract checks when one config that runs its tests/contract/ files lists them all, and reports the others',
        async () => {
            const ws = doctorWorkspace('sssb-doctor-e2e-contract-others-', 'packed', ['web'])
            write(
                path.join(ws, 'apps', 'web', 'tests', 'contract', 'smoke.test.ts'),
                "import { it } from 'vitest'\nit('smoke', () => {})\n",
            )
            write(
                path.join(ws, 'vitest.smoke.config.mjs'),
                "export default { test: { include: ['apps/*/tests/contract/smoke.test.ts'] } }\n",
            )
            const { code, out } = await doctor(ws, 'apps/web')
            expect(out).toMatch(
                /^ok +apps\/web: the contract runner's checks would run: all 1 tests listed \(.*vitest\.contract\.config\.mjs/m,
            )
            expect(out).toMatch(
                /^report +apps\/web: vitest\.smoke\.config\.mjs runs its tests\/contract\/ files but 1 of its 1 contract tests would not run: if CI runs it instead of vitest\.contract\.config\.mjs, those checks do not run$/m,
            )
            expect(code, out).toBe(0)
            // With no config listing them, every config that runs the files fails.
            rmSync(path.join(ws, 'vitest.contract.config.mjs'))
            const none = await doctor(ws, 'apps/web')
            expect(none.out).toMatch(
                /^FAIL +apps\/web: the contract runner's checks would run: 1 of its 1 tests would not run \(.*vitest\.smoke\.config\.mjs/m,
            )
            expect(none.code).toBe(1)
        },
        E2E_TIMEOUT,
    )

    it(
        "honours an opt-out marker only from the app's own src/sssb.conformance.test.ts",
        async () => {
            const ws = doctorWorkspace('sssb-doctor-e2e-forged-', 'packed', ['web'])
            const src = path.join(ws, 'apps', 'web', 'src')
            write(path.join(src, 'sssb.conformance.test.ts'), suiteFile('unit', {}, ['alpha']))
            write(path.join(src, 'thing.test.ts'), suiteFile('unit', { beta: 'forged elsewhere' }, ['beta']))
            const { code, out } = await doctor(ws, 'apps/web')
            expect(out).toMatch(/not listed: \[sssb:beta\] the beta check > three/)
            expect(code).toBe(1)
        },
        E2E_TIMEOUT,
    )

    it(
        'follows a tsconfig target as TypeScript does: only its first * is the match, a second is a literal *',
        async () => {
            const ws = doctorWorkspace('sssb-doctor-e2e-stars-', 'in-repo')
            const a = path.join(ws, 'apps', 'a')
            const b = path.join(ws, 'apps', 'b')
            json(path.join(a, 'tsconfig.json'), {
                compilerOptions: { paths: { '@sssb/app-config/*': ['./src/app-config/*/*'] } },
            })
            // TypeScript's resolver fills the FIRST star and leaves the second as a literal `*` (`replaceFirstStar`),
            // and only rejects such a target when it builds a program (TS5062). Where the probe lands through the
            // first star is a real directory holding a link literally named `*` to another app's seam, so TypeScript
            // would resolve this app's seam into app b's, and doctor must say so.
            const probeDir = path.join(a, 'src', 'app-config', '__sssb_doctor_probe__')
            mkdirSync(probeDir, { recursive: true })
            link(path.join(probeDir, '*'), path.join(b, 'src', 'app-config'))
            const { code, out } = await doctor(ws, 'apps/a')
            expect(out).toMatch(/apps\/a: its tsconfig sends/)
            expect(code).toBe(1)
        },
        E2E_TIMEOUT,
    )

    it(
        "fails a tsconfig target or a Vitest alias (RegExp, array form) that sends the seam to another app's",
        async () => {
            const ws = doctorWorkspace('sssb-doctor-e2e-aliases-', 'in-repo')
            const a = path.join(ws, 'apps', 'a')
            json(path.join(a, 'tsconfig.json'), {
                compilerOptions: {
                    paths: { '@sssb/app-config/*': ['./src/app-config/*', '../b/src/app-config/*'] },
                },
            })
            write(
                path.join(ws, 'vitest.config.mjs'),
                UNIT_CONFIG.replace(
                    "resolve: { alias: { '@sssb/app-config': at('apps', app, 'src', 'app-config') } }",
                    "resolve: { alias: [{ find: /^@sssb\\/app-config\\/(.*)$/, replacement: at('apps', 'b', 'src', 'app-config') + '/$1' }, { find: '@sssb/app-config', replacement: at('apps', app, 'src', 'app-config') }] }",
                ),
            )
            const { code, out } = await doctor(ws, 'apps/a')
            expect(out).toMatch(/apps\/a: its tsconfig sends @sssb\/app-config\/\* to apps\/b\/src\/app-config/)
            expect(out).toMatch(
                /apps\/a: Vitest project a \(vitest\.config\.mjs\) aliases .*app-config.* to apps\/b\/src\/app-config/,
            )
            expect(code).toBe(1)
        },
        E2E_TIMEOUT,
    )

    it(
        'checks the conformance listing of every app in the workspace, not only the one it runs for',
        async () => {
            const ws = doctorWorkspace('sssb-doctor-e2e-every-app-', 'packed')
            addApp(ws, 'apps/c', 'packed', { conformance: false })
            const { code, out } = await doctor(ws, 'apps/a')
            expect(out).toMatch(/^FAIL +apps\/c: the conformance suite would run/m)
            expect(code).toBe(1)
        },
        E2E_TIMEOUT,
    )

    it(
        "counts the tests in an app's seam as the app's, though the seam is a workspace package of its own",
        async () => {
            const ws = doctorWorkspace('sssb-doctor-e2e-seam-tests-', 'packed')
            write(
                path.join(ws, 'apps', 'a', 'src', 'app-config', 'abilities.test.ts'),
                "import { it } from 'vitest'\nit('a seam test', () => {})\n",
            )
            write(
                path.join(ws, 'apps', 'a', 'vitest.seam.config.mjs'),
                "export default { test: { include: ['src/app-config/**/*.test.ts'] } }\n",
            )
            const { out } = await doctor(ws, 'apps/a')
            expect(out).toMatch(/vitest\.seam\.config\.mjs runs 1 of its src\/ test files but not/)
        },
        E2E_TIMEOUT,
    )

    it(
        "does not count a nested app's tests for an app at the workspace root",
        async () => {
            const ws = realpathSync(makeTestTmpDir('sssb-doctor-e2e-nested-'))
            write(path.join(ws, 'pnpm-workspace.yaml'), 'packages:\n    - apps/*\n')
            link(path.join(ws, 'node_modules', 'vitest'), realpathSync(path.join(REPO, 'node_modules', 'vitest')))
            addApp(ws, '.', 'packed', { conformance: false })
            rmSync(path.join(ws, 'tests'), { recursive: true })
            addApp(ws, 'apps/x', 'packed')
            write(
                path.join(ws, 'vitest.config.mjs'),
                "export default { test: { include: ['**/src/**/*.test.ts'], exclude: ['**/node_modules/**'] } }\n",
            )
            write(
                path.join(ws, 'vitest.contract.config.mjs'),
                "export default { test: { include: ['**/tests/contract/**/*.test.ts'], exclude: ['**/node_modules/**'] } }\n",
            )
            const { code, out } = await doctor(ws, '.')
            expect(out).toMatch(/^FAIL +\(the workspace root\): the conformance suite would run/m)
            expect(out).toMatch(/^FAIL +\(the workspace root\): the contract runner's checks would run/m)
            expect(code).toBe(1)
        },
        E2E_TIMEOUT,
    )

    it(
        'fails at once, before any check, in a workspace pnpm installed with nodeLinker pnp',
        async () => {
            const ws = doctorWorkspace('sssb-doctor-e2e-pnp-', 'packed')
            json(path.join(ws, 'node_modules', '.modules.yaml'), { layoutVersion: 5, nodeLinker: 'pnp' })
            const started = Date.now()
            const { code, out } = await doctor(ws, 'apps/a')
            expect(out).toMatch(/^FAIL +installed layout: pnpm installed this workspace with nodeLinker pnp/m)
            expect(out).toMatch(/Nothing else is checked until it is\nsssb doctor: 1 problem\(s\)\n$/)
            expect(out).not.toMatch(/conformance suite|vitest list/)
            expect(code).toBe(1)
            expect(Date.now() - started).toBeLessThan(10_000)
        },
        E2E_TIMEOUT,
    )

    it(
        'waits out one listing that never finishes, not every listing after it',
        async () => {
            const ws = doctorWorkspace('sssb-doctor-e2e-hang-', 'packed')
            // Configs that never finish loading: each listing of them would run to the limit.
            const hang = 'setInterval(() => {}, 1000)\nexport default new Promise(() => {})\n'
            write(path.join(ws, 'vitest.config.mjs'), hang)
            write(path.join(ws, 'vitest.contract.config.mjs'), hang)
            const started = Date.now()
            const { code, out } = await doctor(ws, 'apps/a', { SSSB_DOCTOR_VITEST_TIMEOUT: '3' })
            const seconds = (Date.now() - started) / 1000
            expect(out).toMatch(/vitest list did not finish within 3s, so doctor stopped it/)
            expect(out).toMatch(/not listed, since an earlier listing ran out of time/)
            expect(code).toBe(1)
            // One limit, plus doctor's own work; not one per listing.
            expect(seconds).toBeLessThan(9)
        },
        E2E_TIMEOUT,
    )

    /** Declares `port` as the app's slot in `ws/<dir>/package.json`. */
    function declarePort(ws: string, dir: string, port: unknown) {
        const file = path.join(ws, dir, 'package.json')
        const manifest = JSON.parse(readFileSync(file, 'utf8'))
        manifest.sssb = { ...manifest.sssb, port }
        json(file, manifest)
    }

    it(
        'FAILS two apps that declare one port slot, and passes them once each declares its own',
        async () => {
            const ws = doctorWorkspace('sssb-doctor-e2e-port-slots-', 'in-repo')
            declarePort(ws, 'apps/a', 'starter')
            declarePort(ws, 'apps/b', 'starter')
            const same = await doctor(ws, 'apps/a')
            expect(same.out).toMatch(/^FAIL +port slots: no two apps bind one port$/m)
            expect(same.out).toMatch(/- apps\/a and apps\/b declare the same port slot "starter"/)
            expect(same.code, same.out).toBe(1)

            // The same two, each on a slot of its own: the check passes and says where each one binds.
            declarePort(ws, 'apps/a', { name: 'ledger', default: 3700 })
            declarePort(ws, 'apps/b', { name: 'portal', default: 3710 })
            const distinct = await doctor(ws, 'apps/a')
            expect(distinct.out).toMatch(/^ok +port slots: no two apps bind one port$/m)
            expect(distinct.out).toMatch(/apps\/a: slot "ledger", port 3700 in a main checkout/)
            expect(distinct.out).toMatch(/apps\/b: slot "portal", port 3710 in a main checkout/)
            expect(distinct.code, distinct.out).toBe(0)

            // A built-in beside a custom slot is fine too, and an app with no declaration is not checked.
            declarePort(ws, 'apps/a', 'starter')
            const mixed = await doctor(ws, 'apps/a')
            expect(mixed.code, mixed.out).toBe(0)
        },
        E2E_TIMEOUT,
    )

    it(
        'FAILS an app whose port declaration is not valid, naming its package.json, and two slots on one default',
        async () => {
            const ws = doctorWorkspace('sssb-doctor-e2e-port-bad-', 'in-repo')
            declarePort(ws, 'apps/a', { name: 'Ledger', default: 3700 })
            const invalid = await doctor(ws, 'apps/a')
            expect(invalid.out).toMatch(/- apps\/a: .*apps\/a\/package\.json: a port slot's name is lowercase words/)
            expect(invalid.code, invalid.out).toBe(1)

            declarePort(ws, 'apps/a', { name: 'ledger', default: 3700 })
            declarePort(ws, 'apps/b', { name: 'portal', default: 3700 })
            const clash = await doctor(ws, 'apps/a')
            expect(clash.out).toMatch(
                /- apps\/a and apps\/b declare port slots \("ledger", "portal"\) with one default, 3700/,
            )
            expect(clash.code, clash.out).toBe(1)
        },
        E2E_TIMEOUT,
    )

    it(
        'reads column-0 `packages` entries, so a seamless importer there is named',
        async () => {
            const ws = doctorWorkspace('sssb-doctor-e2e-col0-', 'packed')
            write(path.join(ws, 'pnpm-workspace.yaml'), 'packages:\n- apps/*\n- packages/*\n')
            const seamless = pkg(path.join(ws, 'packages', 'seamless'), {
                name: 'seamless',
                dependencies: { '@sssb/kit': 'file:kit.tgz' },
            })
            link(
                path.join(seamless, 'node_modules', '@sssb', 'kit'),
                realpathSync(path.join(ws, 'apps', 'a', 'node_modules', '@sssb', 'kit')),
            )
            const { code, out } = await doctor(ws, 'apps/a')
            expect(out).toMatch(/packages\/seamless: takes @sssb\/kit but declares no seam link/)
            expect(code).toBe(1)
        },
        E2E_TIMEOUT,
    )

    it(
        "fails an adopter's missing or stale guide copy; in-repo, reports a missing one and checks one that exists",
        async () => {
            /** The kit at `dir` starts shipping a guide, as @sssb/kit does from ADR-0014 P7. */
            const shipGuide = (dir: string) => {
                pkg(dir, { ...KIT_MANIFEST, exports: { ...KIT_MANIFEST.exports, './guide.md': './guide.md' } })
                write(path.join(dir, 'guide.md'), '# Rules\n')
            }
            const copy = (ws: string) => path.join(ws, '.claude', 'sssb-guide.md')

            const packed = doctorWorkspace('sssb-doctor-e2e-guide-packed-', 'packed', ['web'])
            shipGuide(path.join(packed, 'store', 'web', 'node_modules', '@sssb', 'kit'))
            const adopter = await doctor(packed, 'apps/web')
            expect(adopter.out).toMatch(/^FAIL +apps\/web: app guide: the repository's copy is not the kit's/m)
            expect(adopter.code).toBe(1)

            const inRepo = doctorWorkspace('sssb-doctor-e2e-guide-in-repo-', 'in-repo', ['web'])
            shipGuide(path.join(inRepo, 'packages', 'kit'))
            const none = await doctor(inRepo, 'apps/web')
            expect(none.out).toMatch(
                /^report +app guide: not checked: in-repo, .*neither imports it from CLAUDE\.md \(@packages\/kit\/guide\.md\) nor holds a copy of it/m,
            )
            expect(none.code, none.out).toBe(0)

            // SSSB's own repository imports the source itself, which nothing can make stale; a mention in a code span
            // is no import.
            write(path.join(inRepo, 'CLAUDE.md'), '# Maintainers\n\nNot `@packages/kit/guide.md` here.\n')
            const mentioned = await doctor(inRepo, 'apps/web')
            expect(mentioned.out).toMatch(/^report +app guide: not checked: in-repo/m)
            write(path.join(inRepo, 'CLAUDE.md'), '# Maintainers\n\n@packages/kit/guide.md\n')
            const imported = await doctor(inRepo, 'apps/web')
            expect(imported.out).toMatch(
                /^ok +app guide: in-repo, CLAUDE\.md imports the kit's guide from its source \(@packages\/kit\/guide\.md\)/m,
            )
            expect(imported.code, imported.out).toBe(0)

            write(copy(inRepo), '# A copy with no stamp\n')
            const stale = await doctor(inRepo, 'apps/web')
            expect(stale.out).toMatch(/^FAIL +apps\/web: app guide: the repository's copy is not the kit's/m)
            expect(stale.code).toBe(1)
        },
        E2E_TIMEOUT,
    )

    it(
        "reports the workflow and plugin pins against the app's kit's release stamp, and never fails on them",
        async () => {
            const sha = 'c'.repeat(40)
            const packed = doctorWorkspace('sssb-doctor-e2e-pins-', 'packed', ['web'])
            const kit = path.join(packed, 'store', 'web', 'node_modules', '@sssb', 'kit')
            pkg(kit, {
                ...KIT_MANIFEST,
                repository: { type: 'git', url: 'git+https://github.com/safeinsights/sssb.git' },
            })
            write(path.join(kit, 'dist', 'release.json'), `${JSON.stringify({ commit: sha })}\n`)
            const uses = (ref: string) =>
                `jobs:\n    sssb:\n        uses: safeinsights/sssb/.github/workflows/app-checks.yml@${ref}\n`
            const settings = (ref: string) =>
                JSON.stringify({
                    extraKnownMarketplaces: { sssb: { source: { source: 'github', repo: 'safeinsights/sssb', ref } } },
                    enabledPlugins: { 'sssb@sssb': true },
                })
            write(path.join(packed, '.github', 'workflows', 'checks.yml'), uses(sha))

            const noSettings = await doctor(packed, 'apps/web')
            expect(noSettings.out).toMatch(/^report +workflow and plugin pins: not every pin is there/m)
            expect(noSettings.out).toMatch(/^ +no \.claude\/settings\.json: no plugin marketplace pin/m)
            expect(noSettings.code, noSettings.out).toBe(0)

            write(path.join(packed, '.claude', 'settings.json'), settings('d'.repeat(40)))
            const mismatched = await doctor(packed, 'apps/web')
            expect(mismatched.out).toMatch(
                /^report +workflow and plugin pins: 1 pin\(s\) differ from @sssb\/kit 0\.1\.0's release commit c{40}/m,
            )
            expect(mismatched.out).toMatch(/\(marketplace sssb\) pins d{40}, not @sssb\/kit's release commit c{40}$/m)
            expect(mismatched.code, mismatched.out).toBe(0)

            write(path.join(packed, '.claude', 'settings.json'), settings(sha))
            const matching = await doctor(packed, 'apps/web')
            expect(matching.out).toMatch(
                /^ok +workflow and plugin pins: the reusable workflow and the plugin marketplace pin @sssb\/kit 0\.1\.0's release commit c{40}$/m,
            )

            // In-repo there is no stamp: the kit is the workspace's own source (a dist/ left by a pack is not read).
            const inRepo = doctorWorkspace('sssb-doctor-e2e-pins-in-repo-', 'in-repo', ['web'])
            write(path.join(inRepo, 'packages', 'kit', 'dist', 'release.json'), `${JSON.stringify({ commit: sha })}\n`)
            const own = await doctor(inRepo, 'apps/web')
            expect(own.out).toMatch(
                /^report +workflow and plugin pins: not checked: in-repo, @sssb\/kit is this workspace's own source/m,
            )
            expect(own.code, own.out).toBe(0)
        },
        E2E_TIMEOUT,
    )

    it(
        'fails when the workspace walk does not reach the app it runs for, or cannot read pnpm-workspace.yaml',
        async () => {
            const ws = doctorWorkspace('sssb-doctor-e2e-walk-', 'packed')
            write(path.join(ws, 'pnpm-workspace.yaml'), 'packages:\n    - packages/*\n')
            const missed = await doctor(ws, 'apps/a')
            expect(missed.out).toMatch(/^FAIL +.*apps\/a.*/m)
            expect(missed.out).toMatch(/apps\/a is not among the importers/)
            expect(missed.code).toBe(1)
            write(path.join(ws, 'pnpm-workspace.yaml'), 'packages: &globs\n    - apps/*\n')
            const unread = await doctor(ws, 'apps/a')
            expect(unread.out).toMatch(/^FAIL +workspace walk: .*pnpm-workspace\.yaml line 1/m)
            expect(unread.code).toBe(1)
        },
        E2E_TIMEOUT,
    )
})

describe('portSlotProblems', () => {
    function apps(declarations: Record<string, unknown>) {
        const ws = realpathSync(makeTestTmpDir('sssb-doctor-ports-'))
        const dirs = Object.entries(declarations).map(([name, port]) =>
            pkg(path.join(ws, 'apps', name), { name, ...(port === undefined ? {} : { sssb: { port } }) }),
        )
        return { ws, dirs }
    }

    it('passes apps on distinct slots, built-in or their own, and an app that declares none', () => {
        const { ws, dirs } = apps({
            a: { name: 'ledger', default: 3700 },
            b: { name: 'portal', default: 3710 },
            c: 'starter',
            d: undefined,
        })
        expect(portSlotProblems(ws, dirs)).toEqual({
            problems: [],
            slots: [
                'apps/a: slot "ledger", port 3700 in a main checkout',
                'apps/b: slot "portal", port 3710 in a main checkout',
                'apps/c: slot "starter", port 3100 in a main checkout',
            ],
        })
    })

    it('names every app on a slot, whichever form declares it', () => {
        const { ws, dirs } = apps({
            a: { name: 'ledger', default: 3700 },
            b: { name: 'ledger', default: 3710 },
            c: 'starter',
            d: 'starter',
            e: 'starter',
        })
        const { problems } = portSlotProblems(ws, dirs)
        expect(problems).toHaveLength(2)
        expect(problems[0]).toContain('apps/a and apps/b declare the same port slot "ledger"')
        expect(problems[1]).toContain('apps/c and apps/d and apps/e declare the same port slot "starter"')
    })

    it('reads a derived port in a worktree workspace as a main checkout’s default, never the derived one', () => {
        const { ws, dirs } = apps({ a: { name: 'ledger', default: 3700 } })
        const inWorktree = path.join(ws, '.claude', 'worktrees', 'x')
        const moved = pkg(path.join(inWorktree, 'apps', 'a'), {
            name: 'a',
            sssb: { port: { name: 'ledger', default: 3700 } },
        })
        expect(dirs).toHaveLength(1)
        expect(portSlotProblems(inWorktree, [moved]).slots).toEqual([
            'apps/a: slot "ledger", port 3700 in a main checkout',
        ])
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

describe('knipGaps: the apps knip.json gives no workspace (reported, never failed)', () => {
    it("names each app, and each app's seam package, that knip.json's workspaces do not, globs counted", () => {
        const root = makeTestTmpDir('doctor-knip-')
        const apps = ['apps/console', 'apps/ledger'].map((app) =>
            pkg(path.join(root, app), { name: path.basename(app) }),
        )
        const seams = apps.map((app) => pkg(path.join(app, 'src/app-config'), { name: `${path.basename(app)}-seam` }))
        const packages = [...apps, ...seams]
        expect(knipGaps(root, apps, packages)).toBeNull()

        json(path.join(root, 'knip.json'), {
            workspaces: { '.': {}, 'apps/console': {}, 'apps/console/src/app-config': {} },
        })
        expect(knipGaps(root, apps, packages)).toEqual({
            file: 'knip.json',
            missing: ['apps/ledger', 'apps/ledger/src/app-config'],
            generator: false,
        })
        // A seam that is no workspace package (SSSB's own repository, where aliases carry it) is not knip's to name.
        expect(knipGaps(root, apps, apps)).toEqual({ file: 'knip.json', missing: ['apps/ledger'], generator: false })
        json(path.join(root, 'knip.json'), { workspaces: { 'apps/*': {}, 'apps/*/src/app-config/': {} } })
        expect(knipGaps(root, apps, packages)).toEqual({ file: 'knip.json', missing: [], generator: false })
        // One config for every package, or a config doctor cannot read.
        json(path.join(root, 'knip.json'), { entry: ['src/index.ts'] })
        expect(knipGaps(root, apps, packages)).toEqual({ file: 'knip.json', missing: null, generator: false })
        // A root that installs @sssb/create for `sssb add-app`, which nothing imports: knip calls it unused unless ignored.
        json(path.join(root, 'package.json'), { name: 'ws', devDependencies: { '@sssb/create': '0.2.0' } })
        expect(knipGaps(root, apps, packages)).toMatchObject({ generator: true })
        json(path.join(root, 'knip.json'), { ignoreDependencies: ['@sssb/create'] })
        expect(knipGaps(root, apps, packages)).toMatchObject({ generator: false })
        // An entry with a regular expression's characters is one, to knip.
        json(path.join(root, 'knip.json'), { ignoreDependencies: ['@sssb/.*'] })
        expect(knipGaps(root, apps, packages)).toMatchObject({ generator: false })
        json(path.join(root, 'knip.json'), { ignoreDependencies: ['@sssb/kit', '(unclosed'] })
        expect(knipGaps(root, apps, packages)).toMatchObject({ generator: true })
        json(path.join(root, 'knip.json'), { workspaces: { '.': { ignoreDependencies: ['esbuild'] }, 'apps/*': {} } })
        expect(knipGaps(root, apps, packages)).toMatchObject({ generator: true })
        json(path.join(root, 'knip.json'), {
            workspaces: { '.': { ignoreDependencies: ['@sssb/create'] }, 'apps/*': {} },
        })
        expect(knipGaps(root, apps, packages)).toMatchObject({ generator: false })
        rmSync(path.join(root, 'package.json'))
        write(path.join(root, 'knip.json'), '{ "workspaces": {')
        expect(knipGaps(root, apps, packages)).toMatchObject({ file: 'knip.json', unread: expect.any(String) })
        // knip reads a knip.json with comments, trailing commas or a byte-order mark too.
        write(
            path.join(root, 'knip.json'),
            '\uFEFF{ // why\n "workspaces": { "apps/*": {}, "apps/*/src/app-config": {}, },\n}',
        )
        expect(knipGaps(root, apps, packages)).toEqual({ file: 'knip.json', missing: [], generator: false })
        // An app that is no workspace package is the root's, for knip.
        json(path.join(root, 'knip.json'), { workspaces: { '.': {} } })
        expect(knipGaps(root, apps, [])).toEqual({ file: 'knip.json', missing: [], generator: false })
        // knip.jsonc takes comments and trailing commas; a `//` inside a string is not one.
        rmSync(path.join(root, 'knip.json'))
        write(
            path.join(root, 'knip.jsonc'),
            '{\n  // the apps\n  "$schema": "https://unpkg.com/knip@6/schema.json",\n  "workspaces": {\n' +
                '    "apps/console": {}, /* its seam */ "apps/console/src/app-config": {},\n  },\n}\n',
        )
        expect(knipGaps(root, apps, packages)).toEqual({
            file: 'knip.jsonc',
            missing: ['apps/ledger', 'apps/ledger/src/app-config'],
            generator: false,
        })
    })
})

describe('pinReport: the workflow and plugin pins against the kit’s release stamp (never a failure)', () => {
    const SHA = 'a'.repeat(40)
    const OTHER = 'b'.repeat(40)
    const workflow = (ref: string) => ({
        file: '.github/workflows/checks.yml',
        text: `jobs:\n    sssb:\n        uses: safeinsights/sssb/.github/workflows/app-checks.yml@${ref} # @sssb/create 0.1.0\n    other:\n        steps:\n            - uses: actions/checkout@${OTHER}\n`,
    })
    const settings = (ref: string | null, repo = 'safeinsights/sssb') => ({
        file: '.claude/settings.json',
        text: JSON.stringify({
            extraKnownMarketplaces: {
                sssb: { source: { source: 'github', repo, ...(ref === null ? {} : { ref }) } },
                elsewhere: { source: { source: 'github', repo: 'someone/else', ref: OTHER } },
            },
            enabledPlugins: { 'sssb@sssb': true },
        }),
    })
    const base = {
        inRepo: false,
        version: '0.2.0',
        stamp: `${JSON.stringify({ commit: SHA })}\n`,
        repository: 'safeinsights/sssb',
        workflows: [workflow(SHA)],
        settings: settings(SHA),
    }

    it('is ok when the kit is stamped and the workflow and the marketplace both pin that commit', () => {
        expect(pinReport(base)).toEqual({
            status: 'ok',
            title: `workflow and plugin pins: the reusable workflow and the plugin marketplace pin @sssb/kit 0.2.0's release commit ${SHA}`,
            lines: [
                '.github/workflows/checks.yml (.github/workflows/app-checks.yml)',
                '.claude/settings.json (marketplace sssb)',
            ],
        })
    })

    it('reports, naming both commits, a pin that differs, and one that follows a branch or no ref at all', () => {
        const mismatched = pinReport({ ...base, workflows: [workflow(OTHER)], settings: settings('main') })
        expect(mismatched.status).toBe('report')
        expect(mismatched.title).toMatch(
            /^workflow and plugin pins: 2 pin\(s\) differ from @sssb\/kit 0\.2\.0's release commit a{40} \(reported, not failed/,
        )
        expect(mismatched.lines).toEqual([
            `.github/workflows/checks.yml (.github/workflows/app-checks.yml) pins ${OTHER}, not @sssb/kit's release commit ${SHA}`,
            `.claude/settings.json (marketplace sssb) pins main (a branch or tag, not a commit), not @sssb/kit's release commit ${SHA}`,
        ])
        expect(pinReport({ ...base, settings: settings(null) }).lines).toEqual([
            `.claude/settings.json (marketplace sssb) pins no ref, so it follows safeinsights/sssb's default branch, not @sssb/kit's release commit ${SHA}`,
        ])
        // The repository is matched as GitHub matches it, without case; a git source by its URL.
        const git = JSON.stringify({
            extraKnownMarketplaces: {
                s: { source: { source: 'git', url: 'https://github.com/SafeInsights/SSSB.git', ref: OTHER } },
            },
            enabledPlugins: { 'sssb@s': true },
        })
        expect(pinReport({ ...base, settings: { file: '.claude/settings.json', text: git } }).lines).toEqual([
            `.claude/settings.json (marketplace s) pins ${OTHER}, not @sssb/kit's release commit ${SHA}`,
        ])
    })

    it('reports a missing .claude/settings.json, a marketplace of another repository, or unreadable settings, never failing', () => {
        const missing = pinReport({ ...base, settings: null })
        expect(missing.status).toBe('report')
        expect(missing.title).toMatch(
            /not every pin is there to compare with @sssb\/kit 0\.2\.0's release commit a{40}/,
        )
        expect(missing.lines).toEqual([
            'no .claude/settings.json: no plugin marketplace pin (a workspace whose people do not use Claude Code has no plugin)',
        ])
        expect(pinReport({ ...base, settings: settings(SHA, 'someone/fork') }).lines).toEqual([
            '.claude/settings.json declares no marketplace from safeinsights/sssb: no plugin marketplace pin',
        ])
        expect(pinReport({ ...base, settings: { file: '.claude/settings.json', text: '{' } }).lines[0]).toMatch(
            /^\.claude\/settings\.json is not JSON doctor can read/,
        )
        expect(pinReport({ ...base, workflows: [] }).lines).toEqual([
            'no workflow under .github/workflows calls a reusable workflow of safeinsights/sssb: no workflow pin',
        ])
    })

    it('reports a pinned marketplace no plugin is enabled from, naming what is enabled instead', () => {
        const withPlugins = (enabledPlugins: unknown) => ({
            file: '.claude/settings.json',
            text: JSON.stringify({ ...JSON.parse(settings(SHA).text), enabledPlugins }),
        })
        // Disabled, or enabled only from another marketplace (a local checkout's copy, say): the pin loads nothing.
        const otherCopy = pinReport({ ...base, settings: withPlugins({ 'sssb@dev': true, 'sssb@sssb': false }) })
        expect(otherCopy).toEqual({
            status: 'report',
            title: `workflow and plugin pins: the pins are @sssb/kit 0.2.0's release commit ${SHA}, but no plugin is enabled from the pinned marketplace (reported, not failed: enable it in this workspace's .claude/settings.json)`,
            lines: [
                '.claude/settings.json enables no plugin from marketplace sssb, so the pin loads nothing: its enabledPlugins enable sssb@dev (and set sssb@sssb: false)',
            ],
        })
        for (const enabledPlugins of [undefined, {}, { 'sssb@sssb': 'yes' }])
            expect(pinReport({ ...base, settings: withPlugins(enabledPlugins) }).lines, String(enabledPlugins)).toEqual(
                [
                    expect.stringMatching(
                        /^\.claude\/settings\.json enables no plugin from marketplace sssb, so the pin loads nothing: its enabledPlugins enable none/,
                    ),
                ],
            )
        // Any plugin enabled from the pinned marketplace is SSSB's: the kit does not know the plugin's name.
        expect(pinReport({ ...base, settings: withPlugins({ 'renamed@sssb': true }) }).status).toBe('ok')
        // Claude Code's settings also take a non-empty array of version constraints as enabled; an empty one is not.
        expect(pinReport({ ...base, settings: withPlugins({ 'sssb@sssb': ['>=0.1.0'] }) }).status).toBe('ok')
        expect(pinReport({ ...base, settings: withPlugins({ 'sssb@sssb': [] }) }).lines).toEqual([
            '.claude/settings.json enables no plugin from marketplace sssb, so the pin loads nothing: its enabledPlugins enable none (and set sssb@sssb: [])',
        ])
        // Alongside a pin that differs, the title is the pin's; the line still says what is enabled.
        const both = pinReport({ ...base, workflows: [workflow(OTHER)], settings: withPlugins({}) })
        expect(both.title).toMatch(/1 pin\(s\) differ/)
        expect(both.lines).toHaveLength(2)
        expect(both.lines[1]).toMatch(/enables no plugin from marketplace sssb/)
        // Without a stamp, the line is shown with the pins found.
        expect(pinReport({ ...base, stamp: null, settings: withPlugins({}) }).lines.at(-1)).toMatch(
            /enables no plugin from marketplace sssb/,
        )
    })

    it('says plainly when there is no stamp to compare with: in-repo, an unstamped kit, a stamp naming no commit', () => {
        const inRepo = pinReport({ ...base, inRepo: true })
        expect(inRepo).toMatchObject({ status: 'report', lines: [] })
        expect(inRepo.title).toMatch(
            /^workflow and plugin pins: not checked: in-repo, @sssb\/kit is this workspace's own source, which carries no release stamp/,
        )
        const unstamped = pinReport({ ...base, stamp: null, workflows: [workflow(OTHER)] })
        expect(unstamped.status).toBe('report')
        expect(unstamped.title).toMatch(
            /not checked: @sssb\/kit 0\.2\.0 carries no release stamp \(dist\/release\.json\)/,
        )
        // The pins found are still shown.
        expect(unstamped.lines).toEqual([
            `.github/workflows/checks.yml (.github/workflows/app-checks.yml) pins ${OTHER}`,
            '.claude/settings.json (marketplace sssb) pins ' + SHA,
        ])
        expect(pinReport({ ...base, stamp: '{"commit":"HEAD"}' }).title).toMatch(
            /has a release stamp .* that names no commit/,
        )
        expect(pinReport({ ...base, repository: null }).title).toMatch(/names no GitHub repository/)
    })

    it("reads the repository a kit's package.json names on GitHub", () => {
        expect(githubRepositoryOf({ type: 'git', url: 'git+https://github.com/safeinsights/sssb.git' })).toBe(
            'safeinsights/sssb',
        )
        expect(githubRepositoryOf('git@github.com:Org/Repo.git')).toBe('org/repo')
        expect(githubRepositoryOf({ url: 'https://gitlab.com/o/r' })).toBeNull()
        expect(githubRepositoryOf(undefined)).toBeNull()
    })
})

/**
 * The short form, `sssb doctor` with no `--app`, is what the generated files and READMEs tell people to
 * type (`pnpm exec sssb doctor`), and people type it at the workspace root. A generated workspace's root takes no
 * @sssb/kit, so it used to fail there ("does not resolve @sssb/kit"). One run checks every app, so it now starts from
 * the workspace's first app.
 */
describe.concurrent('sssb doctor with no --app, from the root of a workspace whose root takes no @sssb/kit', () => {
    for (const mode of ['packed', 'in-repo'] as const) {
        it(
            `${mode}: starts from the first app, says so, and checks every app`,
            async () => {
                const ws = doctorWorkspace(`sssb-doctor-root-${mode}-`, mode)
                const { code, out } = await doctorIn(ws)
                expect(out).toMatch(
                    /^sssb doctor: no --app, and the working directory .* takes no @sssb\/kit: starting from apps\/a\./m,
                )
                expect(out).toMatch(/^sssb doctor: apps\/a, @sssb\/kit 0\.1\.0/m)
                // the whole workspace, not only the app it started from
                expect(out).toMatch(/^ok +apps\/b: one copy of each singleton/m)
                expect(out).toMatch(/^ok +apps\/b: the conformance suite would run/m)
                expect(code, out).toBe(0)
            },
            E2E_TIMEOUT,
        )
    }

    it(
        'finds what `--app` finds: the same workspace, a defect in the second app, fails from the root as it does with --app',
        async () => {
            const ws = doctorWorkspace('sssb-doctor-root-defect-', 'packed')
            // apps/b has no suite: the check that would catch it names apps/b, however doctor was started.
            rmSync(path.join(ws, 'apps', 'b', 'src', 'sssb.conformance.test.ts'))
            const fromRoot = await doctorIn(ws)
            const withApp = await doctor(ws, 'apps/a')
            expect(fromRoot.code, fromRoot.out).toBe(1)
            expect(withApp.code, withApp.out).toBe(1)
            expect(fromRoot.out).toMatch(/FAIL +apps\/b:/)
            expect(withApp.out).toMatch(/FAIL +apps\/b:/)
        },
        E2E_TIMEOUT,
    )

    it(
        'starts from the first app `sssb.apps` lists, not the alphabetical one',
        async () => {
            const ws = doctorWorkspace('sssb-doctor-root-listed-', 'packed')
            const manifest = JSON.parse(readFileSync(path.join(ws, 'package.json'), 'utf8'))
            manifest.sssb = { apps: ['apps/b', 'apps/a'] }
            json(path.join(ws, 'package.json'), manifest)
            const { code, out } = await doctorIn(ws)
            expect(out).toMatch(/starting from apps\/b\./)
            expect(out).toMatch(/^ok +apps\/a: one copy of each singleton/m)
            expect(code, out).toBe(0)
        },
        E2E_TIMEOUT,
    )

    it(
        'from an app directory it is unchanged: that app, no note',
        async () => {
            const ws = doctorWorkspace('sssb-doctor-root-fromapp-', 'packed')
            const { code, out } = await doctorIn(path.join(ws, 'apps', 'b'))
            expect(out).toMatch(/^sssb doctor: apps\/b, @sssb\/kit/m)
            expect(out).not.toMatch(/no --app/)
            expect(code, out).toBe(0)
        },
        E2E_TIMEOUT,
    )

    it(
        'at a workspace root with no apps and no @sssb/kit it refuses, saying why and what to pass',
        async () => {
            const ws = realpathSync(makeTestTmpDir('sssb-doctor-root-empty-'))
            write(path.join(ws, 'pnpm-workspace.yaml'), 'packages:\n    - packages/*\n')
            pkg(ws, { name: 'ws', private: true })
            const { code, out } = await doctorIn(ws)
            expect(code).toBe(1)
            expect(out).toMatch(/is a workspace root that takes no @sssb\/kit and has no apps .* pass --app <dir>/)
        },
        E2E_TIMEOUT,
    )

    it(
        'outside any workspace, or in a directory with no package.json, the usual refusal',
        async () => {
            const dir = realpathSync(makeTestTmpDir('sssb-doctor-root-none-'))
            const { code, out } = await doctorIn(dir)
            expect(code).toBe(1)
            expect(out).toMatch(
                /not a package \(no package\.json\): run this from an app's directory or pass --app <dir>/,
            )
        },
        E2E_TIMEOUT,
    )

    it(
        'a workspace root that resolves @sssb/kit is the app itself: no default, no note',
        async () => {
            const ws = doctorWorkspace('sssb-doctor-root-resolves-', 'in-repo')
            // this root is an importer of the kit, as the repository's own root is
            link(path.join(ws, 'node_modules', '@sssb', 'kit'), path.join(ws, 'packages', 'kit'))
            const { out } = await doctorIn(ws)
            expect(out).toMatch(/^sssb doctor: \(the workspace root\), @sssb\/kit/m)
            expect(out).not.toMatch(/no --app/)
        },
        E2E_TIMEOUT,
    )

    it(
        'a directory inside an app (no package.json of its own), or a workspace root with none, is refused, not defaulted',
        async () => {
            const ws = doctorWorkspace('sssb-doctor-root-inside-', 'packed')
            mkdirSync(path.join(ws, 'apps', 'a', 'src', 'deep'), { recursive: true })
            const inside = await doctorIn(path.join(ws, 'apps', 'a', 'src', 'deep'))
            expect(inside.code).toBe(1)
            expect(inside.out).toMatch(/not a package \(no package\.json\)/)
            const bare = realpathSync(makeTestTmpDir('sssb-doctor-root-nopkg-'))
            write(path.join(bare, 'pnpm-workspace.yaml'), 'packages:\n    - apps/*\n')
            const noPackage = await doctorIn(bare)
            expect(noPackage.code).toBe(1)
            expect(noPackage.out).toMatch(/not a package \(no package\.json\)/)
        },
        E2E_TIMEOUT,
    )

    it(
        'says why it picked the first app even when that app is the one that fails (it resolves no @sssb/kit)',
        async () => {
            const ws = doctorWorkspace('sssb-doctor-root-firstbad-', 'packed')
            rmSync(path.join(ws, 'apps', 'a', 'node_modules', '@sssb', 'kit'))
            const { code, out } = await doctorIn(ws)
            expect(code).toBe(1)
            expect(out).toMatch(/starting from apps\/a\.[\s\S]*apps\/a does not resolve @sssb\/kit/)
        },
        E2E_TIMEOUT,
    )

    it(
        'fails when the walk drops an app the workspace names, as `--app <that app>` would, instead of passing from the first',
        async () => {
            const ws = doctorWorkspace('sssb-doctor-root-dropped-', 'packed')
            // pnpm-workspace.yaml no longer lists apps/b: the walk reaches a, not b, though apps/b exists and names a seam
            write(
                path.join(ws, 'pnpm-workspace.yaml'),
                'packages:\n    - apps/a\n    - apps/a/src/app-config\n    - packages/*\n',
            )
            const fromRoot = await doctorIn(ws)
            const withApp = await doctor(ws, 'apps/b')
            expect(withApp.code, withApp.out).toBe(1)
            expect(fromRoot.code, fromRoot.out).toBe(1)
            expect(fromRoot.out).toMatch(/FAIL +workspace walk: it does not reach every app the workspace names/)
            expect(fromRoot.out).toMatch(/apps\/b is named by the workspace/)
        },
        E2E_TIMEOUT,
    )

    // CI runs doctor from `sssb ci lint-typecheck-unit` with `--app` the first app, which used to hold the walk to that
    // app alone: the same workspace failed a bare `sssb doctor` and passed CI's.
    it(
        'fails the same way in `sssb ci lint-typecheck-unit`, which holds the walk to every app it fans out over',
        async () => {
            const ws = doctorWorkspace('sssb-doctor-ci-dropped-', 'packed')
            write(
                path.join(ws, 'pnpm-workspace.yaml'),
                'packages:\n    - apps/a\n    - apps/a/src/app-config\n    - packages/*\n',
            )
            // the job's own steps are not what is under test here: each a no-op
            pkg(ws, {
                name: 'ws',
                private: true,
                sssb: { apps: ['apps/a', 'apps/b'] },
                scripts: { lint: 'node -e 0', typecheck: 'node -e 0', 'test:unit': 'node -e 0' },
            })
            const env = { ...process.env }
            for (const key of Object.keys(env)) if (key.startsWith('VITEST')) delete env[key]
            const ci = spawnSync(process.execPath, [SSSB, 'ci', 'lint-typecheck-unit'], {
                cwd: ws,
                env,
                encoding: 'utf8',
                maxBuffer: 16 * 1024 * 1024,
            })
            const out = `${ci.stdout}${ci.stderr}`
            expect(ci.status, out).toBe(1)
            expect(out).toMatch(
                /sssb doctor --app apps\/a\n[\s\S]*FAIL +workspace walk: it does not reach every app the workspace names/,
            )
            expect(out).toMatch(/apps\/b is named by the workspace/)
        },
        E2E_TIMEOUT,
    )

    it(
        "reports the adopter's own GitHub settings and plugin install, read-only, and never fails on them; skips them in CI",
        async () => {
            const ws = doctorWorkspace('sssb-doctor-e2e-settings-', 'in-repo')
            spawnSync('git', ['init', '-q', ws])
            spawnSync('git', ['-C', ws, 'remote', 'add', 'origin', 'https://github.com/acme-org/acme.git'])
            json(path.join(ws, '.claude', 'settings.json'), { enabledPlugins: { 'sssb@sssb': true } })
            const tools = makeTestTmpDir('sssb-doctor-e2e-settings-bin-')
            const gh = path.join(tools, 'bin', 'gh')
            write(
                gh,
                `#!/bin/sh
echo "$@" >> '${path.join(tools, 'gh.log')}'
case "$4" in
  repos/acme-org/acme) echo '{"default_branch":"main","private":false,"owner":{"type":"User"}}';;
  repos/acme-org/acme/rules/branches/main?per_page=100) echo '[]';;
  repos/acme-org/acme/private-vulnerability-reporting) echo '{"enabled":true}';;
  *) echo '{"message":"Branch not protected"}'; echo 'gh: Branch not protected (HTTP 404)' >&2; exit 1;;
esac
`,
            )
            chmodSync(gh, 0o755)
            const env = {
                PATH: `${path.join(tools, 'bin')}:${process.env.PATH ?? ''}`,
                CLAUDE_CONFIG_DIR: path.join(tools, 'no-claude'),
            }
            const local = await doctor(ws, 'apps/a', { ...env, CI: '' })
            expect(local.out).toMatch(
                /^report +github: sssb \/ all-checks is a required check on main: it is not \(reported, not failed:/m,
            )
            expect(local.out).toMatch(/^ok +github: private vulnerability reporting is on$/m)
            expect(local.out).toMatch(
                /^report +claude plugin: sssb@sssb is enabled by \.claude\/settings\.json but not installed/m,
            )
            expect(local.code, local.out).toBe(0)
            for (const call of readFileSync(path.join(tools, 'gh.log'), 'utf8').trim().split('\n'))
                expect(call).toMatch(/^api --method GET /)

            writeFileSync(path.join(tools, 'gh.log'), '')
            const ci = await doctor(ws, 'apps/a', { ...env, CI: 'true' })
            expect(ci.out).toMatch(/^report +github settings and plugin install: not checked: CI is set/m)
            expect(ci.out).not.toMatch(/required check/)
            expect(readFileSync(path.join(tools, 'gh.log'), 'utf8')).toBe('')
            expect(ci.code, ci.out).toBe(0)
        },
        E2E_TIMEOUT,
    )

    it(
        'an explicit --app is never replaced by the default',
        async () => {
            const ws = doctorWorkspace('sssb-doctor-root-explicit-', 'packed')
            const { code, out } = await doctorIn(ws, ['--app', 'apps/b'])
            expect(out).toMatch(/^sssb doctor: apps\/b, @sssb\/kit/m)
            expect(out).not.toMatch(/no --app/)
            expect(code, out).toBe(0)
        },
        E2E_TIMEOUT,
    )
})
