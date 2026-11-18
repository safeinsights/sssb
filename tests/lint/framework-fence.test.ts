import { symlinkSync, unlinkSync } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { ESLint } from 'eslint'
import { describe, expect, it } from 'vitest'
import { makeTestTmpDir } from '../support/tmp-dir'
import {
    ABSOLUTE_IN_PACKAGE,
    APP,
    APP_CODE_DYNAMIC,
    APP_CODE_PATH,
    APP_CODE_STATIC,
    BARE_TRAVERSAL_DYNAMIC,
    BARE_TRAVERSAL_STATIC,
    CORE_DYNAMIC,
    CORE_STATIC,
    type Fence,
    fired,
    JSX_IN_CORE,
    lint,
    NODE_MODULES_DYNAMIC,
    NODE_MODULES_STATIC,
    OUT_OF_PACKAGE_PATH,
    UNSHIPPED_PATH,
    VENDOR_DYNAMIC,
    VENDOR_STATIC,
} from './lint-text'

/**
 * Two of ADR-0012's fences are no-restricted-imports groups: the framework/app fence (SSSB and its fixture
 * reach app content only through `@sssb/app-config/*`) and @sssb/kit/core's framework ban (ADR-0006). That rule sees
 * import and export DECLARATIONS only, so until `sssb/no-dynamic-app-import` and
 * `sssb/no-dynamic-framework-import-in-core` existed, `import('@app/seed')` in SSSB's server-lib and
 * `export type T = import('@/domain/tickets').Ticket` in SSSB's fixture linted clean. The second is the
 * type-only escape the fixture's fence exists to stop: erased at runtime, resolved by the root tsc, and
 * broken only at `pnpm init-app --eject-showcase`.
 *
 * The new rules read the same patterns through the same matchers as no-restricted-imports (eslint.config.mjs,
 * `patternMatcher`), and the parity table below holds them to it, specifier by specifier.
 */
const KIT = ['packages/kit/src/server-lib/kv.ts', 'packages/kit/src/adapters/real/kv.ts', 'packages/kit/src/core/kv.ts']
const FIXTURE = 'packages/kit/test-fixture/domain/kv.ts'

describe('the framework/app fence holds outside declarations', () => {
    const forms: [string, string][] = [
        ['import()', "export const load = () => import('@app/seed')\n"],
        ['import() with a template literal', 'export const load = () => import(`@/domain/tickets`)\n'],
        ['require()', "export const seed = require('@app/seed/world')\n"],
        ['a type-position import()', "export type Ticket = import('@/domain/tickets').Ticket\n"],
        ['typeof import()', "export type Seed = typeof import('@app/seed')\n"],
    ]

    describe.each([...KIT, FIXTURE, 'packages/kit/src/components/kv-panel.mjs'])('%s', (file) => {
        // A `.mjs` file has no type positions, so it gets the runtime forms only.
        const applicable = file.endsWith('.mjs') ? forms.filter(([form]) => !form.includes('type')) : forms
        it.each(applicable)('may not reach app content by %s', async (_form, code) => {
            expect(fired(await lint(file, code), APP_CODE_DYNAMIC)).toBe(1)
        })
    })

    it('an SSSB test may not load app content with vi.importActual either', async () => {
        const code = "import { vi } from 'vitest'\nexport const load = () => vi.importActual('@app/seed')\n"
        expect(fired(await lint('packages/kit/src/server-lib/kv.test.ts', code), APP_CODE_DYNAMIC)).toBe(1)
    })

    // TypeScript's `import m = require()` is a declaration to no-restricted-imports (TSImportEqualsDeclaration), so
    // the pattern's own half bans it, and the declarationless rule leaves it alone: one finding, not two.
    it.each([...KIT, FIXTURE])('%s may not reach app content by import = require() either', async (file) => {
        const findings = await lint(file, "import seed = require('@app/seed')\nexport { seed }\n")
        expect(fired(findings, APP_CODE_STATIC)).toBe(1)
        expect(fired(findings, APP_CODE_DYNAMIC)).toBe(0)
    })

    it('the seam stays open: @sssb/app-config/* by import() or in a type', async () => {
        const code = [
            "export const load = () => import('@sssb/app-config/jobs')",
            // a seam module whose path happens to contain an apps/ segment is still the seam
            "export const registry = () => import('@sssb/app-config/apps/registry')",
            "export type Jobs = import('@sssb/app-config/jobs').AppJobs",
            "export const local = () => import('./local')",
        ].join('\n')
        expect(fired(await lint(FIXTURE, code), APP_CODE_DYNAMIC)).toBe(0)
    })

    // An app's tsconfig maps `@/*` to `./src/*`, so `@//domain/tickets` is `./src//domain/tickets` to TypeScript:
    // the alias with an empty segment, which a `@/*` group does not match. Every spelling is one finding, in each half.
    it.each([
        '@/domain/tickets',
        '@//domain/tickets',
        '@///domain\\tickets',
        '@app/seed',
        '@app/seed/world',
        '@app//seed/world',
    ])('the app’s alias spelled %s is one finding, in each half', async (specifier) => {
        const at = JSON.stringify(specifier)
        const declared = await lint(FIXTURE, `import { x } from ${at}\nexport { x }\n`)
        expect(fired(declared, APP_CODE_STATIC)).toBe(1)
        const loaded = await lint(FIXTURE, `export const load = () => import(${at})\n`)
        expect(fired(loaded, APP_CODE_DYNAMIC)).toBe(1)
    })

    it('an app reaching its own @/* alias is not crossing the fence', async () => {
        const code =
            "export const load = () => import('@/domain/tickets')\nexport type T = import('@/domain/tickets').T\n"
        expect(fired(await lint(`${APP}/src/app/api/kv/route.ts`, code), APP_CODE_DYNAMIC)).toBe(0)
    })
})

