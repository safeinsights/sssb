import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { DEFAULT_POLICY, evaluate, main, policyProblems, satisfies } from '../../scripts/licence-scan.mjs'
import { makeTestTmpDir } from '../support/tmp-dir'

/**
 * scripts/licence-scan.mjs judges `pnpm licenses list --json` against .github/licence-policy.json (CI's
 * `licence-scan` job; docs/decision-log.md, "Licence scan"). These cases run it over reports written here, so they
 * need no install; the job itself runs it over the real one.
 */
const ROOT = fileURLToPath(new URL('../..', import.meta.url))
const policyFile = JSON.parse(readFileSync(DEFAULT_POLICY, 'utf8'))

const ALLOWED = new Set(['MIT', 'ISC', 'Apache-2.0'])

describe('satisfies', () => {
    it.each([
        ['MIT', true],
        ['GPL-3.0-only', false],
        ['Unknown', false],
        ['', false],
        ['(MIT OR GPL-3.0-only)', true],
        ['(GPL-3.0-only OR LGPL-3.0-only)', false],
        ['MIT AND ISC', true],
        ['MIT AND GPL-3.0-only', false],
        ['Apache-2.0 AND (MIT OR GPL-2.0-only)', true],
        ['MIT AND (GPL-2.0-only OR AGPL-3.0-only)', false],
        ['MIT OR GPL-3.0-only AND AGPL-3.0-only', true], // AND binds tighter than OR
        ['GPL-3.0-only AND AGPL-3.0-only OR MIT', true],
        ['Apache-2.0 WITH LLVM-exception', false], // never read as `Apache-2.0`: an exception decides it
        ['SEE LICENSE IN LICENSE.md', false],
        ['(MIT', false],
        ['MIT)', false],
        ['MIT OR', false],
        ['AND MIT', false],
    ])('%j -> %s', (expression, expected) => {
        expect(satisfies(expression, ALLOWED)).toBe(expected)
    })
})

const POLICY = {
    allowed: ['MIT', 'ISC'],
    scope: { exclude: ['demo'], reason: 'r' },
    exceptions: [
        { package: 'sentry', license: 'FSL-1.1-Apache-2.0', reason: 'x' },
        { package: '@img/libvips-*', license: 'LGPL-3.0-or-later', platform: true, reason: 'x' },
    ],
}

describe('evaluate', () => {
    it('passes an allowed licence, an excepted package and a satisfied expression', () => {
        const result = evaluate(
            {
                MIT: [{ name: 'a', versions: ['1.0.0'] }],
                '(MIT OR CC0-1.0)': [{ name: 'b', versions: ['1.0.0'] }],
                'FSL-1.1-Apache-2.0': [{ name: 'sentry', versions: ['0.49.0'] }],
                'LGPL-3.0-or-later': [{ name: '@img/libvips-linux-x64', versions: ['1.3.4'] }],
            },
            POLICY,
        )
        expect(result.violations).toEqual([])
        expect(result.stale).toEqual([])
        expect(result.excepted).toBe(2)
    })

    it('fails a copyleft, a source-available and an unknown licence, and names each package', () => {
        const result = evaluate(
            {
                'GPL-3.0-only': [{ name: 'g', versions: ['2.0.0'] }],
                'BUSL-1.1': [{ name: 'b', versions: ['1.0.0', '1.1.0'] }],
                Unknown: [{ name: 'u', versions: ['0.0.1'] }],
                MIT: [{ name: 'ok', versions: ['1.0.0'] }],
            },
            POLICY,
        )
        expect(result.violations.map((v) => `${v.name}@${v.versions} ${v.license}`)).toEqual([
            'b@1.0.0,1.1.0 BUSL-1.1',
            'g@2.0.0 GPL-3.0-only',
            'u@0.0.1 Unknown',
        ])
    })

    it('holds an exception to the licence it names: a bump that changes the licence fails again', () => {
        const result = evaluate({ 'BUSL-1.1': [{ name: 'sentry', versions: ['0.50.0'] }] }, POLICY)
        expect(result.violations.map((v) => v.name)).toEqual(['sentry'])
    })

    it('holds an exact exception to the exact name, not a longer one', () => {
        const result = evaluate({ 'FSL-1.1-Apache-2.0': [{ name: 'sentry-extra', versions: ['1.0.0'] }] }, POLICY)
        expect(result.violations.map((v) => v.name)).toEqual(['sentry-extra'])
    })

    it('holds a wildcard exception to its prefix', () => {
        const result = evaluate({ 'LGPL-3.0-or-later': [{ name: '@img/other', versions: ['1.0.0'] }] }, POLICY)
        expect(result.violations.map((v) => v.name)).toEqual(['@img/other'])
    })

    it('reports an exception that matches nothing, but not a per-platform one', () => {
        const result = evaluate({ MIT: [{ name: 'a', versions: ['1.0.0'] }] }, POLICY)
        expect(result.stale).toEqual(['sentry (FSL-1.1-Apache-2.0)'])
    })
})

