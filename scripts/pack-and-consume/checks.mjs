// The pure checks behind pack and consume (ADR-0014 P2), kept apart from the orchestration in
// scripts/pack-and-consume.mjs so tests/tooling/pack-and-consume.test.ts can drive each one with
// inputs that must fail.

import path from 'node:path'

/**
 * ADR-0014's strict-flag set (part 2): the options an adopter may turn on without breaking SSSB. A
 * flag that already gives no error in SSSB's source is in the set too, because the set is a promise.
 */
export const STRICT_FLAGS = [
    'noUncheckedIndexedAccess',
    'exactOptionalPropertyTypes',
    'noPropertyAccessFromIndexSignature',
    'erasableSyntaxOnly',
    'noUnusedLocals',
    'noUnusedParameters',
    'noImplicitReturns',
    'noImplicitOverride',
    'noFallthroughCasesInSwitch',
]

/**
 * The framework's seam-conformance suites, relative to the package root, that run from the tarball
 * against each app's own seam. `demo-presets-seam.test.ts` is the fifth, and is absent until P3 (the
 * workaround `demo-presets-seam-skipped`).
 */
export const CONFORMANCE_SUITES = [
    'src/i18n/namespaces.test.ts',
    'src/i18n/messages-parity.test.ts',
    'src/db/rls-pglite.test.ts',
    'src/db/migrate.test.ts',
]

/**
 * The manifest pin P1 left for this job: the seam is an optional peer declared in
 * `peerDependenciesMeta` ALONE. Listed in `peerDependencies` too, pnpm 11 requested it from the registry
 * (ADR-0014's acceptance addendum). Returns the problems; empty means the pin holds.
 * @param {{ name?: string, peerDependencies?: Record<string, string>, peerDependenciesMeta?: Record<string, { optional?: boolean }> }} manifest
 */
export function seamPeerProblems(manifest) {
    const problems = []
    if (manifest.name !== '@sssb/kit') problems.push(`the packed manifest is named ${manifest.name}, not @sssb/kit`)
    if (manifest.peerDependencies && '@sssb/app-config' in manifest.peerDependencies) {
        problems.push('@sssb/app-config is in peerDependencies, which makes pnpm fetch it from the registry')
    }
    if (manifest.peerDependenciesMeta?.['@sssb/app-config']?.optional !== true) {
        problems.push('@sssb/app-config is not an optional peer in peerDependenciesMeta')
    }
    return problems
}

/**
 * Every place pnpm's lockfile says where an `@sssb/*` package came from must be a tarball file
 * (`file:`) or a link (`link:`), never a registry version, so the job can never test an older published
 * SSSB and go green. `@sssb/app-config` must only ever be a link, and every other `@sssb` package a tarball (a
 * `link:` to the framework would be this repo's source, not the package). Line-based on purpose: it reads the
 * lockfile pnpm 11 writes (lockfileVersion 9) without a YAML dependency, and fails CLOSED on a shape it
 * does not recognise: an `@sssb/` line it cannot classify is a problem, not a pass.
 * @param {string} lockfile
 * @returns {{ problems: string[], seen: string[] }}
 */
