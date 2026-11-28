import { makeTestTmpDir } from '../testing/tmp-dir'
import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
    type Gate,
    type Handler,
    type HandlerFacts,
    type ScanOptions,
    type ScanPolicy,
    type ScanRoot,
    type ScannedRoute,
    describeGate,
    exemptRel,
    exemptionFor,
    gateHolds,
    isPageFileName,
    isReadVerb,
    judge,
    scanPages,
    scanRoutes,
} from './route-scan'

/**
 * The analyser's own cases: which export forms it reads, what counts as a handler's path, what it refuses.
 * The policy (the real exemption map) is ./route-policy.ts, applied by authorized-mutations.test.ts and ./app-exemptions.ts; this file feeds the
 * analyser small route trees written to a scratch directory and checks what it found.
 */

const SCRATCH = makeTestTmpDir('route-scan-')
let caseNumber = 0

/** Writes `files` under a fresh directory and scans it as one root. `route.ts` is the usual subject. */
function scanTree(
    files: Record<string, string>,
    root: (dir: string) => Partial<ScanRoot> = () => ({}),
    options?: ScanOptions,
): ScannedRoute[] {
    const dir = path.join(SCRATCH, `case-${++caseNumber}`)
    for (const [rel, src] of Object.entries(files)) {
        mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true })
        writeFileSync(path.join(dir, rel), src)
    }
    return scanRoutes([{ label: 'case', dir, exemptDir: dir, ...root(dir) }], options)
}

type Outcome = 'authorized' | 'open' | RegExp

function outcome(handler: Handler): string {
    if (handler.refusal !== undefined) return `refused: ${handler.refusal}`
    return handler.facts.reachesAuthorize ? 'authorized' : 'open'
}

/** The verbs of the one `route.ts` in the tree, each with its outcome. */
function verdicts(files: Record<string, string>, root?: (dir: string) => Partial<ScanRoot>, options?: ScanOptions) {
    const route = scanTree(files, root, options).find((r) => r.rel === 'route.ts')
    if (!route) throw new Error('no route.ts in the case')
    return Object.fromEntries(route.handlers.map((handler) => [handler.verb, outcome(handler)]))
}

function expectVerdicts(actual: Record<string, string>, expected: Record<string, Outcome>): void {
    expect(Object.keys(actual)).toEqual(Object.keys(expected))
    for (const [verb, want] of Object.entries(expected)) {
        if (want instanceof RegExp) expect(actual[verb], verb).toMatch(want)
        else expect(actual[verb], verb).toBe(want)
    }
}

/** The facts on the route's one handler (fails the test if it was refused). */
function factsOf(src: string, verb = 'POST'): HandlerFacts {
    const route = scanTree({ 'route.ts': src }).find((r) => r.rel === 'route.ts')
    const handler = route?.handlers.find((h) => h.verb === verb)
    if (!handler?.facts) throw new Error(`no facts for ${verb}: ${handler?.refusal ?? 'no handler'}`)
    return handler.facts
}

const AUTHORIZE = "import { authorize } from '@sssb/kit/authz/authorize'\n"
const CALL = 'authorize(actor, "update", subject)'
const DECLS = 'declare const actor: never\ndeclare const subject: never\ndeclare const cond: boolean\n'

/** A route.ts that imports the real authorize, with `body` as POST's body. */
function post(body: string, prelude = ''): Record<string, string> {
    return {
        'route.ts': `${AUTHORIZE}${DECLS}${prelude}\nexport async function POST(request: Request) {\n${body}\n}\n`,
    }
}

describe('the export forms a mutating handler can take', () => {
    const cases: Array<{ name: string; files: Record<string, string>; expect: Record<string, Outcome> }> = [
        {
            name: 'export async function',
            files: { 'route.ts': `${AUTHORIZE}${DECLS}export async function POST() { ${CALL} }` },
            expect: { POST: 'authorized' },
        },
        {
            name: 'export function (sync, returning a promise)',
            files: { 'route.ts': `${AUTHORIZE}${DECLS}export function PUT() { ${CALL}; return Promise.resolve() }` },
            expect: { PUT: 'authorized' },
        },
        {
            name: 'export const = arrow',
            files: { 'route.ts': `${AUTHORIZE}${DECLS}export const PATCH = async () => { ${CALL} }` },
            expect: { PATCH: 'authorized' },
        },
        {
            name: 'export const = function expression, behind `satisfies`',
            files: {
                'route.ts': `${AUTHORIZE}${DECLS}export const DELETE = (function () { ${CALL} }) satisfies unknown`,
            },
            expect: { DELETE: 'authorized' },
        },
        {
            name: 'export const = a wrapper call around the handler',
            files: {
                'route.ts': `${AUTHORIZE}${DECLS}declare const wrap: Function\nexport const POST = wrap(async () => { ${CALL} })`,
            },
            expect: { POST: 'authorized' },
        },
        {
            name: 'export const = a same-file const that is itself the handler',
            files: {
                'route.ts': `${AUTHORIZE}${DECLS}const handler = async () => { ${CALL} }\nexport const POST = handler`,
            },
            expect: { POST: 'authorized' },
        },
        {
            name: 'export { handler as POST }, and an open one as PATCH',
            files: {
                'route.ts': `${AUTHORIZE}${DECLS}async function handler() { ${CALL} }\nconst open = async () => {}\nexport { handler as POST, open as PATCH }`,
            },
            expect: { POST: 'authorized', PATCH: 'open' },
        },
        {
            name: "export { handler as 'DELETE' } (a string export name)",
            files: { 'route.ts': "const handler = async () => {}\nexport { handler as 'DELETE' }" },
            expect: { DELETE: 'open' },
        },
        {
            name: 'an overloaded function: the implementation is the handler',
            files: {
                'route.ts': `${AUTHORIZE}${DECLS}export function POST(): Promise<void>\nexport function POST(request?: Request) { ${CALL}; return Promise.resolve() }`,
            },
            expect: { POST: 'authorized' },
        },
        {
            name: 'export { POST } from a relative module, read in that module',
            files: {
                'route.ts': "export { POST, DELETE } from './impl'",
                'impl.ts': `${AUTHORIZE}${DECLS}export async function POST() { ${CALL} }\nexport async function DELETE() {}`,
            },
            expect: { POST: 'authorized', DELETE: 'open' },
        },
        {
            name: 'export { handler as POST } from a module',
            files: {
                'route.ts': "export { handler as POST } from './impl'",
                'impl.ts': `${AUTHORIZE}${DECLS}export const handler = async () => { ${CALL} }`,
            },
            expect: { POST: 'authorized' },
        },
        {
            name: 'an imported handler, exported by name and as an initializer',
            files: {
                'route.ts':
                    "import { open, guarded } from './impl'\nexport const POST = guarded\nexport { open as DELETE }",
                'impl.ts': `${AUTHORIZE}${DECLS}export const guarded = async () => { ${CALL} }\nexport const open = async () => {}`,
            },
            expect: { POST: 'authorized', DELETE: 'open' },
        },
        {
            name: 'export * from a module: each of its verbs is judged',
            files: {
                'route.ts': "export * from './impl'\nexport async function GET() {}",
                'impl.ts': `${AUTHORIZE}${DECLS}export async function POST() { ${CALL} }\nexport async function DELETE() {}\nexport async function GET() {}`,
            },
            expect: { GET: 'open', POST: 'authorized', DELETE: 'open' },
        },
        {
            name: 'export * through two modules, where the route also names a verb itself',
            files: {
                'route.ts': "export * from './a'\nexport async function PUT() {}",
                'a.ts': "export * from './b'",
                'b.ts': `${AUTHORIZE}${DECLS}export async function PATCH() { ${CALL} }\nexport async function PUT() { ${CALL} }`,
            },
            expect: { PUT: 'open', PATCH: 'authorized' },
        },
        {
            name: 'a named re-export of a name the module itself gets through export *',
            files: {
                'route.ts': "export { POST, DELETE } from './a'",
                'a.ts': "export * from './b'",
                'b.ts': `${AUTHORIZE}${DECLS}export async function POST() { ${CALL} }\nexport async function DELETE() {}`,
            },
            expect: { POST: 'authorized', DELETE: 'open' },
        },
        {
            name: 'a re-export into a directory with only an index',
            files: {
                'route.ts': "export { POST } from './impl'",
                'impl/index.ts': `${AUTHORIZE}${DECLS}export async function POST() { ${CALL} }`,
            },
            expect: { POST: 'authorized' },
        },
        {
            name: 'a re-export through a tsconfig `paths` alias',
            files: {
                'route.ts': "export { POST } from '@/impl'",
                'src/impl.ts': `${AUTHORIZE}${DECLS}export async function POST() { ${CALL} }`,
                'tsconfig.json': JSON.stringify({
                    compilerOptions: { moduleResolution: 'bundler', module: 'esnext', paths: { '@/*': ['./src/*'] } },
                }),
            },
            expect: { POST: 'authorized' },
        },
        {
            name: 'export { h as POST } where h is overloaded',
            files: {
                'route.ts': `${AUTHORIZE}${DECLS}function h(): Promise<void>\nfunction h(r?: Request) { ${CALL}; return Promise.resolve() }\nexport { h as POST }`,
            },
            expect: { POST: 'authorized' },
        },
        {
            name: "a module's default function, re-exported as a verb",
            files: {
                'route.ts': "export { default as POST } from './impl'",
                'impl.ts': `${AUTHORIZE}${DECLS}export default async function () { ${CALL} }`,
            },
            expect: { POST: 'authorized' },
        },
        {
            name: "a module's default expression, re-exported as a verb",
            files: {
                'route.ts': "export { default as POST, default as DELETE } from './impl'",
                'impl.ts': `${AUTHORIZE}${DECLS}export default async () => { ${CALL} }`,
            },
            expect: { POST: 'authorized', DELETE: 'authorized' },
        },
        {
            name: "a module's default, imported and exported as a verb",
            files: {
                'route.ts': "import h from './impl'\nexport { h as POST }",
                'impl.ts': 'export default async function named() {}',
            },
            expect: { POST: 'open' },
        },
        {
            name: "a module's default class is not a handler",
            files: { 'route.ts': "export { default as POST } from './impl'", 'impl.ts': 'export default class {}' },
            expect: { POST: /ClassDeclaration, not a function/ },
        },
        {
            name: 'every verb Next routes is judged, reads as well as mutations (safeinsights/sssb#103)',
            files: {
                'route.ts': `${AUTHORIZE}${DECLS}export async function GET() { ${CALL} }\nexport const HEAD = async () => {}\nexport function OPTIONS() {}`,
            },
            expect: { GET: 'authorized', HEAD: 'open', OPTIONS: 'open' },
        },
        {
            name: 'a route file that exports no verb has no handler',
            files: { 'route.ts': "export const dynamic = 'force-dynamic'\nexport async function helper() {}" },
            expect: {},
        },
        {
            name: 'a type-only export is not a handler',
            files: { 'route.ts': 'type POST = () => void\nexport type { POST }' },
            expect: {},
        },
    ]

    it.each(cases)('$name', ({ files, expect: expected }) => {
        const root =
            'tsconfig.json' in files ? (dir: string) => ({ tsconfig: path.join(dir, 'tsconfig.json') }) : undefined
        expectVerdicts(verdicts(files, root), expected)
    })
})

describe('what the analyser refuses, and says why', () => {
    const cases: Array<{ name: string; files: Record<string, string>; expect: Record<string, RegExp> }> = [
        {
            name: 'a destructured export',
            files: {
                'route.ts':
                    'declare const handlers: Record<string, unknown>\nexport const { POST, other: [DELETE] } = handlers as never',
            },
            expect: { POST: /destructured/, DELETE: /destructured/ },
        },
        {
            name: 'a `let` handler, which can be reassigned',
            files: { 'route.ts': `${AUTHORIZE}${DECLS}export let POST = async () => { ${CALL} }` },
            expect: { POST: /`let` or `var`/ },
        },
        {
            name: 'a handler that is a property of another value',
            files: { 'route.ts': 'declare const handlers: { post: () => void }\nexport const POST = handlers.post' },
            expect: { POST: /PropertyAccessExpression/ },
        },
        {
            name: 'an ambient handler with no initializer',
            files: { 'route.ts': 'export declare const POST: () => Promise<Response>' },
            expect: { POST: /no initializer/ },
        },
        {
            name: 'a handler defined in terms of itself',
            files: { 'route.ts': 'export const POST = other\nconst other = POST' },
            expect: { POST: /in terms of itself/ },
        },
        {
            name: 'a class exported under a verb',
            files: { 'route.ts': 'export class POST {}' },
            expect: { POST: /ClassDeclaration, not a function/ },
        },
        {
            name: 'a namespace re-export under a verb',
            files: { 'route.ts': "export * as POST from './impl'", 'impl.ts': 'export const x = 1' },
            expect: { POST: /namespace re-export/ },
        },
        {
            name: '`export import … =` under a verb',
            files: {
                'route.ts': 'namespace handlers { export const post = () => {} }\nexport import POST = handlers.post',
            },
            expect: { POST: /export import/ },
        },
        {
            name: 'a re-export that does not resolve',
            files: { 'route.ts': "export { POST } from './missing'" },
            expect: { POST: /does not resolve/ },
        },
        {
            name: 'a re-export of a name the module does not export',
            files: { 'route.ts': "export { POST } from './impl'", 'impl.ts': 'export const GET = async () => {}' },
            expect: { POST: /has no export named `POST`/ },
        },
        {
            name: 'a named re-export from a module whose export * does not resolve',
            files: { 'route.ts': "export { POST } from './a'", 'a.ts': "export * from './missing'" },
            expect: { POST: /does not resolve/ },
        },
        {
            name: 'a re-export into a declaration file',
            files: { 'route.ts': "export { POST } from './impl'", 'impl.d.ts': 'export declare function POST(): void' },
            expect: { POST: /declaration file/ },
        },
        {
            name: 'a re-export into a module that does not parse',
            files: { 'route.ts': "export { POST } from './impl'", 'impl.ts': 'export async function POST( {' },
            expect: { POST: /does not parse/ },
        },
        {
            name: 'export * from a module that does not resolve: which verbs is unknown',
            files: { 'route.ts': "export * from './missing'\nexport async function GET() {}" },
            expect: { GET: /^open$/, '*': /which verbs it exports is unknown/ },
        },
        {
            name: 'an import of a module that does not resolve, exported as a verb',
            files: { 'route.ts': "import { handler } from 'no-such-package'\nexport { handler as POST }" },
            expect: { POST: /does not resolve/ },
        },
        {
            name: 'a namespace import exported as a verb',
            files: {
                'route.ts': "import * as impl from './impl'\nexport { impl as POST }",
                'impl.ts': 'export const x = 1',
            },
            expect: { POST: /namespace import/ },
        },
        {
            name: 'a route file that does not parse',
            files: { 'route.ts': 'export async function POST( {' },
            expect: { '*': /does not parse/ },
        },
        {
            name: 'a route file that assigns module.exports',
            files: { 'route.ts': 'module.exports.POST = async () => {}' },
            expect: { '*': /module\.exports/ },
        },
        {
            name: 'a handler function the file reassigns',
            files: {
                'route.ts': `${AUTHORIZE}${DECLS}export async function POST() { ${CALL} }\nPOST = async () => {}`,
            },
            expect: { POST: /reassigns/ },
        },
        {
            name: 'a route file with exports and an exports[...] assignment',
            files: { 'route.ts': "export const GET = 1\nexports['POST'] = async () => {}" },
            expect: { '*': /module\.exports/ },
        },
        {
            name: 'a route file with exports and Object.assign(module.exports, …)',
            files: { 'route.ts': 'export const GET = 1\nObject.assign(module.exports, { POST: async () => {} })' },
            expect: { '*': /module\.exports/ },
        },
        {
            name: "a route file with exports and module['exports'] in a block",
            files: { 'route.ts': "export const GET = 1\n{ module['exports'] = {} }" },
            expect: { '*': /module\.exports/ },
        },
        {
            name: 'a route file with exports and a bare exports passed along',
            files: { 'route.ts': 'export const GET = 1\nObject.assign(exports, {})' },
            expect: { '*': /module\.exports/ },
        },
        {
            name: 'a route file that uses export =',
            files: { 'route.ts': 'const handlers = { async POST() { return Response.json({}) } }\nexport = handlers' },
            expect: { '*': /export =/ },
        },
        {
            name: 'a handler the file destructures a new value into',
            files: {
                'route.ts': `${AUTHORIZE}${DECLS}export async function POST() { ${CALL} }\n;[POST] = [async () => {}]`,
            },
            expect: { POST: /reassigns/ },
        },
        {
            name: 'a handler the file object-destructures a new value into',
            files: {
                'route.ts': `${AUTHORIZE}${DECLS}export async function POST() { ${CALL} }\n;({ open: POST } = { open: async () => {} })`,
            },
            expect: { POST: /reassigns/ },
        },
        {
            name: 'a handler a shorthand destructuring assigns',
            files: {
                'route.ts': `${AUTHORIZE}${DECLS}export async function POST() { ${CALL} }\n;({ POST } = { POST: async () => {} })`,
            },
            expect: { POST: /reassigns/ },
        },
        {
            name: 'a handler an array spread target assigns',
            files: { 'route.ts': `${AUTHORIZE}${DECLS}export function PUT() { ${CALL} }\n;[...PUT] = []` },
            expect: { PUT: /reassigns/ },
        },
        {
            name: 'a handler a for-of loop assigns',
            files: { 'route.ts': `${AUTHORIZE}${DECLS}export async function POST() { ${CALL} }\nfor (POST of []) {}` },
            expect: { POST: /reassigns/ },
        },
        {
            name: 'a handler a destructuring default assigns',
            files: {
                'route.ts': `${AUTHORIZE}${DECLS}export async function POST() { ${CALL} }\n;[POST = async () => {}] = []`,
            },
            expect: { POST: /reassigns/ },
        },
        {
            name: 'a handler a spread target assigns',
            files: { 'route.ts': `${AUTHORIZE}${DECLS}export function DELETE() { ${CALL} }\n;({ ...DELETE } = {})` },
            expect: { DELETE: /reassigns/ },
        },
        {
            name: 'a re-export with a .ts and a .js beside each other',
            files: {
                'route.ts': "export { POST } from './impl'",
                'impl.ts': `${AUTHORIZE}${DECLS}export async function POST() { ${CALL} }`,
                'impl.js': 'export async function POST() {}',
            },
            expect: { POST: /could load any of impl\.ts, impl\.js/ },
        },
        {
            name: 'a re-export of the route itself',
            files: { 'route.ts': "export { POST } from './route'" },
            expect: { POST: /leads back to itself/ },
        },
        {
            name: 'a re-export cycle through two modules',
            files: {
                'route.ts': "export { POST } from './a'",
                'a.ts': "export { POST } from './b'",
                'b.ts': "export { POST } from './a'",
            },
            expect: { POST: /leads back to itself/ },
        },
        {
            name: 'a re-export TypeScript reads from impl/index.ts while the bundler loads impl.mjs',
            files: {
                'route.ts': "export { POST } from './impl'",
                'impl.mjs': 'export async function POST() {}',
                'impl/index.ts': `${AUTHORIZE}${DECLS}export async function POST() { ${CALL} }`,
            },
            expect: { POST: /could load any of impl\.mjs, impl\/index\.ts/ },
        },
        {
            name: 'a re-export into a directory whose package.json the bundler may follow',
            files: {
                'route.ts': "export { POST } from './impl'",
                'impl/package.json': JSON.stringify({ types: './index.ts', main: './served.js' }),
                'impl/index.ts': `${AUTHORIZE}${DECLS}export async function POST() { ${CALL} }`,
                'impl/served.js': 'export async function POST() {}',
            },
            expect: { POST: /could load any of impl\/index\.ts, impl\/package\.json/ },
        },
        {
            name: 'a route file that is no module at all',
            files: { 'route.ts': 'const x = 1' },
            expect: { '*': /not an ES module/ },
        },
        {
            name: 'export * into a CommonJS module',
            files: { 'route.ts': "export * from './impl.js'", 'impl.js': 'module.exports = { POST: async () => {} }' },
            expect: { '*': /not an ES module/ },
        },
        {
            name: 'a route file that assigns exports.X',
            files: { 'route.ts': 'exports.DELETE = async () => {}' },
            expect: { '*': /module\.exports/ },
        },
    ]

    it.each(cases)('$name', ({ files, expect: expected }) => {
        expectVerdicts(verdicts(files), expected)
    })
})

