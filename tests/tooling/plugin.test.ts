import { spawnSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import ts from 'typescript'
import { beforeAll, describe, expect, it } from 'vitest'
import { parse as parseYaml } from 'yaml'
import eslintPlugin from '../../packages/eslint-plugin/src/index.js'
import { generate } from '../../packages/create/src/generate.js'
import { buildTemplate } from '../../packages/create/src/template.js'
import { makeTestTmpDir } from '../support/tmp-dir'

/**
 * SSSB's Claude Code plugin (ADR-0014 part 9, step P13): the marketplace at the repository root
 * (`.claude-plugin/marketplace.json`) and the plugin it lists (`plugins/sssb`), whose commands and agent an app
 * author runs in a workspace `@sssb/create` generated.
 *
 * (a) The manifests' shape, checked here without the `claude` binary, so it never skips (CI has no `claude`).
 * (b) Every reference a command or agent makes resolves in a workspace generated from this repository's live tree.
 *     It reads the prose's code spans, the bare paths and rule ids in the prose, and the fenced code blocks (a shell
 *     block's lines are commands; a TypeScript block's imports are specifiers). The conventions, for the text:
 *       - a path resolves against the app, then the workspace root; a path in a command, against the directory the
 *         command runs in. `<app>` is the app's slug (its directory and package name). Any other `<placeholder>`,
 *         `…` or `*` ends what is known: the path's fixed part before that segment must exist (or be created);
 *       - a path right after the word "create" (not "do not create", "never create") is one the command tells you
 *         to create; later mentions of it, of a path under it, or of a file in it by its bare name, resolve;
 *       - "(if any)" right after a path excuses only OPTIONAL: places the app guide names that an app may lack;
 *       - a runtime path is an entry the generated `.gitignore` names, exactly (`.data/`), or a build output
 *         listed in RUNTIME_OUTPUTS with the app script that writes it; nothing under `node_modules`, ever;
 *       - a `pnpm` script exists in a generated workspace AND in this repository (root, or both apps, by where it
 *         runs); `pnpm exec <bin>` takes a binary a dependency of the package it runs in declares (the workspace
 *         root, or the app under `--filter <app>`, `-C`, `cd`), never one pnpm only happens to hoist; `sssb …`
 *         names a command `sssb --help` lists; `npx` and `pnpm dlx` of SSSB's packages, and a package binary run
 *         bare, fail;
 *       - `@sssb/<package>/<subpath>` is a dependency of the generated workspace and in that package's `exports`,
 *         `@sssb/app-config/<module>` and `@/<module>` resolve in the app, `sssb/<rule>` is an
 *         `@sssb/eslint-plugin` rule, `/sssb:<command>` is a plugin command;
 *       - an identifier the text ties to an `@sssb/kit/…` module ("`X` (`@sssb/kit/m`)", "`X` from|in
 *         `@sssb/kit/m`", a list of them, "`@sssb/kit/m` (`X`, `Y`)", or a fenced import) is exported by it;
 *       - SSSB's own files are cited ONLY as a code span `https://github.com/safeinsights/sssb/(blob|tree)/<ref>/<path>`
 *         whose path exists in this tree (the plugin and the file are read at the same commit); any other mention of
 *         the repository (bare, a markdown link, `http://`, `www.`, raw.githubusercontent, a branch) fails.
 * (c) `claude plugin validate --strict` on the marketplace and the plugin, when the binary is on PATH.
 */
const REPO = path.resolve(__dirname, '../..')
const MARKETPLACE = path.join(REPO, '.claude-plugin/marketplace.json')
const SLUG = 'acme'

const readJson = (file: string) => JSON.parse(readFileSync(file, 'utf8'))
interface Entry {
    name: string
    source: string
    description?: unknown
    version?: string
}
const marketplace = readJson(MARKETPLACE)
const entries: Entry[] = marketplace.plugins
const pluginDirs = entries.map((entry) => path.join(REPO, entry.source))

/** The markdown component files of a plugin: commands/*.md and agents/*.md. */
function componentFiles(pluginDir: string) {
    return ['commands', 'agents'].flatMap((kind) => {
        const dir = path.join(pluginDir, kind)
        if (!existsSync(dir)) return []
        return readdirSync(dir)
            .filter((file) => file.endsWith('.md'))
            .map((file) => ({ kind, name: file.slice(0, -3), file: path.join(dir, file) }))
    })
}

function frontmatter(file: string): { data: Record<string, unknown>; body: string } {
    const text = readFileSync(file, 'utf8')
    const match = /^---\n([\s\S]*?)\n---\n/.exec(text)
    if (!match) return { data: {}, body: text }
    return { data: (parseYaml(match[1]) ?? {}) as Record<string, unknown>, body: text.slice(match[0].length) }
}

describe('the plugin marketplace: shape', () => {
    const KEBAB = /^[a-z0-9]+(-[a-z0-9]+)*$/
    const RESERVED = /^(claude|anthropic)/

    it('names itself, an owner and at least one plugin, each from a relative source inside the repository', () => {
        expect(marketplace.name).toMatch(KEBAB)
        expect(marketplace.name).not.toMatch(RESERVED)
        expect(typeof marketplace.owner?.name).toBe('string')
        expect(marketplace.plugins.length).toBeGreaterThan(0)
        for (const entry of entries) {
            expect(entry.name).toMatch(KEBAB)
            expect(entry.name).not.toMatch(RESERVED)
            expect(typeof entry.description).toBe('string')
            expect(entry.source).toMatch(/^\.\//)
            expect(entry.source.split('/')).not.toContain('..')
            const dir = path.join(REPO, entry.source)
            expect(statSync(dir).isDirectory()).toBe(true)
            // The plugin is not a workspace package: pnpm-workspace.yaml must not pick it up.
            expect(existsSync(path.join(dir, 'package.json'))).toBe(false)
        }
    })

    it.each(entries)(
        'plugin $name: its manifest agrees with the entry and names no version, so a moved pin moves the plugin',
        (entry) => {
            const dir = path.join(REPO, entry.source)
            const manifest = readJson(path.join(dir, '.claude-plugin/plugin.json'))
            expect(manifest.name).toBe(entry.name)
            expect(typeof manifest.description).toBe('string')
            expect(typeof manifest.author?.name).toBe('string')
            // A set version keeps every user on the cached copy until the string changes, whatever commit the
            // marketplace is pinned to; with none, Claude Code versions the plugin by the commit it came from.
            expect(manifest.version).toBeUndefined()
            expect(entry.version).toBeUndefined()
            for (const key of ['commands', 'agents', 'skills', 'hooks', 'mcpServers']) {
                for (const rel of [manifest[key] ?? []].flat()) {
                    if (typeof rel === 'string') expect(existsSync(path.join(dir, rel)), `${key}: ${rel}`).toBe(true)
                }
            }
            const files = componentFiles(dir)
            expect(files.length).toBeGreaterThan(0)
            for (const { kind, name, file } of files) {
                const { data } = frontmatter(file)
                expect(typeof data.description, `${file}: description`).toBe('string')
                if (kind === 'agents') expect(data.name, `${file}: name`).toBe(name)
            }
        },
    )

    it('is ONE copy: no command or agent of this repository shadows a plugin one', () => {
        const local = (kind: string) =>
            existsSync(path.join(REPO, '.claude', kind))
                ? readdirSync(path.join(REPO, '.claude', kind)).map((file) => file.replace(/\.md$/, ''))
                : []
        for (const dir of pluginDirs) {
            for (const { kind, name } of componentFiles(dir)) expect(local(kind), `${kind}/${name}`).not.toContain(name)
        }
    })

    it("this repository's project settings enable the plugin and commit no machine path", () => {
        const settings = readJson(path.join(REPO, '.claude/settings.json'))
        for (const entry of entries) {
            expect(settings.enabledPlugins?.[`${entry.name}@${marketplace.name}`]).toBe(true)
        }
        // The marketplace itself is each maintainer's `claude plugin marketplace add ./ --scope local`, which writes an
        // absolute path to the gitignored settings.local.json; a committed absolute path would be one machine's.
        for (const declared of Object.values(settings.extraKnownMarketplaces ?? {}) as {
            source: { path?: string }
        }[]) {
            expect(path.isAbsolute(declared.source.path ?? '')).toBe(false)
        }
    })
})

/** What a reference is checked against: a generated workspace and this repository's own manifests. */
interface Context {
    ws: string
    app: string
    rootScripts: Set<string>
    appScripts: Set<string>
    repoRootScripts: Set<string>
    repoAppScripts: Set<string>
    rootBins: Set<string>
    appBins: Set<string>
    repoRootBins: Set<string>
    repoAppBins: Set<string>
    /** Every package binary any of those declares: a span starting with one runs it bare, off PATH. */
    allBins: Set<string>
    /** SSSB's packages (packages/*), by name, with their `exports` keys. */
    sssbPackages: Map<string, Set<string>>
    /** The SSSB packages a generated workspace depends on (root or app). */
    installedSssb: Set<string>
    /** `@sssb/kit`'s subpaths (`./core/presets`) to their source files, for the identifier check. */
    kitModules: Map<string, string>
    sssbCommands: Set<string>
    ruleIds: Set<string>
    pluginCommands: Set<string>
    ignored: string[]
}

/**
 * Places the app guide names that an app may not have yet: the only paths "(if any)" excuses. A test below holds each
 * to the guide, so the list cannot grow into a general escape.
 */
const OPTIONAL = ['src/adapters/real/', 'lint-exceptions.mjs']
/** Build output a command may name, app-relative, with the app script that writes it (checked to exist). */
const RUNTIME_OUTPUTS = new Map([['dist-demo/index.html', 'build:demo-static']])

let ctx: Context

const deps = (file: string) => {
    const manifest = readJson(file)
    return Object.keys({ ...manifest.dependencies, ...manifest.devDependencies })
}
/** The binaries the named packages declare, read from this repository's installed copies (SSSB's from source). */
function binsOf(names: string[]): Set<string> {
    const bins = new Set<string>()
    for (const name of names) {
        const manifest = name.startsWith('@sssb/')
            ? path.join(REPO, 'packages', name.slice('@sssb/'.length), 'package.json')
            : [REPO, path.join(REPO, 'apps/showcase'), path.join(REPO, 'apps/starter')]
                  .map((dir) => path.join(dir, 'node_modules', name, 'package.json'))
                  .find((file) => existsSync(file))
        if (!manifest || !existsSync(manifest)) continue
        const bin: unknown = readJson(manifest).bin
        if (typeof bin === 'string') bins.add(name.split('/').pop() ?? name)
        else if (bin && typeof bin === 'object') for (const key of Object.keys(bin)) bins.add(key)
    }
    return bins
}
const intersect = (a: Set<string>, b: Set<string>) => new Set([...a].filter((x) => b.has(x)))

beforeAll(() => {
    const template = path.join(makeTestTmpDir('plugin-template-'), 'template')
    buildTemplate({ repoRoot: REPO, outDir: template })
    const ws = path.join(makeTestTmpDir('plugin-ws-'), SLUG)
    generate({ templateDir: template, target: ws, slug: SLUG, name: 'Acme' })
    const app = path.join(ws, 'apps', SLUG)
    const scripts = (file: string) => new Set(Object.keys(readJson(file).scripts ?? {}))
    const help = spawnSync(process.execPath, [path.join(REPO, 'packages/tools/bin/sssb.js'), '--help'], {
        encoding: 'utf8',
    })
    const sssbPackages = new Map(
        readdirSync(path.join(REPO, 'packages'))
            .map((dir) => path.join(REPO, 'packages', dir, 'package.json'))
            .filter((file) => existsSync(file))
            .map((file) => readJson(file))
            .filter((manifest) => typeof manifest.name === 'string' && manifest.name.startsWith('@sssb/'))
            .map((manifest) => [manifest.name.slice('@sssb/'.length), new Set(Object.keys(manifest.exports ?? {}))]),
    )
    const kitExports: Record<string, unknown> = readJson(path.join(REPO, 'packages/kit/package.json')).exports
    const generatedDeps = [...deps(path.join(ws, 'package.json')), ...deps(path.join(app, 'package.json'))]
    const rootBins = binsOf(deps(path.join(ws, 'package.json')))
    const appBins = binsOf(deps(path.join(app, 'package.json')))
    const repoRootBins = binsOf(deps(path.join(REPO, 'package.json')))
    const repoAppBins = intersect(
        binsOf(deps(path.join(REPO, 'apps/showcase/package.json'))),
        binsOf(deps(path.join(REPO, 'apps/starter/package.json'))),
    )
    ctx = {
        ws,
        app,
        rootScripts: scripts(path.join(ws, 'package.json')),
        appScripts: scripts(path.join(app, 'package.json')),
        repoRootScripts: scripts(path.join(REPO, 'package.json')),
        repoAppScripts: intersect(
            scripts(path.join(REPO, 'apps/starter/package.json')),
            scripts(path.join(REPO, 'apps/showcase/package.json')),
        ),
        rootBins,
        appBins,
        repoRootBins,
        repoAppBins,
        allBins: new Set([...rootBins, ...appBins, ...repoRootBins, ...repoAppBins]),
        sssbPackages,
        installedSssb: new Set(generatedDeps.filter((name) => name.startsWith('@sssb/'))),
        kitModules: new Map(
            Object.entries(kitExports)
                .filter((entry): entry is [string, string] => typeof entry[1] === 'string')
                .filter(([, file]) => /\.tsx?$/.test(file))
                .map(([key, file]) => [key, path.join(REPO, 'packages/kit', file)]),
        ),
        sssbCommands: new Set([...help.stdout.matchAll(/^ {2}([a-z][\w-]*) /gm)].map((m) => m[1])),
        ruleIds: new Set(Object.keys(eslintPlugin.rules).map((id) => `sssb/${id}`)),
        pluginCommands: new Set(pluginDirs.flatMap((dir) => componentFiles(dir).map((c) => c.name))),
        ignored: readFileSync(path.join(ws, '.gitignore'), 'utf8')
            .split('\n')
            .filter((line) => line && !line.startsWith('#') && !line.startsWith('!')),
    }
    // A sanity check on the context itself, so a broken parse cannot make every reference "unknown" or "fine".
    expect(ctx.sssbCommands).toContain('doctor')
    expect(ctx.ruleIds).toContain('sssb/no-raw-db-handle')
    expect(ctx.rootScripts).toContain('verify')
    expect(ctx.appBins).toContain('playwright')
    expect(ctx.rootBins).toContain('sssb')
    expect(ctx.rootBins).not.toContain('playwright')
    expect(ctx.installedSssb).toContain('@sssb/kit')
    expect(ctx.kitModules.size).toBeGreaterThan(50)
})

/** Where SSSB's framework, reference app and repo-only files live: never a path in a plugin command. */
const REPO_ONLY = /^(packages\/kit\/|apps\/(showcase|starter)\/|scripts\/|tests\/support\/|packages\/seed\/)/
const PATH_CHARS = /^[\w.@<>[\]()*~+…-]+(?:\/[\w.@<>[\]()*~+…-]*)*$/
const EXT = 'tsx|ts|mjs|cjs|js|json|md|ya?ml|css|html'
const EXTENSION = new RegExp(`\\.(${EXT})$`)
const PLACEHOLDER = /<[^>]*>|…|\*/
const ROOTS = [
    'src',
    'apps',
    'packages',
    'tests',
    'docs',
    'scripts',
    'config',
    'messages',
    'infra',
    '.claude',
    '.github',
]
/** A bare path under a root this repository's apps use, with or without an extension. */
const BARE_ROOTED = new RegExp(
    `(?<![\\w/.@\`~-])((?:${ROOTS.map((r) => r.replace('.', '\\.')).join('|')})/[\\w./<>[\\]()*@~…-]*)`,
    'g',
)
/** Any other bare path-like token: filtered in code to one with a `/` and an extension or a trailing `/`. */
const BARE_ANY = /(?<![\w/.@~\])>:-])([\w.@<[~…-][\w.@<>[\]()*+~…-]*(?:\/[\w.@<>[\]()*+~…-]*)+)/g
const BARE_RULE = /(?<![\w@/.:-])(sssb\/[\w-]+\/?)/g
/** SSSB cited the one accepted way: a code span holding a pinned github.com URL. */
const PINNED = /`https:\/\/github\.com\/safeinsights\/sssb\/(?:blob|tree)\/<ref>\/([^`\s]+)`/g
/** Any mention of SSSB's repository, however it is written. */
const SSSB_REPO = /safeinsights(?:\/|\.github\.io\/)sssb\b/gi
const URLS = /(?:\b(?:https?:\/\/|www\.)|\b[\w.-]*github(?:usercontent)?\.com\/)[^\s`)\]>]*/g
const FENCE = /^[ \t]*(`{3,}|~{3,})[ \t]*([\w-]*)[^\n]*\n([\s\S]*?)^[ \t]*\1[ \t]*$/gm
const SHELL = new Set(['', 'sh', 'bash', 'shell', 'console', 'zsh'])
const SCRIPT = new Set(['ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'typescript', 'javascript'])
const PNPM_BUILTINS = new Set([
    'install',
    'i',
    'add',
    'remove',
    'rm',
    'update',
    'up',
    'outdated',
    'why',
    'list',
    'ls',
    'create',
    'store',
    'patch',
])

const normalize = (rel: string) => rel.replaceAll('<app>', SLUG).replace(/^\.\//, '')
/** `apps/<slug>/x` → `x`, for a check that is about the app's own tree. */
const appRelative = (rel: string) => rel.replace(new RegExp(`^apps/${SLUG}/`), '')

function existsIn(bases: string[], rel: string) {
    return bases.some((root) => existsSync(path.join(root, rel)))
}

/** Whether a module specifier under `src/` resolves (as TypeScript would), in the workspace or among created files. */
function moduleExists(c: Context, rel: string, created: string[]) {
    const p = rel.replace(/\/\*$/, '/')
    if (p.endsWith('/')) return existsIn([c.app], p) || created.some((file) => file.startsWith(p))
    const candidates = [p, `${p}.ts`, `${p}.tsx`, `${p}/index.ts`, `${p}/index.tsx`]
    return candidates.some((candidate) => existsIn([c.app], candidate) || created.includes(candidate))
}

/** A runtime path: an exact `.gitignore` entry, or a listed build output whose script the app has. */
function isRuntime(c: Context, rel: string) {
    const p = appRelative(rel)
    const script = RUNTIME_OUTPUTS.get(p)
    if (script !== undefined) return c.appScripts.has(script)
    return c.ignored.some((pattern) => pattern.replace(/^\//, '') === p)
}

/** Whether `rel` is a created path, under a created directory, a directory holding one, or a created file's name. */
function isCreated(rel: string, created: string[]) {
    return created.some(
        (file) =>
            file === rel ||
            file.startsWith(rel.endsWith('/') ? rel : `${rel}/`) ||
            (file.endsWith('/') && rel.startsWith(file)) ||
            (!rel.includes('/') && file.endsWith(`/${rel}`)),
    )
}

/** Problems with a path (already known to be path-like), resolved against `bases`. */
function checkPath(c: Context, token: string, created: string[], optional: boolean, bases: string[]): string | null {
    if (REPO_ONLY.test(token))
        return "is SSSB's own tree, which an adopter does not have: cite @sssb/kit/… or a <ref> URL"
    if (/(^|\/)node_modules(\/|$)/.test(token)) return 'is inside node_modules, which no command may point into'
    const p = normalize(token)
    const segments = p.split('/')
    const open = segments.findIndex((segment) => PLACEHOLDER.test(segment))
    if (open !== -1) {
        // A placeholder ends what is known; the fixed part before it must still be real.
        if (open === 0 || isCreated(p, created)) return null
        const fixed = `${segments.slice(0, open).join('/')}/`
        return existsIn(bases, fixed) || isCreated(fixed, created)
            ? null
            : `its fixed part \`${fixed}\` does not exist in a generated workspace`
    }
    if (existsIn(bases, p) || isRuntime(c, p) || isCreated(p, created)) return null
    if (optional) {
        return OPTIONAL.some((place) => appRelative(p) === place || appRelative(p).startsWith(place))
            ? null
            : `"(if any)" excuses only the optional places the app guide names (${OPTIONAL.join(', ')})`
    }
    return 'does not exist in a generated workspace (mark a file the command creates with "create")'
}

