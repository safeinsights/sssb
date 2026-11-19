import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import ts from 'typescript'
import { expect } from 'vitest'
import type { CheckImpl } from './types'

/**
 * `real-auth-provider`: a page that renders one of SSSB's real-mode auth forms sits under a layout that mounts their
 * provider. The forms (`@sssb/kit/adapters/real/sign-in-form`, `.../accept-invite-form`) call the auth vendor's client
 * hooks, which throw outside its provider (`RealAuthProviders`, `@sssb/kit/adapters/real/providers`). In simulated mode
 * neither the form nor the provider loads, so nothing but real mode shows the gap: a real sign-in page that fails to
 * render. SSSB's own starter once shipped without the provider, and no gate saw it.
 *
 * How it reads the app: from each of Next's rendering files under `src/app` (`page`, `template`, `default`,
 * `not-found`, `error`, `loading`, `forbidden`, `unauthorized`, and `layout`), it follows the app's own imports, a
 * relative path or `@/` (the app's `src/`), through import and export declarations and `import()` of a literal, and
 * notes whether it reaches a form or the provider. Type-only imports load nothing and are not followed; neither is a
 * specifier it cannot resolve to a file. A comment or a string naming a module does not count. A rendering file that
 * reaches a form passes when it is itself a layout or template that reaches the provider, or when a layout or template
 * in its directory or one above it, up to `src/app`, does.
 *
 * What it does not read: whether an import runs (an `isSimulated` branch is how it should be written, and a dead one
 * would pass), a path alias other than `@/`, and anything behind a symbolic link, which it does not follow, as the
 * authorization scan does not.
 */

const FORMS: ReadonlySet<string> = new Set([
    '@sssb/kit/adapters/real/sign-in-form',
    '@sssb/kit/adapters/real/accept-invite-form',
])
const PROVIDER = '@sssb/kit/adapters/real/providers'
const EXTENSIONS = ['.tsx', '.ts', '.jsx', '.js', '.mts', '.cts', '.mjs', '.cjs']
const RENDERING = /^(page|template|default|not-found|error|loading|forbidden|unauthorized|layout)\.(tsx?|jsx?)$/
const WRAPPER = /^(layout|template)\.(tsx?|jsx?)$/

/** Paths as the report prints them: relative to the app, with `/` on every platform. */
const relativeTo = (appDir: string, file: string) => path.relative(appDir, file).split(path.sep).join('/')

/** Every rendering file under `dir`, recursively, as absolute paths. Symbolic links are not followed. */
function renderingFiles(dir: string): string[] {
    const files: string[] = []
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name)
        if (entry.isDirectory()) files.push(...renderingFiles(full))
        else if (entry.isFile() && RENDERING.test(entry.name)) files.push(full)
    }
    return files
}

/** The specifiers `file` loads at run time: value import and export declarations, and `import()` of a literal. */
function loadedSpecifiers(file: string): string[] {
    const source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true)
    const found: string[] = []
    const visit = (node: ts.Node): void => {
        if (ts.isImportDeclaration(node)) {
            if (!node.importClause?.isTypeOnly && ts.isStringLiteral(node.moduleSpecifier)) {
                found.push(node.moduleSpecifier.text)
            }
        } else if (ts.isExportDeclaration(node)) {
            if (!node.isTypeOnly && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
                found.push(node.moduleSpecifier.text)
            }
        } else if (
            ts.isCallExpression(node) &&
            node.expression.kind === ts.SyntaxKind.ImportKeyword &&
            node.arguments[0] &&
            ts.isStringLiteralLike(node.arguments[0])
        ) {
            found.push(node.arguments[0].text)
        }
        ts.forEachChild(node, visit)
    }
    visit(source)
    return found
}

/** The app file a relative or `@/` specifier names, or undefined when it is neither or names no file. */
function resolveLocal(specifier: string, from: string, srcDir: string): string | undefined {
    let base: string
    if (specifier.startsWith('@/')) base = path.join(srcDir, specifier.slice(2))
    else if (specifier.startsWith('./') || specifier.startsWith('../'))
        base = path.resolve(path.dirname(from), specifier)
    else return undefined
    const candidates = [
        base,
        ...EXTENSIONS.map((ext) => base + ext),
        ...EXTENSIONS.map((ext) => path.join(base, `index${ext}`)),
    ]
    return candidates.find((file) => existsSync(file) && statSync(file).isFile())
}