describe("what counts as a handler's own path", () => {
    const cases: Array<{ name: string; files: Record<string, string>; expect: Outcome }> = [
        { name: 'a direct call', files: post(CALL), expect: 'authorized' },
        {
            name: "'authorize(' in a string",
            files: post(`return Response.json({ why: 'authorize(' })`),
            expect: 'open',
        },
        { name: "'authorize(' in a template", files: post('return `authorize(actor)`'), expect: 'open' },
        { name: 'authorize(...) in a comment', files: post(`// ${CALL}\n/* ${CALL} */`), expect: 'open' },
        { name: 'under if (false)', files: post(`if (false) ${CALL}`), expect: 'open' },
        { name: 'under if (0)', files: post(`if (0) { ${CALL} }`), expect: 'open' },
        { name: "under if ('')", files: post(`if ('') ${CALL}`), expect: 'open' },
        { name: 'under if (!true)', files: post(`if (!true) ${CALL}`), expect: 'open' },
        { name: 'under if (void 0)', files: post(`if (void 0) ${CALL}`), expect: 'open' },
        { name: 'under if (null)', files: post(`if (null) ${CALL}`), expect: 'open' },
        { name: 'under if (undefined)', files: post(`if (undefined) ${CALL}`), expect: 'open' },
        {
            name: 'under a const bound to false',
            files: post(`if (NEVER) ${CALL}`, 'const NEVER = false\n'),
            expect: 'open',
        },
        {
            name: 'under a const bound to a const bound to false',
            files: post(`if (OFF) ${CALL}`, 'const NEVER = false\nconst OFF = NEVER\n'),
            expect: 'open',
        },
        {
            name: 'under a let bound to false (could change)',
            files: post(`if (maybe) ${CALL}`, 'let maybe = false\n'),
            expect: 'authorized',
        },
        { name: 'in the else of if (true)', files: post(`if (true) {} else ${CALL}`), expect: 'open' },
        { name: 'in the then of if (true)', files: post(`if (true) ${CALL}`), expect: 'authorized' },
        { name: 'in the else of if (false)', files: post(`if (false) {} else ${CALL}`), expect: 'authorized' },
        { name: 'under an unknown condition', files: post(`if (cond) ${CALL}`), expect: 'authorized' },
        { name: 'in the condition itself', files: post(`if (${CALL}) {}`), expect: 'authorized' },
        { name: 'right of false &&', files: post(`false && ${CALL}`), expect: 'open' },
        { name: 'right of true ||', files: post(`true || ${CALL}`), expect: 'open' },
        { name: "right of 'x' ??", files: post(`'x' ?? ${CALL}`), expect: 'open' },
        { name: 'right of null ??', files: post(`null ?? ${CALL}`), expect: 'authorized' },
        { name: 'right of cond &&', files: post(`cond && ${CALL}`), expect: 'authorized' },
        { name: 'right of true &&', files: post(`true && ${CALL}`), expect: 'authorized' },
        { name: 'right of false ||', files: post(`false || ${CALL}`), expect: 'authorized' },
        { name: 'right of an unknown ??', files: post(`cond ?? ${CALL}`), expect: 'authorized' },
        { name: 'right of a const string ??', files: post(`OK ?? ${CALL}`, "const OK = 'yes'\n"), expect: 'open' },
        { name: 'right of a const false ??', files: post(`NO ?? ${CALL}`, 'const NO = false\n'), expect: 'open' },
        {
            name: 'right of a const null ??',
            files: post(`NONE ?? ${CALL}`, 'const NONE = null\n'),
            expect: 'authorized',
        },
        {
            name: 'right of a let string ??',
            files: post(`ok ?? ${CALL}`, "let ok: string | null = 'yes'\n"),
            expect: 'authorized',
        },
        { name: 'right of undefined ??', files: post(`undefined ?? ${CALL}`), expect: 'authorized' },
        { name: 'the false arm of true ? :', files: post(`true ? 1 : ${CALL}`), expect: 'open' },
        { name: 'the true arm of false ? :', files: post(`false ? ${CALL} : 1`), expect: 'open' },
        { name: 'either arm of an unknown ? :', files: post(`cond ? 1 : ${CALL}`), expect: 'authorized' },
        { name: 'in the condition of an unknown ? :', files: post(`;(${CALL}) ? 1 : 2`), expect: 'authorized' },
        { name: 'the true arm of true ? :', files: post(`true ? ${CALL} : 1`), expect: 'authorized' },
        { name: 'in while (false)', files: post(`while (false) ${CALL}`), expect: 'open' },
        { name: 'in while (cond)', files: post(`while (cond) ${CALL}`), expect: 'authorized' },
        { name: 'in a while condition', files: post(`while (${CALL}) {}`), expect: 'authorized' },
        { name: 'in for (;false;)', files: post(`for (;false;) ${CALL}`), expect: 'open' },
        { name: 'in for (;;) with a break first', files: post(`for (;;) { break; ${CALL} }`), expect: 'open' },
        { name: 'in a for initializer', files: post(`for (let i = ${CALL}; cond; ) {}`), expect: 'authorized' },
        { name: 'in a for condition', files: post(`for (; ${CALL}; ) {}`), expect: 'authorized' },
        { name: 'in a for incrementor', files: post(`for (; cond; ${CALL}) {}`), expect: 'authorized' },
        { name: 'in a for body', files: post(`for (let i = 0; i < 1; i++) ${CALL}`), expect: 'authorized' },
        { name: 'in a for-of body', files: post(`for (const x of [1]) ${CALL}`), expect: 'authorized' },
        { name: 'in a for-in expression', files: post(`for (const k in ${CALL}) {}`), expect: 'authorized' },
        { name: 'in a do-while body', files: post(`do { ${CALL} } while (false)`), expect: 'authorized' },
        { name: 'in a do-while condition', files: post(`do {} while (${CALL})`), expect: 'authorized' },
        {
            name: 'in a for-of body after continue',
            files: post(`for (const x of [1]) { continue; ${CALL} }`),
            expect: 'open',
        },
        { name: 'in a switch case', files: post(`switch (cond) { case true: ${CALL}; break }`), expect: 'authorized' },
        { name: 'in a switch subject', files: post(`switch (${CALL}) { default: break }`), expect: 'authorized' },
        { name: 'in a switch case label', files: post(`switch (cond) { case ${CALL}: break }`), expect: 'authorized' },
        {
            name: 'in a switch case after its break',
            files: post(`switch (cond) { default: break; ${CALL} }`),
            expect: 'open',
        },
        { name: 'in a labeled block', files: post(`outer: { ${CALL} }`), expect: 'authorized' },
        {
            name: 'after a switch whose every clause returns, with a default',
            files: post(`switch (cond) { case true: return 1; default: return 2 }\n${CALL}`),
            expect: 'open',
        },
        {
            name: 'after a switch whose clauses fall through to a return',
            files: post(`switch (cond) { case true: default: return 2 }\n${CALL}`),
            expect: 'open',
        },
        {
            name: 'after a switch with no default',
            files: post(`switch (cond) { case true: return 1 }\n${CALL}`),
            expect: 'authorized',
        },
        {
            name: 'after a switch a clause breaks out of',
            files: post(`switch (cond) { case true: break; default: return 2 }\n${CALL}`),
            expect: 'authorized',
        },
        {
            name: 'after a switch whose last clause falls off the end',
            files: post(`switch (cond) { default: return 2; case true: }\n${CALL}`),
            expect: 'authorized',
        },
        {
            name: 'after a switch whose inner loop breaks (not out of the switch)',
            files: post(`switch (cond) { default: for (;;) { break } return 2 }\n${CALL}`),
            expect: 'open',
        },
        { name: 'after while (true) that returns', files: post(`while (true) { return 1 }\n${CALL}`), expect: 'open' },
        { name: 'after for (;;) that returns', files: post(`for (;;) { return 1 }\n${CALL}`), expect: 'open' },
        {
            name: 'after for (; true;) that returns',
            files: post(`for (; true; ) { return 1 }\n${CALL}`),
            expect: 'open',
        },
        {
            name: 'after while (true) that can break',
            files: post(`while (true) { if (cond) break; return 1 }\n${CALL}`),
            expect: 'authorized',
        },
        {
            name: 'after while (true) whose body is a break',
            files: post(`while (true) break\n${CALL}`),
            expect: 'authorized',
        },
        {
            name: 'after while (true) whose only break is in an inner loop',
            files: post(`while (true) { for (;;) { break } return 1 }\n${CALL}`),
            expect: 'open',
        },
        {
            name: 'after while (true) whose inner loop breaks it by label',
            files: post(`outer: while (true) { for (;;) { break outer } }\n${CALL}`),
            expect: 'authorized',
        },
        {
            // Invalid (a break cannot cross a function), but it parses, and must not count as leaving the loop.
            name: 'after while (true) whose only bare break is in a nested function',
            files: post(`while (true) { ;(() => { break })(); return 1 }\n${CALL}`),
            expect: 'open',
        },
        {
            name: 'after while (cond) that returns',
            files: post(`while (cond) { return 1 }\n${CALL}`),
            expect: 'authorized',
        },
        { name: 'after do that returns', files: post(`do { return 1 } while (cond)\n${CALL}`), expect: 'open' },
        {
            name: 'after do that continues',
            files: post(`do { continue } while (false)\n${CALL}`),
            expect: 'authorized',
        },
        {
            name: 'after do whose only continue is in an inner loop',
            files: post(`do { for (const x of [1]) { continue } return 1 } while (cond)\n${CALL}`),
            expect: 'open',
        },
        { name: 'after do-while (true)', files: post(`do {} while (true)\n${CALL}`), expect: 'open' },
        {
            name: 'after do-while (true) that breaks',
            files: post(`do { break } while (true)\n${CALL}`),
            expect: 'authorized',
        },
        {
            name: 'after do-while (cond) with an empty body',
            files: post(`do {} while (cond)\n${CALL}`),
            expect: 'authorized',
        },
        { name: 'after a labeled block that returns', files: post(`l: { return 1 }\n${CALL}`), expect: 'open' },
        {
            name: 'after a labeled block a break names',
            files: post(`l: { if (cond) break l; return 1 }\n${CALL}`),
            expect: 'authorized',
        },
        {
            name: 'after a labeled if a break names',
            files: post(`l: if (cond) { break l } else { return 1 }\n${CALL}`),
            expect: 'authorized',
        },
        {
            name: 'after a labeled try a break names',
            files: post(`l: try { break l } finally { return 1 }\n${CALL}`),
            expect: 'authorized',
        },
        {
            name: 'after a labeled try whose catch a break names',
            files: post(`l: try { return 1 } catch { break l }\n${CALL}`),
            expect: 'authorized',
        },
        {
            name: 'after a labeled try that returns',
            files: post(`l: try { return 1 } catch { return 2 }\n${CALL}`),
            expect: 'open',
        },
        {
            name: 'after a labeled block whose if returns both ways',
            files: post(`l: if (cond) { return 1 } else { return 2 }\n${CALL}`),
            expect: 'open',
        },
        {
            name: 'after a labeled if (true) that returns',
            files: post(`l: if (true) { return 1 }\n${CALL}`),
            expect: 'open',
        },
        {
            name: 'after a labeled if (false) whose else returns',
            files: post(`l: if (false) {} else { return 1 }\n${CALL}`),
            expect: 'open',
        },
        {
            name: 'after a labeled while (true) a break names',
            files: post(`l: while (true) { break l }\n${CALL}`),
            expect: 'authorized',
        },
        {
            name: 'after a labeled while (true) that returns',
            files: post(`l: while (true) { return 1 }\n${CALL}`),
            expect: 'open',
        },
        {
            name: 'after a labeled do whose continue names it',
            files: post(`l: do { if (cond) continue l; return 1 } while (false)\n${CALL}`),
            expect: 'authorized',
        },
        {
            name: 'after a labeled switch a break names',
            files: post(`l: switch (cond) { default: if (cond) break l; return 1 }\n${CALL}`),
            expect: 'authorized',
        },
        {
            name: 'after nested labels, a break naming the outer',
            files: post(`a: b: { break a }\n${CALL}`),
            expect: 'authorized',
        },
        {
            name: 'after nested labels, a break naming the inner',
            files: post(`a: b: { break b }\n${CALL}`),
            expect: 'authorized',
        },
        { name: 'after nested labels that return', files: post(`a: b: { return 1 }\n${CALL}`), expect: 'open' },
        {
            name: 'in a do condition after a body that returns',
            files: post(`do { return 1 } while (${CALL})`),
            expect: 'open',
        },
        {
            name: 'in a do condition after a body that can continue',
            files: post(`do { if (cond) continue; return 1 } while (${CALL})`),
            expect: 'authorized',
        },
        {
            name: 'in a labeled do condition a continue names',
            files: post(`l: do { for (;;) { continue l } } while (${CALL})`),
            expect: 'authorized',
        },
        {
            name: 'in a do condition after a body that falls through',
            files: post(`do {} while (${CALL})`),
            expect: 'authorized',
        },
        {
            name: 'in a for incrementor after a body that returns',
            files: post(`for (;; ${CALL}) { return 1 }`),
            expect: 'open',
        },
        {
            name: 'in a for incrementor after a body that can continue',
            files: post(`for (;; ${CALL}) { if (cond) continue; return 1 }`),
            expect: 'authorized',
        },
        { name: 'in a constant if condition that calls', files: post(`if (void ${CALL}) {}`), expect: 'authorized' },
        {
            name: 'in a constant while condition that calls',
            files: post(`while (void ${CALL}) {}`),
            expect: 'authorized',
        },
        { name: 'in a constant ?: condition that calls', files: post(`;(void ${CALL}) ? 1 : 2`), expect: 'authorized' },
        { name: 'left of a dead &&', files: post(`;(void ${CALL}) && 1`), expect: 'authorized' },
        { name: 'after return', files: post(`return Response.json({})\n${CALL}`), expect: 'open' },
        { name: 'after throw', files: post(`throw new Error('no')\n${CALL}`), expect: 'open' },
        { name: 'in the returned expression', files: post(`return ${CALL}`), expect: 'authorized' },
        { name: 'in the thrown expression', files: post(`throw ${CALL}`), expect: 'authorized' },
        { name: 'after a block that returns', files: post(`{ return 1 }\n${CALL}`), expect: 'open' },
        {
            name: 'after an if whose both arms return',
            files: post(`if (cond) return 1\nelse return 2\n${CALL}`),
            expect: 'open',
        },
        { name: 'after an if (true) that returns', files: post(`if (true) return 1\n${CALL}`), expect: 'open' },
        {
            name: 'after an if (false) whose else returns',
            files: post(`if (false) {} else return 2\n${CALL}`),
            expect: 'open',
        },
        { name: 'after an if (false) with no else', files: post(`if (false) return 1\n${CALL}`), expect: 'authorized' },
        {
            name: 'after an if with one arm returning',
            files: post(`if (cond) return 1\n${CALL}`),
            expect: 'authorized',
        },
        {
            name: 'after an if/else where only one arm returns',
            files: post(`if (cond) return 1\nelse {}\n${CALL}`),
            expect: 'authorized',
        },
        {
            name: 'after an if/else where only the else returns',
            files: post(`if (cond) {}\nelse return 1\n${CALL}`),
            expect: 'authorized',
        },
        {
            name: 'after try/catch that both return',
            files: post(`try { return 1 } catch { return 2 }\n${CALL}`),
            expect: 'open',
        },
        {
            name: 'after try that returns with no catch',
            files: post(`try { return 1 } finally {}\n${CALL}`),
            expect: 'open',
        },
        { name: 'after a finally that returns', files: post(`try {} finally { return 1 }\n${CALL}`), expect: 'open' },
        {
            name: 'after a try that returns, catch that does not',
            files: post(`try { return 1 } catch {}\n${CALL}`),
            expect: 'authorized',
        },
        { name: 'inside a try whose catch swallows it', files: post(`try { ${CALL} } catch {}`), expect: 'open' },
        {
            name: 'inside a try whose catch can fall through',
            files: post(`try { ${CALL} } catch (e) { if (cond) throw e }`),
            expect: 'open',
        },
        {
            name: 'inside a try whose catch rethrows',
            files: post(`try { ${CALL} } catch (e) { throw e }`),
            expect: 'authorized',
        },
        {
            name: 'inside a try whose catch returns (a response the scan cannot read: a 403 or a 200)',
            files: post(`try { ${CALL} } catch { return new Response(null, { status: 403 }) }`),
            expect: 'open',
        },
        {
            name: 'an async helper whose catch returns, awaited (the helper resolves, the handler goes on)',
            files: post('await check()', `async function check() { try { ${CALL} } catch { return } }\n`),
            expect: 'open',
        },
        {
            name: 'inside a try whose catch returns only from a nested function, then rethrows',
            files: post(`try { ${CALL} } catch (e) { const f = () => { return 1 }; throw e }`),
            expect: 'authorized',
        },
        { name: 'inside a try with only a finally', files: post(`try { ${CALL} } finally {}`), expect: 'authorized' },
        {
            name: 'inside a try whose finally returns in its place',
            files: post(`try { ${CALL} } finally { return new Response() }`),
            expect: 'open',
        },
        {
            name: 'inside a catch whose finally returns in its place',
            files: post(`try {} catch { ${CALL} } finally { return new Response() }`),
            expect: 'open',
        },
        {
            name: 'inside a try whose catch breaks out of a labeled block',
            files: post(`out: { try { ${CALL} } catch { break out } }\nreturn new Response()`),
            expect: 'open',
        },
        {
            name: 'inside a try whose catch breaks out of a do-while (false)',
            files: post(`do { try { ${CALL} } catch { break } } while (false)`),
            expect: 'open',
        },
        {
            name: 'inside a try whose catch continues its loop',
            files: post(`for (const x of [1]) { try { ${CALL} } catch { continue } }`),
            expect: 'open',
        },
        {
            name: 'inside a try whose catch breaks only an inner loop, then rethrows',
            files: post(`try { ${CALL} } catch (e) { for (;;) { break } throw e }`),
            expect: 'authorized',
        },
        {
            name: 'inside a try whose finally may return in its place',
            files: post(`try { ${CALL} } finally { if (cond) return new Response() }`),
            expect: 'open',
        },
        {
            name: 'inside a try nested in a try whose catch swallows it',
            files: post(`try { try { ${CALL} } finally {} } catch {}`),
            expect: 'open',
        },
        { name: 'inside catch', files: post(`try {} catch { ${CALL} }`), expect: 'authorized' },
        { name: 'inside finally', files: post(`try {} finally { ${CALL} }`), expect: 'authorized' },
        { name: 'in a variable initializer', files: post(`const x = ${CALL}`), expect: 'authorized' },
        {
            name: 'in a destructuring default (runs only when missing)',
            files: post(`const { a = ${CALL} } = {} as { a?: 1 }`),
            expect: 'open',
        },
        {
            name: 'in a parameter default',
            files: { 'route.ts': `${AUTHORIZE}${DECLS}export async function POST(request = ${CALL}) {}` },
            expect: 'open',
        },
        { name: 'nested inside another call’s argument', files: post(`Response.json(${CALL})`), expect: 'authorized' },
        {
            name: 'in a callback passed to a wrapper',
            files: post(`return wrap(async () => { ${CALL} })`, 'declare const wrap: Function\n'),
            expect: 'authorized',
        },
        {
            name: 'in a function expression passed to a wrapper',
            files: post(`return wrap(async function () { ${CALL} })`, 'declare const wrap: Function\n'),
            expect: 'authorized',
        },
        { name: 'in a callback passed to forEach', files: post(`;[1].forEach(() => ${CALL})`), expect: 'authorized' },
        {
            name: 'in a callback passed to a method whose result is returned',
            files: post(`return [1].map(() => ${CALL})`),
            expect: 'authorized',
        },
        { name: 'in a Promise executor', files: post(`await new Promise(() => ${CALL})`), expect: 'authorized' },
        { name: 'in an IIFE', files: post(`;(() => { ${CALL} })()`), expect: 'authorized' },
        {
            name: 'in a closure that is never called',
            files: post(`const check = () => ${CALL}\nreturn typeof check`),
            expect: 'open',
        },
        {
            name: 'in a closure that is called',
            files: post(`const check = () => ${CALL}\ncheck()`),
            expect: 'authorized',
        },
        {
            name: 'in a let closure that is called (could be reassigned)',
            files: post(`let check = () => ${CALL}\ncheck()`),
            expect: 'open',
        },
        {
            name: 'in a closure passed by name to a wrapper',
            files: post(`const check = async () => { ${CALL} }\nreturn wrap(check)`, 'declare const wrap: Function\n'),
            expect: 'authorized',
        },
        {
            name: 'in a same-file function declaration that is called',
            files: post('check()', `function check() { ${CALL} }\n`),
            expect: 'authorized',
        },
        {
            name: 'in a same-file function declared after the call',
            files: post('return check()\nfunction check() { ' + CALL + ' }'),
            expect: 'authorized',
        },
        {
            name: 'in a same-file function that is never called',
            files: post('return 1', `function check() { ${CALL} }\n`),
            expect: 'open',
        },
        {
            name: 'in a same-file generator that is called',
            files: post('check()', `function* check() { ${CALL} }\n`),
            expect: 'open',
        },
        {
            name: 'in a same-file async generator that is called',
            files: post('check()', `async function* check() { ${CALL} }\n`),
            expect: 'open',
        },
        {
            name: 'in a generator expression that is called',
            files: post('check()', `const check = function* () { ${CALL} }\n`),
            expect: 'open',
        },
        {
            name: 'in a generator passed to a wrapper',
            files: post(`return wrap(function* () { ${CALL} })`, 'declare const wrap: Function\n'),
            expect: 'open',
        },
        {
            name: 'in a same-file function two calls deep, through a cycle',
            files: post('a()', `function a(): void { b() }\nfunction b(): void { if (cond) a(); ${CALL} }\n`),
            expect: 'authorized',
        },
        {
            name: 'in a nested function declaration that is never called',
            files: post(`function check() { ${CALL} }\nreturn 1`),
            expect: 'open',
        },
        {
            name: 'in an object method that is called',
            files: post(`const h = { run() { ${CALL} } }\nh.run()`),
            expect: 'open',
        },
        { name: 'in a class body', files: post(`class C { static { ${CALL} } }\nnew C()`), expect: 'open' },
        {
            name: 'in a class expression (not followed, though a static block would run)',
            files: post(`const C = class { static { ${CALL} } }\nreturn C`),
            expect: 'open',
        },
        {
            name: 'an import type clause of authorize',
            files: {
                'route.ts': `import type { authorize } from '@sssb/kit/authz/authorize'\n${DECLS}export async function POST() { ${CALL} }`,
            },
            expect: 'open',
        },
        {
            name: 'a same-file helper the file reassigns',
            files: post('check()', `function check() { ${CALL} }\ncheck = () => {}\n`),
            expect: 'open',
        },
        {
            name: 'a same-file helper a for-in loop assigns',
            files: post('check()', `function check() { ${CALL} }\nfor (check in {}) {}\n`),
            expect: 'open',
        },
        {
            name: 'a same-file helper the file increments (still a write)',
            files: post('check()', `function check() { ${CALL} }\ncheck++\n`),
            expect: 'open',
        },
        {
            name: 'an overloaded same-file helper',
            files: post(
                'check(1)',
                `function check(a: string): void\nfunction check(a: number): void\nfunction check(a: unknown) { ${CALL} }\n`,
            ),
            expect: 'authorized',
        },
        {
            name: 'a type-only import of authorize',
            files: {
                'route.ts': `import { type authorize } from '@sssb/kit/authz/authorize'\n${DECLS}export async function POST() { ${CALL} }`,
            },
            expect: 'open',
        },
        {
            name: 'in a helper imported from another module',
            files: {
                ...post('check()', "import { check } from './helper'\n"),
                'helper.ts': `${AUTHORIZE}${DECLS}export function check() { ${CALL} }`,
            },
            expect: 'open',
        },
        {
            name: 'a local function named authorize',
            files: {
                'route.ts': `${DECLS}function authorize(..._: unknown[]) {}\nexport async function POST() { ${CALL} }`,
            },
            expect: 'open',
        },
        {
            name: 'a local function named authorize that calls the real one',
            files: {
                'route.ts': `import { authorize as real } from '@sssb/kit/authz/authorize'\n${DECLS}function authorize(...a: never[]) { real(...a) }\nexport async function POST() { ${CALL} }`,
            },
            expect: 'authorized',
        },
        {
            name: 'authorize imported from another module',
            files: {
                'route.ts': `import { authorize } from './my-authz'\n${DECLS}export async function POST() { ${CALL} }`,
            },
            expect: 'open',
        },
        {
            name: 'authorize imported under another name',
            files: {
                'route.ts': `import { authorize as az } from '@sssb/kit/authz/authorize'\n${DECLS}export async function POST() { az(actor, 'update', subject) }`,
            },
            expect: 'authorized',
        },
        {
            name: 'a different SSSB export imported as authorize',
            files: {
                'route.ts': `import { canInActiveOrg as authorize } from '@sssb/kit/authz/authorize'\n${DECLS}export async function POST() { ${CALL} }`,
            },
            expect: 'open',
        },
        {
            name: 'authorize through a namespace import of SSSB',
            files: {
                'route.ts': `import * as authz from '@sssb/kit/authz/authorize'\n${DECLS}export async function POST() { authz.authorize(actor, 'update', subject) }`,
            },
            expect: 'authorized',
        },
        {
            name: 'another export through a namespace import of SSSB',
            files: {
                'route.ts': `import * as authz from '@sssb/kit/authz/authorize'\n${DECLS}export async function POST() { authz.canInActiveOrg(actor) }`,
            },
            expect: 'open',
        },
        {
            name: 'authorize through a namespace import of another module',
            files: {
                'route.ts': `import * as authz from './my-authz'\n${DECLS}export async function POST() { authz.authorize(actor, 'update', subject) }`,
            },
            expect: 'open',
        },
        {
            name: 'authorize as a property of something that is not an import',
            files: {
                'route.ts': `${DECLS}declare const authz: { authorize: Function }\nexport async function POST() { authz.authorize(actor) }`,
            },
            expect: 'open',
        },
    ]

    it.each(cases)('$name', ({ files, expect: expected }) => {
        expectVerdicts(verdicts(files), { POST: expected })
    })

    it("a call in one handler is not on another handler's path", () => {
        expectVerdicts(
            verdicts({
                'route.ts': `${AUTHORIZE}${DECLS}export async function PATCH() { ${CALL} }\nexport async function DELETE() {}\nexport async function GET() { ${CALL} }`,
            }),
            { PATCH: 'authorized', DELETE: 'open', GET: 'authorized' },
        )
    })

    it('two handlers sharing a same-file helper both reach what it calls', () => {
        expectVerdicts(
            verdicts({
                'route.ts': `${AUTHORIZE}${DECLS}function check() { ${CALL} }\nexport async function PATCH() { check() }\nexport async function DELETE() { check() }`,
            }),
            { PATCH: 'authorized', DELETE: 'authorized' },
        )
    })

    it('the authorize modules are an option, so an adopter can name its own', () => {
        const files = {
            'route.ts': `import { authorize } from '@acme/authz'\n${DECLS}export async function POST() { ${CALL} }`,
        }
        expectVerdicts(verdicts(files), { POST: 'open' })
        expectVerdicts(verdicts(files, undefined, { authorizeModules: ['@acme/authz'] }), { POST: 'authorized' })
    })

    it('a JSDoc @import in a route.js is a type, not the choke point, and does not stop the scan', () => {
        const route = scanTree({
            'route.js':
                "/** @import { authorize } from '@sssb/kit/authz/authorize' */\nexport async function POST() { authorize() }",
        })[0]
        expect(route?.handlers.map((h) => [h.verb, outcome(h)])).toEqual([['POST', 'open']])
    })

    it('a route.js helper declared twice, or also as a var, is not followed: the last one is what runs', () => {
        const twice = scanTree({
            'route.js': `${AUTHORIZE}export async function POST() { function check() { authorize() } function check() {} check() }`,
        })[0]
        expect(twice?.handlers.map((h) => outcome(h))).toEqual(['open'])
        const asVar = scanTree({
            'route.js': `${AUTHORIZE}export async function POST() { function check() { authorize() } var check = () => {}; check() }`,
        })[0]
        expect(asVar?.handlers.map((h) => outcome(h))).toEqual(['open'])
        // A var in a nested block is hoisted to the function, so it is the same name.
        const hoisted = scanTree({
            'route.js': `${AUTHORIZE}export async function POST(c) { function check() { authorize() } if (c) { var check = () => {} } check() }`,
        })[0]
        expect(hoisted?.handlers.map((h) => outcome(h))).toEqual(['open'])
    })

    it('a route.js handler declared twice in its scope is refused', () => {
        const route = scanTree({
            'route.js': `${AUTHORIZE}export async function POST() { authorize() }\nfunction POST() {}`,
        })[0]
        expect(route?.handlers[0]?.refusal).toMatch(/declared more than once/)
    })

    it('a route.js that reassigns its handler is refused', () => {
        const route = scanTree({
            'route.js': `${AUTHORIZE}export async function POST() { authorize() }\nPOST = async () => {}`,
        })[0]
        expect(route?.handlers[0]?.refusal).toMatch(/reassigns/)
    })

    it('reads a route.js the same way', () => {
        const route = scanTree({
            'route.js': `${AUTHORIZE}export async function POST() { authorize() }\nexport function DELETE() {}`,
        })[0]
        expect(route?.handlers.map((h) => [h.verb, outcome(h)])).toEqual([
            ['POST', 'authorized'],
            ['DELETE', 'open'],
        ])
    })
})

