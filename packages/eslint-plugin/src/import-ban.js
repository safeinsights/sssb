// HOW AN IMPORT FENCE SEES A SPECIFIER, in both of its halves.
//
// The declaration half (declarationImportBan) replaces what no-restricted-imports used to carry, and matches a
// pattern as that rule does (eslint's lib/rules/no-restricted-imports.js): a `group` through the `ignore` package
// with `allowRelativePaths: true` and `ignorecase` (no pattern here sets caseSensitive), a `regex` as a RegExp with
// the `iu` flags, and the specifier trimmed. It visits what that rule visits: import declarations, re-exports with a
// source, and TypeScript's `import m = require('…')`. One difference, a tightening: ESLint trims the specifier of
// import and export declarations only, and this half trims `import m = require(' x')`'s too. That includes the group syntax's quirks:
// a bare name matches at any depth, so core's `react` also bans `@x/react` and `./react`, and `pg` bans `./pg`.
//
// The declarationless half (declarationlessImportBan) sees what no declaration rule can: `import()`, `require()`,
// vitest/jest's `importActual`, `requireActual`, `importMock` and `requireMock`, and a type-position `import('…')`
// (TSImportType). `import type { T } from '…'` is a declaration, and the inline type form is an import too.
// NOT covered: `vi.mock`/`vi.doMock` and jest's. A mock names a module and, given a factory, never loads it; the
// module under test that imports it is what both halves catch. Out of reach of both, as of every import rule: a
// computed specifier (`import(name)`), and a require not called by that name (`createRequire(…)(…)`,
// `module.require(…)`).
//
// Both halves match a specifier as written and cut at a resource query or hash (`pg?raw`), and report EVERY pattern
// either reading matches, one finding each, with that pattern's message, as
// no-restricted-imports did. Neither factory takes options. The two vendor rules wrap them and take `{ vendors }`
// (./rules.js), which a later block could replace; `sssb check-fences` compares those options exactly with the
// preset's, and every other import fence takes none.
import ignore from 'ignore'

const patternMatcher = (pattern) => {
    if (pattern.regex) {
        const regex = new RegExp(pattern.regex, 'iu')
        return (specifier) => regex.test(specifier)
    }
    const matcher = ignore({ allowRelativePaths: true, ignorecase: true }).add(pattern.group)
    return (specifier) => matcher.ignores(specifier)
}
/** The message of every pattern a specifier matches. */
export const matchesPatterns = (patterns) => {
    const matchers = patterns.map((pattern) => ({ test: patternMatcher(pattern), message: pattern.message }))
    return (specifier) => matchers.filter(({ test }) => test(specifier)).map(({ message }) => message)
}