describe('@sssb/kit/core stays framework-free outside declarations', () => {
    const CORE = 'packages/kit/src/core/kv.ts'

    it.each([
        ['import()', "export const load = () => import('next/headers')\n"],
        ['a mid-name wildcard (react-*)', "export const load = () => import('react-dom/client')\n"],
        ['require()', "export const ui = require('@mantine/core')\n"],
        ['a type-position import()', "export type Node = import('react').ReactNode\n"],
        ['next-intl', "export const load = () => import('next-intl/server')\n"],
    ])('may not reach a framework by %s', async (_form, code) => {
        expect(fired(await lint(CORE, code), CORE_DYNAMIC)).toBe(1)
    })

    it('nor by import = require(), which the declaration half bans: one finding, not two', async () => {
        const findings = await lint(CORE, "import React = require('react')\nexport { React }\n")
        expect(fired(findings, CORE_STATIC)).toBe(1)
        expect(fired(findings, CORE_DYNAMIC)).toBe(0)
    })

    it('a library that is not a framework is fine', async () => {
        const code = "export const load = () => import('./pure')\nexport type Schema = import('zod').ZodType\n"
        expect(fired(await lint(CORE, code), CORE_DYNAMIC)).toBe(0)
    })

    it('outside core the framework ban does not apply', async () => {
        const code = "export const load = () => import('react-dom/client')\n"
        expect(fired(await lint('packages/kit/src/server-lib/kv.ts', code), CORE_DYNAMIC)).toBe(0)
    })
})

