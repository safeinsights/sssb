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
 * What the conformance suite an app runs (`@sssb/kit/testing`, ADR-0014 P5) needs from the tarball besides its
 * modules: the registry of its checks, which `sssb doctor` reads without loading the kit, and the seam specifiers
 * its `seam-map` check resolves. The suite's modules are source and ship with `src`; a test file never ships.
 */
export const CONFORMANCE_DATA = ['src/testing/checks.json', 'src/testing/seam-specifiers.json']

/**
 * What the packed framework must not ship: a test or story file, or anything of the test fixture (ADR-0014 part 2,
 * "a `files` allowlist"); and what it must: the conformance suite's data (`CONFORMANCE_DATA`). Returns the problems;
 * empty means the tarball holds only what an adopter needs, and that.
 * @param {readonly string[]} files every file in the package, relative to its root, `/`-separated
 */
export function shippedFileProblems(files) {
    const problems = []
    for (const file of files) {
        if (file.startsWith('test-fixture/')) problems.push(`${file}: the test fixture is shipped`)
        else if (/\.(test|stories)\.[cm]?[jt]sx?$/.test(file)) problems.push(`${file}: a test or story file is shipped`)
    }
    for (const file of CONFORMANCE_DATA)
        if (!files.includes(file)) problems.push(`${file}: the conformance suite's data is not shipped`)
    return problems
}

/**
 * The manifest shape P1 chose: the seam is an optional peer declared in `peerDependenciesMeta` ALONE.
 * Listed in `peerDependencies` too, pnpm 11 requested it from the registry when installing THIS repo's
 * workspace (ADR-0014's acceptance addendum); a consumer installing the tarball did not (docs/decision-log.md,
 * "Pack and consume"). A consumer does fetch a seam that is not optional at all, and the job's dead `@sssb`
 * registry turns that into a failed install. Returns the problems; empty means the shape holds.
 * @param {{ name?: string, peerDependencies?: Record<string, string>, peerDependenciesMeta?: Record<string, { optional?: boolean }> }} manifest
 */
export function seamPeerProblems(manifest) {
    const problems = []
    if (manifest.name !== '@sssb/kit') problems.push(`the packed manifest is named ${manifest.name}, not @sssb/kit`)
    if (manifest.peerDependencies && '@sssb/app-config' in manifest.peerDependencies) {
        problems.push(
            "@sssb/app-config is in peerDependencies, which makes pnpm fetch it from the registry in this repo's own install",
        )
    }
    if (manifest.peerDependenciesMeta?.['@sssb/app-config']?.optional !== true) {
        problems.push('@sssb/app-config is not an optional peer in peerDependenciesMeta')
    }
    return problems
}

/**
 * Every place pnpm's lockfile says where an `@sssb/*` package came from must be local, never a registry
 * version, so the job can never test an older published SSSB and go green. `@sssb/app-config` must only ever be a link, and every other `@sssb` package a tarball (a
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
 * The full name of every test one runner registers for an app with no opt-outs, as `vitest list` and the suite itself
 * spell it (`[sssb:<id>] <title> > <test>`), from the packed `@sssb/kit/testing/checks.json`: the conformance suite's
 * (`unit`, the default) or the contract runner's (`contract`, `@sssb/kit/testing/contract`).
 * @param {{ checks: { id: string, runner: string, title: string, tests: string[] }[] }} registry
 * @param {'unit' | 'contract'} [runner]
 */
export function expectedConformanceTests(registry, runner = 'unit') {
    return registry.checks
        .filter((check) => check.runner === runner)
        .flatMap((check) => check.tests.map((test) => `[sssb:${check.id}] ${check.title} > ${test}`))
}

