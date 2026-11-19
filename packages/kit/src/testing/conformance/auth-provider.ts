import { readdirSync, readFileSync, statSync } from 'node:fs'
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
 * How it reads the app: from each of Next's rendering files under `src/app` (`page`, `layout`, `template`, `default`,
 * `not-found`, `error`, `global-error`, `loading`, `forbidden`, `unauthorized`), it follows the app's own imports
 * (a relative path, `@/` for the app's `src/`, `@sssb/app-config/` for its seam) through import and export
 * declarations and `import()` of a literal, and notes whether each file reaches a form or the provider. An import that
 * loads nothing (`import type`, or every name marked `type`) is not followed, nor is a specifier it cannot resolve to
 * a file; a comment or a string naming a module does not count. A rendering file that reaches a form passes when it
 * is wrapped by one that reaches the provider: a layout or template that is itself that file, or one in a directory
 * above it, or in its own directory, where a page is inside both, a template is inside the layout, and a layout is
 * inside neither. `global-error` replaces the root layout, so only it can wrap itself.
 *
 * What it does not read: whether an import runs (an `isSimulated` branch is how it should be written, and a dead one
 * would pass), a path alias other than those two, and anything behind a symbolic link, which it does not follow, as the
 * authorization scan does not. It parses each file once and settles what every file reaches in one pass over the
 * graph, so its cost grows with the app's size, not with its pages times its modules.
 */

const FORMS: ReadonlySet<string> = new Set([
    '@sssb/kit/adapters/real/sign-in-form',
    '@sssb/kit/adapters/real/accept-invite-form',
])
const PROVIDER = '@sssb/kit/adapters/real/providers'
/**
 * The seam's specifiers, as a prefix. Built from the package name because a literal spelling of a seam module path in
 * shipped kit source is what `seam-specifiers.test.ts` refuses as a specifier it cannot list.
 */
const SEAM_PACKAGE = '@sssb/app-config'
const SEAM_PREFIX = `${SEAM_PACKAGE}/`
const EXTENSIONS = ['.tsx', '.ts', '.jsx', '.js', '.mts', '.cts', '.mjs', '.cjs']
/** What a written `.js`-style extension may stand for, as TypeScript's `bundler` resolution reads it. */
const SOURCE_FOR: Readonly<Record<string, readonly string[]>> = {
    '.js': ['.ts', '.tsx', '.js', '.jsx'],
    '.jsx': ['.tsx', '.jsx'],
    '.mjs': ['.mts', '.mjs'],
    '.cjs': ['.cts', '.cjs'],
}
const RENDERING =
    /^(page|layout|template|default|not-found|error|global-error|loading|forbidden|unauthorized)\.(tsx?|jsx?)$/
const LAYOUT = /^layout\.(tsx?|jsx?)$/
const TEMPLATE = /^template\.(tsx?|jsx?)$/

/** Paths as the report prints them: relative to the app, with `/` on every platform. */
const relativeTo = (appDir: string, file: string) => path.relative(appDir, file).split(path.sep).join('/')

/** The entries of `dir`, or none when it cannot be read, which is then recorded. */
function entriesOf(dir: string, unreadable: Map<string, string>) {
    try {
        return readdirSync(dir, { withFileTypes: true })
    } catch (error) {
        unreadable.set(dir, (error as Error).message)
        return []
    }
}

/** Every rendering file under `dir`, recursively, as absolute paths. Symbolic links are not followed. */
function renderingFiles(dir: string, unreadable: Map<string, string>): string[] {
    const files: string[] = []
    for (const entry of entriesOf(dir, unreadable)) {
        const full = path.join(dir, entry.name)
        if (entry.isDirectory()) files.push(...renderingFiles(full, unreadable))
        else if (entry.isFile() && RENDERING.test(entry.name)) files.push(full)
    }
    return files
}

/** True when an import or export declaration loads nothing at run time: all of it, or every name in it, is a type. */
function typeOnly(node: ts.ImportDeclaration | ts.ExportDeclaration): boolean {
    if (ts.isImportDeclaration(node)) {
        const clause = node.importClause
        if (clause === undefined) return false // `import 'x'` runs the module
        if (clause.isTypeOnly) return true
        const named = clause.namedBindings
        return (
            clause.name === undefined &&
            named !== undefined &&
            ts.isNamedImports(named) &&
            named.elements.length > 0 &&
            named.elements.every((element) => element.isTypeOnly)
        )
    }
    if (node.isTypeOnly) return true
    const clause = node.exportClause
    return (
        clause !== undefined &&
        ts.isNamedExports(clause) &&
        clause.elements.length > 0 &&
        clause.elements.every((element) => element.isTypeOnly)
    )
}

/** The specifiers `file` loads at run time: value import and export declarations, and `import()` of a literal. */
function loadedSpecifiers(file: string): string[] {
    const source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true)
    const found: string[] = []
    const visit = (node: ts.Node): void => {
        if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
            const specifier = node.moduleSpecifier
            if (specifier && ts.isStringLiteral(specifier) && !typeOnly(node)) found.push(specifier.text)
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

const isFile = (file: string) => {
    try {
        return statSync(file).isFile()
    } catch {
        return false
    }
}

const isDirectory = (dir: string) => {
    try {
        return statSync(dir).isDirectory()
    } catch {
        return false
    }
}

/** The app file a specifier names, through a relative path, `@/` or `@sssb/app-config/`; undefined for anything else. */
function resolverFor(srcDir: string): (specifier: string, from: string) => string | undefined {
    const cache = new Map<string, string | undefined>()
    return (specifier, from) => {
        let base: string
        if (specifier.startsWith('@/')) base = path.join(srcDir, specifier.slice(2))
        else if (specifier.startsWith(SEAM_PREFIX)) {
            base = path.join(srcDir, 'app-config', specifier.slice(SEAM_PREFIX.length))
        } else if (specifier === '.' || specifier === '..' || /^\.\.?\//.test(specifier)) {
            base = path.resolve(path.dirname(from), specifier)
        } else return undefined
        if (cache.has(base)) return cache.get(base)
        const written = path.extname(base)
        const stem = base.slice(0, base.length - written.length)
        const candidates = [
            base,
            ...(SOURCE_FOR[written] ?? []).map((ext) => stem + ext),
            ...EXTENSIONS.map((ext) => base + ext),
            ...EXTENSIONS.map((ext) => path.join(base, `index${ext}`)),
        ]
        const found = candidates.find(isFile)
        cache.set(base, found)
        return found
    }
}

interface Reach {
    form: boolean
    provider: boolean
}

/**
 * What every file reachable from `roots` reaches, settled in one pass: each file is parsed once to learn what it
 * loads directly and which app files it imports, and then each flag is carried backwards along the imports from the
 * files that set it. Cycles need nothing special: a file is visited at most once per flag.
 */
function reachOf(roots: readonly string[], srcDir: string, unreadable: Map<string, string>): Map<string, Reach> {
    const resolve = resolverFor(srcDir)
    const direct = new Map<string, Reach>()
    const importers = new Map<string, string[]>()
    const queue = [...roots]
    const seen = new Set(roots)
    while (queue.length > 0) {
        const file = queue.shift() as string
        const reach: Reach = { form: false, provider: false }
        let specifiers: string[] = []
        try {
            specifiers = loadedSpecifiers(file)
        } catch (error) {
            unreadable.set(file, (error as Error).message)
        }
        for (const specifier of specifiers) {
            if (FORMS.has(specifier)) reach.form = true
            if (specifier === PROVIDER) reach.provider = true
            const local = resolve(specifier, file)
            if (local === undefined) continue
            const list = importers.get(local) ?? []
            list.push(file)
            importers.set(local, list)
            if (!seen.has(local)) {
                seen.add(local)
                queue.push(local)
            }
        }
        direct.set(file, reach)
    }
    const result = new Map<string, Reach>([...seen].map((file) => [file, { form: false, provider: false }]))
    for (const flag of ['form', 'provider'] as const) {
        const pending = [...direct].filter(([, reach]) => reach[flag]).map(([file]) => file)
        for (const file of pending) (result.get(file) as Reach)[flag] = true
        while (pending.length > 0) {
            for (const importer of importers.get(pending.pop() as string) ?? []) {
                const reach = result.get(importer) as Reach
                if (!reach[flag]) {
                    reach[flag] = true
                    pending.push(importer)
                }
            }
        }
    }
    return result
}

/**
 * The layouts and templates that wrap `file`, itself included when it is one: in its own directory, a page (or any
 * other rendering file) is inside both, a template is inside the layout, and a layout is inside neither; every layout
 * and template in each directory above wraps it, up to `appRoot`. A `global-error` replaces the root layout, so it
 * wraps itself and nothing else does.
 */
function wrappersOf(file: string, appRoot: string, unreadable: Map<string, string>): string[] {
    const name = path.basename(file)
    if (/^global-error\./.test(name)) return [file]
    const wrappers = LAYOUT.test(name) || TEMPLATE.test(name) ? [file] : []
    const own = path.dirname(file)
    for (let current = own; ; current = path.dirname(current)) {
        for (const entry of entriesOf(current, unreadable)) {
            if (!entry.isFile()) continue
            const isLayout = LAYOUT.test(entry.name)
            const isTemplate = TEMPLATE.test(entry.name)
            if (!isLayout && !isTemplate) continue
            if (current === own) {
                if (LAYOUT.test(name)) continue // a layout is inside neither of its own directory's wrappers
                if (TEMPLATE.test(name) && isTemplate) continue // a template is inside its layout, not itself again
            }
            wrappers.push(path.join(current, entry.name))
        }
        if (current === appRoot || path.dirname(current) === current) break
    }
    return wrappers
}

/** What the check finds: how many rendering files it walked, those that reach a form, those no provider wraps. */
export function realAuthProviderGaps(appDir: string): {
    walked: number
    withForms: string[]
    gaps: string[]
    unreadable: string[]
} {
    const srcDir = path.join(appDir, 'src')
    const appRoot = path.join(srcDir, 'app')
    const unreadableFiles = new Map<string, string>()
    if (!isDirectory(appRoot)) return { walked: 0, withForms: [], gaps: [], unreadable: [] }
    const files = renderingFiles(appRoot, unreadableFiles)
    const reach = reachOf(files, srcDir, unreadableFiles)
    const reaches = (file: string, flag: keyof Reach) => reach.get(file)?.[flag] ?? false
    const withForms = files.filter((file) => reaches(file, 'form'))
    const gaps = withForms.filter(
        (file) => !wrappersOf(file, appRoot, unreadableFiles).some((wrapper) => reaches(wrapper, 'provider')),
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
            expect(unreadable, 'these files or directories could not be read').toEqual([])
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
