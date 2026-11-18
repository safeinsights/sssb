// @ts-check
// WHICH MARKDOWN A REPOSITORY HOLDS TO ITS PATH CITATIONS, and the parser that reads them. Nothing here names this
// repository: the roots, the doc set, the exemptions and the reference apps are the adopter's `sssb.docPaths` in the
// root package.json, so the gate is theirs the day the framework leaves their tree.
//
// Two callers need the same answer and must never drift apart: the `check-doc-paths` gate, which fails the build
// when a doctrine doc cites a path that does not exist, and an adoption rewriter, which repoints those citations
// when an app is renamed or ejected. A second list would mean the rewriter could miss a file the gate checks, a
// broken gate on the adopter's first command.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'

/**
 * Build outputs are never checked. A doc may legitimately name one (the static demo's `dist-demo/index.html` is the
 * artifact you hand someone) but whether it exists on disk depends on whether you happened to run a build, which
 * would make the gate pass locally and fail on a clean checkout. A gate whose verdict depends on build state is not
 * a gate.
 */
const DEFAULT_BUILD_OUTPUTS = [
    'dist-demo',
    '.next',
    'coverage',
    'playwright-report',
    'test-results',
    'node_modules',
    '.data',
]

/** Backtick-quoted spans, which is how a doc set cites every path. */
const BACKTICKED = /`([^`\n]+)`/g

/** The `apps/<name>/` prefix of a citation, with globs and metavariables already excluded. */
const APP_PREFIX = /^apps\/[^/<*{]+\//

/** @param {unknown} value @returns {value is string[]} */
const isStringList = (value) => Array.isArray(value) && value.every((entry) => typeof entry === 'string')

/** @type {import('./doc-paths.d.ts').readDocPathsConfig} */
export function readDocPathsConfig(root) {
    const manifest = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'))
    const block = manifest?.sssb?.docPaths
    if (block === undefined)
        throw new Error(`sssb: ${root}/package.json has no \`sssb.docPaths\`: the doc-paths gate needs it`)
    if (typeof block !== 'object' || block === null || Array.isArray(block))
        throw new Error('sssb: `sssb.docPaths` in the root package.json must be an object')
    for (const key of ['roots', 'include', 'exempt']) {
        if (!isStringList(block[key])) throw new Error(`sssb: \`sssb.docPaths.${key}\` must be a list of strings`)
    }
    for (const key of ['referenceApps', 'buildOutputs']) {
        if (block[key] !== undefined && !isStringList(block[key]))
            throw new Error(`sssb: \`sssb.docPaths.${key}\` must be a list of strings when present`)
    }
    const bases = block.relativeTo
    if (
        bases !== undefined &&
        (typeof bases !== 'object' ||
            bases === null ||
            Array.isArray(bases) ||
            !Object.values(bases).every((base) => typeof base === 'string'))
    )
        throw new Error('sssb: `sssb.docPaths.relativeTo` must map doc paths to directories (strings) when present')
    return block
}

/**
 * @param {string} root
 * @param {string} rel
 * @param {import('./doc-paths.d.ts').DocPathsConfig} config
 * @param {string[]} out
 */
function collectDocs(root, rel, config, out) {
    for (const entry of readdirSync(path.join(root, rel)).sort()) {
        const child = rel === '' ? entry : `${rel}/${entry}`
        if (config.exempt.some((exempt) => child.startsWith(exempt))) continue
        if (statSync(path.join(root, child)).isDirectory()) collectDocs(root, child, config, out)
        else if (path.extname(child) === '.md') out.push(child)
    }
}

/**
 * `text` without its leading and trailing characters that are in `chars`. A loop, not `/^x+|x+$/` or `/x+$/`: a
 * backtracking regex anchored at the end retries from every position of a long run of `x` that is followed by
 * anything else, so it takes time quadratic in the run's length, and the text here comes from the docs and the
 * configuration a caller hands in.
 * @param {string} text
 * @param {string} chars
 * @param {{ start?: boolean }} [options] `start: false` trims the end only
 */
