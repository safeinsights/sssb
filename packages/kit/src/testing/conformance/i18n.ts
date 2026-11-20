import {
    isDateElement,
    isLiteralElement,
    isNumberElement,
    isPluralElement,
    isPoundElement,
    isSelectElement,
    isTagElement,
    isTimeElement,
    type MessageFormatElement,
    parse,
} from '@formatjs/icu-messageformat-parser'
import { expect } from 'vitest'
import enFramework from '../../i18n/messages/en.json'
import esFramework from '../../i18n/messages/es.json'
import { mergeMessages, type MessageTree } from '../../i18n/messages'
import { FRAMEWORK_NAMESPACES } from '../../i18n/namespaces'
import type { CheckImpl } from './types'

// The app's half of the catalog arrives through the seam, imported when a test runs rather than when the suite is
// collected, so a seam that fails to load fails its checks by name instead of the whole file.
const seamMessages = () => import('@sssb/app-config/messages')

/**
 * `i18n-partition`: the framework/app namespace partition (ADR-0012), and it is PHYSICAL: each side's catalog must
 * hold exactly its own namespaces, the two lists must be DISJOINT, and the merged catalog's top-level keys must be
 * exactly their union — so no namespace is orphaned or served twice. (en/es parity is `i18n-parity`.)
 */
export const i18nPartition: CheckImpl = {
    tests: {
        'FRAMEWORK and APP namespaces are disjoint': async () => {
            const { APP_NAMESPACES } = await seamMessages()
            const app: readonly string[] = APP_NAMESPACES
            expect(FRAMEWORK_NAMESPACES.filter((ns) => app.includes(ns))).toEqual([])
        },
        "the framework catalog's top-level keys are exactly FRAMEWORK_NAMESPACES": () => {
            expect(Object.keys(enFramework).sort()).toEqual([...FRAMEWORK_NAMESPACES].sort())
        },
        "the app catalog's top-level keys are exactly APP_NAMESPACES": async () => {
            const { APP_NAMESPACES, loadAppMessages } = await seamMessages()
            expect(Object.keys(await loadAppMessages('en')).sort()).toEqual([...APP_NAMESPACES].sort())
        },
        "the MERGED catalog's top-level keys are exactly FRAMEWORK ∪ APP": async () => {
            const { APP_NAMESPACES, loadAppMessages } = await seamMessages()
            const union = [...FRAMEWORK_NAMESPACES, ...APP_NAMESPACES].sort()
            expect(Object.keys(mergeMessages(enFramework, await loadAppMessages('en'))).sort()).toEqual(union)
        },
    },
}

function flatten(tree: MessageTree, prefix = ''): Map<string, string> {
    const out = new Map<string, string>()
    for (const [key, value] of Object.entries(tree)) {
        const at = prefix ? `${prefix}.${key}` : key
        if (typeof value === 'string') out.set(at, value)
        else for (const [k, v] of flatten(value, at)) out.set(k, v)
    }
    return out
}

/**
 * What a translation of `message` must keep, as sorted strings: each argument with its type (`count:plural`,
 * `name:argument`, `d:date`), including arguments nested inside a plural or select branch, and each tag (`<b>`).
 * Branch text is text, a quoted `'{literal}'` is text, and branch keys are not compared (Spanish and English need
 * different plural categories). It is a set: an argument used in one branch of one side and in every branch of the
 * other matches. Throws when `message` is not ICU.
 */
export function icuSignature(message: string): string[] {
    const found = new Set<string>()
    const visit = (elements: MessageFormatElement[]): void => {
        for (const element of elements) {
            if (isLiteralElement(element) || isPoundElement(element)) continue
            if (isTagElement(element)) {
                found.add(`<${element.value}>`)
                visit(element.children)
                continue
            }
            const type = isPluralElement(element)
                ? element.pluralType === 'ordinal'
                    ? 'selectordinal'
                    : 'plural'
                : isSelectElement(element)
                  ? 'select'
                  : isNumberElement(element)
                    ? 'number'
                    : isDateElement(element)
                      ? 'date'
                      : isTimeElement(element)
                        ? 'time'
                        : 'argument'
            found.add(`${element.value}:${type}`)
            if (isPluralElement(element) || isSelectElement(element)) {
                for (const option of Object.values(element.options)) visit(option.value)
            }
        }
    }
    visit(parse(message))
    return [...found].sort()
}

