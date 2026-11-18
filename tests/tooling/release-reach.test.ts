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
 * them): `release` admits `main` only, `npm-publish` admits `v*` tags only, a tag ruleset lets only the release app
 * create `v*`, and each package's trusted publisher names this repository, `release.yml` and `npm-publish`.
 */
const WORKFLOWS = fileURLToPath(new URL('../../.github/workflows/', import.meta.url))

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

    it('runs no publish anywhere else, but as a dry run, and nothing else holds an id-token, environment or secret', () => {
        const others = files.filter((f) => f !== 'release.yml')
        expect(others.sort()).toEqual(['app-checks.yml', 'checks.yml'])
        for (const file of others) {
            const workflow = read(file)
            // read as parsed, so a comment that names one is not one; `write-all` would grant an id-token too
            expect(JSON.stringify(workflow.permissions ?? {}), file).not.toMatch(/id-token|write-all/)
            for (const [name, job] of Object.entries(workflow.jobs)) {
                expect(JSON.stringify(job.permissions ?? {}), `${file} ${name}`).not.toMatch(/id-token|write-all/)
                expect(JSON.stringify(job), `${file} ${name}`).not.toMatch(/\bsecrets\./)
                expect(job.environment, `${file} ${name}`).toBeUndefined()
                for (const command of publishCommands(runs(job)))
                    expect(command, `${file} ${name}`).toMatch(/--dry-run/)
            }
        }
        // release.yml: npm's one publish, in `publish`; the candidate's jobs attach to a GitHub release, not npm
        const elsewhere = Object.entries(release.jobs)
            .filter(([name]) => name !== 'publish')
            .flatMap(([, job]) => publishCommands(runs(job)))
        expect(elsewhere).toEqual([])
    })

    it('rehearses the release on every PR with the same commands, holding nothing that writes', () => {
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
        // the npm it rehearses with is the one `publish` publishes with
        expect(runs(release.jobs.publish)).toContain(
            'npx --yes npm@11.21.2 publish "$file" --access public --provenance',
        )
        expect(script).not.toMatch(/git push|gh release|gh api/)
    })
})
