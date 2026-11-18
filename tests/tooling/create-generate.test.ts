import { execFileSync, spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'
import { CreateError } from '../../packages/create/src/args.js'
import { generate } from '../../packages/create/src/generate.js'
import { buildTemplate, EXCLUDED, filesUnder, fromStored, ROOT_FILES } from '../../packages/create/src/template.js'
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
const SEAM_SPECIFIERS: string[] = JSON.parse(
    readFileSync(path.join(REPO, 'packages/kit/src/testing/seam-specifiers.json'), 'utf8'),
).specifiers

const read = (root: string, file: string) => readFileSync(path.join(root, file), 'utf8')
const readJson = (root: string, file: string) => JSON.parse(read(root, file))

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
    it("holds the starter's files, the generic workspace files and a stamp of the workflow commit", () => {
        const starter = filesUnder(path.join(REPO, 'apps/starter'), (name) => EXCLUDED.has(name))
        const app = filesUnder(path.join(template, 'app')).map(fromStored)
        // The starter's tracked files are all there (a local, untracked file may be too, which is the next test's).
        const tracked = execFileSync('git', ['ls-files', 'apps/starter'], { cwd: REPO, encoding: 'utf8' })
            .split('\n')
            .filter(Boolean)
            .map((file) => path.relative('apps/starter', file))
            .filter((file) => existsSync(path.join(REPO, 'apps/starter', file)))
        expect(app).toEqual(expect.arrayContaining(tracked))
        expect(app).toEqual(starter.filter((file) => !file.endsWith('.tsbuildinfo') && !file.startsWith('.env')))
        expect(filesUnder(path.join(template, 'root')).map(fromStored).sort()).toEqual([...ROOT_FILES].sort())
        const meta = readJson(template, 'meta.json')
        expect(meta.workflow).toEqual({ repository: 'safeinsights/sssb', ref: HEAD })
        expect(meta.version).toBe(readJson(REPO, 'packages/create/package.json').version)
        expect(meta.seamSpecifiers).toEqual(SEAM_SPECIFIERS)
    })

    it('leaves out dependencies, build and test output, local state and secrets', () => {
        // A stand-in repository: the files the template reads, and a starter with every kind of local junk in it.
        const repo = makeTestTmpDir('create-junk-')
        for (const file of [
            'package.json',
            'pnpm-workspace.yaml',
            '.github/workflows/app-checks.yml',
            '.github/workflows/checks.yml',
            'packages/create/package.json',
            'packages/kit/src/testing/seam-specifiers.json',
            'packages/kit/src/cutover/rows.json',
            ...ROOT_FILES,
        ]) {
            mkdirSync(path.dirname(path.join(repo, file)), { recursive: true })
            cpSync(path.join(REPO, file), path.join(repo, file))
        }
        cpSync(path.join(REPO, 'apps/starter'), path.join(repo, 'apps/starter'), {
            recursive: true,
            filter: (source) => !source.includes(`${path.sep}node_modules`),
        })
        const junk = [
            'node_modules/pkg/index.js',
            '.next/server/page.js',
            '.data/pglite/PG_VERSION',
            'dist-demo/index.html',
            'test-results/run/trace.zip',
            'playwright-report/index.html',
            'coverage/lcov.info',
            'infra/cdk.out/manifest.json',
            'src/.data/nested',
            'next-env.d.ts',
            'tsconfig.tsbuildinfo',
            '.env.local',
            '.DS_Store',
        ]
        for (const file of junk) {
            mkdirSync(path.dirname(path.join(repo, 'apps/starter', file)), { recursive: true })
            writeFileSync(path.join(repo, 'apps/starter', file), 'junk')
        }
        const out = path.join(makeTestTmpDir('create-junk-out-'), 'template')
        const meta = buildTemplate({ repoRoot: repo, outDir: out, workflowRef: 'f'.repeat(40) })
        const copied = filesUnder(path.join(out, 'app')).map(fromStored)
        for (const file of junk) expect(copied).not.toContain(file)
        expect(copied).toContain('src/sssb.conformance.test.ts')
        expect(meta.workflow.ref).toBe('f'.repeat(40))
    })
})