describe("a denial counts only when it reaches the handler's outcome", () => {
    // `authorize` throws synchronously. Inside an async function that throw becomes a rejection of the function's
    // promise, so it stops the handler only if the handler awaits or returns that promise. A floating one is an
    // unhandled rejection, and the handler goes on to mutate (ADR-0012, addendum of 2026-11-18).
    const ASYNC = `async function check() { ${CALL} }\n`
    const SYNC = `function checkSync() { ${CALL} }\n`
    const RELAY = `${ASYNC}function relay() { return check() }\n`
    const OUTER = `${ASYNC}async function outer() { await check() }\n`
    const EARLY = `async function early() { ${CALL}; await Promise.resolve() }\n`
    const EXTERNS = 'declare const wrap: Function\ndeclare const load: () => Promise<unknown>\n'
    const cases: Array<{ name: string; files: Record<string, string>; expect: Outcome }> = [
        // Floating: the scan used to count every one of these.
        { name: 'an async helper called and not awaited', files: post('check()', ASYNC), expect: 'open' },
        {
            name: 'an async helper that authorizes before its first await, not awaited',
            files: post('early()', EARLY),
            expect: 'open',
        },
        { name: 'an async helper behind void', files: post('void check()', ASYNC), expect: 'open' },
        { name: 'an async helper chained with .then', files: post('check().then(() => 1)', ASYNC), expect: 'open' },
        { name: 'an async helper chained with .catch', files: post('check().catch(() => {})', ASYNC), expect: 'open' },
        {
            name: 'an awaited .then chain on an async helper (a chain is not followed)',
            files: post('await check().then(() => 1)', ASYNC),
            expect: 'open',
        },
        {
            name: 'an async helper whose promise is stored, then awaited later',
            files: post('const pending = check()\nawait pending', ASYNC),
            expect: 'open',
        },
        { name: 'an async helper left of &&', files: post('await (check() && 1)', ASYNC), expect: 'open' },
        { name: 'an async IIFE not awaited', files: post(`;(async () => { ${CALL} })()`), expect: 'open' },
        {
            name: 'an async IIFE that awaits the helper, itself not awaited',
            files: post(';(async () => { await check() })()', ASYNC),
            expect: 'open',
        },
        {
            name: 'an async closure called and not awaited',
            files: post(`const run = async () => { ${CALL} }\nrun()`),
            expect: 'open',
        },
        {
            name: 'an async helper awaited inside an async helper the handler does not await',
            files: post('outer()', OUTER),
            expect: 'open',
        },
        {
            name: "a sync helper returning an async helper's promise, not awaited",
            files: post('relay()', RELAY),
            expect: 'open',
        },
        {
            name: 'a callback to .then, not awaited',
            files: post(`load().then(() => ${CALL})`, EXTERNS),
            expect: 'open',
        },
        {
            name: 'an async callback to a wrapper whose result is dropped',
            files: post(`wrap(async () => { ${CALL} })`, EXTERNS),
            expect: 'open',
        },
        {
            name: 'a sync callback to a wrapper whose result is dropped (the wrapper may defer it)',
            files: post(`wrap(() => { ${CALL} })`, EXTERNS),
            expect: 'open',
        },
        {
            name: 'an async helper by name to a wrapper whose result is dropped',
            files: post('wrap(check)', ASYNC + EXTERNS),
            expect: 'open',
        },
        {
            name: 'an async helper returned from a callback whose wrapper is dropped',
            files: post('wrap(() => check())', ASYNC + EXTERNS),
            expect: 'open',
        },
        { name: 'a timer callback', files: post(`setTimeout(() => ${CALL}, 0)`), expect: 'open' },
        { name: 'a Promise executor not awaited', files: post(`new Promise(() => ${CALL})`), expect: 'open' },
        {
            name: 'an async callback to forEach, though the forEach is awaited',
            files: post(`await [1].forEach(async () => { ${CALL} })`),
            expect: 'open',
        },
        {
            name: 'an async callback to map, though the map is returned',
            files: post(`return [1].map(async () => { ${CALL} })`),
            expect: 'open',
        },
        {
            name: 'an async helper by name to forEach',
            files: post('[1].forEach(check)', ASYNC),
            expect: 'open',
        },
        {
            name: 'an async helper in a try whose catch swallows its rejection',
            files: post('try { await check() } catch {}', ASYNC),
            expect: 'open',
        },
        {
            name: 'a callback to a same-file wrapper, even one that awaits it (a parameter is not followed)',
            files: post(
                `await run(async () => { ${CALL} })`,
                'async function run(fn: () => Promise<void>) { await fn() }\n',
            ),
            expect: 'open',
        },
        {
            name: 'a callback to a let wrapper',
            files: post(`await run(async () => { ${CALL} })`, 'let run = async (fn: Function) => { await fn() }\n'),
            expect: 'open',
        },
        {
            name: 'a callback to a method of a same-file object',
            files: post(
                `await o.run(async () => { ${CALL} })`,
                'const o = { run: async (fn: Function) => { await fn() } }\n',
            ),
            expect: 'open',
        },
        {
            name: 'a callback to a method of a same-file object, by element access',
            files: post(
                `await o['run'](async () => { ${CALL} })`,
                'const o = { run: async (fn: Function) => { await fn() } }\n',
            ),
            expect: 'open',
        },
        {
            name: 'a callback to a same-file class',
            files: post(`await new Runner(async () => { ${CALL} })`, 'class Runner { constructor(fn: Function) {} }\n'),
            expect: 'open',
        },
        {
            name: 'a callback to what a same-file factory returns',
            files: post(
                `await run(async () => { ${CALL} })`,
                'function mk() { return async (fn: Function) => { await fn() } }\nconst run = mk()\n',
            ),
            expect: 'open',
        },
        {
            name: 'a callback to a wrapper destructured from a same-file object',
            files: post(
                `await run(async () => { ${CALL} })`,
                'const { run } = { run: async (fn: Function) => { await fn() } }\n',
            ),
            expect: 'open',
        },
        {
            name: 'a callback to a wrapper destructured from a same-file factory',
            files: post(
                `await run(async () => { ${CALL} })`,
                'function mk() { return { run: async (fn: Function) => { await fn() } } }\nconst { run } = mk()\n',
            ),
            expect: 'open',
        },
        {
            name: 'a callback to a wrapper destructured from a same-file array',
            files: post(
                `await run(async () => { ${CALL} })`,
                'const [run] = [async (fn: Function) => { await fn() }]\n',
            ),
            expect: 'open',
        },
        {
            name: 'a callback to a same-file wrapper chosen by a ternary',
            files: post(
                `await (cond ? run : wrap)(async () => { ${CALL} })`,
                'const run = async (fn: Function) => { await fn() }\ndeclare const wrap: Function\n',
            ),
            expect: 'open',
        },
        {
            name: 'a callback to a same-file wrapper behind a comma',
            files: post(
                `await (0, run)(async () => { ${CALL} })`,
                'const run = async (fn: Function) => { await fn() }\n',
            ),
            expect: 'open',
        },
        {
            name: 'a callback to a variable holding a same-file wrapper or an import',
            files: post(
                `await run(async () => { ${CALL} })`,
                'declare const wrap: Function\nconst run = wrap ?? (async (fn: Function) => { await fn() })\n',
            ),
            expect: 'open',
        },
        {
            name: 'a callback to a long chain of calls on an import, awaited',
            files: post(
                `await client.a().b().c().d().e().f().g().h().i().run(async () => { ${CALL} })`,
                "import { client } from './client'\n",
            ),
            expect: 'authorized',
        },
        {
            name: "a sync callback to a same-file object's own forEach",
            files: post(`o.forEach(() => ${CALL})`, 'const o = { forEach(f: Function) { setTimeout(f) } }\n'),
            expect: 'open',
        },
        {
            name: "a sync callback to a same-file class instance's own forEach",
            files: post(`new Bag().forEach(() => ${CALL})`, 'class Bag { forEach(f: Function) { setTimeout(f) } }\n'),
            expect: 'open',
        },
        {
            name: 'a sync callback to map on an array, its result kept',
            files: post(
                `const rows = ids.map((id) => { ${CALL}; return id })\nreturn Response.json(rows)`,
                'declare const ids: number[]\n',
            ),
            expect: 'authorized',
        },
        {
            name: 'a sync callback to filter on an array',
            files: post(`ids.filter(() => ${CALL})`, 'declare const ids: number[]\n'),
            expect: 'authorized',
        },
        {
            name: 'a sync callback to forEach on rows a same-file async function loaded',
            files: post(
                `const rows = await load()\nrows.forEach(() => ${CALL})`,
                'async function load() { return [1] }\n',
            ),
            expect: 'authorized',
        },
        {
            name: 'a sync callback to map on an iterator, awaited (nothing consumes it)',
            files: post(`await ids.values().map(() => { ${CALL}; return 1 })`, 'declare const ids: number[]\n'),
            expect: 'open',
        },
        {
            name: 'a sync callback to filter on Iterator.from, returned',
            files: post(`return Iterator.from(ids).filter(() => ${CALL})`, 'declare const ids: number[]\n'),
            expect: 'open',
        },
        {
            name: 'a sync callback to forEach on an iterator (forEach runs it in place)',
            files: post(`ids.values().forEach(() => ${CALL})`, 'declare const ids: number[]\n'),
            expect: 'authorized',
        },
        {
            name: 'a callback to a method of a local holding an awaited import',
            files: post(
                `const client = await connect()\nawait client.run(async () => { ${CALL} })`,
                'declare const connect: () => Promise<{ run: Function }>\n',
            ),
            expect: 'authorized',
        },
        {
            name: 'a sync callback to map on an iterator (it runs map lazily)',
            files: post(`ids.values().map(() => { ${CALL}; return 1 })`, 'declare const ids: number[]\n'),
            expect: 'open',
        },
        {
            name: 'a sync callback to an imported namespace forEach (a library, perhaps curried)',
            files: post(`R.forEach(() => ${CALL})`, "import * as R from 'ramda'\n"),
            expect: 'open',
        },
        {
            name: 'a sync callback to forEach on an import',
            files: post(`items.forEach(() => ${CALL})`, "import { items } from './items'\n"),
            expect: 'open',
        },
        {
            name: 'an async callback to forEach by element access, awaited',
            files: post(`await ids['forEach'](async () => { ${CALL} })`, 'declare const ids: number[]\n'),
            expect: 'open',
        },
        {
            name: 'a sync callback to forEach by element access',
            files: post(`ids['forEach'](() => ${CALL})`, 'declare const ids: number[]\n'),
            expect: 'authorized',
        },
        {
            name: 'a sync callback to forEach on a same-file function result',
            files: post(`list().forEach(() => ${CALL})`, 'function list() { return [1] }\n'),
            expect: 'authorized',
        },
        {
            name: 'a callback to a same-file wrapper that drops its promise',
            files: post(`await run(async () => { ${CALL} })`, 'async function run(fn: () => Promise<void>) { fn() }\n'),
            expect: 'open',
        },
        // Reaching the outcome.
        { name: 'an async helper awaited', files: post('await check()', ASYNC), expect: 'authorized' },
        { name: 'an async helper returned', files: post('return check()', ASYNC), expect: 'authorized' },
        { name: 'an async helper returned awaited', files: post('return await check()', ASYNC), expect: 'authorized' },
        {
            name: 'an async helper awaited in a condition',
            files: post('if (await check()) {}', ASYNC),
            expect: 'authorized',
        },
        {
            name: 'an async helper awaited in a variable initializer',
            files: post('const ok = await check()', ASYNC),
            expect: 'authorized',
        },
        {
            name: 'an async helper in an awaited ternary arm',
            files: post('await (cond ? check() : null)', ASYNC),
            expect: 'authorized',
        },
        {
            name: 'an async helper right of an awaited &&',
            files: post('await (cond && check())', ASYNC),
            expect: 'authorized',
        },
        {
            name: 'an async helper right of a returned ??',
            files: post('return cond ?? check()', ASYNC),
            expect: 'authorized',
        },
        {
            name: 'an async helper right of a returned comma',
            files: post('return (0, check())', ASYNC),
            expect: 'authorized',
        },
        {
            name: 'an async helper behind a type assertion, awaited',
            files: post('await (check() as Promise<void>)', ASYNC),
            expect: 'authorized',
        },
        { name: 'an async IIFE awaited', files: post(`await (async () => { ${CALL} })()`), expect: 'authorized' },
        {
            name: 'an async helper awaited inside an async helper the handler awaits',
            files: post('await outer()', OUTER),
            expect: 'authorized',
        },
        {
            name: "a sync helper returning an async helper's promise, returned",
            files: post('return relay()', RELAY),
            expect: 'authorized',
        },
        {
            name: 'an awaited callback to .then',
            files: post(`await load().then(() => ${CALL})`, EXTERNS),
            expect: 'authorized',
        },
        {
            name: 'an async callback to an awaited wrapper',
            files: post(`await wrap(async () => { ${CALL} })`, EXTERNS),
            expect: 'authorized',
        },
        {
            name: 'a sync helper not awaited (it throws in place)',
            files: post('checkSync()', SYNC),
            expect: 'authorized',
        },
        { name: 'a sync helper behind void', files: post('void checkSync()', SYNC), expect: 'authorized' },
        { name: 'authorize itself behind void', files: post(`void ${CALL}`), expect: 'authorized' },
        { name: 'authorize itself chained with .then', files: post(`${CALL}.then(() => 1)`), expect: 'authorized' },
        { name: 'a sync IIFE not awaited', files: post(`;(() => { ${CALL} })()`), expect: 'authorized' },
        {
            name: 'an async helper left of an awaited ||',
            files: post('await (check() || 1)', ASYNC),
            expect: 'authorized',
        },
        {
            name: 'an async helper left of a returned ??',
            files: post('return check() ?? 1', ASYNC),
            expect: 'authorized',
        },
        { name: 'a sync helper by name to forEach', files: post('[1].forEach(checkSync)', SYNC), expect: 'authorized' },
        {
            name: 'a sync callback to every, its result discarded',
            files: post(`;[1].every(() => ${CALL})`),
            expect: 'authorized',
        },
        {
            name: 'an async helper returned from a try whose catch swallows (a returned promise is not caught)',
            files: post('try { return check() } catch {}', ASYNC),
            expect: 'authorized',
        },
        {
            name: 'a sync closure called inside an async helper the handler awaits',
            files: post(`await outerSync()`, `async function outerSync() { const c = () => ${CALL}; c() }\n`),
            expect: 'authorized',
        },
    ]

    it.each(cases)('$name', ({ files, expect: expected }) => {
        expectVerdicts(verdicts(files), { POST: expected })
    })

    it('an arrow handler whose body is the async helper reaches it; the same call in a block does not', () => {
        const route = (handler: string) => verdicts({ 'route.ts': `${AUTHORIZE}${DECLS}${ASYNC}${handler}` })
        expectVerdicts(route('export const POST = async () => check()'), { POST: 'authorized' })
        expectVerdicts(route('export const POST = async () => { check() }'), { POST: 'open' })
    })

    it("a wrapper handler's function must await the helper too: the wrapper is trusted, its body is not", () => {
        const route = (handler: string) =>
            verdicts({ 'route.ts': `${AUTHORIZE}${DECLS}${ASYNC}import { withX } from './wrappers'\n${handler}` })
        expectVerdicts(route('export const POST = withX(async () => { await check() })'), { POST: 'authorized' })
        expectVerdicts(route('export const POST = withX(async () => { check() })'), { POST: 'open' })
        expectVerdicts(route('export const POST = withX(check)'), { POST: 'authorized' })
    })

    it('a wrapper handler declared in the same file is not trusted: the scan does not follow a parameter', () => {
        const route = (wrapper: string) =>
            verdicts({
                'route.ts': `${AUTHORIZE}${DECLS}${wrapper}\nexport const POST = withL(async () => { ${CALL} })`,
            })
        expectVerdicts(route('function withL(fn: Function) { return async () => { fn() } }'), { POST: 'open' })
        expectVerdicts(route('const withL = (fn: Function) => async () => fn()'), { POST: 'open' })
        expectVerdicts(route('let withL = (fn: Function) => async () => fn()'), { POST: 'open' })
        expectVerdicts(route('function withL(fn: Function) { return fn }\nwithL = withL'), { POST: 'open' })
    })

    it('a wrapper nested in a same-file wrapper is not trusted either', () => {
        const route = (handler: string) =>
            verdicts({
                'route.ts': `${AUTHORIZE}${DECLS}import { withX } from './wrappers'\nfunction withL(fn: Function) { return fn }\n${handler}`,
            })
        expectVerdicts(route(`export const POST = withL(withX(async () => { ${CALL} }))`), { POST: 'open' })
        expectVerdicts(route(`export const POST = withX(withX(async () => { ${CALL} }))`), { POST: 'authorized' })
        expectVerdicts(route(`export const POST = w.withL(async () => { ${CALL} })\nconst w = { withL }`), {
            POST: 'open',
        })
    })

    it('a helper reached on two paths counts when one of them reaches the outcome', () => {
        expectVerdicts(verdicts(post('check()\nawait check()', ASYNC)), { POST: 'authorized' })
        expectVerdicts(verdicts(post('check()\ncheck()', ASYNC)), { POST: 'open' })
    })
})

