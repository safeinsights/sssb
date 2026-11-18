import { existsSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { expect } from 'vitest'
import seamSpecifiers from '../seam-specifiers.json'
import type { CheckImpl } from './types'

/**
 * `seam-map`: every `@sssb/app-config/*` specifier the shipped kit source imports (../seam-specifiers.json, held equal
 * to a scan of the source by the kit's own test) resolves for this app. Two halves (ADR-0014 part 1):
 *
 * - When the app's seam is a PACKAGE (`src/app-config/package.json`, linked into the app as `@sssb/app-config`, which
 *   is how an adopter's install reaches it), each specifier resolves through that package's `exports` map to a FILE
 *   (a directory is not something an import can load). The `./*` pattern covers flat `.ts` modules only, so a
 *   directory module (`db/migrations`) or a `.tsx` one needs its own entry, and a map that forgets one fails here by
 *   name rather than at the first import. Inside SSSB's own repo the seam resolves through each app's alias, and
 *   there is no package to read.
 * - Each specifier loads when imported FROM KIT CODE. Under Vitest that import goes through the project's
 *   `@sssb/app-config` alias (the `@sssb/tools/vitest` preset sets it, as this repo's config does), never through
 *   the `exports` map, so this half proves every seam module exists and loads; that the map reaches it is the first
 *   half's to prove.
 */
const SEAM = '@sssb/app-config'

type ExportsTarget = string | null | { [condition: string]: ExportsTarget } | ExportsTarget[]

/**
 * The conditions matched, NODE'S OWN for an ES `import` of the seam (`node`, `import`, `default`): every tool that
 * imports it outside a bundler (Node, tsx, a migration script) matches exactly these, and a bundler matches them plus
 * its own (`module`, `browser`, `development`, ...), which belong to one environment and so cannot stand in for the
 * rest. `types` is never one: it resolves for the type checker only, and a target behind it loads nothing at run time.
 */
const CONDITIONS: ReadonlySet<string> = new Set(['node', 'import', 'default'])

/**
 * What resolving one target gives: a file (relative to the package), a target Node refuses (`invalid`, why; Node
 * throws ERR_INVALID_PACKAGE_TARGET), `null` for an explicit exclusion, which stops the search, or `undefined` for
 * "no condition matched", which the caller falls through.
 */
type Resolved = { file: string } | { target: string; invalid: string } | null | undefined

/** True when a path has a `.`, `..` or `node_modules` segment, percent-encoded or not, in any case (Node's rule). */
function hasInvalidSegment(value: string): boolean {
    let decoded = value
    try {
        decoded = decodeURIComponent(value)
    } catch {
        // a malformed escape: judge the raw text
    }
    return decoded.split(/[\\/]/).some((segment) => ['.', '..', 'node_modules'].includes(segment.toLowerCase()))
}

/**
 * A string target, held to Node's rules (PACKAGE_TARGET_RESOLVE): it must start with `./` (so no bare name, no `../`,
 * no absolute path or URL), and neither it (past that `./`) nor the pattern's match may have a `.`, `..` or
 * `node_modules` segment. An empty segment is only deprecated by Node, so it passes here too.
 */
function stringTarget(target: string, match: string | undefined): Resolved {
    if (!target.startsWith('./')) return { target, invalid: 'it does not start with "./"' }
    if (hasInvalidSegment(target.slice(2))) return { target, invalid: 'it has a ".", ".." or "node_modules" segment' }
    if (match === undefined) return { file: target }
    const file = target.replaceAll('*', match)
    if (hasInvalidSegment(match))
        return { target: file, invalid: 'its `*` matches a ".", ".." or "node_modules" segment' }
    return { file }
}

/**
 * A conditional export target, resolved as Node does (PACKAGE_TARGET_RESOLVE): an object's conditions in its OWN key
 * order, the first that matches and yields something winning, and one whose nested target matches no condition
 * falling through to the next; an array's items in order, an invalid or unmatched one falling through, the first
 * other result (a `null` included) winning, and the last invalid one reported when nothing else is left.
 */
function resolveTarget(target: ExportsTarget | undefined, match: string | undefined): Resolved {
    if (typeof target === 'string') return stringTarget(target, match)
    if (target === null) return null
    if (target === undefined) return undefined
    if (Array.isArray(target)) {
        let last: Resolved = null
        for (const item of target) {
            const resolved = resolveTarget(item, match)
            if (resolved === undefined) continue
            if (resolved !== null && 'invalid' in resolved) {
                last = resolved
                continue
            }
            return resolved
        }
        return last
    }
    for (const [condition, value] of Object.entries(target)) {
        if (!CONDITIONS.has(condition)) continue
        const resolved = resolveTarget(value, match)
        if (resolved !== undefined) return resolved
    }
    return undefined
}

/**
 * Node's PATTERN_KEY_COMPARE, as a sort comparator: the key with the longer prefix before its `*` first, and between
 * equal prefixes the longer key first.
 */
function patternKeyCompare(a: string, b: string): number {
    const [baseA, baseB] = [a.indexOf('*'), b.indexOf('*')]
    if (baseA !== baseB) return baseB - baseA
    return b.length - a.length
}

/**
 * Node's subpath resolution over one `exports` map (PACKAGE_IMPORTS_EXPORTS_RESOLVE): an exact key, else the first
 * pattern key (one `*`, in PATTERN_KEY_COMPARE order) that matches with a NON-EMPTY `*`; whatever that one key's
 * target resolves to is the answer, as in Node, which never tries a second pattern.
 */
function resolveExport(exportsMap: Record<string, ExportsTarget>, subpath: string): Resolved {
    if (Object.hasOwn(exportsMap, subpath) && !subpath.includes('*')) {
        return resolveTarget(exportsMap[subpath], undefined)
    }
    const patterns = Object.keys(exportsMap)
        .filter((key) => key.split('*').length === 2)
        .sort(patternKeyCompare)
    for (const key of patterns) {
        const star = key.indexOf('*')
        const [base, trailer] = [key.slice(0, star), key.slice(star + 1)]
        if (!subpath.startsWith(base) || subpath === base) continue
        if (trailer !== '' && !(subpath.endsWith(trailer) && subpath.length >= key.length)) continue
        return resolveTarget(exportsMap[key], subpath.slice(base.length, subpath.length - trailer.length))
    }
    return null
}

export const seamMap: CheckImpl = {
    tests: {
        "through the exports map of the app's seam package, when it has one": ({ appDir }) => {
            const seamDir = path.join(appDir, 'src/app-config')
            const manifestFile = path.join(seamDir, 'package.json')
            if (!existsSync(manifestFile)) return
            const manifest = JSON.parse(readFileSync(manifestFile, 'utf8')) as {
                name?: unknown
                exports?: unknown
            }
            const problems: string[] = []
            if (manifest.name !== SEAM) problems.push(`src/app-config/package.json is named ${String(manifest.name)}`)
            const exportsMap =
                typeof manifest.exports === 'object' && manifest.exports !== null && !Array.isArray(manifest.exports)
                    ? (manifest.exports as Record<string, ExportsTarget>)
                    : undefined
            if (!exportsMap) problems.push('src/app-config/package.json has no `exports` map')
            else {
                for (const specifier of seamSpecifiers.specifiers) {
                    const subpath = `.${specifier.slice(SEAM.length)}`
                    const resolved = resolveExport(exportsMap, subpath)
                    if (resolved === null || resolved === undefined) {
                        problems.push(
                            `${specifier}: no \`exports\` entry for ${subpath} that resolves under the conditions ` +
                                `${[...CONDITIONS].join(', ')}`,
                        )
                    } else if ('invalid' in resolved) {
                        problems.push(
                            `${specifier}: \`exports\` maps ${subpath} to ${resolved.target}, which Node refuses: ` +
                                `${resolved.invalid} (ERR_INVALID_PACKAGE_TARGET)`,
                        )
                    } else if (!statSync(path.join(seamDir, resolved.file), { throwIfNoEntry: false })?.isFile()) {
                        problems.push(
                            `${specifier}: \`exports\` maps ${subpath} to ${resolved.file}, which is not a file`,
                        )
                    }
                }
            }
            expect(problems, problems.join('\n')).toEqual([])
        },
        "from the kit's own code": async () => {
            const problems: string[] = []
            for (const specifier of seamSpecifiers.specifiers) {
                try {
                    await import(/* @vite-ignore */ specifier)
                } catch (error) {
                    problems.push(`${specifier}: ${error instanceof Error ? error.message : String(error)}`)
                }
            }
            expect(problems).toEqual([])
        },
    },
}
