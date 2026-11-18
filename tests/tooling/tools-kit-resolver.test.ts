import { spawnSync } from 'node:child_process'
import { mkdirSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
    assertAppsKitFile,
    assertNoForeignFramework,
    isFrameworkFile,
    kitDirOf,
    kitVersionOf,
    resolveAppsKit,
    resolveFromApp,
} from '../../packages/tools/src/kit.js'
import { makeTestTmpDir } from '../support/tmp-dir'

/**
 * ADR-0014, rule 4: a tool must reach `@sssb/kit` from the APP's directory, and what it gets must sit inside the
 * real directory of the `@sssb/kit` that app resolves. pnpm hoists one copy into `.pnpm/node_modules`, which in a
 * workspace with two apps is the other app's instance, so the failure is silent: the tool runs, on the wrong seam.
 * These tests build a workspace where every one of those copies exists with different content and pin that the
 * resolver hands each app its own, refuses every other, and follows the symlinks pnpm and workspace links use.
 */
const WS = realpathSync(makeTestTmpDir('sssb-tools-resolver-'))

function writeFile(file: string, text: string) {
    mkdirSync(path.dirname(file), { recursive: true })
    writeFileSync(file, text)
}

/** A fake `@sssb/kit` package in `dir`, whose `ports/errors` says `marker`. */
function writeKit(dir: string, marker: string) {
    writeFile(
        path.join(dir, 'package.json'),
        JSON.stringify({
            name: '@sssb/kit',
            version: '0.0.0',
            type: 'module',
            exports: { './package.json': './package.json', './ports/errors': './src/ports/errors.ts' },
        }),
    )
    writeFile(path.join(dir, 'src', 'ports', 'errors.ts'), `export const WHO = '${marker}'\n`)
}

function writeApp(app: string) {
    writeFile(path.join(WS, 'apps', app, 'package.json'), JSON.stringify({ name: app, private: true }))
    return path.join(WS, 'apps', app)
}

const appA = writeApp('a')
const appB = writeApp('b')
const noKitApp = writeApp('no-kit')
const kitA = path.join(appA, 'node_modules', '@sssb', 'kit')
const kitB = path.join(appB, 'node_modules', '@sssb', 'kit')
const kitHoisted = path.join(WS, 'node_modules', '.pnpm', 'node_modules', '@sssb', 'kit')
const kitRoot = path.join(WS, 'node_modules', '@sssb', 'kit')
writeKit(kitA, 'a')
writeKit(kitB, 'b')
writeKit(kitHoisted, 'hoisted')
writeKit(kitRoot, 'root')
// An app in a directory of its own, with no node_modules anywhere above it: it installs no framework.
const lonely = realpathSync(makeTestTmpDir('sssb-tools-lonely-'))
writeFile(path.join(lonely, 'package.json'), JSON.stringify({ name: 'lonely' }))
const KIT_JS = path.resolve(__dirname, '../../packages/tools/src/kit.js')

const errorsOf = (kit: string) => realpathSync(path.join(kit, 'src', 'ports', 'errors.ts'))

