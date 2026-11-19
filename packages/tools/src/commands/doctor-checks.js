// @ts-check
// The checks behind `sssb doctor` (ADR-0014 part 5), apart from the command that runs and prints them, so a test can
// drive each one over a workspace built on disk or a `vitest list` sample. Each returns its problems as sentences that
// name what is wrong; empty means the check holds. Nothing here loads the framework: what it needs of `@sssb/kit` (its
// peers, its check registry, its cutover rows) is read as data from the copy the APP resolves (rule 4, ../kit.js).
import { existsSync, globSync, readdirSync, readFileSync, realpathSync } from 'node:fs'
import path from 'node:path'
import { readJson, UsageError, workspaceApps } from '../app.js'
import { portForRoot, readPortDeclaration } from '../ports.js'

const KIT = '@sssb/kit'
const SEAM = '@sssb/app-config'

/** The dependency fields that give a package its own copy of a package (a seam declared as a peer is not its own). */
const DEPENDENCY_FIELDS = /** @type {const} */ (['dependencies', 'devDependencies', 'optionalDependencies'])

/** The fields that make a package an importer of @sssb/kit: any of them puts an instance on its lookup chain. */
const IMPORTER_FIELDS = /** @type {const} */ ([...DEPENDENCY_FIELDS, 'peerDependencies'])

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
 * deliberately small reader, so @sssb/tools takes no YAML dependency. It reads the subset a pnpm-workspace.yaml uses,
 * and THROWS, naming the line, on anything else, because a list it misread as empty would make every workspace-wide
 * check pass over nothing:
 *
 *   - top-level `key:` entries, plain or quoted keys; the value of any key but these two is skipped (its indented
 *     lines, and `- ` items at column 0, which YAML lets a block sequence use under a top-level key);
 *   - `packages` as a block sequence at any one indentation, column 0 included, of plain or quoted scalars, or as a
 *     flow sequence (`[a, 'b']`) on one line or over several (at any column, as YAML allows); comments and blank lines
 *     anywhere;
 *   - `dedupePeerDependents` as an unquoted true or false, on the key's line or alone on the indented line below it
 *     (anything else, a quoted 'false' too, is not the boolean);
 *   - a flow collection (any key's) opens only where a value starts with `[` or `{`; a bracket inside a plain scalar
 *     (`nodeOptions: --foo[bar`) is text.
 *
 * What it throws on, among others: in the two values it reads, anchors, aliases and tags (an unquoted `!glob` is a
 * tag, an unquoted `*glob` an alias), nested or multi-line items and a scalar where the list belongs; anywhere at the
 * top level, a duplicate key, a top-level flow mapping, a flow collection of any key still open at the end of the
 * file, and a second document. Another key's value is skipped unread (an anchor there passes), but for its flow
 * brackets.
 * @param {string} text
 * @returns {{ packages: string[], dedupePeerDependents: boolean | undefined }}
 */
export function parseWorkspaceYaml(text) {
    /**
     * @param {number} line
     * @param {string} what
     * @returns {never}
     */
    const fail = (line, what) => {
        throw new UsageError(
            `sssb: pnpm-workspace.yaml line ${line}: ${what}, which sssb's reader of the file does not understand ` +
                '(it reads a small subset of YAML: see parseWorkspaceYaml in @sssb/tools)',
        )
    }
    /** @typedef {{ line: number, text: string }} Line */
    /** @typedef {{ line: number, value: string, body: Line[], depth: number }} Entry depth: flow brackets still open */
    /** @type {Map<string, Entry>} */
    const entries = new Map()
    /** @type {Entry | null} */
    let current = null
    let ended = false
    const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/)
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i] ?? ''
        const n = i + 1
        if (/^\s*(#.*)?$/.test(line)) continue
        // Inside an open flow collection (`key: [` ...), every line continues it, at column 0 too.
        if (current !== null && current.depth > 0) {
            current.body.push({ line: n, text: line })
            current.depth += flowDepth(line)
            continue
        }
        if (ended) fail(n, 'content after the end of the document (`...`)')
        if (/^---[ \t]*(#.*)?$/.test(line)) {
            if (entries.size > 0) fail(n, 'a second YAML document')
            continue
        }
        if (/^\.\.\.[ \t]*(#.*)?$/.test(line)) {
            ended = true
            continue
        }
        if (/^[ \t]/.test(line) || /^-([ \t]|$)/.test(line)) {
            if (current === null) fail(n, 'an indented line or list item before any key')
            current.body.push({ line: n, text: line })
            continue
        }
        const key = /^(?:([A-Za-z_][\w.-]*)|'((?:[^']|'')*)'|"((?:[^"\\]|\\.)*)")[ \t]*:(?:[ \t]+(.*))?$/.exec(line)
        if (!key) fail(n, `\`${line.trim()}\``)
        const name =
            key[1] ?? (key[2] === undefined ? unescapeDouble(key[3] ?? '', n, fail) : key[2].replaceAll("''", "'"))
        if (entries.has(name)) fail(n, `a second \`${name}\` key`)
        // A flow collection opens only where the value STARTS with `[` or `{`; in a plain scalar (`--foo[bar`) a
        // bracket is text.
        const value = key[4] ?? ''
        current = { line: n, value, body: [], depth: /^[[{]/.test(value) ? flowDepth(value) : 0 }
        entries.set(name, current)
    }
    if (current !== null && current.depth > 0)
        fail(current.line, 'a flow collection (`[` or `{`) never closed before the end of the file')

    /** @param {string} raw @param {number} line @param {boolean} inFlow */
    const scalar = (raw, line, inFlow) => {
        if (raw.startsWith("'")) {
            const quoted = /^'((?:[^']|'')*)'$/.exec(raw)
            if (!quoted) fail(line, `\`${raw}\``)
            return (quoted[1] ?? '').replaceAll("''", "'")
        }
        if (raw.startsWith('"')) {
            const quoted = /^"((?:[^"\\]|\\.)*)"$/.exec(raw)
            if (!quoted) fail(line, `\`${raw}\``)
            return unescapeDouble(quoted[1] ?? '', line, fail)
        }
        if (/^[,[\]{}#&*!|>%@`]/.test(raw) || /^[-?:]([ \t]|$)/.test(raw))
            fail(line, `\`${raw}\` (an anchor, alias, tag, nested collection or block scalar)`)
        if (/:([ \t]|$)/.test(raw) || (inFlow && /[,[\]{}]/.test(raw))) fail(line, `\`${raw}\``)
        if (/^(~|null|Null|NULL)$/.test(raw)) fail(line, `\`${raw}\` (a null where a glob belongs)`)
        return raw
    }

    /** @type {string[]} */
    let packages = []
    const listed = entries.get('packages')
    if (listed) {
        const value = stripComment(listed.value, listed.line, fail)
        if (value === '') packages = blockSequence(listed.body, scalar, fail)
        else if (value.startsWith('['))
            packages = flowSequence(
                [
                    { line: listed.line, text: value },
                    ...listed.body.map((b) => ({ line: b.line, text: stripComment(b.text, b.line, fail) })),
                ],
                scalar,
                fail,
            )
        else fail(listed.line, `\`packages: ${value}\` (a list belongs there)`)
    }

    // The value on the key's line, or alone on the one indented line below it (`dedupePeerDependents:\n  false`); more
    // lines make a multi-line scalar, which is no boolean.
    const dedupe = entries.get('dedupePeerDependents')
    const inline = dedupe ? stripComment(dedupe.value, dedupe.line, fail) : ''
    const below = dedupe?.body.length === 1 && inline === '' ? dedupe.body[0] : undefined
    const flag =
        dedupe && dedupe.body.length === 0
            ? inline
            : below && !/^\s*-([ \t]|$)/.test(below.text)
              ? stripComment(below.text, below.line, fail)
              : ''
    const dedupePeerDependents = /^(true|True|TRUE)$/.test(flag)
        ? true
        : /^(false|False|FALSE)$/.test(flag)
          ? false
          : undefined
    return { packages, dedupePeerDependents }
}

