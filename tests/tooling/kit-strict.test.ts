import { readFileSync } from 'node:fs'
import path from 'node:path'
import ts from 'typescript'
import { describe, expect, test } from 'vitest'
import { STRICT_FLAGS } from '../../scripts/pack-and-consume/checks.mjs'

/**
 * The framework's compiler contract has two halves (ADR-0014 part 2): packages/kit/tsconfig.strict.json, which
 * `pnpm typecheck` runs over the package's source in this repo, and pack and consume, which turns the same
 * options on in an adopter-shaped consumer of the tarball. This holds the two to ONE list, so neither can
 * quietly promise more or less than the other.
 */
const ROOT = path.resolve(import.meta.dirname, '../..')
const CONFIG = path.join(ROOT, 'packages/kit/tsconfig.strict.json')

function strictConfig(): { compilerOptions: Record<string, unknown>; include: string[] } {
    const parsed = ts.parseConfigFileTextToJson(CONFIG, readFileSync(CONFIG, 'utf8'))
    if (parsed.error) throw new Error(ts.flattenDiagnosticMessageText(parsed.error.messageText, '\n'))
    return parsed.config as { compilerOptions: Record<string, unknown>; include: string[] }
}

describe("the framework's strict-flag contract", () => {
    test('packages/kit/tsconfig.strict.json turns on exactly pack and consume’s STRICT_FLAGS', () => {
        const { compilerOptions } = strictConfig()
        const on = Object.entries(compilerOptions)
            .filter(([key, value]) => value === true && key !== 'incremental')
            .map(([key]) => key)
        expect(on.sort()).toEqual([...STRICT_FLAGS].sort())
    })

    test('it compiles at the ES2022 lib floor, and covers the whole of the package’s src/', () => {
        const { compilerOptions, include } = strictConfig()
        expect(compilerOptions['lib']).toEqual(['dom', 'dom.iterable', 'es2022'])
        expect(include).toEqual(['src/**/*.ts', 'src/**/*.tsx'])
    })

    test('`pnpm typecheck` runs it', () => {
        const manifest = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8')) as {
            scripts: Record<string, string>
        }
        expect(manifest.scripts['typecheck']).toContain('tsc --noEmit -p packages/kit/tsconfig.strict.json')
    })
})