// A bundler's resource query or hash (`pg?raw`, `@aws-sdk/client-s3#x`) names the package all the same, so a specifier
// is matched both as written and cut at its first `?` or `#` (by index, never a regex retried from every `?`). A
// leading one (index 0) is not a query, and leaves the specifier as written.
const readingsOf = (specifier) => {
    const cut = specifier.search(/[?#]/)
    return cut > 0 ? [specifier, specifier.slice(0, cut)] : [specifier]
}
/** What `matches` returns for any reading of the specifier, each once. */
const matchesAnyReading = (matches, specifier) => [
    ...new Set(readingsOf(specifier).flatMap((reading) => matches(reading))),
]

/** The specifier a node holds: a string literal, or a template literal with no expressions; else undefined. */
export const literalSpecifier = (node) =>
    node?.type === 'Literal'
        ? node.value
        : node?.type === 'TemplateLiteral' && node.expressions.length === 0
          ? node.quasis[0].value.cooked
          : undefined

/** Every place a specifier is named outside an import or export declaration, each handed to `check`. */
export const declarationlessVisitors = (check) => ({
    ImportExpression: (node) => check(node.source),
    TSImportType: (node) => check(node.source),
    'CallExpression[callee.name="require"]': (node) => check(node.arguments[0]),
    // A test inside the fence loads the real module with these, exactly as with import().
    'CallExpression[callee.object.name=/^(vi|jest)$/][callee.property.name=/^(importActual|requireActual|importMock|requireMock)$/]':
        (node) => check(node.arguments[0]),
})

/** Every declaration that names a specifier, each handed to `check` with the node to report. */
export const declarationVisitors = (check) => ({
    ImportDeclaration: (node) => check(node, node.source),
    ExportNamedDeclaration: (node) => node.source && check(node, node.source),
    ExportAllDeclaration: (node) => check(node, node.source),
    TSImportEqualsDeclaration: (node) =>
        node.moduleReference.type === 'TSExternalModuleReference' && check(node, node.moduleReference.expression),
})

/**
 * A declaration that is type-only as a whole (`import type …`, `export type … from`, `export type * from`,
 * `import type x = require(…)`): TypeScript erases it under every setting, so it loads nothing. An inline
 * `import { type X } from …` is not one: under `verbatimModuleSyntax` it is emitted as `import {} from …`, which loads
 * the module.
 * @param {any} node
 */
const isTypeOnly = (node) => node.importKind === 'type' || node.exportKind === 'type'

/**
 * A fence over import and export DECLARATIONS: one finding per matching pattern, reported on the declaration with
 * the pattern's own message. `allowTypeOnly` lets a type-only declaration through, for a fence about what a module
 * LOADS rather than what it may name.
 * @returns {import('eslint').Rule.RuleModule}
 */
export const declarationImportBan = ({ description, patterns, allowTypeOnly = false }) => {
    const matches = matchesPatterns(patterns)
    return {
        meta: {
            type: 'problem',
            docs: { description },
            schema: [],
            messages: { banned: "'{{specifier}}' import is restricted from being used by a pattern. {{rule}}" },
        },
        create(context) {
            return declarationVisitors((node, source) => {
                if (allowTypeOnly && isTypeOnly(node)) return
                const specifier = literalSpecifier(source)
                if (typeof specifier !== 'string') return
                for (const rule of matchesAnyReading(matches, specifier.trim())) {
                    context.report({ node, messageId: 'banned', data: { specifier: specifier.trim(), rule } })
                }
            })
        },
    }
}

/**
 * A fence over everything a declaration ban cannot see. `what` names the thing the specifier is; `matches` returns
 * the fence's own sentence for each pattern a banned specifier matches, and nothing for an allowed one.
 * @returns {import('eslint').Rule.RuleModule}
 */
export const declarationlessImportBan = ({ description, what, matches }) => ({
    meta: {
        type: 'problem',
        docs: { description },
        schema: [],
        messages: {
            banned:
                `\`{{specifier}}\` is ${what}, and reaching it with import() or require(), or naming it in a type ` +
                "import('…'), is still importing it. {{rule}}",
        },
    },
    create(context) {
        return declarationlessVisitors((node) => {
            const specifier = literalSpecifier(node)
            if (typeof specifier !== 'string') return
            for (const rule of matchesAnyReading(matches, specifier.trim())) {
                context.report({ node, messageId: 'banned', data: { specifier, rule } })
            }
        })
    },
})

/**
 * A fence over syntax: one esquery selector per message, each its own messageId, in a rule with its own id.
 * @param {{ description: string, selectors: Record<string, { selector: string, message: string }> }} spec
 * @returns {import('eslint').Rule.RuleModule}
 */
export const syntaxBan = ({ description, selectors }) => ({
    meta: {
        type: 'problem',
        docs: { description },
        schema: [],
        messages: Object.fromEntries(Object.entries(selectors).map(([id, { message }]) => [id, message])),
    },
    create(context) {
        return Object.fromEntries(
            Object.entries(selectors).map(([messageId, { selector }]) => [
                selector,
                (node) => context.report({ node, messageId }),
            ]),
        )
    },
})
