import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import {
    docFiles,
    docPathProblems,
    readDocPathsConfig,
    resolves,
    citationsIn,
    generalizeAppCitations,
    type DocPathsConfig,
    missingIncludes,
} from '@sssb/tools/doc-paths'
import { run } from '../../packages/tools/src/commands/check-doc-paths.js'
import { UsageError } from '../../packages/tools/src/app.js'
import { makeTestTmpDir } from '../support/tmp-dir'

/**
 * The doc-paths engine against a workspace built from scratch, because `tests/docs/doc-paths.test.ts` only proves
 * that THIS repository's docs are consistent, and says nothing about whether the engine honours a configuration
 * that is not SSSB's. An adopter's gate is exactly that case.
 */
const config: DocPathsConfig = {
    roots: ['docs/', 'src/', 'apps/'],
    include: ['docs'],
    exempt: ['docs/adr/'],
}

/** A workspace root with a package.json (carrying `sssb.docPaths` unless `docPaths` is null) and the given files. */
function workspace(files: Record<string, string>, docPaths: unknown = config): string {
    const root = makeTestTmpDir('doc-paths-engine-')
    writeFileSync(path.join(root, 'pnpm-workspace.yaml'), '')
    const manifest = docPaths === null ? { name: 'w' } : { name: 'w', sssb: { docPaths } }
    writeFileSync(path.join(root, 'package.json'), JSON.stringify(manifest))
    // Every include entry exists unless a test removes it: a missing one is itself a problem now (below).
    for (const [file, content] of Object.entries(files)) {
        mkdirSync(path.dirname(path.join(root, file)), { recursive: true })
        writeFileSync(path.join(root, file), content)
    }
    return root
}

describe('readDocPathsConfig', () => {
    it('reads the block', () => {
        expect(readDocPathsConfig(workspace({}))).toEqual(config)
    })

    it('throws, naming the key, when the block is absent', () => {
        expect(() => readDocPathsConfig(workspace({}, null))).toThrow(/sssb\.docPaths/)
    })

    it('throws, naming the key, when a list is malformed or missing', () => {
        expect(() => readDocPathsConfig(workspace({}, { ...config, roots: 'docs/' }))).toThrow(/docPaths\.roots/)
        expect(() => readDocPathsConfig(workspace({}, { roots: [], include: [] }))).toThrow(/docPaths\.exempt/)
        expect(() => readDocPathsConfig(workspace({}, { ...config, referenceApps: [1] }))).toThrow(
            /docPaths\.referenceApps/,
        )
        expect(() => readDocPathsConfig(workspace({}, []))).toThrow(/must be an object/)
    })
})

describe('docFiles', () => {
    it('walks directories and lists files, in a stable order, honouring exempt and skipping absent entries', () => {
        const root = workspace({
            'docs/b.md': '',
            'docs/a.md': '',
            'docs/notes.txt': '',
            'docs/adr/0001.md': '',
            'README.md': '',
        })
        expect(
            docFiles(root, { ...config, include: [...config.include, 'README.md', 'missing', 'CLAUDE.md'] }),
        ).toEqual(['docs/a.md', 'docs/b.md', 'README.md'])
    })
})

describe('docPathProblems', () => {
    it('fails an include entry that names nothing, so a typo cannot shrink the gate to nothing', () => {
        const root = workspace({ 'docs/a.md': '' })
        expect(docPathProblems(root, { ...config, include: [...config.include, 'doc'] })).toEqual([
            'doc: in sssb.docPaths.include, but not in the tree',
        ])
        expect(missingIncludes(root, { ...config, include: ['doc', 'docs/adr/x'] })).toEqual(['doc'])
    })

    it('fails a doc set with no markdown in it', () => {
        const root = workspace({ 'docs/notes.txt': '' })
        expect(docPathProblems(root, config)).toEqual([
            'sssb.docPaths.include names no markdown file: the gate would check nothing',
        ])
    })

    it('finds a broken citation, with file and line', () => {
        const root = workspace({ 'docs/a.md': 'fine\nsee `src/gone` here\n', 'src/there/x.ts': '' })
        expect(docPathProblems(root, config)).toEqual(['docs/a.md:2 cites `src/gone`'])
    })

    it('lets a file citation pass on its parent directory, but not a directory citation', () => {
        const root = workspace({
            'docs/a.md': '`src/there/new.ts` and `src/there/newdir` and `src/nope/new.ts`\n',
            'src/there/x.ts': '',
        })
        expect(docPathProblems(root, config)).toEqual([
            'docs/a.md:1 cites `src/there/newdir`',
            'docs/a.md:1 cites `src/nope/new.ts`',
        ])
    })

    it('resolves against the root it is given, not the working directory', () => {
        // `docs/` exists in the real repo; the scratch workspace has none of it.
        expect(resolves('docs', workspace({}), config)).toBe(false)
    })

    it('skips build outputs, line references and globs, and reads paths inside commands', () => {
        const root = workspace({
            'docs/a.md': [
                '`docs/dist-demo/index.html` `docs/.next/x` `docs/a.md:3` `src/gone/*.ts` `src/gone/<name>.ts`',
                '`pnpm --filter "./apps/*" run docs/real.md`',
            ].join('\n'),
            'src/x': '',
            'apps/x': '',
        })
        const problems = docPathProblems(root, { ...config, buildOutputs: ['dist-demo', '.next'] })
        // `src/gone/*` truncates to `src/gone`, which is missing; `docs/real.md` is a file whose parent exists
        expect(problems).toEqual(['docs/a.md:1 cites `src/gone`', 'docs/a.md:1 cites `src/gone`'])
    })

    it('honours exempt', () => {
        const root = workspace({ 'docs/a.md': '', 'docs/adr/0001.md': '`src/gone`\n' })
        expect(docPathProblems(root, config)).toEqual([])
        expect(docPathProblems(root, { ...config, exempt: [] })).toEqual(['docs/adr/0001.md:1 cites `src/gone`'])
    })
})

