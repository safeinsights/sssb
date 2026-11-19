#!/usr/bin/env node
// The licence scan: judges the licences of the dependency closure an adopter inherits against
// `.github/licence-policy.json`. CI's `licence-scan` job runs it (docs/decision-log.md, "Licence scan").
//
//   node scripts/licence-scan.mjs [--policy <file>] [--report <file>] [--summary]
//
//   --policy <file>  a policy other than `.github/licence-policy.json`
//   --report <file>  judge a saved `pnpm licenses list --json` instead of running pnpm (the tests, and a probe
//                    that needs no install)
//   --summary        print the count per licence as well, whether or not the scan passes
//
// The licences come from `pnpm licenses list --json`, which reads the installed `node_modules`: what this machine's
// install holds, so per-platform native packages are judged on the platform that runs the scan (CI's Linux), and
// the install must come first (`pnpm install --frozen-lockfile --ignore-scripts` is enough).
//
// Fails (exit 1) on:
//   - a package whose licence the policy does not allow and no exception covers, an unknown or missing licence
//     included. An exception names the package and the licence it carries, so a version bump that changes the
//     licence fails again;
//   - an exception that matches nothing (it rots otherwise), unless it is marked `platform` (a native binary that
//     exists on some platforms only);
//   - a policy that is not well formed.
//
// DEPENDENCY-FREE: plain Node, loaded directly.
import { execFileSync } from 'node:child_process'
import { readFileSync, realpathSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
export const DEFAULT_POLICY = path.join(ROOT, '.github/licence-policy.json')

/** Splits an SPDX expression into identifiers, `AND`, `OR` and parentheses. */
function tokens(expression) {
    return expression.match(/\(|\)|[^\s()]+/g) ?? []
}

/**
 * Whether an SPDX licence expression is satisfied by the allowed identifiers: `A OR B` by either side, `A AND B`
 * by both. An empty, unparsable or `WITH` expression is not satisfied (an exception decides those).
 * @param {string} expression
 * @param {ReadonlySet<string>} allowed
 */
export function satisfies(expression, allowed) {
    const list = tokens(String(expression ?? ''))
    let at = 0
    const peek = () => list[at]
    const orExpr = () => {
        let ok = andExpr()
        while (peek() === 'OR') {
            at++
            const right = andExpr()
            ok = ok || right
        }
        return ok
    }
    const andExpr = () => {
        let ok = atom()
        while (peek() === 'AND') {
            at++
            const right = atom()
            ok = ok && right
        }
        return ok
    }
    const atom = () => {
        const token = list[at++]
        if (token === undefined) throw new Error('unexpected end')
        if (token === '(') {
            const ok = orExpr()
            if (list[at++] !== ')') throw new Error('missing )')
            return ok
        }
        if (token === ')' || token === 'AND' || token === 'OR') throw new Error(`unexpected ${token}`)
        return allowed.has(token)
    }
    try {
        const ok = orExpr()
        return at === list.length && ok
    } catch {
        return false
    }
}

/** A package name matches an exception's `package`: exactly, or by a prefix when it ends in `*`. */
function nameMatches(pattern, name) {
    return pattern.endsWith('*') ? name.startsWith(pattern.slice(0, -1)) : name === pattern
}

/** The problems with the policy's own shape, as strings. */
export function policyProblems(policy) {
    const problems = []
    const isRecord = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)
    if (!isRecord(policy)) return ['the policy is not an object']
    const strings = (v) => Array.isArray(v) && v.every((s) => typeof s === 'string' && s.trim() !== '')
    if (!strings(policy.allowed) || policy.allowed.length === 0) problems.push('`allowed` is not a list of identifiers')
    if (!Array.isArray(policy.exceptions)) problems.push('`exceptions` is not a list')
    if (!isRecord(policy.scope) || !strings(policy.scope.exclude) || !policy.scope.reason?.trim()) {
        problems.push('`scope` needs an `exclude` list of workspace project names and a `reason`')
    }
    for (const [i, e] of (Array.isArray(policy.exceptions) ? policy.exceptions : []).entries()) {
        const where = `exceptions[${i}]`
        if (!isRecord(e)) problems.push(`${where} is not an object`)
        else {
            if (typeof e.package !== 'string' || e.package === '') problems.push(`${where} has no \`package\``)
            else if (e.package.includes('*') && !/^[^*]{4,}\*$/.test(e.package)) {
                problems.push(`${where}.package may use \`*\` only as the last character, after at least four others`)
            }
            if (typeof e.license !== 'string' || e.license === '') problems.push(`${where} has no \`license\``)
            if (typeof e.reason !== 'string' || e.reason.trim() === '') problems.push(`${where} has no \`reason\``)
            if (e.platform !== undefined && typeof e.platform !== 'boolean')
                problems.push(`${where}.platform is not a boolean`)
        }
    }
    return problems
}

