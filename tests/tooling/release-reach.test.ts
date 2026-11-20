import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { parse } from 'yaml'

/**
 * WHAT CAN REACH NPM (ADR-0014 P14). From P14 the fixed group is public, so a plain `vX.Y.Z` tag publishes it. This
 * reads every workflow in the repository and holds the one path there is: a push to `main` runs release.yml's `plan`
 * (after `checks` passes on that merge commit) and `push` (in the `release` environment, the only holder of the
 * release app's key), which tags the release commit; that tag's run is `pack` (after `checks` passes on the release
 * commit, and only for a plain tag on `main`) and then `publish`, the only job that holds an id-token in the
 * `npm-publish` environment, which npm's trusted publisher names. Nothing else runs `npm publish` except as a dry run,
 * and nothing that runs on a pull request or on another branch holds an id-token, an environment or a secret.
 *
 * What this cannot read are the settings that carry the same path on GitHub and npm (release.yml's header lists
 * what they must be): `release` admits `main` only, `npm-publish` admits `v*` tags only, a tag ruleset lets only the
 * release app create `v*`, and each package's trusted publisher names this repository, `release.yml` and `npm-publish`.
 */
const WORKFLOWS = fileURLToPath(new URL('../../.github/workflows/', import.meta.url))
// A failure swallowed (`|| true`, `|| :`, `|| exit 0`, `|| echo …`), or errors turned off (`set +e`). `:` is not a word
// character, so it cannot end in `\b` as the others do (that version never saw `|| :` at the end of a line, or before a
// space or a `;`): it is `:` not followed by what would make it part of a longer word.
const SWALLOWED_FAILURE = /\|\|\s*(?:(?:true|exit\s+0|echo)\b|:(?![\w-]))|\bset\s+\+e\b/

type Step = { name?: string; run?: string; uses?: string; with?: Record<string, unknown> }
type Job = {
    if?: string
    needs?: string | string[]
    environment?: string | { name: string }
    permissions?: Record<string, string>
    steps?: Step[]
    uses?: string
}
type Workflow = { on: Record<string, unknown>; permissions?: unknown; jobs: Record<string, Job> }

const read = (file: string) => parse(readFileSync(path.join(WORKFLOWS, file), 'utf8')) as Workflow
const files = readdirSync(WORKFLOWS).filter((f) => /\.ya?ml$/.test(f))
const release = read('release.yml')
const runs = (job: Job) => (job.steps ?? []).map((s) => s.run ?? '').join('\n')
const environment = (job: Job) => (typeof job.environment === 'string' ? job.environment : job.environment?.name)
/** Every line of a script that runs a publish command, continuation lines joined. */
const publishCommands = (script: string) =>
    script
        .replace(/\\\n\s*/g, ' ')
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => /\b(npm|pnpm|yarn)\b.*\bpublish\b|changeset\s+publish/.test(line) && !/^\s*#/.test(line))

