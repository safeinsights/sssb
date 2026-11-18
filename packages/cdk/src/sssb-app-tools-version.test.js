// @ts-check
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import * as cdk from 'aws-cdk-lib'
import { expect, it, vi } from 'vitest'

/**
 * `@sssb/tools` is `@sssb/cdk`'s peer, and pnpm only warns when the copy beside cdk is another release, so `SssbApp`
 * refuses it itself. Here cdk reads the manifest of the `@sssb/tools` it resolves as another version (the one file it
 * reads that way), in a file of its own because the mock holds for the whole file.
 */
vi.mock('node:fs', async (importOriginal) => {
    const fs = /** @type {typeof import('node:fs')} */ (await importOriginal())
    /** @type {typeof fs.readFileSync} */
    const readFileSync = /** @type {any} */ (
        (/** @type {any} */ file, /** @type {any[]} */ ...rest) =>
            String(file).endsWith('/tools/package.json')
                ? JSON.stringify({ name: '@sssb/tools', version: '0.0.0-other' })
                : fs.readFileSync(file, ...rest)
    )
    return { ...fs, default: { ...fs, readFileSync }, readFileSync }
})

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')

it('refuses to synth beside an @sssb/tools that is not its own version', async () => {
    const { SssbApp } = await import('./index.js')
    const fs = /** @type {typeof import('node:fs')} */ (await vi.importActual('node:fs'))
    const own = JSON.parse(fs.readFileSync(path.join(REPO, 'packages/cdk/package.json'), 'utf8')).version
    expect(
        () =>
            new SssbApp(new cdk.Stack(new cdk.App()), 'Default', {
                appDir: path.join(REPO, 'apps/starter'),
                slug: 'starter',
                params: { database: { transport: 'pg' } },
                environment: 'Staging',
                production: false,
            }),
    ).toThrow(`SssbApp: this @sssb/cdk is ${own}, but the @sssb/tools beside it is 0.0.0-other.`)
})