function signatureOrError(message: string): string[] | string {
    try {
        return icuSignature(message)
    } catch (error) {
        return `does not parse as ICU (${(error as Error).message})`
    }
}

/**
 * The `{name}` placeholder names in a value that is not ICU, sorted: what a raw pair (a value read with next-intl's
 * `t.raw()`, such as markup, JSON or a template) must still agree on.
 */
const rawPlaceholderNames = (value: string) => [...new Set([...value.matchAll(/\{(\w+)/g)].map((m) => m[1]!))].sort()

/**
 * Every way `es` is not a faithful counterpart of `en`: a key on one side only, or a message whose signature differs.
 * A pair that parses as ICU on NEITHER side is a raw value (`t.raw()`), compared by its `{name}` placeholder names
 * only; a pair that parses on exactly one side fails, naming the side that does not.
 */
export function parityProblems(en: MessageTree, es: MessageTree): string[] {
    const enFlat = flatten(en)
    const esFlat = flatten(es)
    const problems: string[] = []
    for (const key of enFlat.keys()) if (!esFlat.has(key)) problems.push(`${key}: missing from es`)
    for (const key of esFlat.keys()) if (!enFlat.has(key)) problems.push(`${key}: missing from en`)
    for (const [key, enMsg] of enFlat) {
        const esMsg = esFlat.get(key)
        if (esMsg === undefined) continue
        const enSig = signatureOrError(enMsg)
        const esSig = signatureOrError(esMsg)
        if (typeof enSig === 'string' && typeof esSig === 'string') {
            const enRaw = rawPlaceholderNames(enMsg)
            const esRaw = rawPlaceholderNames(esMsg)
            if (enRaw.join() !== esRaw.join()) {
                problems.push(
                    `${key}: a raw value (ICU on neither side) with en {${enRaw.join(', ')}}, es {${esRaw.join(', ')}}`,
                )
            }
        } else if (typeof enSig === 'string') {
            problems.push(`${key}: en ${enSig}, while es parses`)
        } else if (typeof esSig === 'string') {
            problems.push(`${key}: es ${esSig}, while en parses`)
        } else if (enSig.join() !== esSig.join()) {
            problems.push(`${key}: en has [${enSig.join(', ')}], es has [${esSig.join(', ')}]`)
        }
    }
    return problems
}

function expectParity(en: MessageTree, es: MessageTree): void {
    expect(parityProblems(en, es)).toEqual([])
}

/**
 * `i18n-parity`: en/es parity over the MERGED catalog (the framework half + the app half, which arrives through the
 * ADR-0012 seam). The catalogs are physically split, but what ships to the user is the merge — so that is what must
 * stay key- and placeholder-identical: the same arguments, each of the same type (inside plural and select
 * branches too), and the same tags (`icuSignature`). A raw value, ICU on neither side, keeps its `{name}` placeholders. The framework half is checked on its own too, so the package carries a
 * truthful guarantee independent of whatever app consumes it.
 */
export const i18nParity: CheckImpl = {
    tests: {
        'the framework catalog has identical key sets and ICU placeholders': () => {
            expectParity(enFramework, esFramework)
        },
        'the MERGED catalog (framework + app) has identical key sets and ICU placeholders': async () => {
            const { loadAppMessages } = await seamMessages()
            expectParity(
                mergeMessages(enFramework, await loadAppMessages('en')),
                mergeMessages(esFramework, await loadAppMessages('es')),
            )
        },
    },
}