describe('policyProblems', () => {
    it('accepts the repository policy', () => {
        expect(policyProblems(policyFile)).toEqual([])
    })

    it('names what is missing', () => {
        expect(policyProblems(null)).toEqual(['the policy is not an object'])
        expect(
            policyProblems({
                allowed: [],
                exceptions: [{ package: 'p', license: 'L' }, { license: 'L', reason: 'r' }, 7],
                scope: {},
            }),
        ).toEqual([
            '`allowed` is not a list of identifiers',
            '`scope` needs an `exclude` list of workspace project names and a `reason`',
            'exceptions[0] has no `reason`',
            'exceptions[1] has no `package`',
            'exceptions[2] is not an object',
        ])
    })

    it('refuses a wildcard that is not a prefix of some length', () => {
        const withPackage = (pkg: string) => ({
            ...POLICY,
            exceptions: [{ package: pkg, license: 'GPL-3.0-only', reason: 'x'.repeat(50) }],
        })
        for (const bad of ['*', 'a*', '*-lib', 'a*b*', '@x*y'])
            expect(policyProblems(withPackage(bad)), bad).toHaveLength(1)
        for (const good of ['lightningcss-*', '@img/sharp-libvips-*', 'exact-name']) {
            expect(policyProblems(withPackage(good)), good).toEqual([])
        }
    })

    it('holds every exception of the repository policy to a reason that is more than a word', () => {
        for (const e of policyFile.exceptions) expect(e.reason.length, e.package).toBeGreaterThan(40)
    })

    it('does not allow a copyleft, source-available or data licence outright: those are exceptions with reasons', () => {
        const risky = /GPL|MPL|EPL|CDDL|CC-BY|FSL|BUSL|SSPL|Elastic|Commons-Clause|UNLICENSED/i
        for (const id of policyFile.allowed) expect(id, 'allowed').not.toMatch(risky)
    })
})

describe('main', () => {
    const scratch = makeTestTmpDir('licence-scan-')
    const run = (report: unknown, policy: unknown = POLICY, extra: string[] = []) => {
        const reportPath = path.join(scratch, 'report.json')
        const policyPath = path.join(scratch, 'policy.json')
        writeFileSync(reportPath, JSON.stringify(report))
        writeFileSync(policyPath, JSON.stringify(policy))
        const out: string[] = []
        const err: string[] = []
        const code = main(['--report', reportPath, '--policy', policyPath, ...extra], {
            out: (l) => out.push(l),
            err: (l) => err.push(l),
        })
        return { code, out: out.join('\n'), err: err.join('\n') }
    }
    const sentry = { 'FSL-1.1-Apache-2.0': [{ name: 'sentry', versions: ['0.49.0'] }] }

    it('exits 0 and counts a clean report', () => {
        const r = run({ MIT: [{ name: 'a', versions: ['1'] }], ...sentry })
        expect(r.code).toBe(0)
        expect(r.out).toContain('2 packages, 0 not allowed, 1 covered by an exception')
    })

    it('exits 1 on a disallowed licence, naming the package and how to trace it', () => {
        const r = run({ ...sentry, 'GPL-3.0-only': [{ name: 'g', versions: ['2.0.0'] }] })
        expect(r.code).toBe(1)
        expect(r.err).toContain('g@2.0.0  GPL-3.0-only')
        expect(r.err).toContain('pnpm why -r g')
    })

    it('exits 1 on a stale exception', () => {
        const r = run({ MIT: [{ name: 'a', versions: ['1'] }] })
        expect(r.code).toBe(1)
        expect(r.err).toContain('sentry (FSL-1.1-Apache-2.0)')
    })

    it('exits 2, judging nothing, on an empty report, a malformed policy or an unknown flag', () => {
        expect(run({}).code).toBe(2)
        expect(run({ MIT: [{ name: 'a', versions: ['1'] }] }, { allowed: [] }).code).toBe(2)
        expect(run({ MIT: [{ name: 'a', versions: ['1'] }] }, POLICY, ['--nope']).code).toBe(2)
    })

    it('prints the count per licence with --summary', () => {
        const r = run({ MIT: [{ name: 'a', versions: ['1'] }], ...sentry }, POLICY, ['--summary'])
        expect(r.out).toMatch(/1 {2}MIT/)
    })
})

describe('the CLI', () => {
    it('is the script CI runs, from the repository root', () => {
        expect(readFileSync(path.join(ROOT, '.github/workflows/checks.yml'), 'utf8')).toContain(
            'node scripts/licence-scan.mjs',
        )
    })
})
