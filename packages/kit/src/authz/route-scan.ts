import { type Dirent, existsSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs'
import path from 'node:path'
import ts from 'typescript'

/**
 * The analyser behind the authorization scan (each app's, ./app-exemptions.ts `scanApp`, and the kit's own over its
 * fixture, `authorized-mutations.test.ts`), split out so the scan's POLICY (which roots, which exemptions:
 * ./route-policy.ts and an app's own) is input rather than something this module knows. It reads route
 * files with the TypeScript compiler's parser and binder, never a regex over their text, and judges EACH
 * exported handler on its own, whatever its verb: a string, a comment, a call in another handler or a call in
 * statically dead code proves nothing about the handler in front of it. A read handler (GET, HEAD, OPTIONS) is held
 * to the same rule as a mutation, because a read of org-scoped data authorizes the read, and may pass in one more way:
 * by reading nothing, naming no data but inert globals, literals and its request (`readsNothing`), as a liveness
 * probe or a preflight does.
 * Which reads touch org-scoped data is not guessed from what a handler calls, since a helper in another module that
 * resolves the org would hide it: a read that calls anything else authorizes, or names an exemption whose gate it
 * passes, as a mutation does (safeinsights/sssb#103). Server Actions (`scanServerActions`) are
 * judged by the same rules as a POST, each export of a `'use server'` file and each function whose body opens with
 * `'use server'`; no exemption applies to one. The walks follow a symbolic link to a directory, as Next does.
 *
 * WHAT "REACHES" MEANS. A call counts for a handler when it sits on that handler's own path:
 *
 * - in the handler's body, before any statement control cannot get past: `return`, `throw`, `break`,
 *   `continue`; an `if`, `try`, `switch` or labeled block every way through which does; a `while (true)` or
 *   `for (;;)` nothing breaks out of; a `do` whose body never falls through;
 * - not in a branch a constant condition rules out: `if (false)`, `false && …`, `true ? … : here`,
 *   `'x' ?? …`, an optional call on a receiver a constant makes nullish (`hook?.(…)` with `const hook = null`), or a
 *   `const` bound to such a literal. Constants are literals, `!`, `void` and parentheses;
 *   nothing else is evaluated;
 * - in a function literal passed as an argument (`withPortErrors(async () => { … })`), which the call is
 *   ASSUMED to invoke and to carry its failure in the call's own result. That is the wrapper idiom every route
 *   uses, and the one trust this module extends: it cannot read an imported wrapper to see whether it really
 *   calls its argument. It extends none to a callee whose code is in this file (`isSameFile`): a function is not
 *   followed through a parameter, so what such a callee is handed counts for nothing. Nor to a callee known never to
 *   hand a function's failure back (`neverCarriesFailure`): a timer or microtask (`setTimeout`, `setInterval`,
 *   `setImmediate`, `queueMicrotask`, `process.nextTick`; bare, as a member of `globalThis`, `self` or `window`, or
 *   imported from Node's `timers`), Next's `after` (and `unstable_after`), which runs its callback after the response,
 *   `Promise.resolve`, which never calls a function, a `.catch`, `.finally` or listener method (`.on`, `.once`,
 *   `addEventListener`, …) on any receiver, and the second argument of `.then`, which runs only on a rejection. A function
 *   handed to a callee whose result is RETURNED counts only where a throw at the call would also reach the outcome
 *   (not inside a `try` whose `catch` swallows): the callee may run it synchronously, a tracing span does;
 * - in a function declared in the SAME module and called (or passed as an argument) from the handler's
 *   path, followed to any depth. A function that is only defined, or that the file reassigns or declares twice,
 *   is not followed;
 * - where its denial reaches the handler's OUTCOME, the promise Next awaits. `authorize` throws synchronously, so a
 *   denial goes up through every synchronous frame, and is lost in three places:
 *   - an async boundary nobody awaits. In an `async` function a throw only rejects the function's promise, and a
 *     function handed to a call may run later (`.then`, a timer, an async wrapper). So a call into an `async`
 *     function, or one a function is handed to, carries the denial only when its result is `await`ed or returned
 *     on the spot (`settledBy`: `return`, an arrow's expression body; through parentheses, a type assertion, a
 *     ternary arm, the right of `&&`, `||`, `??` or a comma, or the left of `||` or `??`). A statement of its own,
 *     `void`, a variable awaited later, a `.then` or `.catch` chain, an argument, all leave the promise floating;
 *   - an array iteration method (`forEach`, `map`, …, by name on any receiver but an object whose code is in this
 *     file, and `Array.from`'s mapper). It drops an `async` function's promise, awaited or not, and runs a sync one
 *     in place, so its throw goes up through the call; but a `map`, `filter` or `flatMap` on a receiver that is
 *     visibly an iterator (`xs.values()`, `Iterator.from(…)`) runs nothing until consumed, and on a receiver whose
 *     head is an import (`R.forEach`, `parse(req).ids.map`), where the name may be a library's, a sync callback
 *     counts only when the call's result is settled, as for any imported callee. The one way an async callback's
 *     failure comes back is `Promise.all(xs.map(async …))` awaited or returned: Promise.all rejects with the first
 *     rejection. `allSettled` never rejects, and `any` and `race` settle on another promise, so they do not count.
 *     (`Array.fromAsync` awaits what its mapper returns, so it is trusted like any imported callee);
 *   - a `try` whose `catch` can do anything but rethrow (fall through, `return`, `break` or `continue` out of
 *     itself), or whose `finally` can leave in the throw's place. A promise the `try` returns (`return p`) is not
 *     caught; `return await p` throws inside it.
 *   (The rule is syntactic: a sync function counts as throwing in place, and an `authorize` named by
 *   `ScanOptions.authorizeModules` must throw synchronously too, as SSSB's does.)
 *
 * For a handler that is a wrapper's result (`export const POST = withX(fn)`), the wrapper call itself and
 * its other arguments run once, when the module loads; only the functions handed to it run per request, so
 * only those are the handler's path. The wrapper, being what Next calls, is trusted to carry their failure, unless
 * its code is in this file, or it sits inside a wrapper whose code is.
 *
 * What is NOT followed, and so does not count: a call into another module (an imported helper that calls
 * `authorize` inside it), a method on an object, a getter, a class body, a generator (calling one runs none of its
 * body), and a parameter or destructuring default (it runs only when the value is missing). Each of those fails the
 * handler.
 *
 * WHAT COUNTS AS `authorize`: a call to the `authorize` imported from one of `ScanOptions.authorizeModules`
 * (SSSB's `@sssb/kit/authz/authorize` by default), under any local name or through a namespace import, by a
 * value import (not `import type`, not a JSDoc `@import`). A local function that happens to be named
 * `authorize` is followed like any other, so it counts only if it calls the real one.
 *
 * WHAT COUNTS AS A GATE'S NAME: the same rule, by binding (`gateName`). A gate's call counts wherever it RUNS on the
 * handler's path, whatever a `try` around it does with its failure (a `calls` gate says what the route's mutation is,
 * so what matters is that it runs). One in a function that never runs, or runs only later and not for the handler (a
 * same-file callee the scan does not follow, a lazy iterator, a timer, a listener, a `.catch` handler, an `after`
 * callback), does not count. `withWebhookSecret`, `auth.updateProfile`,
 * `isSimulated` count only when the name (the head of a dotted one) is a value import kept under the name it is
 * exported by, from any module; a namespace member reads under its own name. A local look-alike
 * (`const isSimulated = true`) or an alias (`import { identity as withWebhookSecret }`) is not the gate.
 *
 * A handler the module cannot resolve at all (a destructured export, a `let`, a reassigned function, an
 * unresolvable re-export, a file that does not parse, a module that is not an ES module) is REFUSED with
 * the reason, and a refusal is a failure.
 *
 * WHAT IT DOES NOT PROVE. "Reaches" is MAY-reach: some path through the handler passes an `authorize` whose denial
 * stops it. It does not prove that EVERY path does, nor that the call comes before the mutation. A handler that
 * returns early on an attacker's input before authorizing, authorizes only inside an `if`, mutates first and
 * authorizes after, or authorizes in a loop over a list that may be empty, passes. Only a branch a constant rules
 * out is dead to it; a condition it cannot evaluate is taken both ways. The rule an author keeps by hand is
 * stronger: authorize before anything else the handler does, on every path.
 */

/** The verbs that mutate. */
const MUTATING_VERBS: readonly string[] = ['POST', 'PUT', 'PATCH', 'DELETE']

/**
 * The verbs that read. A read handler is judged as a mutation is, with one more way to pass: it reads nothing
 * (`HandlerFacts.readsNothing`), as a liveness probe or a CORS preflight does. A read of org-scoped data
 * authorizes the read, since the session's org says where a person is placed, not that they may read there.
 */
const READ_VERBS: readonly string[] = ['GET', 'HEAD', 'OPTIONS']

/** Every verb Next routes to an exported handler: each one the module exports is judged. */
const JUDGED_VERBS: readonly string[] = [...MUTATING_VERBS, ...READ_VERBS]

/** Whether `verb` reads (GET, HEAD, OPTIONS) rather than mutates. */
export function isReadVerb(verb: string): boolean {
    return READ_VERBS.includes(verb)
}

// Next.js routes route.ts/tsx/js/jsx/mjs. All of them, or the scan is bypassable by filename.
const ROUTE_FILE = /^route\.(?:mjs|[jt]sx?)$/

/** The extensions one extensionless module specifier can land on, in TypeScript's resolution or the bundler's. */
const SOURCE_EXTENSIONS = ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs']

/**
 * Every file the module TypeScript resolved to could have been, by the bundler's rules: `impl` with any source
 * extension, `impl/index` with any, and `impl/package.json` (whose `main` the bundler may follow). For a resolved
 * `impl/index.ts`, the module is `impl`.
 */
function moduleCandidates(resolvedFile: string): string[] {
    const stem = resolvedFile.replace(/\.[cm]?[jt]sx?$/, '')
    const base = path.basename(stem) === 'index' ? path.dirname(stem) : stem
    return [
        ...SOURCE_EXTENSIONS.map((ext) => base + ext),
        ...SOURCE_EXTENSIONS.map((ext) => path.join(base, `index${ext}`)),
        path.join(base, 'package.json'),
    ].filter((file) => existsSync(file))
}

export interface ScanRoot {
    /** Human label: disambiguates identical route paths across roots. */
    label: string
    /** Where the walk starts. */
    dir: string
    /** Where exemption paths are measured from. A file outside it gets a `../` path no exemption can match. */
    exemptDir: string
    /**
     * The tsconfig whose module resolution (its `paths`, its `moduleResolution`) re-exports and imported
     * handlers are followed with. Without one, relative specifiers and packages resolve, aliases do not.
     */
    tsconfig?: string | undefined
}

/**
 * What an exemption's gate requires of ONE handler. Each kind is checked per verb, and every name in it
 * must be a value import in the route's module (see the header):
 *
 * - `wrapped-by`: the handler IS a call to one of `callees` (`export const POST = withWebhookSecret(…)`).
 *   For a guard that wraps the handler, reaching it is not enough: the guard has to be what Next calls.
 * - `calls`: the handler reaches a call to one of `callees` (dotted names, `auth.updateProfile`).
 * - `opens-with-simulated-404`: the handler's FIRST statement (after a directive prologue) is `if (!isSimulated)`
 *   and its branch does nothing but return or throw a response built from literals (`return new Response(null,
 *   { status: 404 })`, `return Response.json(…)`, `throw new NotFoundError(…)` with the error imported from
 *   `@sssb/kit/ports/errors`, or a global `…Error`), no parameter runs code before it (a default), and the file
 *   assigns to none of the globals that branch builds (`Response`, `JSON`, an `…Error`), so the real-mode path
 *   does nothing.
 */
export type Gate =
    | { kind: 'wrapped-by'; callees: readonly string[] }
    | { kind: 'calls'; callees: readonly string[] }
    | { kind: 'opens-with-simulated-404' }

/** What the analyser found on one handler's path. */
export interface HandlerFacts {
    /** A call to `authorize` imported from one of the scan's authorize modules is on the handler's path. */
    reachesAuthorize: boolean
    /** Gate name (`gateName`) of the call the handler IS (`export const POST = withX(…)` → `withX`), or null. */
    wrappedBy: string | null
    /** Gate name (`gateName`) of every call on the handler's path that has one (`auth.updateProfile`). */
    calls: ReadonlySet<string>
    /** The handler opens with the inert `if (!isSimulated)` gate and no parameter runs code (`opensWithSimulated404`). */
    opensWithSimulated404: boolean
    /**
     * The handler is a function (not a wrapper's result) whose code, read lexically, names nothing from outside it
     * but inert globals, a few named imports and literal constants (`readsNothing`), so the only data in its reach is
     * its request. What lets a read handler pass without `authorize`.
     */
    readsNothing: boolean
}

/** One exported handler: its facts, or why it could not be read (a refusal is a failure). */
export type Handler =
    { verb: string; facts: HandlerFacts; refusal?: never } | { verb: string; refusal: string; facts?: never }

export interface ScannedRoute {
    root: string
    /** Path relative to the root's `exemptDir`, `/`-separated. */
    rel: string
    file: string
    /** One entry per exported verb Next routes (`JUDGED_VERBS`). Empty for a file that exports none. */
    handlers: Handler[]
}

export interface ScanOptions {
    /** Module specifiers whose `authorize` export is the choke point. Default: SSSB's. */
    authorizeModules?: readonly string[]
}

/** Every route file under every root, each with its exported handlers analysed. */
export function scanRoutes(roots: readonly ScanRoot[], options: ScanOptions = {}): ScannedRoute[] {
    const authorizeModules = options.authorizeModules ?? ['@sssb/kit/authz/authorize']
    return roots.flatMap((root) => {
        const scanner = new RootScanner(root, authorizeModules)
        const unreadable = new Map<string, string>()
        const routes: ScannedRoute[] = routeFiles(root.dir, unreadable).map((file) => ({
            root: root.label,
            rel: path.relative(root.exemptDir, file).split(path.sep).join('/'),
            file,
            handlers: scanner.handlers(file),
        }))
        for (const [dir, code] of unreadable) {
            routes.push({
                root: root.label,
                rel: path.relative(root.exemptDir, dir).split(path.sep).join('/'),
                file: dir,
                handlers: [{ verb: '*', refusal: unreadableRefusal(code) }],
            })
        }
        return routes
    })
}

function routeFiles(dir: string, unreadable: Map<string, string>): string[] {
    return walkFiles(
        dir,
        (name) => ROUTE_FILE.test(name),
        () => true,
        new Set(),
        new Map(),
        unreadable,
    )
}

/** The refusal for a directory the walk could not read: a failure, since a route or an action may be in it. */
function unreadableRefusal(code: string): string {
    return `the directory could not be read (${code}), so a route or Server Action in it would go unchecked`
}

/**
 * Files under `dir` named `route.<something>` that the scan does not read as a route (`route.mts`, `route.api.ts`):
 * Next serves `route.<ext>` for every extension its `pageExtensions` names, which the scan does not read, so such a
 * file may be a route nobody checked. A colocated test artefact (`route.test.ts`, `route.integration.test.ts`,
 * `route.spec.tsx`, `route.stories.tsx`, `route.bench.ts`, `route.test-d.ts`, a `.snap`) and a declaration file are
 * not routes.
 */
export function unreadRouteFiles(dir: string): string[] {
    const named = (name: string) =>
        /^route\./.test(name) &&
        !ROUTE_FILE.test(name) &&
        !/^route\.(?:[\w-]+\.)*(?:test|spec|stories|bench|test-d)\.[cm]?[jt]sx?$/.test(name) &&
        !/\.d\.[cm]?ts$/.test(name) &&
        !name.endsWith('.snap')
    return walkFiles(dir, named, () => true)
}

/**
 * Every file under `dir` whose name `accept`s, descending into each directory `descend` allows. A symbolic link to
 * a directory is followed as Next's own walk follows it (a `Dirent` reports the link, not a directory, so a walk
 * that asked only `isDirectory()` skipped every route behind one), and a link back to a directory the walk is
 * already inside is not, so a cycle ends. A file's path is the one the walk reached it by, link included: that is
 * the path Next serves it at.
 */
function walkFiles(
    dir: string,
    accept: (name: string) => boolean,
    descend: (name: string) => boolean,
    ancestors: ReadonlySet<string> = new Set(),
    walked: Map<string, { base: string; files: string[] }> = new Map(),
    unreadable: Map<string, string> = new Map(),
): string[] {
    // A directory the walk cannot read (EACCES, or removed mid-walk: ENOENT) may hold a route: it is recorded in
    // `unreadable` with the error's code, for the caller to report as a failure, never skipped in silence.
    let real: string
    let listed: Dirent[]
    try {
        real = realpathSync(dir)
        if (ancestors.has(real)) return []
        listed = readdirSync(dir, { withFileTypes: true })
    } catch (error) {
        unreadable.set(dir, (error as NodeJS.ErrnoException).code ?? 'unknown error')
        return []
    }
    const inside = new Set(ancestors).add(real)
    const out: string[] = []
    // Sorted, so what the walk finds never depends on the filesystem's entry order.
    const entries = listed.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    for (const entry of entries) {
        const full = path.join(dir, entry.name)
        const linked = entry.isSymbolicLink() && isDirectoryTarget(full)
        if (entry.isDirectory() || linked) {
            if (!descend(entry.name)) continue
            // A directory reached through a link that was already walked is not walked again (two links per level would
            // make the walk exponential in the depth), but every file found there is reported again at THIS path too:
            // Next serves it at both, and an exemption is judged by path.
            const target = linked ? realpathOrUndefined(full) : undefined
            const prior = target === undefined || inside.has(target) ? undefined : walked.get(target)
            if (prior) {
                out.push(...prior.files.map((file) => path.join(full, path.relative(prior.base, file))))
                continue
            }
            const files = walkFiles(full, accept, descend, inside, walked, unreadable)
            const walkedReal = realpathOrUndefined(full)
            if (walkedReal !== undefined) walked.set(walkedReal, { base: full, files })
            out.push(...files)
        } else if (accept(entry.name)) out.push(full)
    }
    return out.sort()
}

/** A path's real path, or undefined when it cannot be resolved (the walk reports such a directory itself). */
function realpathOrUndefined(file: string): string | undefined {
    try {
        return realpathSync(file)
    } catch {
        return undefined
    }
}

/** Whether a symbolic link leads to a directory; false for a dangling one. */
function isDirectoryTarget(link: string): boolean {
    try {
        return statSync(link).isDirectory()
    } catch {
        return false
    }
}

/** A source file Next could compile into the app, by extension. Declaration files hold no code. */
function isSourceFile(name: string): boolean {
    return /\.(?:[cm]?[jt]sx?)$/.test(name) && !/\.d\.[cm]?ts$/.test(name)
}

/** Whether `statements` opens with a `'use server'` directive (a string-literal statement in the prologue). */
function hasUseServer(statements: readonly ts.Statement[]): boolean {
    for (const statement of statements) {
        if (!ts.isExpressionStatement(statement) || !ts.isStringLiteral(statement.expression)) return false
        if (statement.expression.text === 'use server') return true
    }
    return false
}

/** Whether the file declares any Server Action: a file-level `'use server'`, or one opening a function's body. */
function declaresServerActions(file: string): boolean {
    let text: string
    try {
        text = readFileSync(file, 'utf8')
    } catch {
        // A dangling link (an editor's lockfile, `.#page.tsx -> user@host.pid`): nothing there to serve or to read.
        return false
    }
    if (!text.includes('use server')) return false
    const sf = ts.createSourceFile(file, text, ts.ScriptTarget.ESNext, false)
    let found = hasUseServer(sf.statements)
    const visit = (node: ts.Node): void => {
        if (found) return
        if (ts.isFunctionLike(node) && 'body' in node && node.body && ts.isBlock(node.body)) {
            if (hasUseServer(node.body.statements)) found = true
        }
        ts.forEachChild(node, visit)
    }
    if (!found) visit(sf)
    return found
}

export interface ScannedAction {
    root: string
    /** Path relative to the root's `dir`, `/`-separated. */
    rel: string
    file: string
    /** The action's name: its export name, or `<function name or "inline"> (line N)` for an inline one. */
    name: string
    handler: Handler
}

/**
 * Every Server Action under `root.dir`, each analysed as a mutating handler (verb `action`). A Server Action is
 * a POST endpoint Next exposes for the function, so it must reach `authorize` by the same rules as a route's
 * POST, and no exemption applies to one (the exemption map names route paths). Two kinds: every export of a file
 * that opens with `'use server'`, and every function whose own body opens with it. `node_modules` is not walked.
 */
export function scanServerActions(root: ScanRoot, options: ScanOptions = {}): ScannedAction[] {
    const authorizeModules = options.authorizeModules ?? ['@sssb/kit/authz/authorize']
    const scanner = new RootScanner(root, authorizeModules)
    const unreadable = new Map<string, string>()
    const files = walkFiles(
        root.dir,
        isSourceFile,
        (name) => name !== 'node_modules',
        new Set(),
        new Map(),
        unreadable,
    ).filter(declaresServerActions)
    const actions: ScannedAction[] = files.flatMap((file) =>
        scanner.actions(file).map(({ name, handler }) => ({
            root: root.label,
            rel: path.relative(root.dir, file).split(path.sep).join('/'),
            file,
            name,
            handler,
        })),
    )
    for (const [dir, code] of unreadable) {
        actions.push({
            root: root.label,
            rel: path.relative(root.dir, dir).split(path.sep).join('/'),
            file: dir,
            name: '*',
            handler: { verb: 'action', refusal: unreadableRefusal(code) },
        })
    }
    return actions
}

/**
 * Build and test output a generated workspace's `.gitignore` names, at any depth. A bundler can keep a `'use server'`
 * directive as the first statement of what it writes there, which is not the app's source: judging it would make the
 * check's verdict depend on whether a build had run.
 */
const BUILD_OUTPUT_DIRS: ReadonlySet<string> = new Set([
    'build',
    'cdk.out',
    'coverage',
    'dist',
    'dist-demo',
    'out',
    'playwright-report',
    'storybook-static',
    'test-results',
])

/**
 * Files in `appDir` but outside its `src` (and outside `node_modules`, dot-directories such as a build's `.next`, and
 * BUILD_OUTPUT_DIRS) that declare Server Actions. The scan judges actions only under `src`, so one elsewhere would go
 * unchecked. A directory it cannot read goes in `unreadable`, with its error code.
 */
export function serverActionFilesOutsideSrc(appDir: string, unreadable: Map<string, string> = new Map()): string[] {
    const keep = (name: string) => name !== 'node_modules' && !name.startsWith('.') && !BUILD_OUTPUT_DIRS.has(name)
    if (!existsSync(appDir)) return []
    let entries: Dirent[]
    try {
        entries = readdirSync(appDir, { withFileTypes: true })
    } catch (error) {
        unreadable.set(appDir, (error as NodeJS.ErrnoException).code ?? 'unknown error')
        return []
    }
    return entries
        .flatMap((entry) => {
            const full = path.join(appDir, entry.name)
            if (entry.name === 'src' || !keep(entry.name)) return []
            if (entry.isDirectory() || (entry.isSymbolicLink() && isDirectoryTarget(full))) {
                return walkFiles(full, isSourceFile, keep, new Set(), new Map(), unreadable)
            }
            return isSourceFile(entry.name) ? [full] : []
        })
        .filter(declaresServerActions)
        .sort()
}

/** Why a Server Action fails the scan, or undefined if it passes. No exemption applies to one. */
export function judgeServerAction(action: ScannedAction): string | undefined {
    const where = `${action.root}: ${action.rel} Server Action \`${action.name}\``
    if (action.handler.refusal !== undefined) {
        return `${where} cannot be checked: ${action.handler.refusal}. The scan fails a handler it cannot follow rather than pass it.`
    }
    if (action.handler.facts.reachesAuthorize) return undefined
    return (
        `${where} does not reach authorize(...) on its own path. A Server Action is a POST endpoint Next exposes ` +
        `for the function, whoever renders the form that calls it, so it is judged as a route's POST is, and no ` +
        `exemption applies to it. A call in a dead branch, an uncalled function or another module does not count, nor ` +
        `does one whose denial cannot reach the action: in an async function or a callback whose promise it neither ` +
        `awaits nor returns, or in a try whose catch does not rethrow (the useActionState shape, ` +
        `\`try { authorize(...); … } catch (e) { return { error } }\`, swallows the denial). Call authorize(...) first, ` +
        `before any try (or in a function in this file that it calls, awaiting it if it is async).`
    )
}

// ---------------------------------------------------------------------------------------------------------
// Policy: exemptions and the gates they rest on.
// ---------------------------------------------------------------------------------------------------------

export interface Exemption {
    reason: string
    /** The gate the reason rests on. Checked on every exempted handler, per verb, in every root. */
    mustMatch: Gate
}

export interface ScanPolicy {
    /** Exemptions by path prefix, relative to a root's `exemptDir`. */
    exemptPrefixes: Readonly<Record<string, Exemption>>
    /** Exemptions by exact path. An exact entry wins over a prefix. */
    exemptFiles: Readonly<Record<string, Exemption>>
    /** Gates a non-exempt handler under a prefix must pass IN ADDITION to reaching `authorize`. */
    requiredAlongside: Readonly<Record<string, Exemption>>
    /** Appended to the "does not reach authorize" failure. */
    hint?: string | undefined
}

export function exemptionFor(policy: ScanPolicy, rel: string): Exemption | undefined {
    const exact = policy.exemptFiles[rel]
    if (exact) return exact
    const prefix = Object.keys(policy.exemptPrefixes).find((p) => rel.startsWith(p))
    return prefix === undefined ? undefined : policy.exemptPrefixes[prefix]
}

function requiredFor(policy: ScanPolicy, rel: string): Exemption | undefined {
    const prefix = Object.keys(policy.requiredAlongside).find((p) => rel.startsWith(p))
    return prefix === undefined ? undefined : policy.requiredAlongside[prefix]
}

export function gateHolds(gate: Gate, facts: HandlerFacts): boolean {
    switch (gate.kind) {
        case 'wrapped-by':
            return facts.wrappedBy !== null && gate.callees.includes(facts.wrappedBy)
        case 'calls':
            return gate.callees.some((callee) => facts.calls.has(callee))
        case 'opens-with-simulated-404':
            return facts.opensWithSimulated404
    }
}

export function describeGate(gate: Gate): string {
    const names = (callees: readonly string[]) => callees.map((c) => `${c}(…)`).join(' or ')
    switch (gate.kind) {
        case 'wrapped-by':
            return `the handler is itself a call to an imported ${names(gate.callees)}, as in \`export const POST = ${gate.callees[0]}(…)\``
        case 'calls':
            return `the handler reaches a call to an imported ${names(gate.callees)} on its own path`
        case 'opens-with-simulated-404':
            return (
                'the handler takes no parameter that runs code (a default) and opens with ' +
                '`if (!isSimulated) return new Response(null, { status: 404 })` (an imported ' +
                '`isSimulated`, and a branch that only returns or throws a response built from inert values: ' +
                '`new Response(…)` or `Response.json(…)` with literal arguments, or `throw new NotFoundError(…)` imported ' +
                "from @sssb/kit/ports/errors. Next's `notFound()` (next/navigation) and an options object held in a " +
                'variable, `new Response(null, NOT_FOUND)`, are refused: the scan cannot see that either runs nothing)'
            )
    }
}

/** Why `handler` fails the scan, or undefined if it passes. */
export function judge(route: ScannedRoute, handler: Handler, policy: ScanPolicy): string | undefined {
    const where = `${route.root}: ${route.rel} ${handler.verb}`
    if (handler.refusal !== undefined) {
        return `${where} cannot be checked: ${handler.refusal}. The scan fails a handler it cannot follow rather than pass it.`
    }
    // An exemption is an alternative to authorize(...), never a ban on it: a handler under an exempted path that
    // does not pass the gate is judged like any other, so one that authorizes passes.
    const exemption = exemptionFor(policy, route.rel)
    if (exemption && gateHolds(exemption.mustMatch, handler.facts)) return undefined
    const required = requiredFor(policy, route.rel)
    if (required && !gateHolds(required.mustMatch, handler.facts)) {
        return `${where} must also satisfy: ${describeGate(required.mustMatch)}. ${required.reason}`
    }
    // A read that calls nothing but globals reads no data, so it has nothing to authorize, wherever it sits.
    const read = isReadVerb(handler.verb)
    if (!handler.facts.reachesAuthorize && read && handler.facts.readsNothing) return undefined
    if (!handler.facts.reachesAuthorize && exemption) {
        return (
            `${where} sits under an exemption that holds only when ${describeGate(exemption.mustMatch)}, and this ` +
            `handler does not: the exemption's justification does not hold here. Add the gate to THIS handler, or call ` +
            `authorize(...). (A string, a comment, a look-alike, or the gate on another verb does not count.)`
        )
    }
    if (!handler.facts.reachesAuthorize && read) {
        return (
            `${where} exports a read handler that does not reach authorize(...) on its own path, and the route is not ` +
            `in the exemption map. A read authorizes as a mutation does, \`authorize(user, orgId, 'read', subject)\`: ` +
            `the session's org says where a person is placed, not that they may read there (the role \`none\` is placed ` +
            `with no standing). A read handler passes without it only when it reads nothing: it names nothing from ` +
            `outside itself but inert globals (Response, Date, URL, JSON), NextResponse, appMode and isSimulated, and ` +
            `literal constants, so no import, helper, fetch or process.env, and works only on its request. ` +
            `The same reachability rules apply as for a mutation: a call in a string, a dead branch, an uncalled ` +
            `function or another module does not count, nor does one whose denial cannot reach the handler. Call ` +
            `authorize(...) in this handler, or, only if it reads nothing org-scoped (a self-only read authorizes its ` +
            `self-only subject instead), add a justified exemption.` +
            (policy.hint ? ` ${policy.hint}` : '')
        )
    }
    if (!handler.facts.reachesAuthorize) {
        return (
            `${where} exports a mutating handler that does not reach authorize(...) on its own path, and the route is ` +
            `not in the exemption map. A call in a string, a comment, another handler, a dead branch, an uncalled ` +
            `function or another module does not count, nor does one whose denial cannot reach the handler: in an ` +
            `async function or a callback whose promise the handler neither awaits nor returns, in a callback handed ` +
            `to a function of this file, or in a try whose catch does not rethrow. Call authorize(...) in this handler ` +
            `(or in a function in this file that it calls, awaiting it if it is async), or, only if it is genuinely ` +
            `not a per-actor product mutation, add a justified exemption.` +
            (policy.hint ? ` ${policy.hint}` : '')
        )
    }
    return undefined
}

// ---------------------------------------------------------------------------------------------------------
// Analysis.
// ---------------------------------------------------------------------------------------------------------

interface Source {
    fileName: string
    sf: ts.SourceFile
    checker: ts.TypeChecker
    /** Symbols the file assigns to (`POST = …`, `check = …`, `x++`): never trusted as a handler or helper. */
    reassigned: ReadonlySet<ts.Symbol>
}

/** What an exported name is bound to. */
type Binding =
    | { kind: 'decl'; src: Source; decl: ts.Declaration }
    | { kind: 'module'; src: Source; specifier: string; name: string }
    | { kind: 'refused'; reason: string }

/** A handler resolved to code: a function Next calls, or a call whose result Next calls. */
type HandlerNode = { src: Source; fn: ts.FunctionLikeDeclaration } | { src: Source; call: ts.CallExpression }

type Refusal = { reason: string }

// Parse and bind one file at a time: no lib, no import resolution. Every question asked of the checker is
// about a binding in the file itself; following an import is this module's job, done explicitly below.
const ANALYSIS_OPTIONS: ts.CompilerOptions = {
    noResolve: true,
    noLib: true,
    types: [],
    allowJs: true,
    jsx: ts.JsxEmit.Preserve,
    target: ts.ScriptTarget.ESNext,
    module: ts.ModuleKind.ESNext,
    noEmit: true,
}

const DEFAULT_RESOLUTION: ts.CompilerOptions = {
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    allowJs: true,
}

class RootScanner {
    private readonly sources = new Map<string, Source | string>()
    private readonly resolution: ts.CompilerOptions
    private readonly authorizeModules: readonly string[]

    constructor(root: ScanRoot, authorizeModules: readonly string[]) {
        this.authorizeModules = authorizeModules
        this.resolution = root.tsconfig ? readCompilerOptions(root.tsconfig) : DEFAULT_RESOLUTION
    }

    handlers(file: string): Handler[] {
        const src = this.load(file)
        if (typeof src === 'string') return [{ verb: '*', refusal: src }]
        return this.judgedExports(src, new Set()).map(([verb, binding]) => {
            const node = this.handlerOf(binding, new Set())
            return 'reason' in node ? { verb, refusal: node.reason } : { verb, facts: this.facts(node) }
        })
    }

    /** Every Server Action `file` declares, with its facts or why it could not be read. */
    actions(file: string): Array<{ name: string; handler: Handler }> {
        const src = this.load(file)
        if (typeof src === 'string') return [{ name: '*', handler: { verb: 'action', refusal: src } }]
        const out: Array<{ name: string; handler: Handler }> = []
        if (hasUseServer(src.sf.statements)) {
            const { named, stars } = exportsOf(src)
            for (const [name, binding] of named) {
                const node = this.handlerOf(binding, new Set())
                out.push({
                    name,
                    handler:
                        'reason' in node
                            ? { verb: 'action', refusal: node.reason }
                            : { verb: 'action', facts: this.facts(node) },
                })
            }
            for (const specifier of stars) {
                const refusal = `\`export * from '${specifier}'\` in a 'use server' file is not followed; export each action by name`
                out.push({ name: '*', handler: { verb: 'action', refusal } })
            }
        }
        const visit = (node: ts.Node): void => {
            if (ts.isFunctionLike(node) && 'body' in node && node.body && ts.isBlock(node.body)) {
                if (hasUseServer(node.body.statements)) {
                    const fn = node as ts.FunctionLikeDeclaration
                    const line = src.sf.getLineAndCharacterOfPosition(fn.getStart(src.sf)).line + 1
                    const label = fn.name && ts.isIdentifier(fn.name) ? fn.name.text : 'inline'
                    out.push({
                        name: `${label} (line ${line})`,
                        handler: { verb: 'action', facts: this.facts({ src, fn }) },
                    })
                }
            }
            ts.forEachChild(node, visit)
        }
        visit(src.sf)
        return out
    }

    private load(fileName: string): Source | string {
        const cached = this.sources.get(fileName)
        if (cached !== undefined) return cached
        const program = ts.createProgram({ rootNames: [fileName], options: ANALYSIS_OPTIONS })
        const sf = program.getSourceFile(fileName)
        let result: Source | string
        if (!sf) result = 'the file could not be read'
        else if (program.getSyntacticDiagnostics(sf).length > 0) {
            const [first] = program.getSyntacticDiagnostics(sf)
            result = `the file does not parse (${ts.flattenDiagnosticMessageText(first?.messageText, ' ')})`
        } else {
            const checker = program.getTypeChecker()
            // `export =` makes TypeScript call the file a module, but it compiles to `module.exports =`, and Next
            // serves the handlers on it: it is CommonJS for this purpose.
            const exportEquals = sf.statements.some((s) => ts.isExportAssignment(s) && s.isExportEquals)
            if (!ts.isExternalModule(sf) || exportEquals || usesCommonJsExports(sf, checker)) {
                result =
                    'the file is not an ES module, or uses `export =`, `module.exports` or `exports`, which the scan ' +
                    'does not read (route modules are ES modules)'
            } else result = { fileName, sf, checker, reassigned: reassignedSymbols(sf, checker) }
        }
        this.sources.set(fileName, result)
        return result
    }

    private resolve(from: Source, specifier: string): Source | string {
        const resolved = ts.resolveModuleName(specifier, from.fileName, this.resolution, ts.sys).resolvedModule
        if (!resolved) return `'${specifier}' does not resolve from ${from.fileName}`
        if (/\.d\.[cm]?ts$/.test(resolved.resolvedFileName)) {
            return `'${specifier}' resolves to a declaration file (${resolved.resolvedFileName}), which has no handler body to read`
        }
        // TypeScript and Next's bundler do not pick the same file from every layout: TypeScript prefers `impl.ts`
        // where the bundler may load `impl.js` beside it, skips `impl.mjs` for an extensionless specifier and reads
        // `impl/index.ts` instead, and follows a package.json's `types` where the bundler follows `main`. With more
        // than one candidate for the one module, the scan cannot know which file is served, so it reads none.
        const candidates = moduleCandidates(resolved.resolvedFileName)
        if (candidates.length > 1) {
            const names = candidates.map((file) => path.relative(path.dirname(from.fileName), file)).join(', ')
            return `'${specifier}' could load any of ${names}, and the scan cannot tell which Next serves`
        }
        const loaded = this.load(resolved.resolvedFileName)
        return typeof loaded === 'string' ? `'${specifier}' (${resolved.resolvedFileName}): ${loaded}` : loaded
    }

    /** `[verb, binding]` for every verb the module exports (`JUDGED_VERBS`), through `export *` as well. */
    private judgedExports(src: Source, seen: Set<string>): Array<[string, Binding]> {
        const { named, stars } = exportsOf(src)
        const out = [...named].filter(([name]) => JUDGED_VERBS.includes(name))
        if (seen.has(src.fileName)) return out
        seen.add(src.fileName)
        for (const specifier of stars) {
            const target = this.resolve(src, specifier)
            if (typeof target === 'string') {
                const reason = `\`export * from '${specifier}'\` cannot be followed (${target}), so which verbs it exports is unknown`
                out.push(['*', { kind: 'refused', reason }])
                continue
            }
            for (const [verb, binding] of this.judgedExports(target, seen)) {
                if (!out.some(([known]) => known === verb)) out.push([verb, binding])
            }
        }
        return out
    }

    /** The binding a module exports under `name`, through `export *` as well. */
    private exportNamed(src: Source, name: string, seen: Set<string>): Binding | undefined {
        const { named, stars } = exportsOf(src)
        const direct = named.get(name)
        if (direct) return direct
        if (seen.has(src.fileName)) return undefined
        seen.add(src.fileName)
        for (const specifier of stars) {
            const target = this.resolve(src, specifier)
            if (typeof target === 'string') return { kind: 'refused', reason: target }
            const found = this.exportNamed(target, name, seen)
            if (found) return found
        }
        return undefined
    }

    private handlerOf(binding: Binding, seen: Set<unknown>): HandlerNode | Refusal {
        if (binding.kind === 'refused') return { reason: binding.reason }
        if (binding.kind === 'module') {
            const target = this.resolve(binding.src, binding.specifier)
            if (typeof target === 'string') return { reason: `the handler is re-exported from ${target}` }
            const key = `${target.fileName}\0${binding.name}`
            if (seen.has(key)) return { reason: `the re-export of \`${binding.name}\` leads back to itself` }
            seen.add(key)
            const next = this.exportNamed(target, binding.name, new Set())
            if (!next) return { reason: `'${binding.specifier}' has no export named \`${binding.name}\`` }
            return this.handlerOf(next, seen)
        }
        const { src, decl } = binding
        if (seen.has(decl)) return { reason: 'the handler is defined in terms of itself' }
        seen.add(decl)
        if (ts.isFunctionDeclaration(decl)) {
            if (!decl.body) return { reason: 'the handler is a declaration with no body' }
            if (isReassigned(src, decl)) {
                return {
                    reason: 'the handler is a function the file reassigns, so the declaration is not what Next calls',
                }
            }
            if (isRedeclared(decl)) {
                return {
                    reason:
                        'the handler is declared more than once in its scope, and the last declaration is the one that ' +
                        'runs; declare it once',
                }
            }
            return { src, fn: decl }
        }
        if (ts.isVariableDeclaration(decl)) {
            if (!isConst(decl)) {
                return {
                    reason:
                        'the handler is a `let` or `var`, which can be reassigned after the binding the scan reads; ' +
                        'declare it `const` or as a function',
                }
            }
            if (!decl.initializer) return { reason: 'the handler has no initializer' }
            return this.handlerFromExpression(src, decl.initializer, seen)
        }
        if (ts.isExportAssignment(decl) && !decl.isExportEquals)
            return this.handlerFromExpression(src, decl.expression, seen)
        return { reason: `the handler is a ${ts.SyntaxKind[decl.kind]}, not a function` }
    }

    private handlerFromExpression(src: Source, expression: ts.Expression, seen: Set<unknown>): HandlerNode | Refusal {
        const e = unwrap(expression)
        if (isFunctionLiteral(e)) return { src, fn: e }
        if (ts.isCallExpression(e)) return { src, call: e }
        if (ts.isIdentifier(e)) {
            const decl = declarationOf(src, e)
            if (!decl) return { reason: `\`${e.text}\` is not declared in this file` }
            return this.handlerOf(bindingOfDeclaration(src, decl), seen)
        }
        return {
            reason:
                `the handler is a ${ts.SyntaxKind[e.kind]}, which the scan cannot follow; export a function, ` +
                'or a call that wraps one',
        }
    }

    private facts(node: HandlerNode): HandlerFacts {
        const reach = new Reach(node.src, this.authorizeModules)
        if ('fn' in node) {
            reach.invoke(node.fn)
            return {
                reachesAuthorize: reach.authorize,
                wrappedBy: null,
                calls: reach.calls,
                opensWithSimulated404: opensWithSimulated404(node.src, node.fn),
                readsNothing: readsNothing(node.src, node.fn),
            }
        }
        reach.wrapped(node.call)
        return {
            reachesAuthorize: reach.authorize,
            wrappedBy: gateName(node.src, node.call.expression) ?? null,
            calls: reach.calls,
            opensWithSimulated404: false,
            // A wrapper is code the scan does not read, run on every request: what it reads is out of sight.
            readsNothing: false,
        }
    }
}

/**
 * Where a failure at one point of the walk goes: whether a throw there, or a rejection of the promise the current
 * function returns, reaches the handler's outcome (what Next awaits). A handler's own body reaches it both ways.
 */
interface Outcome {
    /** A throw here reaches the handler's outcome. In an async function, that is a rejection of its promise. */
    thrown: boolean
    /** A promise the current function returns reaches the handler's outcome, so a rejection of it does. */
    returned: boolean
    /**
     * Code here runs when the handler does (as far as the scan can tell), whether or not its failure reaches the
     * outcome. A gate's call counts where this holds: a `calls` gate says what the route's mutation IS, so what
     * matters is that it runs, not where its failure goes. False in a function never invoked, or run later by
     * something that is not the handler (a same-file callee not followed, a lazy iterator, a timer, a listener, a
     * `.catch` handler).
     */
    runs: boolean
}

const HANDLER_OUTCOME: Outcome = { thrown: true, returned: true, runs: true }
/** Never runs on the handler's path. */
const NEVER: Outcome = { thrown: false, returned: false, runs: false }
/** Runs, but its failure does not reach the handler's outcome (the outcome `outer` carries over its `runs`). */
const dropped = (outer: Outcome): Outcome => ({ thrown: false, returned: false, runs: outer.runs })

/** Walks one handler's path, collecting the calls on it. One instance per handler, never shared. */
class Reach {
    readonly calls = new Set<string>()
    authorize = false
    /** Each function walked, per outcome it was walked under: a cycle stops, a second path that reaches does not. */
    private readonly invoked = new Map<ts.Node, Set<string>>()

    private readonly src: Source
    private readonly authorizeModules: readonly string[]

    constructor(src: Source, authorizeModules: readonly string[]) {
        this.src = src
        this.authorizeModules = authorizeModules
    }

    /** Walks `fn`'s body, where `outcome` says what reaches the handler's outcome from inside it. */
    invoke(fn: ts.FunctionLikeDeclaration, outcome: Outcome = HANDLER_OUTCOME): void {
        const key = `${outcome.thrown}/${outcome.returned}/${outcome.runs}`
        const seen = this.invoked.get(fn) ?? new Set<string>()
        if (seen.has(key)) return
        seen.add(key)
        this.invoked.set(fn, seen)
        // Calling a generator runs none of its body; it only makes an iterator.
        if (fn.asteriskToken) return
        // Parameter defaults are not visited: one runs only when its argument is missing, which for a handler
        // depends on what Next passes, and for a helper on the caller. Not counting them fails closed.
        if (!fn.body) return
        if (ts.isBlock(fn.body)) this.statements(fn.body.statements, outcome)
        else this.visit(fn.body, outcome)
    }

    /**
     * A handler that is a call's result. The call and its non-function arguments ran when the module loaded;
     * per request, only the functions handed to it run (a nested wrapper's, too: `withA(withB(fn))`). The wrapper
     * is what Next calls, and is trusted to carry their failure to Next (see the header). A wrapper declared in
     * this file is not: the scan can read it, but does not follow a function through its parameter, so what it
     * is handed counts for nothing, and so does what a wrapper inside it is handed.
     */
    wrapped(call: ts.CallExpression, outcome: Outcome = HANDLER_OUTCOME): void {
        const own = this.isSameFile(call.expression) ? NEVER : outcome
        for (const argument of call.arguments) {
            const a = unwrap(argument)
            if (isFunctionLiteral(a)) this.invoke(a, own)
            else if (ts.isCallExpression(a)) this.wrapped(a, own)
            else {
                const local = this.localFunction(a)
                if (local) this.invoke(local, own)
            }
        }
    }

    /**
     * A callee whose code is in this file, which the scan could read but does not follow through a parameter, so it
     * is never trusted the way an imported wrapper is. Its head (through `o.run`, `o['run']`, `new C`, `mk()`,
     * `await`, either arm of a ternary, either side of `&&`, `||`, `??` or a comma) is a function, class or object
     * literal, an array literal holding one, or a name declared here as a function or class, as a variable or
     * destructured name whose initializer is any of those, or as anything the file assigns to. A parameter, an
     * import, a global, and a local holding anything else (`const client = await connect()`) are not: their code
     * is out of the scan's sight either way.
     */
    private isSameFile(callee: ts.Expression, seen: Set<ts.Node> = new Set()): boolean {
        let e = unwrap(callee)
        while (ts.isPropertyAccessExpression(e) || ts.isElementAccessExpression(e)) e = unwrap(e.expression)
        if (isFunctionLiteral(e) || ts.isClassExpression(e) || ts.isObjectLiteralExpression(e)) return true
        if (ts.isArrayLiteralExpression(e)) {
            return e.elements.some((element) => !ts.isOmittedExpression(element) && this.isSameFile(element, seen))
        }
        if (ts.isCallExpression(e) || ts.isNewExpression(e) || ts.isAwaitExpression(e) || ts.isSpreadElement(e)) {
            return this.isSameFile(e.expression, seen)
        }
        if (ts.isConditionalExpression(e))
            return this.isSameFile(e.whenTrue, seen) || this.isSameFile(e.whenFalse, seen)
        if (ts.isBinaryExpression(e)) return this.isSameFile(e.left, seen) || this.isSameFile(e.right, seen)
        if (!ts.isIdentifier(e)) return false
        const symbol = this.src.checker.getSymbolAtLocation(e)
        if (symbol !== undefined && this.src.reassigned.has(symbol)) return true
        const decl = declarationOf(this.src, e)
        if (decl === undefined) return false
        if (ts.isFunctionDeclaration(decl) || ts.isClassDeclaration(decl)) return true
        const variable = variableOf(decl)
        if (variable?.initializer === undefined) return false
        // A name defined in terms of itself (`const a = b(); const b = a()`) fails closed.
        if (seen.has(variable)) return true
        seen.add(variable)
        return this.isSameFile(variable.initializer, seen)
    }

    /**
     * Whether a method's receiver is an object whose code is in this file (an object or class literal, a `new` of a
     * same-file class, a class, or a variable or destructured name holding one), so that its `forEach` is its own
     * and not an array's. A call's or an `await`'s result is taken for data, as an array is.
     */
    private isSameFileObject(receiver: ts.Expression, seen: Set<ts.Node> = new Set()): boolean {
        let e = unwrap(receiver)
        while (ts.isPropertyAccessExpression(e) || ts.isElementAccessExpression(e)) e = unwrap(e.expression)
        if (ts.isObjectLiteralExpression(e) || ts.isClassExpression(e)) return true
        if (ts.isNewExpression(e)) return this.isSameFile(e.expression)
        if (ts.isConditionalExpression(e)) {
            return this.isSameFileObject(e.whenTrue, seen) || this.isSameFileObject(e.whenFalse, seen)
        }
        if (ts.isBinaryExpression(e)) return this.isSameFileObject(e.left, seen) || this.isSameFileObject(e.right, seen)
        if (!ts.isIdentifier(e)) return false
        const decl = declarationOf(this.src, e)
        if (decl === undefined) return false
        if (ts.isClassDeclaration(decl)) return true
        const variable = variableOf(decl)
        if (variable?.initializer === undefined || seen.has(variable)) return false
        seen.add(variable)
        return this.isSameFileObject(variable.initializer, seen)
    }

    /**
     * `xs.forEach`, `xs['map']` and the like, by name, whatever the receiver: an array iteration method, unless the
     * receiver is an object whose code is in this file, whose `forEach` is its own (and, being same-file, is not
     * followed through its parameter at all). `imported` is a receiver whose head is an import (`parse(req).ids`,
     * `R`), where the same name may be a library's, deferred or lazy: an async callback is dropped either way, and a
     * sync one is trusted only as far as an imported callee is. `lazy` is a `map`, `filter` or `flatMap` on a
     * receiver that is visibly an iterator (`xs.values()`, `.keys()`, `.entries()`, `Iterator.from(…)`), which runs
     * nothing until something consumes it. `Array.from(xs, fn)` maps like an eager method.
     */
    private iterationMethod(callee: ts.Expression): { name: string; lazy: boolean; imported: boolean } | undefined {
        if (isGlobalMember(this.src, callee, 'Array', 'from')) return { name: 'from', lazy: false, imported: false }
        const name = memberName(callee)
        if (name === undefined || !ARRAY_ITERATION.has(name)) return undefined
        const receiver = unwrap((callee as ts.PropertyAccessExpression | ts.ElementAccessExpression).expression)
        let head = receiver
        for (;;) {
            if (ts.isPropertyAccessExpression(head) || ts.isElementAccessExpression(head))
                head = unwrap(head.expression)
            else if (ts.isCallExpression(head)) head = unwrap(head.expression)
            else break
        }
        const imported = ts.isIdentifier(head) && valueImportOf(declarationOf(this.src, head)) !== undefined
        if (this.isSameFileObject(receiver)) return undefined
        return { name, lazy: !EAGER_ITERATION.has(name) && isIterator(this.src, receiver), imported }
    }

    private visit(node: ts.Node, outcome: Outcome): void {
        // A function or class body runs only when called; a type never runs.
        if (ts.isFunctionLike(node) || ts.isClassLike(node) || ts.isTypeNode(node)) return
        if (ts.isCallExpression(node) || ts.isNewExpression(node)) return this.call(node, outcome)
        // The initializer runs; a default inside a destructuring pattern runs only when the value is missing.
        if (ts.isVariableDeclaration(node)) return node.initializer && this.visit(node.initializer, outcome)
        // A condition always runs; only the branch it rules out is dead.
        if (ts.isConditionalExpression(node)) {
            const condition = constantTruth(this.src, node.condition)
            this.visit(node.condition, outcome)
            if (condition !== false) this.visit(node.whenTrue, outcome)
            if (condition !== true) this.visit(node.whenFalse, outcome)
            return
        }
        if (ts.isBinaryExpression(node) && isShortCircuit(node.operatorToken.kind)) {
            this.visit(node.left, outcome)
            if (!rightIsDead(this.src, node)) this.visit(node.right, outcome)
            return
        }
        ts.forEachChild(node, (child) => this.visit(child, outcome))
    }

    private call(node: ts.CallExpression | ts.NewExpression, outcome: Outcome): void {
        // `hook?.(…)`, `x?.y(…)` on a receiver a constant makes null or undefined: the chain stops there, and neither
        // the call nor its arguments run.
        if (shortCircuitsOnConstant(this.src, node)) return
        const callee = unwrap(node.expression)
        // A gate's call counts wherever it RUNS on the handler's path, whatever a `try` around it does with its
        // failure; one in a function that never runs (a same-file no-op, a lazy iterator, a timer, a `.catch`
        // handler) does not.
        const name = gateName(this.src, callee)
        if (name && outcome.runs) this.calls.add(name)
        // `authorize` throws synchronously, so its denial reaches the outcome wherever a throw here does.
        if (outcome.thrown && this.isAuthorize(callee)) this.authorize = true
        // The promise this call returns reaches the outcome only when it is awaited or returned on the spot.
        const settled = settledBy(node)
        const result = settled === 'await' ? outcome.thrown : settled === 'return' ? outcome.returned : false
        // A function handed to an imported callee may run synchronously inside it (a tracing span, an
        // AsyncLocalStorage.run), so its denial may come out as a throw from the call rather than as a rejection of
        // what the call returns. A returned call carries it only where a throw at the call also reaches the outcome:
        // not inside a `try` whose `catch` swallows, where `return wrap(() => authorize(…))` passed before.
        // An async function literal cannot throw synchronously out of the call (its denial rejects its promise), so the
        // condition applies only to a sync one.
        const handedResult = (fn: ts.FunctionLikeDeclaration): boolean =>
            settled === 'return' && !isAsync(fn) ? result && outcome.thrown : result
        // Called directly, a sync function throws into this point; an async one only rejects its promise.
        const direct = (fn: ts.FunctionLikeDeclaration): Outcome =>
            isAsync(fn)
                ? { thrown: result, returned: result, runs: outcome.runs }
                : { thrown: outcome.thrown, returned: result, runs: outcome.runs }
        if (isFunctionLiteral(callee)) this.invoke(callee, direct(callee))
        else {
            this.visit(callee, outcome)
            const local = this.localFunction(callee)
            if (local) this.invoke(local, direct(local))
        }
        // A function handed to a call is assumed to be invoked, and its failure to come out of the call's own result:
        // the callee is not read, and may run it now or later (`.then`, a timer, an async wrapper). Two exceptions.
        // An array's iteration method drops an async function's promise, awaited or not, and runs a sync one in
        // place, so it throws through the call; a lazy one on an iterator runs nothing. A callee whose code is in
        // this file is not followed through its parameter, so what it is handed counts for nothing.
        const method = this.iterationMethod(callee)
        const allOf = method?.name === 'map' && !method.lazy ? promiseAllOf(this.src, node) : undefined
        const handed = (fn: ts.FunctionLikeDeclaration, index: number): Outcome => {
            if (method !== undefined) {
                // Only the callback is called: argument 0 (Array.from's mapper is argument 1). Another function
                // argument is a `thisArg`, which is never invoked.
                if (index !== (method.name === 'from' ? 1 : 0)) return NEVER
                if (method.lazy) return NEVER
                // `await Promise.all(xs.map(cb))`: the array map returns is what Promise.all settles, and it rejects
                // with the first rejection, so what each callback RETURNS reaches the Promise.all call's own result:
                // an async callback's promise, or the promise a sync one returns (`xs.map((x) => db.withTenant(…))`).
                // A sync callback's throw still goes up through map. Only Promise.all: allSettled never rejects, and
                // any and race settle on another promise's outcome.
                if (allOf !== undefined) {
                    const settledAll = settledBy(allOf)
                    const reaches =
                        settledAll === 'await' ? outcome.thrown : settledAll === 'return' && outcome.returned
                    if (isAsync(fn)) return { thrown: reaches, returned: reaches, runs: outcome.runs }
                    return { thrown: outcome.thrown, returned: reaches, runs: outcome.runs }
                }
                if (isAsync(fn)) return dropped(outcome)
                // A sync callback runs in place on an array. On a receiver whose head is an import, the same name may
                // be a library's (a curried `R.forEach`, a query builder's `map`) that runs it later or not at all,
                // so it is trusted no further than any imported callee: only when the call's result is settled.
                if (method.imported && !handedResult(fn)) return dropped(outcome)
                return { thrown: outcome.thrown, returned: false, runs: outcome.runs }
            }
            // `.then(onFulfilled, onRejected)`: the second runs only on a rejection, as a `.catch` handler does.
            if (index === 1 && memberName(callee) === 'then') return NEVER
            if (this.isSameFile(callee) || neverCarriesFailure(this.src, callee)) return NEVER
            return handedResult(fn) ? { ...HANDLER_OUTCOME, runs: outcome.runs } : dropped(outcome)
        }
        node.arguments?.forEach((argument, index) => {
            const a = unwrap(argument)
            if (isFunctionLiteral(a)) this.invoke(a, handed(a, index))
            else {
                this.visit(a, outcome)
                const local = this.localFunction(a)
                if (local) this.invoke(local, handed(local, index))
            }
        })
    }

    private localFunction(e: ts.Expression): ts.FunctionLikeDeclaration | undefined {
        if (!ts.isIdentifier(e)) return undefined
        const decl = declarationOf(this.src, e)
        if (!decl) return undefined
        if (ts.isFunctionDeclaration(decl)) {
            return decl.body && !isReassigned(this.src, decl) && !isRedeclared(decl) ? decl : undefined
        }
        if (ts.isVariableDeclaration(decl) && isConst(decl) && decl.initializer) {
            const init = unwrap(decl.initializer)
            if (isFunctionLiteral(init)) return init
        }
        return undefined
    }

    private isAuthorize(callee: ts.Expression): boolean {
        if (ts.isIdentifier(callee)) {
            const imported = valueImportOf(declarationOf(this.src, callee))
            return (
                imported?.kind === 'named' &&
                imported.name === 'authorize' &&
                this.authorizeModules.includes(imported.module)
            )
        }
        if (
            ts.isPropertyAccessExpression(callee) &&
            callee.name.text === 'authorize' &&
            ts.isIdentifier(callee.expression)
        ) {
            const imported = valueImportOf(declarationOf(this.src, callee.expression))
            return imported?.kind === 'namespace' && this.authorizeModules.includes(imported.module)
        }
        return false
    }

    private statements(list: readonly ts.Statement[], outcome: Outcome): void {
        for (const statement of list) {
            this.statement(statement, outcome)
            if (alwaysExits(this.src, statement)) return
        }
    }

    private statement(s: ts.Statement, outcome: Outcome): void {
        if (ts.isExpressionStatement(s)) this.visit(s.expression, outcome)
        else if (ts.isVariableStatement(s)) this.visit(s.declarationList, outcome)
        else if (ts.isReturnStatement(s) || ts.isThrowStatement(s)) {
            if (s.expression) this.visit(s.expression, outcome)
        } else if (ts.isIfStatement(s)) {
            const condition = constantTruth(this.src, s.expression)
            this.visit(s.expression, outcome)
            if (condition !== false) this.statement(s.thenStatement, outcome)
            if (condition !== true && s.elseStatement) this.statement(s.elseStatement, outcome)
        } else if (ts.isBlock(s)) this.statements(s.statements, outcome)
        else if (ts.isTryStatement(s)) {
            // A throw in the `try` goes on only if the `catch` rethrows on every path: it neither falls through, nor
            // returns, nor jumps out of itself (`break`, `continue`). A throw in either, or a promise either returns,
            // goes on only if the `finally` has no way to leave in its place. A promise the `try` returns (`return p`,
            // not `return await p`, which throws inside it) is not caught by the `catch`.
            const finallyMayLeave = s.finallyBlock !== undefined && leavesBlock(s.finallyBlock, true)
            const catchSwallows =
                s.catchClause !== undefined &&
                (!alwaysExits(this.src, s.catchClause.block) || leavesBlock(s.catchClause.block, true))
            const thrown = outcome.thrown && !finallyMayLeave
            const returned = outcome.returned && !finallyMayLeave
            const runs = outcome.runs
            this.statements(s.tryBlock.statements, { thrown: thrown && !catchSwallows, returned, runs })
            if (s.catchClause) this.statements(s.catchClause.block.statements, { thrown, returned, runs })
            if (s.finallyBlock) this.statements(s.finallyBlock.statements, outcome)
        } else if (ts.isWhileStatement(s)) {
            const condition = constantTruth(this.src, s.expression)
            this.visit(s.expression, outcome)
            if (condition !== false) this.statement(s.statement, outcome)
        } else if (ts.isDoStatement(s)) {
            this.statement(s.statement, outcome)
            // The condition runs only when the body falls through or continues; a body that always returns
            // never reaches it.
            if (reachesLoopEnd(this.src, s)) this.visit(s.expression, outcome)
        } else if (ts.isForStatement(s)) {
            if (s.initializer) this.visit(s.initializer, outcome)
            const condition = s.condition ? constantTruth(this.src, s.condition) : true
            if (s.condition) this.visit(s.condition, outcome)
            if (condition !== false) {
                this.statement(s.statement, outcome)
                if (s.incrementor && reachesLoopEnd(this.src, s)) this.visit(s.incrementor, outcome)
            }
        } else if (ts.isForOfStatement(s) || ts.isForInStatement(s)) {
            this.visit(s.expression, outcome)
            this.statement(s.statement, outcome)
        } else if (ts.isSwitchStatement(s)) {
            this.visit(s.expression, outcome)
            for (const clause of s.caseBlock.clauses) {
                if (ts.isCaseClause(clause)) this.visit(clause.expression, outcome)
                this.statements(clause.statements, outcome)
            }
        } else if (ts.isLabeledStatement(s)) this.statement(s.statement, outcome)
        // Anything else (a function or class declaration, an import, an enum) runs nothing on this path that
        // the scan credits: fail closed.
    }
}

function isAsync(fn: ts.FunctionLikeDeclaration): boolean {
    return hasModifier(fn, ts.SyntaxKind.AsyncKeyword)
}

/** Iteration methods that call their function argument before they return, on an array, and on an iterator that has them. */
const EAGER_ITERATION: ReadonlySet<string> = new Set([
    'every',
    'find',
    'findIndex',
    'findLast',
    'findLastIndex',
    'forEach',
    'reduce',
    'reduceRight',
    'some',
    // A comparator: called in place, and an async one's promise is read as a number (NaN), never awaited.
    'sort',
    'toSorted',
])

/** Every array iteration method: on an array all run in place; on an iterator `filter`, `flatMap`, `map` are lazy. */
const ARRAY_ITERATION: ReadonlySet<string> = new Set([...EAGER_ITERATION, 'filter', 'flatMap', 'map'])

/** A receiver that is visibly an iterator: `xs.values()`, `xs.keys()`, `xs.entries()` or `Iterator.from(…)`. */
function isIterator(src: Source, receiver: ts.Expression): boolean {
    const e = unwrap(receiver)
    if (!ts.isCallExpression(e) || !ts.isPropertyAccessExpression(e.expression)) return false
    const name = e.expression.name.text
    const target = unwrap(e.expression.expression)
    // `Object.entries(m)` and its siblings return arrays, not iterators.
    if (ts.isIdentifier(target) && target.text === 'Object' && declarationOf(src, target) === undefined) return false
    if (name === 'values' || name === 'keys' || name === 'entries') return true
    return name === 'from' && ts.isIdentifier(target) && target.text === 'Iterator'
}

/** The member a callee names, `x.name` or `x['name']`; undefined for any other callee. */
function memberName(callee: ts.Expression): string | undefined {
    if (ts.isPropertyAccessExpression(callee)) return callee.name.text
    if (ts.isElementAccessExpression(callee) && ts.isStringLiteralLike(callee.argumentExpression)) {
        return callee.argumentExpression.text
    }
    return undefined
}

/** `Global.member` (or `Global['member']`), where `Global` is not declared or imported in this file. */
function isGlobalMember(src: Source, callee: ts.Expression, global: string, member: string): boolean {
    if (memberName(callee) !== member) return false
    const target = unwrap((callee as ts.PropertyAccessExpression | ts.ElementAccessExpression).expression)
    return ts.isIdentifier(target) && target.text === global && declarationOf(src, target) === undefined
}

/** Globals that take a function and never hand its failure back: they run it later, or not at all. */
const DETACHING_GLOBALS: ReadonlySet<string> = new Set([
    'queueMicrotask',
    'requestAnimationFrame',
    'requestIdleCallback',
    'setImmediate',
    'setInterval',
    'setTimeout',
])

/**
 * Methods, by name on any receiver, whose function argument's failure never comes out of the call's result: a
 * `.catch` handler runs only if the promise rejects, a `.finally` one after it has settled, and a listener when
 * an event fires.
 */
const DETACHING_METHODS: ReadonlySet<string> = new Set([
    'addEventListener',
    'addListener',
    'catch',
    'finally',
    'on',
    'once',
    'prependListener',
    'prependOnceListener',
])

/**
 * A callee known not to carry the failure of a function handed to it out of its own result, awaited or not: a
 * timer or microtask (`setTimeout`, `queueMicrotask`, `process.nextTick`), `Promise.resolve`, which never calls a
 * function it is given, or a `.catch`, `.finally` or listener method (DETACHING_METHODS). Every other callee that
 * is neither same-file nor an iteration method is trusted when its result is settled (see the header).
 */
function neverCarriesFailure(src: Source, callee: ts.Expression): boolean {
    if (ts.isIdentifier(callee)) {
        const decl = declarationOf(src, callee)
        if (decl === undefined) return DETACHING_GLOBALS.has(callee.text)
        const imported = valueImportOf(decl)
        if (imported?.kind !== 'named') return false
        // Next's `after` runs its callback once the response has been sent; Node's timers module exports the timers.
        if (imported.module === 'next/server') return imported.name === 'after' || imported.name === 'unstable_after'
        return TIMER_MODULES.has(imported.module) && DETACHING_GLOBALS.has(imported.name)
    }
    const name = memberName(callee)
    if (name !== undefined && DETACHING_METHODS.has(name)) return true
    // `globalThis.setTimeout`, `self.queueMicrotask`, `window.setTimeout`, and `timers.setTimeout` through a namespace
    // import of Node's timers module.
    if (name !== undefined && DETACHING_GLOBALS.has(name)) {
        const target = unwrap((callee as ts.PropertyAccessExpression | ts.ElementAccessExpression).expression)
        if (ts.isIdentifier(target)) {
            const decl = declarationOf(src, target)
            if (decl === undefined) return GLOBAL_OBJECTS.has(target.text)
            const imported = valueImportOf(decl)
            if (imported?.kind === 'namespace' && TIMER_MODULES.has(imported.module)) return true
        }
    }
    return isGlobalMember(src, callee, 'process', 'nextTick') || isGlobalMember(src, callee, 'Promise', 'resolve')
}

/** Node's modules that export the timer functions under their global names. */
const TIMER_MODULES: ReadonlySet<string> = new Set(['timers', 'node:timers'])

/** The names the global object goes by. */
const GLOBAL_OBJECTS: ReadonlySet<string> = new Set(['globalThis', 'self', 'window'])

/**
 * The `Promise.all(…)` call `node` is the first argument of (through parentheses and type assertions), when
 * `Promise` is the global; undefined otherwise.
 */
function promiseAllOf(src: Source, node: ts.CallExpression | ts.NewExpression): ts.CallExpression | undefined {
    let child: ts.Node = node
    let parent: ts.Node = node.parent
    while (
        ts.isParenthesizedExpression(parent) ||
        ts.isAsExpression(parent) ||
        ts.isSatisfiesExpression(parent) ||
        ts.isNonNullExpression(parent) ||
        ts.isTypeAssertionExpression(parent)
    ) {
        child = parent
        parent = parent.parent
    }
    if (!ts.isCallExpression(parent) || parent.arguments[0] !== child) return undefined
    return isGlobalMember(src, unwrap(parent.expression), 'Promise', 'all') ? parent : undefined
}

/** The variable declaration a declared name belongs to, through destructuring; undefined for a parameter. */
function variableOf(decl: ts.Declaration): ts.VariableDeclaration | undefined {
    let node: ts.Node = decl
    while (ts.isBindingElement(node) || ts.isObjectBindingPattern(node) || ts.isArrayBindingPattern(node)) {
        node = node.parent
    }
    return ts.isVariableDeclaration(node) ? node : undefined
}

/**
 * Whether `block` has a way out of itself other than falling off its end or throwing: a `break` or `continue` whose
 * target is outside it, and with `returns`, a `return`. Nested functions are not looked into.
 */
function leavesBlock(block: ts.Block, returns: boolean): boolean {
    let found = false
    const walk = (node: ts.Node, labels: readonly string[], loops: number, switches: number): void => {
        if (found || ts.isFunctionLike(node) || ts.isClassLike(node)) return
        if (ts.isReturnStatement(node)) {
            if (returns) found = true
        } else if (ts.isBreakStatement(node) || ts.isContinueStatement(node)) {
            if (node.label) found = !labels.includes(node.label.text)
            else found = ts.isBreakStatement(node) ? loops + switches === 0 : loops === 0
            if (found) return
        }
        const inner = ts.isLabeledStatement(node) ? [...labels, node.label.text] : labels
        const loop = ts.isIterationStatement(node, false) ? 1 : 0
        const swtch = ts.isSwitchStatement(node) ? 1 : 0
        ts.forEachChild(node, (child) => walk(child, inner, loops + loop, switches + swtch))
    }
    walk(block, [], 0, 0)
    return found
}

/**
 * What happens to the value of `call` on the spot: it is `await`ed, or returned from the function it sits in (by
 * `return`, or as an arrow's expression body). On the way it may pass through parentheses, a type assertion
 * (`as`, `satisfies`, `!`, `<T>`), a ternary's arm, the right of `&&`, `||`, `??` or a comma, or the left of `||` or
 * `??` (a promise is truthy and never nullish, so it is their value), which hand it on. Anything else (a statement
 * of its own, `void`, a variable, an argument, a `.then`) leaves its promise floating, as far as the scan can see.
 */
function settledBy(call: ts.Expression): 'await' | 'return' | undefined {
    let node: ts.Node = call
    for (;;) {
        const parent: ts.Node = node.parent
        const operator = ts.isBinaryExpression(parent) ? parent.operatorToken.kind : undefined
        if (
            ts.isParenthesizedExpression(parent) ||
            ts.isAsExpression(parent) ||
            ts.isSatisfiesExpression(parent) ||
            ts.isNonNullExpression(parent) ||
            ts.isTypeAssertionExpression(parent) ||
            (ts.isConditionalExpression(parent) && parent.condition !== node) ||
            (ts.isBinaryExpression(parent) &&
                parent.right === node &&
                operator !== undefined &&
                (isShortCircuit(operator) || operator === ts.SyntaxKind.CommaToken)) ||
            (ts.isBinaryExpression(parent) &&
                parent.left === node &&
                (operator === ts.SyntaxKind.BarBarToken || operator === ts.SyntaxKind.QuestionQuestionToken))
        ) {
            node = parent
            continue
        }
        if (ts.isAwaitExpression(parent)) return 'await'
        if (ts.isReturnStatement(parent)) return 'return'
        if (ts.isArrowFunction(parent) && parent.body === node) return 'return'
        return undefined
    }
}

// ---------------------------------------------------------------------------------------------------------
// Helpers over the syntax tree.
// ---------------------------------------------------------------------------------------------------------

function exportsOf(src: Source): { named: Map<string, Binding>; stars: string[] } {
    const named = new Map<string, Binding>()
    const stars: string[] = []
    for (const statement of src.sf.statements) {
        if (ts.isExportDeclaration(statement)) {
            if (statement.isTypeOnly) continue
            const specifier =
                statement.moduleSpecifier && ts.isStringLiteral(statement.moduleSpecifier)
                    ? statement.moduleSpecifier.text
                    : undefined
            const clause = statement.exportClause
            if (!clause) {
                if (specifier !== undefined) stars.push(specifier)
            } else if (ts.isNamespaceExport(clause)) {
                named.set(exportNameText(clause.name), {
                    kind: 'refused',
                    reason: 'a namespace re-export (`export * as …`) is not a handler',
                })
            } else {
                for (const element of clause.elements) {
                    if (element.isTypeOnly) continue
                    const exported = exportNameText(element.name)
                    if (specifier !== undefined) {
                        named.set(exported, {
                            kind: 'module',
                            src,
                            specifier,
                            name: exportNameText(element.propertyName ?? element.name),
                        })
                    } else {
                        const decl = preferBody(src.checker.getExportSpecifierLocalTargetSymbol(element)?.declarations)
                        named.set(
                            exported,
                            decl
                                ? bindingOfDeclaration(src, decl)
                                : { kind: 'refused', reason: `\`${exported}\` is not declared in this file` },
                        )
                    }
                }
            }
            continue
        }
        if (ts.isExportAssignment(statement)) {
            // `export default <expression>`. (`export =` is CommonJS: the file was refused when it loaded.)
            if (!statement.isExportEquals) named.set('default', { kind: 'decl', src, decl: statement })
            continue
        }
        if (!hasModifier(statement, ts.SyntaxKind.ExportKeyword)) continue
        const isDefault = hasModifier(statement, ts.SyntaxKind.DefaultKeyword)
        if (ts.isFunctionDeclaration(statement) && (statement.name || isDefault)) {
            const name = isDefault ? 'default' : statement.name!.text
            // An overload signature has no body; the implementation is the handler.
            if (statement.body || !named.has(name)) named.set(name, { kind: 'decl', src, decl: statement })
        } else if (isDefault) {
            if (ts.isClassDeclaration(statement)) named.set('default', { kind: 'decl', src, decl: statement })
        } else if (ts.isVariableStatement(statement)) {
            for (const decl of statement.declarationList.declarations) {
                if (ts.isIdentifier(decl.name)) named.set(decl.name.text, { kind: 'decl', src, decl })
                else {
                    for (const name of boundNames(decl.name)) {
                        named.set(name, {
                            kind: 'refused',
                            reason: `\`${name}\` is destructured out of another value, which the scan cannot follow`,
                        })
                    }
                }
            }
        } else if (ts.isImportEqualsDeclaration(statement)) {
            named.set(statement.name.text, { kind: 'refused', reason: '`export import … =` is not followed' })
        } else if (
            (ts.isClassDeclaration(statement) ||
                ts.isEnumDeclaration(statement) ||
                ts.isModuleDeclaration(statement)) &&
            statement.name &&
            ts.isIdentifier(statement.name)
        ) {
            named.set(statement.name.text, { kind: 'decl', src, decl: statement })
        }
    }
    return { named, stars }
}

function bindingOfDeclaration(src: Source, decl: ts.Declaration): Binding {
    if (ts.isImportSpecifier(decl) || ts.isImportClause(decl) || ts.isNamespaceImport(decl)) {
        const imported = valueImportOf(decl)
        if (!imported) return { kind: 'refused', reason: 'the handler is a type-only import' }
        if (imported.kind === 'namespace') return { kind: 'refused', reason: 'a namespace import is not a handler' }
        return { kind: 'module', src, specifier: imported.module, name: imported.name }
    }
    return { kind: 'decl', src, decl }
}

type ValueImport = { kind: 'named'; module: string; name: string } | { kind: 'namespace'; module: string }

/**
 * What a declaration imports, when it is a VALUE import of an `import` statement: not `import type`, not
 * `import { type x }`, not a JSDoc `@import` (whose parent chain is a comment's, not an import's).
 */
function valueImportOf(decl: ts.Declaration | undefined): ValueImport | undefined {
    if (!decl) return undefined
    let clause: ts.ImportClause
    if (ts.isImportSpecifier(decl)) {
        if (decl.isTypeOnly) return undefined
        clause = decl.parent.parent
    } else if (ts.isNamespaceImport(decl)) clause = decl.parent
    else if (ts.isImportClause(decl)) clause = decl
    else return undefined
    const statement = clause.parent
    if (clause.isTypeOnly || !ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) {
        return undefined
    }
    const from = statement.moduleSpecifier.text
    if (ts.isImportSpecifier(decl)) {
        return { kind: 'named', module: from, name: exportNameText(decl.propertyName ?? decl.name) }
    }
    if (ts.isNamespaceImport(decl)) return { kind: 'namespace', module: from }
    return { kind: 'named', module: from, name: 'default' }
}

/**
 * The dotted name a gate is matched against (`auth.updateProfile`), or undefined when the name's head is not a
 * value import that keeps the name it is exported under. A named import counts under its exported name only, so
 * `import { identity as withWebhookSecret }` is not the guard. A namespace import's head is dropped, so
 * `respond.withWebhookSecret` reads as `withWebhookSecret`. A default import has no exported name to check and
 * counts under its local one.
 *
 * WHICH module exports the name is not checked: an app may re-export SSSB's `isSimulated` from its own module, and
 * the wrappers are the app's. So a module that exports a fake under the real name passes. The scan catches a
 * route that lost its gate; it does not stand against one written to fool it (ADR-0012).
 */
function gateName(src: Source, callee: ts.Expression): string | undefined {
    const members: string[] = []
    let head = unwrap(callee)
    while (ts.isPropertyAccessExpression(head)) {
        if (!ts.isIdentifier(head.name)) return undefined
        members.unshift(head.name.text)
        head = unwrap(head.expression)
    }
    if (!ts.isIdentifier(head)) return undefined
    const imported = valueImportOf(declarationOf(src, head))
    if (!imported) return undefined
    if (imported.kind === 'namespace') return members.length > 0 ? members.join('.') : undefined
    if (imported.name !== 'default' && imported.name !== head.text) return undefined
    return [head.text, ...members].join('.')
}

function boundNames(pattern: ts.BindingName): string[] {
    if (ts.isIdentifier(pattern)) return [pattern.text]
    return pattern.elements.flatMap((element) => (ts.isOmittedExpression(element) ? [] : boundNames(element.name)))
}

function exportNameText(name: ts.ModuleExportName): string {
    return name.text
}

function hasModifier(node: ts.Node, kind: ts.SyntaxKind): boolean {
    return ts.canHaveModifiers(node) && (ts.getModifiers(node) ?? []).some((m) => m.kind === kind)
}

/** An overloaded function has a declaration per signature; the one with a body is the function. */
function preferBody(declarations: readonly ts.Declaration[] | undefined): ts.Declaration | undefined {
    return declarations?.find((d) => ts.isFunctionDeclaration(d) && d.body !== undefined) ?? declarations?.[0]
}

function declarationOf(src: Source, id: ts.Identifier): ts.Declaration | undefined {
    return preferBody(src.checker.getSymbolAtLocation(id)?.declarations)
}

function isConst(decl: ts.VariableDeclaration): boolean {
    return (ts.getCombinedNodeFlags(decl) & ts.NodeFlags.Const) !== 0
}

/**
 * A function declared twice in one scope, or also declared as a `var` (`function check() {…} function check() {}`,
 * `var check = …`): TypeScript rejects both, but nothing typechecks a route.js, and at run time the LAST one is what
 * the name holds. An overload signature has no body and is not a second declaration.
 */
function isRedeclared(decl: ts.FunctionDeclaration): boolean {
    // Read from the syntax, not the binder: in a JS file the binder gives `function check` and `var check` separate
    // symbols, and an exported function its own export symbol, so neither shows as a second declaration there.
    // The scope is the block that holds the declaration: a module is strict code, where a function declared in a
    // block belongs to that block. A `var` anywhere inside it (outside nested functions) hoists past it and is the
    // same name.
    const name = decl.name?.text
    if (name === undefined) return false
    const scope: ts.Node = decl.parent
    let count = 0
    const walk = (node: ts.Node): void => {
        if (node !== scope && (ts.isFunctionLike(node) || ts.isClassLike(node))) {
            // A nested function's NAME belongs to this scope; nothing inside it does.
            if (ts.isFunctionDeclaration(node) && node.body !== undefined && node.name?.text === name) count++
            return
        }
        if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === name) count++
        ts.forEachChild(node, walk)
    }
    walk(scope)
    return count > 1
}

