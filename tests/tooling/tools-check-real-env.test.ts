import { spawnSync } from 'node:child_process'
import { mkdirSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { makeTestTmpDir } from '../support/tmp-dir'

/**
 * Pins `sssb check-real-env` (the `dev:real` preflight) on rule 4 of ADR-0014: the framework it bundles and runs is
 * the one the APP installs, on the APP's seam. The workspace here has two apps, each with its own fake
 * `@sssb/kit` whose real adapters read an identity from the seam, so a run that reached the other app's framework
 * or seam would print the wrong name. No real framework, no network: the fake kit is a few lines of TypeScript,
 * which is all esbuild needs to bundle it.
 */
const SSSB = path.resolve(__dirname, '../../packages/tools/bin/sssb.js')

function write(file: string, text: string) {
    mkdirSync(path.dirname(file), { recursive: true })
    writeFileSync(file, text)
}

/** `notices`, when given, is the body of the fake framework's `realEnvNotices`, which a kit before #192 lacks. */
function writeKit(dir: string, notices?: string) {
    write(
        path.join(dir, 'package.json'),
        JSON.stringify({
            name: '@sssb/kit',
            version: '0.0.0',
            type: 'module',
            exports: {
                './package.json': './package.json',
                './ports/errors': './src/ports/errors.ts',
                './adapters/real/index': './src/adapters/real/index.ts',
            },
        }),
    )
    write(path.join(dir, 'src/ports/errors.ts'), 'export class CutoverPendingError extends Error {}\n')
    write(
        path.join(dir, 'src/adapters/real/index.ts'),
        [
            "import { APP_SLUG } from '@sssb/app-config/identity'",
            "import { CutoverPendingError } from '../../ports/errors'",
            '',
            'export function assertRealEnv(): void {',
            "    if (process.env['FAKE_READY'] !== '1') throw new CutoverPendingError(`missing for ${APP_SLUG}`)",
            '}',
            ...(notices === undefined
                ? []
                : ['', 'export function realEnvNotices(): string[] {', `    ${notices}`, '}']),
            '',
        ].join('\n'),
    )
}

/** An app with its own kit and a seam whose identity module is `identity`. */
function writeApp(root: string, name: string, identity: string | undefined, notices?: string) {
    const appDir = path.join(root, 'apps', name)
    write(path.join(appDir, 'package.json'), JSON.stringify({ name, private: true }))
    writeKit(path.join(appDir, 'node_modules/@sssb/kit'), notices)
    if (identity !== undefined) write(path.join(appDir, 'src/app-config/identity.ts'), identity)
    return appDir
}

function checkRealEnv(appDir: string, env: Record<string, string> = {}) {
    const result = spawnSync(process.execPath, [SSSB, 'check-real-env'], {
        cwd: appDir,
        encoding: 'utf8',
        env: { ...process.env, FAKE_READY: '', ...env },
    })
    return { status: result.status, output: result.stdout + result.stderr }
}

const root = realpathSync(makeTestTmpDir('sssb-check-real-env-'))
write(path.join(root, 'pnpm-workspace.yaml'), "packages:\n  - 'apps/*'\n")
const appA = writeApp(root, 'a', "export const APP_SLUG = 'alpha'\n")
const appB = writeApp(root, 'b', "export const APP_SLUG = 'beta'\n")

describe('sssb check-real-env', () => {
    it('reads each app’s own seam, through that app’s own framework', () => {
        const a = checkRealEnv(appA)
        expect(a.status).toBe(1)
        expect(a.output).toContain('missing for alpha')
        expect(a.output).not.toContain('beta')

        const b = checkRealEnv(appB)
        expect(b.status).toBe(1)
        expect(b.output).toContain('missing for beta')
        expect(b.output).not.toContain('alpha')
    })

    it('exits 0 and says so when the environment is complete', () => {
        for (const appDir of [appA, appB]) {
            const result = checkRealEnv(appDir, { FAKE_READY: '1' })
            expect(result.status).toBe(0)
            expect(result.output).toContain('real-mode env complete')
        }
    })

    // safeinsights/sssb#192: the framework's advisory lines, after a pass, never a failure.
    describe('the notices the framework offers', () => {
        const NOTICES = "return ['CLERK_AUTHORIZED_PARTIES is unset: any origin', 'CLERK_AUTHORISED_PARTIES is set']"
        const withNotices = writeApp(root, 'notices', "export const APP_SLUG = 'theta'\n", NOTICES)
        const throwing = writeApp(root, 'notices-throw', "export const APP_SLUG = 'iota'\n", "throw new Error('boom')")

        it('prints each after a passing check, and still exits 0', () => {
            const result = checkRealEnv(withNotices, { FAKE_READY: '1' })
            expect(result.status).toBe(0)
            expect(result.output).toContain('real-mode env complete')
            expect(result.output).toContain('notice: CLERK_AUTHORIZED_PARTIES is unset: any origin')
            expect(result.output).toContain('notice: CLERK_AUTHORISED_PARTIES is set')
        })

        it('prints none when the check fails: the failure is the whole answer', () => {
            const result = checkRealEnv(withNotices)
            expect(result.status).toBe(1)
            expect(result.output).toContain('missing for theta')
            expect(result.output).not.toContain('notice:')
        })

        it('prints none, and says nothing of them, for a framework that offers none', () => {
            const result = checkRealEnv(appA, { FAKE_READY: '1' })
            expect(result.status).toBe(0)
            expect(result.output).not.toContain('notice')
            expect(result.output.toLowerCase()).not.toContain('warning')
        })

        it('does not fail a passing check when the notices themselves fail', () => {
            const result = checkRealEnv(throwing, { FAKE_READY: '1' })
            expect(result.status).toBe(0)
            expect(result.output).toContain('notice: the notices could not be read: boom')
        })
    })

    it('acts on the app --app names, not the working directory', () => {
        const result = spawnSync(process.execPath, [SSSB, 'check-real-env', '--app', 'apps/b'], {
            cwd: root,
            encoding: 'utf8',
            env: { ...process.env, FAKE_READY: '' },
        })
        expect(result.status).toBe(1)
        expect(result.stderr).toContain('missing for beta')
    })

    it('refuses a seam that reaches another app’s framework by a relative path', () => {
        // The slip rule 4 exists for. A bare `@sssb/kit/...` import is resolved from the app and checked as it is
        // resolved; a RELATIVE import into another copy's directory never passes that check, so the post-build
        // check over every bundled input is what catches it. Here the "other copy" is app b's kit, reached from
        // app c's seam, and the framework's own error class would then be a different class from the one the
        // preflight's entry catches.
        const appC = writeApp(
            root,
            'c',
            [
                "import { CutoverPendingError } from '../../../b/node_modules/@sssb/kit/src/ports/errors'",
                "export const APP_SLUG = typeof CutoverPendingError === 'function' ? 'gamma' : 'unreachable'",
                '',
            ].join('\n'),
        )

        const result = checkRealEnv(appC)

        expect(result.status).not.toBe(0)
        expect(result.output).toContain('is not part of the @sssb/kit')
        expect(result.output).toContain(path.join(appC, 'node_modules'))
        expect(result.output).not.toContain('missing for gamma')
    })

    it('accepts a seam that imports the framework by its bare specifier', () => {
        const appD = writeApp(
            root,
            'd',
            [
                "import { CutoverPendingError } from '@sssb/kit/ports/errors'",
                "export const APP_SLUG = typeof CutoverPendingError === 'function' ? 'delta' : 'unreachable'",
                '',
            ].join('\n'),
        )
        const result = checkRealEnv(appD)
        expect(result.status).toBe(1)
        expect(result.output).toContain('missing for delta')
    })

    it('bundles a workspace package the seam imports, extensionless relative imports and all', () => {
        const shared = path.join(root, 'packages/shared')
        write(path.join(shared, 'package.json'), JSON.stringify({ name: 'shared', main: 'src/index.ts' }))
        write(path.join(shared, 'src/index.ts'), "export { NAME } from './util'\n")
        write(path.join(shared, 'src/util.ts'), "export const NAME: string = 'epsilon'\n")
        const appE = writeApp(root, 'e', "import { NAME } from 'shared'\nexport const APP_SLUG = NAME\n")
        mkdirSync(path.join(appE, 'node_modules'), { recursive: true })
        symlinkSync(shared, path.join(appE, 'node_modules/shared'), 'dir')

        const result = checkRealEnv(appE)

        expect(result.status).toBe(1)
        expect(result.output).toContain('missing for epsilon')
    })

    it('gives a bundled workspace file its own import.meta location, though the bundle is CommonJS', () => {
        const shared = path.join(root, 'packages/shared-meta')
        write(path.join(shared, 'package.json'), JSON.stringify({ name: 'shared-meta', main: 'src/index.ts' }))
        write(path.join(shared, 'src/data.txt'), 'zeta-data')
        write(
            path.join(shared, 'src/index.ts'),
            [
                "import { readFileSync } from 'node:fs'",
                "import path from 'node:path'",
                "export const TEXT = readFileSync(new URL('./data.txt', import.meta.url), 'utf8')",
                'export const DIR = path.basename(import.meta.dirname)',
                // A string that mentions import.meta is text, not an expression: it must come through as written.
                'export const NOTE = "see import.meta.url"',
                // The destructured form reads the same object.
                'const { filename } = import.meta',
                'export const FILE = path.basename(filename)',
                '',
            ].join('\n'),
        )
        const appH = writeApp(
            root,
            'h',
            "import { TEXT, DIR, NOTE, FILE } from 'shared-meta'\nexport const APP_SLUG = `${TEXT}@${DIR}|${NOTE}|${FILE}`\n",
        )
        mkdirSync(path.join(appH, 'node_modules'), { recursive: true })
        symlinkSync(shared, path.join(appH, 'node_modules/shared-meta'), 'dir')

        const result = checkRealEnv(appH)

        expect(result.status).toBe(1)
        expect(result.output).toContain('missing for zeta-data@src|see import.meta.url|index.ts')
    })

    it('refuses a workspace package that brings a framework copy of its own', () => {
        const shared = path.join(root, 'packages/shared-kit')
        write(path.join(shared, 'package.json'), JSON.stringify({ name: 'shared-kit', main: 'src/index.ts' }))
        write(
            path.join(shared, 'src/index.ts'),
            "import { CutoverPendingError } from '@sssb/kit/ports/errors'\nexport const NAME = typeof CutoverPendingError\n",
        )
        writeKit(path.join(shared, 'node_modules/@sssb/kit'))
        const appF = writeApp(root, 'f', "import { NAME } from 'shared-kit'\nexport const APP_SLUG = NAME\n")
        symlinkSync(shared, path.join(appF, 'node_modules/shared-kit'), 'dir')

        const result = checkRealEnv(appF)

        expect(result.status).not.toBe(0)
        expect(result.output).toContain('is not part of the @sssb/kit')
        expect(result.output).not.toContain('missing for')
    })

    it('refuses a plain copy of the framework tree reached by a relative path', () => {
        writeKit(path.join(root, 'vendor/kit'))
        const appG = writeApp(
            root,
            'g',
            [
                "import { CutoverPendingError } from '../../../../vendor/kit/src/ports/errors'",
                "export const APP_SLUG = typeof CutoverPendingError === 'function' ? 'eta' : 'unreachable'",
                '',
            ].join('\n'),
        )

        const result = checkRealEnv(appG)

        expect(result.status).not.toBe(0)
        expect(result.output).toContain('is not part of the @sssb/kit')
        expect(result.output).not.toContain('missing for eta')
    })

    it('exits 1 with a clear message for an app with no seam', () => {
        const bare = writeApp(root, 'bare', undefined)
        const result = checkRealEnv(bare)
        expect(result.status).toBe(1)
        expect(result.output).toContain('has no seam at src/app-config')
    })

    // The tests above bundle a stub kit. This one bundles the real framework, on each of SSSB's apps: what is
    // bundled must build as the preflight's CommonJS, which a module reaching the adapter registry (its top-level
    // await) would not.
    it.each(['showcase', 'starter'])(
        "bundles the real framework for the %s app, and names what's missing",
        (app) => {
            const blank = Object.fromEntries(
                [
                    'DATABASE_TRANSPORT',
                    'DATABASE_URL',
                    'CLERK_SECRET_KEY',
                    'NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY',
                    'JOBS_RUNNER',
                ].map((name) => [name, '']),
            )
            const result = checkRealEnv(path.resolve(__dirname, '../../apps', app), {
                ...blank,
                DATABASE_TRANSPORT: 'pg',
                APP_MODE: 'real',
            })
            expect(result.output).toContain('dev:real is not available yet')
            expect(result.output).toMatch(/Missing env: .*CLERK_SECRET_KEY/)
            expect(result.status).toBe(1)
        },
        120_000,
    )
})
