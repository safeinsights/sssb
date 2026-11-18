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
 * The file a conditional export target names, resolved as Node does (PACKAGE_TARGET_RESOLVE): an object's conditions
 * in its OWN key order, the first that matches and yields something winning, and one whose nested target matches no
 * condition falling through to the next. `undefined` is "nothing matched" (the caller falls through); `null` is an
 * explicit exclusion, which stops the search.
 */
function targetFile(target: ExportsTarget | undefined): string | null | undefined {
    if (typeof target === 'string') return target
    if (target === null) return null
    if (target === undefined) return undefined
    if (Array.isArray(target)) {
        for (const item of target) {
            const file = targetFile(item)
            if (file !== undefined) return file
        }
        return undefined
    }
    for (const [condition, value] of Object.entries(target)) {
        if (!CONDITIONS.has(condition)) continue
        const file = targetFile(value)
        if (file !== undefined) return file
    }
    return undefined
}

/** Node's subpath resolution over one `exports` map: an exact key, else the matching pattern with the longest prefix. */
function resolveExport(exportsMap: Record<string, ExportsTarget>, subpath: string): string | null {
    if (Object.hasOwn(exportsMap, subpath)) return targetFile(exportsMap[subpath]) ?? null
    let best: { key: string; match: string } | undefined
    for (const key of Object.keys(exportsMap)) {
        const star = key.indexOf('*')
        if (star < 0) continue
        const [before, after] = [key.slice(0, star), key.slice(star + 1)]
        if (!subpath.startsWith(before) || !subpath.endsWith(after) || subpath.length < key.length - 1) continue
        if (!best || before.length > best.key.indexOf('*')) {
            best = { key, match: subpath.slice(before.length, subpath.length - after.length) }
        }
    }
    if (!best) return null
    const file = targetFile(exportsMap[best.key])
    return file === null || file === undefined ? null : file.replaceAll('*', best.match)
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
                    const target = resolveExport(exportsMap, subpath)
                    if (target === null) {
                        problems.push(
                            `${specifier}: no \`exports\` entry for ${subpath} that resolves under the conditions ` +
                                `${[...CONDITIONS].join(', ')}`,
                        )
                    } else if (!statSync(path.join(seamDir, target), { throwIfNoEntry: false })?.isFile()) {
                        problems.push(`${specifier}: \`exports\` maps ${subpath} to ${target}, which is not a file`)
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