function isReassigned(src: Source, decl: ts.FunctionDeclaration): boolean {
    const symbol = decl.name ? src.checker.getSymbolAtLocation(decl.name) : undefined
    return symbol !== undefined && src.reassigned.has(symbol)
}

/**
 * Every symbol the file writes to by name: an assignment or compound assignment, including each name in a
 * destructuring target (`[POST] = …`, `({ open: POST } = …)`), a `for (x of …)`/`for (x in …)` target, and `++`/`--`.
 */
function reassignedSymbols(sf: ts.SourceFile, checker: ts.TypeChecker): Set<ts.Symbol> {
    const out = new Set<ts.Symbol>()
    const mark = (target: ts.Expression): void => {
        const e = unwrap(target)
        if (ts.isIdentifier(e)) {
            const symbol = checker.getSymbolAtLocation(e)
            if (symbol) out.add(symbol)
        } else if (ts.isArrayLiteralExpression(e)) {
            for (const element of e.elements) mark(ts.isSpreadElement(element) ? element.expression : element)
        } else if (ts.isObjectLiteralExpression(e)) {
            for (const property of e.properties) {
                if (ts.isPropertyAssignment(property)) mark(property.initializer)
                else if (ts.isShorthandPropertyAssignment(property)) {
                    // The name's own symbol is the object property; the variable written is this one.
                    const symbol = checker.getShorthandAssignmentValueSymbol(property)
                    if (symbol) out.add(symbol)
                } else if (ts.isSpreadAssignment(property)) mark(property.expression)
            }
        }
        // A default inside a target (`[POST = x] = …`) is an assignment expression itself; the walk marks it.
    }
    const walk = (node: ts.Node): void => {
        if (
            ts.isBinaryExpression(node) &&
            node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
            node.operatorToken.kind <= ts.SyntaxKind.LastAssignment
        ) {
            mark(node.left)
        } else if (
            (ts.isForOfStatement(node) || ts.isForInStatement(node)) &&
            !ts.isVariableDeclarationList(node.initializer)
        ) {
            mark(node.initializer)
        } else if (
            (ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) &&
            (node.operator === ts.SyntaxKind.PlusPlusToken || node.operator === ts.SyntaxKind.MinusMinusToken)
        ) {
            mark(node.operand)
        }
        ts.forEachChild(node, walk)
    }
    walk(sf)
    return out
}

