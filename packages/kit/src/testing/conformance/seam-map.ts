import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { expect } from 'vitest'
import seamSpecifiers from '../seam-specifiers.json'
import type { CheckImpl } from './types'

/**
 * `seam-map`: every `@sssb/app-config/*` specifier the shipped kit source imports (../seam-specifiers.json, held equal
 * to a scan of the source by the kit's own test) resolves for this app. Two halves (ADR-0014 part 1):
 *
 * - When the app's seam is a PACKAGE (`src/app-config/package.json`, linked into the app as `@sssb/app-config`, which
 *   is how an adopter's install reaches it), each specifier resolves through that package's `exports` map to a file
 *   that exists. The `./*` pattern covers flat `.ts` modules only, so a directory module (`db/migrations`) or a
 *   `.tsx` one needs its own entry, and a map that forgets one fails here by name rather than at the first import.
 *   Inside SSSB's own repo the seam resolves through each app's alias, and there is no package to read.
 * - Each specifier loads when imported FROM KIT CODE, which is where resolution happens under a pnpm link: from the
 *   kit's own directory, through its peer link to this app's seam.
 */
const SEAM = '@sssb/app-config'

type ExportsTarget = string | null | { [condition: string]: ExportsTarget } | ExportsTarget[]

/** The first file a conditional export target names, preferring the conditions a bundler or Node would use. */
function targetFile(target: ExportsTarget | undefined): string | null {
    if (typeof target === 'string') return target
    if (target === null || target === undefined) return null
    if (Array.isArray(target)) {
        for (const item of target) {
            const file = targetFile(item)
            if (file !== null) return file
        }
        return null
    }
    for (const condition of ['import', 'default', 'types', 'node']) {
        if (condition in target) return targetFile(target[condition])
    }
    return null
}

/** Node's subpath resolution over one `exports` map: an exact key, else the matching pattern with the longest prefix. */
function resolveExport(exportsMap: Record<string, ExportsTarget>, subpath: string): string | null {
    if (Object.hasOwn(exportsMap, subpath)) return targetFile(exportsMap[subpath])
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
    return file === null ? null : file.replaceAll('*', best.match)
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
                    if (target === null) problems.push(`${specifier}: no \`exports\` entry for ${subpath}`)
                    else if (!existsSync(path.join(seamDir, target))) {
                        problems.push(`${specifier}: \`exports\` maps ${subpath} to ${target}, which does not exist`)
                    }
                }
            }
            expect(problems).toEqual([])
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