// The declarationless rules must read each group exactly as no-restricted-imports does, or the two halves
// of one fence disagree and the gap between them is a hole. Every specifier here is linted twice, once as a
// declaration and once as import(), and both must agree, including on the group syntax's quirks: a bare
// name matches at any depth (`@x/react`, `./react`), and matching ignores case (`React`).
describe('the two halves of each fence read the group the same way', () => {
    const SPECIFIERS = [
        'react',
        'React',
        // no-restricted-imports trims the specifier before matching, so the other half must too
        ' react',
        'react-dom',
        'react-dom/client',
        '@x/react',
        './react',
        'preact',
        'reactive',
        'next',
        'next/headers',
        'next-intl',
        'next-intl/server',
        'nextra',
        '@mantine/core',
        '@/x',
        '@/domain/tickets',
        '@app/seed',
        '@app/seed/world',
        '@app/seedling',
        '@sssb/app-config/jobs',
        // a `..` in a package or alias specifier climbs out of it (bareTraversalPattern, a regex: compiled `iu`
        // by no-restricted-imports, so by the declarationless half too)
        '@sssb/app-config/../seed',
        '@sssb/app-config/..\\proxy',
        '@sssb/app-config/x/../y',
        '@scope/../../apps/showcase/src/domain/tickets',
        '@SCOPE/../../apps/showcase/src/domain/tickets',
        'lodash/../../packages/seed/src/index',
        '.x/../../apps/showcase/src/domain/tickets',
        '.pnpm/../../apps/showcase/src/domain/tickets',
        '@\\..\\..\\apps\\showcase\\src\\domain\\tickets',
        '@//../../apps/showcase/src/domain/tickets',
        // ...but not one that does not climb
        '@sssb/app-config/apps/registry',
        '@sssb/app-config/x..y',
        // a specifier two patterns match is two findings, in BOTH halves: each reports every pattern it matches
        '@/../domain/tickets',
        '@app/seed/../world',
        'lodash/../../node_modules/.pnpm/node_modules/showcase/src/domain/tickets',
        // a package reached through node_modules, where pnpm links the apps and the seed (nodeModulesPathPattern)
        '.pnpm/node_modules/showcase/src/domain/tickets',
        'node_modules/@app/seed',
        '../../../../node_modules/.pnpm/node_modules/showcase/src/domain/tickets',
        '..\\..\\NODE_MODULES\\showcase',
        // ...but not a name that merely contains it
        './node_modules-cache/x',
    ]
    const halves: [string, string, Fence, Fence][] = [
        ['@sssb/kit/core', 'packages/kit/src/core/kv.ts', CORE_STATIC, CORE_DYNAMIC],
        ['the framework/app fence', 'packages/kit/src/server-lib/kv.ts', APP_CODE_STATIC, APP_CODE_DYNAMIC],
        ['the fixture', FIXTURE, APP_CODE_STATIC, APP_CODE_DYNAMIC],
    ]

    describe.each(halves)('%s', (_name, file, staticFence, dynamicFence) => {
        it.each(SPECIFIERS)('%s', async (specifier) => {
            // JSON.stringify writes the specifier as source text, so a backslash in it survives into the value.
            const at = JSON.stringify(specifier)
            const declared = fired(await lint(file, `import x from ${at}\nexport { x }\n`), staticFence)
            const loaded = fired(await lint(file, `export const load = () => import(${at})\n`), dynamicFence)
            expect(loaded, `static ${declared}, import() ${loaded}`).toBe(declared)
        })
    })

    it('the table is not vacuous: some specifiers are banned in each zone, and some are not', async () => {
        const core = 'packages/kit/src/core/kv.ts'
        expect(fired(await lint(core, "export const l = () => import('@x/react')\n"), CORE_DYNAMIC)).toBe(1)
        expect(fired(await lint(core, "export const l = () => import('nextra')\n"), CORE_DYNAMIC)).toBe(0)
        expect(fired(await lint(FIXTURE, "export const l = () => import('@app/seed/world')\n"), APP_CODE_DYNAMIC)).toBe(
            1,
        )
        expect(fired(await lint(FIXTURE, "export const l = () => import('@app/seedling')\n"), APP_CODE_DYNAMIC)).toBe(0)
    })
})