function isFunctionLiteral(node: ts.Node): node is ts.ArrowFunction | ts.FunctionExpression {
    return ts.isArrowFunction(node) || ts.isFunctionExpression(node)
}

/** Strips parentheses and type-only wrappers (`as`, `satisfies`, `!`, `<T>x`). */
function unwrap(e: ts.Expression): ts.Expression {
    while (
        ts.isParenthesizedExpression(e) ||
        ts.isAsExpression(e) ||
        ts.isSatisfiesExpression(e) ||
        ts.isNonNullExpression(e) ||
        ts.isTypeAssertionExpression(e)
    ) {
        e = e.expression
    }
    return e
}

/** `auth.updateProfile` for that callee; undefined for anything that is not a plain dotted name. */
function dottedName(e: ts.Expression): string | undefined {
    const node = unwrap(e)
    if (ts.isIdentifier(node)) return node.text
    if (ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.name)) {
        const head = dottedName(node.expression)
        return head === undefined ? undefined : `${head}.${node.name.text}`
    }
    return undefined
}

/** The `const` initializer an identifier is bound to, followed a few names deep; undefined if it is not one. */
function constInitializer(src: Source, e: ts.Expression, depth: number): ts.Expression | undefined {
    if (!ts.isIdentifier(e) || depth >= 4) return undefined
    const decl = declarationOf(src, e)
    if (decl && ts.isVariableDeclaration(decl) && isConst(decl) && decl.initializer && ts.isIdentifier(decl.name)) {
        return decl.initializer
    }
    return undefined
}

