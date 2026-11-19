import { spawnSync } from 'node:child_process'
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { DEMO_ASSET, demo, releaseNotes } from '../../scripts/release.mjs'
import { installFakeGh, runStep, workflowStep } from '../support/fake-gh-release'
import { makeTestTmpDir } from '../support/tmp-dir'

/**
 * A plain release's GitHub page (adoption follow-up 4): release.yml's `demo` job runs `release.mjs demo` on the
 * showcase's static demo that `checks` built and tested on the release commit, then `release-notes`, whose output is
 * the page's body. Each fixture is a release commit's checkout reduced to what the two read.
 */
const SCRIPTS = fileURLToPath(new URL('../../scripts/', import.meta.url))
const SHA = 'a'.repeat(40)
const VERSION = '0.3.0'
const HTML = '<!doctype html>\n<html><title>showcase</title></html>\n'

function checkout({ budget = 1000, notes = `# Release notes: v${VERSION}\n\nOne change.\n` } = {}) {
    const root = makeTestTmpDir('sssb-release-demo-')
    mkdirSync(path.join(root, 'apps/showcase'), { recursive: true })
    writeFileSync(
        path.join(root, 'apps/showcase/package.json'),
        JSON.stringify({ scripts: { 'check:demo-size': `sssb check-demo-size ${budget}` } }),
    )
    mkdirSync(path.join(root, 'docs/releases'), { recursive: true })
    writeFileSync(path.join(root, `docs/releases/v${VERSION}.md`), notes)
    return root
}

function built(root: string, body = HTML, name = DEMO_ASSET) {
    const file = path.join(root, 'out', name)
    mkdirSync(path.dirname(file), { recursive: true })
    writeFileSync(file, body)
    return file
}

describe('release demo (the showcase demo a release page attaches)', () => {
    it("accepts the built demo under the README's asset name, and says its size and sha256", () => {
        const root = checkout()
        expect(DEMO_ASSET).toBe('sssb-showcase.html')
        expect(demo(root, VERSION, built(root))).toEqual({
            file: 'sssb-showcase.html',
            size: Buffer.byteLength(HTML),
            sha256: expect.stringMatching(/^[0-9a-f]{64}$/),
        })
        // vite may upper-case the doctype
        expect(() => demo(root, VERSION, built(root, HTML.toUpperCase()))).not.toThrow()
    })

    it("refuses what is not that file: another name, an empty file, not HTML, or over the showcase's budget", () => {
        const root = checkout({ budget: 60 })
        expect(() => demo(root, VERSION, built(root, HTML, 'index.html'))).toThrow(/is not named sssb-showcase\.html/)
        expect(() => demo(root, VERSION, built(root, ''))).toThrow(/is empty/)
        expect(() => demo(root, VERSION, built(root, '{"not":"html"}'))).toThrow(/does not start with <!doctype html>/)
        expect(() => demo(root, VERSION, built(root, HTML + 'x'.repeat(60)))).toThrow(/over the 60 byte budget/)
    })

    it('refuses a candidate, a 1.0, and a showcase with no size budget to hold it to', () => {
        const root = checkout()
        expect(() => demo(root, '0.3.0-rc.0', built(root))).toThrow(/not a 0\.x release/)
        expect(() => demo(root, '1.0.0', built(root))).toThrow(/not a 0\.x release/)
        writeFileSync(path.join(root, 'apps/showcase/package.json'), JSON.stringify({ scripts: {} }))
        expect(() => demo(root, VERSION, built(root))).toThrow(/has no `sssb check-demo-size <bytes>` script/)
    })
})