describe('the facts a gate is judged on', () => {
    const WITH_X = "import { withX } from './wrappers'\n"
    const SIM = "import { isSimulated } from '@sssb/kit/adapters/index'\n"

    it('wrappedBy is the imported callee of the call the handler IS, with type arguments and wrappers seen through', () => {
        expect(factsOf(`${WITH_X}export const POST = withX(async () => {})`).wrappedBy).toBe('withX')
        expect(factsOf(`${WITH_X}export const POST = (withX<{ id: string }>(async () => {})) as never`).wrappedBy).toBe(
            'withX',
        )
        // A namespace import's head is dropped: `respond.withWebhookSecret(…)` is `withWebhookSecret`.
        expect(factsOf("import * as a from './w'\nexport const POST = a.b.withX(async () => {})").wrappedBy).toBe(
            'b.withX',
        )
        expect(
            factsOf("import * as respond from './w'\nexport const POST = respond.withX(async () => {})").wrappedBy,
        ).toBe('withX')
        expect(
            factsOf("import * as respond from './w'\nexport const POST = respond(async () => {})").wrappedBy,
        ).toBeNull()
        expect(factsOf(`${WITH_X}const inner = withX(async () => {})\nexport const POST = inner`).wrappedBy).toBe(
            'withX',
        )
        expect(factsOf("import withX from './w'\nexport const POST = withX(async () => {})").wrappedBy).toBe('withX')
    })

    it('wrappedBy is null for a wrapper that is not a value import: a local look-alike is not the guard', () => {
        expect(
            factsOf('const withX = (h: unknown) => h\nexport const POST = withX(async () => {})').wrappedBy,
        ).toBeNull()
        expect(factsOf('declare const withX: Function\nexport const POST = withX(async () => {})').wrappedBy).toBeNull()
        expect(
            factsOf("import type { withX } from './w'\nexport const POST = withX(async () => {})").wrappedBy,
        ).toBeNull()
        expect(
            factsOf("import { type withX } from './w'\nexport const POST = withX(async () => {})").wrappedBy,
        ).toBeNull()
    })

    it('wrappedBy is null for a function handler, even one that returns the wrapper', () => {
        expect(factsOf(`${WITH_X}export async function POST() { return withX(async () => {}) }`).wrappedBy).toBeNull()
        expect(factsOf('export const POST = async () => {}').wrappedBy).toBeNull()
    })

    it('wrappedBy is null for a callee that is not a dotted name', () => {
        expect(factsOf("import { make } from './w'\nexport const POST = make()(async () => {})").wrappedBy).toBeNull()
        expect(factsOf("import * as w from './w'\nexport const POST = w['withX'](async () => {})").wrappedBy).toBeNull()
    })

    it('calls holds the imported dotted callees on the path, and only those', () => {
        const facts = factsOf(
            "import { auth, other } from '@sssb/kit/adapters/index'\nconst local = { signOut() {} }\n" +
                "const note = 'auth.signOut('\n" +
                'export async function POST() { await auth.updateProfile({}); local.signOut(); if (false) other.thing(); return note }\n' +
                'export async function DELETE() { other.elsewhere() }',
        )
        expect([...facts.calls].sort()).toEqual(['auth.updateProfile'])
    })

    it('calls reads a namespace member under its own name, and ignores an alias', () => {
        const namespaced = factsOf(
            "import * as adapters from '@sssb/kit/adapters/index'\nexport async function PUT() { adapters.auth.updateProfile() }",
            'PUT',
        )
        expect([...namespaced.calls]).toEqual(['auth.updateProfile'])
        const aliased = factsOf(
            "import { other as auth } from '@sssb/kit/adapters/index'\nexport async function PUT() { auth.updateProfile() }",
            'PUT',
        )
        expect([...aliased.calls]).toEqual([])
        expect(
            factsOf("import { identity as withX } from 'lib'\nexport const POST = withX(async () => {})").wrappedBy,
        ).toBeNull()
        expect(
            factsOf("import { withX as withX } from 'lib'\nexport const POST = withX(async () => {})").wrappedBy,
        ).toBe('withX')
    })

    it('calls ignores a local look-alike of a port', () => {
        const facts = factsOf(
            'const auth = { updateProfile: () => {} }\nexport async function PUT() { auth.updateProfile() }',
            'PUT',
        )
        expect([...facts.calls]).toEqual([])
    })

    it("a wrapper handler's path is the functions handed to it, not what ran when the module loaded", () => {
        const route = (src: string) => verdicts({ 'route.ts': `${AUTHORIZE}${DECLS}${WITH_X}${src}` })
        // Load-time: the wrapper's own other arguments, and a same-file factory's body.
        expectVerdicts(route(`export const POST = withX(async () => {}, ${CALL})`), { POST: 'open' })
        expectVerdicts(route(`function make() { ${CALL}; return async () => {} }\nexport const POST = make()`), {
            POST: 'open',
        })
        // Per request: a function literal, a same-file function by name, a nested wrapper's function.
        expectVerdicts(route(`export const POST = withX(async () => { ${CALL} })`), { POST: 'authorized' })
        expectVerdicts(route(`async function h() { ${CALL} }\nexport const POST = withX(h)`), { POST: 'authorized' })
        expectVerdicts(route(`export const POST = withX(withX(async () => { ${CALL} }))`), { POST: 'authorized' })
        expectVerdicts(route(`export const POST = withX({ run: async () => { ${CALL} } })`), { POST: 'open' })
    })

    it('opensWithSimulated404 needs the imported gate as the first statement, with a branch that only exits', () => {
        const gate = (body: string, prelude = SIM) =>
            factsOf(`${prelude}declare const db: { wipe(): Promise<void> }\nexport async function POST() {\n${body}\n}`)
                .opensWithSimulated404
        expect(gate('if (!isSimulated) return new Response(null, { status: 404 })\nreturn 1')).toBe(true)
        expect(gate("if (!isSimulated) { return Response.json({ error: 'not found' }, { status: 404 }) }")).toBe(true)
        expect(gate("if (!isSimulated) throw new Error('no')")).toBe(true)
        expect(gate('if (!(isSimulated)) return new Response(null)')).toBe(true)
        expect(gate('if (!isSimulated) return new Response(null)\nelse return 2')).toBe(true)
        expect(gate('if (!isSimulated) { return new Response(null); }')).toBe(true)
        expect(
            gate(
                'if (!isSimulated) return NextResponse.json({})',
                `${SIM}import { NextResponse } from 'next/server'\n`,
            ),
        ).toBe(true)
        // Not first, not exiting, not this condition.
        expect(gate('const x = 1\nif (!isSimulated) return new Response(x)')).toBe(false)
        expect(gate('await db.wipe()\nif (!isSimulated) return new Response(null)')).toBe(false)
        expect(gate('if (!isSimulated) console.log(1)')).toBe(false)
        expect(gate('if (isSimulated === false) return new Response(null)')).toBe(false)
        expect(gate('if (!other) return new Response(null)', `${SIM}import { other } from 'k'\n`)).toBe(false)
        expect(gate('if (isSimulated) return new Response(null)')).toBe(false)
        expect(gate('if (-isSimulated) return new Response(null)')).toBe(false)
        expect(gate('return 1')).toBe(false)
        expect(gate('')).toBe(false)
        // Not the imported isSimulated.
        expect(gate('if (!isSimulated) return new Response(null)', 'const isSimulated = true\n')).toBe(false)
        expect(gate('if (!isSimulated) return new Response(null)', 'declare const isSimulated: boolean\n')).toBe(false)
        expect(gate('if (!isSimulated) return new Response(null)', "import type { isSimulated } from 'k'\n")).toBe(
            false,
        )
        // A real-mode branch that does something before, or while, it exits.
        expect(gate('if (!isSimulated) { await db.wipe(); return new Response(null) }')).toBe(false)
        expect(gate('if (!isSimulated) return db.wipe()')).toBe(false)
        expect(gate('if (!isSimulated) throw await db.wipe()')).toBe(false)
        expect(gate('if (!isSimulated) throw new Error(String(db.wipe()))')).toBe(false)
        expect(gate('if (!isSimulated) return new Response(await db.wipe())')).toBe(false)
        expect(gate('if (!isSimulated) return Response.json({ x: db.wipe() })')).toBe(false)
        expect(gate('if (!isSimulated) return new Response(null, { status: n++ })', `${SIM}let n = 0\n`)).toBe(false)
        expect(gate('if (!isSimulated) return new Response(null, { status: (n = 1) })', `${SIM}let n = 0\n`)).toBe(
            false,
        )
        expect(
            gate('if (!isSimulated) return new Response(null, { s: delete o.x })', `${SIM}const o: any = {}\n`),
        ).toBe(false)
        expect(gate('if (!isSimulated) return new Response(tag`x`)', `${SIM}declare const tag: any\n`)).toBe(false)
        expect(gate('if (!isSimulated) return new Response(() => 1)')).toBe(false)
        expect(gate('if (!isSimulated) return new Response(new Uint8Array())')).toBe(false)
        expect(gate('if (!isSimulated) return')).toBe(false)
        expect(gate('if (!isSimulated) { log(); return new Response(null) }', `${SIM}declare const log: any\n`)).toBe(
            false,
        )
        expect(gate('if (!isSimulated) try { return new Response(null) } finally { await db.wipe() }')).toBe(false)
        expect(gate('if (!isSimulated) return db.Response(null)')).toBe(false)
        expect(gate('if (!isSimulated) return new Response(null)', `${SIM}const Response = class {}\n`)).toBe(false)
        expect(gate('if (!isSimulated) throw make()', `${SIM}declare const make: any\n`)).toBe(false)
        // An alias is not the gate; a namespace member is.
        expect(
            gate('if (!isSimulated) return new Response(null)', "import { isDemoMode as isSimulated } from 'k'\n"),
        ).toBe(false)
        expect(
            factsOf(
                "import * as adapters from '@sssb/kit/adapters/index'\nexport async function POST() { if (!adapters.isSimulated) return new Response(null) }",
            ).opensWithSimulated404,
        ).toBe(true)
        // Code that runs anyway in real mode: a local class's constructor, a parameter default or pattern, a
        // value whose toJSON or getter runs when the response is built.
        expect(gate("if (!isSimulated) throw new Gone('x')", `${SIM}class Gone { constructor(_: string) {} }\n`)).toBe(
            false,
        )
        // A thrown constructor runs code: only SSSB's port errors (and a global Error) are known to do nothing.
        expect(
            gate(
                "if (!isSimulated) throw new NotFoundError('x')",
                `${SIM}import { NotFoundError } from '@sssb/kit/ports/errors'\n`,
            ),
        ).toBe(true)
        expect(
            gate(
                "if (!isSimulated) throw new errors.NotFoundError('x')",
                `${SIM}import * as errors from '@sssb/kit/ports/errors'\n`,
            ),
        ).toBe(true)
        expect(
            gate("if (!isSimulated) throw new NotFoundError('x')", `${SIM}import { NotFoundError } from 'k'\n`),
        ).toBe(false)
        expect(
            factsOf(
                `${SIM}declare const db: any\nexport async function POST(r: Request, c: unknown, x = db.wipe()) { if (!isSimulated) return new Response(null) }`,
            ).opensWithSimulated404,
        ).toBe(false)
        // Next's own `(request, { params })` runs nothing; a default or a computed key anywhere in a pattern does.
        const params = (signature: string) =>
            factsOf(
                `${SIM}declare const db: any\nexport async function DELETE(${signature}) { if (!isSimulated) return new Response(null) }`,
                'DELETE',
            ).opensWithSimulated404
        expect(params('r: Request, { params }: { params: unknown }')).toBe(true)
        expect(params('r: Request, { params: { id } }: any')).toBe(true)
        expect(params('r: Request, [a, , b]: any')).toBe(true)
        expect(params('r: Request, { params = db.wipe() }: any')).toBe(false)
        expect(params('r: Request, { params: { id = db.wipe() } }: any')).toBe(false)
        expect(params('r: Request, [a = db.wipe()]: any')).toBe(false)
        expect(params('r: Request, { [db.wipe()]: x }: any')).toBe(false)
        // A global that is not an Error does work when built; an Error does not.
        expect(gate("if (!isSimulated) throw new WebSocket('ws://example.invalid')")).toBe(false)
        expect(gate("if (!isSimulated) throw new TypeError('not here')")).toBe(true)
        expect(gate("if (!isSimulated) throw new Error('not here')")).toBe(true)
        expect(gate('if (!isSimulated) throw new Errors()')).toBe(false)
        expect(
            factsOf(
                `${SIM}export async function POST(request: Request, ...rest: unknown[]) { if (!isSimulated) return new Response(null) }`,
            ).opensWithSimulated404,
        ).toBe(true)
        expect(
            gate(
                'if (!isSimulated) return Response.json(body, { status: 404 })',
                `${SIM}const body = { toJSON() { return {} } }\n`,
            ),
        ).toBe(false)
        expect(gate('if (!isSimulated) return Response.json({ get x() { return 1 } })')).toBe(false)
        expect(gate('if (!isSimulated) return Response.json({ x() {} })')).toBe(false)
        expect(gate('if (!isSimulated) return Response.json({ ...o })', `${SIM}const o = {}\n`)).toBe(false)
        expect(gate("if (!isSimulated) return Response.json({ ['k']: 1 })")).toBe(false)
        expect(gate('if (!isSimulated) return Response.json({ k })', `${SIM}const k = 1\n`)).toBe(false)
        expect(gate('if (!isSimulated) return Response.json([o])', `${SIM}const o = {}\n`)).toBe(false)
        expect(gate('if (!isSimulated) return Response.json(o.x)', `${SIM}const o = { x: 1 }\n`)).toBe(false)
        expect(gate('if (!isSimulated) return new Response(`a${1}`)')).toBe(false)
        expect(gate('if (!isSimulated) return Response.json(!1)')).toBe(false)
        // A sign on a name runs its valueOf.
        expect(
            gate('if (!isSimulated) return Response.json({ n: -o })', `${SIM}const o = { valueOf: () => 1 }\n`),
        ).toBe(false)
        // Literals of every kind, nested, are fine; so is JSON.stringify of one.
        expect(
            gate(
                "if (!isSimulated) return Response.json({ a: 'x', b: 1, c: -1, d: +2, e: true, f: false, g: null, h: undefined, i: [1, , 'y'], j: { k: 1n }, 'l': `m` }, { status: 404 })",
            ),
        ).toBe(true)
        expect(
            gate("if (!isSimulated) return new Response(JSON.stringify({ error: 'not-found' }), { status: 404 })"),
        ).toBe(true)
        expect(gate('if (!isSimulated) return new Response(JSON.stringify(o))', `${SIM}const o = {}\n`)).toBe(false)
        expect(gate('if (!isSimulated) return new Response(JSON.parse("1"))')).toBe(false)
        expect(gate('if (!isSimulated) return new Response(undefined)', `${SIM}const undefined = 1\n`)).toBe(false)
        // A global that is not a response: `fetch` is undeclared like `Response`, and is not allowed.
        expect(gate("if (!isSimulated) return fetch('/wipe')")).toBe(false)
        expect(gate('if (!isSimulated) return new Map()')).toBe(false)
        expect(factsOf(`${SIM}export const POST = async () => (!isSimulated ? 1 : 2)`).opensWithSimulated404).toBe(
            false,
        )
        expect(
            factsOf(
                `${SIM}${WITH_X}export const POST = withX(async () => { if (!isSimulated) return new Response(null) })`,
            ).opensWithSimulated404,
        ).toBe(false)
    })
})

