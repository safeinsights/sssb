import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { parse } from 'yaml'

/**
 * The reusable workflow (.github/workflows/app-checks.yml, ADR-0014 P10) and this repository's call to it from
 * checks.yml. GitHub reads both files when a run starts, so nothing else would notice a change that drops a check:
 * a skipped job reports as a passing check, a job that never starts reports nothing, and release.yml trusts the
 * `checks` workflow's conclusion alone. These cases hold the shape that keeps every check running.
 */
const ROOT = path.resolve(__dirname, '../..')
type Step = { run?: string; uses?: string; if?: string; env?: Record<string, string> }
type Job = {
    name?: string
    if?: string
    uses?: string
    with?: Record<string, string>
    secrets?: unknown
    needs?: string | string[]
    permissions?: Record<string, string>
    strategy?: unknown
    steps?: Step[]
}
type Workflow = {
    name: string
    on: Record<string, { inputs?: Record<string, unknown>; secrets?: unknown }>
    permissions?: Record<string, string>
    jobs: Record<string, Job>
}
const read = (file: string) => parse(readFileSync(path.join(ROOT, '.github/workflows', file), 'utf8')) as Workflow

const reusable = read('app-checks.yml')
const checks = read('checks.yml')

describe('app-checks.yml, the reusable workflow', () => {
    it('is called, never triggered, and takes no secrets', () => {
        expect(Object.keys(reusable.on)).toEqual(['workflow_call'])
        expect(reusable.on.workflow_call?.secrets).toBeUndefined()
        expect(Object.keys(reusable.on.workflow_call?.inputs ?? {}).sort()).toEqual([
            'apps',
            'node-version-file',
            'synth',
        ])
    })

    it('reads the repository and nothing else, in every job', () => {
        expect(reusable.permissions).toEqual({ contents: 'read' })
        for (const [id, job] of Object.entries(reusable.jobs)) {
            if (id !== 'all-checks') expect(job.permissions, id).toEqual({ contents: 'read' })
        }
        expect(reusable.jobs['all-checks']?.permissions).toEqual({})
    })

    // all-checks is the check an adopter requires. It must wait for every other job, run whatever they did, and judge
    // each one, so a job added later is either listed in both places or this goes red.
    it('all-checks waits for and judges every other job, whatever happened to them', () => {
        const allChecks = reusable.jobs['all-checks']!
        const others = Object.keys(reusable.jobs).filter((id) => id !== 'all-checks')
        expect(allChecks.if).toBe('always()')
        expect([allChecks.needs].flat().sort()).toEqual([...others].sort())
        const script = allChecks.steps?.map((step) => step.run ?? '').join('\n') ?? ''
        const judged = /for \(const job of (\[[^\]]*\])\)/.exec(script)?.[1]
        expect(JSON.parse(judged ?? '[]').sort()).toEqual([...others].sort())
        // Only synth may be skipped, and only when no synth was asked for.
        expect(script).toContain('job === "synth" && process.env.SYNTH === "" ? "skipped" : "success"')
        expect(
            Object.entries(reusable.jobs)
                .filter(([, job]) => job.if)
                .map(([id]) => id)
                .sort(),
        ).toEqual(['all-checks', 'synth'])
    })

    // Orchestration only (ADR-0014 part 7): every step that is not setup is one `sssb ci <job>` command, so its logic
    // comes from the caller's lockfile. And no step interpolates an input or a matrix value into its shell text, where
    // an app directory's name would become code; they arrive as environment variables.
    it('runs each job through `pnpm exec sssb ci`, and never splices a value into a shell command', () => {
        const SETUP = [
            /^pnpm install --frozen-lockfile( --ignore-scripts)?$/,
            /^pnpm exec playwright install(-deps| --with-deps) chromium$/,
            /^node -e "const s=require\('\.\/coverage\/coverage-summary\.json'\)/,
            /^node -e '/,
        ]
        const jobsThatRun: string[] = []
        for (const [id, job] of Object.entries(reusable.jobs)) {
            for (const step of job.steps ?? []) {
                if (step.run === undefined) continue
                expect(step.run, `${id}: ${step.run}`).not.toMatch(/\$\{\{/)
                const command = step.run.trim()
                if (SETUP.some((pattern) => pattern.test(command))) continue
                expect(command, id).toMatch(/^pnpm exec sssb ci [a-z0-9-]+( |$)/)
                jobsThatRun.push(/^pnpm exec sssb ci ([a-z0-9-]+)/.exec(command)![1]!)
            }
        }
        expect(jobsThatRun.sort()).toEqual(['contract', 'demo-static', 'e2e', 'lint-typecheck-unit', 'matrix', 'synth'])
    })
})

describe("checks.yml's call to it", () => {
    const sssb = checks.jobs['sssb']!

    it('calls it by its local path, always, with no secrets and only a read', () => {
        expect(sssb.uses).toBe('./.github/workflows/app-checks.yml')
        expect(sssb.if).toBeUndefined()
        expect(sssb.secrets).toBeUndefined()
        expect(sssb.permissions).toEqual({ contents: 'read' })
    })

    // No `apps`: the workspace's apps are discovered, so `pnpm init-app`'s rename and eject need no edit here, and no
    // app can be left out by a list that went stale.
    it('covers every app, and synthesizes every app’s infra', () => {
        expect(Object.keys(sssb.with ?? {})).toEqual(['synth'])
        const infra = readdirSync(path.join(ROOT, 'apps'))
            .filter((app) => existsSync(path.join(ROOT, 'apps', app, 'infra', 'package.json')))
            .map((app) => `apps/${app}/infra`)
        expect(infra.length).toBeGreaterThan(0)
        const listed = execFileSync('pnpm', ['--filter', sssb.with!['synth']!, 'list', '--depth', '-1', '--json'], {
            cwd: ROOT,
            encoding: 'utf8',
        })
        const matched = (JSON.parse(listed) as { path: string }[]).map((pkg) => path.relative(ROOT, pkg.path)).sort()
        expect(matched).toEqual(infra.sort())
    })

    // release.yml's CI gate (scripts/release.mjs, wait-for-checks) reads the runs of `checks.yml` by its file name.
    it('is still the workflow release.yml waits for', () => {
        expect(checks.name).toBe('checks')
        expect(readFileSync(path.join(ROOT, 'scripts/release.mjs'), 'utf8')).toContain(
            'actions/workflows/checks.yml/runs',
        )
    })
})

// The rulesets on `main` and `integration` require checks BY NAME, and a name that stops appearing blocks every PR
// (or, if the ruleset is edited to match the wrong name, lets one through). So the names are pinned here: a job
// renamed or added fails this, and the rulesets change in the same step as the merge.
describe('the check names the rulesets require', () => {
    const REQUIRED = [
        'adoption-probe',
        'changeset-required',
        'pack-and-consume',
        'release-plan',
        'repo-checks',
        'secret-scan',
        'sssb / all-checks',
        'sssb / contract',
        'sssb / demo-static (showcase)',
        'sssb / demo-static (starter)',
        'sssb / discover',
        'sssb / e2e (showcase)',
        'sssb / e2e (showcase-destructive)',
        'sssb / e2e (starter)',
        'sssb / lint-typecheck-unit',
        'sssb / synth',
    ]

    it('are what the two workflows produce for this repository', () => {
        const matrix = execFileSync(process.execPath, [path.join(ROOT, 'packages/tools/bin/sssb.js'), 'ci', 'matrix'], {
            cwd: ROOT,
            encoding: 'utf8',
            env: { ...process.env, GITHUB_OUTPUT: '' },
        })
        const listOf = (label: string) =>
            JSON.parse(
                /^.*: (.*)$/m.exec(matrix.split('\n').find((line) => line.startsWith(label)) ?? '')?.[1] ?? '[]',
            ) as {
                name: string
            }[]
        const names: string[] = []
        for (const [id, job] of Object.entries(checks.jobs)) {
            if (id !== 'sssb') {
                names.push(job.name ?? id)
                continue
            }
            for (const [inner, called] of Object.entries(reusable.jobs)) {
                if (inner === 'e2e') names.push(...listOf('e2e shards').map((s) => `sssb / e2e (${s.name})`))
                else if (inner === 'demo-static')
                    names.push(...listOf('static demos').map((d) => `sssb / demo-static (${d.name})`))
                else names.push(`sssb / ${called.name ?? inner}`)
            }
        }
        expect(names.sort()).toEqual([...REQUIRED].sort())
    })
})
