import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { makeTestTmpDir } from './tmp-dir'

/**
 * The seam guard of the build that compiles `@sssb/kit/testing/e2e` (scripts/build-testing-e2e.mjs), run as `pnpm
 * pack` runs it, on the real entry and on scratch entries that try to reach a module past it. Every build writes to a
 * scratch output directory, never the package's own `dist/`.
 */

const SCRIPT = path.resolve(import.meta.dirname, '../../scripts/build-testing-e2e.mjs')

function build(entrySource?: string): { status: number | null; output: string; outDir: string } {
    const dir = makeTestTmpDir('build-testing-e2e-')
    const outDir = path.join(dir, 'dist')
    const args = [SCRIPT, '--out-dir', outDir]
    if (entrySource !== undefined) {
        writeFileSync(path.join(dir, 'entry.ts'), entrySource)
        args.push('--entry', path.join(dir, 'entry.ts'))
    }
    const result = spawnSync(process.execPath, args, { encoding: 'utf8' })
    return { status: result.status, output: `${result.stdout}${result.stderr}`, outDir }
}

describe('build-testing-e2e', () => {
    it('builds the real entry: one module, with its declarations', () => {
        const { status, output, outDir } = build()
        expect(status, output).toBe(0)
        expect(readFileSync(path.join(outDir, 'testing/e2e.js'), 'utf8')).toMatch(/verifyWebhookSignature/)
        expect(existsSync(path.join(outDir, 'testing/e2e.d.ts'))).toBe(true)
    })

    it('refuses an entry that imports the seam by a literal specifier, and leaves nothing behind', () => {
        const { status, output, outDir } = build(
            "import { APP_SLUG } from '@sssb/app-config/identity'\nexport const slug = APP_SLUG\n",
        )
        expect(status).toBe(1)
        expect(output).toMatch(
            /must be seam-free, but its closure imports the app's seam:\n {2}@sssb\/app-config\/identity/,
        )
        expect(existsSync(outDir)).toBe(false)
    })

    it.each([
        ['a computed dynamic import', 'export const load = (m: string) => import(m)\n', /a dynamic import\(\)/],
        [
            'a template-literal dynamic import',
            'export const load = (app: string) => import(`@sssb/${app}/identity`)\n',
            /a dynamic import\(\)/,
        ],
        [
            'a loader reached through globalThis',
            "export const load = (m: string) => (globalThis as any)['req' + 'uire'](m)\n",
            /a reference to `globalThis`/,
        ],
        ['an indirect eval', 'export const run = (code: string) => (0, eval)(code)\n', /a reference to `eval`/],
    ])('refuses %s that esbuild leaves for run time', (_name, source, message) => {
        const { status, output, outDir } = build(source)
        expect(status, output).toBe(1)
        expect(output).toMatch(/must be one self-contained module, but what esbuild emitted can still load code/)
        expect(output).toMatch(message)
        expect(existsSync(outDir)).toBe(false)
    })
})
