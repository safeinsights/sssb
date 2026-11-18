import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import type { Plugin, PluginOption } from 'vite'
import { describe, expect, it } from 'vitest'
import { frameworkGuard } from '../../packages/tools/src/framework-guard.js'
import { staticDemoConfig } from '../../packages/tools/src/vite.js'
import { appTestProject } from '../../packages/tools/src/vitest.js'
import { makeTestTmpDir } from '../support/tmp-dir'

/**
 * ADR-0014 rule 4, for the Vite and Vitest presets: a module the build or a test run loads that is framework source
 * must be the app's own @sssb/kit. The guard's `load` hook is called directly; both presets must put it first.
 */
const WS = realpathSync(makeTestTmpDir('sssb-tools-guard-'))

function write(file: string, text: string) {
    mkdirSync(path.dirname(file), { recursive: true })
    writeFileSync(file, text)
}

function writeKit(dir: string) {
    write(path.join(dir, 'package.json'), JSON.stringify({ name: '@sssb/kit', version: '0.0.0' }))
    write(path.join(dir, 'src', 'x.ts'), 'export {}\n')
    return path.join(dir, 'src', 'x.ts')
}

const app = path.join(WS, 'apps', 'a')
write(path.join(app, 'package.json'), JSON.stringify({ name: 'a' }))
const ownKit = writeKit(path.join(app, 'node_modules', '@sssb', 'kit'))
const foreign = writeKit(path.join(WS, 'vendor', 'kit'))

const load = (id: string) =>
    (frameworkGuard(app).load as unknown as (this: unknown, id: string) => unknown).call({}, id)

const flatten = (plugins: PluginOption[] | undefined): Plugin[] => (plugins ?? []).flat(Infinity as 1) as Plugin[]

describe('frameworkGuard', () => {
    it('lets the app’s own framework file through', () => {
        expect(load(ownKit)).toBeNull()
    })

    it('throws when a loaded module is framework source from another instance', () => {
        expect(() => load(foreign)).toThrow('is not part of the @sssb/kit')
    })

    it('ignores ids that are not files, and strips a query before judging', () => {
        expect(load('\0virtual')).toBeNull()
        expect(load('virtual:x')).toBeNull()
        expect(load(`${ownKit}?v=1`)).toBeNull()
        expect(() => load(`${foreign}?v=1`)).toThrow('is not part of the @sssb/kit')
    })

    it('remembers a file only once it passes: a foreign file fails every load, an own file passes every load', () => {
        const guard = frameworkGuard(app).load as unknown as (this: unknown, id: string) => unknown
        expect(() => guard.call({}, foreign)).toThrow('is not part of the @sssb/kit')
        expect(() => guard.call({}, foreign)).toThrow('is not part of the @sssb/kit')
        expect(guard.call({}, ownKit)).toBeNull()
        expect(guard.call({}, ownKit)).toBeNull()
    })

    it('is the first plugin of both presets', async () => {
        // Whichever app of this tree builds a static demo: no name is assumed.
        const appsDir = path.resolve(__dirname, '../../apps')
        const appDir = readdirSync(appsDir)
            .map((name) => path.join(appsDir, name))
            .find((dir) => {
                const manifest = path.join(dir, 'package.json')
                if (!existsSync(manifest)) return false
                const devDependencies = JSON.parse(readFileSync(manifest, 'utf8')).devDependencies ?? {}
                return '@vitejs/plugin-react' in devDependencies && 'vite-plugin-singlefile' in devDependencies
            })
        if (appDir === undefined) throw new Error('no app in this tree builds a static demo')
        const project = await appTestProject({ appDir })
        expect(flatten(project.plugins as PluginOption[])[0]?.name).toBe('sssb:framework-guard')
        const demo = await staticDemoConfig({ appDir })
        expect(flatten(demo.plugins)[0]?.name).toBe('sssb:framework-guard')
    })
})
