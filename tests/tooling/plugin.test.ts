import { spawnSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
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
 * (b) Every reference a command or agent makes resolves in a workspace generated from this repository's live tree:
 *     a path (relative to the app, or to the workspace root), an `@sssb/kit/…` subpath in the kit's `exports`, a
 *     `pnpm` script, an `sssb` command, an `sssb/*` lint rule, a `/sssb:*` command, or SSSB's own file by a URL
 *     pinned to `<ref>`. The conventions it reads, for the command text:
 *       - `<app>` is the generated app's slug; any other `<placeholder>` or `…` is not checked;
 *       - a path right after the word "create" is one the command tells you to create, and later mentions of it (or
 *         of a file under it, by its bare name) resolve;
 *       - a path right before "(if any)" is optional, a place the rules name that an app may not have yet;
 *       - a path the generated `.gitignore` names (`.data/`, build output) is a runtime path;
 *       - SSSB's own files are cited as `https://github.com/safeinsights/sssb/(blob|tree)/<ref>/<path>`, never at a
 *         branch, and the path must exist in this tree (the plugin and the file are at the same commit).
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
    kitExports: Set<string>
    toolsExports: Set<string>
    sssbCommands: Set<string>
    ruleIds: Set<string>
    pluginCommands: Set<string>
    ignored: string[]
}

let ctx: Context

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
    ctx = {
        ws,
        app,
        rootScripts: scripts(path.join(ws, 'package.json')),
        appScripts: scripts(path.join(app, 'package.json')),
        repoRootScripts: scripts(path.join(REPO, 'package.json')),
        repoAppScripts: new Set(
            [...scripts(path.join(REPO, 'apps/starter/package.json'))].filter((s) =>
                scripts(path.join(REPO, 'apps/showcase/package.json')).has(s),
            ),
        ),
        kitExports: new Set(Object.keys(readJson(path.join(REPO, 'packages/kit/package.json')).exports)),
        toolsExports: new Set(Object.keys(readJson(path.join(REPO, 'packages/tools/package.json')).exports)),
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
})

/** Where SSSB's framework, reference app and repo-only files live: never a path in a plugin command. */
const REPO_ONLY = /^(packages\/kit\/|apps\/(showcase|starter)\/|scripts\/|tests\/support\/|packages\/seed\/)/
const SSSB_URL = /^https:\/\/github\.com\/safeinsights\/sssb\/(?:blob|tree)\/([^/]+)\/(.+)$/
const PATH_CHARS = /^[\w.@<>[\]()*~+…-]+(?:\/[\w.@<>[\]()*~+…-]*)*$/
const EXTENSION = /\.(ts|tsx|js|mjs|cjs|json|md|ya?ml|css|html)$/
const PLACEHOLDER = /<(?!app>)[^>]*>|…/
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
const BARE = new RegExp(
    `(?<![\\w/.@\`-])((?:${ROOTS.map((r) => r.replace('.', '\\.')).join('|')})/[\\w./<>[\\]()*@-]*)`,
    'g',
)
const PNPM_BUILTINS = new Set(['install', 'i', 'add', 'remove', 'update', 'outdated', 'why', 'list', 'dlx', 'create'])