describe('reference apps', () => {
    const text = '`apps/showcase/src/x.ts`\n'

    it('resolve while the app is absent, and are strict once its package.json is present', () => {
        const withApps = { ...config, referenceApps: ['showcase'] }
        expect(docPathProblems(workspace({ 'docs/a.md': text }), withApps)).toEqual([])
        const present = workspace({ 'docs/a.md': text, 'apps/showcase/package.json': '{}' })
        // present now, so `apps/showcase/src/x.ts` is checked like any path, and its parent `src/` is not there
        expect(docPathProblems(present, withApps)).toEqual(['docs/a.md:1 cites `apps/showcase/src/x.ts`'])
        const broken = workspace({ 'docs/a.md': '`apps/showcase/gone`\n', 'apps/showcase/package.json': '{}' })
        expect(docPathProblems(broken, withApps)).toEqual(['docs/a.md:1 cites `apps/showcase/gone`'])
    })

    it('are strict when none are configured', () => {
        expect(docPathProblems(workspace({ 'docs/a.md': text }), config)).toEqual([
            'docs/a.md:1 cites `apps/showcase/src/x.ts`',
        ])
    })

    it('are escaped, so a name is never read as a pattern', () => {
        const root = workspace({ 'docs/a.md': '`apps/shoXcase/gone`\n' })
        expect(docPathProblems(root, { ...config, referenceApps: ['sho.case'] })).toEqual([
            'docs/a.md:1 cites `apps/shoXcase/gone`',
        ])
    })
})

describe('relativeTo', () => {
    // The app guide's shape: it cites paths inside the reader's app, and the gate checks them against one app here.
    const guide = '`src/app-config/` and `config/params.ts`\nand `src/gone`\n'
    const mapped = {
        ...config,
        roots: [...config.roots, 'config/'],
        include: ['guide.md'],
        relativeTo: { 'guide.md': 'apps/one' },
    }

    it("resolves a mapped doc's citations under its directory, and names the joined path when one is broken", () => {
        const root = workspace({
            'guide.md': guide,
            'apps/one/src/app-config/x.ts': '',
            'apps/one/config/params.ts': '',
            'src/gone/x.ts': '', // present at the ROOT, which must not rescue the citation
        })
        expect(docPathProblems(root, mapped)).toEqual(['guide.md:2 cites `apps/one/src/gone`'])
        // Unmapped, the same doc is read against the root, where `src/app-config` and `config/` are not.
        expect(docPathProblems(root, { ...mapped, relativeTo: {} })).toEqual([
            'guide.md:1 cites `src/app-config`',
            'guide.md:1 cites `config/params.ts`',
        ])
    })

    it('fails an `apps/` citation in a mapped doc, since an app holds no `apps/` of its own', () => {
        const root = workspace({ 'guide.md': '`apps/one/src`\n', 'apps/one/src/x.ts': '' })
        expect(docPathProblems(root, mapped)).toEqual(['guide.md:1 cites `apps/one/apps/one/src`'])
    })

    it('applies the reference-app rule to the joined path', () => {
        const toStarter = { ...mapped, referenceApps: ['starter'], relativeTo: { 'guide.md': 'apps/starter/' } }
        expect(docPathProblems(workspace({ 'guide.md': guide }), toStarter)).toEqual([])
        const present = workspace({ 'guide.md': guide, 'apps/starter/package.json': '{}' })
        expect(docPathProblems(present, toStarter)).toEqual([
            'guide.md:1 cites `apps/starter/src/app-config`',
            'guide.md:1 cites `apps/starter/config/params.ts`',
            'guide.md:2 cites `apps/starter/src/gone`',
        ])
    })

    it('is validated when read', () => {
        expect(() => readDocPathsConfig(workspace({}, { ...config, relativeTo: ['apps/one'] }))).toThrow(
            /docPaths\.relativeTo/,
        )
        expect(() => readDocPathsConfig(workspace({}, { ...config, relativeTo: { 'guide.md': 1 } }))).toThrow(
            /docPaths\.relativeTo/,
        )
    })
})

