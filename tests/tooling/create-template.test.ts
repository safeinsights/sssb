import { execFileSync, spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { CreateError } from '../../packages/create/src/args.js'
import {
    buildTemplate,
    filesUnder,
    fromStored,
    ROOT_FILES,
    UNPUSHED_PIN_ENV,
    unpushedPin,
} from '../../packages/create/src/template.js'
import { makeTestTmpDir } from '../support/tmp-dir'

/**
 * `@sssb/create`'s template (packages/create/src/template.js, ADR-0014 P12) and the command run from a checkout, each
 * against a STAND-IN REPOSITORY: the files the template is built from, copied out of this one into a git repository of
 * their own, so a test can give it junk, a symlink, no git, or a remote-tracking branch, without touching this one.
 */
const REPO = path.resolve(__dirname, '../..')
const CREATE = path.join(REPO, 'packages/create')

/** What buildTemplate reads beside the starter and ROOT_FILES. */
const READ_FILES = [
    '.gitignore',
    'package.json',
    'pnpm-workspace.yaml',
    'pnpm-lock.yaml',
    '.github/workflows/app-checks.yml',
    '.github/workflows/checks.yml',
    'packages/kit/src/testing/seam-specifiers.json',
    'packages/kit/src/cutover/rows.json',
    'packages/kit/src/guide.md',
]

const git = (cwd: string, args: string[]) =>
    execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
const commit = (cwd: string) =>
    git(cwd, [
        ...['-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false'],
        ...['-c', 'core.hooksPath=/dev/null', 'commit', '-qm', 'x'],
    ])

/**
 * A repository holding what the template is built from (the starter's files that are not ignored, the files
 * buildTemplate reads) and packages/create, with everything committed in one commit, or no git at all.
 */
function standIn({ withGit = true } = {}) {
    const repo = makeTestTmpDir('create-standin-')
    const starter = git(REPO, ['ls-files', '--cached', '--others', '--exclude-standard', '-z', '--', 'apps/starter'])
        .split('\0')
        .filter((file) => file !== '' && existsSync(path.join(REPO, file)))
    for (const file of [...READ_FILES, ...ROOT_FILES, ...starter]) {
        mkdirSync(path.dirname(path.join(repo, file)), { recursive: true })
        cpSync(path.join(REPO, file), path.join(repo, file))
    }
    for (const part of ['bin', 'src', 'scripts', 'package.json'])
        cpSync(path.join(CREATE, part), path.join(repo, 'packages/create', part), { recursive: true })
    if (withGit) {
        git(repo, ['init', '-q', '-b', 'main'])
        git(repo, ['add', '-A'])
        commit(repo)
    }
    return repo
}

const head = (repo: string) => git(repo, ['rev-parse', 'HEAD']).trim()
const pushTo = (repo: string, remote: string) => git(repo, ['update-ref', `refs/remotes/${remote}/main`, 'HEAD'])

describe('@sssb/create: the template holds what git tracks, and only that', () => {
    it('leaves out every file git does not track, and says which', () => {
        const repo = standIn()
        // Local files nobody meant to share (not ignored: git would offer to add them), and local output (ignored).
        const unshared = ['.npmrc', 'infra/deploy-key.pem', '.vscode/settings.json', 'src/.page.tsx.swp']
        const ignored = ['node_modules/pkg/index.js', '.next/server/page.js', '.env.local', 'infra/cdk.out/x.json']
        for (const file of [...unshared, ...ignored]) {
            mkdirSync(path.dirname(path.join(repo, 'apps/starter', file)), { recursive: true })
            writeFileSync(path.join(repo, 'apps/starter', file), '//registry.npmjs.org/:_authToken=secret\n')
        }
        const warnings: string[] = []
        const out = path.join(makeTestTmpDir('create-standin-out-'), 'template')
        buildTemplate({ repoRoot: repo, outDir: out, workflowRef: 'f'.repeat(40), warn: (m) => warnings.push(m) })

        const tracked = git(repo, ['ls-files', 'apps/starter'])
            .split('\n')
            .filter(Boolean)
            .map((file) => file.slice('apps/starter/'.length))
        expect(filesUnder(path.join(out, 'app')).map(fromStored)).toEqual(tracked.sort())
        expect(tracked).toContain('src/sssb.conformance.test.ts')
        expect(filesUnder(path.join(out, 'root')).map(fromStored).sort()).toEqual([...ROOT_FILES].sort())
        expect(warnings).toHaveLength(1)
        for (const file of unshared) expect(warnings[0]).toContain(`apps/starter/${file}`)
        for (const file of ignored) expect(warnings[0]).not.toContain(file)
    })

    it('refuses a symlink, a tracked file gone from the working tree, and a checkout without git', () => {
        const build = (repo: string) => () =>
            buildTemplate({
                repoRoot: repo,
                outDir: path.join(makeTestTmpDir('create-standin-out-'), 'template'),
                workflowRef: 'f'.repeat(40),
            })

        const linked = standIn()
        symlinkSync('config/app.ts', path.join(linked, 'apps/starter/linked.ts'))
        git(linked, ['add', '-A'])
        commit(linked)
        expect(build(linked)).toThrow(CreateError)
        expect(build(linked)).toThrow(/apps\/starter\/linked\.ts is a symlink/)

        const missing = standIn()
        rmSync(path.join(missing, 'apps/starter/infra/README.md'))
        expect(build(missing)).toThrow(/apps\/starter\/infra\/README\.md is tracked but missing from the working tree/)

        expect(build(standIn({ withGit: false }))).toThrow(/is not a git checkout/)
    })
})

describe('@sssb/create: the pinned commit must be on GitHub', () => {
    it("is on GitHub when a remote-tracking branch of SSSB's GitHub remote contains it", () => {
        const repo = standIn()
        const check = () => unpushedPin({ repoRoot: repo, ref: head(repo), repository: 'safeinsights/sssb' })
        expect(check()).toMatch(/no remote of this checkout is github\.com\/safeinsights\/sssb/)
        // A fork holding the commit is not SSSB's repository.
        git(repo, ['remote', 'add', 'fork', 'https://github.com/someone/sssb.git'])
        pushTo(repo, 'fork')
        git(repo, ['remote', 'add', 'origin', 'git@github.com:safeinsights/sssb.git'])
        expect(check()).toMatch(/is on no branch of origin \(github\.com\/safeinsights\/sssb\)/)
        pushTo(repo, 'origin')
        expect(check()).toBeNull()
        // A commit after the last push is not on GitHub.
        writeFileSync(path.join(repo, 'apps/starter/new.ts'), 'export {}\n')
        git(repo, ['add', '-A'])
        commit(repo)
        expect(check()).toMatch(/is on no branch of origin/)
        expect(unpushedPin({ repoRoot: repo, ref: 'a'.repeat(40), repository: 'safeinsights/sssb' })).toMatch(
            /is not in this checkout/,
        )
    })

    it(`packing refuses an unpushed pin, unless ${UNPUSHED_PIN_ENV}=1`, () => {
        const repo = standIn()
        git(repo, ['remote', 'add', 'origin', 'https://github.com/safeinsights/sssb'])
        const script = path.join(repo, 'packages/create/scripts/build-template.js')
        const template = path.join(repo, 'packages/create/template')
        const prepack = (env: Record<string, string> = {}) =>
            spawnSync(process.execPath, [script], { encoding: 'utf8', env: { ...process.env, ...env } })

        const refused = prepack()
        expect(refused.status).toBe(1)
        expect(refused.stderr).toContain(`is on no branch of origin`)
        expect(refused.stderr).toContain(`${UNPUSHED_PIN_ENV}=1`)
        expect(existsSync(template)).toBe(false)

        const optedOut = prepack({ [UNPUSHED_PIN_ENV]: '1' })
        expect(optedOut.status).toBe(0)
        expect(optedOut.stderr).toContain(`WARNING (${UNPUSHED_PIN_ENV}=1)`)
        expect(JSON.parse(readFileSync(path.join(template, 'meta.json'), 'utf8')).workflow.ref).toBe(head(repo))
        rmSync(template, { recursive: true })

        pushTo(repo, 'origin')
        const pushed = prepack()
        expect(pushed.stderr).toBe('')
        expect(pushed.status).toBe(0)
    })
})

describe('@sssb/create: the command, run from a checkout', () => {
    const cli = (repo: string, args: string[]) => {
        const tmp = makeTestTmpDir('create-cli-tmp-')
        const result = spawnSync(process.execPath, [path.join(repo, 'packages/create/bin/create.js'), ...args], {
            encoding: 'utf8',
            env: { ...process.env, TMPDIR: tmp },
        })
        return { ...result, leftInTmp: readdirSync(tmp) }
    }
    const target = () => path.join(makeTestTmpDir('create-cli-out-'), 'acme')

    it('builds the template with --workflow-ref instead of reading the commit, and removes it however it ends', () => {
        // A checkout whose HEAD lacks the reusable workflow: no pin can be read from it, so one must be given.
        const repo = standIn()
        git(repo, ['rm', '-q', '--cached', '.github/workflows/app-checks.yml'])
        commit(repo)
        const out = target()
        const pinned = cli(repo, [out, '--workflow-ref', 'a'.repeat(40), '--yes'])
        expect(pinned.stderr).not.toMatch(/\n\s+at /)
        expect(pinned.status).toBe(0)
        expect(readFileSync(path.join(out, '.github/workflows/checks.yml'), 'utf8')).toContain(
            `app-checks.yml@${'a'.repeat(40)} `,
        )
        expect(pinned.leftInTmp).toEqual([])

        const unpinned = cli(repo, [target(), '--yes'])
        expect(unpinned.status).toBe(1)
        expect(unpinned.stderr).toMatch(
            /^@sssb\/create: commit [0-9a-f]{40} holds no \.github\/workflows\/app-checks\.yml/,
        )
        expect(unpinned.leftInTmp).toEqual([])
    })

    it('fails with a message, not a stack trace, in a checkout without git', () => {
        const result = cli(standIn({ withGit: false }), [target(), '--yes'])
        expect(result.status).toBe(1)
        expect(result.stderr).toMatch(/^@sssb\/create: .* is not a git checkout/)
        expect(result.stderr).not.toMatch(/\n\s+at /)
        expect(result.leftInTmp).toEqual([])
    })

    it('warns, loudly, when the commit it pins is not on GitHub', () => {
        const repo = standIn()
        git(repo, ['remote', 'add', 'origin', 'git@github.com:safeinsights/sssb.git'])
        const unpushed = cli(repo, [target(), '--yes'])
        expect(unpushed.status).toBe(0)
        expect(unpushed.stderr).toContain(`@sssb/create: WARNING: commit ${head(repo)} is on no branch of origin`)
        pushTo(repo, 'origin')
        const pushed = cli(repo, [target(), '--yes'])
        expect(pushed.status).toBe(0)
        expect(pushed.stderr).toBe('')
    })
})