/**
 * The truthiness of a condition the scan can decide without running anything, or undefined. Literals,
 * `!`, `void`, and a `const` bound to one of those (to a depth of a few names); nothing else.
 */
function constantTruth(src: Source, expression: ts.Expression, depth = 0): boolean | undefined {
    const e = unwrap(expression)
    switch (e.kind) {
        case ts.SyntaxKind.TrueKeyword:
            return true
        case ts.SyntaxKind.FalseKeyword:
        case ts.SyntaxKind.NullKeyword:
            return false
        case ts.SyntaxKind.VoidExpression:
            return false
    }
    if (ts.isNumericLiteral(e)) return Number(e.text) !== 0
    if (ts.isStringLiteral(e) || ts.isNoSubstitutionTemplateLiteral(e)) return e.text !== ''
    if (ts.isPrefixUnaryExpression(e) && e.operator === ts.SyntaxKind.ExclamationToken) {
        const inner = constantTruth(src, e.operand, depth)
        return inner === undefined ? undefined : !inner
    }
    if (ts.isIdentifier(e)) {
        if (e.text === 'undefined' && !declarationOf(src, e)) return false
        const init = constInitializer(src, e, depth)
        return init === undefined ? undefined : constantTruth(src, init, depth + 1)
    }
    return undefined
}

