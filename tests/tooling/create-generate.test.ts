import { execFileSync, spawn, spawnSync } from 'node:child_process'
import {
    chmodSync,
    cpSync,
    existsSync,
    mkdirSync,
    readdirSync,
    readFileSync,
    statSync,
    symlinkSync,
    writeFileSync,
} from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import ts from 'typescript'
import { beforeAll, describe, expect, it } from 'vitest'
import { parse as parseYaml } from 'yaml'
import { CreateError } from '../../packages/create/src/args.js'
import { generate } from '../../packages/create/src/generate.js'
import { buildTemplate, filesUnder, fromStored, ROOT_FILES } from '../../packages/create/src/template.js'
import { verifyGateProblems } from '../../scripts/pack-and-consume/checks.mjs'
import { makeTestTmpDir } from '../support/tmp-dir'

/**
 * `@sssb/create` (packages/create, ADR-0014 P12), generating from THIS repository's live tree: the template is built
 * with the same function the package's `prepack` runs, so what is tested here is what is packed. The packed generator's
 * own end-to-end proof (pack every @sssb package, generate outside the repository with `--sssb <tarballs>`, install,
 * and run the workspace's `pnpm verify`) takes minutes, so it is not a gate here.
 */
const REPO = path.resolve(__dirname, '../..')
const CLI = path.join(REPO, 'packages/create/bin/create.js')
const HEAD = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: REPO, encoding: 'utf8' }).trim()
/** The generator's version, the fixed group's: the only one its workspaces may install. */
const VERSION: string = JSON.parse(readFileSync(path.join(REPO, 'packages/create/package.json'), 'utf8')).version
const SEAM_SPECIFIERS: string[] = JSON.parse(
    readFileSync(path.join(REPO, 'packages/kit/src/testing/seam-specifiers.json'), 'utf8'),
).specifiers

/** The browser install, run where `@playwright/test` is a dependency (the app), as the plugin's commands write it. */
const PLAYWRIGHT_INSTALL = "pnpm --filter './apps/*' exec playwright install chromium"
const read = (root: string, file: string) => readFileSync(path.join(root, file), 'utf8')
const readJson = (root: string, file: string) => JSON.parse(read(root, file))

/** What `prettier --check .` says in a generated workspace, under its own config: '' when it is clean. */
function prettierCheck(root: string) {
    const prettier = path.join(REPO, 'node_modules/.bin/prettier')
    const result = spawnSync(prettier, ['--check', '--log-level', 'warn', '.'], { cwd: root, encoding: 'utf8' })
    return `${result.stdout}${result.stderr}${result.status === 0 ? '' : `exit ${result.status}`}`
}

let template = ''
let ws = ''
let bare = ''

beforeAll(() => {
    template = path.join(makeTestTmpDir('create-template-'), 'template')
    buildTemplate({ repoRoot: REPO, outDir: template })
    ws = path.join(makeTestTmpDir('create-ws-'), 'acme')
    generate({
        templateDir: template,
        target: ws,
        slug: 'acme',
        name: "Acme's Research",
        repo: 'acme-org/research',
        owners: ['@acme-org/devs', '@jdoe'],
    })
    bare = path.join(makeTestTmpDir('create-bare-'), 'console')
    generate({ templateDir: template, target: bare, slug: 'console', name: 'Console' })
})

describe('@sssb/create: the template', () => {
    // What it leaves out, and what it refuses, is tests/tooling/create-template.test.ts', on stand-in repositories.
    it("holds the starter's tracked files, the generic workspace files and a stamp of the workflow commit", () => {
        const app = filesUnder(path.join(template, 'app')).map(fromStored)
        const tracked = execFileSync('git', ['ls-files', 'apps/starter'], { cwd: REPO, encoding: 'utf8' })
            .split('\n')
            .filter(Boolean)
            .map((file) => path.relative('apps/starter', file))
        expect(app).toEqual(tracked.sort())
        expect(filesUnder(path.join(template, 'root')).map(fromStored).sort()).toEqual([...ROOT_FILES].sort())
        const meta = readJson(template, 'meta.json')
        expect(meta.workflow).toEqual({ repository: 'safeinsights/sssb', ref: HEAD })
        expect(meta.version).toBe(readJson(REPO, 'packages/create/package.json').version)
        expect(meta.seamSpecifiers).toEqual(SEAM_SPECIFIERS)
        expect(meta.dependencyNames).toEqual(expect.arrayContaining(['ws', 'react', 'next', 'kysely']))
        expect(meta.dependencyNames.some((name: string) => name.startsWith('@'))).toBe(false)
        // In this repository's lockfile for its own tooling, never installed by a generated workspace.
        for (const name of ['events', 'history', 'open', 'cookies']) {
            expect(read(REPO, 'pnpm-lock.yaml')).toMatch(new RegExp(`^ {2}'?${name}@`, 'm'))
            expect(meta.dependencyNames).not.toContain(name)
        }
    })
})