// The same app code by PATH: `../../../../apps/showcase/src/domain/tickets` from SSSB's server-lib is the file
// the app's `@/*` alias names, and `../../../seed/src/index` is `@app/seed`. sssb/no-path-to-app-code resolves a
// relative or absolute path against the importing file and reports it if it lands in apps/ or packages/seed/,
// in a declaration and everywhere else alike.
describe('a path into app code crosses the framework/app fence too', () => {
    // The path from `file` to `target`, as an importer would write it.
    const pathFrom = (file: string, target: string) => path.relative(path.dirname(file), target)
    // TypeScript resolves all of these to the same file; the rule ignores case, as macOS's file system does.
    const spellings = (to: string): [string, string][] => [
        ['posix', to],
        ['a doubled slash', to.replace('/', '//')],
        ['backslashes', to.replaceAll('/', '\\')],
        ['another case', to.replace('apps', 'Apps').replace('seed', 'Seed')],
    ]
    const forms = (at: string): [string, string][] => [
        ['a declaration', `import type { T } from ${at}\nexport type U = T\n`],
        ['a re-export', `export { T } from ${at}\n`],
        ['import()', `export const load = () => import(${at})\n`],
        ['a type-position import()', `export type U = import(${at}).T\n`],
        ['require()', `export const m = require(${at})\n`],
        ['import = require()', `import m = require(${at})\nexport { m }\n`],
    ]

    describe.each([...KIT, FIXTURE, 'packages/kit/src/server-lib/kv.test.ts'])('%s', (file) => {
        describe.each([
            ['an app', 'apps/showcase/src/domain/tickets'],
            ['the seed package', 'packages/seed/src/index'],
        ])('into %s', (_target, target) => {
            it.each(spellings(pathFrom(file, target)))('spelled with %s, in every form', async (_spelling, to) => {
                for (const [form, code] of forms(JSON.stringify(to))) {
                    expect(fired(await lint(file, code), APP_CODE_PATH), form).toBe(1)
                }
            })
        })
    })

    it('an absolute path into apps/ too', async () => {
        const to = JSON.stringify(path.join(process.cwd(), 'apps/showcase/src/domain/tickets'))
        expect(fired(await lint(FIXTURE, `export const load = () => import(${to})\n`), APP_CODE_PATH)).toBe(1)
    })

    // Node loads a `file:` URL as the absolute path it names, so it is a path too, in any case of the scheme.
    // Anywhere else out of packages/kit is the package-edge rule's finding, never both; and a `file:` URL into the
    // package names this checkout, which an adopter's machine has not, so it is that rule's finding too.
    it.each([
        ['into apps/', 'apps/showcase/src/domain/tickets.ts', 1, 0, 0],
        ['into the seed package', 'packages/seed/src/index.ts', 1, 0, 0],
        ['anywhere else', 'tests/support/tmp-dir.ts', 0, 1, 0],
        ['within the package', 'packages/kit/src/testing/tmp-dir.ts', 0, 0, 1],
    ])('a file: URL %s', async (_where, target, intoApp, outOfPackage, absolute) => {
        const url = pathToFileURL(path.join(process.cwd(), target)).href
        for (const spelled of [url, url.replace('file:', 'FILE:')]) {
            const findings = await lint(FIXTURE, `export const load = () => import(${JSON.stringify(spelled)})\n`)
            expect(fired(findings, APP_CODE_PATH), spelled).toBe(intoApp)
            expect(fired(findings, OUT_OF_PACKAGE_PATH), spelled).toBe(outOfPackage)
            expect(fired(findings, ABSOLUTE_IN_PACKAGE), spelled).toBe(absolute)
        }
    })

    // A `file:` URL with a literal `..` is still a path (pathToFileURL would normalize the `..` away, so it is
    // written out): the path rule judges where it lands, and the traversal ban, which is for package specifiers,
    // stays out of it.
    it.each([
        ['into apps/', 'packages/kit/../../apps/showcase/src/domain/tickets.ts', 1, 0],
        ['anywhere else', 'packages/kit/../../tests/support/tmp-dir.ts', 0, 1],
    ])('a file: URL with a `..` %s', async (_where, rest, expected, outOfPackage) => {
        const url = `${pathToFileURL(process.cwd()).href}/${rest}`
        const declared = await lint(FIXTURE, `import { x } from ${JSON.stringify(url)}\nexport { x }\n`)
        expect(fired(declared, APP_CODE_PATH)).toBe(expected)
        expect(fired(declared, OUT_OF_PACKAGE_PATH)).toBe(outOfPackage)
        expect(fired(declared, APP_CODE_STATIC)).toBe(0)
        const loaded = await lint(FIXTURE, `export const load = () => import(${JSON.stringify(url)})\n`)
        expect(fired(loaded, APP_CODE_PATH)).toBe(expected)
        expect(fired(loaded, APP_CODE_DYNAMIC)).toBe(0)
    })

    it('a path inside the package stays open; one out of it is the package-edge rule’s, not the app fence’s', async () => {
        const file = 'packages/kit/src/server-lib/kv.test.ts'
        const inside = ["import { a } from '../core/x'", "import { b } from '../testing/tmp-dir'", 'export { a, b }']
        const within = await lint(file, inside.join('\n'))
        expect(fired(within, APP_CODE_PATH) + fired(within, OUT_OF_PACKAGE_PATH)).toBe(0)
        const out = [
            `import { b } from ${JSON.stringify(pathFrom(file, 'tests/support/tmp-dir'))}`,
            "import { c } from '../../../apps-config/x'",
            `export const load = () => import(${JSON.stringify(pathFrom(file, 'scripts/release.mjs'))})`,
            `export type T = import(${JSON.stringify(pathFrom(file, 'tests/support/contract-postgres'))}).ContractServer`,
            'export { b, c }',
        ]
        const findings = await lint(file, out.join('\n'))
        expect(fired(findings, OUT_OF_PACKAGE_PATH)).toBe(4)
        // ...and a relative path's `..` is not the bare-specifier traversal ban's business, nor the app fence's
        expect(fired(findings, APP_CODE_PATH) + fired(findings, BARE_TRAVERSAL_STATIC)).toBe(0)
    })

    it('an absolute path out of the repo is out of the package too', async () => {
        const to = JSON.stringify(path.join(process.cwd(), '..', 'elsewhere', 'helper'))
        expect(
            fired(await lint(KIT[0] as string, `export const load = () => import(${to})\n`), OUT_OF_PACKAGE_PATH),
        ).toBe(1)
    })

    it('an absolute path into the package names this checkout, and is reported', async () => {
        const to = JSON.stringify(path.join(process.cwd(), 'packages/kit/src/core/roles'))
        const findings = await lint(KIT[0] as string, `import { r } from ${to}\nexport { r }\n`)
        expect(fired(findings, ABSOLUTE_IN_PACKAGE)).toBe(1)
        expect(fired(findings, OUT_OF_PACKAGE_PATH) + fired(findings, UNSHIPPED_PATH)).toBe(0)
    })

    // What ships is packages/kit/package.json's `files`, not the whole directory: a shipped file that reaches a test, a
    // story or the fixture resolves here and fails once installed. A file that does not ship may reach them.
    describe('a shipped file reaches only what ships', () => {
        const shipped = 'packages/kit/src/db/kv.ts'
        const reaches = [
            ['the test fixture', '../../test-fixture/app-config/seed', 1],
            ['a test', '../core/state-machine.test', 1],
            ['a story', '../components/app-header.stories', 1],
            ['a config beside src', '../../tsconfig.strict.json', 1],
            ['a test the allowlist names back', '../i18n/namespaces.test', 0],
            ['shipped source', '../core/state-machine', 0],
            ['a shipped catalog', '../i18n/messages/en.json', 0],
            ['a test, with a query', '../core/state-machine.test.ts?raw', 1],
            ['a test, with a hash', '../core/state-machine.test#a', 1],
            ['a sibling of a suite named back, by its own extension', '../i18n/namespaces.test.tsx', 1],
            ['a suite named back, by its extension', '../i18n/namespaces.test.ts', 0],
            ["the package's own manifest, which always ships", '../../package.json', 0],
            ['its LICENSE, which always ships', '../../LICENSE', 0],
            ['another file beside src', '../../README.md', 1],
        ] as const
        it.each(reaches)('from shipped source, %s', async (_what, to, expected) => {
            expect(fired(await lint(shipped, `import x from '${to}'\nexport { x }\n`), UNSHIPPED_PATH)).toBe(expected)
            expect(fired(await lint(shipped, `export const load = () => import('${to}')\n`), UNSHIPPED_PATH)).toBe(
                expected,
            )
        })
        it('from a conformance suite, which ships too', async () => {
            const code = "import x from '../core/state-machine.test'\nexport { x }\n"
            expect(fired(await lint('packages/kit/src/i18n/namespaces.test.ts', code), UNSHIPPED_PATH)).toBe(1)
        })
        it.each(['packages/kit/src/db/kv.test.ts', FIXTURE])('not from %s, which does not ship', async (file) => {
            const code = `import x from ${JSON.stringify(pathFrom(file, 'packages/kit/test-fixture/app-config/seed'))}\nexport { x }\n`
            expect(fired(await lint(file, code), UNSHIPPED_PATH)).toBe(0)
        })
        it('through a triple-slash reference path as well', async () => {
            const code = '/// <reference path="../../test-fixture/app-config/seed.ts" />\nexport const x = 1\n'
            expect(fired(await lint(shipped, code), UNSHIPPED_PATH)).toBe(1)
            const out = '/// <reference path="../../../../tests/support/zz.d.ts" />\nexport const x = 1\n'
            expect(fired(await lint(shipped, out), OUT_OF_PACKAGE_PATH)).toBe(1)
            expect(
                fired(await lint(shipped, '/// <reference types="node" />\nexport const x = 1\n'), UNSHIPPED_PATH),
            ).toBe(0)
        })
        it.each([
            ['a relative types=', '/// <reference types="../../test-fixture/app-config/seed" />'],
            [
                'path= after another attribute',
                '/// <reference preserve="true" path="../../test-fixture/app-config/seed.ts" />',
            ],
            ['in capitals', '/// <REFERENCE PATH="../../test-fixture/app-config/seed.ts" />'],
        ])('through %s', async (_form, reference) => {
            expect(fired(await lint(shipped, `${reference}\nexport const x = 1\n`), UNSHIPPED_PATH)).toBe(1)
        })
    })

    it('the contract tests are its only exemptions, and only by name', async () => {
        const code = `import { s } from '../../../../../tests/support/contract-postgres'\nexport { s }\n`
        for (const file of [
            'packages/kit/src/adapters/real/db.contract.test.ts',
            'packages/kit/src/adapters/real/rds-data.contract.test.ts',
        ])
            expect(fired(await lint(file, code), OUT_OF_PACKAGE_PATH), file).toBe(0)
        expect(
            fired(await lint('packages/kit/src/adapters/real/other.contract.test.ts', code), OUT_OF_PACKAGE_PATH),
        ).toBe(1)
    })

    it('a `..` that is part of a name, not a segment, climbs nowhere', async () => {
        const code = "import { a } from '@sssb/app-config/x..y'\nimport { b } from 'pkg/a..b/c'\nexport { a, b }\n"
        expect(fired(await lint('packages/kit/src/server-lib/kv.ts', code), BARE_TRAVERSAL_STATIC)).toBe(0)
    })

    it('an app reaching another app by path is not this fence’s business', async () => {
        const file = `${APP}/src/domain/kv.ts`
        const code = `export const load = () => import(${JSON.stringify(pathFrom(file, 'apps/starter/src/seed'))})\n`
        expect(fired(await lint(file, code), APP_CODE_PATH)).toBe(0)
    })

    // `@scope/../../apps/…` and `@sssb/app-config/../seed` are package and alias specifiers, not paths: TypeScript
    // resolves them out of node_modules or the seam into app code. bareTraversalPattern bans the `..`, in both
    // halves (the parity table holds them together). A specifier that is also the app's alias is that pattern's
    // finding too: two, not one, since no pattern exempts what another bans.
    describe.each([...KIT, FIXTURE])('%s', (file) => {
        it.each([
            ['@sssb/app-config/../seed', 1],
            ['@sssb/app-config/../domain/tickets', 1],
            ['@sssb/app-config/x/../../seed', 1],
            ['@scope/../../apps/showcase/src/domain/tickets', 1],
            ['lodash/../../packages/seed/src/index', 1],
            // a name that starts with a dot is a package name, not a path: only `./` and `../` are relative
            ['.x/../../apps/showcase/src/domain/tickets', 1],
            ['.pnpm/../../apps/showcase/src/domain/tickets', 1],
            // the app's alias, spelled with a backslash (read as a slash) or an empty segment, and climbing
            ['@\\..\\..\\apps\\showcase\\src\\domain\\tickets', 2],
            ['@app\\seed\\..\\..\\..\\apps\\showcase\\src\\domain\\tickets', 2],
            ['@//../../apps/showcase/src/domain/tickets', 2],
            ['@///../../apps/showcase/src/domain/tickets', 2],
        ] as const)('may not climb out of a package or alias with %s, in either half', async (specifier, findings) => {
            const at = JSON.stringify(specifier)
            const declared = await lint(file, `import { seed } from ${at}\nexport { seed }\n`)
            expect(fired(declared, BARE_TRAVERSAL_STATIC)).toBe(1)
            expect(fired(declared, APP_CODE_STATIC)).toBe(findings)
            const loaded = await lint(file, `export const load = () => import(${at})\n`)
            expect(fired(loaded, BARE_TRAVERSAL_DYNAMIC)).toBe(1)
            expect(fired(loaded, APP_CODE_DYNAMIC)).toBe(findings)
        })
    })

    // pnpm links the apps and the seed, among other workspace packages, into node_modules/.pnpm/node_modules,
    // so a specifier through node_modules reaches app code by where pnpm put it rather than by its name, whether
    // it is spelled as a package or as a path. nodeModulesPathPattern bans it in both halves; the path rule
    // leaves it to that pattern, so it is one finding, not two.
    describe.each([...KIT, FIXTURE])('%s', (file) => {
        it.each([
            '.pnpm/node_modules/showcase/src/domain/tickets',
            'node_modules/@app/seed/src/index',
            pathFrom(file, 'node_modules/.pnpm/node_modules/showcase/src/domain/tickets'),
            pathFrom(file, 'node_modules/.pnpm/node_modules/@app/seed/src/index').replaceAll('/', '\\'),
        ])('may not reach a package through node_modules with %s, in either half', async (specifier) => {
            const at = JSON.stringify(specifier)
            const declared = await lint(file, `import { seed } from ${at}\nexport { seed }\n`)
            expect(fired(declared, NODE_MODULES_STATIC)).toBe(1)
            expect(fired(declared, APP_CODE_PATH)).toBe(0)
            const loaded = await lint(file, `export const load = () => import(${at})\n`)
            expect(fired(loaded, NODE_MODULES_DYNAMIC)).toBe(1)
            expect(fired(loaded, APP_CODE_PATH)).toBe(0)
        })
    })

    it('a name that merely contains node_modules is not one', async () => {
        const code =
            "import { a } from './node_modules-cache/x'\nimport { b } from '@scope/my_node_modules'\nexport { a, b }\n"
        const findings = await lint('packages/kit/src/server-lib/kv.ts', code)
        expect(fired(findings, NODE_MODULES_STATIC)).toBe(0)
    })

    // The path is judged by where it really lands. Opened through a symlink to the checkout, as an editor's
    // workspace can be, every file's path starts somewhere the config's own directory does not; resolved
    // lexically, `../../../../apps/…` would then land outside the repo and in no app at all.
    it('through a symlink to the checkout, a path into apps/ is still one', async () => {
        const link = path.join(makeTestTmpDir('fence-symlink-'), 'checkout')
        symlinkSync(process.cwd(), link, 'dir')
        try {
            const eslint = new ESLint({ cwd: link })
            const file = 'packages/kit/src/server-lib/kv.ts'
            const lintThrough = async (code: string) => {
                const [result] = await eslint.lintText(code, { filePath: path.join(link, file) })
                expect(
                    result.messages.filter((m) => !m.ruleId),
                    'not actually linted',
                ).toEqual([])
                return result.messages.map((m) => ({ rule: m.ruleId as string, message: m.message }))
            }
            const into = JSON.stringify(pathFrom(file, 'apps/showcase/src/domain/tickets'))
            expect(fired(await lintThrough(`export const load = () => import(${into})\n`), APP_CODE_PATH)).toBe(1)
            const out = JSON.stringify(pathFrom(file, 'tests/support/tmp-dir'))
            const outFindings = await lintThrough(`export const load = () => import(${out})\n`)
            expect(fired(outFindings, APP_CODE_PATH)).toBe(0)
            expect(fired(outFindings, OUT_OF_PACKAGE_PATH)).toBe(1)
        } finally {
            // the link, never what it points at: the scratch directory's own removal must find nothing to follow
            unlinkSync(link)
        }
    })
})