/** Whether the value is a constant known not to be null or undefined (so `??` never reaches its right side). */
function constantlyNonNullish(src: Source, expression: ts.Expression, depth = 0): boolean {
    const e = unwrap(expression)
    if (e.kind === ts.SyntaxKind.NullKeyword || e.kind === ts.SyntaxKind.VoidExpression) return false
    if (ts.isIdentifier(e)) {
        const init = constInitializer(src, e, depth)
        return init !== undefined && constantlyNonNullish(src, init, depth + 1)
    }
    return constantTruth(src, e) !== undefined
}

/** Whether the value is a constant known to be null or undefined: `null`, `void …`, `undefined`, or a const of one. */
function constantlyNullish(src: Source, expression: ts.Expression, depth = 0): boolean {
    const e = unwrap(expression)
    if (e.kind === ts.SyntaxKind.NullKeyword || e.kind === ts.SyntaxKind.VoidExpression) return true
    if (!ts.isIdentifier(e)) return false
    if (e.text === 'undefined' && !declarationOf(src, e)) return true
    const init = constInitializer(src, e, depth)
    return init !== undefined && constantlyNullish(src, init, depth + 1)
}

/** A call in an optional chain (`a?.(…)`, `a?.b(…)`, `a?.b.c(…)`) whose optional link's receiver is constantly nullish. */
function shortCircuitsOnConstant(src: Source, node: ts.CallExpression | ts.NewExpression): boolean {
    let link: ts.Expression = node
    while (ts.isCallExpression(link) || ts.isPropertyAccessExpression(link) || ts.isElementAccessExpression(link)) {
        if (link.questionDotToken && constantlyNullish(src, link.expression)) return true
        link = unwrap(link.expression)
    }
    return false
}