/** Problems with an `@sssb/…` specifier. */
function checkSssbSpecifier(c: Context, token: string, created: string[]): string | null {
    const [, name, sub] = /^@sssb\/([^/]+)(?:\/(.*))?$/.exec(token) ?? []
    if (name === undefined) return 'is not an SSSB package'
    if (name === 'app-config') {
        if (sub === undefined || sub === '*' || PLACEHOLDER.test(sub)) return null
        return moduleExists(c, `src/app-config/${sub}`, created) ? null : 'no such seam module'
    }
    const exported = c.sssbPackages.get(name)
    if (!exported) return 'is not an SSSB package'
    if (sub === undefined) return null
    if (!c.installedSssb.has(`@sssb/${name}`)) return `@sssb/${name} is not a dependency of a generated workspace`
    const open = sub.split('/').findIndex((segment) => PLACEHOLDER.test(segment))
    if (open !== -1) {
        const fixed = sub.split('/').slice(0, open).join('/')
        return fixed === '' || [...exported].some((key) => key.startsWith(`./${fixed}/`))
            ? null
            : `no @sssb/${name} subpath under ./${fixed}/`
    }
    return exported.has(`./${sub}`) ? null : `is not in @sssb/${name}'s exports`
}

/** Problems with one reference written without spaces: a path, a specifier, a rule, a command name. */
function checkToken(c: Context, token: string, created: string[], optional = false, bases?: string[]): string | null {
    if (/^(?:https?:\/\/|www\.)/.test(token)) return null // URLs: the SSSB scan in referenceProblems owns them
    if (/^\/sssb:/.test(token)) {
        return c.pluginCommands.has(token.slice('/sssb:'.length)) ? null : 'names a plugin command that does not exist'
    }
    if (token.startsWith('/') || token.startsWith('$')) return null // a route (`/api/…`) or `$ARGUMENTS`
    if (token.startsWith('@sssb/')) return checkSssbSpecifier(c, token, created)
    if (token.startsWith('@/')) return moduleExists(c, `src/${token.slice(2)}`, created) ? null : 'no such app module'
    if (token.startsWith('@')) return null // another package's name
    if (/^sssb\//.test(token)) return c.ruleIds.has(token) ? null : 'is not an @sssb/eslint-plugin rule'
    if (!PATH_CHARS.test(token) || !(token.includes('/') || EXTENSION.test(token))) return null
    return checkPath(c, token, created, optional, bases ?? [c.app, c.ws])
}

/** Problems with the arguments of a command that runs in `dir`: rule ids and paths, relative to `dir`. */
function checkArgs(c: Context, args: string[], dir: string, created: string[], segment: string): string[] {
    const problems: string[] = []
    for (const word of args) {
        if (word.startsWith('-') || /['"`]/.test(word)) continue
        if (!(word.includes('/') || EXTENSION.test(word)) || !PATH_CHARS.test(word)) continue
        const problem = checkToken(c, word, created, false, [dir])
        if (problem) problems.push(`\`${word}\` (in \`${segment}\`): ${problem}`)
    }
    return problems
}

/** Where `pnpm --filter X`, `-C X` or `cd X` sends a command: the app, or null for no package a workspace has. */
function packageDir(c: Context, value: string, kind: 'filter' | 'dir'): 'app' | 'root' | null {
    const v = value.replace(/^['"]|['"]$/g, '')
    if (kind === 'filter') return ['<app>', SLUG, './apps/*', 'apps/*'].includes(v) ? 'app' : null
    const p = normalize(v).replace(/\/$/, '')
    if (p === `apps/${SLUG}`) return 'app'
    if (p === '.' || p === '') return 'root'
    return null
}

/** Problems with a command line: `pnpm …`, `sssb …`, and any other command's path arguments. */
function checkCommand(c: Context, span: string, created: string[]): string[] {
    const problems: string[] = []
    let cwd: 'root' | 'app' = 'root'
    for (const segment of span.split(/&&|\|\||;|\|/).map((s) => s.trim())) {
        if (!segment) continue
        const words = segment.split(/\s+/)
        const at = (message: string) => problems.push(`\`${segment}\`: ${message}`)
        const dirOf = (where: 'root' | 'app') => (where === 'app' ? c.app : c.ws)
        if (words[0] === 'cd') {
            const where = packageDir(c, words[1] ?? '', 'dir')
            if (where === null) at(`no directory "${words[1]}" to cd into in a generated workspace`)
            cwd = where ?? cwd
            continue
        }
        if (words[0] === 'npx') {
            at("`npx` reaches past the workspace: run a dependency's binary with `pnpm exec`")
            continue
        }
        if (words[0] === 'sssb') {
            if (!c.sssbCommands.has(words[1])) at(`no sssb command "${words[1]}"`)
            continue
        }
        if (words[0] !== 'pnpm') {
            if (c.allBins.has(words[0]))
                at(`\`${words[0]}\` is a package binary, not on PATH: run it with \`pnpm exec\``)
            problems.push(...checkArgs(c, words.slice(1), dirOf(cwd), created, segment))
            continue
        }
        let target: 'root' | 'app' = cwd
        let i = 1
        while (i < words.length && words[i].startsWith('-')) {
            const [flag, inline] = words[i].split(/=(.*)/s)
            const value = inline ?? words[i + 1] ?? ''
            const step = inline === undefined ? 2 : 1
            if (flag === '--filter' || flag === '-F' || flag === '--dir' || flag === '-C') {
                const where = packageDir(c, value, flag === '--filter' || flag === '-F' ? 'filter' : 'dir')
                if (where === null) at(`no package "${value}" in a generated workspace`)
                target = where ?? target
                i += step
            } else {
                if (flag === '-w' || flag === '--workspace-root') target = 'root'
                i += 1
            }
        }
        let command = words[i]
        if (command === 'run') command = words[++i]
        const [bins, repoBins, scripts, repoScripts] =
            target === 'app'
                ? [c.appBins, c.repoAppBins, c.appScripts, c.repoAppScripts]
                : [c.rootBins, c.repoRootBins, c.rootScripts, c.repoRootScripts]
        const where = target === 'app' ? 'the app' : 'the workspace root'
        if (command === 'exec') {
            const bin = words[i + 1]
            if (bin === 'sssb' && !c.sssbCommands.has(words[i + 2])) at(`no sssb command "${words[i + 2]}"`)
            if (!bins.has(bin)) at(`no dependency of ${where} provides "${bin}" in a generated workspace`)
            else if (!repoBins.has(bin)) at(`no dependency of ${where} provides "${bin}" in SSSB's own repository`)
            problems.push(...checkArgs(c, words.slice(i + 2), dirOf(target), created, segment))
        } else if (command === 'dlx') {
            if (/^(@sssb\/|sssb$)/.test(words[i + 1] ?? ''))
                at("`pnpm dlx` fetches SSSB's tools from the registry, past the workspace's pinned copy")
        } else if (command !== undefined && !PNPM_BUILTINS.has(command)) {
            if (!scripts.has(command)) at(`no "${command}" script in ${where} of a generated workspace`)
            else if (!repoScripts.has(command)) at(`no "${command}" script in ${where} of SSSB's own repository`)
            problems.push(...checkArgs(c, words.slice(i + 1), dirOf(target), created, segment))
        }
    }
    return problems
}

/** Names a TypeScript module exports, followed through `export *` to relative modules. */
const exportCache = new Map<string, Set<string>>()
function exportsOf(file: string): Set<string> {
    const cached = exportCache.get(file)
    if (cached) return cached
    const names = new Set<string>()
    exportCache.set(file, names)
    const source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true)
    for (const statement of source.statements) {
        if (ts.isExportDeclaration(statement)) {
            if (statement.exportClause && ts.isNamedExports(statement.exportClause)) {
                for (const element of statement.exportClause.elements) names.add(element.name.text)
            } else if (statement.moduleSpecifier && ts.isStringLiteral(statement.moduleSpecifier)) {
                const base = path.resolve(path.dirname(file), statement.moduleSpecifier.text)
                const target = [`${base}.ts`, `${base}.tsx`, path.join(base, 'index.ts'), base.replace(/\.js$/, '.ts')]
                    .filter((candidate) => existsSync(candidate))
                    .at(0)
                if (target) for (const name of exportsOf(target)) names.add(name)
            }
            continue
        }
        if (ts.isExportAssignment(statement)) names.add('default')
        const modifiers = ts.canHaveModifiers(statement) ? ts.getModifiers(statement) : undefined
        if (!modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)) continue
        if (ts.isVariableStatement(statement)) {
            for (const declaration of statement.declarationList.declarations) {
                if (ts.isIdentifier(declaration.name)) names.add(declaration.name.text)
            }
        } else if (
            (ts.isFunctionDeclaration(statement) ||
                ts.isClassDeclaration(statement) ||
                ts.isInterfaceDeclaration(statement) ||
                ts.isTypeAliasDeclaration(statement) ||
                ts.isEnumDeclaration(statement)) &&
            statement.name
        ) {
            names.add(statement.name.text)
        }
    }
    return names
}

/** Problem with an identifier the text says `@sssb/kit/<sub>` exports (`WEBHOOK_*_HEADER` may stand for several). */
function identifierProblem(c: Context, name: string, specifier: string): string | null {
    const file = c.kitModules.get(`./${specifier.slice('@sssb/kit/'.length)}`)
    if (!file) return null // the specifier's own check reports it
    const exported = exportsOf(file)
    const pattern = new RegExp(`^${name.replaceAll('*', '\\w*')}$`)
    return [...exported].some((x) => pattern.test(x)) ? null : `\`${name}\` is not exported by ${specifier}`
}

const IDENTIFIER = /^([A-Za-z_$][\w$*]*)(?:\.[^\s]*)?(?:<[^>]*>)?(?:\(.*\))?$/
const LIST_GLUE = /^\s*(?:,|,?\s*and|,?\s*or)\s*$/

interface Span {
    text: string
    start: number
    end: number
}

/** Identifiers the prose ties to an `@sssb/kit/…` module, by position: before it, or listed in brackets after it. */
function proseIdentifierProblems(c: Context, prose: string, spans: Span[]): string[] {
    const problems: string[] = []
    const glue = (a: Span, b: Span) => prose.slice(a.end, b.start)
    const identifier = (span: Span) => IDENTIFIER.exec(span.text)?.[1]
    spans.forEach((module, j) => {
        if (!c.kitModules.has(`./${module.text.slice('@sssb/kit/'.length)}`) || !module.text.startsWith('@sssb/kit/'))
            return
        const named: string[] = []
        for (let k = j - 1; k >= 0; k -= 1) {
            const between = glue(spans[k], spans[k + 1])
            const ok = k === j - 1 ? /^\s*(?:\(|from|in)\s*$/.test(between) : LIST_GLUE.test(between)
            const name = identifier(spans[k])
            if (!ok || !name) break
            named.push(name)
        }
        if (j + 1 < spans.length && /^\s*\(\s*$/.test(glue(module, spans[j + 1]))) {
            for (let k = j + 1; k < spans.length; k += 1) {
                const name = identifier(spans[k])
                if (!name) break
                named.push(name)
                if (k + 1 >= spans.length || !LIST_GLUE.test(glue(spans[k], spans[k + 1]))) break
            }
        }
        for (const name of named) {
            const problem = identifierProblem(c, name, module.text)
            if (problem) problems.push(problem)
        }
    })
    return problems
}

/** Problems with a fenced TypeScript block: its `@sssb/…` and `@/…` imports, and the names it takes from the kit. */
function scriptProblems(c: Context, code: string, created: string[]): string[] {
    const problems: string[] = []
    const source = ts.createSourceFile('fence.tsx', code, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
    for (const statement of source.statements) {
        if (!(ts.isImportDeclaration(statement) || ts.isExportDeclaration(statement))) continue
        const specifier = statement.moduleSpecifier
        if (!specifier || !ts.isStringLiteral(specifier)) continue
        const spec = specifier.text
        if (!spec.startsWith('@sssb/') && !spec.startsWith('@/')) continue
        const problem = checkToken(c, spec, created)
        if (problem) {
            problems.push(`\`${spec}\` (fenced import): ${problem}`)
            continue
        }
        const bindings = ts.isImportDeclaration(statement)
            ? statement.importClause?.namedBindings
            : statement.exportClause
        if (
            !spec.startsWith('@sssb/kit/') ||
            !bindings ||
            !(ts.isNamedImports(bindings) || ts.isNamedExports(bindings))
        )
            continue
        for (const element of bindings.elements) {
            const problem = identifierProblem(c, (element.propertyName ?? element.name).text, spec)
            if (problem) problems.push(`${problem} (fenced import)`)
        }
    }
    return problems
}

/** Every problem with every reference in one command's or agent's text. */
function referenceProblems(c: Context, text: string): string[] {
    const body = text.replace(/^---\n[\s\S]*?\n---\n/, '')
    const problems: string[] = []

    // SSSB's repository is cited one way only, anywhere in the text (fenced code included).
    const pinned: [number, number][] = []
    for (const match of body.matchAll(PINNED)) {
        pinned.push([match.index, match.index + match[0].length])
        if (!existsSync(path.join(REPO, match[1]))) {
            problems.push(`\`${match[0].slice(1, -1)}\`: cites a file SSSB does not have at this commit`)
        }
    }
    for (const match of body.matchAll(SSSB_REPO)) {
        if (pinned.some(([from, to]) => match.index > from && match.index < to)) continue
        const around = body.slice(Math.max(0, match.index - 30), match.index + 40).replace(/\s+/g, ' ')
        problems.push(
            `"…${around}…": cites SSSB other than as a code span https://github.com/safeinsights/sssb/(blob|tree)/<ref>/<path>`,
        )
    }

    const fences = [...body.matchAll(FENCE)].map((m) => ({ lang: m[2].toLowerCase(), code: m[3] }))
    const prose = body.replace(FENCE, '\n')
    for (const paragraph of prose.split(/\n\s*\n/)) {
        if ((paragraph.match(/`/g)?.length ?? 0) % 2 === 1) {
            problems.push(`unbalanced backticks in "${paragraph.trim().slice(0, 60)}…"`)
        }
    }
    const spans: Span[] = [...prose.matchAll(/`([^`]+)`/g)]
        .filter((m) => !/\n\s*\n/.test(m[1]))
        .map((m) => ({ text: m[1], start: m.index, end: m.index + m[0].length }))
    const created = spans
        .filter(({ start }) => {
            const before = prose.slice(Math.max(0, start - 30), start)
            return /\bcreate\s*\(?\s*$/i.test(before) && !/\b(?:not|never|n't|no)\s+create\s*\(?\s*$/i.test(before)
        })
        .map(({ text }) => normalize(text))

    for (const { text: raw, end } of spans) {
        if (raw.includes('\n') && PATH_CHARS.test(raw.replace(/\s+/g, '')) && raw.replace(/\s+/g, '').includes('/')) {
            problems.push(
                `\`${raw.replace(/\s+/g, '')}\`: a path broken across lines, which markdown renders with a space`,
            )
            continue
        }
        const span = raw.replace(/\s+/g, ' ').trim()
        if (/\s/.test(span)) {
            problems.push(...checkCommand(c, span, created))
            continue
        }
        const problem = checkToken(c, span, created, /^\s*\(if any\)/.test(prose.slice(end, end + 12)))
        if (problem) problems.push(`\`${span}\`: ${problem}`)
    }
    problems.push(...proseIdentifierProblems(c, prose, spans))

    // Bare references in the prose: paths, rule ids (URLs are the scan's above).
    const bare = prose.replace(/`[^`]+`/g, ' ').replace(URLS, ' ')
    const seen = new Set<string>()
    const trim = (token: string) => {
        let t = token.replace(/[.,;:]+$/, '')
        while (t.endsWith(')') && (t.match(/\(/g)?.length ?? 0) < (t.match(/\)/g)?.length ?? 0)) t = t.slice(0, -1)
        return t.replace(/[.,;:]+$/, '')
    }
    const candidates = [
        ...[...bare.matchAll(BARE_ROOTED)].map((m) => trim(m[1])),
        ...[...bare.matchAll(BARE_ANY)].map((m) => trim(m[1])).filter((t) => t.endsWith('/') || EXTENSION.test(t)),
        ...[...bare.matchAll(BARE_RULE)].map((m) => trim(m[1])),
    ]
    for (const token of candidates) {
        if (seen.has(token) || !token.includes('/')) continue
        seen.add(token)
        const problem = checkToken(c, token, created)
        if (problem) problems.push(`${token} (bare): ${problem}`)
    }

    for (const { lang, code } of fences) {
        if (SHELL.has(lang)) {
            for (const line of code.split('\n')) {
                const command = line.trim().replace(/^\$\s+/, '')
                if (command && !command.startsWith('#')) problems.push(...checkCommand(c, command, created))
            }
        } else if (SCRIPT.has(lang)) {
            problems.push(...scriptProblems(c, code, created))
        }
    }
    return problems
}

describe('the plugin: every reference resolves in a generated workspace', () => {
    const files = pluginDirs.flatMap((dir) => componentFiles(dir).map(({ file }) => path.relative(REPO, file)))

    it.each(files)('%s', (file) => {
        expect(referenceProblems(ctx, readFileSync(path.join(REPO, file), 'utf8'))).toEqual([])
    })

    it('excuses "(if any)" only for places the app guide names, and runtime output only where the app makes it', () => {
        const guide = readFileSync(path.join(REPO, 'packages/kit/src/guide.md'), 'utf8')
        for (const place of OPTIONAL) expect(guide, place).toContain(place.replace(/^src\//, ''))
        const spec = readFileSync(path.join(ctx.app, 'tests/demo-static/static-shell.spec.ts'), 'utf8')
        for (const [output, script] of RUNTIME_OUTPUTS) {
            expect(ctx.appScripts, output).toContain(script)
            expect(spec, `the app's own static spec reads ${output}`).toContain(output)
        }
    })

    // A canary for the checker itself: each planted reference must fail with ITS problem, so a rule that stops
    // matching (REPO_ONLY never matching, say) turns its row red instead of letting another rule catch it.
    const planted: [string, string][] = [
        ['`packages/kit/src/x.ts`', "is SSSB's own tree"],
        ['`pnpm nonexistent`', 'no "nonexistent" script in the workspace root of a generated workspace'],
        ['`pnpm exec sssb nope`', 'no sssb command "nope"'],
        ['`sssb nope`', 'no sssb command "nope"'],
        ['`@sssb/kit/nope`', "is not in @sssb/kit's exports"],
        ['`sssb/nope`', 'is not an @sssb/eslint-plugin rule'],
        ['`src/missing.ts`', 'does not exist in a generated workspace'],
        ['`/sssb:nope`', 'names a plugin command that does not exist'],
        ['bare src/also-missing.ts here', 'src/also-missing.ts (bare): does not exist'],
        // A binary only the app depends on, run from the root (pnpm may hoist it there, but nothing promises that).
        ['`pnpm exec playwright install chromium`', 'no dependency of the workspace root provides "playwright"'],
        ['`pnpm --filter <app> exec nope-bin`', 'no dependency of the app provides "nope-bin"'],
        ['`pnpm exec vitest run src/missing.test.ts`', '`src/missing.test.ts` (in `pnpm exec vitest run'],
        ['`pnpm exec vitest run apps/<app>/src/missing.test.ts`', 'does not exist in a generated workspace'],
        ['`grep -c pglite apps/<app>/missing-dist/index.html`', '`apps/<app>/missing-dist/index.html` (in `grep'],
        ['`vitest run apps/<app>/src/sssb.conformance.test.ts`', '`vitest` is a package binary, not on PATH'],
        ['`npx sssb doctor`', '`npx` reaches past the workspace'],
        ['`pnpm dlx sssb doctor`', '`pnpm dlx` fetches'],
        ['`cd apps/<app> && pnpm nope2`', 'no "nope2" script in the app of a generated workspace'],
        ['`pnpm --filter=<app> nope4`', 'no "nope4" script in the app'],
        ['`pnpm -C apps/<app> nope5`', 'no "nope5" script in the app'],
        ['`pnpm --filter nope test:e2e`', 'no package "nope" in a generated workspace'],
        ['`pnpm exec eslint --rule sssb/nope apps/<app>/src`', '`sssb/nope` (in `pnpm exec eslint'],
        ['Edit lib/missing.ts first.', 'lib/missing.ts (bare): does not exist'],
        ['Then components/missing-card.tsx.', 'components/missing-card.tsx (bare): does not exist'],
        ['And app-config/missing.ts too.', 'app-config/missing.ts (bare): does not exist'],
        ['the sssb/no-such-rule lint rule', 'sssb/no-such-rule (bare): is not an @sssb/eslint-plugin rule'],
        ['`@sssb/create/nope`', '@sssb/create is not a dependency of a generated workspace'],
        ['`@sssb/eslint-plugin/nope`', "is not in @sssb/eslint-plugin's exports"],
        ['`@sssb/nope`', 'is not an SSSB package'],
        ['see https://github.com/safeinsights/sssb/blob/<ref>/README.md bare', 'cites SSSB other than as a code span'],
        ['[a link](https://github.com/safeinsights/sssb/blob/main/README.md)', 'cites SSSB other than'],
        ['`https://raw.githubusercontent.com/safeinsights/sssb/main/README.md`', 'cites SSSB other than'],
        ['`https://github.com/safeinsights/sssb/tree/main`', 'cites SSSB other than'],
        ['`https://github.com/safeinsights/sssb/blob/main/README.md`', 'cites SSSB other than'],
        ['`http://github.com/safeinsights/sssb/blob/<ref>/README.md`', 'cites SSSB other than'],
        ['`https://www.github.com/safeinsights/sssb/blob/<ref>/README.md`', 'cites SSSB other than'],
        ['`https://github.com/safeinsights/sssb/blob/<ref>/missing.md`', 'cites a file SSSB does not have'],
        ['```bash\nsee https://github.com/SafeInsights/SSSB/tree/main\n```', 'cites SSSB other than'],
        ['Do not create `src/app-config/abilitys.ts`: edit it.', '`src/app-config/abilitys.ts`: does not exist'],
        ['Never create `src/app-config/db/schemma.ts`.', '`src/app-config/db/schemma.ts`: does not exist'],
        ['Read `src/app-config/notthere.ts` (if any).', '"(if any)" excuses only the optional places'],
        ['Read `src/nope/<kind>/definition.ts`.', 'its fixed part `src/nope/` does not exist'],
        ['Read `src/nope/…/x.ts`.', 'its fixed part `src/nope/` does not exist'],
        ['Edit `node_modules/foo/bar.js`.', 'is inside node_modules'],
        ['Edit `.data/x/y.ts`.', '`.data/x/y.ts`: does not exist'],
        ['```bash\npnpm nope-in-fence\n```', 'no "nope-in-fence" script'],
        [
            "```ts\nimport { nope } from '@sssb/kit/core/presets'\n```",
            '`nope` is not exported by @sssb/kit/core/presets',
        ],
        ["```ts\nimport { x } from '@sssb/kit/nope'\n```", "`@sssb/kit/nope` (fenced import): is not in @sssb/kit's"],
        ['a `noSuchThing` (`@sssb/kit/core/presets`)', '`noSuchThing` is not exported by @sssb/kit/core/presets'],
        ['`exportKeyPrefix`, `noSuch` in `@sssb/kit/core/jobs`', '`noSuch` is not exported by @sssb/kit/core/jobs'],
        ['`@sssb/kit/core/presets` (`presetProblems`, `nopeOperation`)', '`nopeOperation` is not exported'],
        // Declared in the module but not exported: still not something an app can import.
        ['`inviteOperation` from `@sssb/kit/core/presets`', '`inviteOperation` is not exported'],
        ['A span that wraps `src/app-config/\nabilities.ts` here.', 'a path broken across lines'],
        ['an odd ` backtick here', 'unbalanced backticks'],
    ]
    it.each(planted)('fails %j with its own problem', (input, expected) => {
        const problems = referenceProblems(ctx, input)
        expect(problems, JSON.stringify(problems)).toHaveLength(1)
        expect(problems[0]).toContain(expected)
    })

    it('passes the forms its conventions allow', () => {
        const fine = [
            '`src/app-config/abilities.ts` `messages/en.json` `docs/cutover-checklist.md` `.claude/sssb-guide.md`',
            '`pnpm verify` `pnpm exec sssb doctor` `@sssb/kit/authz/authorize` `sssb/no-raw-db-handle` `.data/`',
            'create `src/ports/<name>.ts`, then create `src/new/thing.ts` and `src/new/thing.ts` again; `thing.ts`',
            '`src/adapters/real/` (if any) `apps/<app>/src/sssb.conformance.test.ts` `/sssb:new-entity`',
            '`https://github.com/safeinsights/sssb/blob/<ref>/docs/recipes/app-owned-adapter.md`',
            "`pnpm --filter './apps/*' exec playwright install chromium` `pnpm --filter <app> exec playwright test a11y`",
            '`pnpm exec vitest run apps/<app>/src/sssb.conformance.test.ts` `grep -c pglite apps/<app>/dist-demo/index.html`',
            'create `src/app-config/presets/operations/<kind>/`, then `src/app-config/presets/operations/<kind>/static.ts`',
            'a `DemoPreset` (`@sssb/kit/core/presets`); `builderTick`, `serviceTick` in `@sssb/kit/components/simulator/actor-runtime`',
            '`WEBHOOK_*_HEADER` in `@sssb/kit/core/webhook-signing`; `@sssb/kit/core/presets` (`presetProblems`, `expandPreset`)',
            "```ts\nimport { presetProblems, type DemoPreset } from '@sssb/kit/core/presets'\n```",
            '```bash\npnpm build:demo-static && pnpm e2e:demo-static\n```',
            // An indented fence (inside a list item) is code, not prose: its lone backtick is a template literal's.
            '1. A step:\n\n        ```ts\n        const file = `../messages/${locale}.json\n        ```',
            'the app under src/app/[locale]/(protected)/dashboard/page.tsx, `pnpm create @sssb`, `pnpm --filter <app> add valibot`',
        ].join('\n\n')
        expect(referenceProblems(ctx, fine)).toEqual([])
    })
})

describe('claude plugin validate --strict', () => {
    const claude = spawnSync('sh', ['-c', 'command -v claude'], { encoding: 'utf8' }).stdout.trim()

    // The structural checks above never skip; this one runs where the binary is (a maintainer's machine, not CI).
    it.skipIf(!claude).each(['.', ...pluginDirs.map((dir) => path.relative(REPO, dir))])(
        '%s: no error, and no warning but the version the plugin leaves out on purpose',
        (dir) => {
            const result = spawnSync(claude, ['plugin', 'validate', dir, '--strict'], { cwd: REPO, encoding: 'utf8' })
            const output = `${result.stdout}${result.stderr}`
            expect(result.status, output).not.toBe(2)
            expect(output).not.toMatch(/Found \d+ errors?/)
            const findings = output
                .split('\n')
                .filter((line) => line.trim().startsWith('❯'))
                .filter((line) => !/version: No version specified/.test(line))
            expect(findings, output).toEqual([])
        },
    )
})
