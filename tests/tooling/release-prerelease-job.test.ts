import { spawnSync } from 'node:child_process'
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { parse } from 'yaml'
import { makeTestTmpDir } from '../support/tmp-dir'

/**
 * release.yml's `prerelease` job (ADR-0014 P7), the one step that writes on a release candidate's tag, run as GitHub runs
 * it (`bash --noprofile --norc -eo pipefail`) against a fake `gh` that keeps the release's state in a file. What it must
 * never do is report success without a published prerelease holding exactly the tarballs `candidate` checked, or change
 * a candidate already published. The script is read from the workflow, so an edit there is what is tested.
 */
const WORKFLOW = fileURLToPath(new URL('../../.github/workflows/release.yml', import.meta.url))
const VERSION = '0.2.0-rc.0'
const TAG = `v${VERSION}`

type Release = { draft: boolean; prerelease: boolean; latest: boolean | null; assets: Record<string, string> }
type State = { tags: string[]; release: Release | null; calls: string[] }

function script(): string {
    const workflow = parse(readFileSync(WORKFLOW, 'utf8')) as {
        jobs: Record<string, { steps: { name?: string; run?: string }[] }>
    }
    const step = workflow.jobs['prerelease']?.steps.find((s) => s.name === 'publish the prerelease')
    if (!step?.run) throw new Error('release.yml has no `publish the prerelease` step in its prerelease job')
    return step.run
}

/**
 * A `gh` that answers only the calls the job makes, from a state file, and fails on anything else. `--jq` is handed to
 * the real jq with `-r`, as gh prints strings raw.
 */
const FAKE_GH = `#!/usr/bin/env node
const { execFileSync } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')
const file = process.env.FAKE_GH_STATE
const state = JSON.parse(fs.readFileSync(file, 'utf8'))
const args = process.argv.slice(2)
state.calls.push(args.join(' '))
const save = () => fs.writeFileSync(file, JSON.stringify(state))
const opt = (name) => { const i = args.indexOf(name); return i < 0 ? undefined : args[i + 1] }
const die = (msg) => { save(); process.stderr.write(msg + '\\n'); process.exit(1) }
if (args[0] !== 'release') die('unexpected gh ' + args.join(' '))
const [, cmd, tag] = args
if (opt('--repo') !== 'safeinsights/sssb') die('wrong repo')
const r = state.release
const dir = process.env.FAKE_GH_ASSETS
if (cmd === 'view') {
  if (!r) die('release not found')
  const all = { isDraft: r.draft, isPrerelease: r.prerelease, tagName: tag, assets: Object.keys(r.assets).map((name) => ({ name })) }
  const fields = opt('--json').split(',')
  const out = JSON.stringify(Object.fromEntries(fields.map((f) => [f, all[f]])))
  const jq = opt('--jq')
  process.stdout.write(jq ? execFileSync('jq', ['-r', jq], { input: out, encoding: 'utf8' }) : out + '\\n')
} else if (cmd === 'create') {
  if (r) die('a release for ' + tag + ' exists')
  if (!state.tags.includes(tag)) die('tag ' + tag + ' does not exist')
  state.release = { draft: args.includes('--draft'), prerelease: args.includes('--prerelease'), latest: null, assets: {} }
} else if (cmd === 'upload') {
  if (!r) die('release not found')
  for (const f of args.slice(3).filter((a) => !a.startsWith('--') && a !== opt('--repo'))) {
    const name = path.basename(f)
    if (r.assets[name]) die('asset ' + name + ' exists')
    fs.mkdirSync(dir, { recursive: true })
    fs.copyFileSync(f, path.join(dir, name))
    r.assets[name] = path.join(dir, name)
  }
} else if (cmd === 'download') {
  if (!r) die('release not found')
  const to = opt('--dir')
  fs.mkdirSync(to, { recursive: true })
  for (const [name, from] of Object.entries(r.assets)) fs.copyFileSync(from, path.join(to, name))
} else if (cmd === 'edit') {
  if (!r) die('release not found')
  if (args.includes('--draft=false')) r.draft = false
  if (args.includes('--prerelease')) r.prerelease = true
  if (args.includes('--latest=false')) r.latest = false
} else die('unexpected gh release ' + cmd)
save()
`