function trimChars(text, chars, { start = true } = {}) {
    let from = 0
    let to = text.length
    if (start) while (from < to && chars.includes(/** @type {string} */ (text[from]))) from++
    while (to > from && chars.includes(/** @type {string} */ (text[to - 1]))) to--
    return text.slice(from, to)
}

/** `text` without its trailing slashes. @param {string} text */
const trimTrailingSlashes = (text) => trimChars(text, '/', { start: false })

/**
 * The root-level entries are listed rather than globbed because a repo root accumulates markdown that is NOT
 * doctrine (a stray NOTES.md should not become a build gate). SECURITY.md earns its place in SSSB by citing the
 * code that backs its claims, an RLS proof suite, a fail-closed guard.
 *
 * Be precise about what that buys: `resolves()` below keeps a FILE citation alive on its parent directory
 * existing, so gating SECURITY.md catches a moved DIRECTORY, not a moved file. That is a deliberate trade (recipes
 * cite files you are meant to create), and it is measured: 22 citations across SSSB's doc set resolve only by that
 * fallback, nearly all of them legitimately unbuilt.
 *
 * @type {import('./doc-paths.d.ts').docFiles}
 */
export function docFiles(root, config) {
    /** @type {string[]} */
    const out = []
    for (const entry of config.include) {
        const rel = trimTrailingSlashes(entry)
        if (config.exempt.some((exempt) => rel.startsWith(exempt))) continue
        const abs = path.join(root, rel)
        if (!existsSync(abs)) continue
        if (statSync(abs).isDirectory()) collectDocs(root, rel, config, out)
        else out.push(rel)
    }
    return out
}

/**
 * The `include` entries that name nothing in the tree. A typo there would silently shrink the gate (`"doc"` for
 * `"docs"` checks no doc at all and passes), so the gate fails on one instead.
 *
 * @type {import('./doc-paths.d.ts').missingIncludes}
 */
export function missingIncludes(root, config) {
    return config.include
        .map(trimTrailingSlashes)
        .filter((rel) => !config.exempt.some((exempt) => rel.startsWith(exempt)) && !existsSync(path.join(root, rel)))
}

/**
 * The path-like tokens inside one backticked span.
 *
 * Usually the span IS the path, `apps/showcase/src/app-config`, and that stays one citation. But a doc set also
 * cites paths INSIDE backticked commands, and such a span starts with `pnpm` or `git`, not with a repo root. Reading
 * whole spans only, the gate could not see those at all, and two had rotted unnoticed: a `fixtures/llm/` and a
 * `tests/e2e/a11y.spec.ts` that had both moved under `apps/showcase/`. A gate blind to a whole citation FORM is not
 * a gate over that form.
 *
 * @param {string} raw
 * @param {string[]} roots
 * @returns {string[]}
 */