/**
 * How many flow brackets (`[`, `{`) a line opens and leaves open, its quoted text and comment aside. Never throws: it
 * only decides which lines a flow value spans, and the value's own reader judges them.
 * @param {string} text
 */
function flowDepth(text) {
    let depth = 0
    /** @type {string | null} */
    let quote = null
    for (let i = 0; i < text.length; i++) {
        const c = text[i]
        if (quote !== null) {
            if (quote === '"' && c === '\\') i++
            else if (c === quote) quote = null
        } else if (c === "'" || c === '"') quote = c
        else if (c === '#' && (i === 0 || /\s/.test(text[i - 1] ?? ''))) break
        else if (c === '[' || c === '{') depth++
        else if (c === ']' || c === '}') depth--
    }
    return depth
}

/** @typedef {(line: number, what: string) => never} Fail */
/** @typedef {(raw: string, line: number, inFlow: boolean) => string} Scalar */

/**
 * A line with its comment (a `#` at its start or after white space, outside quotes) cut off, trimmed.
 * @param {string} text
 * @param {number} line
 * @param {Fail} fail
 */
function stripComment(text, line, fail) {
    /** @type {string | null} */
    let quote = null
    for (let i = 0; i < text.length; i++) {
        const c = text[i]
        if (quote === "'") {
            if (c === "'") {
                if (text[i + 1] === "'") i++
                else quote = null
            }
        } else if (quote === '"') {
            if (c === '\\') i++
            else if (c === '"') quote = null
        } else if (c === "'" || c === '"') quote = c
        else if (c === '#' && (i === 0 || /\s/.test(text[i - 1] ?? ''))) return text.slice(0, i).trim()
    }
    if (quote !== null) fail(line, 'a quoted string that does not close on its line')
    return text.trim()
}

/**
 * A double-quoted scalar's text, with the escapes a glob needs (`\\`, `\"`, `\/`); any other escape throws.
 * @param {string} text
 * @param {number} line
 * @param {Fail} fail
 */
function unescapeDouble(text, line, fail) {
    return text.replace(/\\(.)/g, (_, c) =>
        c === '\\' || c === '"' || c === '/' ? c : fail(line, `the escape \\${c}`),
    )
}

/**
 * A block sequence's items: every line `- <scalar>`, all at one indentation.
 * @param {{ line: number, text: string }[]} body
 * @param {Scalar} scalar
 * @param {Fail} fail
 */
function blockSequence(body, scalar, fail) {
    /** @type {number | null} */
    let indent = null
    /** @type {string[]} */
    const items = []
    for (const { line, text } of body) {
        const item = /^( *)-(?:[ \t]+(.*))?$/.exec(text)
        if (!item) fail(line, `\`${text.trim()}\` inside the packages list`)
        const at = (item[1] ?? '').length
        if (indent === null) indent = at
        else if (at !== indent) fail(line, 'a list item at another indentation than the first')
        const value = stripComment(item[2] ?? '', line, fail)
        if (value === '') fail(line, 'an empty or nested list item')
        items.push(scalar(value, line, false))
    }
    return items
}

/**
 * A flow sequence's items, from its lines (comments already cut): `[` item `,` ... `]`, a trailing comma allowed.
 * @param {{ line: number, text: string }[]} parts
 * @param {Scalar} scalar
 * @param {Fail} fail
 */
function flowSequence(parts, scalar, fail) {
    /** @type {{ text: string, line: number }[]} */
    const items = []
    let item = ''
    let itemLine = parts[0]?.line ?? 1
    /** @type {string | null} */
    let quote = null
    let closed = false
    for (const [index, { line, text }] of parts.entries()) {
        for (let i = index === 0 ? 1 : 0; i < text.length; i++) {
            const c = text[i] ?? ''
            if (closed) fail(line, `\`${text.slice(i).trim()}\` after the list's closing \`]\``)
            if (quote !== null) {
                item += c
                if (quote === '"' && c === '\\') item += text[++i] ?? ''
                else if (c === quote) {
                    if (quote === "'" && text[i + 1] === "'") item += text[++i]
                    else quote = null
                }
            } else if (c === "'" || c === '"') {
                quote = c
                item += c
            } else if (c === ',' || c === ']') {
                items.push({ text: item.trim(), line: itemLine })
                item = ''
                itemLine = line
                if (c === ']') closed = true
            } else if (c === '[' || c === '{' || c === '}') fail(line, 'a nested collection in the packages list')
            else {
                if (item.trim() === '') itemLine = line
                item += c
            }
        }
        if (!closed) item += ' '
    }
    if (!closed) fail(parts.at(-1)?.line ?? 1, 'a flow sequence never closed with `]`')
    // `[]` and a trailing comma leave one empty item last; an empty item anywhere else is a stray comma.
    if (items.at(-1)?.text === '') items.pop()
    return items.map(({ text, line }) => (text === '' ? fail(line, 'an empty list item') : scalar(text, line, true)))
}

/**
 * Every package of the workspace at `root` (its `pnpm-workspace.yaml` globs, `!` negations applied), as absolute
 * directories holding a package.json, sorted. The root itself is not in it. Throws when the file cannot be read.
 * @param {string} root
 * @returns {string[]}
 */
