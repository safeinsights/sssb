import { execFileSync, spawnSync } from 'node:child_process'
import { copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { makeTestTmpDir } from '../support/tmp-dir'
import {
    bump,
    candidate,
    candidateNotes,
    check,
    impliedVersion,
    nextCandidate,
    prepare,
    unwrap,
    preflight,
    publishable,
    verifyRelease,
    waitForChecks,
} from '../../scripts/release.mjs'

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
 * that leaves a `prepare-ran` file wherever a later step runs scripts after all. `pre` writes `.changeset/pre.json` in
 * pre mode with the tag `rc`; by default it is written when the fixed group is private, as this repository has it
 * until P14 (a private group's releases are candidates, ADR-0014 P7).
 */
function workspace(
    pkgs: Pkg[],
    changesets: Record<string, string[]> = {},
    {
        git = false,
        installed = false,
        pre = pkgs.filter((p) => p.name.startsWith('@sssb/')).every((p) => p.private),
    } = {},
) {
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
    if (pre) writeJson(path.join(root, '.changeset', 'pre.json'), { mode: 'pre', tag: 'rc' })
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
function tarball(dir: string, file: string, manifest: Record<string, unknown>, extra: Record<string, string> = {}) {
    const staging = path.join(dir, `${file}-staging`)
    writeJson(path.join(staging, 'package', 'package.json'), manifest)
    for (const [name, text] of Object.entries(extra)) {
        mkdirSync(path.dirname(path.join(staging, 'package', name)), { recursive: true })
        writeFileSync(path.join(staging, 'package', name), text)
    }
    execFileSync('tar', ['-czf', path.join(dir, file), '-C', staging, 'package'])
    return path.join(dir, file)
}

describe('release check (every PR)', () => {
    it('refuses a major changeset on 0.x, in a release candidate as in a release', async () => {
        const root = workspace([KIT('0.1.0'), APP], { breaking: ['"@sssb/kit": major'] })
        const { problems, plan } = await check(root)
        expect(problems.join('\n')).toMatch(/breaking\.md files a major for @sssb\/kit, which is on 0\.1\.0/)
        expect(problems.join('\n')).toMatch(/takes @sssb\/kit from 0\.1\.0 to 1\.0\.0-rc\.0/)
        // The kit alone, never the private app that depends on it: the config ignores every unscoped package.
        expect(plan.map((r: { name: string; newVersion: string }) => [r.name, r.newVersion])).toEqual([
            ['@sssb/kit', '1.0.0-rc.0'],
        ])
    })

    it('accepts a minor, the breaking channel on 0.x: a candidate while private, a release once public', async () => {
        const candidate = workspace([KIT('0.1.0'), APP], { breaking: ['"@sssb/kit": minor'] })
        expect(await check(candidate)).toMatchObject({ problems: [], plan: [{ newVersion: '0.2.0-rc.0' }] })
        const release = workspace([KIT('0.1.0', false), APP], { breaking: ['"@sssb/kit": minor'] })
        expect(await check(release)).toMatchObject({ problems: [], plan: [{ newVersion: '0.2.0' }] })
    })

    it('ties pre mode to privacy: a private group cuts candidates, a public one leaves pre mode', async () => {
        // Without pre mode a merge to main would cut a plain version of a private group, which nothing can publish.
        const unmarked = workspace([KIT('0.1.0'), APP], { feature: ['"@sssb/kit": minor'] }, { pre: false })
        expect((await check(unmarked)).problems).toEqual([expect.stringMatching(/pre\.json must be \{"mode": "pre"/)])
        // npm sees no candidate: a public group's release is plain.
        const publicPre = workspace([KIT('0.1.0', false)], { feature: ['"@sssb/kit": minor'] }, { pre: true })
        expect((await check(publicPre)).problems).toEqual([
            expect.stringMatching(/the fixed group is public: leave pre mode/),
        ])
    })

    it('reads pre.json strictly: exactly pre mode with the tag rc, or nothing', async () => {
        for (const state of [
            { mode: 'exit', tag: 'rc' },
            { mode: 'pre', tag: 'beta' },
            { mode: 'pre', tag: 'rc', x: 1 },
        ]) {
            const root = workspace([KIT('0.1.0')])
            writeJson(path.join(root, '.changeset', 'pre.json'), state)
            await expect(check(root)).rejects.toThrow(/pre\.json must be exactly \{"mode": "pre", "tag": "rc"\}/)
        }
    })

    it('refuses a group member at another version, which the release would refuse after merge', async () => {
        // A package that joins the group mid-cycle at 0.1.0, beside one at a candidate's version.
        const tools: Pkg = { ...KIT('0.1.0'), dir: 'packages/tools', name: '@sssb/tools' }
        const root = workspace([KIT('0.2.0-rc.0'), tools], { fix: ['"@sssb/kit": patch'] })
        expect((await check(root)).problems).toEqual([
            expect.stringMatching(/several versions \(@sssb\/kit@0\.2\.0-rc\.0, @sssb\/tools@0\.1\.0\)/),
        ])
    })

    it('refuses a pending changeset named like one an earlier candidate consumed', async () => {
        const root = workspace([KIT('0.2.0-rc.0')], { feature: ['"@sssb/kit": minor'] })
        mkdirSync(path.join(root, '.changeset', 'pre'))
        copyFileSync(path.join(root, '.changeset', 'feature.md'), path.join(root, '.changeset', 'pre', 'feature.md'))
        expect((await check(root)).problems).toEqual([
            expect.stringMatching(/feature\.md has the name of a changeset an earlier release candidate consumed/),
        ])
    })

    it('requires a config that versions private packages while the group is private', async () => {
        const root = workspace([KIT('0.1.0'), APP], { feature: ['"@sssb/kit": minor'] })
        const file = path.join(root, '.changeset', 'config.json')
        writeJson(file, { ...JSON.parse(readFileSync(file, 'utf8')), privatePackages: { version: false, tag: false } })
        expect((await check(root)).problems).toEqual([expect.stringMatching(/must version private packages/)])
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
    it('cuts a release candidate while the group is private: rc versions, the changesets moved to pre/', async () => {
        const root = workspace([KIT('0.1.0'), APP], { feature: ['"@sssb/kit": minor'] }, { git: true })
        const result = await prepare(root, { fetchImpl: registry() })
        expect(result).toEqual({
            release: true,
            version: '0.2.0-rc.0',
            packages: ['@sssb/kit'],
            notes: 'docs/releases/v0.2.0-rc.0.md',
        })
        const manifest = (dir: string) => JSON.parse(readFileSync(path.join(root, dir, 'package.json'), 'utf8'))
        expect(manifest('packages/kit')).toMatchObject({ version: '0.2.0-rc.0', private: true })
        // the app the config ignores keeps its version
        expect(manifest('apps/app').version).toBe('0.1.0')
        // consumed, but kept until pre mode ends: Changesets 3 moves it, byte for byte
        expect(existsSync(path.join(root, '.changeset', 'feature.md'))).toBe(false)
        expect(readFileSync(path.join(root, '.changeset', 'pre', 'feature.md'), 'utf8')).toMatch(
            /^---\n"@sssb\/kit": minor/,
        )
        expect(readFileSync(path.join(root, 'docs/releases/v0.2.0-rc.0.md'), 'utf8')).toMatch(
            /^# Release notes: v0\.2\.0-rc\.0\n/,
        )
    })

    it('numbers the next candidate on from the last, and keeps the version it is heading for', async () => {
        // Cut rc.0 from a minor, then a patch and a minor in turn: both are already inside 0.2.0, so only N moves.
        const root = workspace([KIT('0.1.0'), APP], { feature: ['"@sssb/kit": minor'] }, { git: true })
        const commit = (message: string) => {
            execFileSync('git', ['add', '-A'], { cwd: root })
            execFileSync(
                'git',
                [
                    '-c',
                    'user.name=t',
                    '-c',
                    'user.email=t@example.invalid',
                    'commit',
                    '-q',
                    '--no-verify',
                    '-m',
                    message,
                ],
                { cwd: root },
            )
        }
        await prepare(root, { fetchImpl: registry() })
        commit('rc.0')
        for (const [id, type, expected] of [
            ['fix', 'patch', '0.2.0-rc.1'],
            ['more', 'minor', '0.2.0-rc.2'],
        ]) {
            const body = `### ${id}\n\n**Kind.** none\n\n**Action.** none\n\n**What changed.** ${id}\n`
            writeFileSync(path.join(root, '.changeset', `${id}.md`), `---\n"@sssb/kit": ${type}\n---\n\n${body}`)
            commit(`add ${id}`)
            expect(await prepare(root, { fetchImpl: registry() })).toMatchObject({ release: true, version: expected })
            commit(expected)
        }
        // nothing new pending: no release, though the consumed changesets are still in .changeset/pre/
        expect(await prepare(root, { fetchImpl: registry() })).toEqual({
            release: false,
            reason: 'no changesets are pending',
        })
    })

    it('refuses a candidate whose tag already exists, or that is not ahead of the latest release', async () => {
        const root = workspace([KIT('0.1.0'), APP], { feature: ['"@sssb/kit": minor'] }, { git: true })
        execFileSync('git', ['tag', 'v0.2.0-rc.0'], { cwd: root })
        await expect(prepare(root, { fetchImpl: registry() })).rejects.toThrow(/the tag v0\.2\.0-rc\.0 already exists/)
        execFileSync('git', ['tag', '-d', 'v0.2.0-rc.0'], { cwd: root, stdio: 'ignore' })
        execFileSync('git', ['tag', 'v0.2.0'], { cwd: root })
        await expect(prepare(root, { fetchImpl: registry() })).rejects.toThrow(
            /not newer than the latest stable tag \(0\.2\.0\)/,
        )
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
        // release.yml's `push` job copies scripts/release.mjs out of the commit, and `publish` checks out three files,
        // release.mjs among them and release-notes.mjs not. A static import of scripts/release-notes.mjs would fail both with ERR_MODULE_NOT_FOUND.
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
                // The notes file already in HEAD with other content: the release would modify it, not add it.
                (root, run) => {
                    const notes = path.join(root, 'docs/releases/v0.2.0.md')
                    writeFileSync(notes, '# Release notes: v0.0.1\n')
                    run('add', 'docs/releases/v0.2.0.md')
                    run(
                        '-c',
                        'user.name=t',
                        '-c',
                        'user.email=t@example.invalid',
                        'commit',
                        '-q',
                        '--no-verify',
                        '-m',
                        'x',
                        '--',
                        'docs/releases/v0.2.0.md',
                    )
                    writeFileSync(notes, '# Release notes: v0.2.0\n\nmore\n')
                },
                /may not change docs\/releases\/v0\.2\.0\.md \(M 100644 → 100644\)/,
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

describe('release candidates (ADR-0014 P7): the version they take, as Changesets 3 computes it', () => {
    it("bumps a prerelease to the version it is heading for, as semver's inc does", () => {
        // Each row is semver/functions/inc's answer (semver 7), which Changesets 3 calls before appending -rc.N.
        for (const [from, type, to] of [
            ['0.1.0', 'patch', '0.1.1'],
            ['0.1.0', 'minor', '0.2.0'],
            ['0.1.0', 'major', '1.0.0'],
            ['0.2.0-rc.1', 'patch', '0.2.0'],
            ['0.2.0-rc.1', 'minor', '0.2.0'],
            ['0.2.0-rc.1', 'major', '1.0.0'],
            ['0.1.1-rc.0', 'patch', '0.1.1'],
            ['0.1.1-rc.0', 'minor', '0.2.0'],
            ['1.0.0-rc.0', 'major', '1.0.0'],
        ] as const) {
            expect(bump(from, type), `${from} ${type}`).toBe(to)
        }
    })

    it('numbers a candidate one past the group, from 0', () => {
        expect(nextCandidate(['0.1.0', '0.1.0'])).toBe(0)
        expect(nextCandidate(['0.2.0-rc.0', '0.2.0-rc.0'])).toBe(1)
        expect(impliedVersion(['0.2.0-rc.4'], ['patch', 'none'], true)).toBe('0.2.0-rc.5')
        expect(impliedVersion(['0.1.0'], ['minor', 'patch'], true)).toBe('0.2.0-rc.0')
        expect(impliedVersion(['0.1.0'], ['patch'], false)).toBe('0.1.1')
        expect(impliedVersion(['0.1.0'], ['none'], true)).toBeNull()
        expect(() => impliedVersion(['0.1.0', '0.2.0'], ['patch'], true)).toThrow(/several versions/)
    })
})

describe("the prerelease notes' line breaks", () => {
    it('joins wrapped lines, which a GitHub release renders as hard breaks, and leaves the rest as it was', () => {
        const wrapped = [
            '# Release notes: v0.2.0-rc.0',
            '',
            'A paragraph wrapped',
            'onto two lines.',
            '',
            '- an item',
            '  continued',
            '- another',
            '',
            '| a | b |',
            '| --- | --- |',
            '',
            '```yaml',
            'overrides:',
            "    '@sssb/kit': x",
            '```',
            '### A title',
            'right under it',
        ].join('\n')
        expect(unwrap(wrapped)).toBe(
            [
                '# Release notes: v0.2.0-rc.0',
                '',
                'A paragraph wrapped onto two lines.',
                '',
                '- an item continued',
                '- another',
                '',
                '| a | b |',
                '| --- | --- |',
                '',
                '```yaml',
                'overrides:',
                "    '@sssb/kit': x",
                '```',
                '### A title',
                'right under it',
            ].join('\n'),
        )
    })
})

describe("the prerelease notes' line breaks, where joining would change what an adopter copies", () => {
    const untouched = (text: string) => expect(unwrap(text)).toBe(text)

    it('leaves a fence that holds a shorter fence, and a ~~~ fence that holds backticks, as they were', () => {
        untouched(['````md', '```ts', 'const a = 1', 'const b = 2', '```', '````'].join('\n'))
        untouched(['~~~', '```', 'line one', 'line two', '~~~'].join('\n'))
    })

    it('leaves indented code, hard breaks, HTML, link definitions and setext underlines on their own lines', () => {
        untouched(['Before:', '', '    code one', '    code two'].join('\n'))
        untouched(['a hard break  ', 'after it'].join('\n'))
        untouched(['a backslash break\\', 'after it'].join('\n'))
        untouched(['<details>', '<summary>More</summary>', 'text', '</details>'].join('\n'))
        untouched(['[a]: https://example.invalid/a', '[b]: https://example.invalid/b'].join('\n'))
        untouched(['A setext title', '---'].join('\n'))
        untouched(['a | table', '--- | ---', 'x | y'].join('\n'))
    })
})

describe('a release candidate, end to end, against a local fake tag', () => {
    const TOOLS = (version: string): Pkg => ({ ...KIT(version), dir: 'packages/tools', name: '@sssb/tools' })
    const commit = (root: string, message: string) =>
        execFileSync(
            'git',
            ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', 'commit', '-q', '--no-verify', '-m', message],
            { cwd: root },
        )

    /** The `plan` job's prepare, staged as the `push` job applies it. */
    async function staged() {
        const root = workspace([KIT('0.1.0'), TOOLS('0.1.0'), APP], { feature: ['"@sssb/kit": minor'] }, { git: true })
        expect(await prepare(root, { fetchImpl: registry() })).toMatchObject({ version: '0.2.0-rc.0' })
        execFileSync('git', ['add', '-A'], { cwd: root })
        return root
    }

    /**
     * The tarballs `checks`' pack-and-consume job hands over, as `pnpm pack` lays them out: the kit's carries its
     * release stamp, naming the commit it was packed from (`stamp`, by default the checkout's HEAD; null for none).
     */
    function tarballs(root: string, version: string, names = ['kit', 'tools'], stamp?: string | null) {
        const dir = makeTestTmpDir('sssb-rc-tarballs-')
        const commit =
            stamp === undefined
                ? execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim()
                : stamp
        return names.map((n) =>
            tarball(
                dir,
                `sssb-${n}-${version}.tgz`,
                { name: `@sssb/${n}`, version, private: true },
                n === 'kit' && commit !== null ? { 'dist/release.json': `${JSON.stringify({ commit })}\n` } : {},
            ),
        )
    }

    it('plans, verifies, tags and assembles the prerelease: the flow a merge to main runs', async () => {
        const root = await staged()
        // `push`: the staged patch is exactly the candidate
        expect(() => verifyRelease(root, '0.2.0-rc.0')).not.toThrow()
        commit(root, 'chore: release v0.2.0-rc.0')
        execFileSync('git', ['tag', 'v0.2.0-rc.0'], { cwd: root })
        // the tag's `candidate` job: the release commit is the one that added the notes
        const added = execFileSync('git', ['diff', '--name-status', 'HEAD^', 'HEAD', '--', 'docs/releases'], {
            cwd: root,
            encoding: 'utf8',
        })
        expect(added).toBe('A\tdocs/releases/v0.2.0-rc.0.md\n')
        const assets = candidate(root, '0.2.0-rc.0', tarballs(root, '0.2.0-rc.0'))
        expect(assets.map((a: { name: string; file: string }) => [a.name, a.file])).toEqual([
            ['@sssb/kit', 'sssb-kit-0.2.0-rc.0.tgz'],
            ['@sssb/tools', 'sssb-tools-0.2.0-rc.0.tgz'],
        ])
        for (const a of assets) expect(a.sha512).toMatch(/^sha512-[A-Za-z0-9+/]+=*$/)
        const notes = candidateNotes(root, '0.2.0-rc.0', 'safeinsights/sssb', SHA, assets)
        expect(notes).toMatch(/^# Release notes: v0\.2\.0-rc\.0\n/)
        const url = 'https://github.com/safeinsights/sssb/releases/download/v0.2.0-rc.0/sssb-kit-0.2.0-rc.0.tgz'
        expect(notes).toContain(`overrides:\n    '@sssb/kit': ${url}\n`)
        expect(notes).toContain(`"@sssb/kit": "${url}"`)
        expect(notes).toContain(`| \`@sssb/kit\` | [\`sssb-kit-0.2.0-rc.0.tgz\`](${url}) | \`${assets[0].sha512}\` |`)
        expect(notes).toContain(`cut from \`${SHA}\``)
        expect(notes).not.toContain('package/bin/create.js')
        // the generator is listed and said how to run, never overridden or depended on
        const generator = { name: '@sssb/create', file: 'sssb-create-0.2.0-rc.0.tgz', sha512: 'sha512-AAAA' }
        const withGenerator = candidateNotes(root, '0.2.0-rc.0', 'safeinsights/sssb', SHA, [...assets, generator])
        expect(withGenerator).toContain(`overrides:\n    '@sssb/kit': ${url}\n`)
        expect(withGenerator).not.toContain(`'@sssb/create':`)
        expect(withGenerator).not.toContain(`"@sssb/create":`)
        expect(withGenerator).toContain('| `@sssb/create` | [`sssb-create-0.2.0-rc.0.tgz`]')
        expect(withGenerator).toContain(
            'tar -xzf sssb-create-0.2.0-rc.0.tgz\nnode package/bin/create.js <dir> --sssb . --repo',
        )
        // pinned to the release workflow, the candidate's tag and this commit, not just the repository
        expect(notes).toContain(
            'gh attestation verify <tarball> --repo safeinsights/sssb --signer-workflow ' +
                'safeinsights/sssb/.github/workflows/release.yml \\\n' +
                `    --source-ref refs/tags/v0.2.0-rc.0 --source-digest ${SHA}`,
        )
        // unwrapped: the install paragraph, wrapped in the source, is one line in the release body
        expect(notes).toMatch(
            /\nIn `pnpm-workspace\.yaml`, map every package to its tarball, so that .* release candidate:\n/,
        )
        // the CLI the workflow runs, with no sibling module and no node_modules
        const alone = path.join(makeTestTmpDir('sssb-release-alone-'), 'release.mjs')
        copyFileSync(SCRIPT, alone)
        const files = tarballs(root, '0.2.0-rc.0')
        const out = spawnSync(process.execPath, [alone, 'candidate', '0.2.0-rc.0', ...files], {
            cwd: root,
            encoding: 'utf8',
        })
        expect(out.stderr).toBe('')
        expect(JSON.parse(out.stdout)).toHaveLength(2)
    })

    it("refuses tarballs that are not this commit's group at this version, one each", async () => {
        const root = await staged()
        commit(root, 'chore: release v0.2.0-rc.0')
        const v = '0.2.0-rc.0'
        expect(() => candidate(root, v, tarballs(root, '0.2.0-rc.1'))).toThrow(
            /holds @sssb\/kit@0\.2\.0-rc\.1, not 0\.2\.0-rc\.0/,
        )
        expect(() => candidate(root, v, tarballs(root, v, ['kit']))).toThrow(/no tarball holds @sssb\/tools/)
        expect(() => candidate(root, v, tarballs(root, v, ['kit', 'tools', 'cdk']))).toThrow(
            /holds @sssb\/cdk, which is not in this commit's fixed group/,
        )
        const renamed = tarballs(root, v)
        const odd = path.join(path.dirname(renamed[0]!), 'kit; rm -rf.tgz')
        copyFileSync(renamed[0]!, odd)
        expect(() => candidate(root, v, [odd, renamed[1]!])).toThrow(
            /holds @sssb\/kit, so is named sssb-kit-0\.2\.0-rc\.0\.tgz/,
        )
        const twice = [...tarballs(root, v), ...tarballs(root, v, ['kit'])]
        expect(() => candidate(root, v, twice)).toThrow(/@sssb\/kit is packed twice/)
        expect(() => candidate(root, '0.2.0', tarballs(root, v))).toThrow(/not a release candidate: '0\.2\.0'/)
        // a release candidate is of the commit it tags: one whose manifests say another version is refused
        const behind = workspace([KIT('0.1.0'), TOOLS('0.1.0')], {}, { git: true })
        expect(() => candidate(behind, v, tarballs(behind, v))).toThrow(/this commit has @sssb\/kit at 0\.1\.0/)
    })

    it("refuses a kit whose release stamp is not this commit's, or that carries none", async () => {
        const root = await staged()
        commit(root, 'chore: release v0.2.0-rc.0')
        const v = '0.2.0-rc.0'
        const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim()
        expect(() => candidate(root, v, tarballs(root, v))).not.toThrow()
        expect(() => candidate(root, v, tarballs(root, v, ['kit', 'tools'], 'b'.repeat(40)))).toThrow(
            `@sssb/kit's release stamp names ${'b'.repeat(40)}, not ${head}`,
        )
        expect(() => candidate(root, v, tarballs(root, v, ['kit', 'tools'], null))).toThrow(
            `@sssb/kit's release stamp names no commit, not ${head}`,
        )
    })

    it('refuses a tarball laid out other than as one package/, before reading it', async () => {
        const root = await staged()
        commit(root, 'chore: release v0.2.0-rc.0')
        const dir = makeTestTmpDir('sssb-rc-stray-')
        const staging = path.join(dir, 'staging')
        writeJson(path.join(staging, 'pkg', 'package.json'), { name: '@sssb/kit', version: '0.2.0-rc.0' })
        execFileSync('tar', ['-czf', path.join(dir, 'odd.tgz'), '-C', staging, 'pkg'])
        expect(() => candidate(root, '0.2.0-rc.0', [path.join(dir, 'odd.tgz')])).toThrow(
            /is not laid out as one package/,
        )
    })

    it('verify-release refuses a candidate whose changesets are deleted, edited or numbered wrong', async () => {
        const deleted = await staged()
        execFileSync('git', ['rm', '-q', '--cached', '.changeset/pre/feature.md'], { cwd: deleted })
        rmSync(path.join(deleted, '.changeset/pre/feature.md'))
        expect(() => verifyRelease(deleted, '0.2.0-rc.0')).toThrow(
            /feature\.md is deleted, not moved to \.changeset\/pre\//,
        )

        const edited = await staged()
        writeFileSync(path.join(edited, '.changeset/pre/feature.md'), 'something else\n')
        execFileSync('git', ['add', '-A'], { cwd: edited })
        expect(() => verifyRelease(edited, '0.2.0-rc.0')).toThrow(/pre\/feature\.md must hold exactly what/)

        const numbered = await staged()
        expect(() => verifyRelease(numbered, '0.2.0-rc.1')).toThrow(/release 0\.2\.0-rc\.0, not 0\.2\.0-rc\.1/)
        expect(() => verifyRelease(numbered, '0.2.0')).toThrow(/not a 0\.x release candidate version: '0\.2\.0'/)

        const repo = await staged()
        execFileSync('git', ['tag', 'v0.2.0-rc.0'], { cwd: repo })
        expect(() => verifyRelease(repo, '0.2.0-rc.0')).toThrow(/the tag v0\.2\.0-rc\.0 already exists/)
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