describe('@sssb/create: the generated workspace', () => {
    it('is the app under apps/<slug>, its infra/, and the workspace around it', () => {
        const all = filesUnder(ws)
        const root = all.filter((file) => !file.startsWith('apps/'))
        expect(root.sort()).toEqual(
            [
                '.claude/settings.json',
                '.claude/sssb-guide.md',
                '.editorconfig',
                '.github/ISSUE_TEMPLATE/bug_report.yml',
                '.github/ISSUE_TEMPLATE/config.yml',
                '.github/workflows/checks.yml',
                '.gitignore',
                '.gitleaks.toml',
                '.husky/commit-msg',
                '.husky/pre-commit',
                '.jscpd.json',
                '.nvmrc',
                '.prettierignore',
                '.prettierrc.json',
                'CODEOWNERS',
                'CLAUDE.md',
                'CODE_OF_CONDUCT.md',
                'README.md',
                'SECURITY.md',
                'commitlint.config.mjs',
                'docs/cutover-checklist.md',
                'eslint.config.mjs',
                'knip.json',
                'lint-staged.config.mjs',
                'package.json',
                'pnpm-workspace.yaml',
                'tsconfig.json',
                'vitest.config.ts',
                'vitest.contract.config.ts',
            ].sort(),
        )
        const app = all.filter((file) => file.startsWith('apps/acme/')).map((file) => file.slice('apps/acme/'.length))
        const fromTemplate = filesUnder(path.join(template, 'app')).map(fromStored)
        // Every template file, plus the app's own lint config and its seam package; nothing else.
        expect(app.sort()).toEqual([...fromTemplate, 'eslint.config.mjs', 'src/app-config/package.json'].sort())
        expect(all.every((file) => file.startsWith('apps/acme/') || !file.startsWith('apps/'))).toBe(true)
        for (const file of [
            'src/sssb.conformance.test.ts',
            'tests/contract/rls-contract.test.ts',
            'infra/app.ts',
            'infra/package.json',
        ])
            expect(app).toContain(file)
    })

    /**
     * NOTHING OF SSSB'S REPOSITORY SURVIVES: its apps' names, its workspace's name, its framework's path, its own
     * repository (but the pinned workflow), its maintainer, the project's old name, and its spikes and dated records
     * (build notes, decision log), which a workspace does not have. Two allowances, each pinned to
     * its exact form: the reusable workflow's `uses:` line and the plugin marketplace's `repo` in .claude/settings.json
     * name SSSB's repository, and `starter` is the name of the
     * port service in @sssb/tools (`sssb port`, `originFor`, `sssb tick`/`dev-tick`), which the app keeps when it is
     * renamed (@sssb/tools' ports.js). And every relative path stays inside its own app, or inside the workspace.
     */
    it('carries no survivor of SSSB’s repository', () => {
        const allowed: Record<string, RegExp[]> = {
            'safeinsights/sssb': [
                /^ {8}uses: safeinsights\/sssb\/\.github\/workflows\/app-checks\.yml@[0-9a-f]{40} /,
                /^ {16}"repo": "safeinsights\/sssb",$/,
            ],
            starter: [/originFor\('starter'\)/, /"port": "starter"/, /sssb (?:dev-)?tick starter\b/],
        }
        const banned = [
            'starter',
            'showcase',
            'sssb-workspace',
            'packages/kit',
            'safeinsights/sssb',
            'jpslav',
            'keel',
            'spikes/',
            'build-notes',
            'decision-log',
        ]
        const survivors: string[] = []
        for (const file of filesUnder(ws)) {
            const lines = read(ws, file).split('\n')
            lines.forEach((line, index) => {
                for (const token of banned) {
                    if (!line.toLowerCase().includes(token)) continue
                    // `uses:` is allowed only in the workflow file, the marketplace's `repo` only in the settings.
                    const ok = (allowed[token] ?? []).some(
                        (pattern) =>
                            pattern.test(line) &&
                            (token !== 'safeinsights/sssb' ||
                                file ===
                                    (line.includes('uses:')
                                        ? '.github/workflows/checks.yml'
                                        : '.claude/settings.json')),
                    )
                    if (!ok) survivors.push(`${file}:${index + 1}: ${token}: ${line.trim()}`)
                }
                for (const match of line.matchAll(/(?:\.\.\/)+[\w@.[\]()*-]*(?:\/[\w@.[\]()*-]+)*/g)) {
                    const fileDir = path.dirname(path.join(ws, file))
                    const home = file.startsWith('apps/acme/') ? path.join(ws, 'apps/acme') : ws
                    const target = path.resolve(fileDir, match[0])
                    if (target !== home && !target.startsWith(`${home}${path.sep}`))
                        survivors.push(`${file}:${index + 1}: ${match[0]} leaves ${path.relative(ws, home) || '.'}`)
                }
            })
        }
        expect(survivors).toEqual([])
    })

    it("is the app's identity throughout: slug, package names, display name", () => {
        expect(read(ws, 'apps/acme/config/app.ts')).toMatch(/export const APP_SLUG = 'acme'\n/)
        expect(read(ws, 'apps/acme/config/app.ts')).toContain('`acme_session`')
        expect(readJson(ws, 'apps/acme/package.json').name).toBe('acme')
        expect(readJson(ws, 'apps/acme/infra/package.json').name).toBe('acme-infra')
        expect(readJson(ws, 'package.json').name).toBe('acme-workspace')
        for (const locale of ['en', 'es']) {
            const welcome = readJson(ws, `apps/acme/messages/${locale}.json`).welcome
            expect([welcome.appName, welcome.title]).toEqual(["Acme's Research", "Acme's Research"])
        }
        expect(read(ws, 'apps/acme/src/app/[locale]/layout.tsx')).toContain(`title: "Acme's Research"`)
        expect(read(ws, 'apps/acme/src/demo-static/index.html')).toContain(
            "<title>Acme's Research — static demo</title>",
        )
        expect(readJson(ws, 'package.json').sssb).toEqual({ apps: ['apps/acme'] })
        expect(read(ws, 'vitest.config.ts')).toContain("const APPS = ['acme']")
        expect(readJson(ws, 'knip.json').workspaces).toHaveProperty(['apps/acme'])
    })

    it('puts the flags in the owner files, and placeholders without them', () => {
        expect(read(ws, 'CODEOWNERS')).toMatch(/^\* +@acme-org\/devs @jdoe$/m)
        for (const file of ['SECURITY.md', 'CODE_OF_CONDUCT.md', '.github/ISSUE_TEMPLATE/config.yml'])
            expect(read(ws, file)).toContain('https://github.com/acme-org/research/security/advisories/new')
        for (const file of filesUnder(ws)) expect(read(ws, file)).not.toContain('PLACEHOLDER_GITHUB')

        expect(read(bare, 'CODEOWNERS')).toMatch(/^\* +@PLACEHOLDER_GITHUB_OWNER$/m)
        for (const file of ['SECURITY.md', 'CODE_OF_CONDUCT.md', '.github/ISSUE_TEMPLATE/config.yml'])
            expect(read(bare, file)).toContain('github.com/PLACEHOLDER_GITHUB_OWNER/PLACEHOLDER_GITHUB_REPO/security')
    })

    it("calls SSSB's reusable workflow pinned to a full commit SHA, and says which check to require", () => {
        const workflow = read(ws, '.github/workflows/checks.yml')
        const uses = [...workflow.matchAll(/^\s+uses: (\S+)$|^\s+uses: (\S+) #/gm)].map((m) => m[1] ?? m[2])
        const sssb = uses.filter((value) => value?.includes('/.github/workflows/'))
        expect(sssb).toEqual([`safeinsights/sssb/.github/workflows/app-checks.yml@${HEAD}`])
        expect(HEAD).toMatch(/^[0-9a-f]{40}$/)
        // Every other action is pinned by commit SHA too.
        for (const value of uses) expect(value).toMatch(/@[0-9a-f]{40}$/)
        expect(workflow).toContain('synth: ./apps/acme/infra')
        expect(workflow).toMatch(/^permissions: \{\}$/m)
        expect(workflow).not.toMatch(/^\s+secrets:/m)
        expect(workflow).toContain('`sssb / all-checks`')
        expect(read(ws, 'README.md')).toContain('**Require the check `sssb / all-checks`**')
        // The pin can be overridden.
        const other = path.join(makeTestTmpDir('create-ref-'), 'ws')
        generate({ templateDir: template, target: other, slug: 'acme', name: 'Acme', workflowRef: 'a'.repeat(40) })
        expect(read(other, '.github/workflows/checks.yml')).toContain(`app-checks.yml@${'a'.repeat(40)} `)
    })

    it("enables SSSB's Claude Code plugin from its marketplace, pinned to the workflow's commit", () => {
        const marketplace = readJson(REPO, '.claude-plugin/marketplace.json')
        const plugin = readJson(REPO, 'plugins/sssb/.claude-plugin/plugin.json')
        expect(marketplace.plugins.map((entry: { name: string }) => entry.name)).toContain(plugin.name)
        const enabled = `${plugin.name}@${marketplace.name}`
        expect(enabled).toBe('sssb@sssb')
        expect(readJson(ws, '.claude/settings.json')).toEqual({
            extraKnownMarketplaces: {
                [marketplace.name]: { source: { source: 'github', repo: 'safeinsights/sssb', ref: HEAD } },
            },
            enabledPlugins: { [enabled]: true },
        })
        // The same commit as the workflow's pin, which follows an override.
        const other = path.join(makeTestTmpDir('create-ref-plugin-'), 'ws')
        generate({ templateDir: template, target: other, slug: 'acme', name: 'Acme', workflowRef: 'a'.repeat(40) })
        expect(readJson(other, '.claude/settings.json').extraKnownMarketplaces.sssb.source.ref).toBe('a'.repeat(40))

        // The workspace's own CLAUDE.md imports the app guide's copy, on a line of its own (an import, not a mention).
        expect(read(ws, 'CLAUDE.md').split('\n')).toContain('@.claude/sssb-guide.md')
        const readme = read(ws, 'README.md')
        expect(readme).toContain(`\`claude plugin install ${enabled} --scope project\``)
        expect(readme).toContain('**Claude Code 2.1.324 or later**')
        expect(readme).toContain('`/sssb:new-entity`')
        expect(readme).toContain("the plugin marketplace's `ref` in `.claude/settings.json`")
        // Playwright is the app's dependency, not the root's: the root form works only where pnpm hoists its bin.
        expect(readme).toContain(`\n${PLAYWRIGHT_INSTALL}   # once`)
        expect(readme).not.toMatch(/^pnpm exec playwright/m)
        expect(read(REPO, 'plugins/sssb/commands/verify.md')).toContain(`\`${PLAYWRIGHT_INSTALL}\``)
    })

    it('names each of the plugin’s commands as the workspace’s Claude Code runs it, `/sssb:<command>`', () => {
        const commands = readdirSync(path.join(REPO, 'plugins/sssb/commands'))
            .filter((file) => file.endsWith('.md'))
            .map((file) => file.slice(0, -'.md'.length))
        expect(commands).toContain('new-preset')
        // A bare `/<command>` (not a path's last segment, nor already `/sssb:<command>`) is one no session has.
        const bare = new RegExp(`(?<![\\w.:/-])/(?:${commands.join('|')})(?![\\w-])`)
        const unprefixed: string[] = []
        for (const file of filesUnder(ws))
            read(ws, file)
                .split('\n')
                .forEach((line, index) => {
                    if (bare.test(line)) unprefixed.push(`${file}:${index + 1}: ${line.trim()}`)
                })
        expect(unprefixed).toEqual([])
        expect(read(ws, 'apps/acme/src/app-config/presets.ts')).toContain('`/sssb:new-preset-operation`')
    })

    it('links the seam as a package whose exports map covers every specifier the framework imports', () => {
        const seam = readJson(ws, 'apps/acme/src/app-config/package.json')
        expect(seam.name).toBe('@sssb/app-config')
        const exportsMap: Record<string, string> = seam.exports
        const resolve = (subpath: string) => {
            if (exportsMap[subpath]) return exportsMap[subpath]
            for (const [key, value] of Object.entries(exportsMap)) {
                if (!key.includes('*')) continue
                const [before, after] = key.split('*') as [string, string]
                if (subpath.startsWith(before) && subpath.endsWith(after))
                    // Every `*` in the target takes the matched text, as Node resolves a pattern export.
                    return value.replaceAll('*', subpath.slice(before.length, subpath.length - after.length))
            }
            return undefined
        }
        expect(SEAM_SPECIFIERS.length).toBeGreaterThan(10)
        for (const specifier of SEAM_SPECIFIERS) {
            const target = resolve(`./${specifier.slice('@sssb/app-config/'.length)}`)
            expect(target, specifier).toBeDefined()
            expect(existsSync(path.join(ws, 'apps/acme/src/app-config', target ?? '')), specifier).toBe(true)
        }
        const app = readJson(ws, 'apps/acme/package.json')
        expect(app.dependencies['@sssb/app-config']).toBe('link:./src/app-config')
        // The app's module type, which a nested package.json would otherwise reset below it.
        expect(seam.type).toBe(app.type)
    })

    it('depends on @sssb packages at the generator’s version, and takes nothing from SSSB’s workspace', () => {
        const version = readJson(REPO, 'packages/create/package.json').version
        const app = readJson(ws, 'apps/acme/package.json')
        expect(app.dependencies['@sssb/kit']).toBe(`^${version}`)
        expect(app.devDependencies['@sssb/tools']).toBe(`^${version}`)
        expect(app.devDependencies['@sssb/eslint-plugin']).toBe(`^${version}`)
        expect(readJson(ws, 'apps/acme/infra/package.json').dependencies['@sssb/cdk']).toBe(`^${version}`)
        expect(readJson(ws, 'package.json').devDependencies['@sssb/tools']).toBe(`^${version}`)
        const tsconfig = readJson(ws, 'apps/acme/tsconfig.json')
        expect(tsconfig.compilerOptions.paths).toEqual({ '@/*': ['./src/*'] })
        const workspace = read(ws, 'pnpm-workspace.yaml')
        expect(workspace).toMatch(/^dedupePeerDependents: false$/m)
        expect(workspace).toMatch(/^allowBuilds:$/m)
        expect(workspace).toMatch(/^minimumReleaseAgeExclude:\n {4}- '@sssb\/\*'$/m)
        expect(workspace).not.toMatch(/^overrides:/m)
    })

    it('with --sssb <dir>, depends on each @sssb package by its tarball', () => {
        const tarballs = makeTestTmpDir('create-tarballs-')
        for (const pkg of ['kit', 'tools', 'eslint-plugin', 'cdk', 'create'])
            writeFileSync(path.join(tarballs, `sssb-${pkg}-${VERSION}.tgz`), '')
        const out = path.join(makeTestTmpDir('create-file-'), 'ws')
        generate({ templateDir: template, target: out, slug: 'acme', name: 'Acme', sssb: tarballs })
        const file = (pkg: string) => `file:${path.join(tarballs, `sssb-${pkg}-${VERSION}.tgz`)}`
        const app = readJson(out, 'apps/acme/package.json')
        expect(app.dependencies['@sssb/kit']).toBe(file('kit'))
        expect(app.devDependencies['@sssb/tools']).toBe(file('tools'))
        expect(app.devDependencies['@sssb/eslint-plugin']).toBe(file('eslint-plugin'))
        expect(readJson(out, 'apps/acme/infra/package.json').dependencies['@sssb/cdk']).toBe(file('cdk'))
        expect(readJson(out, 'package.json').devDependencies['@sssb/tools']).toBe(file('tools'))
        // @sssb/cdk's own dependency on @sssb/tools is a registry version in its manifest: overridden too.
        const workspace = read(out, 'pnpm-workspace.yaml')
        for (const pkg of ['kit', 'tools', 'eslint-plugin', 'cdk'])
            expect(workspace).toContain(`    '@sssb/${pkg}': '${file(pkg)}'`)

        // A directory missing one is refused; so is a value that is neither a directory nor a version.
        const partial = makeTestTmpDir('create-partial-')
        writeFileSync(path.join(partial, `sssb-kit-${VERSION}.tgz`), '')
        const again = path.join(makeTestTmpDir('create-file-'), 'ws')
        const run = (sssb: string) => () =>
            generate({ templateDir: template, target: again, slug: 'a', name: 'A', sssb })
        expect(run(partial)).toThrow(/expected one sssb-tools-<version>\.tgz/)
        expect(run('latest')).toThrow(/neither a directory of tarballs nor a version/)
        // Tarballs of two releases: the @sssb packages are one fixed group.
        const mixed = makeTestTmpDir('create-mixed-')
        for (const pkg of ['kit', 'tools', 'eslint-plugin', 'cdk'])
            writeFileSync(path.join(mixed, `sssb-${pkg}-${pkg === 'tools' ? '0.9.1' : '0.9.0'}.tgz`), '')
        expect(run(mixed)).toThrow(CreateError)
        expect(run(mixed)).toThrow(
            /different versions \(@sssb\/kit, @sssb\/eslint-plugin, @sssb\/cdk 0\.9\.0; @sssb\/tools 0\.9\.1\)/,
        )
        expect(existsSync(again)).toBe(false)
        generate({ templateDir: template, target: again, slug: 'a', name: 'A', sssb: VERSION })
        expect(readJson(again, 'apps/a/package.json').dependencies['@sssb/kit']).toBe(VERSION)
    })

    // The workspace's guide copy is stamped with the hash of the guide packed into the generator: another version's
    // @sssb/kit ships another guide, and `sssb doctor` would fail the first `pnpm verify`.
    it("refuses --sssb of any version but the generator's own", () => {
        const other = makeTestTmpDir('create-other-')
        for (const pkg of ['kit', 'tools', 'eslint-plugin', 'cdk'])
            writeFileSync(path.join(other, `sssb-${pkg}-0.9.0.tgz`), '')
        const run = (sssb: string) => () =>
            generate({
                templateDir: template,
                target: path.join(makeTestTmpDir('create-version-'), 'ws'),
                slug: 'a',
                name: 'A',
                sssb,
            })
        expect(run(other)).toThrow(CreateError)
        expect(run(other)).toThrow(
            new RegExp(
                `is @sssb 0\\.9\\.0, and this generator writes workspaces of @sssb ${VERSION.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`,
            ),
        )
        for (const version of ['0.9.0', '^0.9.0', `${VERSION}-rc.1`])
            expect(run(version), version).toThrow(/run @sssb\/create@/)
        for (const version of [VERSION, `^${VERSION}`, `~${VERSION}`]) expect(run(version), version).not.toThrow()
    })

    it('refuses a target that is not an empty directory', () => {
        const parent = makeTestTmpDir('create-occupied-')
        writeFileSync(path.join(parent, 'README.md'), 'mine')
        expect(() => generate({ templateDir: template, target: parent, slug: 'a', name: 'A' })).toThrow(CreateError)
        expect(() => generate({ templateDir: template, target: parent, slug: 'a', name: 'A' })).toThrow(/not an empty/)
        expect(read(parent, 'README.md')).toBe('mine')
        const file = path.join(parent, 'README.md')
        expect(() => generate({ templateDir: template, target: file, slug: 'a', name: 'A' })).toThrow(/not an empty/)
        // An empty directory is fine.
        const empty = path.join(parent, 'empty')
        mkdirSync(empty)
        generate({ templateDir: template, target: empty, slug: 'a', name: 'A' })
        expect(existsSync(path.join(empty, 'apps/a/package.json'))).toBe(true)
    })

    // Its first `pnpm lint` runs `prettier --check .`, under the workspace's own .prettierrc.json and .editorconfig.
    it("is formatted as the workspace's own Prettier would format it", () => {
        expect(prettierCheck(ws)).toBe('')
    })

    /**
     * A LOCAL GREEN IS A CI GREEN: `pnpm verify` runs every script SSSB's reusable workflow's jobs run (read from
     * `sssb ci`'s source: the root scripts its jobs look up, the checks it runs in each app) and every script the
     * workspace's own workflow job runs. Only the secret scan is CI's alone.
     */
    it("verifies what CI runs: every job of SSSB's reusable workflow, and the workspace's own", () => {
        const scripts: Record<string, string> = readJson(ws, 'package.json').scripts
        const ran = new Set([...scripts['verify']!.matchAll(/'pnpm:([^']+)'|pnpm ([\w:-]+)/g)].map((m) => m[1] ?? m[2]))
        for (const name of ran) expect(scripts, `verify runs ${name}`).toHaveProperty([name!])

        const ci = read(REPO, 'packages/tools/src/commands/ci.js')
        const rootScripts = [...ci.matchAll(/rootScript\(root, job, \[([^\]]+)\]\)/g)].map((m) =>
            [...m[1]!.matchAll(/'([^']+)'/g)].map((n) => n[1]!).find((name) => name in scripts),
        )
        expect(rootScripts).toEqual(['lint', 'typecheck', 'test:coverage', 'test:contract'])
        const inApps = [...ci.matchAll(/checks\.push\(\['([\w-]+)'/g)].map((m) => m[1])
        expect(inApps).toEqual(['check-fences', 'doctor', 'check-e2e'])
        const demoSteps = /for \(const step of (\[[^\]]+\])\)/.exec(ci)?.[1]
        expect(demoSteps).toBe("['build:demo-static', 'check:demo-size', 'e2e:demo-static']")
        const workspaceJob = [
            ...read(ws, '.github/workflows/checks.yml').matchAll(/^ +- run: pnpm (?!install)(\S+)$/gm),
        ]
        expect(workspaceJob.map((m) => m[1])).toEqual(['knip', 'jscpd'])
        for (const name of [
            ...rootScripts,
            'check:fences', // check-fences, in each app
            'sssb:doctor',
            'check:e2e',
            'test:e2e', // the e2e job
            'build:demo-static', // the demo-static job
            'check:demo-size',
            'e2e:demo-static',
            'synth', // the synth job
            ...workspaceJob.map((m) => m[1]),
        ])
            expect([...ran], `verify runs ${name}`).toContain(name)
        expect(scripts['check:fences']).toBe("pnpm --filter './apps/*' --fail-if-no-match exec sssb check-fences")
        // Pack and consume's composition check, which also refuses a script that can pass with a gate not run.
        expect(verifyGateProblems(scripts).problems).toEqual([])
    })

    it("typechecks each app's infra/, as the starter's own typecheck does in SSSB's repository", () => {
        for (const app of [path.join(REPO, 'apps/starter'), path.join(ws, 'apps/acme')])
            expect(readJson(app, 'package.json').scripts.typecheck).toMatch(/ && tsc --noEmit -p infra$/)
        expect(readJson(ws, 'package.json').scripts.typecheck).toMatch(
            /^pnpm --filter '\.\/apps\/\*' --fail-if-no-match typecheck /,
        )
        expect(read(ws, 'apps/acme/infra/tsconfig.json')).toBe(read(REPO, 'apps/starter/infra/tsconfig.json'))
        const program = execFileSync(
            path.join(REPO, 'node_modules/.bin/tsc'),
            ['-p', 'apps/starter/infra', '--listFilesOnly'],
            { cwd: REPO, encoding: 'utf8' },
        ).split('\n')
        for (const file of ['infra/app.ts', 'infra/lib/tags.ts', 'config/params.ts'])
            expect(program).toContain(path.join(REPO, 'apps/starter', file))
        // Not the app's own program: `next build` typechecks that one, and the CDK's declarations have no place there.
        expect(program.filter((file) => file.startsWith(path.join(REPO, 'apps/starter/src/')))).toEqual([])
    })

    it('writes YAML that reads back as what it holds, quoted as Prettier quotes it', () => {
        const tarballs = path.join(makeTestTmpDir('create-yaml-'), `it's "odd" #1: here`)
        mkdirSync(tarballs)
        for (const pkg of ['kit', 'tools', 'eslint-plugin', 'cdk'])
            writeFileSync(path.join(tarballs, `sssb-${pkg}-${VERSION}.tgz`), '')
        const out = path.join(makeTestTmpDir('create-yaml-out-'), 'ws')
        generate({ templateDir: template, target: out, slug: 'acme', name: 'Acme', sssb: tarballs })
        const workspace = parseYaml(read(out, 'pnpm-workspace.yaml'))
        for (const pkg of ['kit', 'tools', 'eslint-plugin', 'cdk'])
            expect(workspace.overrides[`@sssb/${pkg}`]).toBe(
                `file:${path.join(tarballs, `sssb-${pkg}-${VERSION}.tgz`)}`,
            )
        expect(workspace.allowBuilds).toEqual(parseYaml(read(REPO, 'pnpm-workspace.yaml')).allowBuilds)
        expect(prettierCheck(out)).toBe('')
        for (const file of filesUnder(out).filter((f) => /\.ya?ml$/.test(f)))
            expect(() => parseYaml(read(out, file))).not.toThrow()
        // The approvals' comments were SSSB's, about SSSB's repository; the generated block speaks for itself.
        expect(read(ws, 'pnpm-workspace.yaml')).not.toMatch(/this repo|adopter/)
    })

    it('carries a display name into every file it lands in, Prettier-stable and parseable', () => {
        for (const name of [
            'O\'Brien "Labs"',
            'Ünïcødé 研究 🚀',
            '1. Numbered',
            'R&D: Portal (Beta)!',
            'W'.repeat(60),
            '50% Study; Q&A = Help',
            'Acme ~ Lab_1 snake_case',
            'C# Lab #1 of C#',
        ]) {
            const out = path.join(makeTestTmpDir('create-name-'), 'ws')
            generate({ templateDir: template, target: out, slug: 'acme', name })
            expect(prettierCheck(out), name).toBe('')
            const layout = path.join(out, 'apps/acme/src/app/[locale]/layout.tsx')
            const source = ts.createSourceFile(
                layout,
                read(out, 'apps/acme/src/app/[locale]/layout.tsx'),
                ts.ScriptTarget.Latest,
                true,
                ts.ScriptKind.TSX,
            )
            expect((source as unknown as { parseDiagnostics: unknown[] }).parseDiagnostics, name).toEqual([])
            expect(readJson(out, 'apps/acme/messages/es.json').welcome.appName).toBe(name)
            expect(read(out, 'README.md')).toMatch(new RegExp(`^# ${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\n`))
        }
        // generate holds the same line as the command line does.
        const run = (name: string) => () =>
            generate({
                templateDir: template,
                target: path.join(makeTestTmpDir('create-name-'), 'ws'),
                slug: 'a',
                name,
            })
        expect(run('Line\nBreak')).toThrow(CreateError)
        expect(run('*Emph*')).toThrow(/uses "\*"/)
        // A generation and a Prettier pass per name: about 10s alone, 23s measured under `pnpm verify`'s parallel load.
    }, 90_000)

    it('refuses a slug that would name a package like a dependency the workspace installs', () => {
        const run = (slug: string) => () =>
            generate({
                templateDir: template,
                target: path.join(makeTestTmpDir('create-slug-'), 'ws'),
                slug,
                name: 'A',
            })
        expect(run('ws')).toThrow(CreateError)
        expect(run('ws')).toThrow(/the slug "ws" would name a package "ws", which is also a dependency/)
        expect(run('react')).toThrow(/would name a package "react"/)
        // Only what a generated workspace installs (pack and consume's seed), not this repository's own tooling.
        for (const slug of ['events', 'history', 'open', 'cookies']) expect(run(slug), slug).not.toThrow()
    })

    // `sssb doctor` fails a workspace without the app guide's stamped copy, so it is written as `sssb guide` writes it.
    it("carries the app guide's copy, byte for byte what `sssb guide` writes", () => {
        const out = path.join(makeTestTmpDir('create-guide-'), 'sssb-guide.md')
        const sssb = spawnSync(
            process.execPath,
            [path.join(REPO, 'packages/tools/bin/sssb.js'), 'guide', '--app', 'apps/starter', '--out', out],
            { cwd: REPO, encoding: 'utf8' },
        )
        expect(sssb.status, sssb.stderr).toBe(0)
        expect(read(ws, '.claude/sssb-guide.md')).toBe(readFileSync(out, 'utf8'))
    })

    it('claims no licence for the workspace’s packages', () => {
        for (const file of filesUnder(ws).filter((f) => path.basename(f) === 'package.json'))
            expect(readJson(ws, file), file).not.toHaveProperty('license')
    })

    it('leaves nothing behind when it fails part-way, and turns filesystem surprises into a message', () => {
        // A template whose identity moved: generation fails after the app is copied.
        const broken = path.join(makeTestTmpDir('create-broken-'), 'template')
        cpSync(template, broken, { recursive: true })
        writeFileSync(path.join(broken, 'app/config/app.ts'), 'export {}\n')
        const parent = makeTestTmpDir('create-partway-')
        const into = (templateDir: string, target: string) => () =>
            generate({ templateDir, target: path.join(parent, target), slug: 'acme', name: 'Acme' })
        expect(into(broken, 'ws')).toThrow(/declares no APP_SLUG/)
        expect(readdirSync(parent)).toEqual([])
        expect(into(broken, 'made/for/it/ws')).toThrow(/declares no APP_SLUG/)
        expect(readdirSync(parent)).toEqual([])
        mkdirSync(path.join(parent, 'empty'))
        expect(into(broken, 'empty')).toThrow(/declares no APP_SLUG/)
        expect(readdirSync(parent)).toEqual(['empty'])
        expect(readdirSync(path.join(parent, 'empty'))).toEqual([])

        symlinkSync(path.join(parent, 'nowhere'), path.join(parent, 'dangling'))
        expect(into(template, 'dangling')).toThrow(CreateError)
        expect(into(template, 'dangling')).toThrow(/is a symbolic link/)

        const locked = path.join(parent, 'locked')
        mkdirSync(locked, { mode: 0o555 })
        try {
            expect(into(template, 'locked/ws')).toThrow(CreateError)
            expect(into(template, 'locked/ws')).toThrow(/could not write the workspace: EACCES/)
        } finally {
            chmodSync(locked, 0o755)
        }
    })

    // `pnpm create @sssb .` from inside it, a mount point, a directory with its own mode or ACLs, in a parent the user
    // cannot write: the target is the user's, so the workspace is moved into it, never put in its place.
    it('never removes or replaces an existing target: the same directory, its mode kept, in a parent it cannot write', () => {
        const parent = makeTestTmpDir('create-keep-')
        const target = path.join(parent, 'ws')
        mkdirSync(target)
        chmodSync(target, 0o2770)
        const before = statSync(target)
        chmodSync(parent, 0o555)
        try {
            generate({ templateDir: template, target, slug: 'acme', name: 'Acme' })
        } finally {
            chmodSync(parent, 0o755)
        }
        const after = statSync(target)
        expect([after.ino, after.mode]).toEqual([before.ino, before.mode])
        expect(readdirSync(parent)).toEqual(['ws'])
        expect(readdirSync(target).filter((entry) => entry.includes('sssb-create'))).toEqual([])
        expect(existsSync(path.join(target, 'apps/acme/package.json'))).toBe(true)
    })

    // `git init` or `gh repo clone` of a new repository, the Finder, a filesystem root: still an empty directory.
    it('counts a directory holding only .git, .DS_Store or lost+found as empty, and leaves them as they were', () => {
        const parent = makeTestTmpDir('create-left-alone-')
        const target = path.join(parent, 'ws')
        mkdirSync(path.join(target, '.git'), { recursive: true })
        writeFileSync(path.join(target, '.git/HEAD'), 'ref: refs/heads/main\n')
        writeFileSync(path.join(target, '.DS_Store'), 'finder')
        mkdirSync(path.join(target, 'lost+found'))
        const leftAlone = ['.DS_Store', '.git', 'lost+found']
        // A failure part-way removes what it wrote, and none of them.
        const broken = path.join(makeTestTmpDir('create-broken-'), 'template')
        cpSync(template, broken, { recursive: true })
        writeFileSync(path.join(broken, 'app/config/app.ts'), 'export {}\n')
        expect(() => generate({ templateDir: broken, target, slug: 'acme', name: 'Acme' })).toThrow(/no APP_SLUG/)
        expect(readdirSync(target).sort()).toEqual(leftAlone)
        generate({ templateDir: template, target, slug: 'acme', name: 'Acme' })
        expect(existsSync(path.join(target, 'apps/acme/package.json'))).toBe(true)
        expect(read(target, '.git/HEAD')).toBe('ref: refs/heads/main\n')
        expect(read(target, '.DS_Store')).toBe('finder')
        expect(readdirSync(path.join(target, 'lost+found'))).toEqual([])
        // A workspace that would write one of them never replaces (or, failing, removes) the one already there.
        const finder = path.join(makeTestTmpDir('create-finder-'), 'template')
        cpSync(template, finder, { recursive: true })
        writeFileSync(path.join(finder, 'root/_dot_DS_Store'), 'template')
        const kept = path.join(makeTestTmpDir('create-finder-out-'), 'ws')
        mkdirSync(kept)
        writeFileSync(path.join(kept, '.DS_Store'), 'finder')
        expect(() => generate({ templateDir: finder, target: kept, slug: 'a', name: 'A' })).toThrow(
            /already holds \.DS_Store, which the workspace would replace/,
        )
        expect(readdirSync(kept)).toEqual(['.DS_Store'])
        expect(read(kept, '.DS_Store')).toBe('finder')
        // Anything else is not empty.
        for (const entry of ['.gitignore', '.github', 'notes.txt']) {
            const other = path.join(makeTestTmpDir('create-not-empty-'), 'ws')
            mkdirSync(path.join(other, '.git'), { recursive: true })
            writeFileSync(path.join(other, entry), '')
            expect(() => generate({ templateDir: template, target: other, slug: 'a', name: 'A' }), entry).toThrow(
                /already exists and is not an empty directory/,
            )
            expect(readdirSync(other).sort(), entry).toEqual(['.git', entry].sort())
        }
    })

    /** Runs `generate` in a child that writes `arrival` into the target as the workspace's first file is copied. */
    function generateWhileArriving(target: string, arrival: string) {
        const script = path.join(makeTestTmpDir('create-arrival-'), 'run.mjs')
        const generator = pathToFileURL(path.join(REPO, 'packages/create/src/generate.js')).href
        writeFileSync(
            script,
            [
                "import fs from 'node:fs'",
                "import { syncBuiltinESMExports } from 'node:module'",
                `import { generate } from '${generator}'`,
                'const [options, arrival] = [JSON.parse(process.argv[2]), process.argv[3]]',
                'const cpSync = fs.cpSync',
                'fs.cpSync = (...args) => {',
                '    fs.cpSync = cpSync',
                '    syncBuiltinESMExports()',
                '    fs.writeFileSync(`${options.target}/${arrival}`, "")',
                '    return cpSync(...args)',
                '}',
                'syncBuiltinESMExports()',
                'generate(options)',
                '',
            ].join('\n'),
        )
        const options = { templateDir: template, target, slug: 'acme', name: 'Acme' }
        return spawnSync(process.execPath, [script, JSON.stringify(options), arrival], { encoding: 'utf8' })
    }

    it('lets a .DS_Store arrive while it writes, and refuses anything else that does', () => {
        const target = path.join(makeTestTmpDir('create-arrival-out-'), 'ws')
        mkdirSync(target)
        const finder = generateWhileArriving(target, '.DS_Store')
        expect(finder.stderr).toBe('')
        expect(finder.status).toBe(0)
        expect(existsSync(path.join(target, 'apps/acme/package.json'))).toBe(true)
        expect(existsSync(path.join(target, '.DS_Store'))).toBe(true)

        const other = path.join(makeTestTmpDir('create-arrival-out-'), 'ws')
        mkdirSync(other)
        const notes = generateWhileArriving(other, 'notes.txt')
        expect(notes.status).toBe(1)
        expect(notes.stderr).toContain('gained notes.txt while the workspace was written')
        expect(readdirSync(other)).toEqual(['notes.txt'])
    })

    /**
     * A signal part-way leaves nothing (what was there before stays). `poll` runs `generate` inside an I/O callback, as
     * the command does after its confirmation prompt (`main()` resumes from stdin's read callback): there the event
     * loop's next check phase comes before its next poll phase, the only one where libuv reads a pending signal. The
     * child then waits as the command does (signalsSettled) and exits 0, so a signal not dispatched by then is dropped.
     */
    it('leaves nothing behind when SIGINT, SIGTERM or SIGHUP comes part-way, from an I/O callback too', async () => {
        // A template with thousands of files more, so the write lasts long enough to be interrupted.
        const big = path.join(makeTestTmpDir('create-big-'), 'template')
        cpSync(template, big, { recursive: true })
        mkdirSync(path.join(big, 'app/bulk'))
        for (let index = 0; index < 4000; index += 1) writeFileSync(path.join(big, `app/bulk/f${index}.txt`), '')
        const script = path.join(makeTestTmpDir('create-signal-'), 'run.mjs')
        const src = (file: string) => pathToFileURL(path.join(REPO, 'packages/create/src', file)).href
        writeFileSync(
            script,
            [
                "import { readFile } from 'node:fs'",
                `import { generate } from '${src('generate.js')}'`,
                `import { signalsSettled } from '${src('signals.js')}'`,
                'const [options, mode] = [JSON.parse(process.argv[2]), process.argv[3]]',
                'const run = async () => {',
                '    generate(options)',
                '    await signalsSettled()',
                "    console.log('Created')",
                '    process.exit(0)',
                '}',
                "if (mode === 'poll') readFile(process.argv[1], () => void run())",
                'else void run()',
                '',
            ].join('\n'),
        )
        for (const [signal, existing, mode] of [
            ['SIGINT', false, 'poll'],
            ['SIGINT', true, 'top'],
            ['SIGTERM', true, 'poll'],
            ['SIGHUP', false, 'poll'],
        ] as const) {
            const what = `${signal} ${mode}${existing ? ' existing' : ''}`
            const parent = makeTestTmpDir('create-signal-parent-')
            const target = path.join(parent, 'ws')
            if (existing) {
                mkdirSync(path.join(target, '.git'), { recursive: true })
                writeFileSync(path.join(target, '.DS_Store'), '')
            }
            const options = { templateDir: big, target, slug: 'acme', name: 'Acme' }
            const child = spawn(process.execPath, [script, JSON.stringify(options), mode], { stdio: 'ignore' })
            const exited = new Promise((resolve) => child.on('exit', (code, sig) => resolve({ code, signal: sig })))
            const staged = () =>
                [parent, target].some(
                    (dir) => existsSync(dir) && readdirSync(dir).some((e) => e.includes('sssb-create-')),
                )
            const until = Date.now() + 20_000
            while (!staged() && Date.now() < until) await new Promise((resolve) => setTimeout(resolve, 1))
            expect(staged(), `${what}: the stage appeared`).toBe(true)
            child.kill(signal)
            expect(await exited, what).toEqual({ code: null, signal })
            expect(readdirSync(parent), what).toEqual(existing ? ['ws'] : [])
            if (existing) expect(readdirSync(target).sort(), what).toEqual(['.DS_Store', '.git'])
        }
    }, 60_000)
})

describe('@sssb/create: the command', () => {
    const cli = (args: string[]) => spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8' })

    it('generates from a checkout of SSSB, building the template on the way', () => {
        const target = path.join(makeTestTmpDir('create-cli-'), 'research hub')
        const result = cli([target, '--slug', 'research-hub', '--repo', 'acme/hub', '--yes'])
        // Only warnings (an unpushed pin, a file the template leaves out), never an error.
        expect(
            result.stderr
                .split('\n')
                .filter(
                    (line) =>
                        line.startsWith('@sssb/create:') &&
                        !/^@sssb\/create: (WARNING: |left out of the template)/.test(line),
                ),
        ).toEqual([])
        expect(result.stderr).not.toMatch(/\n\s+at /)
        expect(result.status).toBe(0)
        expect(result.stdout).toContain('Created Research Hub in')
        expect(result.stdout).toContain(`  cd '${target}'\n`)
        expect(result.stdout).toContain('`sssb / all-checks`')
        expect(result.stdout).toContain('Still to fill in: the code owner in CODEOWNERS (--owner)')
        expect(result.stdout).toContain(`\n  ${PLAYWRIGHT_INSTALL}\n`)
        expect(result.stdout).not.toMatch(/^ {2}pnpm exec playwright/m)
        expect(readJson(target, 'apps/research-hub/package.json').name).toBe('research-hub')
    })

    it('prints its usage, and fails with it on a bad argument', () => {
        expect(cli(['--help'])).toMatchObject({ status: 0, stdout: expect.stringContaining('--workflow-ref <sha>') })
        const bad = cli(['ws', '--slug', 'Bad'])
        expect(bad.status).toBe(1)
        expect(bad.stderr).toContain('@sssb/create: "Bad" is not a valid slug')
    })
})
