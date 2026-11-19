import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { existingRelease, installFakeGh, runStep, type State, workflowStep } from '../support/fake-gh-release'
import { makeTestTmpDir } from '../support/tmp-dir'

/**
 * release.yml's `prerelease` job (ADR-0014 P7), the one step that writes on a release candidate's tag, run as GitHub runs
 * it (`bash --noprofile --norc -eo pipefail`) against a fake `gh` that keeps the release's state in a file. What it must
 * never do is report success without a published prerelease holding exactly the tarballs `candidate` checked, or change
 * a candidate already published. The script is read from the workflow, so an edit there is what is tested.
 */
const VERSION = '0.2.0-rc.0'
const TAG = `v${VERSION}`

const script = () => workflowStep('prerelease', 'publish the prerelease')

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
    installFakeGh(temp)
    return { temp, tarballs }
}

const run = (temp: string, state: State, version = VERSION) => runStep(temp, script(), state, version)

/** A candidate's release already holding these files (name → contents), as a draft or published. */
const existing = (temp: string, files: Record<string, string>, draft: boolean) =>
    existingRelease(temp, files, { draft, prerelease: true })

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

    it('finishes a draft a failed run left part-way, replacing a tarball it left half-written', () => {
        const { temp } = runner()
        const release = existing(temp, { 'sssb-kit-0.2.0-rc.0.tgz': 'ki' }, true)
        const { status, state } = run(temp, { ...fresh(), release })
        expect(status).toBe(0)
        expect(state.calls.filter((c) => c.startsWith('release upload'))).toEqual([
            expect.stringMatching(/--clobber .*sssb-kit-0\.2\.0-rc\.0\.tgz$/),
            expect.stringMatching(/--clobber .*sssb-tools-0\.2\.0-rc\.0\.tgz$/),
        ])
        expect(readFileSync(state.release!.assets['sssb-kit-0.2.0-rc.0.tgz']!, 'utf8')).toBe('kit')
        expect(state.release).toMatchObject({ draft: false, prerelease: true })
    })

    it("publishes its own title and notes, never a draft's someone else wrote", () => {
        const { temp } = runner()
        const release = { ...existing(temp, {}, true), title: 'mine', notes: 'install from elsewhere' }
        const { status, state } = run(temp, { ...fresh(), release })
        expect(status).toBe(0)
        expect(state.release).toMatchObject({ draft: false, title: TAG, notes: `# Release notes: ${TAG}\n` })
    })

    it('stops, creating nothing, when the release cannot be read for any reason but "not found"', () => {
        const { temp } = runner()
        const { status, stdout, stderr, state } = run(temp, { ...fresh(), viewError: 'HTTP 502: Bad Gateway' })
        expect(status).toBe(1)
        expect(stderr).toMatch(/HTTP 502/)
        expect(stdout).toMatch(/::error::could not read v0\.2\.0-rc\.0's release/)
        expect(state.calls.filter((c) => !c.startsWith('release view'))).toEqual([])
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