// JSX in @sssb/kit/core imports react/jsx-runtime without naming it ("jsx": "react-jsx" in tsconfig.json), so
// neither half of core's import ban can see it. The JSX itself is the finding: each outermost element or fragment.
describe('@sssb/kit/core holds no JSX', () => {
    it.each([
        ['an element', 'export const C = () => <div>{1}</div>\n'],
        [
            'nested elements, reported once',
            'export const C = () => (\n    <ul>\n        <li>{1}</li>\n        <li>{2}</li>\n    </ul>\n)\n',
        ],
        ['a fragment', 'export const C = () => <>{1}</>\n'],
    ])('%s', async (_form, code) => {
        expect(fired(await lint('packages/kit/src/core/view.tsx', code), JSX_IN_CORE)).toBe(1)
    })

    // Each outermost element is a finding, so a disable comment on one does not hide the next.
    it('two elements are two findings, and disabling one leaves the other', async () => {
        const two = 'export const A = () => <div>{1}</div>\nexport const B = () => <span>{2}</span>\n'
        expect(fired(await lint('packages/kit/src/core/view.tsx', two), JSX_IN_CORE)).toBe(2)
        const disabled =
            '// eslint-disable-next-line sssb/no-jsx-in-core\nexport const A = () => <div>{1}</div>\n' +
            'export const B = () => <span>{2}</span>\n'
        expect(fired(await lint('packages/kit/src/core/view.tsx', disabled), JSX_IN_CORE)).toBe(1)
    })

    it('a .jsx file in core too', async () => {
        const code = 'export const C = () => <p>{1}</p>\n'
        expect(fired(await lint('packages/kit/src/core/view.jsx', code), JSX_IN_CORE)).toBe(1)
    })

    it('outside core, JSX is just JSX', async () => {
        const code = 'export const C = () => <div>{1}</div>\n'
        expect(fired(await lint('packages/kit/src/components/kv-panel.tsx', code), JSX_IN_CORE)).toBe(0)
    })
})