function isShortCircuit(kind: ts.SyntaxKind): boolean {
    return (
        kind === ts.SyntaxKind.AmpersandAmpersandToken ||
        kind === ts.SyntaxKind.BarBarToken ||
        kind === ts.SyntaxKind.QuestionQuestionToken
    )
}

/** For `a && b`, `a || b` and `a ?? b`: whether a constant left side means `b` never runs. */
function rightIsDead(src: Source, node: ts.BinaryExpression): boolean {
    const kind = node.operatorToken.kind
    if (kind === ts.SyntaxKind.QuestionQuestionToken) return constantlyNonNullish(src, node.left)
    const left = constantTruth(src, node.left)
    if (left === undefined) return false
    return kind === ts.SyntaxKind.AmpersandAmpersandToken ? left === false : left === true
}

/**
 * Whether control never falls through `s` to the statement after it. `labels` are the labels `s` carries
 * (`a: b: { … }` carries both), so a `break` naming any of them counts as falling through.
 */
function alwaysExits(src: Source, s: ts.Statement, labels: readonly string[] = []): boolean {
    if (ts.isReturnStatement(s) || ts.isThrowStatement(s) || ts.isBreakStatement(s) || ts.isContinueStatement(s)) {
        return true
    }
    // A labeled block, `if` or `try` falls through after all when a `break` names its label.
    const named = (exits: boolean) => exits && (labels.length === 0 || !breaksOut(s, labels, false, false))
    if (ts.isBlock(s)) return named(s.statements.some((inner) => alwaysExits(src, inner)))
    if (ts.isIfStatement(s)) {
        const condition = constantTruth(src, s.expression)
        if (condition === true) return named(alwaysExits(src, s.thenStatement))
        if (condition === false) return named(s.elseStatement !== undefined && alwaysExits(src, s.elseStatement))
        return named(
            s.elseStatement !== undefined && alwaysExits(src, s.thenStatement) && alwaysExits(src, s.elseStatement),
        )
    }
    if (ts.isTryStatement(s)) {
        if (s.finallyBlock && alwaysExits(src, s.finallyBlock)) return named(true)
        return named(alwaysExits(src, s.tryBlock) && (!s.catchClause || alwaysExits(src, s.catchClause.block)))
    }
    if (ts.isLabeledStatement(s)) return alwaysExits(src, s.statement, [...labels, s.label.text])
    // A loop that only a `break` can leave: `while (true)`, `for (;;)`, `for (; true;)`.
    if (ts.isWhileStatement(s) || ts.isForStatement(s)) {
        const condition = ts.isWhileStatement(s) ? s.expression : s.condition
        const forever = condition === undefined || constantTruth(src, condition) === true
        return forever && !breaksOut(s.statement, labels, true, false)
    }
    if (ts.isDoStatement(s)) {
        if (alwaysExits(src, s.statement) && !breaksOut(s.statement, labels, true, true)) return true
        return constantTruth(src, s.expression) === true && !breaksOut(s.statement, labels, true, false)
    }
    // A switch with a default that nothing breaks out of: control leaves only through the last clause's end.
    if (ts.isSwitchStatement(s)) {
        const clauses = s.caseBlock.clauses
        const last = clauses[clauses.length - 1]
        return (
            clauses.some(ts.isDefaultClause) &&
            last !== undefined &&
            last.statements.some((inner) => alwaysExits(src, inner)) &&
            !breaksOut(s.caseBlock, labels, true, false)
        )
    }
    return false
}