interface Reach {
    form: boolean
    provider: boolean
}

/**
 * What a file reaches through the app's own imports: a walk of its import graph, each file once (an import cycle ends
 * there). Each file is parsed once across walks; a file that cannot be read is collected with its error.
 */
function reacher(srcDir: string, unreadable: Map<string, string>): (file: string) => Reach {
    const parsed = new Map<string, string[]>()
    const specifiersOf = (file: string): string[] => {
        let specifiers = parsed.get(file)
        if (specifiers === undefined) {
            try {
                specifiers = loadedSpecifiers(file)
            } catch (error) {
                unreadable.set(file, (error as Error).message)
                specifiers = []
            }
            parsed.set(file, specifiers)
        }
        return specifiers
    }
    return (start) => {
        const result: Reach = { form: false, provider: false }
        const seen = new Set([start])
        const queue = [start]
        while (queue.length > 0) {
            const file = queue.shift() as string
            for (const specifier of specifiersOf(file)) {
                if (FORMS.has(specifier)) result.form = true
                if (specifier === PROVIDER) result.provider = true
                const local = resolveLocal(specifier, file, srcDir)
                if (local !== undefined && !seen.has(local)) {
                    seen.add(local)
                    queue.push(local)
                }
            }
        }
        return result
    }
}

/** The layouts and templates that wrap a rendering file in `dir`: its own directory's and each above it, to `appRoot`. */
function wrappersAbove(dir: string, appRoot: string): string[] {
    const wrappers: string[] = []
    for (let current = dir; ; current = path.dirname(current)) {
        for (const entry of readdirSync(current, { withFileTypes: true })) {
            if (entry.isFile() && WRAPPER.test(entry.name)) wrappers.push(path.join(current, entry.name))
        }
        if (current === appRoot || path.dirname(current) === current) break
    }
    return wrappers
}

/** What the check finds: how many rendering files it walked, those that reach a form, those with no provider above. */
export function realAuthProviderGaps(appDir: string): {
    walked: number
    withForms: string[]
    gaps: string[]
    unreadable: string[]
} {
    const srcDir = path.join(appDir, 'src')
    const appRoot = path.join(srcDir, 'app')
    if (!existsSync(appRoot)) return { walked: 0, withForms: [], gaps: [], unreadable: [] }
    const unreadableFiles = new Map<string, string>()
    const reach = reacher(srcDir, unreadableFiles)
    const files = renderingFiles(appRoot)
    const withForms = files.filter((file) => reach(file).form)
    const gaps = withForms.filter(
        (file) =>
            !(WRAPPER.test(path.basename(file)) && reach(file).provider) &&
            !wrappersAbove(path.dirname(file), appRoot).some((wrapper) => reach(wrapper).provider),
    )
    const rel = (file: string) => relativeTo(appDir, file)
    return {
        walked: files.length,
        withForms: withForms.map(rel),
        gaps: gaps.map(rel),
        unreadable: [...unreadableFiles].map(([file, why]) => `${rel(file)}: ${why}`),
    }
}

export const realAuthProvider: CheckImpl = {
    tests: {
        "the app's src/app is really walked": ({ appDir }) => {
            const { walked, unreadable } = realAuthProviderGaps(appDir)
            expect(walked, `no page or layout found under ${path.join(appDir, 'src', 'app')}`).toBeGreaterThan(0)
            expect(unreadable, 'these files could not be read').toEqual([])
        },
        'every page that reaches a real auth form sits under a layout that reaches RealAuthProviders': ({ appDir }) => {
            const { gaps } = realAuthProviderGaps(appDir)
            expect(
                gaps,
                `these reach ${[...FORMS].join(' or ')}, but no layout above them reaches ${PROVIDER}, so the form ` +
                    'throws in real mode. Mount RealAuthProviders in a layout above them, loaded with import() when ' +
                    '!isSimulated',
            ).toEqual([])
        },
    },
}
