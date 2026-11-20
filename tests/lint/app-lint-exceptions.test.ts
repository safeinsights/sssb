import { mkdirSync, utimesSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import sssb from '@sssb/eslint-plugin'
import { ESLint, type Linter } from 'eslint'
import { describe, expect, it } from 'vitest'
import { makeTestTmpDir } from '../support/tmp-dir'

/**
 * App-owned lint exceptions (@sssb/eslint-plugin's preset reads them): an app names the modules a fence should let
 * through in its own `lint-exceptions.mjs`, by path relative to the app, so an adopter never edits SSSB's config and
 * renaming the app cannot break an exception. Everything is checked when `configs.app({ root })` runs, and anything
 * that could widen an exception quietly fails it.
 */
const RAW_DB = 'sssb/no-raw-db-handle'

/** A scratch workspace holding one app, its exceptions file, and the source files it names. */
function tree(app: string, exceptions: string, files: string[] = []): string {
    const root = makeTestTmpDir('lint-exceptions-')
    const appDir = path.join(root, 'apps', app)
    for (const file of files) {
        mkdirSync(path.dirname(path.join(appDir, file)), { recursive: true })
        writeFileSync(path.join(appDir, file), 'export const x = 1\n')
    }
    mkdirSync(appDir, { recursive: true })
    writeFileSync(path.join(appDir, 'lint-exceptions.mjs'), `export default ${exceptions}\n`)
    return root
}
const entry = (file: string, reason = 'runs as the system to purge every tenant’s expired rows') =>
    `{ ${JSON.stringify(RAW_DB)}: [{ file: ${JSON.stringify(file)}, reason: ${JSON.stringify(reason)} }] }`

const tenancyBlock = (config: Linter.Config[]) => config.find((block) => block.name === 'sssb/app/tenancy')
/** The tenancy ban's app exceptions, as the preset wrote them into the block's `ignores` (tests are its first). */
const exceptionsOf = async (root: string) => (tenancyBlock(await sssb.configs.app({ root }))?.ignores ?? []).slice(1)

describe('an app lists its own exceptions, by path relative to the app', () => {
    it('an app with no exceptions file has none', async () => {
        const root = makeTestTmpDir('lint-exceptions-')
        mkdirSync(path.join(root, 'apps', 'acme', 'src'), { recursive: true })
        expect(await exceptionsOf(path.join(root, 'apps/acme'))).toEqual([])
        expect(await exceptionsOf(path.join(root, 'apps/*'))).toEqual([])
    })

    it('an entry becomes an exact path under that app, whatever the app is called', async () => {
        const file = 'src/domain/maintenance.ts'
        for (const app of ['starter', 'acme', 'pages']) {
            const root = tree(app, entry(file), [file])
            // from the app's own config, relative to the app; from a config that lints every app, under its name
            expect(await exceptionsOf(path.join(root, 'apps', app))).toEqual([file])
            expect(await exceptionsOf(path.join(root, 'apps/*'))).toEqual([`${app}/${file}`])
        }
    })

    it('a Next route path is matched literally, not as a glob', async () => {
        const file = 'src/app/[locale]/admin/purge/route.ts'
        const root = tree('acme', entry(file), [file])
        const appDir = path.join(root, 'apps/acme')
        expect(await exceptionsOf(appDir)).toEqual(['src/app/\\[locale\\]/admin/purge/route.ts'])
        // ESLint reads the escaped path as that one file, and not as its sibling.
        const eslint = new ESLint({
            cwd: appDir,
            overrideConfigFile: true,
            overrideConfig: await sssb.configs.app({ root: appDir }),
        })
        const listed = await eslint.calculateConfigForFile(path.join(appDir, file))
        const sibling = await eslint.calculateConfigForFile(path.join(appDir, 'src/app/[locale]/admin/other.ts'))
        // linted, with the app's other fences, so the missing ban is the exception and not a file the config ignores
        expect(listed?.rules?.['sssb/no-process-env']).toBeDefined()
        expect(listed?.rules?.[RAW_DB]).toBeUndefined()
        expect(sibling?.rules?.[RAW_DB]).toBeDefined()
    })

    it('an edited exceptions file is read afresh, not served from the module cache', async () => {
        const [first, second] = ['src/domain/maintenance.ts', 'src/domain/archive.ts']
        const root = tree('acme', entry(first), [first, second])
        const appDir = path.join(root, 'apps/acme')
        expect(await exceptionsOf(appDir)).toEqual([first])
        const source = path.join(appDir, 'lint-exceptions.mjs')
        writeFileSync(source, `export default ${entry(second)}\n`)
        // a later mtime, set rather than waited for, so a coarse file-system clock cannot hide the edit
        const later = new Date(Date.now() + 60_000)
        utimesSync(source, later, later)
        expect(await exceptionsOf(appDir)).toEqual([second])
    })
})

describe('anything that could widen an exception fails the config load', () => {
    it.each([
        ['a glob', entry('src/domain/*.ts'), [], /is a glob/],
        ['a directory', entry('src/domain'), ['src/domain/maintenance.ts'], /names no file/],
        ['a file that does not exist', entry('src/domain/gone.ts'), [], /names no file/],
        ['a path out of the app', entry('src/../../other/src/x.ts'), [], /path under the app's src/],
        ['a path outside src/', entry('config/params.ts'), ['config/params.ts'], /path under the app's src/],
        ['backslashes', entry('src\\domain\\maintenance.ts'), ['src/domain/maintenance.ts'], /path under/],
        ['no reason', entry('src/domain/maintenance.ts', '  '), ['src/domain/maintenance.ts'], /needs a reason/],
        ['no file', `{ ${JSON.stringify(RAW_DB)}: [{ reason: 'purges every tenant' }] }`, [], /names no file/],
        [
            'a rule that takes no exceptions',
            `{ 'sssb/no-dynamic-app-import': [{ file: 'src/x.ts', reason: 'r' }] }`,
            ['src/x.ts'],
            /takes no app exceptions/,
        ],
        [
            'entries that are not a list',
            `{ ${JSON.stringify(RAW_DB)}: 'src/x.ts' }`,
            ['src/x.ts'],
            /must map to an array/,
        ],
        ['a default export that is not an object', `['src/x.ts']`, [], /default export must be an object/],
    ])('%s', async (_case, exceptions, files, why) => {
        const root = tree('acme', exceptions, files)
        for (const appRoot of [path.join(root, 'apps/acme'), path.join(root, 'apps/*')]) {
            await expect(sssb.configs.app({ root: appRoot })).rejects.toThrow(/apps\/acme\/lint-exceptions\.mjs: /)
            await expect(sssb.configs.app({ root: appRoot })).rejects.toThrow(why)
        }
    })
})

// The wiring, end to end: the preset, reading a scratch app's exceptions, lets the listed file through the tenancy ban
// and nothing else, whether the config is the app's own or one that lints every app.
describe('a listed module passes the tenancy ban, and an unlisted one still fails it', () => {
    // Two findings in one module: the raw handle, and a process.env read, which no app exception touches. The second
    // is what shows the listed module was linted at all, rather than ignored wholesale.
    const PURGE = 'export const purge = (db) => db.getDb()\nexport const region = process.env.AWS_REGION\n'
    const listed = 'src/domain/maintenance.ts'
    const lintAs = async (cwd: string, root: string, file: string) => {
        const eslint = new ESLint({ cwd, overrideConfigFile: true, overrideConfig: await sssb.configs.app({ root }) })
        const [result] = await eslint.lintText(PURGE, { filePath: path.join(cwd, file) })
        expect(
            result.messages.filter((m) => !m.ruleId),
            `${file} was not actually linted`,
        ).toEqual([])
        return result.messages.map((m) => m.ruleId)
    }

    it.each([
        ["from the app's own config", 'apps/acme', 'apps/acme', ''],
        ['from a config that lints every app', '', 'apps/*', 'apps/acme/'],
    ])('%s', async (_case, cwd, root, prefix) => {
        const scratch = tree('acme', entry(listed), [listed])
        const [at, anchor] = [path.join(scratch, cwd), path.join(scratch, root)]
        const passed = await lintAs(at, anchor, `${prefix}${listed}`)
        expect(passed).not.toContain(RAW_DB)
        expect(passed).toContain('sssb/no-process-env')
        expect(await lintAs(at, anchor, `${prefix}src/domain/other.ts`)).toContain(RAW_DB)
    })

    it('a relative root is refused: it would be relative to wherever ESLint was started', async () => {
        await expect(sssb.configs.app({ root: 'apps/acme' })).rejects.toThrow(/ABSOLUTE path/)
        await expect(sssb.configs.app({ root: '.' })).rejects.toThrow(/ABSOLUTE path/)
    })
})
