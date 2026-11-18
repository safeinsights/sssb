import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { makeTestTmpDir } from '../support/tmp-dir'
import { citedPaths, resolves } from './doc-set'

/**
 * The citation parser's own tests, because `doc-paths.test.ts` can only ever prove that TODAY's docs
 * are consistent with TODAY's tree — it says nothing about which citation FORMS the parser can see.
 *
 * That distinction is not academic. The parser originally read a backticked span only when the whole
 * span was a path, so a path written inside a backticked command was invisible to it, and two such
 * citations rotted unnoticed while the gate stayed green. The cases below pin the forms down so a
 * later simplification of the parser has to break a test rather than a promise.
 */
function citationsIn(markdown: string) {
    const dir = makeTestTmpDir('doc-set-')
    const file = path.join(dir, 'doc.md')
    writeFileSync(file, markdown)
    return citedPaths(file).map(({ path: cited }) => cited)
}

describe('citedPaths', () => {
    it('reads a span that is itself a path', () => {
        expect(citationsIn('see `packages/kit/src/ports`')).toEqual(['packages/kit/src/ports'])
    })

    it('reads a path out of a backticked command', () => {
        expect(citationsIn('run `git diff apps/showcase/fixtures/llm/`')).toEqual(['apps/showcase/fixtures/llm'])
    })

    it('reads every path in a command, and ignores the non-path words', () => {
        expect(citationsIn('`cp docs/README.md scripts/out.md`')).toEqual(['docs/README.md', 'scripts/out.md'])
    })

    it('unwraps quoting and a ./ prefix', () => {
        expect(citationsIn(`\`pnpm --filter './apps/*' build\``)).toEqual(['apps'])
    })

    it('truncates a glob or a <metavariable> to its static prefix', () => {
        expect(citationsIn('`packages/kit/src/adapters/<real|fake>/<name>.ts`')).toEqual(['packages/kit/src/adapters'])
    })

    it('truncates a brace expansion to its static prefix, in a span and in a command', () => {
        expect(citationsIn('`packages/kit/src/i18n/messages/{en,es}.json`')).toEqual(['packages/kit/src/i18n/messages'])
        expect(citationsIn('`rm apps/showcase/messages/{en,es}.json`')).toEqual(['apps/showcase/messages'])
    })

    it('strips a trailing line reference, which names a place in a file and not a file', () => {
        expect(citationsIn('`docs/build-notes.md:52`')).toEqual(['docs/build-notes.md'])
        expect(citationsIn('`apps/showcase/src/app/[locale]/layout.tsx:67:9`')).toEqual([
            'apps/showcase/src/app/[locale]/layout.tsx',
        ])
    })

    it('keeps a colon that is not a line reference', () => {
        expect(citationsIn('`scripts/release.mjs:latest`')).toEqual(['scripts/release.mjs:latest'])
    })

    it('ignores build outputs, which depend on whether you happened to run a build', () => {
        expect(citationsIn('`rm -rf apps/showcase/.next`')).toEqual([])
    })

    it('ignores a span with no repo-rooted token', () => {
        expect(citationsIn('`pnpm install` and `--filter showcase`')).toEqual([])
    })

    it('keeps `raw` as the whole span, which is what `generalizeAppCitations` rewrites on', () => {
        const dir = makeTestTmpDir('doc-set-')
        const file = path.join(dir, 'doc.md')
        writeFileSync(file, '`pnpm --filter showcase exec vitest apps/showcase/src`')
        expect(citedPaths(file)).toEqual([
            { path: 'apps/showcase/src', raw: 'pnpm --filter showcase exec vitest apps/showcase/src', line: 1 },
        ])
    })
})

/**
 * `resolves` against real directory trees, because what it decides depends on which apps exist. Three trees,
 * and the point is that the template is strict while an adopted tree is not strict about SSSB's two apps.
 */