/**
 * Judges a `pnpm licenses list --json` report ({ [licence]: [{ name, versions }] }) against a policy.
 * @returns {{ violations: { license: string, name: string, versions: string[] }[], stale: string[], counts: Record<string, number>, excepted: number }}
 */
export function evaluate(report, policy) {
    const allowed = new Set(policy.allowed)
    const used = new Set()
    const violations = []
    const counts = {}
    let excepted = 0
    for (const [license, packages] of Object.entries(report)) {
        counts[license] = packages.length
        if (satisfies(license, allowed)) continue
        for (const pkg of packages) {
            const index = policy.exceptions.findIndex((e) => e.license === license && nameMatches(e.package, pkg.name))
            if (index >= 0) {
                used.add(index)
                excepted++
            } else violations.push({ license, name: pkg.name, versions: pkg.versions ?? [] })
        }
    }
    violations.sort((a, b) => a.license.localeCompare(b.license) || a.name.localeCompare(b.name))
    const stale = policy.exceptions
        .map((e, i) => ({ e, i }))
        .filter(({ e, i }) => !used.has(i) && !e.platform)
        .map(({ e }) => `${e.package} (${e.license})`)
    return { violations, stale, counts, excepted }
}

/** `pnpm licenses list --json` over the workspace less the policy's excluded projects. */
function runPnpm(policy) {
    const filters = policy.scope.exclude.flatMap((project) => ['--filter', `!${project}`])
    let out
    try {
        out = execFileSync('pnpm', [...filters, 'licenses', 'list', '--json'], {
            cwd: ROOT,
            encoding: 'utf8',
            maxBuffer: 1 << 28,
            stdio: ['ignore', 'pipe', 'inherit'],
        })
    } catch (error) {
        throw new Error(`\`pnpm licenses list\` failed (is the workspace installed?): ${error.message}`, {
            cause: error,
        })
    }
    return JSON.parse(out)
}

/**
 * @param {string[]} argv
 * @param {{ out?: (line: string) => void, err?: (line: string) => void }} [io]
 * @returns {number} the exit code
 */
export function main(argv, io = {}) {
    const out = io.out ?? ((line) => console.log(line))
    const err = io.err ?? ((line) => console.error(line))
    let policyFile = DEFAULT_POLICY
    let reportFile
    let summary = false
    for (let i = 0; i < argv.length; i++) {
        if (argv[i] === '--policy') policyFile = path.resolve(argv[++i] ?? '')
        else if (argv[i] === '--report') reportFile = path.resolve(argv[++i] ?? '')
        else if (argv[i] === '--summary') summary = true
        else {
            err(`licence-scan: unknown argument ${argv[i]}`)
            return 2
        }
    }
    let policy
    try {
        policy = JSON.parse(readFileSync(policyFile, 'utf8'))
    } catch (error) {
        err(`licence-scan: cannot read the policy ${policyFile}: ${error.message}`)
        return 2
    }
    const bad = policyProblems(policy)
    if (bad.length > 0) {
        err(`licence-scan: ${policyFile} is not well formed:\n  ${bad.join('\n  ')}`)
        return 2
    }
    let report
    try {
        report = reportFile ? JSON.parse(readFileSync(reportFile, 'utf8')) : runPnpm(policy)
    } catch (error) {
        err(`licence-scan: ${error.message}`)
        return 2
    }
    const total = Object.values(report).reduce((n, list) => n + list.length, 0)
    if (total === 0) {
        err('licence-scan: the report holds no packages, so nothing was judged')
        return 2
    }
    const { violations, stale, counts, excepted } = evaluate(report, policy)
    if (summary) {
        for (const [license, n] of Object.entries(counts).sort((a, b) => b[1] - a[1]))
            out(`${String(n).padStart(5)}  ${license}`)
    }
    out(
        `licence-scan: ${total} packages, ${violations.length} not allowed, ${excepted} covered by an exception` +
            ` (${path.relative(ROOT, policyFile) || policyFile})`,
    )
    if (violations.length === 0 && stale.length === 0) return 0
    if (violations.length > 0) {
        err('\nLicences the policy does not allow:')
        for (const v of violations) {
            err(`  ${v.name}@${v.versions.join(',')}  ${v.license || '(none)'}   why: pnpm why -r ${v.name}`)
        }
        err(
            '\nRemove or replace the dependency, or, if an adopter can use it, add an entry to `exceptions` in the policy\n' +
                'with the package, the licence it carries and the reason (`allowed` takes a licence for every package).',
        )
    }
    if (stale.length > 0) {
        err(
            '\nExceptions that match no installed package (delete them, or mark a per-platform binary `"platform": true`):',
        )
        for (const s of stale) err(`  ${s}`)
    }
    return 1
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
    process.exitCode = main(process.argv.slice(2))
}