/**
 * Each app's conformance file (`src/sssb.conformance.test.ts`, which calls `@sssb/kit/testing`) must have RUN and
 * passed EVERY check the suite registers, by name (`expectedTests`), with the file itself not failed (the suite's
 * skip guard fails the file); so must each test file of the app's own that the job relies on (`requiredByApp`,
 * absolute paths), with at least one passing test and no failure. A file that was filtered out, skipped whole or never
 * collected is a problem, so the gate cannot pass vacuously: Vitest exits 0 when some OTHER project ran tests.
 * @param {{ testResults?: { name: string, status?: string, assertionResults?: { status: string, title?: string, ancestorTitles?: string[] }[] }[] }} report Vitest's JSON report
 * @param {Record<string, string>} conformanceFileByApp each app's conformance file, absolute
 * @param {readonly string[]} expectedTests `expectedConformanceTests` of the packed registry
 * @param {Record<string, string[]>} [requiredByApp]
 */
export function conformanceProblems(report, conformanceFileByApp, expectedTests, requiredByApp = {}) {
    /** @type {string[]} */
    const problems = []
    const results = report.testResults ?? []
    const norm = (/** @type {string} */ file) => file.replaceAll('\\', '/')
    /** @param {string} file */
    const resultFor = (file) => results.find((r) => norm(r.name) === norm(file))
    for (const [app, file] of Object.entries(conformanceFileByApp)) {
        const result = resultFor(file)
        if (!result) {
            problems.push(`${app}: ${path.basename(file)} did not run`)
            continue
        }
        if (result.status === 'failed') problems.push(`${app}: ${path.basename(file)} failed`)
        /** @type {Map<string, string>} */
        const statusByName = new Map(
            (result.assertionResults ?? []).map((a) => [
                [...(a.ancestorTitles ?? []), a.title ?? ''].join(' > '),
                a.status,
            ]),
        )
        for (const name of expectedTests) {
            const status = statusByName.get(name)
            if (status !== 'passed') problems.push(`${app}: ${name} ${status ?? 'did not run'}`)
        }
    }
    for (const [app, files] of Object.entries(requiredByApp)) {
        for (const file of files) {
            const label = `${app}: ${path.basename(file)}`
            const result = resultFor(file)
            if (!result) {
                problems.push(`${label} did not run`)
                continue
            }
            const statuses = (result.assertionResults ?? []).map((a) => a.status)
            const passed = statuses.filter((s) => s === 'passed').length
            const failed = statuses.filter((s) => s === 'failed').length
            if (failed > 0) problems.push(`${label} has ${failed} failing test(s)`)
            if (passed === 0) problems.push(`${label} ran no passing test (${statuses.join(', ') || 'none collected'})`)
        }
    }
    return problems
}

/**
 * The packages a framework source file imports that its manifest does not declare. pnpm's hidden hoist
 * (node_modules/.pnpm/node_modules) lends every package in the graph to every other, so an undeclared
 * import resolves in the consumer and the job stays green; an adopter whose graph lacks the package, or
 * who turns hoisting off, gets "cannot find module" inside node_modules/@sssb/kit. This reads the
 * source instead of trusting resolution. Test and story files are not the shipped surface, and are skipped
 * (the conformance suite at `@sssb/kit/testing` is source, and is read). The specifiers come from `specifiersOf`, which the job backs
 * with TypeScript's own `preProcessFile`, so comments, strings and template literals cannot hide an
 * import or invent one.
 * @param {{ file: string, text: string }[]} sources
 * @param {{ dependencies?: Record<string, string>, peerDependencies?: Record<string, string>, peerDependenciesMeta?: Record<string, unknown>, name?: string }} manifest
 * @param {readonly string[]} builtins Node's builtin module names
 * @param {(text: string) => string[]} specifiersOf every module specifier a file imports, exports from or requires
 * @returns {Map<string, string[]>} package name -> the files that import it
 */
export function undeclaredImports(sources, manifest, builtins, specifiersOf) {
    const declared = new Set([
        ...Object.keys(manifest.dependencies ?? {}),
        ...Object.keys(manifest.peerDependencies ?? {}),
        ...Object.keys(manifest.peerDependenciesMeta ?? {}),
        manifest.name ?? '',
    ])
    const builtin = new Set(builtins)
    /** @type {Map<string, string[]>} */
    const found = new Map()
    for (const { file, text } of sources) {
        if (/\.(test|stories)\.[cm]?[jt]sx?$/.test(file)) continue
        for (const spec of specifiersOf(text)) {
            if (spec.startsWith('.') || spec.startsWith('/') || spec.startsWith('node:')) continue
            const parts = spec.split('/')
            const name = spec.startsWith('@') ? parts.slice(0, 2).join('/') : (parts[0] ?? spec)
            if (builtin.has(name) || declared.has(name)) continue
            found.set(name, [...(found.get(name) ?? []), file])
        }
    }
    return found
}

