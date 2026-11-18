import { spawnSync } from 'node:child_process'
import { readdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import sssb from '@sssb/eslint-plugin'
import { describe, expect, it } from 'vitest'

/**
 * Next's `no-html-link-for-pages` looks for an app's `app/` and `pages/` under `settings.next.rootDir`, and without it
 * under the directory ESLint runs from: from a workspace root, which has neither, it printed "Pages directory cannot be
 * found" (exit 0) on every run. The preset names each app as Next's root dir.
 */
const repoRoot = process.cwd()
const APPS = readdirSync(path.join(repoRoot, 'apps'), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
const require = createRequire(import.meta.url)
const ESLINT_BIN = path.join(path.dirname(require.resolve('eslint/package.json')), 'bin', 'eslint.js')

/** The root layout of each app, linted from the workspace root by a fresh ESLint process (Next warns once a process). */
function lintFromRoot(app: string) {
    return spawnSync(process.execPath, [ESLINT_BIN, `apps/${app}/src/app/[locale]/layout.tsx`], {
        cwd: repoRoot,
        encoding: 'utf8',
    })
}

describe("Next's root dir", () => {
    it.each(APPS)(
        'lints %s from the workspace root without "Pages directory cannot be found"',
        (app) => {
            const result = lintFromRoot(app)
            expect(`${result.stdout}${result.stderr}`).not.toMatch(/Pages directory cannot be found/)
            expect(result.status, result.stdout).toBe(0)
        },
        60_000,
    )

    it('names each app, escaped as a glob, in the block that runs Next’s rules', async () => {
        const configs = await sssb.configs.app({ root: path.join(repoRoot, 'apps', '*') })
        const next = configs.find((block) => block.name === 'sssb/app/next')
        expect(next?.settings?.next).toEqual({ rootDir: APPS.sort().map((app) => path.join(repoRoot, 'apps', app)) })
        const single = await sssb.configs.app({ root: path.join(repoRoot, 'apps', APPS[0]!) })
        expect(single.find((block) => block.name === 'sssb/app/next')?.settings?.next).toEqual({
            rootDir: [path.join(repoRoot, 'apps', APPS[0]!)],
        })
    })
})
