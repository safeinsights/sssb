import { existsSync, readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import ts from 'typescript'
import { expect } from 'vitest'
import type { CheckImpl } from './types'

/**
 * `real-auth-provider`: a route module that loads one of SSSB's real-mode auth forms sits under a layout that loads
 * their provider. The forms (`@sssb/kit/adapters/real/sign-in-form`, `.../accept-invite-form`) call the auth vendor's
 * client hooks, which throw outside its provider (`RealAuthProviders`, `@sssb/kit/adapters/real/providers`). In
 * simulated mode neither the form nor the provider loads, so nothing but real mode shows the gap: a real sign-in page
 * that fails to render. SSSB's own starter once shipped without the provider, and no gate saw it.
 *
 * What it reads: every module under the app's `src/app`, parsed with TypeScript, for the specifiers it imports (import
 * and export declarations, and `import()` with a literal). A module that loads a form passes when some `layout` file in
 * its own directory or in one above it, up to `src/app`, loads the provider. A comment or a string naming the provider
 * does not count. What it does not read: whether the layout's import runs (an `isSimulated` branch is how it should
 * be written, and a dead one would pass), or a form loaded by a module outside `src/app`, a screen under
 * `src/components` say, whose route the check cannot tell.
 */

const FORMS = ['@sssb/kit/adapters/real/sign-in-form', '@sssb/kit/adapters/real/accept-invite-form']
const PROVIDER = '@sssb/kit/adapters/real/providers'
const SOURCE = /\.(tsx?|jsx?|mts|cts|mjs|cjs)$/
const LAYOUT = /^layout\.(tsx?|jsx?)$/

/** Every source file under `dir`, recursively, as absolute paths. */
function sourceFiles(dir: string): string[] {
    const files: string[] = []
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name)
        if (entry.isDirectory()) files.push(...sourceFiles(full))
        else if (SOURCE.test(entry.name) && !/\.(test|spec|stories)\.[^.]+$/.test(entry.name)) files.push(full)
    }
    return files
}

/** The module specifiers `file` imports: declarations, re-exports, and `import()` of a string literal. */
export function importedSpecifiers(file: string): Set<string> {
    const source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true)
    const found = new Set<string>()
    const visit = (node: ts.Node): void => {
        if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier) {
            if (ts.isStringLiteral(node.moduleSpecifier)) found.add(node.moduleSpecifier.text)
        } else if (
            ts.isCallExpression(node) &&
            node.expression.kind === ts.SyntaxKind.ImportKeyword &&
            node.arguments[0] &&
            ts.isStringLiteralLike(node.arguments[0])
        ) {
            found.add(node.arguments[0].text)
        }
        ts.forEachChild(node, visit)
    }
    visit(source)
    return found
}

/** The layout files that wrap a route module in `dir`: its own directory's and every one above it, up to `appRoot`. */
function layoutsAbove(dir: string, appRoot: string): string[] {
    const layouts: string[] = []
    for (let current = dir; ; current = path.dirname(current)) {
        for (const name of readdirSync(current)) if (LAYOUT.test(name)) layouts.push(path.join(current, name))
        if (current === appRoot || path.dirname(current) === current) break
    }
    return layouts
}

/** What the check finds in an app: the route modules that load a form, and the ones of those with no provider above. */
export function realAuthProviderGaps(appDir: string): { walked: number; withForms: string[]; gaps: string[] } {
    const appRoot = path.join(appDir, 'src', 'app')
    if (!existsSync(appRoot)) return { walked: 0, withForms: [], gaps: [] }
    const files = sourceFiles(appRoot)
    const withForms = files.filter((file) => {
        const specifiers = importedSpecifiers(file)
        return FORMS.some((form) => specifiers.has(form))
    })
    const gaps = withForms.filter(
        (file) => !layoutsAbove(path.dirname(file), appRoot).some((layout) => importedSpecifiers(layout).has(PROVIDER)),
    )
    const rel = (file: string) => path.relative(appDir, file)
    return { walked: files.length, withForms: withForms.map(rel), gaps: gaps.map(rel) }
}

export const realAuthProvider: CheckImpl = {
    tests: {
        "the app's src/app is really walked": ({ appDir }) => {
            const { walked } = realAuthProviderGaps(appDir)
            expect(walked, `no source module found under ${path.join(appDir, 'src', 'app')}`).toBeGreaterThan(0)
        },
        'every route module that loads a real auth form sits under a layout that loads RealAuthProviders': ({
            appDir,
        }) => {
            const { gaps } = realAuthProviderGaps(appDir)
            expect(
                gaps,
                `these load ${FORMS.join(' or ')}, but no layout above them loads ${PROVIDER}, so the form throws in ` +
                    'real mode. Mount RealAuthProviders in a layout above them, loaded with import() when !isSimulated',
            ).toEqual([])
        },
    },
}
