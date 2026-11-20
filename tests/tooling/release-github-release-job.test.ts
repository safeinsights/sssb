import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { existingRelease, installFakeGh, runStep, type State, workflowStep } from '../support/fake-gh-release'
import { makeTestTmpDir } from '../support/tmp-dir'

/**
 * release.yml's `github-release` job (adoption follow-up 4), the one step that writes on a plain release's tag, run as
 * GitHub runs it against a fake `gh` that keeps the release's state in a file. What it must never do is report success
 * without a published, non-prerelease release holding exactly the demo `demo` checked under the README's asset name,
 * or change a release already published. The script is read from the workflow, so an edit there is what is tested.
 */
const VERSION = '0.3.0'
const TAG = `v${VERSION}`
const DEMO = 'sssb-showcase.html'
const BODY = '<!doctype html><title>showcase</title>'

const script = () => workflowStep('github-release', 'publish the release page')
const run = (temp: string, state: State, version = VERSION) => runStep(temp, script(), state, version)
const sha256 = (body: string) => createHash('sha256').update(body).digest('hex')

/** A runner's temp directory holding what `demo` uploads: the demo, its demo.json and the notes. */
function runner(body = BODY, named = DEMO) {
    const temp = makeTestTmpDir('sssb-github-release-')
    const dir = path.join(temp, 'release-page')
    mkdirSync(dir, { recursive: true })
    writeFileSync(path.join(dir, DEMO), body)
    writeFileSync(
        path.join(dir, 'demo.json'),
        JSON.stringify({ file: named, size: Buffer.byteLength(body), sha256: sha256(body) }),
    )
    writeFileSync(path.join(dir, 'notes.md'), `# Release notes: ${TAG}\n`)
    installFakeGh(temp)
    return { temp, dir }
}

const existing = (temp: string, files: Record<string, string>, draft: boolean) =>
    existingRelease(temp, files, { draft, prerelease: false })
const fresh = (): State => ({ tags: [TAG], release: null, calls: [] })
const writes = (state: State) => state.calls.filter((c) => /^release (create|upload|edit)/.test(c))

