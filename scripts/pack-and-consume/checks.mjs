// The pure checks behind pack and consume (ADR-0014 P2), kept apart from the orchestration in
// scripts/pack-and-consume.mjs so tests/tooling/pack-and-consume.test.ts can drive each one with
// inputs that must fail.

import { createHash } from 'node:crypto'
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

        // An adopter's `overrides` of an @sssb package, which pnpm records: `  '@sssb/kit': file:/…/sssb-kit-0.1.0.tgz`.
        // The generator no longer writes any (no SSSB package depends on another); one that sends a package anywhere
        // but a local tarball is still a problem.
        const override =
            section === 'overrides' && indent === 2 ? /^ {2}'(@sssb\/[^']+)':\s*(\S+)\s*$/.exec(line) : null
        if (override) {
            seen.push(`overrides: ${override[1]} -> ${override[2]}`)
            if (override[1] === '@sssb/app-config' || !isLocal(override[1], override[2]))
                problems.push(`${where}: ${override[1]} is overridden to ${override[2]}, not a local tarball`)
            continue
        }
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
 * The packed @sssb/cdk: named so, depending on no framework (ADR-0014 rule 4), taking `@sssb/tools` as a PEER at
 * exactly its own version (the fixed group's lockstep, which the pack resolved from `workspace:*`), shipping
 * JavaScript, declarations and its Lambda placeholder asset, and no test. A peer, never a dependency: a package
 * installed by URL that depends on another by version makes pnpm look for it in the registry, which has no release
 * candidate, or, overridden to its URL, refuse it as an exotic subdependency (`blockExoticSubdeps`, on by default in
 * pnpm 11). As a peer it resolves to the `@sssb/tools` the adopter's package installs itself. Returns the problems.
 * @param {Record<string, unknown>} manifest
 * @param {readonly string[]} files every file in the package, relative to its root, `/`-separated
 */
export function cdkPackProblems(manifest, files) {
    const problems = []
    if (manifest.name !== '@sssb/cdk') problems.push(`the packed manifest is named ${manifest.name}, not @sssb/cdk`)
    for (const field of /** @type {const} */ ([
        'dependencies',
        'peerDependencies',
        'optionalDependencies',
        'peerDependenciesMeta',
    ])) {
        const deps = /** @type {Record<string, string> | undefined} */ (manifest[field]) ?? {}
        for (const [dep, range] of Object.entries(deps)) {
            if (dep === '@sssb/kit') problems.push(`${field} names @sssb/kit: @sssb/cdk depends on no framework`)
            // The peer's meta is checked below (it must not be optional).
            else if (dep === '@sssb/tools' && field === 'peerDependenciesMeta') continue
            else if (dep === '@sssb/tools' && field === 'dependencies') {
                problems.push(
                    'dependencies names @sssb/tools: it must be a peer, which an install by URL resolves to the ' +
                        "adopter's own copy, not a dependency, which it looks for in the registry",
                )
            } else if (dep.startsWith('@sssb/') && (field !== 'peerDependencies' || dep !== '@sssb/tools')) {
                problems.push(`${field} names ${dep}: @sssb/cdk's one SSSB peer is @sssb/tools`)
            } else if (dep === '@sssb/tools' && range !== manifest.version) {
                problems.push(
                    `@sssb/tools is ${range}, not exactly ${String(manifest.version)}: the set moves together`,
                )
            }
        }
    }
    const peers = /** @type {Record<string, string> | undefined} */ (manifest.peerDependencies) ?? {}
    if (!('@sssb/tools' in peers)) problems.push('peerDependencies does not name @sssb/tools, which @sssb/cdk imports')
    const meta = /** @type {Record<string, { optional?: boolean }> | undefined} */ (manifest.peerDependenciesMeta) ?? {}
    if (meta['@sssb/tools']?.optional) problems.push('@sssb/tools is an optional peer: @sssb/cdk cannot run without it')
    for (const file of files) {
        if (['package.json', 'README.md', 'LICENSE', 'CHANGELOG.md'].includes(file)) continue
        if (/\.test\.[cm]?[jt]sx?$/.test(file)) problems.push(`${file}: a test file is shipped`)
        else if (/^src\/assets\//.test(file)) continue
        else if (!/^src\/.*\.(js|d\.ts)$/.test(file))
            problems.push(`${file}: neither JavaScript nor a declaration in src/`)
    }
    if (!files.includes('src/index.js')) problems.push('src/index.js: the construct is not shipped')
    return problems
}

/**
 * The packed @sssb/eslint-plugin's manifest: named so, no dependency on any SSSB package (ADR-0014 rule 4), and ESLint a
 * peer, so the plugin runs inside the app's own ESLint. Returns the problems.
 * @param {Record<string, unknown>} manifest
 */
export function pluginManifestProblems(manifest) {
    const problems = []
    if (manifest.name !== '@sssb/eslint-plugin') {
        problems.push(`the packed manifest is named ${manifest.name}, not @sssb/eslint-plugin`)
    }
    for (const field of /** @type {const} */ ([
        'dependencies',
        'peerDependencies',
        'optionalDependencies',
        'peerDependenciesMeta',
    ])) {
        for (const dep of Object.keys(manifest[field] ?? {})) {
            if (dep.startsWith('@sssb/')) {
                problems.push(`${field} names ${dep}: @sssb/eslint-plugin depends on no SSSB package`)
            }
        }
    }
    const peers = /** @type {Record<string, string> | undefined} */ (manifest.peerDependencies)
    if (!peers?.eslint) problems.push("eslint is not a peer: the plugin must run inside the app's own ESLint")
    return problems
}

/**
 * What the packed @sssb/eslint-plugin may ship: JavaScript ESLint loads directly and its hand-written declarations
 * (ADR-0014 part 2), and no tests. Returns the problems.
 * @param {readonly string[]} files every file in the package, relative to its root, `/`-separated
 */
export function pluginShippedFileProblems(files) {
    const problems = []
    for (const file of files) {
        if (['package.json', 'README.md', 'LICENSE'].includes(file)) continue
        if (/\.test\.[cm]?[jt]sx?$/.test(file)) problems.push(`${file}: a test file is shipped`)
        else if (!file.startsWith('src/')) problems.push(`${file}: outside src/`)
        else if (!/\.(js|d\.ts)$/.test(file)) problems.push(`${file}: neither JavaScript nor a declaration file`)
    }
    for (const entry of ['src/index.js', 'src/check-fences.js']) {
        if (!files.includes(entry)) problems.push(`${entry}: an export's entry is not shipped`)
    }
    return problems
}

/**
 * The packed @sssb/create (ADR-0014 P12): named so, with its bin, no dependency at all (it runs before anything is
 * installed, and depends on no SSSB package, rule 4), shipping JavaScript under bin/ and src/ and the template its
 * prepack built (template/meta.json, the app under template/app/). What template/app/ holds, file by file, is
 * `templateAppProblems`'. Returns the problems.
 * @param {Record<string, unknown>} manifest
 * @param {readonly string[]} files every file in the package, relative to its root, `/`-separated
 */
export function createPackageProblems(manifest, files) {
    const problems = []
    if (manifest.name !== '@sssb/create')
        problems.push(`the packed manifest is named ${manifest.name}, not @sssb/create`)
    const bin = /** @type {Record<string, string> | undefined} */ (manifest.bin)
    if (typeof bin !== 'object' || bin === null || Object.values(bin).length === 0)
        problems.push('the packed manifest has no bin')
    for (const field of /** @type {const} */ (['dependencies', 'peerDependencies', 'optionalDependencies'])) {
        for (const dep of Object.keys(/** @type {Record<string, string>} */ (manifest[field] ?? {})))
            problems.push(`${field} names ${dep}: @sssb/create runs with no dependency installed`)
    }
    for (const file of files) {
        if (['package.json', 'README.md', 'LICENSE'].includes(file)) continue
        if (file.startsWith('template/')) continue
        else if (!/^(bin|src)\//.test(file)) problems.push(`${file}: outside bin/, src/ and template/`)
        else if (/\.test\.[cm]?[jt]sx?$/.test(file)) problems.push(`${file}: a test file is shipped`)
        else if (!/\.js$/.test(file)) problems.push(`${file}: not JavaScript`)
    }
    for (const entry of [
        'template/meta.json',
        'template/app/package.json',
        'template/app/src/sssb.conformance.test.ts',
    ])
        if (!files.includes(entry)) problems.push(`${entry}: the template is not packed whole`)
    for (const entry of Object.values(bin ?? {}))
        if (!files.includes(entry.replace(/^\.\//, ''))) problems.push(`${entry}: the bin is not shipped`)
    return problems
}

/**
 * The packed template's app (`template/app/`), file for file, against what the repository tracks under apps/starter
 * (`git ls-files apps/starter`) plus the files the template build itself writes there (`generated`): an allowlist, so
 * no checkout's local state (an env file, a build's output, a cache under a name nobody thought to deny) can reach an
 * adopter, and no tracked file of the starter can go missing. The template stores a leading `.` of a path segment as
 * `_dot_` (npm's packing drops some dotfiles); this compares the paths as the workspace gets them. Returns the problems.
 * @param {readonly string[]} files every file in the @sssb/create package, relative to its root, `/`-separated
 * @param {readonly string[]} tracked every file git tracks under apps/starter, relative to apps/starter
 * @param {readonly string[]} [generated] files the template build writes into template/app/, relative to it
 */
export function templateAppProblems(files, tracked, generated = []) {
    const fromStored = (/** @type {string} */ stored) =>
        stored
            .split('/')
            .map((segment) => (segment.startsWith('_dot_') ? `.${segment.slice('_dot_'.length)}` : segment))
            .join('/')
    /** Each packed app file as the workspace gets it, to the path the tarball stores it at. */
    const packed = new Map(
        files
            .filter((file) => file.startsWith('template/app/'))
            .map((file) => [fromStored(file.slice('template/app/'.length)), file]),
    )
    const expected = new Set([...tracked, ...generated])
    const problems = []
    for (const [file, stored] of [...packed].sort()) {
        if (!expected.has(file))
            problems.push(`${stored}: not a file git tracks under apps/starter (a checkout's local state?)`)
    }
    for (const file of [...expected].sort()) {
        if (!packed.has(file)) problems.push(`apps/starter/${file}: tracked, but not in the packed template`)
    }
    return problems
}

/** The packed @sssb packages a lockfile can name by tarball file. */
const SSSB_TARBALL_NAMES = '(kit|tools|eslint-plugin|cdk|create)'
/** The seed's stand-in for this run's tarball directory, an absolute path that differs between machines. */
export const SEED_TARBALLS = '__PACK_AND_CONSUME_TARBALLS__'
/** The seed's stand-in for the fixed group's version, which every release (and every release candidate) moves. */
export const SEED_VERSION = '__PACK_AND_CONSUME_VERSION__'

/** @param {string} text */
const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/**
 * Rewrites the version of every packed @sssb package a lockfile names: in each tarball's file name
 * (`sssb-kit-<version>.tgz`, in specifiers, overrides, keys and dependency edges) and in the `version:` line of each
 * one's `packages:` entry.
 * @param {string} text
 * @param {string} from
 * @param {string} to
 */
function swapSssbVersion(text, from, to) {
    const name = new RegExp(`(sssb-${SSSB_TARBALL_NAMES}-)${escapeRegExp(from)}(\\.tgz)`, 'g')
    let inSssbEntry = false
    return text
        .split('\n')
        .map((line) => {
            if (/^ {2}'@sssb\/(kit|tools|eslint-plugin|cdk|create)@file:/.test(line)) inSssbEntry = true
            else if (/^ {0,2}\S/.test(line)) inSssbEntry = false
            const renamed = line.replace(name, `$1${to}$3`)
            return inSssbEntry && renamed === `    version: ${from}` ? `    version: ${to}` : renamed
        })
        .join('\n')
}

/**
 * The committed seed made from an installed workspace's lockfile: this run's tarball directory and the fixed group's
 * version replaced by their tokens, so the seed matches the next run's workspace on any machine and at any version (a
 * release candidate packs `sssb-kit-0.2.0-rc.0.tgz`, and the seed still names the tarball the generator wrote).
 * @param {string} lockText
 * @param {{ tarballs: string, version: string }} run
 */
export function seedFromLockfile(lockText, { tarballs, version }) {
    return swapSssbVersion(lockText.replaceAll(tarballs, SEED_TARBALLS), version, SEED_VERSION)
}

/**
 * The seed as a workspace's pnpm-lock.yaml for this run: each token replaced by this run's tarball directory and the
 * version it packed. A seed written before the version was a token names a literal version, and is taken as it is.
 * @param {string} seed
 * @param {{ tarballs: string, version: string }} run
 */
export function lockfileFromSeed(seed, { tarballs, version }) {
    return swapSssbVersion(seed.replaceAll(SEED_TARBALLS, tarballs), SEED_VERSION, version)
}

/**
 * What would make a seed machine-specific: a path into this run's directory left in it after the tokens went in (a
 * workspace's absolute path pnpm recorded somewhere other than the tarballs'). Checked on every run, from the seed
 * this run's lockfile would make, not only when the seed is written, so a change that introduces one fails the PR that
 * makes it rather than the next refresh. Returns the problems.
 * @param {string} seed `seedFromLockfile` of the run's lockfile
 * @param {string} base this run's directory
 */
export function seedMachinePathProblems(seed, base) {
    return seed
        .split('\n')
        .map((line, i) => ({ line, at: i + 1 }))
        .filter(({ line }) => line.includes(base))
        .map(({ line, at }) => `line ${at} holds a path into this run's directory (${base}): ${line.trim()}`)
}

/**
 * Every gate a generated workspace's `pnpm verify` must run, so that it holds locally what the reusable workflow's
 * `sssb / all-checks` holds in CI (`sssb ci`'s jobs, plus knip and jscpd). Each is met by a root script verify
 * reaches (`scripts`) or by a command a reached script, or verify itself, runs (`commands`). `e2e` marks the gates
 * `--skip-build-and-e2e` leaves out.
 * @type {readonly { gate: string, scripts?: string[], commands?: string[], e2e?: boolean }[]}
 */
export const GENERATED_VERIFY_GATES = [
    { gate: 'typecheck', scripts: ['typecheck'] },
    { gate: 'lint', scripts: ['lint'] },
    { gate: 'unit tests', scripts: ['test:unit', 'test:coverage'] },
    { gate: 'knip', scripts: ['knip'] },
    { gate: 'jscpd', scripts: ['jscpd'] },
    { gate: 'doctor', scripts: ['sssb:doctor'], commands: ['sssb doctor'] },
    { gate: 'check-e2e', scripts: ['check:e2e'], commands: ['sssb check-e2e'] },
    { gate: 'check-fences', scripts: ['check-fences', 'check:fences'], commands: ['sssb check-fences'] },
    { gate: 'contract tests', scripts: ['test:contract'] },
    { gate: 'synth', scripts: ['synth'] },
    { gate: 'e2e', scripts: ['test:e2e'], e2e: true },
    { gate: 'static demo build', scripts: ['build:demo-static'], e2e: true },
    { gate: 'static demo size', scripts: ['check:demo-size'], e2e: true },
    { gate: 'static demo e2e', scripts: ['e2e:demo-static'], e2e: true },
]

/**
 * The root scripts a command runs, by name: `pnpm <script>`, `pnpm run <script>` and concurrently's `pnpm:<script>`,
 * counting only names the root defines (`pnpm --filter … <script>` runs another package's script, not the root's).
 * @param {string} command
 * @param {Record<string, string>} scripts
 */
function scriptsRunBy(command, scripts) {
    const names = []
    for (const match of command.matchAll(/(?:^|[\s'"&|;(])pnpm(?::|\s+(?:run\s+)?)([\w:.-]+)/g)) {
        const name = /** @type {string} */ (match[1])
        if (Object.hasOwn(scripts, name)) names.push(name)
    }
    return names
}

/**
 * A script as a shell sequences it: each quoted string ('…' or "…") blanked out, so that a `;` inside one (an argument:
 * a glob, a pattern, `node -e` code) is not read as a separator. Not when the script hands quoted text to another shell
 * (concurrently runs each of its arguments in one, as `sh -c` does), where a quoted `;` separates steps all the same:
 * then the script as it is.
 * @param {string} script
 */
const sequencedText = (script) =>
    /\bconcurrently\b|\b(?:ba|da|k|z)?sh\s+(?:-\w+\s+)*-\w*c\b/.test(script)
        ? script
        : script.replace(/'[^']*'|"(?:[^"\\]|\\.)*"/g, "''")

/**
 * The shell and runner forms that let a script exit 0 with a step failed or never run, so that naming a gate's script
 * is not running it: each with what it does. Deliberately plain text matches over the whole script, quoted or not,
 * except a `;` inside quotes where no other shell reads it (sequencedText): the generator writes none of them, and an
 * adopter's verify that needs one can say why in review.
 * @type {[{ test: (script: string) => boolean }, string][]}
 */
const SWALLOWING_FORMS = [
    [/\|\|/, '`||` (a failure before it is swallowed)'],
    [/(?<!\|)\|(?!\|)/, '`|` (a pipeline exits with its last command, so a failure before it is swallowed)'],
    [/[\n\r]/, 'a newline (each line runs whatever the one before returned)'],
    [{ test: (script) => sequencedText(script).includes(';') }, '`;` (the steps run whatever the one before returned)'],
    [/(?<![&>])&(?![&>])/, '`&` (a step put in the background is never waited for)'],
    [/--if-present/, '`--if-present` (a script that is missing passes)'],
    [
        /--success(?:=|\s+)(?!all\b)/,
        "concurrently's `--success` other than `all` (one step's exit code stands for all)",
    ],
    [/(?:^|[\s'"(&|])echo\b/, '`echo` (it prints a step instead of running it)'],
    [/(?:^|\s)#/, '`#` (the rest of the line is a comment)'],
    [
        {
            test: (script) =>
                script
                    .split(/[;&|\n\r]+/)
                    .some((command) => /--filter\b/.test(command) && !/--fail-if-no-match\b/.test(command)),
        },
        '`--filter` without `--fail-if-no-match` in the same command (a selector matching nothing passes)',
    ],
]

/**
 * How a generated workspace's `verify` meets each of `GENERATED_VERIFY_GATES`: the root scripts it reaches (through
 * any depth of scripts calling scripts), and for each gate the script that runs it (or `verify` itself, for a command
 * it runs inline). A gate verify does not reach is a problem: the generated required check would go green with that
 * gate dropped. So is a reached script holding one of SWALLOWING_FORMS, which can pass with a gate failed or not run.
 * Returns `{ problems, runBy }`, `runBy` mapping each gate met to the script that meets it.
 * @param {Record<string, string>} scripts the generated root package.json's scripts
 */
export function verifyGateProblems(scripts) {
    const problems = []
    /** @type {Map<string, string>} */
    const runBy = new Map()
    if (typeof scripts.verify !== 'string') return { problems: ['the root package.json has no verify script'], runBy }
    const reached = new Set()
    const queue = ['verify']
    while (queue.length > 0) {
        const script = /** @type {string} */ (queue.shift())
        if (reached.has(script)) continue
        reached.add(script)
        queue.push(...scriptsRunBy(/** @type {string} */ (scripts[script]), scripts))
    }
    for (const script of reached) {
        for (const [pattern, what] of SWALLOWING_FORMS)
            if (pattern.test(/** @type {string} */ (scripts[script]))) problems.push(`${script} uses ${what}`)
    }
    for (const { gate, scripts: names = [], commands = [] } of GENERATED_VERIFY_GATES) {
        const byName = names.find((name) => reached.has(name))
        const byCommand = [...reached].find((script) =>
            commands.some((command) =>
                new RegExp(`(?:^|[\\s'"&|;(])${escapeRegExp(command)}(?=$|[\\s'"&|;)])`).test(
                    /** @type {string} */ (scripts[script]),
                ),
            ),
        )
        const by = byName ?? byCommand
        if (by === undefined)
            problems.push(
                `verify does not run ${gate} (${[...names, ...commands].map((n) => `\`${n}\``).join(' or ')})`,
            )
        else runBy.set(gate, by)
    }
    return { problems, runBy }
}

/**
 * The root scripts `sssb ci lint-typecheck-unit` looks for to run the unit tests, the first one defined: the coverage
 * run when the workspace has one (@sssb/tools' ci.js, `rootScript(root, job, [...])`, which a test holds this to).
 */
export const CI_UNIT_SCRIPTS = ['test:coverage', 'test:unit']

/**
 * Every root script that runs a generated workspace's unit tests on the way to a green: the one its `verify` reaches
 * for the unit gate (`runBy`, from verifyGateProblems) and the one the reusable workflow's job runs (CI_UNIT_SCRIPTS),
 * once each. Each must be held to the conformance suite: holding a script nothing runs proves nothing.
 * @param {Record<string, string>} scripts
 * @param {Map<string, string>} runBy
 */
export function heldUnitScripts(scripts, runBy) {
    const ci = CI_UNIT_SCRIPTS.find((name) => typeof scripts[name] === 'string')
    return [...new Set([runBy.get('unit tests'), ci])].filter((name) => name !== undefined)
}

/**
 * THE GENERATED PINS AGREE (ADR-0014 P13): the generated workflow calls SSSB's reusable workflow at exactly one full
 * commit SHA; the generated `.claude/settings.json` declares exactly one marketplace from that repository, pinned to that
 * same commit, and enables the plugin (`<plugin>@<that marketplace>`) from it; the packed `@sssb/kit`'s release stamp
 * (`dist/release.json`) names that commit; and, once `doctorOutput` is given, `sssb doctor`'s pin report says they
 * match. Returns the commit (null when the workflow pins none) and the problems.
 * @param {{ workflow: string, settings: string, stamp: string | null, plugin: string, doctorOutput?: string }} input
 *   `workflow`: the generated checks.yml; `settings`: the generated .claude/settings.json; `stamp`: the kit tarball's
 *   dist/release.json, null when it has none; `plugin`: the plugin's name as its manifest gives it
 * @returns {{ commit: string | null, problems: string[] }}
 */
export function generatedPinProblems({ workflow, settings, stamp, plugin, doctorOutput }) {
    const problems = []
    const calls = [...workflow.matchAll(/uses: ([\w.-]+\/[\w.-]+)\/\.github\/workflows\/app-checks\.yml@(\S+)/g)]
    if (calls.length !== 1) {
        problems.push(`the generated workflow calls SSSB's reusable workflow ${calls.length} times, not once`)
        return { commit: null, problems }
    }
    const [, repository, commit] = /** @type {[string, string, string]} */ (/** @type {unknown} */ (calls[0]))
    if (!/^[0-9a-f]{40}$/.test(commit)) {
        problems.push(`the generated workflow pins ${repository}'s reusable workflow at ${commit}, not a commit SHA`)
        return { commit: null, problems }
    }

    /** @type {Record<string, any>} */
    let parsed = {}
    try {
        parsed = JSON.parse(settings)
    } catch (error) {
        problems.push(
            `the generated .claude/settings.json is not JSON: ${error instanceof Error ? error.message : error}`,
        )
    }
    const marketplaces = Object.entries(parsed.extraKnownMarketplaces ?? {}).filter(
        ([, entry]) => entry?.source?.source === 'github' && entry.source.repo === repository,
    )
    if (marketplaces.length !== 1)
        problems.push(
            `the generated .claude/settings.json declares ${marketplaces.length} marketplaces from ${repository}, not one`,
        )
    for (const [name, entry] of marketplaces) {
        if (entry.source.ref !== commit)
            problems.push(
                `the generated .claude/settings.json pins the marketplace ${name} at ${entry.source.ref}, not the workflow's ${commit}`,
            )
        if (parsed.enabledPlugins?.[`${plugin}@${name}`] !== true)
            problems.push(`the generated .claude/settings.json does not enable ${plugin}@${name}`)
    }

    /** @type {unknown} */
    let stamped
    try {
        stamped = stamp === null ? null : JSON.parse(stamp).commit
    } catch {
        stamped = null
    }
    if (stamped !== commit)
        problems.push(
            `the packed @sssb/kit's release stamp names ${stamped ?? 'no commit'}, not the generated pins' ${commit}`,
        )

    if (
        doctorOutput !== undefined &&
        !new RegExp(`^ok +workflow and plugin pins: .*release commit ${commit}$`, 'm').test(doctorOutput)
    )
        problems.push(`sssb doctor does not report the workflow and plugin pins as the kit's release commit ${commit}`)
    return { commit, problems }
}

/**
 * The environment `@sssb/create` and `@sssb/kit` are packed with. The generator's prepack refuses to pin a commit no
 * branch on GitHub holds, or a template (or the plugin it pins) that differs from that commit, and the kit's refuses a
 * release stamp naming a commit its shipped sources differ from, unless SSSB_CREATE_UNPUSHED_PIN=1. Only a push to SSSB's own repository
 * packs a pushed commit whose tarballs a release candidate may attach (checks.yml), so only it packs with the checks
 * on; a pull request's merge commit, a fork's push and a local run's HEAD are not on SSSB's GitHub, and their tarballs
 * never leave the run.
 * @param {Record<string, string | undefined>} env
 * @returns {Record<string, string>}
 */
export function createPackEnv(env) {
    return env.GITHUB_EVENT_NAME === 'push' && env.GITHUB_REPOSITORY === 'safeinsights/sssb'
        ? {}
        : { SSSB_CREATE_UNPUSHED_PIN: '1' }
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
            if (/^ {2}'@sssb\/(kit|tools|eslint-plugin|cdk)@/.test(line)) inSssbBlock = true
            else if (/^ {0,2}\S/.test(line)) inSssbBlock = false
            if (inSssbBlock || /sssb-(kit|tools|eslint-plugin|cdk)-/.test(line)) continue
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
 * The package versions a lockfile resolved that its seed does not hold: its `packages:` keys (`  name@version:`) less
 * the seed's, the packed SSSB packages' own left out. For a workspace whose importers are a SUBSET of the seed's, where
 * a line-by-line comparison also counts the flags pnpm moves when importers drop out (`optional: true`), this is what
 * says its resolution left the seed.
 * @param {string} seed
 * @param {string} lockfile
 */
export function packagesBeyondSeed(seed, lockfile) {
    /** @param {string} text */
    const keys = (text) => {
        /** @type {Set<string>} */
        const out = new Set()
        let section = ''
        for (const line of text.split('\n')) {
            if (/^[A-Za-z]+:/.test(line)) section = line.slice(0, line.indexOf(':'))
            else if (section === 'packages' && /^ {2}\S.*:\s*$/.test(line) && !/^ {2}'?@sssb\//.test(line))
                out.add(line.trim().replace(/^'|':$|:$/g, ''))
        }
        return out
    }
    const known = keys(seed)
    return [...keys(lockfile)].filter((key) => !known.has(key))
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

/**
 * The packument a registry serves for one packed package: its own `package/package.json` as the version's entry, plus
 * the `dist` an install reads (`integrity` and `shasum`, from the tarball's bytes) and the tarball's URL in the shape
 * npm's own registry uses (`<registry><name>/-/<unscoped name>-<version>.tgz`), which pnpm leaves out of the lockfile
 * as it does for npm's. `latest` is the version itself: a caret range on a prerelease matches it.
 * @template {{ name: string, version: string }} M
 * @param {M} manifest
 * @param {Buffer} bytes the tarball
 * @param {string} registry the registry's URL, ending in a slash
 */
export function registryPackument(manifest, bytes, registry) {
    const unscoped = manifest.name.replace(/^@[^/]+\//, '')
    const old = '2020-01-01T00:00:00.000Z' // long past any `minimumReleaseAge`
    return {
        name: manifest.name,
        'dist-tags': { latest: manifest.version },
        versions: {
            [manifest.version]: {
                ...manifest,
                dist: {
                    tarball: `${registry}${manifest.name}/-/${unscoped}-${manifest.version}.tgz`,
                    integrity: `sha512-${createHash('sha512').update(bytes).digest('base64')}`,
                    shasum: createHash('sha1').update(bytes).digest('hex'),
                },
            },
        },
        time: { created: old, modified: old, [manifest.version]: old },
    }
}

/**
 * The `@sssb/*` specifiers a generated workspace's manifests (read) carry: one per package, and a problem for each
 * package two manifests disagree about.
 * @param {Array<Record<string, any>>} manifests
 * @returns {{ specs: Record<string, string>, problems: string[] }}
 */
export function generatedSssbSpecs(manifests) {
    /** @type {Record<string, string>} */
    const specs = {}
    /** @type {string[]} */
    const problems = []
    for (const manifest of manifests) {
        for (const field of ['dependencies', 'devDependencies', 'peerDependencies']) {
            for (const [name, spec] of Object.entries(/** @type {Record<string, string>} */ (manifest[field] ?? {}))) {
                if (!name.startsWith('@sssb/') || spec.startsWith('workspace:')) continue
                if (specs[name] !== undefined && specs[name] !== spec)
                    problems.push(`${name} is ${specs[name]} in one manifest and ${spec} in another`)
                specs[name] = spec
            }
        }
    }
    return { specs, problems }
}

/**
 * What an install from a registry must have written for the `@sssb/*` packages: in the lockfile's `packages:` section,
 * each expected one resolved at exactly its packed version, with the tarball's own integrity and nothing else in its
 * resolution (a `tarball:` URL or `file:` is not a registry's), and no other `@sssb/` package there at all.
 * @param {string} lockfile
 * @param {Record<string, { version: string, integrity: string }>} expected by package name
 */
export function registryLockProblems(lockfile, expected) {
    const lines = lockfile.split('\n')
    /** @type {string[]} */
    const problems = []
    /** @type {Set<string>} */
    const seen = new Set()
    let section = ''
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i] ?? ''
        if (/^[A-Za-z]+:/.test(line)) section = line.slice(0, line.indexOf(':'))
        if (section !== 'packages' || !/^ {2}'?@sssb\//.test(line)) continue
        const key = line.trim().replace(/:$/, '').replace(/^'|'$/g, '')
        const name = key.slice(0, key.lastIndexOf('@'))
        const version = key.slice(key.lastIndexOf('@') + 1)
        const resolution = (lines[i + 1] ?? '').trim()
        const want = expected[name]
        seen.add(name)
        if (!want) problems.push(`${key}: not a package this run packed`)
        else if (version !== want.version)
            problems.push(`${key}: resolved at ${version}, not the packed ${want.version}`)
        else if (!/^resolution: \{integrity: sha512-[^,}\s]+\}$/.test(resolution))
            problems.push(`${key}: not a plain registry resolution (${resolution})`)
        else if (resolution !== `resolution: {integrity: ${want.integrity}}`)
            problems.push(`${key}: integrity is not the tarball's (${resolution})`)
    }
    for (const name of Object.keys(expected))
        if (!seen.has(name)) problems.push(`${name}: no registry resolution in the lockfile`)
    return problems
}