export function lockfileProblems(lockfile) {
    /** @type {string[]} */
    const problems = []
    /** @type {string[]} */
    const seen = []
    const lines = lockfile.split('\n')
    let section = ''
    let group = ''
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i]
        const indent = /^ */.exec(line)?.[0].length ?? 0
        const where = `line ${i + 1} (${section}${group ? `.${group}` : ''})`
        if (indent === 0 && /^[A-Za-z]+:/.test(line)) {
            section = line.slice(0, line.indexOf(':'))
            group = ''
            continue
        }
        if (indent === 2) group = ''
        if (indent === 4 && /^\s+[A-Za-z]+:\s*$/.test(line)) group = line.trim().slice(0, -1)
        if (!line.includes('@sssb/')) continue

        // packages: and snapshots: are keyed `  '@sssb/kit@<version>':`, the snapshot key with peer suffixes.
        const key = indent === 2 ? /^ {2}'(@sssb\/[^@']+)@([^']+)':\s*$/.exec(line) : null
        if (key && (section === 'packages' || section === 'snapshots')) {
            seen.push(`${section}: ${key[1]}@${key[2].split('(')[0]}`)
            if (!isLocal(key[1], key[2])) problems.push(`${where}: ${key[1]}@${key[2]} is not a local tarball or link`)
            continue
        }
        // An importer's dependency, `      '@sssb/kit':` with its `specifier:` and `version:` below it.
        const importer = section === 'importers' && indent === 6 ? /^\s+'(@sssb\/[^']+)':\s*$/.exec(line) : null
        if (importer) {
            const version = lines
                .slice(i + 1, i + 3)
                .map((next) => /^ {8}version:\s*(\S+)/.exec(next)?.[1])
                .find(Boolean)
            seen.push(`importers: ${importer[1]} -> ${version?.split('(')[0]}`)
            if (!version) problems.push(`${where}: ${importer[1]} has no version line`)
            else if (!isLocal(importer[1], version)) problems.push(`${where}: ${importer[1]} resolves to ${version}`)
            continue
        }
        // The importer's own `specifier:`/`version:` lines (checked above, through the entry they belong to).
        if (section === 'importers' && indent === 8 && /^\s+(specifier|version):\s*(file:|link:)/.test(line)) continue
        // A snapshot's resolved dependency, `      '@sssb/app-config': link:apps/console/src/app-config`.
        const resolved = section === 'snapshots' && indent === 6 ? /^\s+'(@sssb\/[^']+)':\s*(\S+)\s*$/.exec(line) : null
        if (resolved) {
            seen.push(`snapshots: ${resolved[1]} -> ${resolved[2].split('(')[0]}`)
            if (!isLocal(resolved[1], resolved[2])) problems.push(`${where}: ${resolved[1]} resolves to ${resolved[2]}`)
            continue
        }
        // What a package DECLARES (its peers and their meta) is a range, not a resolution.
        if (section === 'packages' && (group === 'peerDependencies' || group === 'peerDependenciesMeta')) continue
        problems.push(`${where}: an @sssb line this check cannot classify: ${line.trim().slice(0, 200)}`)
    }
    return { problems, seen }
}

/**
 * @param {string} name
 * @param {string} version
 */
function isLocal(name, version) {
    // The seam is only ever the app's own link; every published package only ever a tarball file.
    if (name === '@sssb/app-config') return version.startsWith('link:')
    return version.startsWith('file:')
}

/**
 * Splits `tsc --pretty false` output into errors, each tagged by where it sits: inside the framework
 * package (`kit`) or anywhere else (`app`). The framework is recognised by its path in the virtual
 * store, so an app file that happens to be named like one cannot count as the framework's.
 * @param {string} output
 */
export function tscErrors(output) {
    /** @type {{ file: string, code: string, owner: 'kit' | 'app', text: string }[]} */
    const errors = []
    for (const line of output.split('\n')) {
        const match = /^(.+?)\(\d+,\d+\): error (TS\d+):/.exec(line)
        if (match) {
            const file = match[1].replaceAll('\\', '/')
            const owner = /node_modules\/(\.pnpm\/@sssb\+kit@[^/]+\/node_modules\/)?@sssb\/kit\//.test(file)
                ? 'kit'
                : 'app'
            errors.push({ file, code: match[2], owner, text: line })
        } else if (/error TS\d+:/.test(line)) {
            // A global error (a bad tsconfig, a missing lib) has no file; it is never the framework's.
            errors.push({ file: '', code: /TS\d+/.exec(line)?.[0] ?? 'TS?', owner: 'app', text: line })
        }
    }
    return errors
}

