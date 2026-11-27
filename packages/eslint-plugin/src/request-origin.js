// THE REQUEST'S OWN URL, followed from where it is made to where it is sent on: the URL half of
// sssb/no-raw-request-origin (./rules.js; the header half is ./patterns.js's visitorHeaderSelector). Behind SssbApp,
// `request.url` and `nextUrl` name the server's own bind address and port, never the visitor's host, so an absolute
// URL built on them is wrong wherever a visitor or a third party sees it. Its path and search parameters are right.
//
// A selector cannot follow a variable, a TypeScript wrapper or "every use of this is harmless", so this is a visitor
// over the scope manager's references. What it starts from (a SOURCE), on an object named like a request
// (REQUEST_NAMED: `req`, `request`, `nextRequest`, `_req`, `ctx.request`; `session.url` and `pullRequest.url` are not):
// - the request's whole URL: a one-argument `new URL(<req>.url)` (or `new URL(<x>.nextUrl)`), `<x>.nextUrl` on any
//   object (only a NextRequest has one; into a redirect, though, only `<req>.nextUrl`, so a router's `state.nextUrl`
//   passes), and `<x>.nextUrl.clone()` (or `nextUrl.clone()`, Next's idiom for a same-host redirect with a new path);
// - `<req>.url`, the same URL as a string;
// - `new URL(path, <the request's URL>)`, an absolute URL on the server's own host.
// What it reports (a SINK), through `!`, `as`, `satisfies`, `<T>` and `?.` on either side, and through any chain of
// `const` aliases (or a `let`/`var` never written again):
// - a `redirect`, `rewrite` or `permanentRedirect` (by member or by name) given it, or a string of it, as its first
//   argument, except in the app's proxy (PROXY_FILE), where Next relativizes a same-origin Location however it was
//   built (`next/dist/server/web/adapter.js`); a route handler's sends the visitor to the server's bind address;
// - a string of the whole URL: `String(u)`, `u.toString()`, `u.toJSON()`, `${u}`, `u + ''` (a `+` with a string
//   literal or template on the other side), `u.href`; and its `origin`, `host` or `hostname` read, by member or
//   destructuring;
// - `new URL(path, u)`; `baseUrl: u` (or `baseUrl: request.url`), the argument SSSB's `sendOrgInvite` and
//   `applyDemoPreset` take.
// `new URL(path, <the request's URL>)` is reported where it is made, except in the proxy, where it is allowed when
// every use of it is a redirect's (or rewrite's) first argument, its string handed to one, or its path and search
// parameters (`login.searchParams.set(...)`). Outside the proxy a `nextUrl.clone()` that is not a variable's initial
// value is reported where it is made: `Response.redirect(request.nextUrl.clone())`.
// Not reported: the string `request.url` anywhere except a redirect or `baseUrl` (a log line, nearly always), and a
// whole URL's path and search parameters, read or written. Still uncaught, as any alias the rule cannot see: a whole
// URL handed to a function of the app's own, returned, stored in an object, an array or a class field, a default
// parameter, a variable reassigned (`let u = ...; u = ...`) or first assigned outside its declaration, a destructured
// `nextUrl` (except its `clone()`), `JSON.stringify` or `Response.json` of it (its `toJSON` called for you), a copy
// (`new URL(u)`), a computed member (`u['origin']`), and a request held under a name REQUEST_NAMED does not match
// (`incoming.url`).
import { PROXY_FILE } from './patterns.js'

const REQUEST_NAMED = /^_?(req|request|nextRequest)$/i
const REDIRECT_NAME = /^(redirect|rewrite|permanentRedirect)$/
const ORIGIN_PART = /^(origin|host|hostname)$/
const PATH_PART = /^(pathname|search|searchParams|hash)$/
const WRAPPERS = new Set([
    'TSNonNullExpression',
    'TSAsExpression',
    'TSSatisfiesExpression',
    'TSTypeAssertion',
    'ChainExpression',
    'ParenthesizedExpression',
])
const MAX_ALIASES = 8

const unwrap = (node) => {
    while (node && WRAPPERS.has(node.type)) node = node.expression
    return node
}
/** The outermost wrapper around `node`, the node its real parent holds. */
const outermost = (node) => {
    while (node.parent && WRAPPERS.has(node.parent.type) && node.parent.expression === node) node = node.parent
    return node
}
const keyName = (node) =>
    node.computed ? undefined : node.key?.type === 'Identifier' ? node.key.name : node.key?.value