/** A path in a command, resolved against the app, then the workspace root. `<app>` is the slug. */
function exists(c: Context, rel: string) {
    const p = rel.replaceAll('<app>', SLUG).replace(/^\.\//, '')
    if (p.includes('*')) {
        const base = p.slice(0, p.indexOf('*'))
        return [c.app, c.ws].some((root) => existsSync(path.join(root, base)))
    }
    return [c.app, c.ws].some((root) => existsSync(path.join(root, p)))
}

/** Whether a module specifier under `src/` resolves (as TypeScript would), in the workspace or among created files. */
function moduleExists(c: Context, rel: string, created: string[]) {
    const p = rel.replace(/\/\*$/, '/')
    if (p.endsWith('/')) return exists(c, p) || created.some((file) => file.startsWith(p))
    const candidates = [p, `${p}.ts`, `${p}.tsx`, `${p}/index.ts`, `${p}/index.tsx`]
    return candidates.some((candidate) => exists(c, candidate) || created.includes(candidate))
}

function isIgnored(c: Context, rel: string) {
    const p = rel.replace(/^\.\//, '')
    return c.ignored.some((pattern) => {
        const plain = pattern.replace(/^\//, '')
        return plain.endsWith('/') ? p === plain || p.startsWith(plain) : p === plain
    })
}

/** Problems with one path-like reference (a span with no spaces), or null when it is fine. */
function checkToken(c: Context, token: string, created: string[], optional: boolean): string | null {
    if (token.startsWith('http://') || token.startsWith('https://')) {
        const sssb = SSSB_URL.exec(token)
        if (!sssb) return null
        if (sssb[1] !== '<ref>') return 'cites SSSB at a branch or commit: write <ref>, the marketplace pin'
        return existsSync(path.join(REPO, sssb[2])) ? null : 'cites a file SSSB does not have at this commit'
    }
    if (/^\/sssb:/.test(token)) {
        return c.pluginCommands.has(token.slice('/sssb:'.length)) ? null : 'names a plugin command that does not exist'
    }
    if (token.startsWith('/') || token.startsWith('$')) return null // a route (`/api/…`) or `$ARGUMENTS`
    if (token.startsWith('@sssb/kit/')) {
        if (PLACEHOLDER.test(token)) return null
        const sub = `./${token.slice('@sssb/kit/'.length)}`
        if (sub.endsWith('/*'))
            return [...c.kitExports].some((key) => key.startsWith(sub.slice(0, -1)))
                ? null
                : 'no such @sssb/kit subpaths'
        return c.kitExports.has(sub) ? null : "is not in @sssb/kit's exports"
    }
    if (token.startsWith('@sssb/tools/')) {
        return c.toolsExports.has(`./${token.slice('@sssb/tools/'.length)}`) ? null : "is not in @sssb/tools' exports"
    }
    if (token.startsWith('@sssb/app-config/')) {
        const rest = token.slice('@sssb/app-config/'.length)
        return rest === '*' || moduleExists(c, `src/app-config/${rest}`, created) ? null : 'no such seam module'
    }
    if (token.startsWith('@/')) return moduleExists(c, `src/${token.slice(2)}`, created) ? null : 'no such app module'
    if (token.startsWith('@')) return null // a package name
    if (/^sssb\/[a-z-]+$/.test(token)) return c.ruleIds.has(token) ? null : 'is not an @sssb/eslint-plugin rule'
    if (!PATH_CHARS.test(token) || !(token.includes('/') || EXTENSION.test(token))) return null
    if (REPO_ONLY.test(token))
        return "is SSSB's own tree, which an adopter does not have: cite @sssb/kit/… or a <ref> URL"
    if (PLACEHOLDER.test(token) || optional || isIgnored(c, token)) return null
    if (exists(c, token)) return null
    const rel = token.replace(/^\.\//, '')
    if (created.some((file) => file === rel || file.startsWith(rel.endsWith('/') ? rel : `${rel}/`))) return null
    if (!rel.includes('/') && created.some((file) => file.endsWith(`/${rel}`))) return null
    return 'does not exist in a generated workspace (mark a file the command creates with "create")'
}

/** Problems with a command line in a span: `pnpm …` and `sssb …` segments, and the paths they name. */
function checkCommand(c: Context, span: string, created: string[]): string[] {
    const problems: string[] = []
    for (const segment of span.split(/&&|\|\|/).map((s) => s.trim())) {
        const words = segment.split(/\s+/)
        if (words[0] === 'sssb') {
            if (!c.sssbCommands.has(words[1])) problems.push(`\`${segment}\`: no sssb command "${words[1]}"`)
            continue
        }
        if (words[0] !== 'pnpm') continue
        let i = 1
        let filtered = false
        while (i < words.length && words[i].startsWith('-')) {
            if (['--filter', '-F', '--dir', '-C'].includes(words[i])) {
                filtered ||= words[i] === '--filter' || words[i] === '-F'
                i += 2
            } else i += 1
        }
        let command = words[i]
        if (command === 'run') command = words[++i]
        if (command === 'exec') {
            if (words[i + 1] === 'sssb' && !c.sssbCommands.has(words[i + 2]))
                problems.push(`\`${segment}\`: no sssb command "${words[i + 2]}"`)
        } else if (command !== undefined && !PNPM_BUILTINS.has(command)) {
            const [generated, repo] = filtered ? [c.appScripts, c.repoAppScripts] : [c.rootScripts, c.repoRootScripts]
            if (!generated.has(command))
                problems.push(`\`${segment}\`: no "${command}" script in a generated workspace`)
            else if (!repo.has(command))
                problems.push(`\`${segment}\`: no "${command}" script in SSSB's own repository`)
        }
        for (const word of words.slice(i + 1)) {
            if (word.startsWith('-') || !word.includes('/') || /['"]/.test(word)) continue
            const problem = checkToken(c, word, created, false)
            if (problem) problems.push(`\`${word}\` (in \`${segment}\`): ${problem}`)
        }
    }
    return problems
}

/** Every problem with every reference in one command's or agent's text. */
function referenceProblems(c: Context, text: string): string[] {
    const body = text.replace(/^---\n[\s\S]*?\n---\n/, '')
    const prose = body.replace(/^```[\s\S]*?^```/gm, '')
    const spans = [...prose.matchAll(/`([^`\n]+)`/g)].map((m) => ({
        span: m[1],
        before: prose.slice(Math.max(0, m.index - 20), m.index),
        after: prose.slice(m.index + m[0].length, m.index + m[0].length + 12),
    }))
    const created = spans.filter(({ before }) => /\bcreate\s*\(?$/i.test(before)).map(({ span }) => span)
    const problems: string[] = []
    for (const { span, after } of spans) {
        if (/\s/.test(span.trim())) {
            problems.push(...checkCommand(c, span, created))
            continue
        }
        const problem = checkToken(c, span, created, /^\s*\(if any\)/.test(after))
        if (problem) problems.push(`\`${span}\`: ${problem}`)
    }
    for (const [, token] of prose.replace(/`[^`\n]+`/g, ' ').matchAll(BARE)) {
        const trimmed = token.replace(/[.,;:)]+$/, '')
        const problem = checkToken(c, trimmed, created, false)
        if (problem) problems.push(`${trimmed} (bare): ${problem}`)
    }
    return problems
}

describe('the plugin: every reference resolves in a generated workspace', () => {
    const files = pluginDirs.flatMap((dir) => componentFiles(dir).map(({ file }) => path.relative(REPO, file)))

    it.each(files)('%s', (file) => {
        expect(referenceProblems(ctx, readFileSync(path.join(REPO, file), 'utf8'))).toEqual([])
    })

    it('reads the conventions it documents (a canary for the checker itself)', () => {
        const probe = [
            '`packages/kit/src/x.ts` `pnpm nonexistent` `pnpm exec sssb nope` `@sssb/kit/nope` `sssb/nope`',
            '`src/missing.ts` `https://github.com/safeinsights/sssb/blob/main/README.md` `/sssb:nope`',
            'bare src/also-missing.ts here',
        ].join('\n')
        expect(referenceProblems(ctx, probe)).toHaveLength(9)
        const fine = [
            '`src/app-config/abilities.ts` `messages/en.json` `docs/cutover-checklist.md` `.claude/sssb-guide.md`',
            '`pnpm verify` `pnpm exec sssb doctor` `@sssb/kit/authz/authorize` `sssb/no-raw-db-handle` `.data/`',
            'create `src/ports/<name>.ts`, then create `src/new/thing.ts` and `src/new/thing.ts` again; `thing.ts`',
            '`src/adapters/real/` (if any) `apps/<app>/src/sssb.conformance.test.ts` `/sssb:new-entity`',
            '`https://github.com/safeinsights/sssb/blob/<ref>/docs/recipes/app-owned-adapter.md`',
        ].join('\n')
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
