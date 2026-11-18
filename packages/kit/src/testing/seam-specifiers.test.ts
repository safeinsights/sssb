import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'
import seamSpecifiers from './seam-specifiers.json'

/**
 * `seam-specifiers.json` is the list the conformance suite's `seam-map` check resolves against an app's seam: every
 * `@sssb/app-config/*` specifier the SHIPPED kit source imports. A list is only as good as its last edit, so this
 * holds it equal to a scan of the source, read with TypeScript's parser (an import, an export-from, a dynamic
 * `import('…')`, a type `import('…')`, a `require('…')`), never the text, so a comment cannot add one or hide one.
 *
 * SHIPPED means what `package.json`'s `files` allowlist ships, read from the allowlist itself: a module that does
 * not ship cannot need an app's seam module in an adopter's install. A seam specifier the scan cannot read — a
 * template literal, or a string assembled at run time — fails, since no list could name what it reaches.
 */
const packageDir = path.resolve(import.meta.dirname, '../..')
const SEAM = '@sssb/app-config'

/** The `files` allowlist as a predicate over package-relative paths (paths and globs; `!` excludes). */
function shippedBy(files: readonly string[]): (rel: string) => boolean {
    const toRegex = (glob: string) => {
        let re = ''
        for (let i = 0; i < glob.length; i++) {
            if (glob.startsWith('**/', i)) {
                re += '(?:.*/)?'
                i += 2
            } else if (glob[i] === '*') re += '[^/]*'
            else re += glob[i]!.replace(/[.+?^${}()|[\]\\]/, '\\$&')
        }
        return new RegExp(`^${re}$`)
    }
    // npm's rule: entries apply in order, and the last one that matches a path decides.
    return (rel) => {
        let shipped = false
        for (const entry of files) {
            const negated = entry.startsWith('!')
            const pattern = negated ? entry.slice(1) : entry
            const matches = /[*?]/.test(pattern)
                ? toRegex(pattern).test(rel)
                : rel === pattern || rel.startsWith(`${pattern}/`)
            if (matches) shipped = !negated
        }
        return shipped
    }
}

function sourcesUnder(dir: string): string[] {
    return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
        const full = path.join(dir, entry.name)
        if (entry.isDirectory()) return sourcesUnder(full)
        return /\.[cm]?[jt]sx?$/.test(entry.name) && !entry.name.endsWith('.d.ts') ? [full] : []
    })
}

/** Every seam specifier one file imports, and every seam-looking string it holds that is not one. */
function seamSpecifiersOf(fileName: string, text: string): { specifiers: string[]; unscannable: string[] } {
    const sf = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true)
    const specifiers: string[] = []
    const unscannable: string[] = []
    const asSpecifier = new Set<ts.Node>()
    const visit = (node: ts.Node): void => {
        let spec: ts.Node | undefined
        if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) spec = node.moduleSpecifier
        else if (
            ts.isCallExpression(node) &&
            (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
                (ts.isIdentifier(node.expression) && node.expression.text === 'require'))
        )
            spec = node.arguments[0]
        else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)) spec = node.argument.literal
        if (spec && (ts.isStringLiteral(spec) || ts.isNoSubstitutionTemplateLiteral(spec))) {
            asSpecifier.add(spec)
            if (spec.text === SEAM || spec.text.startsWith(`${SEAM}/`)) specifiers.push(spec.text)
        }
        const literalText = ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) ? node.text : undefined
        const templateHead = ts.isTemplateExpression(node) ? node.head.text : undefined
        const seen = literalText ?? templateHead
        // A seam MODULE's spelling (the package name alone is a name, not a module) anywhere but an import's specifier.
        if (seen !== undefined && seen.startsWith(`${SEAM}/`) && !asSpecifier.has(node)) {
            unscannable.push(`${path.relative(packageDir, fileName)}: ${node.getText(sf)}`)
        }
        ts.forEachChild(node, visit)
    }
    visit(sf)
    return { specifiers, unscannable }
}

describe('seam-specifiers.json', () => {
    const manifest = JSON.parse(readFileSync(path.join(packageDir, 'package.json'), 'utf8')) as { files: string[] }
    const shipped = shippedBy(manifest.files)
    const files = sourcesUnder(path.join(packageDir, 'src')).filter((file) =>
        shipped(path.relative(packageDir, file).split(path.sep).join('/')),
    )
    const scans = files.map((file) => seamSpecifiersOf(file, readFileSync(file, 'utf8')))

    it('reads the shipped source (a broken walk or allowlist read finds nothing)', () => {
        expect(files.length).toBeGreaterThan(100)
        expect(files.some((file) => file.endsWith('.test.ts'))).toBe(false)
    })

    it('names exactly the seam specifiers the shipped kit source imports', () => {
        const found = [...new Set(scans.flatMap((scan) => scan.specifiers))].sort()
        expect(
            [...seamSpecifiers.specifiers].sort(),
            'packages/kit/src/testing/seam-specifiers.json has drifted from the source: set its `specifiers` to the list below',
        ).toEqual(found)
    })

    it('finds no seam specifier it cannot read (a template or a string built at run time)', () => {
        expect(scans.flatMap((scan) => scan.unscannable)).toEqual([])
    })

    it('reads each kind of specifier, and refuses a template', () => {
        const probe = seamSpecifiersOf(
            path.join(packageDir, 'src/probe.ts'),
            [
                "import { a } from '@sssb/app-config/a'",
                "export { b } from '@sssb/app-config/b'",
                "const c = await import('@sssb/app-config/c')",
                "type D = typeof import('@sssb/app-config/d')",
                "// import { e } from '@sssb/app-config/e'",
                'const f = await import(`@sssb/app-config/${name}`)',
            ].join('\n'),
        )
        expect(probe.specifiers).toEqual([
            '@sssb/app-config/a',
            '@sssb/app-config/b',
            '@sssb/app-config/c',
            '@sssb/app-config/d',
        ])
        expect(probe.unscannable).toEqual(['src/probe.ts: `@sssb/app-config/${name}`'])
    })
})