const memberName = (node) =>
    node?.type === 'MemberExpression' && !node.computed && node.property.type !== 'PrivateIdentifier'
        ? node.property.name
        : undefined
const isRequestNamed = (node) => {
    const target = unwrap(node)
    if (target?.type === 'Identifier') return REQUEST_NAMED.test(target.name)
    return REQUEST_NAMED.test(memberName(target) ?? '')
}
const isUrlConstructor = (node) =>
    node?.type === 'NewExpression' && node.callee.type === 'Identifier' && node.callee.name === 'URL'
const isRedirectCallee = (callee) => {
    const target = unwrap(callee)
    return REDIRECT_NAME.test(target?.type === 'Identifier' ? target.name : (memberName(target) ?? ''))
}
const isStringLiteral = (node) =>
    (node?.type === 'Literal' && typeof node.value === 'string') || node?.type === 'TemplateLiteral'

/** `<req>.url`, the request's URL as a string. */
const isRequestUrlString = (node) => {
    const target = unwrap(node)
    return memberName(target) === 'url' && isRequestNamed(target.object)
}
/**
 * The request's whole URL as a URL, or undefined: `{ clone, named }`, `named` when a redirect may take it for the
 * request's (an `<x>.nextUrl` on an object not named like a request is not).
 */
const wholeUrl = (node) => {
    const target = unwrap(node)
    if (memberName(target) === 'nextUrl') return { clone: false, named: isRequestNamed(target.object) }
    if (isUrlConstructor(target) && target.arguments.length === 1) {
        const [arg] = target.arguments
        if (isRequestUrlString(arg)) return { clone: false, named: true }
        if (memberName(unwrap(arg)) === 'nextUrl') return { clone: false, named: true }
    }
    if (
        target?.type === 'CallExpression' &&
        target.arguments.length === 0 &&
        memberName(unwrap(target.callee)) === 'clone'
    ) {
        const of = unwrap(unwrap(target.callee).object)
        if (memberName(of) === 'nextUrl' || (of?.type === 'Identifier' && of.name === 'nextUrl'))
            return { clone: true, named: true }
    }
    return undefined
}
/** `new URL(path, <the request's URL>)`. */
const isUrlOnRequest = (node) =>
    isUrlConstructor(node) &&
    node.arguments.length === 2 &&
    (isRequestUrlString(node.arguments[1]) || wholeUrl(node.arguments[1]) !== undefined)

/**
 * Where the value at `node` goes, as a list of `{ kind, node }`: `redirect` (a redirect's first argument, directly or
 * as a string), `string`, `origin`, `base` (the base of a `new URL(path, it)`), `baseUrl`, `path` (its path or search
 * parameters, read or written) or `unknown`. A variable's initial value is followed to each of its references.
 */