describe('a read that reads nothing (safeinsights/sssb#103)', () => {
    const only = (src: string, verb = 'GET') => factsOf(src, verb).readsNothing
    const IMPORT = "import { appMode, db, load, store, query } from '@sssb/kit/adapters/index'\n"
    const tsx = (src: string) => scanTree({ 'route.tsx': src }).find((r) => r.rel === 'route.tsx')!.handlers[0]!.facts!

    it('holds for a probe that names only inert globals, its request, primitive constants and the named imports', () => {
        expect(only('export async function GET() { return Response.json({ ok: true }) }')).toBe(true)
        expect(
            only(
                `${IMPORT}export async function GET() { return Response.json({ mode: appMode, at: new Date().toISOString() }) }`,
            ),
        ).toBe(true)
        expect(only('export const HEAD = () => new Response(null, { status: 204 })', 'HEAD')).toBe(true)
        expect(
            only(
                "const ALLOW = 'GET'\nexport function OPTIONS() { return new Response(null, { headers: { allow: ALLOW } }) }",
                'OPTIONS',
            ),
        ).toBe(true)
        expect(
            only(
                "import { NextResponse } from 'next/server'\nexport function GET() { return NextResponse.json({ ok: true }) }",
            ),
        ).toBe(true)
        expect(
            only(
                'export function GET(request: Request) { const u = new URL(request.url); return new Response(u.searchParams.get("hub.challenge")) }',
            ),
        ).toBe(true)
        expect(
            only(
                'type Row = { id: string }\nexport function GET() { const rows: Row[] = []; return Response.json(rows) }',
            ),
        ).toBe(true)
        expect(tsx(`${IMPORT}export async function GET() { return Response.json({ el: <div /> }) }`).readsNothing).toBe(
            true,
        )
    })

    it('fails a name from outside it that is not inert: an import, a helper, a value that is not a literal', () => {
        for (const body of [
            'return Response.json(await load())',
            "return Response.json(await db.withTenant('t', () => 1))",
            'return Response.json({ dockets: store })',
            'return Response.json({ store })',
            'return Response.json({ ...store })',
            "return Response.json(store['depot'] ?? [])",
            'return Response.json(await query)',
            'const f = load; return Response.json(await Promise.resolve().then(f))',
            'setTimeout(load); return Response.json({})',
        ]) {
            expect(only(`${IMPORT}export async function GET() { ${body} }`), body).toBe(false)
        }
        expect(
            only('function helper() { return 1 }\nexport async function GET() { return Response.json(helper()) }'),
        ).toBe(false)
        expect(only('const cache = new Map()\nexport async function GET() { return Response.json([...cache]) }')).toBe(
            false,
        )
        expect(
            only("import { NextResponse as R } from 'next/server'\nexport function GET() { return R.json({}) }"),
        ).toBe(false)
    })

    it('fails a global that is not inert: an upstream service, the process, a module, code from a string', () => {
        for (const body of [
            "return fetch('http://data/orgs/depot/dockets')",
            'return Response.json(await (await fetch(process.env.DATA_API!)).json())',
            'return Response.json({ api: process.env.DATA_API })',
            "return Response.json(require('./db').load())",
            "return Response.json(eval('1'))",
            "return Response.json(new Function('return 1')())",
            'return Response.json(Reflect.ownKeys({}))',
            'return Response.json(globalThis.store)',
            'return Response.json(await prisma.docket.findMany())',
            'return Response.json(arguments[0])',
            'return Response.json({ m: module, e: exports, w: window, s: self, g: global })',
            "return Response.json(Object.constructor('return 1')())",
            "return Response.json(Date['constructor'])",
            "return Response.json(await import('./data'))",
            'return Response.json(import.meta.url)',
        ]) {
            expect(only(`export async function GET() { ${body} }`), body).toBe(false)
        }
        expect(only('Response = class {} as never\nexport async function GET() { return Response.json({}) }')).toBe(
            false,
        )
    })

    it('reads the handler lexically: a dead branch, a nested function and a default count', () => {
        expect(only(`${IMPORT}export async function GET() { if (false) load(); return Response.json({}) }`)).toBe(false)
        expect(only(`${IMPORT}export async function GET() { const f = () => load(); return Response.json({}) }`)).toBe(
            false,
        )
        expect(only(`${IMPORT}export async function GET(x = load()) { return Response.json({ x }) }`)).toBe(false)
    })

    it('fails a tagged template, a component, a class, a decorator or a using declaration', () => {
        expect(
            only(
                "import { sql } from '@vercel/postgres'\nexport async function GET() { return Response.json(await sql`select 1`) }",
            ),
        ).toBe(false)
        expect(
            tsx(`import { Card } from './card'\nexport async function GET() { return Response.json({ el: <Card /> }) }`)
                .readsNothing,
        ).toBe(false)
        expect(
            tsx(
                `import { Card } from './card'\nexport async function GET() { return Response.json({ el: <Card></Card> }) }`,
            ).readsNothing,
        ).toBe(false)
        expect(only('export async function GET() { class A {}; return Response.json({ a: A.name }) }')).toBe(false)
        expect(
            only(
                `${IMPORT}export async function GET() { class A { @load m() {} }; return Response.json({ a: A.name }) }`,
            ),
        ).toBe(false)
        expect(
            only('export async function GET() { using r = { [Symbol.dispose]() {} }; return Response.json({}) }'),
        ).toBe(false)
    })

    it('holds for the named imports and inert names a probe or a redirect uses', () => {
        expect(
            only(
                "import { isSimulated } from '@sssb/kit/adapters/index'\n" +
                    "export function GET() { if (!isSimulated) throw new Error('real'); return Response.json({}) }",
            ),
        ).toBe(true)
        expect(only("import { redirect } from 'next/navigation'\nexport function GET() { redirect('/sign-in') }")).toBe(
            true,
        )
        expect(
            only(
                'export function GET() { type T = string; interface I { a: T } const x: I = { a: "" }; return Response.json(x) }',
            ),
        ).toBe(true)
        expect(only('export function GET() { outer: for (;;) { break outer } return Response.json({}) }')).toBe(true)
    })

    it('fails a const whose contents the file can fill, a let, a namespace import, a const after the handler', () => {
        expect(
            only(
                "import { loadDockets } from './db'\nconst cache: Record<string, string[]> = {}\n" +
                    "export async function POST() { cache['x'] = await loadDockets(); return new Response(null) }\n" +
                    "export async function GET() { return Response.json(cache['x'] ?? []) }",
            ),
        ).toBe(false)
        expect(only('const recent: string[] = []\nexport async function GET() { return Response.json(recent) }')).toBe(
            false,
        )
        expect(only("let ALLOW = 'GET'\nexport function GET() { return Response.json({ ALLOW }) }")).toBe(false)
        expect(
            only("import * as db from './db'\nexport async function GET() { return Response.json(await db.load()) }"),
        ).toBe(false)
        expect(
            only(
                "import { load } from './db'\nexport async function GET() { return Response.json(x) }\nconst x = load()",
            ),
        ).toBe(false)
    })

    it('fails an instantiation expression, whose value a type-only skip would hide', () => {
        expect(
            only(`${IMPORT}export async function GET() { const f = load<never>; return Response.json(await f()) }`),
        ).toBe(false)
        expect(only("export async function GET() { const f = fetch<never>; return f('http://data') }")).toBe(false)
    })

    it('fails a destructured constructor, the Function constructor by another name', () => {
        expect(
            only("export function GET() { const { constructor: F } = Object; return Response.json(F('return 1')()) }"),
        ).toBe(false)
        expect(only("export function GET() { const { 'constructor': F } = Object; return Response.json(F) }")).toBe(
            false,
        )
    })

    it('fails a name bound to anything but a primitive, data hung on the handler, and a shadowed undefined', () => {
        expect(
            only(
                "import { load } from './db'\nconst f = load\nexport async function GET() { return Response.json(await f()) }",
            ),
        ).toBe(false)
        expect(only('const X = `${process.env.X}`\nexport function GET() { return Response.json({ X }) }')).toBe(false)
        expect(
            only(
                "import { load } from './db'\nexport async function GET() { return Response.json(await GET.load()) }\nGET.load = load",
            ),
        ).toBe(false)
        expect(
            only(
                "import { load } from './db'\nconst undefined = load, X = undefined\n" +
                    'export async function GET() { return Response.json(await (X as never as () => Promise<unknown>)()) }',
            ),
        ).toBe(false)
    })

    it("holds for next/navigation's other inert imports, which only throw a response", () => {
        expect(
            only(
                "import { permanentRedirect } from 'next/navigation'\nexport function GET() { permanentRedirect('/a') }",
            ),
        ).toBe(true)
        expect(only("import { notFound } from 'next/navigation'\nexport function GET() { notFound() }")).toBe(true)
    })

    it('never holds for a wrapper, whose code runs on every request out of sight', () => {
        expect(only("import { wrap } from './wrap'\nexport const GET = wrap(() => Response.json({}))")).toBe(false)
    })
})