// The vendor fence's declarationless rule gained the type position too: `import type` of a vendor SDK is
// banned by no-restricted-imports, and the inline form was not.
describe('a vendor SDK named in a type import() is still a vendor import', () => {
    const code = "export type Client = import('@aws-sdk/client-s3').S3Client\n"

    it.each([`${APP}/src/domain/kv.ts`, 'packages/kit/src/server-lib/kv.ts', FIXTURE])('%s may not', async (file) => {
        expect(fired(await lint(file, code), VENDOR_DYNAMIC)).toBe(1)
    })

    it.each([`${APP}/src/adapters/real/kv.ts`, 'packages/kit/src/adapters/real/kv.ts'])('%s may', async (file) => {
        expect(fired(await lint(file, code), VENDOR_DYNAMIC)).toBe(0)
    })
})

// The vendor ban's declaration half sees TypeScript's `import m = require()`, so the declarationless rule leaves it
// alone: one finding, not two.
describe('a vendor SDK reached by import = require() is one finding, from the declaration half', () => {
    const code = "import s3 = require('@aws-sdk/client-s3')\nexport { s3 }\n"

    it.each([`${APP}/src/domain/kv.ts`, 'packages/kit/src/server-lib/kv.ts', FIXTURE])('%s may not', async (file) => {
        const findings = await lint(file, code)
        expect(fired(findings, VENDOR_STATIC)).toBe(1)
        expect(fired(findings, VENDOR_DYNAMIC)).toBe(0)
    })

    it.each([`${APP}/src/adapters/real/kv.ts`, 'packages/kit/src/adapters/real/kv.ts'])('%s may', async (file) => {
        const findings = await lint(file, code)
        expect(fired(findings, VENDOR_STATIC) + fired(findings, VENDOR_DYNAMIC)).toBe(0)
    })
})