describe("release.yml's github-release job", () => {
    it('creates a draft, attaches the demo, checks it byte for byte, then publishes the latest release', () => {
        const { temp } = runner()
        const { status, stderr, state } = run(temp, fresh())
        expect(stderr).toBe('')
        expect(status).toBe(0)
        expect(state.release).toMatchObject({ draft: false, prerelease: false, latest: true, title: TAG })
        expect(Object.keys(state.release!.assets)).toEqual([DEMO])
        expect(readFileSync(state.release!.assets[DEMO]!, 'utf8')).toBe(BODY)
        const create = state.calls.findIndex((c) => c.startsWith('release create'))
        const check = state.calls.findIndex((c) => c.startsWith('release download'))
        const publish = state.calls.findIndex((c) => c.startsWith('release edit'))
        expect(state.calls[create]).toMatch(/--verify-tag --draft --title v0\.3\.0/)
        expect(state.calls[create]).not.toMatch(/--prerelease/)
        expect(create < check && check < publish).toBe(true)
        expect(readFileSync(path.join(temp, 'summary.md'), 'utf8')).toMatch(/Released v0\.3\.0 on GitHub/)
    })

    it('confirms a published release holding exactly this demo, and changes nothing', () => {
        const { temp } = runner()
        const { status, state } = run(temp, { ...fresh(), release: existing(temp, { [DEMO]: BODY }, false) })
        expect(status).toBe(0)
        expect(writes(state)).toEqual([])
    })

    it('fails, and changes nothing, when a published release holds another demo or another file', () => {
        const cases: Record<string, string>[] = [{ [DEMO]: 'other' }, { [DEMO]: BODY, 'extra.tgz': 'x' }]
        for (const files of cases) {
            const { temp } = runner()
            const { status, stdout, state } = run(temp, { ...fresh(), release: existing(temp, files, false) })
            expect(status).toBe(1)
            expect(stdout).toMatch(/::error::v0\.3\.0 holds other files than the demo/)
            expect(writes(state)).toEqual([])
        }
    })

    it('finishes a draft a failed run left part-way, replacing a demo it left half-written', () => {
        const { temp } = runner()
        const { status, state } = run(temp, { ...fresh(), release: existing(temp, { [DEMO]: '<!doc' }, true) })
        expect(status).toBe(0)
        expect(state.calls.filter((c) => c.startsWith('release upload'))).toEqual([
            expect.stringMatching(/--clobber .*sssb-showcase\.html$/),
        ])
        expect(readFileSync(state.release!.assets[DEMO]!, 'utf8')).toBe(BODY)
        expect(state.release).toMatchObject({ draft: false, prerelease: false, latest: true })
    })

    it("publishes its own title and notes, never a draft's someone else wrote", () => {
        const { temp } = runner()
        const release = { ...existing(temp, {}, true), title: 'mine', notes: 'something else' }
        const { status, state } = run(temp, { ...fresh(), release })
        expect(status).toBe(0)
        expect(state.release).toMatchObject({ draft: false, title: TAG, notes: `# Release notes: ${TAG}\n` })
    })

    it('leaves a draft unpublished when it holds a stray file, and fails', () => {
        const { temp } = runner()
        const { status, stdout, state } = run(temp, {
            ...fresh(),
            release: existing(temp, { [DEMO]: BODY, 'extra.tgz': 'x' }, true),
        })
        expect(status).toBe(1)
        expect(stdout).toMatch(/::error::v0\.3\.0 holds other files than the demo/)
        expect(state.release!.draft).toBe(true)
    })

    it('stops, creating nothing, when the release cannot be read for any reason but "not found"', () => {
        const { temp } = runner()
        const { status, stdout, stderr, state } = run(temp, { ...fresh(), viewError: 'HTTP 502: Bad Gateway' })
        expect(status).toBe(1)
        expect(stderr).toMatch(/HTTP 502/)
        expect(stdout).toMatch(/::error::could not read v0\.3\.0's release/)
        expect(state.calls.filter((c) => !c.startsWith('release view'))).toEqual([])
    })

    it('stops before touching any release when the demo is not the one demo checked, or not the README’s name', () => {
        const tampered = runner()
        writeFileSync(path.join(tampered.dir, DEMO), 'tampered')
        const a = run(tampered.temp, fresh())
        expect(a.status).toBe(1)
        expect(a.stdout).toMatch(/the demo is not the one demo checked/)
        expect(a.state.calls).toEqual([])

        const renamed = runner(BODY, 'index.html')
        const b = run(renamed.temp, fresh())
        expect(b.status).toBe(1)
        expect(b.stdout).toMatch(/demo\.json does not name sssb-showcase\.html/)
        expect(b.state.calls).toEqual([])
    })

    it('leaves Latest alone when a higher plain release is tagged, and ignores a higher candidate', () => {
        const older = runner()
        const behind = run(older.temp, { ...fresh(), tags: [TAG, 'v0.3.1', 'v0.10.0-rc.0'] })
        expect(behind.status).toBe(0)
        expect(behind.state.release).toMatchObject({ draft: false, prerelease: false, latest: false })
        const newest = runner()
        // numerically, not as text: 0.3.0 is above 0.2.10, and a candidate's tag is not a release
        const ahead = run(newest.temp, { ...fresh(), tags: ['v0.2.10', TAG, 'v0.3.1-rc.0'] })
        expect(ahead.status).toBe(0)
        expect(ahead.state.release).toMatchObject({ latest: true })
    })

    it('publishes a draft that was made a prerelease as a plain release, and refuses a published prerelease', () => {
        const { temp } = runner()
        const draft = { ...existingRelease(temp, {}, { draft: true, prerelease: true }) }
        const fixed = run(temp, { ...fresh(), release: draft })
        expect(fixed.status).toBe(0)
        expect(fixed.state.release).toMatchObject({ draft: false, prerelease: false, latest: true })

        const other = runner()
        const published = existingRelease(other.temp, { [DEMO]: BODY }, { draft: false, prerelease: true })
        const refused = run(other.temp, { ...fresh(), release: published })
        expect(refused.status).toBe(1)
        expect(refused.stdout).toMatch(/::error::v0\.3\.0 is not a published release \(false true\)/)
        expect(writes(refused.state)).toEqual([])
    })

    it("refuses a candidate's version, and a tag that does not exist", () => {
        const { temp } = runner()
        const candidate = run(temp, fresh(), '0.3.0-rc.0')
        expect(candidate.status).toBe(1)
        expect(candidate.stdout).toMatch(/not a 0\.x release: '0\.3\.0-rc\.0'/)
        expect(candidate.state.calls).toEqual([])
        const untagged = run(temp, { ...fresh(), tags: [] })
        expect(untagged.status).toBe(1)
        expect(untagged.stderr).toMatch(/tag v0\.3\.0 does not exist/)
        expect(untagged.state.release).toBeNull()
    })
})