describe('the names a read refers to from outside itself, for a reads-only gate (safeinsights/sssb#220)', () => {
    const names = (src: string, verb = 'GET') => {
        const facts = factsOf(src, verb)
        return facts.outsideNames === null ? null : [...facts.outsideNames].sort()
    }

    it('lists an import by its exported name, never a default import or a value of the file', () => {
        expect(
            names(
                "import { corsHeaders } from './cors'\nexport function GET() { return new Response(null, { headers: corsHeaders }) }",
            ),
        ).toEqual(['corsHeaders'])
        expect(
            names(
                "import pkg from './package.json'\nexport function GET() { return Response.json({ v: pkg.version }) }",
            ),
        ).toBeNull()
        expect(
            names(
                "const CORS = { allow: 'GET', methods: ['GET'] }\nexport function GET() { return Response.json({ CORS }) }",
            ),
        ).toBeNull()
        expect(names('export function GET() { return Response.json({ ok: true }) }')).toEqual([])
    })

    it("refuses every value of the route's own file but a primitive const", () => {
        for (const src of [
            "import { db } from './db'\nconst corsHeaders = db\nexport function GET() { return Response.json(corsHeaders) }",
            "import { db } from './db'\nfunction publicPosts() { return db.all() }\nexport function GET() { return Response.json(publicPosts()) }",
            "import { db } from './db'\nconst { posts } = db\nexport function GET() { return Response.json(posts) }",
            'const CORS = { at: Date.now() }\nexport function GET() { return Response.json(CORS) }',
            "const { get } = (() => { const m = new Map(); return { get: (k: string) => m.get(k) } })()\nexport function GET() { return Response.json(get('feed')) }",
        ]) {
            expect(names(src), src).toBeNull()
        }
        expect(
            factsOf('function h() { return 1 }\nexport function GET() { return Response.json(h()) }', 'GET')
                .outsideRefusal,
        ).toMatch(/a declaration of the route's own file, which code of the file can change; put it in a module/)
    })

    it('is null for a declared ambient, an import-equals, an exported or mutable name, and the handler itself', () => {
        for (const src of [
            "declare const fetch: (u: string) => Promise<Response>\nexport function GET() { return fetch('http://x') }",
            "declare function fetch(u: string): Promise<Response>\nexport function GET() { return fetch('http://x') }",
            'declare global { var process: { env: Record<string, string> } }\nexport function GET() { return Response.json(process.env) }',
            "import db = require('./db')\nexport function GET() { return Response.json(db) }",
            "export const cors = { allow: 'GET' }\nexport function GET() { return Response.json(cors) }",
            "let cors = { allow: 'GET' }\nexport function GET() { return Response.json(cors) }",
            "import { load } from './db'\nexport async function GET() { return Response.json(await (GET as never as { load: () => unknown }).load()) }\n;(GET as never as { load: unknown }).load = load",
        ]) {
            expect(names(src), src).toBeNull()
        }
        expect(
            factsOf('declare const fetch: () => Response\nexport function GET() { return fetch() }', 'GET')
                .outsideRefusal,
        ).toMatch(/declared with `declare`/)
    })

    it('is null for a listed declaration the file changes or shares outside the read', () => {
        for (const src of [
            "import { db } from './db'\nconst cache: Record<string, unknown> = {}\n;(cache as never as { db: unknown }).db = db\nexport function GET() { return Response.json(cache) }",
            "import { db } from './db'\nconst cache = new Map<string, unknown>()\nexport async function POST() { cache.set('k', await db.secret()); return Response.json({}) }\nexport function GET() { return Response.json([...cache]) }",
            'const cache = { a: 1 }\nexport { cache }\nexport function GET() { return Response.json(cache) }',
            "import { db } from './db'\nfunction f() { return 1 }\nnamespace f { export const d = db }\nexport function GET() { return Response.json(f.d) }",
        ]) {
            expect(names(src), src).toBeNull()
        }
        expect(
            factsOf(
                "import { db } from './db'\nconst box = {}\nObject.assign(box, { db })\nexport function GET() { return Response.json(box) }",
                'GET',
            ).outsideRefusal,
        ).toMatch(/`box` is a declaration of the route's own file/)
        // Shared by two handlers: each may change it, so each is refused (give each its own, or import it).
        expect(
            names(
                "const CORS = { allow: 'GET' }\nexport function GET() { return Response.json(CORS) }\nexport function OPTIONS() { return new Response(null, { headers: CORS }) }",
            ),
        ).toBeNull()
        // A type position changes nothing.
        expect(
            names(
                "const CORS = { allow: 'GET' }\nexport function GET(r?: Request) { if (!r) return CORS as never; return Response.json(CORS) }\n;(GET() as never as { db: unknown }).db = 1",
            ),
        ).toBeNull()
    })

    it('records the module each listed import comes from, and refuses a computed constructor key', () => {
        const facts = factsOf(
            "import { corsHeaders } from './cors'\nexport function GET() { return Response.json(corsHeaders) }",
            'GET',
        )
        expect([...(facts.outsideSources ?? [])]).toEqual([['corsHeaders', './cors']])
        expect(
            names("export function GET() { const { ['constructor']: F } = () => 1; return Response.json(F) }"),
        ).toBeNull()
    })

    it('is null for a handler exported by name that reads what is hung on it', () => {
        const self =
            "import { load } from './db'\n" +
            'async function handler() { return Response.json(await (handler as never as { load: () => unknown }).load()) }\n' +
            ';(handler as never as { load: unknown }).load = load\nexport { handler as GET }'
        expect(names(self)).toBeNull()
        expect(factsOf(self, 'GET').outsideRefusal).toMatch(/refers to itself/)
    })

    it('is null where no name can excuse what the handler does', () => {
        for (const src of [
            "import { corsHeaders as c } from './cors'\nexport function GET() { return Response.json(c) }",
            "import * as cors from './cors'\nexport function GET() { return Response.json(cors.headers) }",
            "export function GET() { return fetch('http://x') }",
            'export function GET() { return Response.json(process.env.X) }',
            "export async function GET() { return Response.json(await import('./x')) }",
            'export function GET() { class A {}; return Response.json(A.name) }',
            "import { wrap } from './wrap'\nexport const GET = wrap(() => Response.json({}))",
        ]) {
            expect(names(src), src).toBeNull()
        }
    })
})

describe('judging a handler against a policy', () => {
    const facts = (over: Partial<HandlerFacts>): HandlerFacts => ({
        reachesAuthorize: false,
        wrappedBy: null,
        calls: new Set(),
        opensWithSimulated404: false,
        outsideNames: null,
        outsideRefusal: null,
        outsideSources: null,
        readsNothing: false,
        ...over,
    })
    const route = (rel: string): ScannedRoute => ({ root: 'r', rel, file: `/x/${rel}`, handlers: [] })
    const policy: ScanPolicy = {
        exemptPrefixes: {
            'hooks/': { reason: 'machine caller', mustMatch: { kind: 'wrapped-by', callees: ['withSecret'] } },
        },
        exemptFiles: {
            'hooks/special/route.ts': { reason: 'port call', mustMatch: { kind: 'calls', callees: ['port.call'] } },
            'sim/route.ts': { reason: 'simulated', mustMatch: { kind: 'opens-with-simulated-404' } },
        },
        requiredAlongside: {
            'svc/': {
                reason: 'the wrapper builds the actor',
                mustMatch: { kind: 'wrapped-by', callees: ['withCaller'] },
            },
        },
        hint: 'HINT-TEXT',
    }

    it('passes a handler that reaches authorize, and fails one that does not, with the hint', () => {
        expect(
            judge(route('items/route.ts'), { verb: 'POST', facts: facts({ reachesAuthorize: true }) }, policy),
        ).toBeUndefined()
        const failure = judge(route('items/route.ts'), { verb: 'POST', facts: facts({}) }, policy)
        expect(failure).toMatch(/^r: items\/route\.ts POST exports a mutating handler that does not reach authorize/)
        expect(failure).toContain('HINT-TEXT')
        expect(
            judge(route('items/route.ts'), { verb: 'POST', facts: facts({}) }, { ...policy, hint: undefined }),
        ).not.toContain('undefined')
    })

    it('judges a read as a mutation, with its own message, and passes one that reads nothing (safeinsights/sssb#103)', () => {
        for (const verb of ['GET', 'HEAD', 'OPTIONS']) {
            expect(
                judge(route('items/route.ts'), { verb, facts: facts({ reachesAuthorize: true }) }, policy),
            ).toBeUndefined()
            const failure = judge(route('items/route.ts'), { verb, facts: facts({}) }, policy)
            expect(failure).toMatch(
                new RegExp(`^r: items/route\\.ts ${verb} exports a read handler that does not reach authorize`),
            )
            expect(failure).toContain("authorize(user, orgId, 'read', subject)")
            expect(failure).toContain('HINT-TEXT')
            expect(
                judge(route('items/route.ts'), { verb, facts: facts({ readsNothing: true }) }, policy),
            ).toBeUndefined()
        }
    })

    it('tells a read outside api/ where its exemption goes', () => {
        expect(judge(route('../feed/route.ts'), { verb: 'GET', facts: facts({}) }, policy)).toMatch(
            /under `outsideApi` \(keys relative to src\/app\), with a `reads-only` gate/,
        )
        expect(judge(route('items/route.ts'), { verb: 'GET', facts: facts({}) }, policy)).toMatch(
            /name a justified exemption, with the gate it passes, in the app's authz-exemptions\.mjs/,
        )
    })

    it('reading nothing excuses a read only: a mutation that reads nothing still authorizes', () => {
        expect(judge(route('items/route.ts'), { verb: 'POST', facts: facts({ readsNothing: true }) }, policy)).toMatch(
            /exports a mutating handler that does not reach authorize/,
        )
    })

    it('a read that reads nothing passes under an exemption whose gate it misses, but not a required gate', () => {
        expect(
            judge(route('hooks/a/route.ts'), { verb: 'GET', facts: facts({ readsNothing: true }) }, policy),
        ).toBeUndefined()
        expect(
            judge(route('svc/jobs/route.ts'), { verb: 'GET', facts: facts({ readsNothing: true }) }, policy),
        ).toMatch(/must also satisfy: the handler is itself a call to an imported withCaller/)
        expect(
            judge(route('hooks/a/route.ts'), { verb: 'GET', facts: facts({ wrappedBy: 'withSecret' }) }, policy),
        ).toBeUndefined()
        expect(judge(route('hooks/a/route.ts'), { verb: 'GET', facts: facts({}) }, policy)).toMatch(
            /sits under an exemption that holds only when/,
        )
    })

    it('fails a refused handler, whatever its path', () => {
        expect(judge(route('hooks/a/route.ts'), { verb: 'PUT', refusal: 'WHY' }, policy)).toMatch(
            /^r: hooks\/a\/route\.ts PUT cannot be checked: WHY\./,
        )
    })

    it('passes an exempted handler on its gate, or on authorize; the exemption is never a ban on authorizing', () => {
        expect(
            judge(route('hooks/a/route.ts'), { verb: 'POST', facts: facts({ wrappedBy: 'withSecret' }) }, policy),
        ).toBeUndefined()
        expect(
            judge(
                route('hooks/a/route.ts'),
                { verb: 'DELETE', facts: facts({ reachesAuthorize: true, wrappedBy: 'other' }) },
                policy,
            ),
        ).toBeUndefined()
        const failure = judge(route('hooks/a/route.ts'), { verb: 'POST', facts: facts({ wrappedBy: 'other' }) }, policy)
        expect(failure).toMatch(
            /exemption that holds only when the handler is itself a call to an imported withSecret\(…\)/,
        )
        expect(failure).not.toContain('HINT-TEXT')
    })

    it('an exact exemption wins over the prefix it sits under', () => {
        expect(exemptionFor(policy, 'hooks/special/route.ts')?.reason).toBe('port call')
        expect(exemptionFor(policy, 'hooks/other/route.ts')?.reason).toBe('machine caller')
        expect(exemptionFor(policy, '../hooks/route.ts')).toBeUndefined()
        expect(exemptionFor(policy, 'items/route.ts')).toBeUndefined()
        expect(
            judge(
                route('hooks/special/route.ts'),
                { verb: 'POST', facts: facts({ calls: new Set(['port.call']) }) },
                policy,
            ),
        ).toBeUndefined()
        expect(
            judge(route('hooks/special/route.ts'), { verb: 'POST', facts: facts({ wrappedBy: 'withSecret' }) }, policy),
        ).toBeDefined()
        expect(
            judge(route('sim/route.ts'), { verb: 'POST', facts: facts({ opensWithSimulated404: true }) }, policy),
        ).toBeUndefined()
    })

    it('requires a required-alongside gate AND authorize', () => {
        const svc = route('svc/jobs/route.ts')
        expect(
            judge(svc, { verb: 'POST', facts: facts({ reachesAuthorize: true, wrappedBy: 'withCaller' }) }, policy),
        ).toBeUndefined()
        expect(judge(svc, { verb: 'POST', facts: facts({ reachesAuthorize: true }) }, policy)).toMatch(
            /must also satisfy: the handler is itself a call to an imported withCaller\(…\).*the wrapper builds the actor/,
        )
        expect(judge(svc, { verb: 'POST', facts: facts({ wrappedBy: 'withCaller' }) }, policy)).toMatch(
            /does not reach authorize/,
        )
    })

    it('a reads-only gate holds for a read that names only the listed names, and never for a mutation', () => {
        const gate: Gate = { kind: 'reads-only', names: ['corsHeaders', 'params'] }
        const listed = facts({ outsideNames: new Set(['corsHeaders']) })
        expect(gateHolds(gate, listed, 'GET')).toBe(true)
        expect(gateHolds(gate, listed, 'OPTIONS')).toBe(true)
        expect(gateHolds(gate, facts({ outsideNames: new Set() }), 'HEAD')).toBe(true)
        expect(gateHolds(gate, listed, 'POST')).toBe(false)
        expect(gateHolds(gate, listed)).toBe(false)
        expect(gateHolds(gate, facts({ outsideNames: new Set(['corsHeaders', 'load']) }), 'GET')).toBe(false)
        expect(gateHolds(gate, facts({ outsideNames: null }), 'GET')).toBe(false)
        expect(describeGate(gate)).toMatch(
            /a read \(GET, HEAD or OPTIONS, or a page's export\) that names nothing from outside itself but inert values and `corsHeaders`, `params`/,
        )
    })

    it('a reads-only exact entry applies to reads; a mutation at its path falls to the prefix it sits under', () => {
        const withEntry: ScanPolicy = {
            ...policy,
            exemptFiles: {
                ...policy.exemptFiles,
                'hooks/meta/route.ts': { reason: 'handshake', mustMatch: { kind: 'reads-only', names: ['params'] } },
            },
        }
        expect(exemptionFor(withEntry, 'hooks/meta/route.ts', 'GET')?.reason).toBe('handshake')
        expect(exemptionFor(withEntry, 'hooks/meta/route.ts', 'POST')?.reason).toBe('machine caller')
        const read = facts({ outsideNames: new Set(['params']) })
        expect(judge(route('hooks/meta/route.ts'), { verb: 'GET', facts: read }, withEntry)).toBeUndefined()
        expect(judge(route('hooks/meta/route.ts'), { verb: 'POST', facts: read }, withEntry)).toMatch(
            /holds only when the handler is itself a call to an imported withSecret/,
        )
        expect(
            judge(route('hooks/meta/route.ts'), { verb: 'POST', facts: facts({ wrappedBy: 'withSecret' }) }, withEntry),
        ).toBeUndefined()
        // A read the entry's gate refuses is judged under the entry, not passed on the prefix's gate.
        expect(
            judge(route('hooks/meta/route.ts'), { verb: 'GET', facts: facts({ wrappedBy: 'withSecret' }) }, withEntry),
        ).toMatch(/holds only when the handler is a read/)
    })

    it('names, in the failure, what a reads-only read named or did that its gate does not allow', () => {
        const withEntry: ScanPolicy = {
            ...policy,
            exemptFiles: { 'feed/route.ts': { reason: 'feed', mustMatch: { kind: 'reads-only', names: ['posts'] } } },
        }
        expect(
            judge(
                route('feed/route.ts'),
                { verb: 'GET', facts: facts({ outsideNames: new Set(['posts', 'db']) }) },
                withEntry,
            ),
        ).toMatch(/It names `db`, which the gate does not list\./)
        expect(
            judge(
                route('feed/route.ts'),
                { verb: 'GET', facts: facts({ outsideRefusal: '`fetch` is a global off the inert list' }) },
                withEntry,
            ),
        ).toMatch(/It cannot pass one: `fetch` is a global off the inert list\./)
        // The handshake hint: only under webhooks/, the one framework prefix an app's reads-only file entry may sit under.
        const webhooks: ScanPolicy = {
            ...policy,
            exemptPrefixes: {
                'webhooks/': { reason: 'machine', mustMatch: { kind: 'wrapped-by', callees: ['withSecret'] } },
            },
        }
        expect(judge(route('webhooks/meta/route.ts'), { verb: 'GET', facts: facts({}) }, webhooks)).toMatch(
            /A read here that reads nothing org-scoped \(a provider's verification handshake\) can instead have a reads-only entry/,
        )
        expect(judge(route('webhooks/meta/route.ts'), { verb: 'POST', facts: facts({}) }, webhooks)).not.toMatch(
            /reads-only entry/,
        )
        expect(judge(route('hooks/a/route.ts'), { verb: 'GET', facts: facts({}) }, policy)).not.toMatch(
            /reads-only entry/,
        )
    })

    it('a gate holds only on the facts it names', () => {
        const wrapped: Gate = { kind: 'wrapped-by', callees: ['withA', 'withB'] }
        expect(gateHolds(wrapped, facts({ wrappedBy: 'withB' }))).toBe(true)
        expect(gateHolds(wrapped, facts({ wrappedBy: null, calls: new Set(['withA']) }))).toBe(false)
        const calls: Gate = { kind: 'calls', callees: ['a.b', 'c'] }
        expect(gateHolds(calls, facts({ calls: new Set(['c']) }))).toBe(true)
        expect(gateHolds(calls, facts({ wrappedBy: 'a.b' }))).toBe(false)
        expect(
            gateHolds(
                { kind: 'opens-with-simulated-404' },
                facts({ opensWithSimulated404: false, reachesAuthorize: true }),
            ),
        ).toBe(false)
    })

    it('describes each gate in words an author can act on', () => {
        expect(describeGate({ kind: 'wrapped-by', callees: ['withA', 'withB'] })).toBe(
            'the handler is itself a call to an imported withA(…) or withB(…), as in `export const <VERB> = withA(…)`',
        )
        expect(describeGate({ kind: 'calls', callees: ['a.b'] })).toBe(
            'the handler reaches a call to an imported a.b(…) on its own path',
        )
        expect(describeGate({ kind: 'opens-with-simulated-404' })).toMatch(
            /opens with `if \(!isSimulated\) return new Response\(null, \{ status: 404 \}\)` \(an imported `isSimulated`/,
        )
    })
})

describe('a route group is not part of the path an exemption is matched against', () => {
    it("drops a parallel route's @slot segment too, and keeps an interception marker", () => {
        const root = { exemptDir: '/app/src/app/api' }
        expect(exemptRel(root, '/app/src/app/api/@s/service/y/route.ts')).toBe('service/y/route.ts')
        expect(exemptRel(root, '/app/src/app/api/(.)service/z/route.ts')).toBe('(.)service/z/route.ts')
    })

    it('refuses a route under an intercepting segment, which Next also serves at the URL it intercepts', () => {
        for (const rel of ['(.)service/z/route.ts', 'a/(..)b/route.ts', '(...)x/route.ts', '(..)(..)x/route.ts']) {
            const [route] = scanTree({ [rel]: 'export async function GET() { return Response.json({}) }' })
            expect(route?.handlers, rel).toEqual([
                { verb: '*', refusal: expect.stringMatching(/under an intercepting segment/) },
            ])
        }
    })

    it('names the path as written in a failure when a group or slot is dropped from it', () => {
        const [route] = scanTree({
            '(internal)/x/route.ts': 'export async function POST() { return Response.json({}) }',
        })
        const policy: ScanPolicy = { exemptPrefixes: {}, exemptFiles: {}, requiredAlongside: {} }
        expect(judge(route!, route!.handlers[0]!, policy)).toMatch(
            /^case: x\/route\.ts \(at \(internal\)\/x\/route\.ts\) POST /,
        )
    })

    it('drops (name) segments inside and above the exempt directory', () => {
        const root = { exemptDir: '/app/src/app/api' }
        expect(exemptRel(root, '/app/src/app/api/(internal)/service/x/route.ts')).toBe('service/x/route.ts')
        expect(exemptRel(root, '/app/src/app/(app)/api/webhooks/a/route.ts')).toBe('webhooks/a/route.ts')
        expect(exemptRel(root, '/app/src/app/(marketing)/feed.xml/route.ts')).toBe('../feed.xml/route.ts')
        expect(exemptRel(root, '/app/src/app/api-docs/route.ts')).toBe('../api-docs/route.ts')
        expect(exemptRel(root, '/app/src/app/api/items/route.ts')).toBe('items/route.ts')
    })

    it('so a service route in a group still needs its required gate', () => {
        const routes = scanTree({
            '(internal)/service/x/route.ts': `${AUTHORIZE}${DECLS}export async function GET() { ${CALL} }`,
        })
        const required: ScanPolicy = {
            exemptPrefixes: {},
            exemptFiles: {},
            requiredAlongside: {
                'service/': { reason: 'caller', mustMatch: { kind: 'wrapped-by', callees: ['withCaller'] } },
            },
        }
        const [route] = routes
        expect(route?.rel).toBe('service/x/route.ts')
        expect(judge(route!, route!.handlers[0]!, required)).toMatch(/must also satisfy/)
    })
})

describe('the walk', () => {
    it('finds every route file name Next serves, and nothing else', () => {
        const routes = scanTree({
            'a/route.ts': '',
            'b/route.tsx': '',
            'c/route.js': '',
            'd/route.jsx': '',
            'e/route.mjs': '',
            'f/route.test.ts': '',
            'g/page.ts': '',
            'h/route.cjs': '',
        })
        expect(routes.map((r) => r.rel)).toEqual([
            'a/route.ts',
            'b/route.tsx',
            'c/route.js',
            'd/route.jsx',
            'e/route.mjs',
        ])
    })

    it('measures rel from exemptDir, so a route outside it gets a ../ path', () => {
        const routes = scanTree({ 'api/x/route.ts': '', 'page/route.ts': '' }, (dir) => ({
            exemptDir: path.join(dir, 'api'),
        }))
        expect(routes.map((r) => r.rel)).toEqual(['x/route.ts', '../page/route.ts'])
    })
})

describe('denials that float, and gate calls that never run (baseline review of 0.4.0)', () => {
    const IDS = 'declare const ids: string[]\n'
    const cases: Array<{ name: string; files: Record<string, string>; expect: Outcome }> = [
        {
            name: 'an async callback to forEach on an imported array, awaited (forEach drops its promise)',
            files: post(`await items.forEach(async () => { ${CALL} })`, "import { items } from './items'\n"),
            expect: 'open',
        },
        {
            name: "an async callback to map on an imported call's result, awaited (await does not await the array)",
            files: post(`await parse(request).ids.map(async () => { ${CALL} })`, "import { parse } from './parse'\n"),
            expect: 'open',
        },
        {
            name: 'an async mapper to Array.from, awaited',
            files: post(`await Array.from(ids, async () => { ${CALL} })`, IDS),
            expect: 'open',
        },
        {
            name: 'a sync mapper to Array.from (it runs in place)',
            files: post(`Array.from(ids, () => ${CALL})`, IDS),
            expect: 'authorized',
        },
        {
            name: 'a callback to queueMicrotask, awaited',
            files: post(`await queueMicrotask(() => { ${CALL} })`),
            expect: 'open',
        },
        {
            name: 'a callback to setTimeout, awaited',
            files: post(`await setTimeout(() => { ${CALL} }, 0)`),
            expect: 'open',
        },
        {
            name: 'a callback to process.nextTick, awaited',
            files: post(`await process.nextTick(() => { ${CALL} })`),
            expect: 'open',
        },
        {
            name: 'a function handed to Promise.resolve, awaited (it is never called)',
            files: post(`await Promise.resolve(() => { ${CALL} })`),
            expect: 'open',
        },
        {
            name: 'an awaited .catch handler (it runs only on a rejection)',
            files: post(`await request.json().catch(() => { ${CALL} })`),
            expect: 'open',
        },
        {
            name: 'an awaited .finally handler (it runs after the promise has settled)',
            files: post(`await request.json().finally(() => { ${CALL} })`),
            expect: 'open',
        },
        {
            name: 'a listener handed to an imported emitter, awaited',
            files: post(`await bus.on('x', () => { ${CALL} })`, "import { bus } from './bus'\n"),
            expect: 'open',
        },
        {
            name: 'awaited Promise.all over map with an async callback (the correct form)',
            files: post(`await Promise.all(ids.map(async () => { ${CALL} }))`, IDS),
            expect: 'authorized',
        },
        {
            name: 'returned Promise.all over map with an async callback',
            files: post(`return Promise.all(ids.map(async () => { ${CALL} }))`, IDS),
            expect: 'authorized',
        },
        {
            name: 'Promise.all over map with an async callback, not awaited',
            files: post(`void Promise.all(ids.map(async () => { ${CALL} }))`, IDS),
            expect: 'open',
        },
        {
            name: 'awaited Promise.allSettled over map with an async callback (it never rejects)',
            files: post(`await Promise.allSettled(ids.map(async () => { ${CALL} }))`, IDS),
            expect: 'open',
        },
        {
            name: 'awaited Promise.any over map with an async callback (one fulfilment is enough)',
            files: post(`await Promise.any(ids.map(async () => { ${CALL} }))`, IDS),
            expect: 'open',
        },
        {
            name: "a local Promise's all is not the global's",
            files: post(
                `await Promise.all(ids.map(async () => { ${CALL} }))`,
                `${IDS}const Promise = { all: (_x: unknown) => undefined }\n`,
            ),
            expect: 'open',
        },
        {
            name: 'a sync callback to an imported namespace forEach, awaited (trusted like any imported callee)',
            files: post(`await R.forEach(() => ${CALL})`, "import * as R from 'ramda'\n"),
            expect: 'authorized',
        },
    ]

    it.each(cases)('$name', ({ files, expect: expected }) => {
        expectVerdicts(verdicts(files), { POST: expected })
    })

    const PORT = "import { auth } from '@sssb/kit/ports/auth'\n"
    it.each([
        [
            'handed to a same-file function that never calls it',
            'never(() => auth.updateProfile())',
            'function never(_f: unknown) {}\n',
        ],
        [
            'handed to a same-file arrow that only returns it',
            'later(() => auth.updateProfile())',
            'const later = (f: () => unknown) => f\n',
        ],
        ['inside a lazy iterator map nobody consumes', '[1].values().map(() => auth.updateProfile())', ''],
        [
            'inside an async callback a same-file no-op is handed',
            'noop(async () => auth.updateProfile())',
            'const noop = (..._a: unknown[]) => {}\n',
        ],
        ['inside a generator', 'gen()', 'function* gen() { auth.updateProfile() }\n'],
    ])('a gate call %s is not on the path', (_label, body, prelude) => {
        expect(
            factsOf(`${PORT}${prelude}export async function POST() {\n${body}\nreturn new Response('ok')\n}\n`).calls,
        ).not.toContain('auth.updateProfile')
    })

    it('a gate call on the path still counts, awaited or not', () => {
        const facts = factsOf(
            `${PORT}export async function POST() {\nawait auth.updateProfile()\nreturn new Response('ok')\n}\n`,
        )
        expect(facts.calls).toContain('auth.updateProfile')
    })
})

describe('the walk through symbolic links (baseline review of 0.4.0)', () => {
    it('scans a route behind a symlinked directory at the path Next serves it from, and ends a cycle', () => {
        const dir = path.join(SCRATCH, `case-${++caseNumber}`)
        mkdirSync(path.join(dir, 'real'), { recursive: true })
        writeFileSync(
            path.join(dir, 'real/route.ts'),
            "export async function POST() { return new Response('mutated') }\n",
        )
        symlinkSync(path.join(dir, 'real'), path.join(dir, 'linked'), 'dir')
        symlinkSync(dir, path.join(dir, 'real/loop'), 'dir')
        const routes = scanRoutes([{ label: 'case', dir, exemptDir: dir }])
        expect(routes.map((route) => route.rel)).toEqual(['linked/route.ts', 'real/route.ts'])
        expect(routes.every((route) => route.handlers[0]?.facts?.reachesAuthorize === false)).toBe(true)
    })
})

describe('second pass of the baseline review of 0.4.0', () => {
    const OTEL = "import { tracer } from './otel'\nimport { wrap } from './w'\n"
    const cases: Array<{ name: string; files: Record<string, string>; expect: Outcome }> = [
        // S3: a function handed to an imported callee may run synchronously inside it, and throw out of the call.
        {
            name: 'returned from a try whose catch swallows: a span callback (a sync throw is caught)',
            files: post(
                `try { return tracer.startActiveSpan('del', () => { ${CALL}; return new Response('ok') }) } catch (e) { void e }\nreturn new Response('mutated')`,
                OTEL,
            ),
            expect: 'open',
        },
        {
            name: 'returned from a try whose catch swallows: a generic wrapper',
            files: post(`try { return wrap(() => { ${CALL} }) } catch {}\nreturn new Response('mutated')`, OTEL),
            expect: 'open',
        },
        {
            name: 'awaited in a try whose catch swallows (control, already open)',
            files: post(`try { await tracer.startActiveSpan('del', () => { ${CALL} }) } catch {}`, OTEL),
            expect: 'open',
        },
        {
            name: 'returned outside a try (still reaches)',
            files: post(`return tracer.startActiveSpan('del', () => { ${CALL}; return new Response('ok') })`, OTEL),
            expect: 'authorized',
        },
        {
            name: 'returned from a try whose catch rethrows (still reaches)',
            files: post(`try { return wrap(() => { ${CALL} }) } catch (e) { throw e }`, OTEL),
            expect: 'authorized',
        },
        // S6: an optional call on a receiver a constant makes nullish never runs its arguments.
        {
            name: 'an optional call on a const null hook',
            files: post(`hook?.(${CALL})`, 'const hook = null as null | ((x: unknown) => void)\n'),
            expect: 'open',
        },
        { name: 'an optional call on a literal null', files: post(`;(null as any)?.(${CALL})`), expect: 'open' },
        { name: 'an optional method on undefined', files: post(`;(undefined as any)?.x(${CALL})`), expect: 'open' },
        {
            name: 'an optional call on a hook that may be set (still reaches)',
            files: post(`hook?.(${CALL})`, 'declare const hook: undefined | ((x: unknown) => void)\n'),
            expect: 'authorized',
        },
    ]

    it.each(cases)('$name', ({ files, expect: expected }) => {
        expectVerdicts(verdicts(files), { POST: expected })
    })

    const SIM = "import { isSimulated } from '@sssb/kit/adapters/index'\n"
    const opens = (body: string, prelude = '') =>
        factsOf(`${SIM}${prelude}export async function POST() {\n${body}\nreturn new Response('ok')\n}\n`)
            .opensWithSimulated404

    it('S5: a constructor thrown from the simulated-mode gate must be a global Error or one of SSSB port errors', () => {
        expect(opens("if (!isSimulated) throw new PurgeTenant('all')", "import { PurgeTenant } from './jobs'\n")).toBe(
            false,
        )
        expect(opens('if (!isSimulated) throw new Purge()', "import Purge from './jobs'\n")).toBe(false)
        expect(opens('if (!isSimulated) throw new jobs.Purge()', "import * as jobs from './jobs'\n")).toBe(false)
        expect(opens("if (!isSimulated) throw new Error('x')")).toBe(true)
    })

    it('S5: a file that assigns to a global the gate builds (Error, Response, JSON) does not open with the gate', () => {
        expect(opens("if (!isSimulated) throw new Error('x')", 'Error = class {} as never\n')).toBe(false)
        expect(
            opens(
                'if (!isSimulated) return new Response(null, { status: 404 })',
                'Response = function () {} as never\n',
            ),
        ).toBe(false)
        expect(
            opens(
                'if (!isSimulated) return Response.json({ error: 1 })',
                'Response.json = (() => undefined) as never\n',
            ),
        ).toBe(false)
        expect(
            opens('if (!isSimulated) return new Response(JSON.stringify(1))', 'JSON.stringify = (() => "") as never\n'),
        ).toBe(false)
        // A local declaration of the name is not the global, and was never taken for it.
        expect(opens('if (!isSimulated) return new Response(null, { status: 404 })', 'let JSON = 1\nJSON = 2\n')).toBe(
            true,
        )
    })

    it("a directive prologue ('use strict') before the gate runs nothing, so the gate still opens the handler", () => {
        expect(opens("'use strict'\nif (!isSimulated) return new Response(null, { status: 404 })")).toBe(true)
        // ...but only a prologue: any other statement first still fails it.
        expect(opens('void 0\nif (!isSimulated) return new Response(null, { status: 404 })')).toBe(false)
    })

    // Known limits: correct code the scan refuses (fail closed). Pinned so a change to any of them is seen.
    it.each([
        {
            name: 'a module helper is not followed when a nested block declares a function of the same name',
            files: post('check()', `function check() { ${CALL} }\nif (cond) { function check() {} }\n`),
        },
        {
            name: 'a module helper is not followed when a nested loop binds a const of the same name',
            files: post('check()', `function check() { ${CALL} }\nfor (const check of [1]) { void check }\n`),
        },
    ])('known limit: $name', ({ files }) => {
        expectVerdicts(verdicts(files), { POST: 'open' })
    })

    it('known limit: a namespace merged with the handler function is refused', () => {
        const route = scanTree({
            'route.ts': `${AUTHORIZE}${DECLS}export async function POST() { ${CALL}; return new Response('ok') }\nexport namespace POST { export const maxDuration = 1 }\n`,
        }).find((r) => r.rel === 'route.ts')
        expect(route?.handlers[0]?.refusal).toBeDefined()
    })

    it('known limit: a wrapper reached through .bind is not the wrapper the gate names', () => {
        const facts = factsOf(
            "import { withWebhookSecret } from './respond'\nexport const POST = withWebhookSecret.bind(null)(async () => new Response('x'))\n",
        )
        expect(facts.wrappedBy).not.toBe('withWebhookSecret')
    })
})

describe("the fix review's verdict (X1, X2, X5-X8)", () => {
    const PORT = "import { auth } from '@sssb/kit/ports/auth'\n"
    const gateRuns = (body: string, prelude = '') =>
        factsOf(
            `${PORT}${prelude}export async function POST(body: unknown) {\n${body}\nreturn new Response('ok')\n}\n`,
        ).calls.has('auth.updateProfile')

    it('X1: a gate call counts wherever it runs, whatever a try around it does with its failure', () => {
        expect(
            gateRuns(
                "try { await auth.updateProfile(body) } catch (e) { return new Response('bad', { status: 400 }) }",
            ),
        ).toBe(true)
        expect(gateRuns('try { await auth.updateProfile(body) } finally { void 0 }')).toBe(true)
        expect(gateRuns('auth.updateProfile(body)')).toBe(true)
        expect(gateRuns('await Promise.all([1].map(async () => auth.updateProfile(body)))')).toBe(true)
        // ...and still not where it never runs.
        expect(gateRuns('never(() => auth.updateProfile(body))', 'function never(_f: unknown) {}\n')).toBe(false)
        expect(gateRuns('setTimeout(() => auth.updateProfile(body), 0)')).toBe(false)
        expect(
            gateRuns('await load().catch(() => auth.updateProfile(body))', 'declare const load: () => Promise<void>\n'),
        ).toBe(false)
        expect(
            gateRuns(
                'await load().then(undefined, () => auth.updateProfile(body))',
                'declare const load: () => Promise<void>\n',
            ),
        ).toBe(false)
    })

    const ASYNC = `async function remove(_id: string) { ${CALL} }\ndeclare const ids: string[]\n`
    const DB = "import { db } from './db'\n"
    const cases: Array<{ name: string; files: Record<string, string>; expect: Outcome }> = [
        // X2: a sync map callback under Promise.all carries what it returns.
        {
            name: 'Promise.all over a sync map callback returning the promise (expression body)',
            files: post('await Promise.all(ids.map((id) => remove(id)))', ASYNC),
            expect: 'authorized',
        },
        {
            name: 'Promise.all over a sync map callback returning the promise (block)',
            files: post('await Promise.all(ids.map((id) => { return remove(id) }))', ASYNC),
            expect: 'authorized',
        },
        {
            name: 'Promise.all over a sync map callback returning withTenant over the helper',
            files: post("await Promise.all(ids.map((id) => db.withTenant('t', () => remove(id))))", ASYNC + DB),
            expect: 'authorized',
        },
        {
            name: 'Promise.all over a sync map callback that calls without returning',
            files: post('await Promise.all(ids.map((id) => { remove(id) }))', ASYNC),
            expect: 'open',
        },
        // X5: .then's second argument is a .catch handler.
        {
            name: '.then(undefined, onRejected)',
            files: post(`await load().then(undefined, () => { ${CALL} })`, 'declare const load: () => Promise<void>\n'),
            expect: 'open',
        },
        {
            name: '.then(ok => ok, onRejected)',
            files: post(
                `await load().then((ok) => ok, () => { ${CALL} })`,
                'declare const load: () => Promise<void>\n',
            ),
            expect: 'open',
        },
        // X6: Next's after.
        {
            name: 'after() from next/server',
            files: post(`await after(() => { ${CALL} })`, "import { after } from 'next/server'\n"),
            expect: 'open',
        },
        {
            name: 'unstable_after() from next/server',
            files: post(`await unstable_after(() => { ${CALL} })`, "import { unstable_after } from 'next/server'\n"),
            expect: 'open',
        },
        // X7a: only the callback argument of an iteration method runs.
        {
            name: "forEach's thisArg function",
            files: post(`ids.forEach(() => {}, () => { ${CALL} })`, ASYNC),
            expect: 'open',
        },
        {
            name: "map's thisArg function under Promise.all",
            files: post(`await Promise.all(ids.map(async () => {}, async () => { ${CALL} }))`, ASYNC),
            expect: 'open',
        },
        // X7b: timers through the global object and Node's module.
        {
            name: 'globalThis.setTimeout',
            files: post(`await globalThis.setTimeout(() => { ${CALL} }, 0)`),
            expect: 'open',
        },
        {
            name: 'self.queueMicrotask',
            files: post(`await (self as any).queueMicrotask(() => { ${CALL} })`),
            expect: 'open',
        },
        {
            name: 'setTimeout imported from node:timers',
            files: post(`await setTimeout(() => { ${CALL} }, 0)`, "import { setTimeout } from 'node:timers'\n"),
            expect: 'open',
        },
        // From the probe rerun: a sort comparator runs in place, and Node's timers through a namespace import.
        {
            name: 'an async sort comparator',
            files: post(`ids.sort(async () => { ${CALL}; return 0 })`, ASYNC),
            expect: 'open',
        },
        {
            name: 'an async toSorted comparator',
            files: post(`ids.toSorted(async () => { ${CALL}; return 0 })`, ASYNC),
            expect: 'open',
        },
        {
            name: 'a sync sort comparator (throws in place)',
            files: post(`ids.sort(() => { ${CALL}; return 0 })`, ASYNC),
            expect: 'authorized',
        },
        {
            name: 'setTimeout through a namespace import of node:timers',
            files: post(`await timers.setTimeout(() => { ${CALL} }, 0)`, "import * as timers from 'node:timers'\n"),
            expect: 'open',
        },
        // X8: Object.entries returns an array.
        {
            name: 'Promise.all over Object.entries(m).map with an async callback',
            files: post(
                `await Promise.all(Object.entries(m).map(async ([k]) => { void k; ${CALL} }))`,
                'declare const m: Record<string, number>\n',
            ),
            expect: 'authorized',
        },
    ]

    it.each(cases)('$name', ({ files, expect: expected }) => {
        expectVerdicts(verdicts(files), { POST: expected })
    })
})

describe("the fix review's second verdict (Y3, Y5)", () => {
    it('Y3: an async callback returned from a try whose catch swallows still reaches (it cannot throw synchronously)', () => {
        const files = post(
            `try { return withPortErrors(async () => { ${CALL}; return new Response('ok') }) } catch { return new Response('', { status: 500 }) }`,
            "import { withPortErrors } from './respond'\n",
        )
        expectVerdicts(verdicts(files), { POST: 'authorized' })
    })

    it("Y5: the simulated-404 gate's description says what it refuses", () => {
        expect(describeGate({ kind: 'opens-with-simulated-404' })).toMatch(/notFound\(\)/)
        expect(describeGate({ kind: 'opens-with-simulated-404' })).toMatch(/new Response\(null, NOT_FOUND\)/)
    })
})

// ---------------------------------------------------------------------------------------------------------
// Pages, layouts and metadata routes (safeinsights/sssb#221).
// ---------------------------------------------------------------------------------------------------------

/** Writes `files` under a fresh directory and scans its pages as one root. */
function scanPageTree(files: Record<string, string>): ScannedRoute[] {
    const dir = path.join(SCRATCH, `case-${++caseNumber}`)
    for (const [rel, src] of Object.entries(files)) {
        mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true })
        writeFileSync(path.join(dir, rel), src)
    }
    return scanPages([{ label: 'case', dir, exemptDir: dir }])
}

/** What a page handler came to: authorized, reads nothing, the names it reads, or why it cannot read nothing. */
function pageState(handler: Handler): string {
    if (handler.refusal !== undefined) return `refused: ${handler.refusal}`
    const f = handler.facts
    if (f.reachesAuthorize) return 'authorized'
    if (f.readsNothing) return 'reads nothing'
    return f.outsideNames === null ? `refusal: ${f.outsideRefusal}` : `names: ${[...f.outsideNames].join(', ')}`
}

/** Each export of the tree's `page.tsx` (or `file`), with its state. */
function pageStates(files: Record<string, string>, file = 'page.tsx'): Record<string, string> {
    const page = scanPageTree(files).find((p) => p.rel === file)
    if (!page) throw new Error(`no ${file} in the case`)
    return Object.fromEntries(page.handlers.map((h) => [h.verb, pageState(h)]))
}

/** The state of the `default` export of a `page.tsx` with source `src`. */
function pageDefault(src: string, more: Record<string, string> = {}): string {
    const state = pageStates({ 'page.tsx': src, ...more })['default']
    if (state === undefined) throw new Error('no default export judged')
    return state
}

const SESSION = "import { auth } from '@sssb/kit/adapters/index'\n"
const GLUE = "import { Glue } from './glue'\n"

describe('pages, layouts and metadata routes are read handlers (safeinsights/sssb#221)', () => {
    it('finds every server-rendered special file and metadata route, with every route extension, and nothing else', () => {
        const judged = [
            'page.tsx',
            'a/layout.ts',
            'b/template.jsx',
            'c/default.js',
            'd/loading.mjs',
            'e/not-found.tsx',
            'f/forbidden.tsx',
            'g/unauthorized.tsx',
            'h/sitemap.ts',
            'robots.ts',
            'manifest.ts',
            'i/opengraph-image.tsx',
            'j/twitter-image.tsx',
            'k/icon.tsx',
            'k/icon1.tsx',
            'l/apple-icon.tsx',
        ]
        const ignored = [
            'error.tsx',
            'global-error.tsx',
            'route.ts',
            'page.test.tsx',
            'page.stories.tsx',
            'page.module.css',
            'm/icon12.tsx',
            'n/opengraph-image.png',
            'sitemap.xml',
            'o/page.mts',
            'p/glue.tsx',
        ]
        const files = Object.fromEntries(
            [...judged, ...ignored].map((f) => [f, 'export default function X() { return null }\n']),
        )
        expect(
            scanPageTree(files)
                .map((p) => p.rel)
                .sort(),
        ).toEqual([...judged].sort())
        for (const name of ['page.tsx', 'layout.mjs', 'icon1.tsx', 'sitemap.js'])
            expect(isPageFileName(name)).toBe(true)
        for (const name of ['error.tsx', 'icon12.tsx', 'page.module.css', 'route.ts'])
            expect(isPageFileName(name)).toBe(false)
    })

    it('judges the default export and the three generate functions, each by name, and nothing else Next reads', () => {
        const states = pageStates({
            'page.tsx':
                'export default function Page() { return null }\n' +
                'export async function generateMetadata() { return { title: "x" } }\n' +
                'export function generateImageMetadata() { return [] }\n' +
                'export const generateSitemaps = async () => [{ id: 0 }]\n' +
                'export function generateStaticParams() { return [] }\n' +
                'export function generateViewport() { return {} }\n' +
                "export const metadata = { title: 'x' }\nexport const revalidate = 60\nexport function helper() {}\n",
        })
        expect(states).toEqual({
            default: 'reads nothing',
            generateMetadata: 'reads nothing',
            generateImageMetadata: 'reads nothing',
            generateSitemaps: 'reads nothing',
        })
        // Each is a read, for the exemption lookup, the reads-only gate and staleness alike.
        for (const name of ['default', 'generateMetadata', 'generateImageMetadata', 'generateSitemaps', 'GET']) {
            expect(isReadVerb(name), name).toBe(true)
        }
        expect(isReadVerb('POST')).toBe(false)
    })

    it('judges a generateMetadata that reads data on its own: it authorizes or it fails', () => {
        const states = pageStates({
            'page.tsx':
                "import { loadOrg } from './data'\nexport default function Page() { return null }\n" +
                'export async function generateMetadata() { return { title: (await loadOrg()).name } }\n',
        })
        expect(states).toEqual({ default: 'reads nothing', generateMetadata: 'names: loadOrg' })
    })

    it("skips a 'use client' file, and an export whose function is in one, but not a file where the string is no directive", () => {
        expect(
            scanPageTree({
                'page.tsx': `'use client'\n${GLUE}export default function P() { return fetch('/x') }\n`,
            })[0]!.handlers,
        ).toEqual([])
        expect(
            scanPageTree({
                'page.tsx': "export { default } from './client'\n",
                'client.tsx': "'use client'\nexport default function C() { return fetch('/x') }\n",
            })[0]!.handlers,
        ).toEqual([])
        // A client file is skipped whole, even where its export could not be resolved to a function.
        expect(
            scanPageTree({ 'page.tsx': "'use client'\nlet C = () => null\nexport default C\n" })[0]!.handlers,
        ).toEqual([])
        expect(pageDefault("const x = 1\n'use client'\nexport default function P() { return fetch('/x') }\n")).toBe(
            'refusal: `fetch` is a global off the inert list',
        )
    })

    it('follows a re-exported page into its module, and refuses one it cannot read, as for a route', () => {
        expect(
            pageDefault("export { default } from './screen'\n", {
                'screen.tsx': "import { db } from './db'\nexport default async function S() { return db }\n",
            }),
        ).toBe('names: db')
        expect(pageStates({ 'page.tsx': 'export default function P( { return null }\n' })).toEqual({
            '*': expect.stringMatching(/^refused: the file does not parse/),
        })
        expect(pageDefault("export { default } from './missing'\n")).toMatch(
            /^refused: the handler is re-exported from/,
        )
        // `export *` never re-exports a default, so it gives the page none to judge, directly or through a named re-export.
        expect(
            pageDefault("export { default } from './screen'\n", {
                'screen.tsx': "export * from './inner'\n",
                'inner.tsx': 'export default function S() { return null }\n',
            }),
        ).toBe("refused: './screen' has no export named `default`")
        expect(
            scanPageTree({
                'page.tsx': "export * from './screen'\n",
                'screen.tsx': 'export default function S() { return null }\n',
            })[0]!.handlers,
        ).toEqual([])
    })

    it('passes a page that reaches authorize, whatever else it names', () => {
        expect(
            pageDefault(
                `${SESSION}${AUTHORIZE}export default async function P() {\n` +
                    "  const user = await auth.requireUser()\n  authorize(user, user.orgSlug, 'read', { type: 'Membership', orgId: user.orgSlug })\n" +
                    '  return auth.listMembers(user.orgSlug)\n}\n',
            ),
        ).toBe('authorized')
    })

    it('refuses a page under an intercepting segment, and matches one under a group or slot by its URL', () => {
        const pages = scanPageTree({
            '(.)photo/page.tsx': 'export default function P() { return null }\n',
            '(shop)/@modal/cart/page.tsx': 'export default function P() { return null }\n',
        })
        expect(pages.find((p) => p.rel === '(.)photo/page.tsx')?.handlers[0]?.refusal).toMatch(
            /the page is under an intercepting segment/,
        )
        const cart = pages.find((p) => p.rel === 'cart/page.tsx')
        expect(cart?.written).toBe('(shop)/@modal/cart/page.tsx')
        expect(cart?.page).toBe(true)
    })
})

describe('what a page may name and still read nothing: the page allow-list (safeinsights/sssb#221)', () => {
    it('passes the thin wrapper every app has: the locale, the session, a redirect, a UI ability check, a component', () => {
        expect(
            pageDefault(
                "import { setRequestLocale, getTranslations } from 'next-intl/server'\nimport { redirect } from 'next/navigation'\n" +
                    `${SESSION}import { canInActiveOrg } from '@sssb/kit/authz/authorize'\n${GLUE}` +
                    'export default async function P({ params }: { params: Promise<{ locale: string }> }) {\n' +
                    '  const { locale } = await params\n  setRequestLocale(locale)\n  const t = await getTranslations("x")\n' +
                    '  const user = await auth.getCurrentUser()\n  if (!user) redirect(`/${locale}${auth.signInPath()}`)\n' +
                    '  return <Glue title={t("title")} canCreate={canInActiveOrg(user, "create", "Item")} />\n}\n',
            ),
        ).toBe('reads nothing')
    })

    it("passes the locale layout's names: hasLocale, routing.locales, the theme, Mantine's html props, the demo flag", () => {
        expect(
            pageStates(
                {
                    'layout.tsx':
                        "import { mantineHtmlProps, MantineProvider } from '@mantine/core'\nimport { hasLocale, NextIntlClientProvider } from 'next-intl'\n" +
                        "import { getMessages } from 'next-intl/server'\nimport { notFound } from 'next/navigation'\n" +
                        "import { auth, isDemoMode, isSimulated } from '@sssb/kit/adapters/index'\nimport { routing } from '@sssb/kit/i18n/routing'\n" +
                        "import { getTenantTheme } from '@sssb/kit/theme'\nimport { sameOriginPath } from '@sssb/kit/core/same-origin-path'\n" +
                        'export default async function L({ children, params }: { children: unknown; params: Promise<{ locale: string }> }) {\n' +
                        '  const { locale } = await params\n  if (!hasLocale(routing.locales, locale)) notFound()\n' +
                        '  const user = await auth.getCurrentUser()\n  const orgs = await auth.listMyOrgs()\n  void (await auth.refusal?.())\n' +
                        '  void sameOriginPath(locale)\n  const messages = await getMessages()\n' +
                        '  return <html {...mantineHtmlProps}><body><NextIntlClientProvider messages={messages}><MantineProvider theme={getTenantTheme(user?.tenantSlug ?? "x")}>' +
                        '{isSimulated && isDemoMode ? orgs.length : children}</MantineProvider></NextIntlClientProvider></body></html>\n}\n',
                },
                'layout.tsx',
            ),
        ).toEqual({ default: 'reads nothing' })
    })

    it('holds the allow-list to the page: a route that names the same imports names them', () => {
        const route = scanTree({
            'route.ts':
                `${SESSION}import { setRequestLocale } from 'next-intl/server'\n` +
                'export async function GET() { setRequestLocale("en"); return Response.json(await auth.getCurrentUser()) }\n',
        })[0]!
        expect(pageState(route.handlers[0]!)).toBe('names: setRequestLocale, auth')
    })

    it('holds an allowed import to its exported name and its module', () => {
        expect(
            pageDefault(
                "import { setRequestLocale as s } from 'next-intl/server'\nexport default function P() { s('en'); return null }\n",
            ),
        ).toBe('refusal: `s` is an import under another name than its exported `setRequestLocale`')
        expect(
            pageDefault(
                "import { setRequestLocale } from './i18n'\nexport default function P() { setRequestLocale('en'); return null }\n",
            ),
        ).toBe('names: setRequestLocale')
    })
})

describe('a member-level allowance: `auth` only as a session read (safeinsights/sssb#221, #259)', () => {
    const page = (body: string, prelude = '') =>
        pageDefault(`${SESSION}${prelude}export default async function P() {\n${body}\n  return null\n}\n`)

    it('passes each listed member, called', () => {
        expect(
            page(
                'await auth.getCurrentUser(); await auth.requireUser(); auth.signInPath("/x"); await auth.refusal?.(); await auth.listMyOrgs()',
            ),
        ).toBe('reads nothing')
    })

    it("refuses every other member, the team's member list first, whatever an exemption could list", () => {
        expect(page('await auth.listMembers("frontline")')).toMatch(
            /^refusal: `auth\.listMembers` is used, and a page may use `auth` only as `auth\.getCurrentUser\(\)`/,
        )
        expect(page('await auth.getMember("frontline", "u")')).toMatch(/^refusal: `auth\.getMember` is used/)
    })

    it('refuses `auth` itself: passed along, aliased, spread, destructured, or reached by a computed key', () => {
        for (const body of [
            'await send(auth)',
            'const a = auth; await a.listMembers("x")',
            'const all = { ...auth }; void all',
            'const { listMembers } = auth; await listMembers("x")',
            'await auth["getCurrentUser"]()',
        ]) {
            expect(page(body, "import { send } from './send'\n"), body).toMatch(/^refusal: `auth` is used itself/)
        }
    })

    it('refuses a listed method that is not called, and a read-only member read is all `routing` may give', () => {
        expect(page('const get = auth.getCurrentUser; await get()')).toBe(
            'refusal: `auth.getCurrentUser` is used without being called, and a page may use `auth` only as ' +
                '`auth.getCurrentUser()`, `auth.listMyOrgs()`, `auth.refusal()`, `auth.requireUser()`, `auth.signInPath()`, ' +
                'since what else it reaches may be org-scoped',
        )
        const routing = "import { routing } from '@sssb/kit/i18n/routing'\n"
        expect(page('void routing.locales', routing)).toBe('reads nothing')
        expect(page('void routing.defaultLocale', routing)).toMatch(/^refusal: `routing\.defaultLocale` is used/)
        expect(page('void routing', routing)).toMatch(/^refusal: `routing` is used itself/)
    })

    it('holds the allowance to the module and the exported name', () => {
        expect(
            pageDefault(
                "import { auth } from './auth'\nexport default async function P() { await auth.getCurrentUser(); return null }\n",
            ),
        ).toBe('names: auth')
        expect(
            pageDefault(
                "import { auth as session } from '@sssb/kit/adapters/index'\nexport default async function P() { await session.getCurrentUser(); return null }\n",
            ),
        ).toBe('refusal: `session` is an import under another name than its exported `auth`')
    })
})

describe('components a page renders (safeinsights/sssb#221)', () => {
    it('passes an imported component used only as a JSX tag, by a named, default or namespace import', () => {
        expect(
            pageDefault(
                `${GLUE}import Screen from './screen'\nimport * as UI from './ui'\n` +
                    'export default function P() { return <UI.Card><Screen><Glue /></Screen></UI.Card> }\n',
            ),
        ).toBe('reads nothing')
    })

    it('counts an imported component referred to any other way: passed, called, aliased', () => {
        expect(pageDefault(`${GLUE}export default function P() { return <div render={Glue} /> }\n`)).toBe('names: Glue')
        expect(pageDefault(`${GLUE}export default function P() { return Glue({}) }\n`)).toBe('names: Glue')
        expect(pageDefault(`${GLUE}export default function P() { const C = Glue; return <C /> }\n`)).toBe('names: Glue')
    })

    it('does not read a type-only import as a component', () => {
        expect(
            pageDefault("import type { Glue } from './glue'\nexport default function P() { return <Glue /> }\n"),
        ).toBe('refusal: `Glue` is a type-only import')
    })

    it('reads a component of its own file that it renders, as part of the page, once, by the same rules', () => {
        const wrapper = (body: string, prelude = '') =>
            pageDefault(
                `${prelude}async function Wrapper({ children }: { children: unknown }) {\n${body}\n}\n` +
                    'export default function P() { return <Wrapper><Wrapper>x</Wrapper></Wrapper> }\n',
            )
        expect(wrapper('return <section>{children}</section>')).toBe('reads nothing')
        expect(wrapper('return <Wrapper>{children}</Wrapper>')).toBe('reads nothing')
        expect(
            wrapper('return <Glue rows={await db.rows()}>{children}</Glue>', `${GLUE}import { db } from './db'\n`),
        ).toBe('names: db')
        expect(wrapper('return cache.get("x")', 'const cache = new Map()\n')).toBe(
            "refusal: `cache` is a declaration of the route's own file, which code of the file can change; put it in a module and list the import",
        )
        const arrow = pageDefault(
            `${GLUE}const Shell = () => <Glue />\nexport default function P() { return <Shell /> }\n`,
        )
        expect(arrow).toBe('reads nothing')
    })

    it('refuses a component of its own file it does not only render, or that the file reassigns', () => {
        expect(
            pageDefault('function Inner() { return null }\nexport default function P() { return Inner() }\n'),
        ).toMatch(/^refusal: `Inner` is a declaration of the route's own file/)
        expect(
            pageDefault(
                'function Inner() { return null }\nInner = () => null\nexport default function P() { return <Inner /> }\n',
            ),
        ).toMatch(/^refusal: `Inner` is a declaration of the route's own file/)
        expect(pageDefault('let Inner = () => null\nexport default function P() { return <Inner /> }\n')).toMatch(
            /^refusal: `Inner` is a declaration of the route's own file/,
        )
    })

    it('holds the components to the page: a route that renders a JSX tag names its import', () => {
        const route = scanTree({ 'route.tsx': `${GLUE}export function GET() { return Response.json(<Glue />) }\n` })[0]!
        expect(pageState(route.handlers[0]!)).toBe('names: Glue')
    })
})

describe('what a page loads with import() to render it (safeinsights/sssb#221)', () => {
    it("passes the guide's real-adapter shape: destructured, awaited, alone or in Promise.all, rendered only", () => {
        expect(
            pageDefault(
                "import { isSimulated } from '@sssb/kit/adapters/index'\nimport { getTranslations } from 'next-intl/server'\n" +
                    'export default async function P() {\n  if (isSimulated) return null\n' +
                    "  const { RealMenu } = await import('@sssb/kit/adapters/real/user-menu')\n" +
                    "  const [{ RealForm }, t] = await Promise.all([import('@sssb/kit/adapters/real/sign-in-form'), getTranslations('auth')])\n" +
                    '  return <RealMenu><RealForm label={t("x")} /></RealMenu>\n}\n',
            ),
        ).toBe('reads nothing')
        // In a component of the page's own file, as a layout's provider is loaded.
        expect(
            pageDefault(
                "async function Providers({ children }: { children: unknown }) { const { Real } = await import('./real'); return <Real>{children}</Real> }\n" +
                    'export default function P() { return <Providers>x</Providers> }\n',
            ),
        ).toBe('reads nothing')
    })

    it('refuses a loaded name used any other way than as a JSX tag', () => {
        expect(
            pageDefault(
                "export default async function P() { const { load } = await import('./data'); return load() }\n",
            ),
        ).toBe(
            "refusal: `load` is loaded with `import('./data')`, and a page may use what it loads with import() only to render it as a component (a JSX tag)",
        )
    })

    it('refuses every other import(): a module object, a rename, a default, a rest, a non-literal, unawaited, a let', () => {
        for (const body of [
            "const mod = await import('./x'); return <mod.C />",
            "const { C: D } = await import('./x'); return <D />",
            "const { C = null } = await import('./x'); return <C />",
            "const { ...rest } = await import('./x'); return rest",
            "const { C } = await import(`./${'x'}`); return <C />",
            "const p = import('./x'); return p",
            "let { C } = await import('./x'); return <C />",
            "const [, { C }] = await Promise.all([...xs, import('./x')]); return <C />",
        ]) {
            expect(
                pageDefault(`export default async function P({ xs }: { xs: unknown[] }) { ${body} }\n`),
                body,
            ).toMatch(/^refusal: it loads a module with `import\(\)` other than to render what it takes from it/)
        }
    })

    it('refuses the same shape in a route: import() is a page allowance only', () => {
        const route = scanTree({
            'route.tsx':
                "export async function GET() { const { C } = await import('./x'); return Response.json(<C />) }\n",
        })[0]!
        expect(pageState(route.handlers[0]!)).toBe('refusal: it loads a module with `import()`')
    })
})

describe('judging a page against a policy (safeinsights/sssb#221)', () => {
    const facts = (overrides: Partial<HandlerFacts>): HandlerFacts => ({
        reachesAuthorize: false,
        wrappedBy: null,
        calls: new Set(),
        opensWithSimulated404: false,
        outsideNames: new Set(['findTenant']),
        outsideSources: new Map(),
        outsideRefusal: null,
        readsNothing: false,
        ...overrides,
    })
    const page = (rel: string): ScannedRoute => ({ root: 'app', rel, file: rel, handlers: [], page: true })
    const policy = (exemptions: Record<string, Gate>, required: Record<string, Gate> = {}): ScanPolicy => ({
        exemptPrefixes: Object.fromEntries(
            Object.entries(exemptions)
                .filter(([k]) => k.endsWith('/'))
                .map(([k, mustMatch]) => [k, { reason: 'r', mustMatch }]),
        ),
        exemptFiles: Object.fromEntries(
            Object.entries(exemptions)
                .filter(([k]) => !k.endsWith('/'))
                .map(([k, mustMatch]) => [k, { reason: 'r', mustMatch }]),
        ),
        requiredAlongside: Object.fromEntries(
            Object.entries(required).map(([k, mustMatch]) => [k, { reason: 'r', mustMatch }]),
        ),
        hint: 'a route-only hint',
    })

    it('fails a page that names data, saying which names, and how to authorize or exempt it', () => {
        const why = judge(page('../x/page.tsx'), { verb: 'default', facts: facts({}) }, policy({}))
        expect(why).toMatch(
            /^app: \.\.\/x\/page\.tsx default is a page export, rendered on the server for every request/,
        )
        expect(why).toMatch(/reads something: it names `findTenant`\./)
        expect(why).toMatch(/Load the data in the page and authorize there/)
        expect(why).toMatch(/`auth\.getCurrentUser\(\)`/)
        expect(why).toMatch(/under `outsideApi` \(keys relative to src\/app\), with a `reads-only` gate/)
        expect(why).not.toMatch(/a route-only hint/)
    })

    it('passes a page that authorizes, or reads nothing, with no entry', () => {
        expect(
            judge(page('../x/page.tsx'), { verb: 'default', facts: facts({ reachesAuthorize: true }) }, policy({})),
        ).toBeUndefined()
        expect(
            judge(
                page('../x/page.tsx'),
                { verb: 'default', facts: facts({ outsideNames: new Set(), readsNothing: true }) },
                policy({}),
            ),
        ).toBeUndefined()
    })

    it('applies a reads-only entry to a page, and names what it reads beyond the gate', () => {
        const gate: Gate = { kind: 'reads-only', names: ['findTenant'] }
        expect(
            judge(page('../x/page.tsx'), { verb: 'default', facts: facts({}) }, policy({ '../x/page.tsx': gate })),
        ).toBeUndefined()
        const more = judge(
            page('../x/page.tsx'),
            { verb: 'generateMetadata', facts: facts({ outsideNames: new Set(['findTenant', 'db']) }) },
            policy({ '../x/page.tsx': gate }),
        )
        expect(more).toMatch(/generateMetadata is a page export \(a read\) under an exemption that holds only when/)
        expect(more).toMatch(/: it names `db`\. List only what the page reads/)
    })

    it('applies no other gate kind to a page: a route-shaped gate proves nothing about a render', () => {
        for (const gate of [
            { kind: 'wrapped-by', callees: ['withWebhookSecret'] },
            { kind: 'calls', callees: ['findTenant'] },
            { kind: 'opens-with-simulated-404' },
        ] satisfies Gate[]) {
            const f = facts({
                wrappedBy: 'withWebhookSecret',
                calls: new Set(['findTenant']),
                opensWithSimulated404: true,
            })
            expect(
                judge(page('webhooks/x/page.tsx'), { verb: 'default', facts: f }, policy({ 'webhooks/': gate })),
                gate.kind,
            ).toMatch(/is a page export, rendered on the server/)
        }
    })

    it('requires a prefix-required gate of a page under it too', () => {
        const why = judge(
            page('service/x/page.tsx'),
            { verb: 'default', facts: facts({ reachesAuthorize: true }) },
            policy({}, { 'service/': { kind: 'wrapped-by', callees: ['withServiceCaller'] } }),
        )
        expect(why).toMatch(/^app: service\/x\/page\.tsx default must also satisfy/)
    })

    it('fails a page it could not read', () => {
        expect(judge(page('../x/page.tsx'), { verb: '*', refusal: 'the file does not parse (x)' }, policy({}))).toMatch(
            /cannot be checked: the file does not parse \(x\)\. The scan fails a handler it cannot follow/,
        )
    })
})

describe('metadata routes (safeinsights/sssb#221)', () => {
    it('passes a sitemap and a robots of literals, and names an image route renderer, which no list allows', () => {
        expect(
            pageStates(
                {
                    'sitemap.ts':
                        "export default function sitemap() { return [{ url: 'https://example.test', lastModified: new Date() }] }\n" +
                        'export async function generateSitemaps() { return [{ id: 0 }] }\n',
                },
                'sitemap.ts',
            ),
        ).toEqual({ default: 'reads nothing', generateSitemaps: 'reads nothing' })
        expect(
            pageStates({ 'robots.ts': "export default () => ({ rules: { userAgent: '*' } })\n" }, 'robots.ts'),
        ).toEqual({
            default: 'reads nothing',
        })
        expect(
            pageStates(
                {
                    'opengraph-image.tsx':
                        "import { ImageResponse } from 'next/og'\nexport default function Image() { return new ImageResponse(<div>x</div>) }\n",
                },
                'opengraph-image.tsx',
            ),
        ).toEqual({ default: 'names: ImageResponse' })
    })

    it('fails an image route that reads org data without authorizing', () => {
        expect(
            pageStates(
                {
                    'icon.tsx':
                        "import { ImageResponse } from 'next/og'\nimport { loadOrg } from './org'\n" +
                        'export default async function Icon() { return new ImageResponse(<div>{(await loadOrg()).name}</div>) }\n',
                },
                'icon.tsx',
            ),
        ).toEqual({ default: 'names: ImageResponse, loadOrg' })
    })
})
