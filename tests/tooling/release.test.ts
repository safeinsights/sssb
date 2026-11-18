import { execFileSync, spawnSync } from 'node:child_process'
import { copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { makeTestTmpDir } from '../support/tmp-dir'
import { check, prepare, preflight, publishable, verifyRelease, waitForChecks } from '../../scripts/release.mjs'

/**
 * scripts/release.mjs is what release.yml and CI's `release-plan` job run (ADR-0014 part 10). Each fixture is a
 * small workspace carrying THIS REPO'S OWN .changeset/config.json, so the tests pin the config as well as the
 * script: a config edit that changed what reaches npm turns them red.
 */
const SCRIPT = fileURLToPath(new URL('../../scripts/release.mjs', import.meta.url))
const CONFIG = fileURLToPath(new URL('../../.changeset/config.json', import.meta.url))
const SHA = 'a'.repeat(40)
const OTHER_SHA = 'b'.repeat(40)

type Pkg = {
    dir: string
    name: string
    version: string
    private?: boolean
    deps?: Record<string, string>
    repository?: { url: string }
}

const KIT = (version: string, isPrivate = true): Pkg => ({
    dir: 'packages/kit',
    name: '@sssb/kit',
    version,
    private: isPrivate,
    repository: { url: 'git+https://github.com/safeinsights/sssb.git' },
})
const APP: Pkg = { dir: 'apps/app', name: 'app', version: '0.1.0', private: true, deps: { '@sssb/kit': 'workspace:*' } }

function writeJson(file: string, value: unknown) {
    mkdirSync(path.dirname(file), { recursive: true })
    writeFileSync(file, JSON.stringify(value, null, 4) + '\n')
}

/**
 * A workspace with these packages and changesets (`{ id: frontmatter lines }`), committed when `git` is set.
 * `installed` runs `pnpm install --ignore-scripts` first, as the `plan` job does, under a root `prepare` script
 * that leaves a `prepare-ran` file wherever a later step runs scripts after all.
 */
function workspace(pkgs: Pkg[], changesets: Record<string, string[]> = {}, { git = false, installed = false } = {}) {
    const root = makeTestTmpDir('sssb-release-')
    writeJson(path.join(root, 'package.json'), {
        name: 'fixture',
        private: true,
        version: '0.0.0',
        ...(installed ? { scripts: { prepare: `node -e "require('fs').writeFileSync('prepare-ran', '')"` } } : {}),
    })
    writeFileSync(path.join(root, 'pnpm-workspace.yaml'), 'packages:\n    - apps/*\n    - packages/*\n')
    for (const p of pkgs) {
        writeJson(path.join(root, p.dir, 'package.json'), {
            name: p.name,
            version: p.version,
            ...(p.private ? { private: true } : {}),
            ...(p.repository ? { repository: p.repository } : {}),
            ...(p.deps ? { dependencies: p.deps } : {}),
        })
    }
    mkdirSync(path.join(root, '.changeset'))
    copyFileSync(CONFIG, path.join(root, '.changeset', 'config.json'))
    for (const [id, lines] of Object.entries(changesets)) {
        // A body in the shape the release notes are assembled from (scripts/release-notes.mjs); `check` and `prepare`
        // refuse any other.
        const body = `### ${id}\n\n**Kind.** none\n\n**Action.** none\n\n**What changed.** ${id}\n`
        writeFileSync(path.join(root, '.changeset', `${id}.md`), `---\n${lines.join('\n')}\n---\n\n${body}`)
    }
    if (installed) {
        writeFileSync(path.join(root, '.gitignore'), 'node_modules\n')
        execFileSync('pnpm', ['install', '--ignore-scripts', '--no-frozen-lockfile'], { cwd: root, stdio: 'ignore' })
    }
    if (git) {
        const run = (...args: string[]) => execFileSync('git', args, { cwd: root, stdio: 'ignore' })
        run('init', '-q', '-b', 'main')
        run('add', '-A')
        run('-c', 'user.name=t', '-c', 'user.email=t@example.invalid', 'commit', '-q', '--no-verify', '-m', 'init')
    }
    return root
}

type Answer = { status: number; body?: unknown }

/** A registry that answers from a table of URL suffixes, 404 for the rest. */
function registry(answers: Record<string, Answer> = {}) {
    return async (url: string | URL | Request) => {
        const key = Object.keys(answers).find((suffix) => String(url).endsWith(suffix))
        const { status, body } = key ? answers[key] : { status: 404 }
        return { status, ok: status >= 200 && status < 300, json: async () => body } as Response
    }
}

/** The attestation the registry serves for a version npm built from `sha`. */
function attestation(sha: string): Answer {
    const statement = { predicate: { buildDefinition: { resolvedDependencies: [{ digest: { gitCommit: sha } }] } } }
    const payload = Buffer.from(JSON.stringify(statement)).toString('base64')
    return {
        status: 200,
        body: {
            attestations: [{ predicateType: 'https://slsa.dev/provenance/v1', bundle: { dsseEnvelope: { payload } } }],
        },
    }
}

/** A tarball laid out as `pnpm pack` lays it out, holding only this manifest. */
function tarball(dir: string, file: string, manifest: Record<string, unknown>) {
    const staging = path.join(dir, `${file}-staging`)
    writeJson(path.join(staging, 'package', 'package.json'), manifest)
    execFileSync('tar', ['-czf', path.join(dir, file), '-C', staging, 'package'])
    return path.join(dir, file)
}

describe('release check (every PR)', () => {
    it('refuses a major changeset on 0.x, though Changesets plans nothing for a private package', async () => {
        const root = workspace([KIT('0.1.0'), APP], { breaking: ['"@sssb/kit": major'] })
        const { problems, plan } = await check(root)
        expect(problems.join('\n')).toMatch(/breaking\.md files a major for @sssb\/kit, which is on 0\.1\.0/)
        expect(problems.join('\n')).toMatch(/takes @sssb\/kit from 0\.1\.0 to 1\.0\.0/)
        // Judged as published: the kit alone, never the private app that depends on it.
        expect(plan.map((r: { name: string; newVersion: string }) => [r.name, r.newVersion])).toEqual([
            ['@sssb/kit', '1.0.0'],
        ])
    })

    it('accepts a minor, the breaking channel on 0.x', async () => {
        const root = workspace([KIT('0.1.0'), APP], { breaking: ['"@sssb/kit": minor'] })
        const { problems, plan } = await check(root)
        expect(problems).toEqual([])
        expect(plan.map((r: { newVersion: string }) => r.newVersion)).toEqual(['0.2.0'])
    })

    it('refuses any plan reaching 1.0.0, even with no major changeset', async () => {
        const root = workspace([KIT('1.0.0')], { fix: ['"@sssb/kit": patch'] })
        const { problems } = await check(root)
        expect(problems).toEqual([expect.stringMatching(/takes @sssb\/kit from 1\.0\.0 to 1\.0\.1/)])
    })

    it('refuses a changeset whose body cannot become a release-note entry, naming the file', async () => {
        const root = workspace([KIT('0.1.0'), APP], { fix: ['"@sssb/kit": patch'] })
        writeFileSync(path.join(root, '.changeset', 'fix.md'), "---\n'@sssb/kit': patch\n---\n\nJust some words.\n")
        const { problems } = await check(root)
        expect(problems.join('\n')).toMatch(/\.changeset\/fix\.md: the body starts with a `### title` line/)
        expect(problems.join('\n')).toMatch(/\.changeset\/fix\.md: missing `\*\*Kind\.\*\*`/)
    })

    it('accepts an empty changeset, and says a package or a bump once, not twice', async () => {
        const root = workspace([KIT('0.1.0'), APP], { app: ['"app": patch'] })
        writeFileSync(path.join(root, '.changeset', 'nothing.md'), '---\n---\n')
        const { problems } = await check(root)
        // the fixed-group rule says it; the shape lint leaves the package names to it
        expect(problems).toEqual([expect.stringMatching(/app\.md names app, which is not released/)])
    })

    it('refuses a changeset naming a package outside the fixed group, which would stop every release', async () => {
        const only = workspace([KIT('0.1.0'), APP], { app: ['"app": patch'] })
        expect((await check(only)).problems).toEqual([
            expect.stringMatching(/app\.md names app, which is not released/),
        ])
        const mixed = workspace([KIT('0.1.0'), APP], { both: ['"@sssb/kit": minor', '"app": patch'] })
        expect((await check(mixed)).problems).toEqual([expect.stringMatching(/both\.md names app/)])
    })

    it("requires a repository.url on every fixed-group package, which npm's provenance checks", async () => {
        const root = workspace([{ ...KIT('0.1.0'), repository: undefined }])
        expect((await check(root)).problems).toEqual([expect.stringMatching(/packages\/kit\/package\.json needs/)])
    })

    it('refuses a fixed group that is part private, or a member outside packages/', async () => {
        const tools: Pkg = { ...KIT('0.1.0'), dir: 'packages/tools', name: '@sssb/tools' }
        const mixed = workspace([KIT('0.1.0', false), tools])
        expect((await check(mixed)).problems).toEqual(['the fixed group must be all private or all public'])
        const elsewhere = workspace([KIT('0.1.0'), { ...tools, dir: 'apps/tools' }])
        expect((await check(elsewhere)).problems).toEqual([
            expect.stringMatching(/@sssb\/tools is in apps\/tools; a released package lives in packages/),
        ])
    })

    it('fails the CLI with the reason, so the CI job goes red', () => {
        const root = workspace([KIT('0.1.0')], { breaking: ['"@sssb/kit": major'] })
        const result = spawnSync(process.execPath, [SCRIPT, 'check'], { cwd: root, encoding: 'utf8' })
        expect(result.status).toBe(1)
        expect(result.stderr).toMatch(/a major would release 1\.0\.0/)
    })
})

describe('release prepare (the plan job)', () => {
    it('releases nothing while every package is private, and consumes no changeset', async () => {
        const root = workspace([KIT('0.1.0'), APP], { feature: ['"@sssb/kit": minor'] }, { git: true })
        const result = await prepare(root, { fetchImpl: registry() })
        expect(result).toEqual({ release: false, reason: expect.stringMatching(/name only private packages/) })
        expect(existsSync(path.join(root, '.changeset', 'feature.md'))).toBe(true)
        expect(JSON.parse(readFileSync(path.join(root, 'packages/kit/package.json'), 'utf8')).version).toBe('0.1.0')
    })

    it('versions a public fixed group with Changesets and leaves the commit to the workflow', async () => {
        const root = workspace([KIT('0.1.0', false), APP], { feature: ['"@sssb/kit": minor'] }, { git: true })
        const npm = registry({ '/%40sssb%2Fkit': { status: 200, body: { 'dist-tags': { latest: '0.0.0' } } } })
        const result = await prepare(root, { fetchImpl: npm })
        expect(result).toEqual({
            release: true,
            version: '0.2.0',
            packages: ['@sssb/kit'],
            notes: 'docs/releases/v0.2.0.md',
        })
        expect(JSON.parse(readFileSync(path.join(root, 'packages/kit/package.json'), 'utf8')).version).toBe('0.2.0')
        expect(existsSync(path.join(root, '.changeset', 'feature.md'))).toBe(false)
        expect(readFileSync(path.join(root, 'packages/kit/CHANGELOG.md'), 'utf8')).toMatch(/## 0\.2\.0/)
    })

    it('writes the release notes from the changesets BEFORE Changesets deletes them, into the release commit', async () => {
        const root = workspace([KIT('0.1.0', false), APP], { feature: ['"@sssb/kit": minor'] }, { git: true })
        writeFileSync(
            path.join(root, '.changeset', 'feature.md'),
            "---\n'@sssb/kit': minor\n---\n\n### A hook the registry takes\n\n**Kind.** seam\n\n**Action.** required\n\n" +
                '**What changed.** The registry takes a hook.\n\n**To adopt.** Register it.\n',
        )
        execFileSync('git', ['add', '-A'], { cwd: root })
        execFileSync(
            'git',
            ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', 'commit', '-q', '--no-verify', '-m', 'x'],
            { cwd: root },
        )
        const npm = registry({ '/%40sssb%2Fkit': { status: 200, body: { 'dist-tags': { latest: '0.0.0' } } } })
        await prepare(root, { fetchImpl: npm })
        // the changeset is consumed, and the notes it made are a file in the tree, for `git add -A` to stage
        expect(existsSync(path.join(root, '.changeset', 'feature.md'))).toBe(false)
        const notes = readFileSync(path.join(root, 'docs/releases/v0.2.0.md'), 'utf8')
        expect(notes).toMatch(/^# Release notes: v0\.2\.0\n/)
        expect(notes).toMatch(/## Seam changes\n\n### A hook the registry takes\n\nAction: required · `@sssb\/kit`\n/)
        expect(notes).toMatch(/\*\*To adopt\.\*\* Register it\./)
        const status = execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' })
        expect(status).toMatch(/\?\? docs\//)
    })

    it("judges a changeset the way `check` does: the packages and bumps are the plan's business, not the notes'", async () => {
        // `none` is a bump Changesets accepts and files no release for; the shape lint alone would refuse it.
        const root = workspace(
            [KIT('0.1.0', false), APP],
            { feature: ['"@sssb/kit": minor'], quiet: ['"@sssb/kit": none'] },
            { git: true },
        )
        const npm = registry({ '/%40sssb%2Fkit': { status: 200, body: { 'dist-tags': { latest: '0.0.0' } } } })
        expect((await check(root)).problems).toEqual([])
        expect(await prepare(root, { fetchImpl: npm })).toMatchObject({ release: true, version: '0.2.0' })
    })

    it('stops before changing anything when a changeset is not a readable entry', async () => {
        const root = workspace([KIT('0.1.0', false), APP], { feature: ['"@sssb/kit": minor'] }, { git: true })
        writeFileSync(path.join(root, '.changeset', 'feature.md'), "---\n'@sssb/kit': minor\n---\n\nwords\n")
        execFileSync('git', ['add', '-A'], { cwd: root })
        execFileSync(
            'git',
            ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', 'commit', '-q', '--no-verify', '-m', 'x'],
            {
                cwd: root,
            },
        )
        const npm = registry({ '/%40sssb%2Fkit': { status: 200, body: { 'dist-tags': { latest: '0.0.0' } } } })
        await expect(prepare(root, { fetchImpl: npm })).rejects.toThrow(
            /feature\.md: the body starts with a `### title`/,
        )
        expect(existsSync(path.join(root, '.changeset', 'feature.md'))).toBe(true)
        expect(JSON.parse(readFileSync(path.join(root, 'packages/kit/package.json'), 'utf8')).version).toBe('0.1.0')
    })

    it('runs no install script, though Changesets formats through `pnpm exec` after bumping a version', async () => {
        // pnpm 11 re-installs, scripts and all, before an `exec` in a workspace whose versions changed since the
        // last install, unless verify-deps-before-run is off.
        const root = workspace(
            [KIT('0.1.0', false)],
            { feature: ['"@sssb/kit": minor'] },
            { git: true, installed: true },
        )
        const npm = registry({ '/%40sssb%2Fkit': { status: 200, body: { 'dist-tags': { latest: '0.0.0' } } } })
        // `pnpm exec vitest` hands its children this very setting, which would hide the bug; CI's job has none.
        const inherited = process.env.pnpm_config_verify_deps_before_run
        delete process.env.pnpm_config_verify_deps_before_run
        try {
            expect(await prepare(root, { fetchImpl: npm })).toMatchObject({ release: true, version: '0.2.0' })
        } finally {
            if (inherited !== undefined) process.env.pnpm_config_verify_deps_before_run = inherited
        }
        expect(existsSync(path.join(root, 'prepare-ran'))).toBe(false)
    })

    it('refuses to go behind what npm already holds', async () => {
        const root = workspace([KIT('0.1.0', false)], { fix: ['"@sssb/kit": patch'] }, { git: true })
        const npm = registry({ '/%40sssb%2Fkit': { status: 200, body: { 'dist-tags': { latest: '0.3.0' } } } })
        await expect(prepare(root, { fetchImpl: npm })).rejects.toThrow(/0\.1\.1, which is not newer than npm's latest/)
    })

    it('refuses a tree with uncommitted changes', async () => {
        const root = workspace([KIT('0.1.0', false)], {}, { git: true })
        writeFileSync(path.join(root, 'stray.txt'), 'x')
        await expect(prepare(root, { fetchImpl: registry() })).rejects.toThrow(/uncommitted changes/)
    })
})

describe('release.mjs run alone, as the push and publish jobs run it', () => {
    it('loads and judges a release with no sibling module and no node_modules: nothing is imported statically', () => {
        // release.yml's `push` job copies scripts/release.mjs out of the commit, and `publish` checks out only that
        // file. A static import of scripts/release-notes.mjs would fail both with ERR_MODULE_NOT_FOUND.
        const root = workspace([KIT('0.2.0', false)], {}, { git: true })
        const alone = path.join(makeTestTmpDir('sssb-release-alone-'), 'release.mjs')
        copyFileSync(SCRIPT, alone)
        const run = spawnSync(process.execPath, [alone, 'verify-release', '0.2.1'], { cwd: root, encoding: 'utf8' })
        expect(run.stderr).not.toMatch(/ERR_MODULE_NOT_FOUND|Cannot find module/)
        // it reached its own checks, and failed them: nothing is pending
        expect(run.status).toBe(1)
        expect(run.stderr).toMatch(/release nothing/)
    })
})

describe('release publishable (the tag)', () => {
    it('is empty while every package is private: the publish is a no-op until P14', async () => {
        expect(await publishable(workspace([KIT('0.1.0'), APP]), '0.1.0')).toEqual([])
    })

    it('lists the public fixed group at the tag version', async () => {
        const root = workspace([KIT('0.2.0', false), APP])
        expect(await publishable(root, '0.2.0')).toEqual([{ name: '@sssb/kit', dir: 'packages/kit' }])
    })

    it('refuses a public package at another version, or outside the fixed group', async () => {
        await expect(publishable(workspace([KIT('0.2.0', false)]), '0.3.0')).rejects.toThrow(/@sssb\/kit@0\.2\.0/)
        const stray = { dir: 'packages/guard', name: 'create-sssb', version: '0.2.0' }
        await expect(publishable(workspace([KIT('0.2.0', false), stray]), '0.2.0')).rejects.toThrow(/create-sssb/)
    })

    it('refuses a "private" that is not a boolean rather than guess', async () => {
        const root = workspace([KIT('0.2.0', false)])
        const file = path.join(root, 'packages/kit/package.json')
        writeJson(file, { ...JSON.parse(readFileSync(file, 'utf8')), private: 'true' })
        await expect(publishable(root, '0.2.0')).rejects.toThrow(/"private" must be true or false/)
    })
})

describe('release verify-release (the job holding the release key)', () => {
    /** A public kit with one minor changeset, prepared as `plan` prepares it and staged as `push` applies it. */
    async function prepared() {
        const root = workspace([KIT('0.1.0', false)], { feature: ['"@sssb/kit": minor'] }, { git: true })
        const npm = registry({ '/%40sssb%2Fkit': { status: 200, body: { 'dist-tags': { latest: '0.0.0' } } } })
        await prepare(root, { fetchImpl: npm })
        const run = (...args: string[]) => execFileSync('git', args, { cwd: root, stdio: 'ignore' })
        run('add', '-A')
        return { root, run }
    }

    it('accepts what prepare wrote: a deleted changeset, a changelog and a version', async () => {
        const { root } = await prepared()
        expect(() => verifyRelease(root, '0.2.0')).not.toThrow()
        expect(() => verifyRelease(root, '0.3.0')).toThrow(/the pending changesets release 0\.2\.0, not 0\.3\.0/)
    })

    it('refuses anything else the patch could carry', async () => {
        const kitManifest = (root: string) => path.join(root, 'packages/kit/package.json')
        const cases: [(root: string, run: (...a: string[]) => void) => void, RegExp][] = [
            [
                (root) => {
                    const file = kitManifest(root)
                    writeJson(file, { ...JSON.parse(readFileSync(file, 'utf8')), scripts: { postinstall: 'x' } })
                },
                /packages\/kit\/package\.json must change only its version/,
            ],
            [
                // JSON-equal, byte-different: a duplicate key the last of which wins.
                (root) => {
                    const file = kitManifest(root)
                    writeFileSync(file, readFileSync(file, 'utf8').replace('{\n', '{\n    "name": "other",\n'))
                },
                /packages\/kit\/package\.json must change only its version/,
            ],
            [
                // A release that consumes nothing: the changeset is put back.
                (_root, run) => run('checkout', 'HEAD', '--', '.changeset/feature.md'),
                /\.changeset\/feature\.md is not consumed/,
            ],
            [
                (root) => writeFileSync(path.join(root, 'packages/zz-CHANGELOG.md'), 'x'),
                /may not change packages\/zz-CHANGELOG\.md/,
            ],
            [
                (root) => {
                    mkdirSync(path.join(root, 'packages/zz'))
                    writeFileSync(path.join(root, 'packages/zz/CHANGELOG.md'), 'x')
                },
                /may not change packages\/zz\/CHANGELOG\.md/,
            ],
            [
                (root) => writeFileSync(path.join(root, '.changeset', 'config.json'), '{}'),
                /may not change \.changeset\/config\.json/,
            ],
            [(root) => writeFileSync(path.join(root, 'scripts.mjs'), 'x'), /may not change scripts\.mjs/],
            [
                (root) => {
                    rmSync(path.join(root, 'packages/kit/CHANGELOG.md'))
                    symlinkSync('/etc/passwd', path.join(root, 'packages/kit/CHANGELOG.md'))
                },
                /may not change packages\/kit\/CHANGELOG\.md \(A 000000 → 120000\)/,
            ],
            [(_root, run) => run('tag', 'v0.2.0'), /0\.2\.0 is not newer than v0\.2\.0/],
            [
                // Notes for another version, or a file that is not notes.
                (root) => writeFileSync(path.join(root, 'docs/releases/v0.2.0.md'), '# Release notes: v0.9.0\n'),
                /docs\/releases\/v0\.2\.0\.md must be the release notes of v0\.2\.0/,
            ],
            [
                (root) => writeFileSync(path.join(root, 'docs/releases/v0.9.0.md'), '# Release notes: v0.9.0\n'),
                /may not change docs\/releases\/v0\.9\.0\.md/,
            ],
            [
                (root) => {
                    rmSync(path.join(root, 'docs/releases/v0.2.0.md'))
                    symlinkSync('/etc/passwd', path.join(root, 'docs/releases/v0.2.0.md'))
                },
                /may not change docs\/releases\/v0\.2\.0\.md \(A 000000 → 120000\)/,
            ],
            [
                // The notes missing altogether: a release that landed without them.
                (root) => rmSync(path.join(root, 'docs/releases/v0.2.0.md')),
                /the release notes docs\/releases\/v0\.2\.0\.md are not staged/,
            ],
        ]
        // One `prepare` (a Changesets subprocess, ~0.7 s) for the whole test: each case works on its own copy of the
        // prepared tree, `.git` and the staged index included. Preparing per case took ~7 s alone and blew the 20 s
        // timeout once under machine load.
        const base = await prepared()
        for (const [tamper, reason] of cases) {
            const root = makeTestTmpDir('sssb-release-case-')
            cpSync(base.root, root, { recursive: true })
            const run = (...args: string[]) => execFileSync('git', args, { cwd: root, stdio: 'ignore' })
            tamper(root, run)
            run('add', '-A')
            expect(() => verifyRelease(root, '0.2.0')).toThrow(reason)
        }
    })

    it('refuses a version the changesets do not imply, even with every file in order', async () => {
        const root = workspace([KIT('0.1.0', false)], { feature: ['"@sssb/kit": minor'] }, { git: true })
        rmSync(path.join(root, '.changeset', 'feature.md'))
        const file = path.join(root, 'packages/kit/package.json')
        writeFileSync(file, readFileSync(file, 'utf8').replace('"version": "0.1.0"', '"version": "0.37.0"'))
        execFileSync('git', ['add', '-A'], { cwd: root })
        expect(() => verifyRelease(root, '0.37.0')).toThrow(/the pending changesets release 0\.2\.0, not 0\.37\.0/)
    })

    it('skips the files Changesets skips, and prints the line the workflow requires', async () => {
        // Single-quoted, as .changeset/README.md's example writes it; the other fixtures double-quote.
        const root = workspace([KIT('0.1.0', false)], { feature: ["'@sssb/kit': minor"] }, { git: true })
        for (const name of ['CLAUDE.md', 'AGENTS.md', '.notes.md'])
            writeFileSync(path.join(root, '.changeset', name), 'x')
        const run = (...args: string[]) => execFileSync('git', args, { cwd: root, stdio: 'ignore' })
        run('add', '-A')
        run('-c', 'user.name=t', '-c', 'user.email=t@example.invalid', 'commit', '-q', '--no-verify', '-m', 'notes')
        const npm = registry({ '/%40sssb%2Fkit': { status: 200, body: { 'dist-tags': { latest: '0.0.0' } } } })
        await prepare(root, { fetchImpl: npm })
        run('add', '-A')
        const result = spawnSync(process.execPath, [SCRIPT, 'verify-release', '0.2.0'], { cwd: root, encoding: 'utf8' })
        expect(result.stderr).toBe('')
        expect(result.stdout).toBe('verified 0.2.0\n')
    })

    it('runs, and fails, when its CLI is reached through a symlink', () => {
        const root = workspace([KIT('0.1.0', false)], {}, { git: true })
        const link = path.join(root, 'release-link.mjs')
        symlinkSync(SCRIPT, link)
        const result = spawnSync(process.execPath, [link, 'verify-release', '0.2.0'], { cwd: root, encoding: 'utf8' })
        expect(result.status).toBe(1)
        expect(result.stderr).toMatch(/the pending changesets release nothing/)
    })
})

describe('release preflight (the job holding the id-token)', () => {
    const kit = { name: '@sssb/kit', version: '0.2.0' }

    it('publishes what npm lacks and skips what this commit already published', async () => {
        const root = workspace([])
        const kitTgz = tarball(root, 'kit.tgz', kit)
        const cdkTgz = tarball(root, 'cdk.tgz', { name: '@sssb/cdk', version: '0.2.0' })
        const npm = registry({ '/attestations/%40sssb%2Fcdk@0.2.0': attestation(SHA) })
        expect(await preflight(root, '0.2.0', SHA, [kitTgz, cdkTgz], npm)).toEqual([
            { name: '@sssb/kit', file: kitTgz },
        ])
    })

    it('refuses, before any publish, a version npm holds from another commit', async () => {
        const root = workspace([])
        const npm = registry({ '/attestations/%40sssb%2Fkit@0.2.0': attestation(OTHER_SHA) })
        await expect(preflight(root, '0.2.0', SHA, [tarball(root, 'kit.tgz', kit)], npm)).rejects.toThrow(
            /on npm from b{40}, not this release/,
        )
    })

    it('refuses to move latest back', async () => {
        const root = workspace([])
        const npm = registry({ '/%40sssb%2Fkit': { status: 200, body: { 'dist-tags': { latest: '0.3.0' } } } })
        await expect(preflight(root, '0.2.0', SHA, [tarball(root, 'kit.tgz', kit)], npm)).rejects.toThrow(
            /latest is 0\.3\.0, newer than 0\.2\.0/,
        )
    })

    it('refuses a tarball laid out other than as one package/, which npm could read differently', async () => {
        const root = workspace([])
        const staging = path.join(root, 'odd')
        writeJson(path.join(staging, 'package', 'package.json'), kit)
        writeJson(path.join(staging, 'other', 'package.json'), { name: '@sssb/kit', version: '9.9.9' })
        execFileSync('tar', ['-czf', path.join(root, 'odd.tgz'), '-C', staging, 'other', 'package'])
        // A second manifest at an unnormalized path that names the same file, and a link.
        execFileSync('tar', [
            '-czf',
            path.join(root, 'dot.tgz'),
            '-C',
            staging,
            'package/package.json',
            'package/./package.json',
        ])
        symlinkSync('package.json', path.join(staging, 'package', 'link.json'))
        execFileSync('tar', ['-czf', path.join(root, 'link.tgz'), '-C', staging, 'package'])
        for (const file of ['odd.tgz', 'dot.tgz', 'link.tgz']) {
            await expect(preflight(root, '0.2.0', SHA, [path.join(root, file)], registry())).rejects.toThrow(
                /not laid out as one package\//,
            )
        }
    })

    it("judges each tarball's own manifest, not pack's word", async () => {
        const root = workspace([])
        const cases: [Record<string, unknown>, RegExp][] = [
            [{ name: 'create-sssb', version: '0.2.0' }, /create-sssb, which is not in the fixed group/],
            [{ name: '@sssb/kit', version: '0.2.1' }, /@sssb\/kit@0\.2\.1, not 0\.2\.0/],
            [{ ...kit, private: true }, /@sssb\/kit, which is private/],
        ]
        for (const [manifest, reason] of cases) {
            const tgz = tarball(root, `${String(manifest.version)}-${String(manifest.private)}.tgz`, manifest)
            await expect(preflight(root, '0.2.0', SHA, [tgz], registry())).rejects.toThrow(reason)
        }
    })
})

describe('release wait-for-checks (the CI gate)', () => {
    /** The gate, answered by these reads in turn (the last repeats), on a clock that each sleep advances. */
    function gate(reads: (Answer | Error)[], timeoutMs = 60_000) {
        let t = 0
        let i = 0
        const urls: string[] = []
        const fetchImpl = async (url: string | URL | Request) => {
            urls.push(String(url))
            const read = reads[Math.min(i++, reads.length - 1)]
            if (read instanceof Error) throw read
            return { status: read.status, ok: read.status === 200, json: async () => read.body } as Response
        }
        const run = waitForChecks({
            repo: 'safeinsights/sssb',
            sha: SHA,
            token: 't',
            timeoutMs,
            intervalMs: 20_000,
            fetchImpl,
            sleep: async (ms: number) => {
                t += ms
            },
            now: () => t,
        })
        return { run, urls, reads: () => i }
    }
    const runs = (status: string, conclusion: string | null): Answer => ({
        status: 200,
        body: { workflow_runs: [{ status, conclusion }] },
    })

    it('waits through a running workflow and passes on success, reading the push run on main for this commit', async () => {
        const { run, urls } = gate([runs('in_progress', null), runs('completed', 'success')])
        await expect(run).resolves.toBeUndefined()
        expect(urls[0]).toMatch(/\/workflows\/checks\.yml\/runs\?head_sha=a{40}&event=push&branch=main&per_page=1$/)
    })

    it('refuses at once when checks concluded anything but success', async () => {
        for (const conclusion of ['failure', 'cancelled', 'skipped']) {
            const { run, reads } = gate([runs('completed', conclusion)])
            await expect(run).rejects.toThrow(`checks concluded '${conclusion}'`)
            expect(reads()).toBe(1)
        }
    })

    it('fails closed: errors, no run and malformed answers wait until the deadline, never pass', async () => {
        const { run, reads } = gate([
            new Error('network down'),
            { status: 500 },
            { status: 200, body: {} },
            runs('queued', null),
        ])
        await expect(run).rejects.toThrow(/timed out waiting for checks on a{40} \(last: queued\)/)
        expect(reads()).toBe(4)
    })
})