describe('resolveAppsKit', () => {
    it('hands each app its own @sssb/kit, never the hoisted or root copy', () => {
        expect(resolveAppsKit(appA, 'ports/errors')).toBe(errorsOf(kitA))
        expect(resolveAppsKit(appB, 'ports/errors')).toBe(errorsOf(kitB))
        expect(kitDirOf(appA)).toBe(realpathSync(kitA))
        expect(kitDirOf(appB)).toBe(realpathSync(kitB))
    })

    it('falls through to the workspace-root copy only for an app with no copy of its own', () => {
        expect(kitDirOf(noKitApp)).toBe(realpathSync(kitRoot))
    })

    it('says the app does not resolve @sssb/kit when nothing installs it, even with NODE_PATH at a hoisted copy', () => {
        // `pnpm exec` and `pnpm run` set NODE_PATH to pnpm's hoisted `.pnpm/node_modules`, which Node's resolver honours
        // as a last resort. Resolved that way, an app with no framework of its own would get the hoisted one: another
        // app's instance. So the child runs with NODE_PATH pointing straight at a hoisted copy, and must still refuse.
        const script = [
            `import { kitDirOf, resolveAppsKit } from ${JSON.stringify(KIT_JS)}`,
            `for (const f of [() => kitDirOf(${JSON.stringify(lonely)}), () => resolveAppsKit(${JSON.stringify(lonely)}, 'ports/errors')]) {`,
            "    try { f(); console.log('no error') } catch (e) { console.log(e.message) }",
            '}',
        ].join('\n')
        const env = { ...process.env, NODE_PATH: path.dirname(path.dirname(kitHoisted)) }
        const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8', env })
        const lines = result.stdout.trim().split('\n')
        expect(lines).toHaveLength(2)
        for (const line of lines) expect(line).toContain('does not resolve @sssb/kit')
    })

    it('says the framework does not publish a subpath it does not export', () => {
        expect(() => resolveAppsKit(appA, 'adapters/real/index')).toThrow(
            'does not publish `@sssb/kit/adapters/real/index`',
        )
    })
})

describe('kitVersionOf', () => {
    it("reads the version of the framework the app resolves, so a package can assert it is in step (@sssb/cdk's construct)", () => {
        writeFileSync(
            path.join(kitB, 'package.json'),
            JSON.stringify({ ...JSON.parse(readFileSync(path.join(kitB, 'package.json'), 'utf8')), version: '9.9.9' }),
        )
        expect(kitVersionOf(appA)).toBe('0.0.0')
        expect(kitVersionOf(appB)).toBe('9.9.9')
    })
})

describe('assertAppsKitFile', () => {
    it('passes a file inside the app’s own kit and returns its real path', () => {
        expect(assertAppsKitFile(appA, errorsOf(kitA))).toBe(errorsOf(kitA))
    })

    it('refuses another app’s kit file, naming the file and the app’s kit', () => {
        expect(() => assertAppsKitFile(appA, errorsOf(kitB))).toThrow(
            new RegExp(
                `${errorsOf(kitB)} is not part of the @sssb/kit that ${appA} resolves \\(${realpathSync(kitA)}\\)`,
            ),
        )
    })

    it('refuses the hoisted copy and the workspace-root copy', () => {
        expect(() => assertAppsKitFile(appA, errorsOf(kitHoisted))).toThrow('is not part of the @sssb/kit')
        expect(() => assertAppsKitFile(appA, errorsOf(kitRoot))).toThrow('is not part of the @sssb/kit')
    })

    it('does not mistake a sibling directory that shares the kit directory’s name as a prefix', () => {
        const sibling = path.join(appA, 'node_modules', '@sssb', 'kit-evil', 'x.ts')
        writeFile(sibling, '')
        expect(() => assertAppsKitFile(appA, sibling)).toThrow('is not part of the @sssb/kit')
    })

    it('follows a symlinked node_modules/@sssb/kit, as pnpm and workspace links lay it out', () => {
        const app = writeApp('linked')
        const elsewhere = path.join(WS, 'packages', 'kit-source')
        writeKit(elsewhere, 'linked')
        mkdirSync(path.join(app, 'node_modules', '@sssb'), { recursive: true })
        symlinkSync(elsewhere, path.join(app, 'node_modules', '@sssb', 'kit'), 'dir')

        expect(kitDirOf(app)).toBe(realpathSync(elsewhere))
        // The path the app sees (through the link) and the real one are both accepted, and both come back real.
        expect(resolveAppsKit(app, 'ports/errors')).toBe(errorsOf(elsewhere))
        expect(
            assertAppsKitFile(app, path.join(app, 'node_modules', '@sssb', 'kit', 'src', 'ports', 'errors.ts')),
        ).toBe(errorsOf(elsewhere))
        expect(assertAppsKitFile(app, errorsOf(elsewhere))).toBe(errorsOf(elsewhere))
        // ...and still refuses a different kit.
        expect(() => assertAppsKitFile(app, errorsOf(kitA))).toThrow('is not part of the @sssb/kit')
    })
})