describe('the one way onto npm', () => {
    it('release.yml starts only on a push to main or a release tag: never on a PR, another branch, or by hand', () => {
        expect(Object.keys(release.on)).toEqual(['push'])
        expect(release.on.push).toEqual({
            branches: ['main'],
            tags: ['v[0-9]+.[0-9]+.[0-9]+', 'v[0-9]+.[0-9]+.[0-9]+-rc.[0-9]+'],
        })
        expect(release.permissions).toEqual({})
    })

    it('publishes from one job, which needs the pack of a plain tag on main that waited for checks', () => {
        const { pack, publish } = release.jobs
        expect(publish.needs).toBe('pack')
        expect(publish.if).toBe("needs.pack.outputs.count != '0'")
        expect(environment(publish)).toBe('npm-publish')
        expect(publish.permissions).toEqual({ contents: 'read', 'id-token': 'write' })
        expect(publishCommands(runs(publish))).toEqual([
            'npx --yes npm@11.21.2 publish "$file" --access public --provenance',
        ])
        expect(runs(publish)).toMatch(/release\.mjs preflight "\$VERSION" "\$GITHUB_SHA"/)

        // a release's tag, never a candidate's, never a branch
        expect(pack.if).toBe("startsWith(github.ref, 'refs/tags/v') && !contains(github.ref_name, '-')")
        const script = runs(pack)
        const order = [
            /\^v\(0\|\[1-9\]\[0-9\]\*\)\\\.\(0\|\[1-9\]\[0-9\]\*\)\\\.\(0\|\[1-9\]\[0-9\]\*\)\$/, // a plain tag
            /git merge-base --is-ancestor "\$GITHUB_SHA" origin\/main/, // on main
            /release\.mjs wait-for-checks "\$GITHUB_SHA"/, // checks passed on the release commit
            /release\.mjs publishable "\$VERSION"/, // the public fixed group at the tag's version
            /HEAD\^:\$dir\/package\.json/, // the tag is the commit that set the version
        ].map((re) => script.search(re))
        expect(order.every((at) => at >= 0)).toBe(true)
        expect([...order].sort((a, b) => a - b)).toEqual(order)
    })

    // A gate softened in place would leave the commands above where they are: a step that may fail and go on, a step
    // that may be skipped, or a check whose answer is not required. Every step of the jobs on the way to npm is held
    // to running unconditionally and failing the job, and each gate's answer to being required.
    it('runs every step on the way to npm unconditionally, and requires each gate to say it passed', () => {
        for (const name of ['plan', 'push', 'pack', 'publish']) {
            const job = release.jobs[name] as Job & { 'continue-on-error'?: unknown }
            expect(job['continue-on-error'], name).toBeUndefined()
            for (const step of job.steps ?? []) {
                const s = step as Step & { if?: unknown; 'continue-on-error'?: unknown }
                expect(s['continue-on-error'], `${name}: ${s.name ?? s.uses ?? s.run}`).toBeUndefined()
                // `upload-artifact` steps are the one kind gated on an earlier output, and they publish nothing
                if (s.if !== undefined)
                    expect(s.uses, `${name}: ${s.name ?? s.run}`).toMatch(/^actions\/upload-artifact@/)
                // a failure swallowed (`|| true`, `|| :`, `|| exit 0`, `|| echo …`), or errors turned off (`set +e`).
                // One line is exempt by its exact text: `pack` reads a package's version before the tag's commit, and a
                // package new at that commit has none, which must read as empty rather than fail the release.
                const exempt = `before=$(git show "HEAD^:$dir/package.json" 2>/dev/null | jq -r .version || true)`
                const script = (s.run ?? '').replace(exempt, '')
                expect(script, `${name}: ${s.name}`).not.toMatch(SWALLOWED_FAILURE)
                expect((s as Step & { shell?: unknown }).shell, `${name}: ${s.name}`).toBeUndefined()
            }
        }
        const gate =
            '[ "$out" = "passed $GITHUB_SHA" ] || { echo "::error::the CI gate did not report a pass"; exit 1; }'
        for (const name of ['plan', 'pack']) {
            const script = runs(release.jobs[name])
            expect(script, name).toContain('out=$(node scripts/release.mjs wait-for-checks "$GITHUB_SHA")')
            expect(script, name).toContain(gate)
            for (const step of release.jobs[name].steps ?? []) {
                if (step.run?.includes('wait-for-checks')) expect(step.run, name).toMatch(/^set -euo pipefail\n/)
            }
        }
        expect(runs(release.jobs.push)).toContain(
            '[ "$out" = "verified $VERSION" ] || { echo "::error::verify-release did not report a pass"; exit 1; }',
        )
    })

    it('cuts a release only on main, behind checks on the merge commit, from a checked patch', () => {
        const { plan, push } = release.jobs
        expect(plan.if).toBe("github.ref == 'refs/heads/main'")
        expect(runs(plan).search(/wait-for-checks "\$GITHUB_SHA"/)).toBeLessThan(
            runs(plan).search(/release\.mjs prepare/),
        )
        expect(push.needs).toBe('plan')
        expect(environment(push)).toBe('release')
        expect(runs(push)).toMatch(/verify-release "\$VERSION"/)
        // a 0.x version, plain or a candidate, in both halves: nothing reaches 1.0.0 by this path
        for (const job of [plan, push]) {
            expect(runs(job)).toContain('^0\\.(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)(-rc\\.(0|[1-9][0-9]*))?$')
        }
    })

    it("holds npm's id-token in publish alone; attest signs with one in no environment, which npm refuses", () => {
        const holders = Object.entries(release.jobs).filter(([, job]) => job.permissions?.['id-token'] === 'write')
        expect(holders.map(([name]) => name).sort()).toEqual(['attest', 'publish'])
        expect(environment(release.jobs.attest)).toBeUndefined()
        expect(release.jobs.attest.if).toBeUndefined()
        expect(release.jobs.attest.needs).toBe('candidate')
        expect(release.jobs.candidate.if).toBe(
            "startsWith(github.ref, 'refs/tags/v') && contains(github.ref_name, '-rc.')",
        )
        expect(publishCommands(runs(release.jobs.attest))).toEqual([])
    })

    // A job added to release.yml is held here before it runs: the list is the whole file, so a new one fails this test
    // until someone has said where it stands relative to the one way onto npm.
    it('has exactly the jobs this test knows, and none that publish waits on but pack', () => {
        expect(Object.keys(release.jobs).sort()).toEqual(
            ['attest', 'candidate', 'demo', 'github-release', 'pack', 'plan', 'prerelease', 'publish', 'push'].sort(),
        )
        const needs = (job: Job) => (job.needs === undefined ? [] : [job.needs].flat())
        // everything `publish` waits on, transitively
        const upstream = new Set<string>()
        for (let todo = needs(release.jobs.publish); todo.length > 0;) {
            const next = todo.pop()!
            if (!upstream.has(next)) todo.push(...needs(release.jobs[next]))
            upstream.add(next)
        }
        expect([...upstream]).toEqual(['pack'])
        // and nothing waits on `publish`: no job's success or failure is tied to npm's
        for (const [name, job] of Object.entries(release.jobs)) expect(needs(job), name).not.toContain('publish')
    })

    // A plain release's GitHub page (adoption follow-up 4) runs beside `publish`, after the same `pack`: it can neither
    // hold up nor start a publish, and holds nothing npm would take.
    it("makes a plain release's GitHub page beside publish, with no id-token, environment or secret", () => {
        const { demo, 'github-release': page } = release.jobs
        expect(demo.needs).toBe('pack')
        expect(page.needs).toEqual(['pack', 'demo'])
        // `pack`'s gates (a plain tag on main, after checks passed on it), and, as `publish`, only a tag that publishes
        expect(demo.if).toBe("needs.pack.outputs.count != '0'")
        expect(page.if).toBeUndefined()
        for (const job of [demo, page]) {
            expect(environment(job)).toBeUndefined()
            expect(JSON.stringify(job)).not.toMatch(/\bsecrets\b|id-token|npm-publish/)
            expect(publishCommands(runs(job))).toEqual([])
            for (const step of job.steps ?? []) expect(step.uses ?? '', step.name).not.toMatch(/publish/i)
        }
        expect(demo.permissions).toEqual({ contents: 'read', actions: 'read' })
        expect(page.permissions).toEqual({ contents: 'write' })
        // what `demo` fetches is what app-checks.yml's demo-static job uploads for the showcase, which checks.yml runs
        expect(runs(demo)).toMatch(/release\.mjs checks-run "\$GITHUB_SHA"/)
        expect(runs(demo)).toContain('--name static-demo-showcase')
        const upload = read('app-checks.yml').jobs['demo-static']?.steps?.find(
            (s) => s.with?.['name'] === 'static-demo-${{ matrix.demo.name }}',
        )
        expect(upload?.with?.['path']).toBe('${{ matrix.demo.app }}/dist-demo/index.html')
    })

    it('runs no publish anywhere else, but as a dry run, and nothing else holds an id-token, environment or secret', () => {
        const others = files.filter((f) => f !== 'release.yml')
        // close-issues-on-integration-merge.yml closes the issues a merged PR names; it holds `issues: write` alone
        expect(others.sort()).toEqual(['app-checks.yml', 'checks.yml', 'close-issues-on-integration-merge.yml'])
        // the reusable workflow starts only when called, from `checks.yml` here or from an adopter's own CI
        expect(Object.keys(read('app-checks.yml').on)).toEqual(['workflow_call'])
        for (const file of others) {
            const workflow = read(file)
            // read as parsed, so a comment that names one is not one; `write-all` would grant an id-token too
            expect(JSON.stringify(workflow.permissions ?? {}), file).not.toMatch(/id-token|write-all/)
            for (const [name, job] of Object.entries(workflow.jobs)) {
                const where = `${file} ${name}`
                expect(JSON.stringify(job.permissions ?? {}), where).not.toMatch(/id-token|write-all/)
                // `secrets.X`, `secrets['X']` and a reusable call's `secrets: inherit` alike
                expect(JSON.stringify(job), where).not.toMatch(/\bsecrets\b/)
                expect(job.environment, where).toBeUndefined()
                for (const command of publishCommands(runs(job))) expect(command, where).toMatch(/--dry-run/)
                // a publish through an action rather than a `run:` line
                for (const step of job.steps ?? []) expect(step.uses ?? '', where).not.toMatch(/publish/i)
            }
        }
        // release.yml: npm's one publish, in `publish`; the candidate's jobs attach to a GitHub release, not npm
        const elsewhere = Object.entries(release.jobs)
            .filter(([name]) => name !== 'publish')
            .flatMap(([, job]) => publishCommands(runs(job)))
        expect(elsewhere).toEqual([])
    })

    it("rehearses the release on every PR with release.yml's commands, holding nothing that writes", () => {
        const checks = read('checks.yml')
        expect(Object.keys(checks.on).sort()).toEqual(['pull_request', 'push'])
        const job = checks.jobs['release-dry-run']
        expect(job.permissions).toEqual({ contents: 'read' })
        expect(job.steps?.[0].with?.['persist-credentials']).toBe(false)
        const script = runs(job)
        for (const command of [
            /node scripts\/release\.mjs prepare/,
            /node "\$RUNNER_TEMP\/release\.mjs" verify-release "\$version"/,
            /node scripts\/release\.mjs publishable "\$version"/,
            /node scripts\/release\.mjs preflight "\$version" "\$sha"/,
        ]) {
            expect(script).toMatch(command)
        }
        expect(publishCommands(script)).toEqual([
            'npx --yes npm@11.21.2 publish "$file" --access public --provenance --dry-run',
        ])
        // the checker is copied before `prepare` runs anything that could rewrite it, as `push` copies it from a fresh
        // checkout; and what is rehearsed is this commit with `main` in it, as a merge would release it
        expect(script.indexOf('cp scripts/release.mjs "$RUNNER_TEMP/release.mjs"')).toBeGreaterThanOrEqual(0)
        expect(script.indexOf('cp scripts/release.mjs')).toBeLessThan(script.indexOf('release.mjs prepare'))
        expect(job.steps?.find((s) => s.name === 'take in main, as a merge to main would')?.run).toContain(
            'merge -q --no-edit origin/main',
        )
        // the npm it rehearses with is the one `publish` publishes with
        expect(runs(release.jobs.publish)).toContain(
            'npx --yes npm@11.21.2 publish "$file" --access public --provenance',
        )
        expect(script).not.toMatch(/git push|gh release|gh api/)
    })
})

describe('the swallowed-failure pattern itself', () => {
    it.each([
        'foo || :',
        'foo || :\nbar',
        'foo ||: # x',
        'foo || :;',
        'foo ||:',
        'foo || true',
        'foo || exit 0',
        'foo || echo skipped',
        'set +e',
    ])('sees %j', (script) => {
        expect(script).toMatch(SWALLOWED_FAILURE)
    })
    it.each([
        'foo || { echo "::error::failed"; exit 1; }',
        'foo || exit 1',
        'foo || :not-a-noop',
        'a=x:y',
        'set -euo pipefail',
    ])('leaves %j alone', (script) => {
        expect(script).not.toMatch(SWALLOWED_FAILURE)
    })
})