export function workspacePackages(root) {
    const { packages } = parseWorkspaceYaml(readFileSync(path.join(root, 'pnpm-workspace.yaml'), 'utf8'))
    const include = packages.filter((glob) => !glob.startsWith('!'))
    const exclude = packages.filter((glob) => glob.startsWith('!')).map((glob) => glob.slice(1))
    const found = new Set()
    // Trailing slashes trimmed by a loop: `/\/+$/` backtracks quadratically on a long run of slashes followed by
    // anything else.
    /** @param {string} glob */
    const trimSlashes = (glob) => {
        let end = glob.length
        while (end > 0 && glob[end - 1] === '/') end--
        return glob.slice(0, end)
    }
    for (const glob of include) {
        for (const match of globSync(trimSlashes(glob), { cwd: root })) {
            const rel = match.split(path.sep).join('/')
            if (rel.split('/').includes('node_modules')) continue
            if (exclude.some((negated) => path.matchesGlob(rel, trimSlashes(negated)))) continue
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
 * @param {readonly string[]} [packages] the workspace's packages, when already walked (workspacePackages)
 */
export function isInRepoKit(kitDir, root, packages = workspacePackages(root)) {
    return packages.some((dir) => realpathSync(dir) === kitDir)
}

/**
 * WHAT DOCTOR WALKS: the workspace's packages, whether the app's kit is one of them (in-repo mode), every importer of
 * @sssb/kit, and the APPS, each of which gets every per-app check: in-repo, the apps the workspace's commands fan out
 * over (`sssb.apps`, or apps/*, as the alias check walks them); otherwise every importer with a seam of its own
 * (`src/app-config`). All real paths. Throws, as workspacePackages does, when pnpm-workspace.yaml cannot be read.
 * @param {string} root real path
 * @param {string} kitDir the real directory of the @sssb/kit doctor's app resolves
 */
export function discoverWorkspace(root, kitDir) {
    const packages = workspacePackages(root)
    const inRepo = isInRepoKit(kitDir, root, packages)
    const importers = kitImporters(root, packages)
    const apps = inRepo
        ? workspaceApps(root).map((app) => realpathSync(path.join(root, app)))
        : importers.map(({ dir }) => dir).filter((dir) => existsSync(path.join(dir, 'src', 'app-config')))
    return { packages, inRepo, importers, apps }
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
 * The checks an app opted out of, with the reason each gives, as the suite records them in what Vitest lists: a test
 * named `[sssb:opt-out:<id>] <reason>` (at the file's top level, or under a describe).
 * @param {readonly string[]} listed every listed test's full name
 * @returns {Map<string, string>} check id -> reason
 */
function optedOut(listed) {
    /** @type {Map<string, string>} */
    const ids = new Map()
    for (const name of listed) {
        for (const segment of name.split(' > ')) {
            const marker = /^\[sssb:opt-out:([^\]\s]+)\]\s*(.*)$/.exec(segment)
            if (marker?.[1]) ids.set(marker[1], marker[2] ?? '')
        }
    }
    return ids
}

/**
 * The tests of one runner's checks that Vitest would NOT run: every expected test that is not in the listing, unless
 * its check is opted out by a listed marker. A marker is honoured only for a check of this runner (the suite refuses
 * any other while collecting, so a stray one changes nothing). The listing must already be the app's own suite files
 * (ownTests): a name or a marker from any other file proves nothing.
 * @param {readonly string[]} listed every listed test's full name
 * @param {{ checks: RegisteredCheck[] }} registry
 * @param {'unit' | 'contract'} runner
 * @returns {{ missing: string[], optedOut: { id: string, reason: string }[], expected: number }}
 */
export function missingTests(listed, registry, runner) {
    const names = new Set(listed)
    const out = optedOut(listed)
    const expected = expectedTests(registry, runner)
    const ids = [...new Set(expected.map((test) => test.id))]
    return {
        missing: expected.filter((test) => !out.has(test.id) && !names.has(test.name)).map((test) => test.name),
        optedOut: ids.filter((id) => out.has(id)).map((id) => ({ id, reason: out.get(id) ?? '' })),
        expected: expected.filter((test) => !out.has(test.id)).length,
    }
}

/**
 * Which of an app's test areas a file is in: `unit` under the app's `src/`, `contract` under its `tests/contract/`,
 * null anywhere else, and null inside a workspace package nested in the app's directory (a root-level app's apps/*),
 * whose tests are that package's, not the app's.
 * @param {string} file
 * @param {string} appDir
 * @param {readonly string[]} nested the workspace packages strictly inside `appDir`
 * @returns {'unit' | 'contract' | null}
 */
export function areaOf(file, appDir, nested) {
    const abs = path.resolve(file)
    if (nested.some((dir) => abs.startsWith(dir + path.sep))) return null
    if (abs.startsWith(path.join(appDir, 'src') + path.sep)) return 'unit'
    if (abs.startsWith(path.join(appDir, 'tests', 'contract') + path.sep)) return 'contract'
    return null
}

/**
 * The names, from a `vitest list` listing, that can prove an app runs a runner's checks or opts out of one: the unit
 * checks come from the app's own `src/sssb.conformance.test.ts` alone, the contract checks from the files under its own
 * `tests/contract/`. A check's name or opt-out marker in any other file (another app's, a nested package's, or an
 * ordinary test that happens to use the name) counts for nothing.
 * @param {readonly { name: string, file: string }[]} listed
 * @param {string} appDir
 * @param {'unit' | 'contract'} runner
 * @param {readonly string[]} nested the workspace packages strictly inside `appDir`
 */
export function ownTests(listed, appDir, runner, nested) {
    const suite = path.join(appDir, 'src', 'sssb.conformance.test.ts')
    return listed
        .filter((test) =>
            runner === 'unit'
                ? path.resolve(test.file) === suite && areaOf(test.file, appDir, nested) === 'unit'
                : areaOf(test.file, appDir, nested) === 'contract',
        )
        .map((test) => test.name)
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
 * @param {readonly string[]} [fields]
 * @returns {string | undefined}
 */
function declared(manifest, name, fields = DEPENDENCY_FIELDS) {
    for (const field of fields) {
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
 * THE INSTALLED LAYOUT: SSSB needs pnpm's default `nodeLinker`, `isolated`. Every check doctor makes reads the layout
 * it builds (each importer's own `@sssb/kit` instance in the virtual store, with its seam linked beside it, found
 * through `node_modules`), and so does the shared kit resolver. Under `hoisted` one instance serves every app, so no
 * two apps can each have their own seam. Under `pnp` pnpm 11 still builds that `node_modules`, but writes a
 * `.pnp.cjs` at the root, and while it is there `pnpm run` loads it into every script's `NODE_OPTIONS` (removing the
 * setting and reinstalling leaves it behind): Plug'n'Play then resolves inside doctor itself, and Vitest's listing
 * never finishes. The layout pnpm installed is in the root's `node_modules/.modules.yaml` (JSON, which is YAML),
 * whatever setting asked for it. Null when the layout is isolated with no Plug'n'Play anywhere, or when nothing is
 * installed (the kit resolver then says so).
 * @param {string} root
 * @param {Record<string, string | undefined>} [env] doctor's own environment
 * @returns {string | null} the problem
 */
export function nodeLinkerProblem(root, env = process.env) {
    const fix =
        "SSSB needs nodeLinker isolated, pnpm's default, which gives each app its own @sssb/kit linked to its own seam " +
        "with no Plug'n'Play. Remove the nodeLinker setting from pnpm-workspace.yaml (and any " +
        'pnpm_config_node_linker variable or --config.node-linker flag), delete .pnp.cjs at the workspace root if it is ' +
        'there, then run pnpm install'
    const file = path.join(root, 'node_modules', '.modules.yaml')
    if (existsSync(file)) {
        /** @type {string} */
        let text
        try {
            text = readFileSync(file, 'utf8')
        } catch (error) {
            return `node_modules/.modules.yaml, where pnpm records the layout it installed, cannot be read (${/** @type {Error} */ (error).message}). ${fix}`
        }
        /** @type {unknown} */
        let linker
        try {
            linker = JSON.parse(text)?.nodeLinker
        } catch {
            // Not JSON (a damaged file, or a pnpm that writes YAML): a `nodeLinker` key at the start of any line,
            // indented or not, quoted or not.
            linker = /^\s*["']?nodeLinker["']?\s*:\s*["']?([A-Za-z-]+)/m.exec(text)?.[1]
        }
        if (typeof linker === 'string' && linker !== 'isolated') {
            return `pnpm installed this workspace with nodeLinker ${linker} (node_modules/.modules.yaml). ${fix}`
        }
    }
    if (existsSync(path.join(root, '.pnp.cjs'))) {
        return `.pnp.cjs at the workspace root makes pnpm run every script under Plug'n'Play, whatever layout it installed. ${fix}`
    }
    if (/\.pnp\.c?js\b/.test(env.NODE_OPTIONS ?? '')) {
        return `doctor runs under Plug'n'Play (NODE_OPTIONS loads a .pnp.cjs: ${env.NODE_OPTIONS}). ${fix}`
    }
    return null
}

/**
 * Every package of the workspace, the root included, that takes `@sssb/kit` in any dependency field (dependencies,
 * devDependencies, optionalDependencies, peerDependencies), the framework itself aside. Real paths.
 * @param {string} root
 * @param {readonly string[]} [packages] the workspace's packages, when already walked (workspacePackages)
 * @returns {{ dir: string, manifest: Record<string, unknown> }[]}
 */
export function kitImporters(root, packages = workspacePackages(root)) {
    return [root, ...packages]
        .map((dir) => ({ dir: realpathSync(dir), manifest: readJson(path.join(dir, 'package.json')) }))
        .filter(({ manifest }) => manifest.name !== KIT && declared(manifest, KIT, IMPORTER_FIELDS) !== undefined)
}

/**
 * ONE SSSB PER IMPORTER, WITH ITS OWN SEAM (ADR-0014 part 5): every package of the workspace that depends on
 * `@sssb/kit` (the root included) must declare its seam link, and the instance it resolves must have that very seam
 * linked, a seam no other importer has. The link must be a workspace package (`workspace:<name>@*`), not a `link:`,
 * which pnpm's next `add <pkg>`, `remove` or `update <pkg>` for the importer unlinks. A package that slips is by definition not an app, so the walk
 * is the whole workspace, whatever package doctor runs from. `resolveKit` is the shared resolver's kitDirOf.
 * @param {string} root
 * @param {(dir: string) => string} resolveKit
 * @param {{ dir: string, manifest: Record<string, unknown> }[]} [found] the importers, when already walked
 * @param {readonly string[]} [packages] the workspace's packages, when already walked (workspacePackages)
 * @returns {{ problems: string[], importers: string[] }}
 */
export function importerSeamProblems(root, resolveKit, found = kitImporters(root), packages = workspacePackages(root)) {
    /** @type {string[]} */
    const problems = []
    /** @type {string[]} */
    const importers = []
    const rel = (/** @type {string} */ dir) => path.relative(root, dir) || '(the workspace root)'
    /**
     * Each declared seam (real path) -> its package: the importer whose own `src/app-config` it is, else the first that
     * declares it. By location first, so an app that declares another's seam is the one named, whatever the walk order.
     * @type {Map<string, string>}
     */
    const seamOwners = new Map()
    for (const { dir } of found) {
        const home = path.join(dir, 'src', 'app-config')
        if (existsSync(home)) seamOwners.set(realpathSync(home), rel(dir))
    }
    for (const { dir, manifest } of found) {
        const own = ownSeam(dir, declared(manifest, SEAM))
        if (own && !seamOwners.has(own)) seamOwners.set(own, rel(dir))
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
        } else if (seamOwners.get(own) !== rel(dir)) {
            problems.push(
                `${rel(dir)}: declares ${SEAM} as ${link}, which is ${seamOwners.get(own)}'s seam ${path.relative(root, own)}, not one of its own`,
            )
        }
        if (link?.startsWith('workspace:')) {
            // pnpm takes two workspace packages of one name without a word and links the one it reaches last, so a
            // copy of the seam left under its name (a copied app, a stray directory) silently becomes the app's seam,
            // and the kit's link agrees with the app's: only the names show it.
            const name = /^(@?[^@]+)@/.exec(link.slice('workspace:'.length))?.[1] ?? SEAM
            const holders = [root, ...packages].filter((pkg) => {
                const file = path.join(pkg, 'package.json')
                return existsSync(file) && readJson(file).name === name
            })
            if (holders.length !== 1) {
                const where = holders.map((pkg) => path.relative(root, pkg) || '(the workspace root)').join(', ')
                problems.push(
                    holders.length === 0
                        ? `${rel(dir)}: declares ${SEAM} as ${link}, but no workspace package is named ${name}`
                        : `${rel(dir)}: declares ${SEAM} as ${link}, but ${holders.length} workspace packages are named ${name} (${where}), and pnpm links one of them: rename the copies`,
                )
            }
        }
        if (link?.startsWith('link:') && own !== null) {
            // Linked today, unlinked by the next partial install: pnpm keeps a `link:` dependency as the provider of
            // @sssb/kit's peer only when it re-resolves every dependency of the app (a fresh install, a bare
            // `pnpm update`), never on a partial install for the app, `add <pkg>`, `remove` or `update <pkg>`, which
            // leave it unresolved (ADR-0014's 2026-11-18 addendum).
            const name = `${typeof manifest.name === 'string' ? manifest.name : path.basename(dir)}-app-config`
            problems.push(
                `${rel(dir)}: declares ${SEAM} as ${link}, which the next \`pnpm add <pkg>\`, \`remove\` or \`update <pkg>\` for it unlinks from its @sssb/kit. ` +
                    `Make the seam a workspace package: list ${path.relative(root, path.join(dir, 'src', 'app-config'))} in pnpm-workspace.yaml's packages, name it ${name} in its package.json, ` +
                    `declare "${SEAM}": "workspace:${name}@*", and run pnpm install`,
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
 * A package's own seam: the target of its `link:` dependency, or what its node_modules links (a `workspace:`
 * dependency, the seam package of the package's own name), real path.
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
 * A path as far as it exists made real, the rest appended: where a target that names a file not (yet) there lands.
 * A bare specifier (no absolute path) is returned as it is.
 * @param {string} target
 */
export function realish(target) {
    if (!path.isAbsolute(target)) return target
    let dir = path.resolve(target)
    /** @type {string[]} */
    const rest = []
    while (!existsSync(dir)) {
        const parent = path.dirname(dir)
        if (parent === dir) return target
        rest.unshift(path.basename(dir))
        dir = parent
    }
    return path.join(realpathSync(dir), ...rest)
}

/** A subpath no seam has, so a probe through it shows where a wildcard mapping sends any subpath. */
export const PROBE = '__sssb_doctor_probe__'

/**
 * The specifiers doctor sends through a Vitest project's aliases to see where each sends the seam: the bare seam, a
 * subpath no seam has, and one subpath per entry of the app's own seam directory (so an alias for one subpath, such as
 * a RegExp for `@sssb/app-config/registrations`, is exercised too).
 * @param {string} own the app's own seam directory
 */
function seamProbes(own) {
    const entries = existsSync(own) ? readdirSync(own).map((name) => name.replace(/\.[^.]+$/, '')) : []
    return [...new Set([SEAM, `${SEAM}/${PROBE}`, ...entries.map((name) => `${SEAM}/${name}`)])]
}

/**
 * Whether a Vite alias's `find` matches a specifier, exactly as Vite decides (a RegExp tests it; a string matches
 * itself and anything under it).
 * @param {string | RegExp} find
 * @param {string} specifier
 */
function aliasMatches(find, specifier) {
    if (find instanceof RegExp) return new RegExp(find.source, find.flags.replace('g', '')).test(specifier)
    return specifier === find || specifier.startsWith(find.endsWith('/') ? find : `${find}/`)
}

/** @typedef {{ find: string, to: string, resolved: string[] }} SeamRoute where one alias or `paths` entry sends the seam: `to` as written, `resolved` the real path each probe specifier lands on (a bare specifier as it is) */

/**
 * Every entry of a Vitest project's resolved alias list (Vite's array form; the object form arrives as one) that
 * would match any `@sssb/app-config` specifier, a string or a RegExp `find` alike, with where it sends each probe.
 * Every matching entry counts, not only the first that wins today, since a reordered list would bring a later one in.
 * @param {readonly { find: string | RegExp, replacement: string }[]} entries
 * @param {string} own the app's own seam directory (real path)
 * @returns {SeamRoute[]}
 */
export function aliasRoutes(entries, own) {
    const probes = seamProbes(own)
    /** @type {SeamRoute[]} */
    const routes = []
    for (const { find, replacement } of entries) {
        const matched = probes.filter((probe) => aliasMatches(find, probe))
        if (matched.length === 0) continue
        routes.push({
            find: String(find),
            to: replacement,
            resolved: matched.map((probe) =>
                realish(
                    find instanceof RegExp ? probe.replace(find, replacement) : replacement + probe.slice(find.length),
                ),
            ),
        })
    }
    return routes
}

/**
 * IN-REPO MODE's replacement for the per-importer seam check: inside SSSB's repository the seam goes through aliases,
 * so every tsconfig `paths` key that is or starts with `@sssb/app-config` (every one of its targets), and every alias of
 * each Vitest project that runs the app's files and would match an `@sssb/app-config` specifier, must send the seam
 * into THAT app's own `src/app-config`.
 * @param {{ app: string, own: string, tsconfig: SeamRoute[], projects: { config: string, project: string, routes: SeamRoute[] }[] }[]} apps
 *   `own` and every `resolved` path are real paths shown the same way (relative to the workspace root)
 * @returns {string[]}
 */
export function aliasProblems(apps) {
    /** @type {string[]} */
    const problems = []
    for (const { app, own, tsconfig, projects } of apps) {
        const inside = (/** @type {SeamRoute} */ route) =>
            route.resolved.every((target) => target === own || target.startsWith(own + path.sep))
        if (tsconfig.length === 0) problems.push(`${app}: its tsconfig maps no ${SEAM} path`)
        for (const route of tsconfig.filter((r) => !inside(r)))
            problems.push(`${app}: its tsconfig sends ${route.find} to ${route.to}, not its own ${own}`)
        if (projects.length === 0) problems.push(`${app}: no Vitest project runs its files, so none aliases its seam`)
        for (const { config, project, routes } of projects) {
            const name = project === '' ? 'the root project' : `project ${project}`
            if (routes.length === 0) problems.push(`${app}: Vitest ${name} (${config}) has no ${SEAM} alias`)
            for (const route of routes.filter((r) => !inside(r)))
                problems.push(
                    `${app}: Vitest ${name} (${config}) aliases ${route.find} to ${route.to}, not its own ${own}`,
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

/** Vitest flags that take a value as the next word (so that word is no file filter). */
const VALUE_FLAGS = new Set([
    '--config',
    '-c',
    '--project',
    '--exclude',
    '-t',
    '--testNamePattern',
    '--shard',
    '--reporter',
    '--outputFile',
    '--root',
    '-r',
    '--dir',
    '--environment',
    '--pool',
    '--maxWorkers',
    '--mode',
    '--testTimeout',
    '--hookTimeout',
    '--retry',
    '--bail',
])

/** Vitest flags that can run fewer tests than the configuration would. */
const NARROWING_FLAGS = new Set([
    '--project',
    '--exclude',
    '-t',
    '--testNamePattern',
    '--changed',
    '--related',
    '--shard',
    '--typecheck.only',
    '--dir',
])

/** Vitest subcommands that run the configuration's files (`related` narrows them, and is reported). */
const SUBCOMMANDS = new Set(['run', 'watch', 'dev', 'list', 'bench'])

/** @typedef {{ script: string, config: string | null, narrowing: string[] }} VitestInvocation */

/**
 * Every place a package.json's scripts run Vitest, with the `--config` each names and every flag or positional file
 * filter that can narrow what the configuration would run. Read from the script text alone: a shell's words (quotes
 * honoured) split at `&&`, `||`, `;` and `|`, a quoted word holding a whole command (`sh -c '...'`) read again, the
 * `vitest` word found by name or path (`vitest`, `node_modules/vitest/vitest.mjs`). A script that runs another
 * script is not followed.
 * @param {Record<string, unknown>} scripts
 * @returns {VitestInvocation[]}
 */
export function vitestInvocations(scripts) {
    /** @type {VitestInvocation[]} */
    const found = []
    /** @param {string} script @param {string} command */
    const scan = (script, command) => {
        for (const segment of shellSegments(command)) {
            for (const word of segment.filter((w) => /\s/.test(w))) scan(script, word)
            const at = segment.findIndex((word) => /(^|\/)vitest(\.m?js)?$/.test(word))
            if (at < 0) continue
            const args = segment.slice(at + 1)
            /** @type {string | null} */
            let config = null
            /** @type {string[]} */
            const narrowing = []
            let i = 0
            if (SUBCOMMANDS.has(args[0] ?? '')) i = 1
            else if (args[0] === 'related') {
                narrowing.push('related')
                i = 1
            }
            for (; i < args.length; i++) {
                const arg = args[i] ?? ''
                if (!arg.startsWith('-')) {
                    narrowing.push(arg)
                    continue
                }
                const eq = arg.indexOf('=')
                const name = eq < 0 ? arg : arg.slice(0, eq)
                let value = eq < 0 ? undefined : arg.slice(eq + 1)
                const separate = value === undefined && VALUE_FLAGS.has(name)
                if (separate) value = args[++i]
                if (name === '--config' || name === '-c') config = value ?? null
                if (NARROWING_FLAGS.has(name)) narrowing.push(separate ? `${name} ${value ?? ''}`.trim() : arg)
            }
            found.push({ script, config, narrowing })
        }
    }
    for (const [script, command] of Object.entries(scripts)) if (typeof command === 'string') scan(script, command)
    return found
}

/**
 * A shell command's words, quotes removed, split into the commands that `&&`, `||`, `;`, `|` and `&` separate.
 * @param {string} command
 * @returns {string[][]}
 */
function shellSegments(command) {
    /** @type {string[][]} */
    const segments = [[]]
    /** @type {string | null} */
    let word = null
    /** @type {string | null} */
    let quote = null
    const end = () => {
        if (word !== null) segments.at(-1)?.push(word)
        word = null
    }
    for (const c of command) {
        if (quote !== null) {
            if (c === quote) quote = null
            else word += c
        } else if (c === "'" || c === '"') {
            quote = c
            word ??= ''
        } else if (/\s/.test(c)) end()
        else if (';&|'.includes(c)) {
            end()
            if ((segments.at(-1)?.length ?? 0) > 0) segments.push([])
        } else word = (word ?? '') + c
    }
    end()
    return segments.filter((segment) => segment.length > 0)
}

/**
 * The framework's cutover rows (`@sssb/kit/cutover/rows.json`) the workspace's own checklist never mentions, by their
 * backticked item name. A row marked `scope: 'sssb'` (`release-app`) belongs to SSSB's own repository only, is no
 * adopter's to record, and is set apart instead.
 * @param {{ rows: { id: string, what: string, scope?: string }[] }} rows
 * @param {string | null} checklist the text of the workspace's docs/cutover-checklist.md, null when it has none
 * @returns {{ unmentioned: string[], sssbOnly: string[] }}
 */
export function cutoverReport(rows, checklist) {
    const sssbOnly = rows.rows.filter((row) => row.scope === 'sssb').map((row) => row.id)
    const unmentioned = rows.rows
        .filter((row) => !sssbOnly.includes(row.id))
        .filter((row) => checklist === null || !checklist.includes(`\`${row.id}\``))
        .map((row) => row.id)
    return { unmentioned, sssbOnly }
}

/**
 * PORT SLOTS: two apps of one workspace must not bind one port. An app declares its slot in its package.json
 * (`"sssb": { "port": "starter" }`, or a slot of its own, `{ "name": "ledger", "default": 3700 }`), the slot fixes the
 * port its dev server, its Playwright config and its ticker use, so two apps on one slot start on one port: the second
 * server fails to bind, or, under Playwright's `reuseExistingServer`, the second app's suite ADOPTS the first app's
 * server and tests the wrong app (docs/build-notes.md). Fails: a declaration that is not valid, two apps on one slot
 * name, and two apps on distinct names whose main-checkout default is one port (a worktree's derived ports differ by
 * name, so the default is the one that can still collide). An app with no declaration is not checked.
 * @param {string} root the workspace root, for the names the problems give
 * @param {readonly string[]} apps the apps' directories (absolute)
 * @returns {{ problems: string[], slots: string[] }} the problems, and one line per declaring app for the check's notes
 */
export function portSlotProblems(root, apps) {
    /** @type {string[]} */
    const problems = []
    /** @type {string[]} */
    const slots = []
    /** @type {Map<string, string[]>} app directories by slot name */
    const byName = new Map()
    /** @type {Map<number, { app: string, name: string }[]>} */
    const byDefault = new Map()
    for (const app of apps) {
        const where = path.relative(root, app) || '(the workspace root)'
        let declared
        try {
            declared = readPortDeclaration(app)
        } catch (error) {
            problems.push(`${where}: ${error instanceof Error ? error.message.replace(/^ports: /, '') : String(error)}`)
            continue
        }
        if (declared === undefined) continue
        const name = typeof declared === 'string' ? declared : declared.name
        // A main checkout's port (the filesystem root is no worktree), whatever this workspace's own path is.
        const fallback = portForRoot(path.sep, declared, {})
        slots.push(`${where}: slot "${name}", port ${fallback} in a main checkout`)
        byName.set(name, [...(byName.get(name) ?? []), where])
        byDefault.set(fallback, [...(byDefault.get(fallback) ?? []), { app: where, name }])
    }
    for (const [name, dirs] of byName) {
        if (dirs.length < 2) continue
        problems.push(
            `${dirs.join(' and ')} declare the same port slot "${name}", so their dev servers, e2e servers and tickers ` +
                "bind one port (and the second suite adopts the first app's server). Give each its own: " +
                '"sssb": { "port": { "name": "<name>", "default": <port> } } in its package.json',
        )
    }
    for (const [port, holders] of byDefault) {
        const distinct = [...new Set(holders.map(({ name }) => name))]
        if (distinct.length < 2) continue
        problems.push(
            `${holders.map(({ app }) => app).join(' and ')} declare port slots (${distinct.map((n) => `"${n}"`).join(', ')}) ` +
                `with one default, ${port}, so in a main checkout they bind one port: give each its own default`,
        )
    }
    return { problems, slots }
}

/**
 * JSONC as JSON: its comments and trailing commas taken out, strings (a `$schema` URL's `//` among them) left whole.
 * @param {string} text
 */
export function withoutJsonComments(text) {
    let out = ''
    // A comma is held until the next token: dropped before a `}` or `]` (a trailing comma), written before anything else.
    let comma = ''
    const token = (/** @type {string} */ value) => {
        out += /^[}\]]/.test(value) ? comma.slice(1) : comma
        comma = ''
        out += value
    }
    for (let i = 0; i < text.length; i++) {
        const char = /** @type {string} */ (text[i])
        if (char === '"') {
            let end = i + 1
            while (end < text.length && text[end] !== '"') end += text[end] === '\\' ? 2 : 1
            token(text.slice(i, end + 1))
            i = end
        } else if (char === '/' && text[i + 1] === '/') {
            while (i + 1 < text.length && text[i + 1] !== '\n') i++
        } else if (char === '/' && text[i + 1] === '*') {
            const end = text.indexOf('*/', i + 2)
            i = end < 0 ? text.length : end + 1
        } else if (char === ',') {
            token('')
            comma = ','
        } else if (/\s/.test(char)) {
            if (comma) comma += char
            else out += char
        } else token(char)
    }
    return out + comma
}

/** Where knip looks for its JSON config at a workspace root, in its own order. */
const KNIP_JSON = ['knip.json', 'knip.jsonc', '.knip.json', '.knip.jsonc']

/**
 * KNIP'S WORKSPACES against the workspace's apps: a generated workspace's knip.json gives each app, and its seam, an
 * entry of its own (their entry files, and the dependencies SSSB's tools load from the app), so an app it does not name
 * is read with knip's defaults, which flag the seam's modules (the framework reads them from node_modules, which knip
 * does not follow) and the presets' dependencies as unused. Reported, never failed: knip's own run is the gate.
 * It also says when the root installs `@sssb/create` (as `sssb add-app` asks) and knip's root config does not ignore it:
 * nothing imports it (the command loads it from node_modules), so knip calls it an unused dependency.
 * Returns null when the root has no knip JSON config; `missing` is null when it has no `workspaces` (one config for
 * every package).
 * @param {string} root
 * @param {readonly string[]} apps absolute
 * @param {readonly string[]} packages the workspace's packages, absolute (workspacePackages)
 * @returns {{ file: string, missing: string[] | null, generator: boolean } | { file: string, unread: string } | null}
 */
export function knipGaps(root, apps, packages) {
    const file = KNIP_JSON.find((name) => existsSync(path.join(root, name)))
    if (file === undefined) return null
    let config
    try {
        const text = readFileSync(path.join(root, file), 'utf8')
        config = JSON.parse(file.endsWith('.jsonc') ? withoutJsonComments(text) : text)
    } catch (error) {
        return { file, unread: error instanceof Error ? error.message : String(error) }
    }
    const workspaces = config?.workspaces
    const hasWorkspaces = workspaces !== null && typeof workspaces === 'object'
    const rootConfig = hasWorkspaces ? workspaces['.'] : config
    const ignored = /** @type {unknown[]} */ (
        [config?.ignoreDependencies, rootConfig?.ignoreDependencies].flatMap((list) =>
            Array.isArray(list) ? list : [],
        )
    )
    const manifestFile = path.join(root, 'package.json')
    const rootManifest = existsSync(manifestFile) ? readJson(manifestFile) : {}
    const installs = ['dependencies', 'devDependencies'].some((field) => rootManifest?.[field]?.['@sssb/create'])
    const generator = Boolean(installs) && !ignored.includes('@sssb/create')
    if (!hasWorkspaces) return { file, missing: null, generator }
    const keys = Object.keys(workspaces)
    const named = (/** @type {string} */ rel) =>
        keys.some((key) => key === rel || path.posix.matchesGlob(rel, key.replace(/\/+$/, '')))
    /** @type {string[]} */
    const missing = []
    for (const app of apps) {
        const rel = path.relative(root, app).split(path.sep).join('/')
        // An app at the root is knip's `.` workspace, which a config with workspaces always has a say over; an app that
        // is no workspace package is part of the root's for knip, and needs no key of its own.
        if (rel !== '' && packages.includes(app) && !named(rel)) missing.push(rel)
        const seam = path.join(app, 'src', 'app-config')
        const seamRel = path.relative(root, seam).split(path.sep).join('/')
        if (packages.includes(seam) && !named(seamRel)) missing.push(seamRel)
    }
    return { file, missing, generator }
}

/** A full commit SHA, the only pin that cannot move. */
const COMMIT = /^[0-9a-f]{40}$/

/**
 * The `owner/name` a package.json's `repository` names on GitHub, lowercased, or null.
 * @param {unknown} repository the manifest's `repository` field (a string or `{ url }`)
 */
export function githubRepositoryOf(repository) {
    const url = typeof repository === 'string' ? repository : /** @type {{ url?: unknown }} */ (repository)?.url
    const match = typeof url === 'string' ? /github\.com[/:]([^/\s]+\/[^/\s]+?)(?:\.git)?\/?$/i.exec(url) : null
    return match?.[1] ? match[1].toLowerCase() : null
}

/**
 * @typedef {{ where: string, ref: string | null }} Pin a place the workspace pins SSSB, and the ref it pins (null: none,
 *   so it follows the default branch)
 */

/**
 * One `uses:` line that calls a reusable workflow (`uses: <owner>/<name>/.github/workflows/<file>@<ref>`), cut so a
 * caller can read or rewrite the ref (`sssb pin`): 1 everything up to and including the `@`, 2 the `owner/name`, 3 the
 * workflow's path, 4 the ref, 5 whatever follows it (a trailing comment, a carriage return). One regex for doctor's
 * report and the command that fixes what it reports, so they cannot disagree about what a pin is.
 */
export const WORKFLOW_USES =
    /^(\s*(?:-\s+)?uses:\s*['"]?([\w.-]+\/[\w.-]+)\/(\.github\/workflows\/[^@\s'"]+)@)([^\s'"#]+)([\s\S]*)$/

/**
 * Every call of a reusable workflow of `repository` in the workspace's workflow files, the owner and name compared as
 * GitHub compares them, without case.
 * @param {string} repository `owner/name`, lowercased
 * @param {{ file: string, text: string }[]} workflows
 * @returns {Pin[]}
 */
function workflowPins(repository, workflows) {
    /** @type {Pin[]} */
    const pins = []
    for (const { file, text } of workflows) {
        for (const line of text.split('\n')) {
            const match = WORKFLOW_USES.exec(line)
            if (match?.[2]?.toLowerCase() === repository)
                pins.push({ where: `${file} (${match[3]})`, ref: /** @type {string} */ (match[4]) })
        }
    }
    return pins
}

/**
 * The `owner/name` a marketplace's `source` names on GitHub, lowercased: a `github` source's `repo`, or a `git` source's
 * `url`. Null for any other source.
 * @param {any} source an `extraKnownMarketplaces.<name>.source` value
 * @returns {string | null}
 */
export function sourceRepository(source) {
    if (source?.source === 'github' && typeof source.repo === 'string')
        return source.repo.toLowerCase().replace(/\.git$/, '')
    return source?.source === 'git' ? githubRepositoryOf(source.url) : null
}

/**
 * Every marketplace `.claude/settings.json` declares from `repository` (`extraKnownMarketplaces.<name>.source`, a
 * `github` source naming it as `repo`, or a `git` one whose `url` is it), with its `ref`; and, when there is one, a
 * line when no plugin is enabled from any of them. A pinned marketplace loads nothing by itself: only
 * `enabledPlugins["<plugin>@<marketplace>"]: true` (or a non-empty array of version constraints) loads a plugin from
 * it. The kit does not know the plugin's name,
 * and needs not: SSSB's marketplace lists only SSSB's plugins, so any plugin enabled from it is one of them, while
 * `sssb@<another marketplace>` is a copy from elsewhere (a local checkout's, say), not the pinned one.
 * @param {string} repository `owner/name`, lowercased
 * @param {string} file the settings file, as shown
 * @param {string} text its contents
 * @returns {{ pins: Pin[], error: string | null, unused: string | null }}
 */
function marketplacePins(repository, file, text) {
    let settings
    try {
        settings = JSON.parse(text)
    } catch (error) {
        return {
            pins: [],
            error: `${file} is not JSON doctor can read (${error instanceof Error ? error.message : error})`,
            unused: null,
        }
    }
    /** @type {Pin[]} */
    const pins = []
    /** @type {string[]} */
    const names = []
    const marketplaces = settings?.extraKnownMarketplaces
    for (const [name, entry] of Object.entries(typeof marketplaces === 'object' && marketplaces ? marketplaces : {})) {
        const source = entry?.source
        if (sourceRepository(source) === repository) {
            names.push(name)
            pins.push({
                where: `${file} (marketplace ${name})`,
                ref: typeof source.ref === 'string' ? source.ref : null,
            })
        }
    }
    const plugins = settings?.enabledPlugins
    const entries = Object.entries(typeof plugins === 'object' && plugins ? plugins : {})
    const fromSssb = (/** @type {string} */ key) => names.includes(key.slice(key.lastIndexOf('@') + 1))
    // Claude Code takes `true`, or a non-empty array of version constraints, as enabled.
    const isOn = (/** @type {unknown} */ on) => on === true || (Array.isArray(on) && on.length > 0)
    if (names.length === 0 || entries.some(([key, on]) => isOn(on) && fromSssb(key)))
        return { pins, error: null, unused: null }
    const enabled = entries.filter(([, on]) => isOn(on)).map(([key]) => key)
    const off = entries
        .filter(([key, on]) => !isOn(on) && fromSssb(key))
        .map(([key, on]) => `${key}: ${JSON.stringify(on)}`)
    return {
        pins,
        error: null,
        unused:
            `${file} enables no plugin from marketplace ${names.join(', ')}, so the pin loads nothing: its enabledPlugins ` +
            `enable ${enabled.length > 0 ? enabled.join(', ') : 'none'}${off.length > 0 ? ` (and set ${off.join(', ')})` : ''}`,
    }
}

/**
 * The commit a kit's release stamp (the text of its dist/release.json) names, or null for none or one unreadable.
 * @param {string | null} stamp
 */
export function stampedCommit(stamp) {
    try {
        const parsed = stamp === null ? null : JSON.parse(stamp)
        return typeof parsed?.commit === 'string' && COMMIT.test(parsed.commit) ? parsed.commit : null
    } catch {
        return null
    }
}

/**
 * THE WORKFLOW AND PLUGIN PINS (ADR-0014 part 5): the commits the workspace pins SSSB's reusable workflow at and the
 * plugin's marketplace at, against the release commit the installed `@sssb/kit` stamps into its package
 * (`dist/release.json`). Never a failure: the pins are in the workspace's own files, not installed code, and CI and
 * people not using Claude Code have no plugin. `ok` only when the kit has a stamp, the workspace has both pins, and
 * every one is that commit, with a plugin enabled from the pinned marketplace (`enabledPlugins`); otherwise a report
 * naming what is missing, which pin differs (with both commits), or which plugins are enabled instead.
 * @param {{
 *   inRepo: boolean,
 *   version: string,
 *   stamp: string | null,
 *   repository: string | null,
 *   workflows: { file: string, text: string }[],
 *   settings: { file: string, text: string } | null,
 * }} input `stamp`: the text of the kit's dist/release.json, null when it has none; `repository`: the `owner/name` the
 *   kit's package.json names (githubRepositoryOf); `settings`: `.claude/settings.json`, null when the workspace has none
 * @returns {{ status: 'ok' | 'report', title: string, lines: string[] }}
 */
export function pinReport({ inRepo, version, stamp, repository, workflows, settings }) {
    const label = 'workflow and plugin pins'
    if (inRepo)
        return {
            status: 'report',
            title:
                `${label}: not checked: in-repo, @sssb/kit is this workspace's own source, which carries no release ` +
                'stamp (the commit a packed kit names in dist/release.json), so there is no release commit to compare ' +
                'pins with',
            lines: [],
        }
    if (repository === null)
        return {
            status: 'report',
            title: `${label}: not checked: @sssb/kit ${version}'s package.json names no GitHub repository, so doctor cannot tell which pins are SSSB's`,
            lines: [],
        }
    /** @type {string[]} */
    const lines = []
    const workflowFound = workflowPins(repository, workflows)
    if (workflowFound.length === 0)
        lines.push(`no workflow under .github/workflows calls a reusable workflow of ${repository}: no workflow pin`)
    /** @type {Pin[]} */
    let marketplaceFound = []
    /** @type {string | null} */
    let unused = null
    if (settings === null)
        lines.push(
            'no .claude/settings.json: no plugin marketplace pin (a workspace whose people do not use Claude Code has no plugin)',
        )
    else {
        const read = marketplacePins(repository, settings.file, settings.text)
        marketplaceFound = read.pins
        if (read.error !== null) lines.push(read.error)
        else if (read.pins.length === 0)
            lines.push(`${settings.file} declares no marketplace from ${repository}: no plugin marketplace pin`)
        unused = read.unused
    }
    const found = [...workflowFound, ...marketplaceFound]

    const commit = stampedCommit(stamp)
    if (commit === null)
        return {
            status: 'report',
            title:
                `${label}: not checked: @sssb/kit ${version} ` +
                (stamp === null
                    ? 'carries no release stamp (dist/release.json): it was packed before ADR-0014 P13 stamped one, or not by its own prepack'
                    : 'has a release stamp (dist/release.json) that names no commit') +
                ', so there is no release commit to compare the pins with',
            lines: [
                ...found.map((pin) => `${pin.where} pins ${pin.ref ?? 'no ref'}`),
                ...lines,
                ...(unused === null ? [] : [unused]),
            ],
        }

    const differing = found.filter((pin) => pin.ref !== commit)
    for (const pin of differing)
        lines.push(
            pin.ref === null
                ? `${pin.where} pins no ref, so it follows ${repository}'s default branch, not @sssb/kit's release commit ${commit}`
                : `${pin.where} pins ${pin.ref}${COMMIT.test(pin.ref) ? '' : ' (a branch or tag, not a commit)'}, not @sssb/kit's release commit ${commit}`,
        )
    const pinProblems = lines.length
    if (unused !== null) lines.push(unused)
    if (lines.length === 0)
        return {
            status: 'ok',
            title: `${label}: the reusable workflow and the plugin marketplace pin @sssb/kit ${version}'s release commit ${commit}`,
            lines: found.map((pin) => pin.where),
        }
    return {
        status: 'report',
        title:
            `${label}: ` +
            (pinProblems === 0
                ? `the pins are @sssb/kit ${version}'s release commit ${commit}, but no plugin is enabled from the ` +
                  "pinned marketplace (reported, not failed: enable it in this workspace's .claude/settings.json)"
                : (differing.length > 0
                      ? `${differing.length} pin(s) differ from @sssb/kit ${version}'s release commit ${commit}`
                      : `not every pin is there to compare with @sssb/kit ${version}'s release commit ${commit}`) +
                  " (reported, not failed: the pins are in this workspace's own files; `pnpm exec sssb pin` raises both to the release commit)"),
        lines,
    }
}