/**
 * The integrities pnpm recorded for one SSSB package's tarballs (`@sssb/kit`, `@sssb/tools`) in the lockfile's
 * `packages:` section.
 * @param {string} lockfile
 * @param {string} [name]
 */
export function tarballIntegrities(lockfile, name = '@sssb/kit') {
    const lines = lockfile.split('\n')
    /** @type {string[]} */
    const found = []
    let section = ''
    const key = `  '${name}@file:`
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i] ?? ''
        if (/^[A-Za-z]+:/.test(line)) section = line.slice(0, line.indexOf(':'))
        if (section !== 'packages' || !line.startsWith(key)) continue
        const integrity = /integrity: (sha512-[A-Za-z0-9+/=]+)/.exec(lines[i + 1] ?? '')?.[1]
        found.push(integrity ?? '(no integrity)')
    }
    return found
}

/**
 * What the packed @sssb/tools must be (ADR-0014 rule 4 and part 2): named so, carrying the `sssb` bin, and taking
 * no SSSB package at all, in any dependency field. It reaches the framework only from the app's directory, so a
 * dependency on @sssb/kit would be a second instance waiting to be loaded by mistake. Returns the problems.
 * @param {{ name?: string, bin?: unknown, dependencies?: Record<string, string>, peerDependencies?: Record<string, string>, optionalDependencies?: Record<string, string>, peerDependenciesMeta?: Record<string, unknown> }} manifest
 */
export function toolsManifestProblems(manifest) {
    const problems = []
    if (manifest.name !== '@sssb/tools') problems.push(`the packed manifest is named ${manifest.name}, not @sssb/tools`)
    const bin = /** @type {Record<string, string> | undefined} */ (manifest.bin)
    if (typeof bin !== 'object' || bin === null || typeof bin['sssb'] !== 'string')
        problems.push('the packed manifest has no `sssb` bin')
    for (const field of /** @type {const} */ ([
        'dependencies',
        'peerDependencies',
        'optionalDependencies',
        'peerDependenciesMeta',
    ])) {
        for (const dep of Object.keys(manifest[field] ?? {})) {
            if (dep.startsWith('@sssb/')) problems.push(`${field} names ${dep}: @sssb/tools depends on no SSSB package`)
        }
    }
    return problems
}

/**
 * What the packed @sssb/tools may ship: JavaScript Node loads directly, its hand-written declarations and the
 * tsconfig base (ADR-0014 part 2: "every other package ships JavaScript"), and no tests. Returns the problems.
 * @param {readonly string[]} files every file in the package, relative to its root, `/`-separated
 */
