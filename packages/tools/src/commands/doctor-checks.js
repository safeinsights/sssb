// @ts-check
// The checks behind `sssb doctor` (ADR-0014 part 5), apart from the command that runs and prints them, so a test can
// drive each one over a workspace built on disk or a `vitest list` sample. Each returns its problems as sentences that
// name what is wrong; empty means the check holds. Nothing here loads the framework: what it needs of `@sssb/kit` (its
// peers, its check registry, its cutover rows) is read as data from the copy the APP resolves (rule 4, ../kit.js).
import { existsSync, globSync, readdirSync, readFileSync, realpathSync } from 'node:fs'
import path from 'node:path'
import { readJson } from '../app.js'

const KIT = '@sssb/kit'
const SEAM = '@sssb/app-config'

/** The dependency fields that make a package an importer of a package (a peer only says who must provide it). */
const DEPENDENCY_FIELDS = /** @type {const} */ (['dependencies', 'devDependencies', 'optionalDependencies'])

/**
 * The directory of package `name` as Node's lookup finds it from `start`: the first `node_modules/<name>` walking up,
 * real path. Never NODE_PATH or the global folders (see kitDirOf in ../kit.js for why). Null when there is none.
 * @param {string} start
 * @param {string} name
 * @returns {string | null}
 */
export function packageDirFrom(start, name) {
    for (let dir = path.resolve(start); ; dir = path.dirname(dir)) {
        const candidate = path.join(dir, 'node_modules', ...name.split('/'))
        if (existsSync(candidate)) return realpathSync(candidate)
        if (path.dirname(dir) === dir) return null
    }
}

/**
 * The two settings doctor reads from `pnpm-workspace.yaml`: its `packages` globs and `dedupePeerDependents`. A
 * deliberately small reader (block sequences of plain or quoted scalars, and one top-level scalar), so @sssb/tools
 * takes no YAML dependency; a flow sequence (`packages: [a, b]`) is read too.
 * @param {string} text
 * @returns {{ packages: string[], dedupePeerDependents: boolean | undefined }}
 */