function pathTokens(raw, roots) {
    if (roots.some((root) => raw.startsWith(root))) return [raw]
    return raw
        .split(/\s+/)
        .map((token) =>
            trimChars(
                trimChars(token, `'"`) // `pnpm --filter './apps/*'`
                    .replace(/^\.\//, ''), // ./apps/... is the same path as apps/...
                ',;)',
                { start: false },
            ),
        )
        .filter((token) => roots.some((root) => token.startsWith(root)))
}

/** @type {import('./doc-paths.d.ts').citationsIn} */
export function citationsIn(text, config) {
    const buildOutputs = config.buildOutputs ?? DEFAULT_BUILD_OUTPUTS
    /** @type {import('./doc-paths.d.ts').Citation[]} */
    const found = []
    text.split('\n').forEach((lineText, index) => {
        for (const match of lineText.matchAll(BACKTICKED)) {
            const raw = (match[1] ?? '').trim()
            for (const token of pathTokens(raw, config.roots)) {
                // A trailing `:12` (or `:12:5`) is a LINE REFERENCE into the file, not part of its name:
                // `docs/build-notes.md:52` asserts that document exists, and read literally it asserts a file
                // nothing could ever create.
                const located = token.replace(/:\d+(?::\d+)?$/, '')
                // A glob, a brace expansion or a `<metavariable>` placeholder only asserts its static prefix
                // exists: `packages/kit/src/adapters/<real|fake>/<name>.ts` is a template, and
                // `messages/{en,es}.json` names two files, neither of them spelled that way.
                const stop = ['*', '<', '{'].map((char) => located.indexOf(char)).filter((i) => i >= 0)
                const stripped = stop.length ? located.slice(0, Math.min(...stop)) : located
                const cited = trimTrailingSlashes(stripped)
                if (!cited) continue
                if (cited.split('/').some((segment) => buildOutputs.includes(segment))) continue
                found.push({ path: cited, raw, line: index + 1 })
            }
        }
    })
    return found
}

/**
 * A doc named in `relativeTo` cites paths relative to a directory, not to the root: the app guide `@sssb/kit` ships
 * says `src/app-config/` and `config/params.ts` because an adopter reads it about their own app, so SSSB checks it
 * against `apps/starter`. Its citations come back joined onto that directory, so `resolves`, the reference-app rule
 * and every message see the path as it sits in this tree. In such a doc EVERY citation is relative to the directory,
 * so an `apps/…` or `packages/…` path in it fails, which is right: an adopter's app holds neither.
 *
 * @type {import('./doc-paths.d.ts').citedPaths}
 */
export function citedPaths(file, config, root) {
    const found = citationsIn(readFileSync(path.resolve(root, file), 'utf8'), config)
    const relative = config.relativeTo?.[file.replace(/^\.\//, '')]
    if (relative === undefined) return found
    const base = trimTrailingSlashes(relative)
    return found.map((citation) => ({ ...citation, path: path.posix.join(base, citation.path) }))
}

/**
 * The reference apps a citation may name while absent, as a regex built from the config; null when none are
 * configured, in which case the rule never applies.
 *
 * @param {import('./doc-paths.d.ts').DocPathsConfig} config
 */
function referenceAppPattern(config) {
    const apps = config.referenceApps ?? []
    if (apps.length === 0) return null
    const names = apps.map((name) => name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    return new RegExp(`^apps/(${names.join('|')})(?:/|$)`)
}

/**
 * SSSB's two reference apps, which a doc may cite by name: every scaffold command points at `apps/showcase/...` for
 * its worked example, and the adoption guide describes `apps/starter`.
 *
 * In the TEMPLATE both exist, so a citation of either is checked like any other and a broken one fails. In an
 * ADOPTED tree they usually do not: a forked adopter deleted the showcase and renamed the starter, and a workspace
 * `@sssb/create` writes has neither. The adoption script that came before the generator repointed the citations it
 * found on the day it ran, but an upstream merge (ADR-0013) later brought in NEW text that named them again, and the
 * gate went red on a citation nobody in the adopter's repo wrote, the first time a recipe cited the starter's
 * sign-in page.
 *
 * So a citation under `apps/<reference app>/` whose app is not in this tree is a reference to SSSB's own app, which
 * cannot be checked here and is not this repo's to fix. It resolves.
 *
 * "In this tree" means the app's `package.json` exists, NOT that its directory does. A merge adds any new file
 * upstream puts under `apps/showcase/` even after you deleted the app (git reports a conflict for a file you
 * deleted and upstream edited, and silently resurrects one that is new), so a directory holding a single stray file
 * would otherwise switch this rule off and turn the gate red on the next doc. A local `apps/starter/node_modules`
 * left behind by a rename does the same. The package manifest is what makes it an app, and a stray file cannot fake
 * it. Everything else stays strict: the adopter's own app (`apps/console/...`), a path in `packages/kit`, and either
 * reference app for as long as it is present. The reference apps are a closed list on purpose: an adopter who keeps
 * the name `starter` has the directory, so their own citations of it are still checked.
 *
 * Here, and not in the test, so a rewriter that asks `resolves` which citations are gone before it generalizes them
 * to `apps/<app>/...` (`generalizeAppCitations`) and the gate cannot disagree.
 *
 * @param {string} cited
 * @param {string} root
 * @param {import('./doc-paths.d.ts').DocPathsConfig} config
 */
function namesAbsentReferenceApp(cited, root, config) {
    const app = referenceAppPattern(config)?.exec(cited)?.[1]
    return app !== undefined && !existsSync(path.join(root, 'apps', app, 'package.json'))
}

/**
 * A directory citation must resolve outright. A FILE citation may also pass on its parent directory existing,
 * because a doc may legitimately name a file you are meant to create, as every recipe does
 * (`packages/kit/src/adapters/real/esign.ts` is the recipe's output, not a file in the tree).
 *
 * The asymmetry matters: allowing the parent fallback for directories too would let `src/app-confgi` pass on the
 * strength of `src/` existing, which defeats the point.
 *
 * @type {import('./doc-paths.d.ts').resolves}
 */
export function resolves(cited, root, config) {
    if (namesAbsentReferenceApp(cited, root, config)) return true
    if (existsSync(path.join(root, cited))) return true
    const looksLikeFile = path.basename(cited).includes('.')
    return looksLikeFile && existsSync(path.join(root, path.dirname(cited)))
}

/**
 * Generalize every citation of an app path that `isMissing` reports as gone into the metavariable form
 * `apps/<app>/...`, which the gate reads as asserting only that `apps/` exists.
 *
 * An adoption rewriter is the caller: after a rename or an eject, docs cite files the surviving app does not have
 * (the scaffold docs teach `src/jobs/`, `src/domain/`, `src/app/api/` because the SHOWCASE has them). Those
 * sentences never meant "this app", they meant "your app".
 *
 * ONE SPAN CAN CARRY SEVERAL CITATIONS, and that is the whole subtlety this function exists for. A backticked
 * command, `cp apps/showcase/src/jobs/x.ts apps/showcase/src/domain/y.ts`, yields TWO citations sharing one `raw`.
 * Rewriting them one at a time cannot work: the first rewrite means the original span no longer appears in the
 * document, so every later citation in it is silently skipped (and `String.replace(string, ...)` only ever replaced
 * the first occurrence anyway). The result was a half-rewritten command with a dangling path, a doc-path gate red
 * on the adopter's FIRST command, the exact failure the shared list at the top of this file exists to prevent. So:
 * group by span, apply every replacement the span needs, then substitute the span once. Longest path first, so a
 * shorter citation can never eat the prefix of a longer one.
 *
 * @type {import('./doc-paths.d.ts').generalizeAppCitations}
 */
export function generalizeAppCitations(text, isMissing, config) {
    /** @type {Map<string, string[]>} */
    const bySpan = new Map()
    for (const { path: cited, raw } of citationsIn(text, config)) {
        if (!APP_PREFIX.test(cited) || !isMissing(cited)) continue
        const paths = bySpan.get(raw) ?? []
        if (!paths.includes(cited)) paths.push(cited)
        bySpan.set(raw, paths)
    }

    let out = text
    for (const [raw, paths] of bySpan) {
        let span = raw
        for (const cited of [...paths].sort((a, b) => b.length - a.length)) {
            span = span.split(cited).join(cited.replace(APP_PREFIX, 'apps/<app>/'))
        }
        if (span !== raw) out = out.split(`\`${raw}\``).join(`\`${span}\``)
    }
    return out
}

/** @type {import('./doc-paths.d.ts').docPathProblems} */
export function docPathProblems(root, config) {
    /** @type {string[]} */
    const problems = missingIncludes(root, config).map((rel) => `${rel}: in sssb.docPaths.include, but not in the tree`)
    const files = docFiles(root, config)
    if (files.length === 0) problems.push('sssb.docPaths.include names no markdown file: the gate would check nothing')
    for (const file of files) {
        for (const { path: cited, line } of citedPaths(file, config, root)) {
            if (!resolves(cited, root, config)) problems.push(`${file}:${line} cites \`${cited}\``)
        }
    }
    return problems
}
