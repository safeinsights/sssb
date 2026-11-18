import { spawnSync } from 'node:child_process'
import { mkdirSync, readdirSync, realpathSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import sssb from '@sssb/eslint-plugin'
import { describe, expect, it } from 'vitest'
import { makeTestTmpDir } from '../support/tmp-dir'

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

    it('names each app in the block that runs Next’s rules, as the directories Next then finds', async () => {
        const configs = await sssb.configs.app({ root: path.join(repoRoot, 'apps', '*') })
        expect(nextRootDirs(configs)).toEqual(APPS.sort().map((app) => path.join(repoRoot, 'apps', app)))
        const single = await sssb.configs.app({ root: path.join(repoRoot, 'apps', APPS[0]!) })
        expect(nextRootDirs(single)).toEqual([path.join(repoRoot, 'apps', APPS[0]!)])
    })

    // Next turns every backslash into a slash before its glob reads the root dir, so the preset escapes a special
    // character as a one-character class, which survives that.
    it.each(['my(app)', 'a+b@c#d', 'x[1]{2}', 'w!x', 's*t?u'])('finds an app at a path with %s in it', async (name) => {
        const app = path.join(realpathSync(makeTestTmpDir('next-root-dir-')), name)
        mkdirSync(path.join(app, 'src', 'app'), { recursive: true })
        writeFileSync(path.join(app, 'package.json'), '{ "name": "special" }\n')
        expect(nextRootDirs(await sssb.configs.app({ root: app }))).toEqual([app])
    })
})

/** The directories Next's own `getRootDirs` finds for the `settings.next.rootDir` the preset's `next` block sets. */
function nextRootDirs(configs: { name?: string; settings?: Record<string, unknown> }[]): string[] {
    const next = configs.find((block) => block.name === 'sssb/app/next')
    const plugin = createRequire(path.join(repoRoot, 'packages/eslint-plugin/package.json')).resolve(
        '@next/eslint-plugin-next',
    )
    const { getRootDirs } = require(path.join(path.dirname(plugin), 'utils', 'get-root-dirs.js')) as {
        getRootDirs: (context: { cwd: string; settings: Record<string, unknown> }) => string[]
    }
    return getRootDirs({ cwd: '/nowhere', settings: next?.settings ?? {} }).map((dir) => path.resolve(dir))
}