/** The labels a statement carries: those of the labeled statements directly around it. */
function labelsOf(s: ts.Statement): string[] {
    const labels: string[] = []
    for (let parent = s.parent; ts.isLabeledStatement(parent); parent = parent.parent) labels.push(parent.label.text)
    return labels
}

/**
 * Whether a `do` or `for` loop's body can reach the end of an iteration, where the `do` condition or the `for`
 * incrementor runs: it falls through, or a `continue` aims at this loop. A body that always returns never does.
 */
function reachesLoopEnd(src: Source, loop: ts.DoStatement | ts.ForStatement): boolean {
    return !alwaysExits(src, loop.statement) || breaksOut(loop.statement, labelsOf(loop), false, true)
}

/**
 * Whether `body` holds a jump that lands just after the statement it belongs to: a `break` naming one of
 * `labels`; with `unlabeled`, a bare `break` not inside a nested loop or switch; with `continues`, a bare
 * `continue` not inside a nested loop, or one naming one of `labels` (a loop's continue goes to its end, then on).
 */
function breaksOut(body: ts.Node, labels: readonly string[], unlabeled: boolean, continues: boolean): boolean {
    let found = false
    const walk = (node: ts.Node, loops: number, switches: number): void => {
        if (found || ts.isFunctionLike(node) || ts.isClassLike(node)) return
        if (ts.isBreakStatement(node)) {
            if (node.label ? labels.includes(node.label.text) : unlabeled && loops + switches === 0) found = true
            return
        }
        if (ts.isContinueStatement(node)) {
            if (continues && (node.label ? labels.includes(node.label.text) : loops === 0)) found = true
            return
        }
        const loop = ts.isIterationStatement(node, false) ? 1 : 0
        const swtch = ts.isSwitchStatement(node) ? 1 : 0
        ts.forEachChild(node, (child) => walk(child, loops + loop, switches + swtch))
    }
    walk(body, 0, 0)
    return found
}

/**
 * The handler's first statement is `if (!isSimulated) <branch>` with `isSimulated` imported under that name, the
 * branch does nothing but return or throw a response built from literals, and nothing runs before it (no
 * parameter default or destructuring), so in real mode the handler does nothing at all.
 */
function opensWithSimulated404(src: Source, fn: ts.FunctionLikeDeclaration): boolean {
    if (!fn.body || !ts.isBlock(fn.body)) return false
    if (!fn.parameters.every(runsNothing)) return false
    if (assignsGateGlobal(src.sf)) return false
    // A directive prologue (`'use strict'`) runs nothing, so the gate may follow it.
    const first = fn.body.statements.find((s) => !(ts.isExpressionStatement(s) && ts.isStringLiteral(s.expression)))
    if (!first || !ts.isIfStatement(first)) return false
    const condition = unwrap(first.expression)
    if (!ts.isPrefixUnaryExpression(condition) || condition.operator !== ts.SyntaxKind.ExclamationToken) return false
    if (gateName(src, condition.operand) !== 'isSimulated') return false
    return isInertExit(src, first.thenStatement)
}

/**
 * The globals a handler that reads nothing may name: values and constructors that hold no data of their own and reach
 * no module, network, file or process. Anything else declared nowhere in the file is out: `fetch` (an upstream
 * service's data), `process` (its environment, and `getBuiltinModule`), `require`, `eval`, `Function`, `Reflect`,
 * `globalThis` and its aliases, `arguments`, and any global another module declares (`declare global { var prisma }`).
 * Every `…Error` constructor is in too (`GLOBAL_ERROR`).
 */
const INERT_GLOBALS: ReadonlySet<string> = new Set([
    'Array',
    'BigInt',
    'Blob',
    'Boolean',
    'Date',
    'Headers',
    'Infinity',
    'JSON',
    'Map',
    'Math',
    'NaN',
    'Number',
    'Object',
    'Promise',
    'RegExp',
    'Response',
    'Set',
    'String',
    'Symbol',
    'TextDecoder',
    'TextEncoder',
    'URL',
    'URLSearchParams',
    'WeakMap',
    'WeakSet',
    'console',
    'crypto',
    'decodeURI',
    'decodeURIComponent',
    'encodeURI',
    'encodeURIComponent',
    'isFinite',
    'isNaN',
    'parseFloat',
    'parseInt',
    'structuredClone',
    'undefined',
])

/**
 * The imports a handler that reads nothing may name, by module and exported name: Next's `NextResponse`, and SSSB's
 * run-mode constants, which a liveness probe reports.
 */
const INERT_IMPORTS: Readonly<Record<string, readonly string[]>> = {
    'next/server': ['NextResponse'],
    '@sssb/kit/adapters/index': ['appMode', 'isSimulated'],
}

/** Member names that lead from any value to the `Function` constructor or a prototype the scan cannot see. */
const ESCAPE_MEMBERS: ReadonlySet<string> = new Set(['constructor', '__proto__'])

/**
 * Whether `fn` reads nothing it could have to authorize. Its whole text is read LEXICALLY, not along a path
 * (parameters, nested functions and dead branches included), and every name it refers to that is declared outside it
 * must be one of:
 *
 * - a global in INERT_GLOBALS (`Response`, `new Date`, `URL`, `JSON`), which the file does not assign to;
 * - an import INERT_IMPORTS names, imported under its exported name (`NextResponse`, `appMode`);
 * - a `const` of this file bound to a literal value (`isLiteralValue`: `const HEADERS = { allow: 'GET' }`).
 *
 * So the only data in reach is those, literals, and the handler's own parameters (the request), and any method may be
 * called on them: `new URL(request.url).searchParams.get('x')` and `await request.json()` read the request, not a
 * port, the database or a helper. Out, whatever the name: an import (a helper, a port, a lazy query, a cache object,
 * a component, a tag), a function of this file, `fetch`, `process`, `arguments`; a dynamic `import()`, `import.meta`;
 * a `.constructor` or `.__proto__` member (`Object.constructor('…')` is `Function`); a class (its heritage and members
 * run code the handler does not show) and a `using` declaration (its disposer runs).
 *
 * What it does not see: a member read through a computed key the scan cannot evaluate (`request[key]`). Like a gate,
 * it proves the KIND of handler, one that names nothing but inert values and its request, not that no data can reach
 * it (ADR-0012).
 */