describe('release release-notes (the release page body)', () => {
    const asset = { file: DEMO_ASSET, size: 10, sha256: 'b'.repeat(64) }

    it("is the commit's notes, the upgrade section naming this commit, then the demo by its release URL", () => {
        const notes = releaseNotes(checkout(), VERSION, 'safeinsights/sssb', SHA, asset)
        expect(notes).toMatch(/^# Release notes: v0\.3\.0\n/)
        expect(notes.match(/^## Upgrading to this release$/gm)).toHaveLength(1)
        expect(notes).toContain(`"ref": "${SHA}"`)
        expect(notes).not.toContain('<sha>')
        expect(notes).toContain(
            '[`sssb-showcase.html`](https://github.com/safeinsights/sssb/releases/download/v0.3.0/sssb-showcase.html)',
        )
        expect(notes).toContain(`sha256: \`${'b'.repeat(64)}\``)
        // a plain release is on npm: no tarballs to attach, no install-by-URL
        expect(notes).not.toMatch(/\.tgz|Installing this release candidate/)
        expect(notes.indexOf('## Try the showcase')).toBeGreaterThan(notes.indexOf('One change.'))
    })

    it("refuses another release's notes, a candidate, a bad commit or repository, and another asset", () => {
        const root = checkout({ notes: '# Release notes: v0.2.0\n' })
        expect(() => releaseNotes(root, VERSION, 'safeinsights/sssb', SHA, asset)).toThrow(/is not the release notes/)
        const ok = checkout()
        expect(() => releaseNotes(ok, '0.3.0-rc.0', 'safeinsights/sssb', SHA, asset)).toThrow(/not a 0\.x release/)
        expect(() => releaseNotes(ok, VERSION, 'safeinsights/sssb', 'HEAD', asset)).toThrow(/not a commit/)
        expect(() => releaseNotes(ok, VERSION, 'not a repo', SHA, asset)).toThrow(/not a repository/)
        expect(() => releaseNotes(ok, VERSION, 'safeinsights/sssb', SHA, { ...asset, file: 'x.html' })).toThrow(
            /not the demo's asset/,
        )
    })

    it('runs as the demo job runs it, from the command line, printing JSON then markdown', () => {
        const root = checkout()
        mkdirSync(path.join(root, 'scripts'))
        for (const f of ['release.mjs', 'release-notes.mjs'])
            copyFileSync(path.join(SCRIPTS, f), path.join(root, 'scripts', f))
        const file = built(root)
        const cli = (...args: string[]) =>
            spawnSync(process.execPath, ['scripts/release.mjs', ...args], { cwd: root, encoding: 'utf8' })
        const checked = cli('demo', VERSION, file)
        expect(checked.stderr).toBe('')
        expect(checked.status).toBe(0)
        writeFileSync(path.join(root, 'demo.json'), checked.stdout)
        const notes = cli('release-notes', VERSION, 'safeinsights/sssb', SHA, path.join(root, 'demo.json'))
        expect(notes.status).toBe(0)
        expect(notes.stdout).toContain('## Try the showcase')
        expect(readFileSync(file, 'utf8')).toBe(HTML)
        expect(cli('demo', VERSION).status).toBe(1)
    })
})

describe("release.yml's demo job, then its github-release job, as the tag's run hands one to the other", () => {
    it('checks the demo checks built, writes the notes for this commit, and the page publishes exactly that file', () => {
        const root = checkout({ budget: 100_000 })
        mkdirSync(path.join(root, 'scripts'))
        for (const f of ['release.mjs', 'release-notes.mjs']) {
            copyFileSync(path.join(SCRIPTS, f), path.join(root, 'scripts', f))
        }
        const temp = makeTestTmpDir('sssb-release-page-')
        mkdirSync(path.join(temp, 'built'))
        writeFileSync(path.join(temp, 'built', 'index.html'), HTML)
        installFakeGh(temp)
        const state = { tags: [`v${VERSION}`], release: null, calls: [] }

        const demoStep = workflowStep('demo', 'check the demo and write the release notes')
        const checked = runStep(temp, demoStep, state, VERSION, { cwd: root, env: { GITHUB_SHA: SHA } })
        expect(checked.stderr).toBe('')
        expect(checked.status).toBe(0)
        const notes = readFileSync(path.join(temp, 'release-page', 'notes.md'), 'utf8')
        expect(notes).toContain(`"ref": "${SHA}"`)
        expect(notes).toContain('releases/download/v0.3.0/sssb-showcase.html')
        expect(readFileSync(path.join(temp, 'summary.md'), 'utf8')).toBe(notes)

        // `release-page` is uploaded from and downloaded to the same path under the runner's temp directory
        const page = runStep(temp, workflowStep('github-release', 'publish the release page'), state, VERSION)
        expect(page.stderr).toBe('')
        expect(page.status).toBe(0)
        expect(page.state.release).toMatchObject({ draft: false, prerelease: false, latest: true, notes })
        expect(readFileSync(page.state.release!.assets[DEMO_ASSET]!, 'utf8')).toBe(HTML)
    })

    it('stops before writing any notes when the demo checks built is over budget', () => {
        const root = checkout({ budget: 10 })
        mkdirSync(path.join(root, 'scripts'))
        for (const f of ['release.mjs', 'release-notes.mjs']) {
            copyFileSync(path.join(SCRIPTS, f), path.join(root, 'scripts', f))
        }
        const temp = makeTestTmpDir('sssb-release-page-')
        mkdirSync(path.join(temp, 'built'))
        writeFileSync(path.join(temp, 'built', 'index.html'), HTML)
        const state = { tags: [`v${VERSION}`], release: null, calls: [] }
        const demoStep = workflowStep('demo', 'check the demo and write the release notes')
        const checked = runStep(temp, demoStep, state, VERSION, { cwd: root, env: { GITHUB_SHA: SHA } })
        expect(checked.status).toBe(1)
        expect(checked.stderr).toMatch(/over the 10 byte budget/)
        expect(() => readFileSync(path.join(temp, 'release-page', 'notes.md'))).toThrow()
    })
})