/** A runner's temp directory holding what `candidate` uploads: the tarballs, their assets.json and the notes. */
function runner(
    files: Record<string, string> = { 'sssb-kit-0.2.0-rc.0.tgz': 'kit', 'sssb-tools-0.2.0-rc.0.tgz': 'tools' },
) {
    const temp = makeTestTmpDir('sssb-prerelease-')
    const tarballs = path.join(temp, 'candidate', 'tarballs')
    mkdirSync(tarballs, { recursive: true })
    const assets = Object.entries(files).map(([file, body]) => {
        writeFileSync(path.join(tarballs, file), body)
        return { name: `@sssb/${file.split('-')[1]}`, file, sha256: createHash('sha256').update(body).digest('hex') }
    })
    writeFileSync(path.join(temp, 'candidate', 'assets.json'), JSON.stringify(assets))
    writeFileSync(path.join(temp, 'candidate', 'notes.md'), `# Release notes: ${TAG}\n`)
    const bin = path.join(temp, 'bin')
    mkdirSync(bin)
    writeFileSync(path.join(bin, 'gh'), FAKE_GH)
    chmodSync(path.join(bin, 'gh'), 0o755)
    return { temp, tarballs }
}

function run(temp: string, state: State, version = VERSION) {
    const stateFile = path.join(temp, 'gh-state.json')
    writeFileSync(stateFile, JSON.stringify(state))
    const result = spawnSync('bash', ['--noprofile', '--norc', '-eo', 'pipefail', '-c', script()], {
        encoding: 'utf8',
        env: {
            NODE_ENV: 'test',
            PATH: `${path.join(temp, 'bin')}:${process.env.PATH}`,
            RUNNER_TEMP: temp,
            GITHUB_REPOSITORY: 'safeinsights/sssb',
            GITHUB_STEP_SUMMARY: path.join(temp, 'summary.md'),
            GH_TOKEN: 'fake',
            VERSION: version,
            FAKE_GH_STATE: stateFile,
            FAKE_GH_ASSETS: path.join(temp, 'release-assets'),
        },
    })
    return { ...result, state: JSON.parse(readFileSync(stateFile, 'utf8')) as State }
}

/** A release already holding these files (name → contents), as a draft or published. */
function existing(temp: string, files: Record<string, string>, draft: boolean): Release {
    const dir = path.join(temp, 'release-assets')
    mkdirSync(dir, { recursive: true })
    for (const [name, body] of Object.entries(files)) writeFileSync(path.join(dir, name), body)
    return {
        draft,
        prerelease: true,
        latest: draft ? null : false,
        assets: Object.fromEntries(Object.keys(files).map((n) => [n, path.join(dir, n)])),
    }
}

const fresh = (): State => ({ tags: [TAG], release: null, calls: [] })