/** A plain COPY of the framework's tree outside node_modules, reached by a relative path in real life. */
const kitCopy = path.join(WS, 'vendor', 'kit')
writeKit(kitCopy, 'copy')
const kitchen = path.join(WS, 'packages', 'kitchen')
writeFile(path.join(kitchen, 'package.json'), JSON.stringify({ name: '@sssb/kitchen' }))
writeFile(path.join(kitchen, 'src', 'x.ts'), '')
const appFile = path.join(appA, 'src', 'thing.ts')
writeFile(appFile, '')

describe('isFrameworkFile', () => {
    it('is true for a file whose nearest package.json is @sssb/kit, in node_modules or in a plain copy', () => {
        expect(isFrameworkFile(errorsOf(kitA))).toBe(true)
        expect(isFrameworkFile(errorsOf(kitCopy))).toBe(true)
    })

    it('is false for an app file and for a package merely named like the kit', () => {
        expect(isFrameworkFile(appFile)).toBe(false)
        expect(isFrameworkFile(path.join(kitchen, 'src', 'x.ts'))).toBe(false)
    })
})

describe('assertNoForeignFramework', () => {
    it('passes the app’s own kit file and files that are not framework source', () => {
        expect(() => assertNoForeignFramework(appA, errorsOf(kitA))).not.toThrow()
        expect(() => assertNoForeignFramework(appA, appFile)).not.toThrow()
        expect(() => assertNoForeignFramework(appA, path.join(kitchen, 'src', 'x.ts'))).not.toThrow()
    })

    it('throws for another installed copy and for a plain copy of the framework tree', () => {
        expect(() => assertNoForeignFramework(appA, errorsOf(kitB))).toThrow('is not part of the @sssb/kit')
        expect(() => assertNoForeignFramework(appA, errorsOf(kitCopy))).toThrow('is not part of the @sssb/kit')
    })
})

describe('resolveFromApp', () => {
    const plugin = (dir: string) => {
        writeFile(path.join(dir, 'package.json'), JSON.stringify({ name: 'x-plugin', main: 'index.js' }))
        writeFile(path.join(dir, 'index.js'), 'module.exports = 1\n')
        return realpathSync(path.join(dir, 'index.js'))
    }

    it('refuses a package the app does not install, even when NODE_PATH holds a copy', () => {
        const hoisted = realpathSync(makeTestTmpDir('sssb-tools-nodepath-'))
        plugin(path.join(hoisted, 'x-plugin'))
        const script = [
            `import { resolveFromApp } from ${JSON.stringify(KIT_JS)}`,
            `try { console.log(resolveFromApp(${JSON.stringify(lonely)}, 'x-plugin', 'tests need')) } catch (e) { console.log(e.message) }`,
        ].join('\n')
        const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
            encoding: 'utf8',
            env: { ...process.env, NODE_PATH: hoisted },
        })
        expect(result.stdout).toContain('does not install `x-plugin`')
    })

    it('resolves a package in the app’s own node_modules or an ancestor’s', () => {
        const own = plugin(path.join(appA, 'node_modules', 'x-plugin'))
        expect(resolveFromApp(appA, 'x-plugin', 'tests need')).toBe(own)

        const outer = realpathSync(makeTestTmpDir('sssb-tools-ancestor-'))
        const inherited = plugin(path.join(outer, 'node_modules', 'x-plugin'))
        writeFile(path.join(outer, 'deep', 'app', 'package.json'), JSON.stringify({ name: 'deep' }))
        expect(resolveFromApp(path.join(outer, 'deep', 'app'), 'x-plugin', 'tests need')).toBe(inherited)
    })
})