describe('resolves', () => {
    /** A tree under a fresh root. `files` are created with their parents; `dirs` are empty directories. */
    function tree(files: string[], dirs: string[] = []): string {
        const root = makeTestTmpDir('doc-set-resolves-')
        for (const dir of dirs) mkdirSync(path.join(root, dir), { recursive: true })
        for (const file of files) {
            mkdirSync(path.dirname(path.join(root, file)), { recursive: true })
            writeFileSync(path.join(root, file), '')
        }
        return root
    }
    // `only-in-temp` exists in these trees and nowhere else, so a lookup that ignored `root` and read the
    // process's own working directory (the real repo) would answer differently.
    const template = () =>
        tree(
            ['apps/showcase/package.json', 'apps/starter/package.json'],
            ['apps/showcase/src/only-in-temp', 'apps/starter/src', 'packages/kit/src'],
        )
    const adopted = () => tree(['apps/console/package.json'], ['apps/console/src', 'packages/kit/src']) // ejected, starter renamed
    const renamedOnly = () =>
        tree(['apps/showcase/package.json', 'apps/console/package.json'], ['apps/showcase/src', 'packages/kit/src'])

    it('reads the tree it is given, not the working directory', () => {
        expect(resolves('apps/showcase/src/only-in-temp', template())).toBe(true)
        expect(resolves('apps/showcase/src/only-in-temp', adopted()), "absent app: SSSB's").toBe(true)
        expect(resolves('packages/kit/src/only-in-temp', template())).toBe(false)
        expect(resolves('scripts', template()), 'a directory of the real repo that is not in the temp tree').toBe(false)
    })

    it('accepts a file citation on its parent directory existing in the tree it is given, not the working directory', () => {
        expect(resolves('apps/showcase/src/only-in-temp/new.ts', template())).toBe(true)
        // `packages/kit/src` is in the temp tree; `scripts/` is only in the real repo
        expect(resolves('packages/kit/src/new.ts', template())).toBe(true)
        expect(resolves('scripts/new.ts', template())).toBe(false)
    })

    it('is strict in the template: a broken citation of either reference app fails', () => {
        const root = template()
        expect(resolves('apps/showcase/src/no-such-dir', root)).toBe(false)
        expect(resolves('apps/starter/src/no-such-dir', root)).toBe(false)
        expect(resolves('apps/showcase', root)).toBe(true)
    })

    it("lets an adopted tree cite SSSB's reference apps, which are not in it", () => {
        const root = adopted()
        expect(resolves('apps/starter/src/app/[locale]/signin/page.tsx', root)).toBe(true)
        expect(resolves('apps/showcase/src/domain/db/tickets.ts', root)).toBe(true)
        expect(resolves('apps/showcase/src/no-such-dir', root)).toBe(true)
        expect(resolves('apps/starter', root)).toBe(true)
    })

    it('stays strict for everything else in an adopted tree', () => {
        const root = adopted()
        expect(resolves('apps/console/src/no-such-dir', root), "the adopter's own app").toBe(false)
        expect(resolves('packages/kit/src/no-such-dir', root)).toBe(false)
        expect(resolves('docs/no-such-dir', root)).toBe(false)
        expect(resolves('apps/showcase-extra/src', root), 'a lookalike prefix is not the showcase').toBe(false)
    })

    it('judges each reference app by whether IT is present', () => {
        const root = renamedOnly() // the showcase kept, the starter renamed away
        expect(resolves('apps/showcase/src/no-such-dir', root)).toBe(false)
        expect(resolves('apps/starter/src/no-such-dir', root)).toBe(true)
    })

    it('keeps checking an app called starter that the adopter kept', () => {
        const root = tree(['apps/starter/package.json'], ['apps/starter/src', 'packages/kit/src']) // kept the name `starter`
        expect(resolves('apps/starter/src/no-such-dir', root)).toBe(false)
    })

    it('is not fooled by what a merge leaves behind where the app used to be', () => {
        // An upstream merge adds every NEW file under apps/showcase/ back, even after you deleted the app; a
        // local rename leaves apps/starter/node_modules. Neither makes the directory an app again.
        const root = tree(
            [
                'apps/console/package.json',
                'apps/showcase/DEMO-SIZE.md',
                'apps/showcase/tests/e2e/new.spec.ts',
                'apps/showcase/src/new-component.ts', // where a new upstream file most often lands
            ],
            ['apps/starter/node_modules/left-behind', 'packages/kit/src'],
        )
        expect(resolves('apps/showcase/src/domain/db/tickets.ts', root)).toBe(true)
        expect(resolves('apps/showcase/src/app-config', root)).toBe(true)
        expect(resolves('apps/starter/src/app/[locale]/signin/page.tsx', root)).toBe(true)
    })
})
