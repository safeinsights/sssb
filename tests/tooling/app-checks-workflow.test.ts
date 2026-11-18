import { execFileSync, spawnSync } from 'node:child_process'
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
    it('all-checks waits for every other job, whatever happened to them', () => {
        const allChecks = reusable.jobs['all-checks']!
        const others = Object.keys(reusable.jobs).filter((id) => id !== 'all-checks')
        expect(allChecks.if).toBe('always()')
        expect([allChecks.needs].flat().sort()).toEqual([...others].sort())
        expect(
            Object.entries(reusable.jobs)
                .filter(([, job]) => job.if)
                .map(([id]) => id)
                .sort(),
        ).toEqual(['all-checks', 'synth'])
    })

    // Its script is RUN here, against every result a job can have, rather than read: a script edited to pass anything
    // would still read like one that judges.
    describe("all-checks' verdict", () => {
        const step = reusable.jobs['all-checks']!.steps!.find((s) => s.run)!
        const others = Object.keys(reusable.jobs).filter((id) => id !== 'all-checks')
        const verdict = (results: Record<string, string>, synth: string) => {
            const needs = Object.fromEntries(
                Object.entries(results).map(([job, result]) => [job, { result, outputs: {} }]),
            )
            return spawnSync('bash', ['-c', step.run!], {
                env: { ...process.env, NEEDS: JSON.stringify(needs), SYNTH: synth },
                encoding: 'utf8',
            }).status
        }
        const all = (result: string, synth: string) =>
            Object.fromEntries(others.map((job) => [job, job === 'synth' && synth === '' ? 'skipped' : result]))

        it('passes when every job succeeded, synth skipped when none was asked for', () => {
            expect(verdict(all('success', ''), '')).toBe(0)
            expect(verdict(all('success', './apps/*/infra'), './apps/*/infra')).toBe(0)
        })

        it.each(others)('fails when %s did not succeed, whatever else did', (job) => {
            for (const result of ['failure', 'cancelled', 'skipped']) {
                expect(verdict({ ...all('success', 'x'), [job]: result }, 'x'), `${job} ${result}`).toBe(1)
            }
            const missing = all('success', 'x')
            delete missing[job]
            expect(verdict(missing, 'x'), `${job} missing`).toBe(1)
        })

        it('fails when synth was skipped although asked for, or ran although not', () => {
            expect(verdict({ ...all('success', 'x'), synth: 'skipped' }, 'x')).toBe(1)
            expect(verdict({ ...all('success', ''), synth: 'success' }, '')).toBe(1)
        })
    })

    // Orchestration only (ADR-0014 part 7): each job's work is one `sssb ci <job>` command, exactly, so its logic comes
    // from the caller's lockfile; nothing may soften it (`|| true`, a step `if`, `continue-on-error`). No step splices an
    // input or a matrix value into its shell text, where an app directory's name would become code: they arrive as
    // environment variables. Setup steps are the only others, and inline Node only where named.
    it('runs each job’s work as exactly one `pnpm exec sssb ci` command, and nothing softens it', () => {
        const WORK: Record<string, string> = {
            'lint-typecheck-unit': 'pnpm exec sssb ci lint-typecheck-unit --apps "$APPS"',
            contract: 'pnpm exec sssb ci contract',
            discover: 'pnpm exec sssb ci matrix --apps "$APPS"',
            e2e: 'pnpm exec sssb ci e2e --app "$APP" ${PROJECT:+--project "$PROJECT"}',
            'demo-static': 'pnpm exec sssb ci demo-static --app "$APP"',
            synth: 'pnpm exec sssb ci synth --filter "$SYNTH"',
        }
        const SETUP = [
            /^pnpm install --frozen-lockfile( --ignore-scripts)?$/,
            /^pnpm exec playwright install(-deps| --with-deps) chromium$/,
        ]
        const INLINE_NODE: Record<string, RegExp> = {
            'lint-typecheck-unit': /^node -e "const s=require\('\.\/coverage\/coverage-summary\.json'\)/,
            'all-checks': /^node -e '/,
        }
        expect(Object.keys(WORK).sort()).toEqual(
            Object.keys(reusable.jobs)
                .filter((id) => id !== 'all-checks')
                .sort(),
        )
        for (const [id, job] of Object.entries(reusable.jobs)) {
            expect((job as Record<string, unknown>)['continue-on-error'], id).toBeUndefined()
            const work: Step[] = []
            for (const step of job.steps ?? []) {
                expect((step as Record<string, unknown>)['continue-on-error'], id).toBeUndefined()
                if (step.run === undefined) continue
                expect(step.run, `${id}: ${step.run}`).not.toMatch(/\$\{\{/)
                const command = step.run.trim()
                if (SETUP.some((pattern) => pattern.test(command))) continue
                if (INLINE_NODE[id]?.test(command)) continue
                work.push(step)
            }
            if (id === 'all-checks') {
                expect(work, id).toEqual([])
                continue
            }
            expect(
                work.map((step) => step.run!.trim()),
                id,
            ).toEqual([WORK[id]])
            expect(work[0]!.if, id).toBeUndefined()
        }
    })

    // What a work step runs with is part of what it runs: an `APP` left pointing at one app runs every shard against
    // it with every shard name intact. So each work step's keys and environment are pinned, as all-checks' is, and no
    // job carries `defaults` (a `run.shell` there wraps every step) or checks out anything but the commit under test.
    it('pins each work step’s environment, all-checks’ step, and what every job checks out', () => {
        const ENV: Record<string, Record<string, string>> = {
            'lint-typecheck-unit': { APPS: '${{ inputs.apps }}' },
            contract: { CONTRACT_DATABASE_URL: 'postgres://postgres:postgres@localhost:5432/postgres' },
            discover: { APPS: '${{ inputs.apps }}' },
            e2e: {
                APP: '${{ matrix.shard.app }}',
                PROJECT: '${{ matrix.shard.project }}',
                NEXT_TELEMETRY_DISABLED: '1',
                E2E_BUILD: '1',
            },
            'demo-static': { APP: '${{ matrix.demo.app }}' },
            synth: { SYNTH: '${{ inputs.synth }}' },
        }
        expect((reusable as Record<string, unknown>)['env']).toBeUndefined()
        expect((reusable as Record<string, unknown>)['defaults']).toBeUndefined()
        for (const [id, job] of Object.entries(reusable.jobs)) {
            expect((job as Record<string, unknown>)['defaults'], id).toBeUndefined()
            expect((job as Record<string, unknown>)['env'], id).toBeUndefined()
            for (const step of job.steps ?? []) {
                if (step.uses?.startsWith('actions/checkout@')) {
                    expect((step as Record<string, unknown>)['with'], `${id}: checkout`).toBeUndefined()
                }
            }
            const work = (job.steps ?? []).filter((step) => step.run?.trim().startsWith('pnpm exec sssb ci '))
            if (id === 'all-checks') continue
            expect(work.length, id).toBe(1)
            const keys = Object.keys(work[0]!).filter((key) => key !== 'id')
            expect(keys.sort(), id).toEqual(['env', 'run'])
            expect(work[0]!.env, id).toEqual(ENV[id])
        }
        const judge = reusable.jobs['all-checks']!.steps!
        expect(judge.length).toBe(1)
        expect(Object.keys(judge[0]!).sort()).toEqual(['env', 'name', 'run'])
        expect(judge[0]!.env).toEqual({ NEEDS: '${{ toJson(needs) }}', SYNTH: '${{ inputs.synth }}' })
    })

    // The matrices come from `discover`, never a hand-written list that an added app would not be in.
    it('takes both matrices from discover', () => {
        expect(reusable.jobs['e2e']!.strategy).toEqual({
            'fail-fast': false,
            matrix: { shard: '${{ fromJson(needs.discover.outputs.e2e) }}' },
        })
        expect(reusable.jobs['demo-static']!.strategy).toEqual({
            'fail-fast': false,
            matrix: { demo: '${{ fromJson(needs.discover.outputs.demo-static) }}' },
        })
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
        for (const dir of infra) {
            const scripts = JSON.parse(readFileSync(path.join(ROOT, dir, 'package.json'), 'utf8')).scripts ?? {}
            expect(typeof scripts.synth, `${dir} has a synth script`).toBe('string')
        }
        // Discovery is the root's `sssb.apps` when it has one: it must not leave an app out.
        const sssbApps = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8')).sssb?.apps as
            string[] | undefined
        const apps = readdirSync(path.join(ROOT, 'apps'))
            .filter((app) => existsSync(path.join(ROOT, 'apps', app, 'package.json')))
            .map((app) => `apps/${app}`)
        if (sssbApps !== undefined) expect([...sssbApps].sort()).toEqual(apps.sort())
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
    // The names that do not depend on which apps the tree holds: a job renamed or added fails this.
    const FIXED = [
        'adoption-probe',
        'changeset-required',
        'pack-and-consume',
        'release-plan',
        'repo-checks',
        'secret-scan',
        'sssb / all-checks',
        'sssb / contract',
        'sssb / discover',
        'sssb / lint-typecheck-unit',
        'sssb / synth',
    ]
    // One per e2e shard and one per static demo, named from the tree's own apps, so this holds in a tree `pnpm
    // init-app` has renamed or ejected (the adoption probe runs it there). In SSSB's own tree they are
    // `sssb / e2e (showcase)`, `sssb / e2e (showcase-destructive)`, `sssb / e2e (starter)`,
    // `sssb / demo-static (showcase)` and `sssb / demo-static (starter)`.
    const PER_APP = ['sssb / e2e (<shard>)', 'sssb / demo-static (<app>)']

    const matrix = execFileSync(process.execPath, [path.join(ROOT, 'packages/tools/bin/sssb.js'), 'ci', 'matrix'], {
        cwd: ROOT,
        encoding: 'utf8',
        env: { ...process.env, GITHUB_OUTPUT: '', GITHUB_ACTIONS: '' },
    })
    const listOf = (label: string) =>
        JSON.parse(
            /^.*?: (.*)$/.exec(matrix.split('\n').find((line) => line.startsWith(label)) ?? '')?.[1] ?? '[]',
        ) as {
            name: string
            app: string
        }[]
    const shards = listOf('e2e shards')
    const demos = listOf('static demos')

    it('are what the two workflows produce for this tree', () => {
        expect(shards.length).toBeGreaterThan(0)
        expect(demos.length).toBeGreaterThan(0)
        const names: string[] = []
        const generic: string[] = []
        for (const [id, job] of Object.entries(checks.jobs)) {
            if (id !== 'sssb') {
                names.push(job.name ?? id)
                continue
            }
            for (const [inner, called] of Object.entries(reusable.jobs)) {
                if (inner === 'e2e') {
                    generic.push('sssb / e2e (<shard>)')
                    names.push(...shards.map((s) => `sssb / e2e (${s.name})`))
                } else if (inner === 'demo-static') {
                    generic.push('sssb / demo-static (<app>)')
                    names.push(...demos.map((d) => `sssb / demo-static (${d.name})`))
                } else names.push(`sssb / ${called.name ?? inner}`)
            }
        }
        expect(generic.sort()).toEqual([...PER_APP].sort())
        const expected = [
            ...FIXED,
            ...shards.map((s) => `sssb / e2e (${s.name})`),
            ...demos.map((d) => `sssb / demo-static (${d.name})`),
        ]
        expect(names.sort()).toEqual(expected.sort())
    })

    // In SSSB's own tree the per-app names are pinned literally too: the rulesets require them by name, and a renamed
    // Playwright project or app would otherwise change them with this test still green.
    it("are, in SSSB's own tree, the five the rulesets name", () => {
        const apps = readdirSync(path.join(ROOT, 'apps'))
            .filter((app) => existsSync(path.join(ROOT, 'apps', app, 'package.json')))
            .sort()
        if (!apps.includes('showcase') || !apps.includes('starter')) return
        const ours = (entry: { app?: string }) => entry.app === 'apps/showcase' || entry.app === 'apps/starter'
        expect(
            [
                ...shards.filter(ours).map((s) => `sssb / e2e (${s.name})`),
                ...demos.filter(ours).map((d) => `sssb / demo-static (${d.name})`),
            ].sort(),
        ).toEqual([
            'sssb / demo-static (showcase)',
            'sssb / demo-static (starter)',
            'sssb / e2e (showcase)',
            'sssb / e2e (showcase-destructive)',
            'sssb / e2e (starter)',
        ])
    })

    // The per-app names come from the matrix jobs' `name:` templates, which are pinned here like the fixed names.
    it('name the matrix jobs by shard and by app', () => {
        expect(reusable.jobs['e2e']!.name).toBe('e2e (${{ matrix.shard.name }})')
        expect(reusable.jobs['demo-static']!.name).toBe('demo-static (${{ matrix.demo.name }})')
    })
})
