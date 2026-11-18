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

const icuArgs = (msg: string) => [...msg.matchAll(/\{(\w+)/g)].map((m) => m[1]).sort()

function expectParity(en: MessageTree, es: MessageTree): void {
    const enFlat = flatten(en)
    const esFlat = flatten(es)
    expect([...esFlat.keys()].sort()).toEqual([...enFlat.keys()].sort())
    for (const [key, enMsg] of enFlat) {
        const esMsg = esFlat.get(key)
        if (esMsg !== undefined) expect.soft(icuArgs(esMsg), key).toEqual(icuArgs(enMsg))
    }
}

/**
 * `i18n-parity`: en/es parity over the MERGED catalog (the framework half + the app half, which arrives through the
 * ADR-0012 seam). The catalogs are physically split, but what ships to the user is the merge — so that is what must
 * stay key- and placeholder-identical. The framework half is checked on its own too, so the package carries a
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