/**
 * Each app's conformance suites must have RUN, from that app's own copy of the package, with at least
 * one passing test and no failure; so must each test file of the app's own that the job relies on
 * (`requiredByApp`, absolute paths). A file that was filtered out, skipped whole or never collected is a
 * problem, so the gate cannot pass vacuously: Vitest exits 0 when some OTHER project ran tests.
 * @param {{ testResults?: { name: string, status?: string, assertionResults?: { status: string }[] }[] }} report Vitest's JSON report
 * @param {Record<string, string[]>} kitDirsByApp each app's spellings of its own @sssb/kit directory (symlinked and real)
 * @param {Record<string, string[]>} [requiredByApp]
 */
export function conformanceProblems(report, kitDirsByApp, requiredByApp = {}) {
    /** @type {string[]} */
    const problems = []
    const results = report.testResults ?? []
    const norm = (/** @type {string} */ file) => file.replaceAll('\\', '/')
    /**
     * @param {string} label
     * @param {string[]} spellings
     */
    const check = (label, spellings) => {
        const files = spellings.map(norm)
        const result = results.find((r) => files.includes(norm(r.name)))
        if (!result) {
            problems.push(`${label} did not run`)
            return
        }
        const statuses = (result.assertionResults ?? []).map((a) => a.status)
        const passed = statuses.filter((s) => s === 'passed').length
        const failed = statuses.filter((s) => s === 'failed').length
        if (failed > 0) problems.push(`${label} has ${failed} failing test(s)`)
        if (passed === 0) problems.push(`${label} ran no passing test (${statuses.join(', ') || 'none collected'})`)
    }
    for (const [app, kitDirs] of Object.entries(kitDirsByApp)) {
        for (const suite of CONFORMANCE_SUITES) {
            check(
                `${app}: ${suite} from the app's own @sssb/kit`,
                kitDirs.map((dir) => path.join(dir, suite)),
            )
        }
    }
    for (const [app, files] of Object.entries(requiredByApp)) {
        for (const file of files) check(`${app}: ${path.basename(file)}`, [file])
    }
    return problems
}

/**
 * The packages a framework source file imports that its manifest does not declare. pnpm's hidden hoist
 * (node_modules/.pnpm/node_modules) lends every package in the graph to every other, so an undeclared
 * import resolves in the consumer and the job stays green; an adopter whose graph lacks the package, or
 * who turns hoisting off, gets "cannot find module" inside node_modules/@sssb/kit. This reads the
 * source instead of trusting resolution. Test and story files are not the shipped surface, and are skipped.
 * @param {{ file: string, text: string }[]} sources
 * @param {{ dependencies?: Record<string, string>, peerDependencies?: Record<string, string>, peerDependenciesMeta?: Record<string, unknown>, name?: string }} manifest
 * @param {readonly string[]} builtins Node's builtin module names
 * @returns {Map<string, string[]>} package name -> the files that import it
 */
export function undeclaredImports(sources, manifest, builtins) {
    const declared = new Set([
        ...Object.keys(manifest.dependencies ?? {}),
        ...Object.keys(manifest.peerDependencies ?? {}),
        ...Object.keys(manifest.peerDependenciesMeta ?? {}),
        manifest.name ?? '',
    ])
    const builtin = new Set(builtins)
    /** @type {Map<string, string[]>} */
    const found = new Map()
    // A module specifier has no whitespace, quote, brace or `$`: that keeps a word "from" in a JSX string
    // or a template literal building a specifier from reading as an import.
    const specifier = /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+|\brequire\s*\(\s*)['"]([^'"\s`${}()]+)['"]/g
    for (const { file, text } of sources) {
        if (/\.(test|stories)\.[cm]?[jt]sx?$/.test(file)) continue
        // Comments mention modules in prose (a doc example's `from '…'`); strip them before scanning.
        const code = text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1')
        for (const match of code.matchAll(specifier)) {
            const spec = match[1] ?? ''
            if (spec.startsWith('.') || spec.startsWith('/') || spec.startsWith('node:')) continue
            const parts = spec.split('/')
            const name = spec.startsWith('@') ? parts.slice(0, 2).join('/') : (parts[0] ?? spec)
            if (builtin.has(name) || declared.has(name)) continue
            found.set(name, [...(found.get(name) ?? []), file])
        }
    }
    return found
}