function sinksOf(node, sourceCode, depth = 0) {
    const top = outermost(node)
    const parent = top.parent
    const stringOf = (stringNode) => {
        const at = outermost(stringNode)
        const call = at.parent
        return call?.type === 'CallExpression' && call.arguments[0] === at && isRedirectCallee(call.callee)
            ? [{ kind: 'redirect', node: call }]
            : [{ kind: 'string', node: stringNode }]
    }
    switch (parent?.type) {
        case 'CallExpression':
            if (parent.arguments[0] !== top) return [{ kind: 'unknown', node: top }]
            if (isRedirectCallee(parent.callee)) return [{ kind: 'redirect', node: parent }]
            if (parent.callee.type === 'Identifier' && parent.callee.name === 'String' && parent.arguments.length === 1)
                return stringOf(parent)
            return [{ kind: 'unknown', node: top }]
        case 'MemberExpression': {
            if (parent.object !== top) return [{ kind: 'unknown', node: top }]
            const name = memberName(parent)
            const use = parent.parent
            const written =
                (use.type === 'AssignmentExpression' && use.left === parent) ||
                (use.type === 'UpdateExpression' && use.argument === parent) ||
                (use.type === 'UnaryExpression' && use.operator === 'delete')
            if (name === 'toString' || name === 'toJSON')
                return use.type === 'CallExpression' && use.callee === parent
                    ? stringOf(use)
                    : [{ kind: 'unknown', node: top }]
            if (written || PATH_PART.test(name ?? '')) return [{ kind: 'path', node: parent }]
            if (name === 'href') return stringOf(parent)
            if (ORIGIN_PART.test(name ?? '')) return [{ kind: 'origin', node: parent }]
            return [{ kind: 'unknown', node: top }]
        }
        case 'TemplateLiteral':
            return stringOf(parent)
        case 'BinaryExpression': {
            const other = parent.left === top ? parent.right : parent.left
            return parent.operator === '+' && isStringLiteral(unwrap(other))
                ? stringOf(parent)
                : [{ kind: 'unknown', node: top }]
        }
        case 'NewExpression':
            return isUrlConstructor(parent) && parent.arguments.length === 2 && parent.arguments[1] === top
                ? [{ kind: 'base', node: parent }]
                : [{ kind: 'unknown', node: top }]
        case 'Property':
            return parent.value === top && parent.parent.type === 'ObjectExpression' && keyName(parent) === 'baseUrl'
                ? [{ kind: 'baseUrl', node: parent }]
                : [{ kind: 'unknown', node: top }]
        case 'VariableDeclarator':
            if (parent.init !== top) return [{ kind: 'unknown', node: top }]
            if (parent.id.type === 'ObjectPattern')
                return parent.id.properties.map((property) =>
                    property.type !== 'Property'
                        ? { kind: 'unknown', node: property }
                        : ORIGIN_PART.test(keyName(property) ?? '') || keyName(property) === 'href'
                          ? { kind: 'origin', node: property }
                          : PATH_PART.test(keyName(property) ?? '')
                            ? { kind: 'path', node: property }
                            : { kind: 'unknown', node: property },
                )
            if (parent.id.type !== 'Identifier' || depth >= MAX_ALIASES) return [{ kind: 'unknown', node: top }]
            return referencesOf(parent, sourceCode).flatMap((id) =>
                id ? sinksOf(id, sourceCode, depth + 1) : [{ kind: 'unknown', node: parent }],
            )
        default:
            return [{ kind: 'unknown', node: top }]
    }
}
/** The identifiers that read a declarator's variable; `[undefined]` when it is written again after its initial value. */
function referencesOf(declarator, sourceCode) {
    const [variable] = sourceCode.getDeclaredVariables(declarator)
    if (!variable || variable.references.some((ref) => ref.isWrite() && !ref.init)) return [undefined]
    return variable.references.filter((ref) => !ref.init && ref.isRead()).map((ref) => ref.identifier)
}
const followed = (node) => {
    const parent = outermost(node).parent
    return parent?.type === 'VariableDeclarator' && parent.init === outermost(node) && parent.id.type === 'Identifier'
}

/** The URL half of sssb/no-raw-request-origin: visitors that report with messageId `origin`. */
export function requestUrlVisitors(context) {
    const inProxy = PROXY_FILE.test(context.filename)
    const { sourceCode } = context
    const seen = new Set()
    const report = (node) => {
        if (seen.has(node)) return
        seen.add(node)
        context.report({ node, messageId: 'origin' })
    }
    /** `new URL(path, <request URL>)`, made directly or on a variable that holds the whole URL. */
    const urlOnRequest = (node) => {
        if (!inProxy) return report(node)
        const sinks = sinksOf(node, sourceCode)
        if (!sinks.every(({ kind }) => kind === 'redirect' || kind === 'path')) report(node)
    }
    /** The whole URL at `node`, `named` when a redirect may take it for the request's. */
    const whole = (node, { clone, named }) => {
        if (clone && !inProxy && !followed(node)) return report(node)
        for (const sink of sinksOf(node, sourceCode)) {
            if (sink.kind === 'redirect' && !inProxy && named) report(sink.node)
            else if (sink.kind === 'string' || sink.kind === 'origin' || sink.kind === 'baseUrl') report(sink.node)
            // A `new URL(path, <the whole URL>)` made directly is its own source; one made on a variable is not.
            else if (sink.kind === 'base' && sink.node.arguments[1] !== outermost(node)) urlOnRequest(sink.node)
        }
    }
    const urlString = (node) => {
        for (const sink of sinksOf(node, sourceCode))
            if ((sink.kind === 'redirect' && !inProxy) || sink.kind === 'baseUrl') report(sink.node)
    }
    return {
        MemberExpression(node) {
            if (isRequestUrlString(node)) return urlString(node)
            const found = wholeUrl(node)
            if (found) whole(node, found)
        },
        NewExpression(node) {
            if (isUrlOnRequest(node)) return urlOnRequest(node)
            const found = wholeUrl(node)
            if (found) whole(node, found)
        },
        CallExpression(node) {
            const found = wholeUrl(node)
            if (found) whole(node, found)
        },
    }
}