export function parseWorkspaceYaml(text) {
    /** @param {string} raw */
    const scalar = (raw) =>
        raw
            .replace(/\s+#.*$/, '')
            .trim()
            .replace(/^(['"])(.*)\1$/, '$2')
    /** @type {string[]} */
    const packages = []
    /** @type {boolean | undefined} */
    let dedupePeerDependents
    const lines = text.split('\n')
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i] ?? ''
        const flow = /^packages:\s*\[(.*)\]\s*(#.*)?$/.exec(line)
        if (flow) {
            packages.push(...(flow[1] ?? '').split(',').map(scalar).filter(Boolean))
            continue
        }
        if (/^packages:\s*(#.*)?$/.test(line)) {
            for (i++; i < lines.length; i++) {
                const item = lines[i] ?? ''
                if (/^\s*(#.*)?$/.test(item)) continue
                const entry = /^\s+-\s+(.+)$/.exec(item)
                if (!entry) {
                    i--
                    break
                }
                packages.push(scalar(entry[1] ?? ''))
            }
            continue
        }
        const dedupe = /^dedupePeerDependents:\s*(.+)$/.exec(line)
        if (dedupe) {
            const value = scalar(dedupe[1] ?? '')
            dedupePeerDependents = value === 'true' ? true : value === 'false' ? false : undefined
        }
    }
    return { packages, dedupePeerDependents }
}

/**
 * Every package of the workspace at `root` (its `pnpm-workspace.yaml` globs, `!` negations applied), as absolute
 * directories holding a package.json, sorted. The root itself is not in it.
 * @param {string} root
 * @returns {string[]}
 */
export function workspacePackages(root) {
    const { packages } = parseWorkspaceYaml(readFileSync(path.join(root, 'pnpm-workspace.yaml'), 'utf8'))
    const include = packages.filter((glob) => !glob.startsWith('!'))
    const exclude = packages.filter((glob) => glob.startsWith('!')).map((glob) => glob.slice(1))
    const found = new Set()
    for (const glob of include) {
        for (const match of globSync(glob.replace(/\/+$/, ''), { cwd: root })) {
            const rel = match.split(path.sep).join('/')
            if (rel.split('/').includes('node_modules')) continue
            if (exclude.some((negated) => path.matchesGlob(rel, negated.replace(/\/+$/, '')))) continue
            if (existsSync(path.join(root, match, 'package.json'))) found.add(path.join(root, match))
        }
    }
    return [...found].sort()
}

/**
 * IN-REPO MODE (ADR-0014 part 1): the `@sssb/kit` the app resolves is a package of this very workspace (SSSB's own
 * repository, where `workspace:*` links the apps to packages/kit's source), not a copy installed from a tarball or a
 * registry. Decided by where the kit really is, never by a setting: its real directory is one of the workspace's
 * package directories. There the seam goes through each app's aliases rather than a link.
 * @param {string} kitDir the real directory of the app's `@sssb/kit` (kitDirOf)
 * @param {string} root the workspace root
 */
export function isInRepoKit(kitDir, root) {
    return workspacePackages(root).some((dir) => realpathSync(dir) === kitDir)
}

/** @typedef {{ id: string, runner: string, title: string, tests: string[] }} RegisteredCheck */

/**
 * Every test the conformance suite registers for one runner, as `vitest list` names it: `[sssb:<id>] <title> >
 * <test>`, from the kit's `checks.json`.
 * @param {{ checks: RegisteredCheck[] }} registry
 * @param {'unit' | 'contract'} runner
 * @returns {{ id: string, name: string }[]}
 */
function expectedTests(registry, runner) {
    return registry.checks
        .filter((check) => check.runner === runner)
        .flatMap((check) =>
            check.tests.map((test) => ({ id: check.id, name: `[sssb:${check.id}] ${check.title} > ${test}` })),
        )
}

/**
 * The checks an app opted out of, as the suite records them in what Vitest lists: a test named
 * `[sssb:opt-out:<id>] <reason>` (at the file's top level, or under a describe).
 * @param {readonly string[]} listed every listed test's full name
 * @returns {Set<string>}
 */
function optedOut(listed) {
    const ids = new Set()
    for (const name of listed) {
        for (const segment of name.split(' > ')) {
            const id = /^\[sssb:opt-out:([^\]\s]+)\]/.exec(segment)?.[1]
            if (id) ids.add(id)
        }
    }
    return ids
}

/**
 * The tests of one runner's checks that Vitest would NOT run: every expected test that is not in the listing, unless
 * its check is opted out by a listed marker. A marker is honoured only for a check of this runner (the suite refuses
 * any other while collecting, so a stray one changes nothing).
 * @param {readonly string[]} listed every listed test's full name
 * @param {{ checks: RegisteredCheck[] }} registry
 * @param {'unit' | 'contract'} runner
 * @returns {{ missing: string[], optedOut: string[], expected: number }}
 */
export function missingTests(listed, registry, runner) {
    const names = new Set(listed)
    const out = optedOut(listed)
    const expected = expectedTests(registry, runner)
    const ids = [...new Set(expected.map((test) => test.id))]
    return {
        missing: expected.filter((test) => !out.has(test.id) && !names.has(test.name)).map((test) => test.name),
        optedOut: ids.filter((id) => out.has(id)),
        expected: expected.filter((test) => !out.has(test.id)).length,
    }
}

/**
 * ONE COPY OF EACH SINGLETON (ADR-0014 part 5): for every peer the framework declares, the real directory of the
 * package found from the kit's directory must be the one found from the app's. Directories, not entry points, since
 * `@types/react` has none. A peer the kit cannot find fails. An OPTIONAL peer that neither side finds is not
 * installed, and passes as a note; one only the kit finds is not the app's to share (a note); one only the app finds
 * is a split (fails), because the kit would load another copy, or none.
 * @param {{ peers: readonly string[], optional: ReadonlySet<string>, fromKit: (name: string) => string | null, fromApp: (name: string) => string | null }} input
 * @returns {{ problems: string[], notes: string[], same: string[] }}
 */
export function singletonProblems({ peers, optional, fromKit, fromApp }) {
    /** @type {string[]} */
    const problems = []
    /** @type {string[]} */
    const notes = []
    /** @type {string[]} */
    const same = []
    for (const name of peers) {
        const kit = fromKit(name)
        const app = fromApp(name)
        const isOptional = optional.has(name)
        if (kit === null && app === null && isOptional) notes.push(`${name}: an optional peer neither installs`)
        else if (kit === null) problems.push(`${name}: @sssb/kit cannot find it${app ? ` (the app has ${app})` : ''}`)
        else if (app === null && isOptional) notes.push(`${name}: an optional peer the app does not install`)
        else if (app === null) problems.push(`${name}: the app cannot find it (@sssb/kit has ${kit})`)
        else if (kit !== app) problems.push(`TWO COPIES  ${name}: @sssb/kit loads ${kit}, the app ${app}`)
        else same.push(name)
    }
    return { problems, notes, same }
}

/**
 * The peers of the framework at `kitDir` that doctor holds to one copy: every `peerDependencies` entry (the seam is
 * declared in `peerDependenciesMeta` alone, and is never one), and which of them are optional.
 * @param {string} kitDir
 */
export function kitPeers(kitDir) {
    const manifest = readJson(path.join(kitDir, 'package.json'))
    const peers = Object.keys(manifest.peerDependencies ?? {}).filter((name) => name !== SEAM)
    const meta = manifest.peerDependenciesMeta ?? {}
    return { peers, optional: new Set(peers.filter((name) => meta[name]?.optional === true)) }
}

/**
 * @param {Record<string, unknown>} manifest
 * @param {string} name
 * @returns {string | undefined}
 */
function declared(manifest, name) {
    for (const field of DEPENDENCY_FIELDS) {
        const deps = /** @type {Record<string, string> | undefined} */ (manifest[field])
        if (deps && typeof deps[name] === 'string') return deps[name]
    }
    return undefined
}

/**
 * The real directory of the seam `@sssb/kit` at `kitDir` loads: `@sssb/app-config` as Node's lookup finds it from the
 * framework's own directory (pnpm links it beside the instance). Null when there is none.
 * @param {string} kitDir
 */
export const seamOfKit = (kitDir) => packageDirFrom(kitDir, SEAM)

/**
 * Every package of the workspace, the root included, that depends on `@sssb/kit` (the framework itself aside).
 * @param {string} root
 * @returns {{ dir: string, manifest: Record<string, unknown> }[]}
 */
export function kitImporters(root) {
    return [root, ...workspacePackages(root)]
        .map((dir) => ({ dir, manifest: readJson(path.join(dir, 'package.json')) }))
        .filter(({ manifest }) => manifest.name !== KIT && declared(manifest, KIT) !== undefined)
}

/**
 * ONE SSSB PER IMPORTER, WITH ITS OWN SEAM (ADR-0014 part 5): every package of the workspace that depends on
 * `@sssb/kit` (the root included) must declare its seam link, and the instance it resolves must have that very seam
 * linked. A package that slips is by definition not an app, so the walk is the whole workspace, whatever package
 * doctor runs from. `resolveKit` is the shared resolver's kitDirOf.
 * @param {string} root
 * @param {(dir: string) => string} resolveKit
 * @returns {{ problems: string[], importers: string[] }}
 */
export function importerSeamProblems(root, resolveKit) {
    /** @type {string[]} */
    const problems = []
    /** @type {string[]} */
    const importers = []
    const rel = (/** @type {string} */ dir) => path.relative(root, dir) || '(the workspace root)'
    const found = kitImporters(root)
    /** @type {Map<string, string>} each package's own seam (real path) -> the package */
    const seamOwners = new Map()
    for (const { dir, manifest } of found) {
        const own = ownSeam(dir, declared(manifest, SEAM))
        if (own) seamOwners.set(own, rel(dir))
    }
    for (const { dir, manifest } of found) {
        importers.push(rel(dir))
        const link = declared(manifest, SEAM)
        const own = ownSeam(dir, link)
        const kitDir = resolvesKit(resolveKit, dir)
        if (kitDir === null) {
            problems.push(`${rel(dir)}: depends on @sssb/kit but resolves none (is it installed?)`)
            continue
        }
        const seam = seamOfKit(kitDir)
        const where = path.relative(root, kitDir)
        const runsOn =
            seam === null
                ? 'no seam linked'
                : `${seamOwners.has(seam) ? `${seamOwners.get(seam)}'s seam` : 'the seam'} ${path.relative(root, seam)} linked`
        if (link === undefined) {
            problems.push(
                `${rel(dir)}: takes @sssb/kit but declares no seam link (${SEAM}); the instance it resolves (${where}) has ${runsOn}`,
            )
        } else if (own === null) {
            problems.push(`${rel(dir)}: declares ${SEAM} as ${link}, which is no directory`)
        } else if (seam !== own) {
            problems.push(
                `${rel(dir)}: its @sssb/kit (${where}) has ${runsOn}, not its own ${path.relative(root, own)}`,
            )
        }
    }
    return { problems, importers }
}

/**
 * @param {(dir: string) => string} resolveKit
 * @param {string} dir
 * @returns {string | null}
 */
function resolvesKit(resolveKit, dir) {
    try {
        return resolveKit(dir)
    } catch {
        return null
    }
}

/**
 * A package's own seam: the target of its `link:` dependency, or what its node_modules links, real path.
 * @param {string} dir
 * @param {string | undefined} spec
 */
function ownSeam(dir, spec) {
    if (spec === undefined) return null
    const target = spec.startsWith('link:')
        ? path.resolve(dir, spec.slice('link:'.length))
        : path.join(dir, 'node_modules', ...SEAM.split('/'))
    return existsSync(target) ? realpathSync(target) : null
}

/**
 * IN-REPO MODE's replacement for the per-importer seam check: inside SSSB's repository the seam goes through aliases,
 * so each app's tsconfig `paths['@sssb/app-config/*']` and the `@sssb/app-config` alias of each Vitest project that
 * runs its files must point at THAT app's own `src/app-config`.
 * @param {{ app: string, own: string, tsconfig: string | null, projects: { config: string, project: string, seam: string | null }[] }[]} apps
 *   `own`, `tsconfig` and each `seam` are real paths (`tsconfig` is where `paths` sends the seam, null when it maps none)
 * @returns {string[]}
 */
export function aliasProblems(apps) {
    /** @type {string[]} */
    const problems = []
    for (const { app, own, tsconfig, projects } of apps) {
        if (tsconfig === null) problems.push(`${app}: its tsconfig maps no ${SEAM}/* path`)
        else if (tsconfig !== own)
            problems.push(`${app}: its tsconfig sends ${SEAM}/* to ${tsconfig}, not its own ${own}`)
        if (projects.length === 0) problems.push(`${app}: no Vitest project runs its files, so none aliases its seam`)
        for (const { config, project, seam } of projects) {
            if (seam === null) problems.push(`${app}: Vitest project ${project} (${config}) has no ${SEAM} alias`)
            else if (seam !== own)
                problems.push(
                    `${app}: Vitest project ${project} (${config}) aliases ${SEAM} to ${seam}, not its own ${own}`,
                )
        }
    }
    return problems
}

/**
 * Every `@sssb/*` package the app resolves, as Node's lookup finds each name from the app's directory (the nearest
 * `node_modules/@sssb/<name>` wins), with its version. The seam is the app's own package, not a release, and is left
 * out.
 * @param {string} appDir
 * @returns {Map<string, string | undefined>} package name -> version
 */
export function sssbPackagesOf(appDir) {
    /** @type {Map<string, string | undefined>} */
    const found = new Map()
    for (let dir = path.resolve(appDir); ; dir = path.dirname(dir)) {
        const scope = path.join(dir, 'node_modules', '@sssb')
        if (existsSync(scope)) {
            for (const name of readdirSync(scope).sort()) {
                const full = `@sssb/${name}`
                if (full === SEAM || found.has(full)) continue
                const manifest = path.join(scope, name, 'package.json')
                if (!existsSync(manifest)) continue
                found.set(full, readJson(manifest).version)
            }
        }
        if (path.dirname(dir) === dir) return found
    }
}

/**
 * VERSIONS IN STEP (ADR-0014 part 5): every `@sssb/*` package the app resolves is the version of its `@sssb/kit`. The
 * packages carry no dependency on each other that would keep them together, so nothing else does.
 * @param {Map<string, string | undefined>} packages
 * @returns {string[]}
 */
export function versionProblems(packages) {
    const kit = packages.get(KIT)
    if (kit === undefined) return ['@sssb/kit: the app resolves no version of it']
    return [...packages]
        .filter(([name, version]) => name !== KIT && version !== kit)
        .map(([name, version]) => `${name} ${version ?? '(no version)'} is not @sssb/kit's ${kit}`)
}

/**
 * The framework's cutover rows (`@sssb/kit/cutover/rows.json`) the workspace's own checklist never mentions, by their
 * backticked item name. A row whose "what it is" says it belongs to SSSB's own repository only (`release-app`) is no
 * adopter's to record, and is set apart instead.
 * @param {{ rows: { id: string, what: string }[] }} rows
 * @param {string | null} checklist the text of the workspace's docs/cutover-checklist.md, null when it has none
 * @returns {{ unmentioned: string[], sssbOnly: string[] }}
 */
export function cutoverReport(rows, checklist) {
    const sssbOnly = rows.rows.filter((row) => /^SSSB's own repository only\b/.test(row.what)).map((row) => row.id)
    const unmentioned = rows.rows
        .filter((row) => !sssbOnly.includes(row.id))
        .filter((row) => checklist === null || !checklist.includes(`\`${row.id}\``))
        .map((row) => row.id)
    return { unmentioned, sssbOnly }
}