describe("release.yml's prerelease job", () => {
    it('creates a draft, attaches every tarball, checks them byte for byte, then publishes a prerelease never latest', () => {
        const { temp } = runner()
        const { status, stderr, state } = run(temp, fresh())
        expect(stderr).toBe('')
        expect(status).toBe(0)
        expect(state.release).toMatchObject({ draft: false, prerelease: true, latest: false })
        expect(Object.keys(state.release!.assets).sort()).toEqual([
            'sssb-kit-0.2.0-rc.0.tgz',
            'sssb-tools-0.2.0-rc.0.tgz',
        ])
        // created as a draft, published only after the download was checked
        const create = state.calls.findIndex((c) => c.startsWith('release create'))
        const check = state.calls.findIndex((c) => c.startsWith('release download'))
        const publish = state.calls.findIndex((c) => c.startsWith('release edit'))
        expect(state.calls[create]).toMatch(/--verify-tag --draft --prerelease/)
        expect(create < check && check < publish).toBe(true)
        expect(readFileSync(path.join(temp, 'summary.md'), 'utf8')).toMatch(
            /Released v0\.2\.0-rc\.0 as a GitHub prerelease/,
        )
    })

    it('confirms a published candidate holding exactly these tarballs, and changes nothing', () => {
        const { temp } = runner()
        const release = existing(
            temp,
            { 'sssb-kit-0.2.0-rc.0.tgz': 'kit', 'sssb-tools-0.2.0-rc.0.tgz': 'tools' },
            false,
        )
        const { status, state } = run(temp, { ...fresh(), release })
        expect(status).toBe(0)
        expect(state.calls.filter((c) => /^release (create|upload|edit)/.test(c))).toEqual([])
    })

    it('fails, and changes nothing, when a published candidate holds other bytes', () => {
        const { temp } = runner()
        const release = existing(
            temp,
            { 'sssb-kit-0.2.0-rc.0.tgz': 'other', 'sssb-tools-0.2.0-rc.0.tgz': 'tools' },
            false,
        )
        const { status, stdout, state } = run(temp, { ...fresh(), release })
        expect(status).toBe(1)
        expect(stdout).toMatch(/::error::v0\.2\.0-rc\.0 holds other files than this candidate's tarballs/)
        expect(state.calls.filter((c) => /^release (create|upload|edit)/.test(c))).toEqual([])
    })

    it('finishes a draft a failed run left part-way, uploading only what is missing', () => {
        const { temp } = runner()
        const release = existing(temp, { 'sssb-kit-0.2.0-rc.0.tgz': 'kit' }, true)
        const { status, state } = run(temp, { ...fresh(), release })
        expect(status).toBe(0)
        expect(state.calls.filter((c) => c.startsWith('release upload'))).toEqual([
            expect.stringMatching(/sssb-tools-0\.2\.0-rc\.0\.tgz$/),
        ])
        expect(state.release).toMatchObject({ draft: false, prerelease: true })
    })

    it('leaves a draft unpublished when it holds a stray file, and fails', () => {
        const { temp } = runner()
        const stray = { 'sssb-kit-0.2.0-rc.0.tgz': 'kit', 'sssb-tools-0.2.0-rc.0.tgz': 'tools', 'extra.tgz': 'x' }
        const { status, state } = run(temp, { ...fresh(), release: existing(temp, stray, true) })
        expect(status).toBe(1)
        expect(state.release!.draft).toBe(true)
    })

    it('stops before touching any release when the tarballs are not the ones candidate checked', () => {
        const { temp, tarballs } = runner()
        writeFileSync(path.join(tarballs, 'sssb-kit-0.2.0-rc.0.tgz'), 'tampered')
        const { status, stdout, state } = run(temp, fresh())
        expect(status).toBe(1)
        expect(stdout).toMatch(/the tarballs are not the ones candidate checked/)
        expect(state.calls).toEqual([])
    })

    it('refuses anything but a release candidate, and a tag that does not exist', () => {
        const { temp } = runner()
        const plain = run(temp, fresh(), '0.2.0')
        expect(plain.status).toBe(1)
        expect(plain.stdout).toMatch(/not a release candidate: '0\.2\.0'/)
        expect(plain.state.calls).toEqual([])
        const untagged = run(temp, { ...fresh(), tags: [] })
        expect(untagged.status).toBe(1)
        expect(untagged.state.release).toBeNull()
    })

    it('reads the step it tests from the workflow, so this file cannot drift from it', () => {
        expect(script()).toMatch(/gh release create "\$tag" --repo "\$repo" --verify-tag --draft --prerelease/)
    })
})