describe('@sssb/create: the generated workspace', () => {
    it('is the app under apps/<slug>, its infra/, and the workspace around it', () => {
        const all = filesUnder(ws)
        const root = all.filter((file) => !file.startsWith('apps/'))
        expect(root.sort()).toEqual(
            [
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
     * repository (but the pinned workflow), its maintainer, and the project's old name. Two allowances, each pinned to
     * its exact form: the reusable workflow's `uses:` line names SSSB's repository, and `starter` is the name of the
     * port service in @sssb/tools (`sssb port`, `originFor`, `sssb tick`/`dev-tick`), which the app keeps when it is
     * renamed (@sssb/tools' ports.js). And every relative path stays inside its own app, or inside the workspace.
     */
    it('carries no survivor of SSSB’s repository', () => {
        const allowed: Record<string, RegExp[]> = {
            'safeinsights/sssb': [/^ {8}uses: safeinsights\/sssb\/\.github\/workflows\/app-checks\.yml@[0-9a-f]{40} /],
            starter: [/originFor\('starter'\)/, /"port": "starter"/, /sssb (?:dev-)?tick starter\b/],
        }
        const banned = ['starter', 'showcase', 'sssb-workspace', 'packages/kit', 'safeinsights/sssb', 'jpslav', 'keel']
        const survivors: string[] = []
        for (const file of filesUnder(ws)) {
            const lines = read(ws, file).split('\n')
            lines.forEach((line, index) => {
                for (const token of banned) {
                    if (!line.toLowerCase().includes(token)) continue
                    // `uses:` is allowed only in the workflow file.
                    const ok = (allowed[token] ?? []).some(
                        (pattern) =>
                            pattern.test(line) &&
                            (token !== 'safeinsights/sssb' || file === '.github/workflows/checks.yml'),
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
                    return value.replace('*', subpath.slice(before.length, subpath.length - after.length))
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
            writeFileSync(path.join(tarballs, `sssb-${pkg}-0.9.0.tgz`), '')
        const out = path.join(makeTestTmpDir('create-file-'), 'ws')
        generate({ templateDir: template, target: out, slug: 'acme', name: 'Acme', sssb: tarballs })
        const file = (pkg: string) => `file:${path.join(tarballs, `sssb-${pkg}-0.9.0.tgz`)}`
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
        writeFileSync(path.join(partial, 'sssb-kit-0.9.0.tgz'), '')
        const again = path.join(makeTestTmpDir('create-file-'), 'ws')
        const run = (sssb: string) => () =>
            generate({ templateDir: template, target: again, slug: 'a', name: 'A', sssb })
        expect(run(partial)).toThrow(/expected one sssb-tools-<version>\.tgz/)
        expect(run('latest')).toThrow(/neither a directory of tarballs nor a version/)
        generate({ templateDir: template, target: again, slug: 'a', name: 'A', sssb: '0.3.0-rc.1' })
        expect(readJson(again, 'apps/a/package.json').dependencies['@sssb/kit']).toBe('0.3.0-rc.1')
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
        const prettier = path.join(REPO, 'node_modules/.bin/prettier')
        const result = spawnSync(prettier, ['--check', '--log-level', 'warn', '.'], { cwd: ws, encoding: 'utf8' })
        expect(result.stdout + result.stderr).toBe('')
        expect(result.status).toBe(0)
    })
})

describe('@sssb/create: the command', () => {
    const cli = (args: string[]) => spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8' })

    it('generates from a checkout of SSSB, building the template on the way', () => {
        const target = path.join(makeTestTmpDir('create-cli-'), 'research-hub')
        const result = cli([target, '--repo', 'acme/hub', '--yes'])
        expect(result.stderr).toBe('')
        expect(result.status).toBe(0)
        expect(result.stdout).toContain('Created Research Hub in')
        expect(result.stdout).toContain('`sssb / all-checks`')
        expect(result.stdout).toContain('Still to fill in: the code owner in CODEOWNERS (--owner)')
        expect(readJson(target, 'apps/research-hub/package.json').name).toBe('research-hub')
    })

    it('prints its usage, and fails with it on a bad argument', () => {
        expect(cli(['--help'])).toMatchObject({ status: 0, stdout: expect.stringContaining('--workflow-ref <sha>') })
        const bad = cli(['ws', '--slug', 'Bad'])
        expect(bad.status).toBe(1)
        expect(bad.stderr).toContain('@sssb/create: "Bad" is not a valid slug')
    })
})