describe('citationsIn', () => {
    it('keeps one span shared by the citations read out of it', () => {
        const found = citationsIn('`cp apps/a/x.ts apps/a/y.ts`', config)
        expect(found.map((c) => c.path)).toEqual(['apps/a/x.ts', 'apps/a/y.ts'])
        expect(new Set(found.map((c) => c.raw)).size).toBe(1)
    })
})

/**
 * The rewriter, tested against the shape that broke it: several citations sharing ONE backticked span. Rewriting per
 * citation by replacing the span verbatim made the span unfindable after the first rewrite, so every later path in
 * it was skipped: a command left half-generalised, and the doc-path gate red. `gone` stands in for a filesystem check
 * (`(cited) => !resolves(cited, root, config)`), so these cases pin the rewriting rule without a tree on disk.
 */
describe('generalizeAppCitations', () => {
    const generalize = (text: string, isMissing: (cited: string) => boolean) =>
        generalizeAppCitations(text, isMissing, config)
    const gone = (cited: string) => cited.startsWith('apps/showcase/')

    it('rewrites EVERY app path in one backticked span', () => {
        expect(generalize('Run `cp apps/showcase/src/jobs/x.ts apps/showcase/src/domain/y.ts` to start.', gone)).toBe(
            'Run `cp apps/<app>/src/jobs/x.ts apps/<app>/src/domain/y.ts` to start.',
        )
    })

    it('rewrites a repeated path within the span, not just its first occurrence', () => {
        expect(generalize('`diff apps/showcase/src/a.ts apps/showcase/src/a.ts`', gone)).toBe(
            '`diff apps/<app>/src/a.ts apps/<app>/src/a.ts`',
        )
    })

    it('rewrites every occurrence of a repeated span in the document', () => {
        expect(generalize('`apps/showcase/src/jobs` twice: `apps/showcase/src/jobs`', gone)).toBe(
            '`apps/<app>/src/jobs` twice: `apps/<app>/src/jobs`',
        )
    })

    it('leaves paths that still resolve alone, even beside one that does not', () => {
        expect(generalize('`cp apps/starter/src/a.ts apps/showcase/src/b.ts`', gone)).toBe(
            '`cp apps/starter/src/a.ts apps/<app>/src/b.ts`',
        )
    })

    it('generalises a glob citation at its static prefix', () => {
        expect(generalize('`apps/showcase/src/jobs/*.ts`', gone)).toBe('`apps/<app>/src/jobs/*.ts`')
    })

    it('touches nothing when every citation resolves', () => {
        const text = '`apps/starter/src` and `packages/kit/src`'
        expect(generalize(text, gone)).toBe(text)
    })

    it('ignores paths outside apps/, which have no <app> to generalise to', () => {
        const text = '`rm packages/kit/src/gone.ts`'
        expect(generalize(text, () => true)).toBe(text)
    })

    it('generalises a brace expansion at its static prefix, keeping the braces', () => {
        expect(generalize('`apps/showcase/messages/{en,es}.json`', gone)).toBe('`apps/<app>/messages/{en,es}.json`')
    })
})

describe('sssb check-doc-paths', () => {
    function quietly<T>(fn: () => Promise<T>): Promise<{ result: T; out: string }> {
        const log = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
        return fn()
            .then((result) => ({ result, out: log.mock.calls.map((call) => String(call[0])).join('') }))
            .finally(() => log.mockRestore())
    }

    it('exits 1 on a broken doc and prints the citation and a summary', async () => {
        const root = workspace({ 'docs/a.md': '`src/gone`\n' })
        const { result, out } = await quietly(() => run(['--root', root]))
        expect(result).toBe(1)
        expect(out).toContain('docs/a.md:1 cites `src/gone`')
        expect(out).toContain('check-doc-paths: 1 doc(s), 1 citation(s) checked, 1 broken')
    })

    it('exits 0 on a clean doc', async () => {
        const root = workspace({ 'docs/a.md': '`src/there`\n', 'src/there/x.ts': '' })
        const { result, out } = await quietly(() => run(['--root', root]))
        expect(result).toBe(0)
        expect(out).toContain('1 doc(s), 1 citation(s) checked, 0 broken')
    })

    it('rejects an unknown argument', async () => {
        await expect(run(['--nope'])).rejects.toBeInstanceOf(UsageError)
    })
})