function readsNothing(src: Source, fn: ts.FunctionLikeDeclaration): boolean {
    const { checker, sf } = src
    const inside = (decl: ts.Declaration) => decl.getStart(sf) >= fn.getStart(sf) && decl.end <= fn.end
    const assigned = new Map<string, boolean>()
    const assignedGlobal = (name: string): boolean => {
        let known = assigned.get(name)
        if (known === undefined) assigned.set(name, (known = assignsGlobal(sf, (n) => n === name)))
        return known
    }
    const allowedOutside = (decl: ts.Declaration): boolean => {
        const imported = valueImportOf(decl)
        if (imported !== undefined) {
            if (imported.kind !== 'named') return false
            return (
                ts.isImportSpecifier(decl) &&
                decl.name.text === imported.name &&
                (INERT_IMPORTS[imported.module] ?? []).includes(imported.name)
            )
        }
        return (
            ts.isVariableDeclaration(decl) &&
            isConst(decl) &&
            decl.initializer !== undefined &&
            isLiteralValue(src, decl.initializer)
        )
    }
    const allowedReference = (id: ts.Identifier): boolean => {
        const parent = id.parent
        const symbol =
            ts.isShorthandPropertyAssignment(parent) && parent.name === id
                ? checker.getShorthandAssignmentValueSymbol(parent)
                : checker.getSymbolAtLocation(id)
        const decl = symbol?.declarations?.[0]
        if (decl === undefined) {
            return (INERT_GLOBALS.has(id.text) || GLOBAL_ERROR.test(id.text)) && !assignedGlobal(id.text)
        }
        return inside(decl) || allowedOutside(decl)
    }
    let reads = false
    const visit = (node: ts.Node): void => {
        if (reads) return
        // A type runs nothing, and names nothing the handler reads.
        if (ts.isTypeNode(node) || ts.isTypeAliasDeclaration(node) || ts.isInterfaceDeclaration(node)) return
        if (
            ts.isClassLike(node) ||
            ts.isMetaProperty(node) ||
            (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) ||
            (ts.isVariableDeclarationList(node) && (node.flags & ts.NodeFlags.Using) !== 0) ||
            (ts.isPropertyAccessExpression(node) && ESCAPE_MEMBERS.has(node.name.text)) ||
            (ts.isElementAccessExpression(node) &&
                ts.isStringLiteralLike(node.argumentExpression) &&
                ESCAPE_MEMBERS.has(node.argumentExpression.text))
        ) {
            reads = true
            return
        }
        if (ts.isIdentifier(node) && isReference(node) && !allowedReference(node)) {
            reads = true
            return
        }
        ts.forEachChild(node, visit)
    }
    visit(fn)
    return !reads
}

/**
 * Whether an identifier names a value at this point, rather than being a property's or a declaration's own name, a
 * label, a JSX attribute or an intrinsic JSX tag (`<div>`). A shorthand property (`{ store }`) is a reference.
 */
function isReference(id: ts.Identifier): boolean {
    const parent = id.parent
    if (ts.isPropertyAccessExpression(parent)) return parent.expression === id
    if (ts.isQualifiedName(parent)) return false
    if (
        (ts.isPropertyAssignment(parent) ||
            ts.isMethodDeclaration(parent) ||
            ts.isPropertyDeclaration(parent) ||
            ts.isGetAccessorDeclaration(parent) ||
            ts.isSetAccessorDeclaration(parent) ||
            ts.isEnumMember(parent) ||
            ts.isJsxAttribute(parent)) &&
        parent.name === id
    ) {
        return false
    }
    if (ts.isBindingElement(parent) && (parent.propertyName === id || parent.name === id)) return false
    if (
        (ts.isVariableDeclaration(parent) ||
            ts.isParameter(parent) ||
            ts.isFunctionDeclaration(parent) ||
            ts.isFunctionExpression(parent) ||
            ts.isEnumDeclaration(parent)) &&
        parent.name === id
    ) {
        return false
    }
    if ((ts.isLabeledStatement(parent) || ts.isBreakOrContinueStatement(parent)) && parent.label === id) return false
    if (
        (ts.isJsxOpeningElement(parent) || ts.isJsxSelfClosingElement(parent) || ts.isJsxClosingElement(parent)) &&
        parent.tagName === id &&
        /^[a-z]/.test(id.text)
    ) {
        return false
    }
    return true
}

/**
 * A parameter that runs no code when the handler is called: no default anywhere in it, and no computed key in a
 * destructuring pattern. Next's own `(request, { params })` is fine; `{ params = wipe() }` is not.
 */
function runsNothing(p: ts.ParameterDeclaration | ts.BindingElement): boolean {
    if (p.initializer !== undefined) return false
    if (ts.isBindingElement(p) && p.propertyName !== undefined && ts.isComputedPropertyName(p.propertyName))
        return false
    if (ts.isIdentifier(p.name)) return true
    return p.name.elements.every((element) => ts.isOmittedExpression(element) || runsNothing(element))
}

const RESPONSE_CONSTRUCTORS = ['Response', 'NextResponse']
/** A global constructor that may be thrown from the gate: an `Error`, which does nothing when built. */
const GLOBAL_ERROR = /^(?:[A-Z][A-Za-z]*)?Error$/
const RESPONSE_FACTORIES = ['Response.json', 'Response.redirect', 'NextResponse.json', 'NextResponse.redirect']

/** `return <response>` or `throw new X(…)`, alone or alone in a block, built from literals only. */
function isInertExit(src: Source, s: ts.Statement): boolean {
    if (ts.isBlock(s)) return s.statements.length === 1 && isInertExit(src, s.statements[0]!)
    if (ts.isReturnStatement(s)) {
        const e = s.expression && unwrap(s.expression)
        if (!e || !(ts.isNewExpression(e) || ts.isCallExpression(e))) return false
        const name = globalOrGateName(src, e.expression)
        const allowed = ts.isNewExpression(e) ? RESPONSE_CONSTRUCTORS : RESPONSE_FACTORIES
        return name !== undefined && allowed.includes(name) && (e.arguments ?? []).every((a) => isLiteralValue(src, a))
    }
    if (ts.isThrowStatement(s)) {
        // A constructor runs code when built, so only one known to do nothing may be thrown: a global Error, or one
        // of SSSB's port errors imported from ERRORS_MODULE. Any other import (`throw new PurgeTenant('all')`) may
        // do anything, and other globals (a WebSocket) do I/O.
        const e = unwrap(s.expression)
        if (!ts.isNewExpression(e)) return false
        const name = globalOrGateName(src, e.expression)
        const global = isGlobal(src, e.expression)
        return (
            name !== undefined &&
            (global ? GLOBAL_ERROR.test(name) : importedFrom(src, e.expression) === ERRORS_MODULE) &&
            (e.arguments ?? []).every((a) => isLiteralValue(src, a))
        )
    }
    return false
}

/** The module whose errors (`NotFoundError` and the rest) the simulated-mode gate may throw. */
const ERRORS_MODULE = '@sssb/kit/ports/errors'

/** The module a callee's head is a value import from, or undefined. */
function importedFrom(src: Source, callee: ts.Expression): string | undefined {
    let head = unwrap(callee)
    while (ts.isPropertyAccessExpression(head)) head = unwrap(head.expression)
    return ts.isIdentifier(head) ? valueImportOf(declarationOf(src, head))?.module : undefined
}

/**
 * Whether the file assigns to a global the gate's inert exit relies on (`Response`, `NextResponse`, `JSON`, an
 * `…Error`, or `globalThis`), or to a property of one (`Response.json = …`): an assignment replaces what the exit
 * builds with code of the file's own. Undeclared names only; a declared one is not the global anyway.
 */
function assignsGateGlobal(sf: ts.SourceFile): boolean {
    return assignsGlobal(
        sf,
        (name) =>
            name === 'Response' ||
            name === 'NextResponse' ||
            name === 'JSON' ||
            name === 'globalThis' ||
            GLOBAL_ERROR.test(name),
    )
}

/** Whether the file assigns to an undeclared name `relied` accepts, or to a property of one (`fetch.x = …`). */
function assignsGlobal(sf: ts.SourceFile, relied: (name: string) => boolean): boolean {
    let found = false
    const visit = (node: ts.Node): void => {
        if (found) return
        if (
            ts.isBinaryExpression(node) &&
            node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
            node.operatorToken.kind <= ts.SyntaxKind.LastAssignment
        ) {
            let head = unwrap(node.left)
            while (ts.isPropertyAccessExpression(head) || ts.isElementAccessExpression(head))
                head = unwrap(head.expression)
            if (ts.isIdentifier(head) && relied(head.text) && !hasLocalDeclaration(sf, head.text)) found = true
        }
        ts.forEachChild(node, visit)
    }
    visit(sf)
    return found
}

/** Whether `name` is declared anywhere in the file (a variable, function, class, parameter or import). */
function hasLocalDeclaration(sf: ts.SourceFile, name: string): boolean {
    let found = false
    const visit = (node: ts.Node): void => {
        if (found) return
        const declared =
            (ts.isVariableDeclaration(node) ||
                ts.isFunctionDeclaration(node) ||
                ts.isClassDeclaration(node) ||
                ts.isParameter(node) ||
                ts.isImportSpecifier(node) ||
                ts.isImportClause(node) ||
                ts.isNamespaceImport(node) ||
                ts.isBindingElement(node)) &&
            node.name !== undefined &&
            ts.isIdentifier(node.name) &&
            node.name.text === name
        if (declared) found = true
        else ts.forEachChild(node, visit)
    }
    visit(sf)
    return found
}

/** The callee's head is declared nowhere in the file. */
function isGlobal(src: Source, callee: ts.Expression): boolean {
    let head = unwrap(callee)
    while (ts.isPropertyAccessExpression(head)) head = unwrap(head.expression)
    return ts.isIdentifier(head) && declarationOf(src, head) === undefined
}

/** A callee's dotted name when its head is a global (declared nowhere in the file), or its gate name if imported. */
function globalOrGateName(src: Source, callee: ts.Expression): string | undefined {
    let head = unwrap(callee)
    while (ts.isPropertyAccessExpression(head)) head = unwrap(head.expression)
    if (!ts.isIdentifier(head)) return undefined
    return declarationOf(src, head) === undefined ? dottedName(callee) : gateName(src, callee)
}

/**
 * A value whose construction runs no code: a literal, `undefined`, a signed number, an array or object literal
 * of those (plain properties only, no spread, computed key, method or accessor), or `JSON.stringify` of one. An
 * identifier or a property read is not one: it can be an object whose `toJSON` or getter runs on use.
 */
function isLiteralValue(src: Source, expression: ts.Expression): boolean {
    const e = unwrap(expression)
    switch (e.kind) {
        case ts.SyntaxKind.StringLiteral:
        case ts.SyntaxKind.NumericLiteral:
        case ts.SyntaxKind.BigIntLiteral:
        case ts.SyntaxKind.NoSubstitutionTemplateLiteral:
        case ts.SyntaxKind.TrueKeyword:
        case ts.SyntaxKind.FalseKeyword:
        case ts.SyntaxKind.NullKeyword:
            return true
    }
    if (ts.isIdentifier(e)) return e.text === 'undefined' && declarationOf(src, e) === undefined
    if (ts.isPrefixUnaryExpression(e)) {
        return (
            (e.operator === ts.SyntaxKind.MinusToken || e.operator === ts.SyntaxKind.PlusToken) &&
            ts.isNumericLiteral(unwrap(e.operand))
        )
    }
    if (ts.isArrayLiteralExpression(e)) {
        return e.elements.every((element) => ts.isOmittedExpression(element) || isLiteralValue(src, element))
    }
    if (ts.isObjectLiteralExpression(e)) {
        return e.properties.every(
            (p) =>
                ts.isPropertyAssignment(p) && !ts.isComputedPropertyName(p.name) && isLiteralValue(src, p.initializer),
        )
    }
    if (ts.isCallExpression(e)) {
        return (
            globalOrGateName(src, e.expression) === 'JSON.stringify' &&
            e.arguments.every((argument) => isLiteralValue(src, argument))
        )
    }
    return false
}

/** The file reads `module.exports`, `module['exports']` or a free `exports`: CommonJS, whatever else it has. */
function usesCommonJsExports(sf: ts.SourceFile, checker: ts.TypeChecker): boolean {
    let found = false
    const free = (node: ts.Node, name: string) =>
        ts.isIdentifier(node) && node.text === name && !checker.getSymbolAtLocation(node)?.declarations?.length
    const walk = (node: ts.Node): void => {
        if (found) return
        if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
            const member = ts.isPropertyAccessExpression(node)
                ? node.name.text
                : ts.isStringLiteralLike(node.argumentExpression)
                  ? node.argumentExpression.text
                  : undefined
            if ((free(node.expression, 'module') && member === 'exports') || free(node.expression, 'exports')) {
                found = true
                return
            }
        }
        if (ts.isCallExpression(node) && node.arguments.some((a) => free(a, 'exports'))) {
            found = true
            return
        }
        ts.forEachChild(node, walk)
    }
    walk(sf)
    return found
}

function readCompilerOptions(tsconfig: string): ts.CompilerOptions {
    const parsed = ts.getParsedCommandLineOfConfigFile(
        tsconfig,
        {},
        {
            ...ts.sys,
            // Only the options are wanted; listing the project's files would walk the whole app for nothing.
            readDirectory: () => [],
            onUnRecoverableConfigFileDiagnostic: (diagnostic) => {
                throw new Error(`${tsconfig}: ${ts.flattenDiagnosticMessageText(diagnostic.messageText, ' ')}`)
            },
        },
    )
    if (!parsed) throw new Error(`${tsconfig}: could not be read`)
    return parsed.options
}
