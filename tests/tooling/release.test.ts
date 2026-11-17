import { execFileSync, spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
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
        writeFileSync(path.join(root, '.changeset', `${id}.md`), `---\n${lines.join('\n')}\n---\n\n${id}\n`)
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

    it('fails the CLI with the reason, so the CI job goes red', () => {
        const root = workspace([KIT('0.1.0')], { breaking: ['"@sssb/kit": major'] })
        const result = spawnSync(process.execPath, [SCRIPT, 'check'], { cwd: root, encoding: 'utf8' })
        expect(result.status).toBe(1)
        expect(result.stderr).toMatch(/a major would release 1\.0\.0/)
    })
})

describe('release prepare (release-commit)', () => {
    it('releases nothing while every package is private, and consumes no changeset', async () => {
        const root = workspace([KIT('0.1.0'), APP], { feature: ['"@sssb/kit": minor'] }, { git: true })
        const result = await prepare(root, { fetchImpl: registry() })
        expect(result).toEqual({ release: false, reason: expect.stringMatching(/name only private packages/) })
        expect(existsSync(path.join(root, '.changeset', 'feature.md'))).toBe(true)
        expect(JSON.parse(readFileSync(path.join(root, 'packages/kit/package.json'), 'utf8')).version).toBe('0.1.0')
    })

    it('versions a public fixed group with Changesets and leaves the commit to the workflow', async () => {
        const root = workspace([KIT('0.1.0', false), APP], { feature: ['"@sssb/kit": minor'] }, { git: true })
        const npm = registry({ '/@sssb%2Fkit': { status: 200, body: { 'dist-tags': { latest: '0.0.0' } } } })
        const result = await prepare(root, { fetchImpl: npm })
        expect(result).toEqual({ release: true, version: '0.2.0', packages: ['@sssb/kit'] })
        expect(JSON.parse(readFileSync(path.join(root, 'packages/kit/package.json'), 'utf8')).version).toBe('0.2.0')
        expect(existsSync(path.join(root, '.changeset', 'feature.md'))).toBe(false)
        expect(readFileSync(path.join(root, 'packages/kit/CHANGELOG.md'), 'utf8')).toMatch(/## 0\.2\.0/)
    })

    it('runs no install script, though Changesets formats through `pnpm exec` after bumping a version', async () => {
        // pnpm 11 re-installs, scripts and all, before an `exec` in a workspace whose versions changed since the
        // last install, unless verify-deps-before-run is off.
        const root = workspace(
            [KIT('0.1.0', false)],
            { feature: ['"@sssb/kit": minor'] },
            { git: true, installed: true },
        )
        const npm = registry({ '/@sssb%2Fkit': { status: 200, body: { 'dist-tags': { latest: '0.0.0' } } } })
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
        const npm = registry({ '/@sssb%2Fkit': { status: 200, body: { 'dist-tags': { latest: '0.3.0' } } } })
        await expect(prepare(root, { fetchImpl: npm })).rejects.toThrow(/0\.1\.1, which is not newer than npm's latest/)
    })

    it('refuses a tree with uncommitted changes', async () => {
        const root = workspace([KIT('0.1.0', false)], {}, { git: true })
        writeFileSync(path.join(root, 'stray.txt'), 'x')
        await expect(prepare(root, { fetchImpl: registry() })).rejects.toThrow(/uncommitted changes/)
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
        const npm = registry({ '/@sssb%2Fkit': { status: 200, body: { 'dist-tags': { latest: '0.0.0' } } } })
        await prepare(root, { fetchImpl: npm })
        const run = (...args: string[]) => execFileSync('git', args, { cwd: root, stdio: 'ignore' })
        run('add', '-A')
        return { root, run }
    }

    it('accepts what prepare wrote: a deleted changeset, a changelog and a version', async () => {
        const { root } = await prepared()
        expect(() => verifyRelease(root, '0.2.0')).not.toThrow()
        expect(() => verifyRelease(root, '0.3.0')).toThrow(/set to 0\.2\.0, not 0\.3\.0/)
    })

    it('refuses anything else the patch could carry', async () => {
        const cases: [(root: string, run: (...a: string[]) => void) => void, RegExp][] = [
            [
                (root) => {
                    const file = path.join(root, 'packages/kit/package.json')
                    writeJson(file, { ...JSON.parse(readFileSync(file, 'utf8')), scripts: { postinstall: 'x' } })
                },
                /packages\/kit\/package\.json changes more than its version/,
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
        ]
        for (const [tamper, reason] of cases) {
            const { root, run } = await prepared()
            tamper(root, run)
            run('add', '-A')
            expect(() => verifyRelease(root, '0.2.0')).toThrow(reason)
        }
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
        const npm = registry({ '/@sssb%2Fkit': { status: 200, body: { 'dist-tags': { latest: '0.3.0' } } } })
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
        await expect(preflight(root, '0.2.0', SHA, [path.join(root, 'odd.tgz')], registry())).rejects.toThrow(
            /not laid out as one package\//,
        )
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