export function toolsShippedFileProblems(files) {
    const problems = []
    for (const file of files) {
        if (['package.json', 'tsconfig.base.json', 'README.md', 'LICENSE'].includes(file)) continue
        if (/\.test\.[cm]?[jt]sx?$/.test(file)) problems.push(`${file}: a test file is shipped`)
        else if (!/^(bin|src)\//.test(file)) problems.push(`${file}: outside bin/ and src/`)
        else if (!/\.(js|mjs|d\.ts)$/.test(file)) problems.push(`${file}: neither JavaScript nor a declaration file`)
    }
    if (!files.includes('bin/sssb.js')) problems.push('bin/sssb.js: the CLI is not shipped')
    return problems
}

/**
 * How far a lockfile moved from its seed, leaving out the packed SSSB packages' own entries (a tarball's name,
 * integrity and version change with every build or release, and are this run's to change). Lines are
 * compared as a multiset, so an edge that moves to a line some other entry already has still counts.
 * @param {string} seed
 * @param {string} lockfile
 */
export function lockfileMoves(seed, lockfile) {
    /** @param {string} text */
    const lines = (text) => {
        /** @type {Map<string, number>} */
        const counts = new Map()
        let inSssbBlock = false
        for (const line of text.split('\n')) {
            // A `packages:` or `snapshots:` entry for a packed SSSB package: its key and every line indented under it.
            if (/^ {2}'@sssb\/(kit|tools)@/.test(line)) inSssbBlock = true
            else if (/^ {0,2}\S/.test(line)) inSssbBlock = false
            if (inSssbBlock || /sssb-(kit|tools)-/.test(line)) continue
            counts.set(line, (counts.get(line) ?? 0) + 1)
        }
        return counts
    }
    const before = lines(seed)
    const after = lines(lockfile)
    let added = 0
    let removed = 0
    for (const [line, n] of after) added += Math.max(0, n - (before.get(line) ?? 0))
    for (const [line, n] of before) removed += Math.max(0, n - (after.get(line) ?? 0))
    return { added, removed }
}

/**
 * What `sssb check-e2e` must say in the consumer's console app, which carries a spec that reaches the framework through
 * `@sssb/kit/testing/e2e` (ADR-0014 part 7): exit 0, the entry resolved through the INSTALLED exports map to the
 * compiled `dist/testing/e2e.js` (not in-repo mode), and that spec checked and seen reaching the kit through it. So a
 * green run cannot be a vacuous one that checked no such spec.
 * @param {{ status: number | null, stdout: string }} result
 * @param {string} spec the spec's path relative to the app
 */
export function checkE2eOkProblems(result, spec) {
    const problems = []
    if (result.status !== 0) problems.push(`sssb check-e2e exited ${result.status}, not 0`)
    const head = result.stdout.split('\n').find((line) => line.startsWith('sssb check-e2e: ') && line.includes(' is '))
    if (head === undefined) problems.push('sssb check-e2e printed no line naming what @sssb/kit/testing/e2e is')
    else {
        if (!head.includes('@sssb/kit/testing/e2e is @sssb/kit:dist/testing/e2e.js'))
            problems.push(`@sssb/kit/testing/e2e is not the compiled dist/testing/e2e.js: ${head}`)
        if (head.includes('in-repo mode'))
            problems.push(`sssb check-e2e took the tarball's kit for SSSB's own: ${head}`)
    }
    const ok = `ok      ${spec}  (reaches the kit through @sssb/kit/testing/e2e)`
    if (!result.stdout.split('\n').includes(ok)) problems.push(`sssb check-e2e did not report "${ok}"`)
    return problems
}

/**
 * What `sssb check-e2e` must say once a spec reaching the framework's source is dropped into the app. In the consumer
 * that source is TypeScript under node_modules, which Node will not load, so Playwright cannot even list the config
 * the spec belongs to: exit 1, a FAIL line for that config, and under it, on an indented line, the kit file
 * Playwright's error names, reached other than through `@sssb/kit/testing/e2e`.
 * @param {{ status: number | null, stdout: string }} result
 * @param {{ config: string, kitFile: string }} expected the config relative to the app, and the kit file as shown
 */
export function checkE2eFailProblems(result, { config, kitFile }) {
    const problems = []
    if (result.status !== 1) problems.push(`sssb check-e2e exited ${result.status}, not 1`)
    const lines = result.stdout.split('\n')
    const at = lines.findIndex((line) => line.startsWith(`FAIL    ${config} could not be listed by Playwright `))
    if (at < 0) {
        problems.push(`sssb check-e2e did not fail ${config} as one Playwright cannot list`)
        return problems
    }
    /** @type {string[]} */
    const detail = []
    for (const line of lines.slice(at + 1)) {
        if (!line.startsWith('          ')) break
        detail.push(line.trim())
    }
    if (!detail.includes(`a file Playwright loads reaches ${kitFile}, other than through @sssb/kit/testing/e2e`))
        problems.push(`sssb check-e2e failed ${config} without naming ${kitFile}`)
    return problems
}
