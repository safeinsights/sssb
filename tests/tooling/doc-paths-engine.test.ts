import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import {
    docFiles,
    docPathProblems,
    readDocPathsConfig,
    resolves,
    citationsIn,
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

describe('citationsIn', () => {
    it('keeps one span shared by the citations read out of it', () => {
        const found = citationsIn('`cp apps/a/x.ts apps/a/y.ts`', config)
        expect(found.map((c) => c.path)).toEqual(['apps/a/x.ts', 'apps/a/y.ts'])
        expect(new Set(found.map((c) => c.raw)).size).toBe(1)
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
