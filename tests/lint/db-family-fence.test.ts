import { existsSync, readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'

/**
 * The database family fence (ADR-0015, second addendum, point 3). SSSB's logic stays generic over the database, and
 * what is specific to one engine belongs to that engine's family (`packages/kit/src/db/family.ts`). So no module of
 * the framework writes engine SQL unless it is one of the Postgres family's own: its dialect helpers and tenant scope,
 * its migrations, its isolation proofs, its transports, and the tooling that reads Postgres's own catalogs. Everything
 * else, the data modules above all, calls the family's helpers (`family.json`, `family.lockRow`, `family.currentTime`,
 * `family.keysetSlice`) and writes none.
 *
 * Engine SQL, as this fence reads it from the syntax of each module:
 *
 *  - Kysely's raw SQL: `sql` imported from `kysely` (under any local name, or re-exported), `CompiledQuery` (whose
 *    `raw` takes a SQL string), anything reached through a namespace import of `kysely`, and `import('kysely')`;
 *  - a row lock: `forUpdate`, `forShare`, `forKeyShare` or `forNoKeyUpdate`, called, destructured, or named as a key
 *    in a string;
 *  - the jsonb encoding: importing the `jsonb` module (`./jsonb`, `@sssb/kit/db/jsonb`).
 *
 * What it cannot read: a key computed at run time (`q['for' + 'Update']`), and SQL handed to a driver as a string
 * (`client.query('BEGIN')`), which only the family's transports and their emulator do. It is a fence against the
 * framework's logic drifting back into one engine's SQL, not a proof that it cannot.
 *
 * Scope: every source module under `packages/kit/src` that ships (a declaration file holds no code). Tests and
 * stories do not ship (`@sssb/kit`'s `files`), and a
 * test of the family's own SQL has to write it. An app's code is the app's: its queries are written for its family
 * too, and nothing here reaches `apps/*`.
 *
 * Exemptions are exact paths, never directories, each with its reason; one that names a missing file, or a file that
 * no longer writes engine SQL, fails as stale.
 */
const KIT_SRC = path.resolve(__dirname, '../../packages/kit/src')

const MIGRATIONS = [
    '0001_tenants',
    '0003_organizations',
    '0004_jobs',
    '0005_service_keys',
    '0008_audit_events',
    '0009_job_schedules',
    '0010_webhooks',
    '0011_notifications',
    '0012_inbound_email',
    '0013_agreements',
    '0014_audit_credential',
    '0015_app_user_grant',
    '0016_audit_detail',
    '0017_job_requester',
    '0019_job_attempts',
]

/** The Postgres family's own modules, relative to `packages/kit/src`, each with why it is the family's. */
const POSTGRES_FAMILY: Readonly<Record<string, string>> = {
    'db/family.ts': "the family's runtime half: its dialect helpers, isolation and tenant scope",
    'db/jsonb.ts': "the family's JSON encoding, a published subpath (`@sssb/kit/db/jsonb`)",
    'db/with-tenant.ts': "the family's tenant scope: `set_config` of the role and the tenant",
    ...Object.fromEntries(
        MIGRATIONS.map((name) => [
            `db/migrations/${name}.ts`,
            "one of the family's framework migrations (Postgres DDL)",
        ]),
    ),
    'db/rls-proofs.ts': "the framework's half of the family's isolation proofs",
    'db/rls-coverage.ts': "the family's coverage proof, reading pg_class, pg_policies and the grants",
    'db/owner-pass.ts': "the family's non-superuser owner proof: roles, databases and grants",
    'adapters/fake/pglite-dialect.ts': "the pglite transport's dialect: transaction control as raw statements",
    'adapters/real/rds-data-dialect.ts': "the Data API transport's dialect: its migration lock and transaction control",
    'adapters/real/contract-postgres.ts': 'the contract server: an embedded Postgres, its databases and roles',
    'db/app-roles.ts': 'catalog tooling: reads pg_roles and pg_auth_members',
    'db/migrate.ts': 'catalog tooling: the migrator reads its own bookkeeping table',
    'testing/conformance/db.ts': "catalog tooling: the conformance suite's schema and role reads on pglite",
    'testing/contract.ts': "catalog tooling: the contract runner's role reads on real Postgres",
}

const ROW_LOCKS = new Set(['forUpdate', 'forShare', 'forKeyShare', 'forNoKeyUpdate'])
const RAW_SQL_IMPORTS = new Set(['sql', 'CompiledQuery'])
const isKysely = (specifier: string) => specifier === 'kysely' || specifier.startsWith('kysely/')
const isJsonbModule = (specifier: string) => /(^|\/)jsonb(\.[cm]?[jt]sx?)?$/.test(specifier)

/** What engine SQL `source` writes, one line per finding; empty when it writes none. */
function engineSqlIn(fileName: string, source: string): string[] {
    const file = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true)
    const findings: string[] = []
    const at = (node: ts.Node, what: string) =>
        findings.push(`${file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1}: ${what}`)
    const specifierOf = (node: ts.Expression | undefined) =>
        node !== undefined && ts.isStringLiteralLike(node) ? node.text : undefined

    const visit = (node: ts.Node): void => {
        if (ts.isImportDeclaration(node) && !node.importClause?.isTypeOnly) {
            const from = specifierOf(node.moduleSpecifier)
            const bindings = node.importClause?.namedBindings
            if (from !== undefined && isJsonbModule(from)) at(node, `imports the jsonb encoding from '${from}'`)
            if (from !== undefined && isKysely(from) && bindings !== undefined) {
                if (ts.isNamespaceImport(bindings)) at(node, `imports all of '${from}', its raw SQL included`)
                else
                    for (const element of bindings.elements) {
                        const imported = (element.propertyName ?? element.name).text
                        if (!element.isTypeOnly && RAW_SQL_IMPORTS.has(imported))
                            at(element, `imports \`${imported}\` from '${from}'`)
                    }
            }
        }
        if (ts.isExportDeclaration(node) && !node.isTypeOnly) {
            const from = specifierOf(node.moduleSpecifier)
            if (from !== undefined && isJsonbModule(from)) at(node, `re-exports the jsonb encoding from '${from}'`)
            if (from !== undefined && isKysely(from)) {
                const clause = node.exportClause
                if (clause === undefined || ts.isNamespaceExport(clause))
                    at(node, `re-exports all of '${from}', its raw SQL included`)
                else
                    for (const element of clause.elements) {
                        const exported = (element.propertyName ?? element.name).text
                        if (!element.isTypeOnly && RAW_SQL_IMPORTS.has(exported))
                            at(element, `re-exports \`${exported}\` from '${from}'`)
                    }
            }
        }
        if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
            const from = specifierOf(node.moduleReference.expression)
            if (from !== undefined && (isKysely(from) || isJsonbModule(from))) at(node, `requires '${from}'`)
        }
        if (ts.isCallExpression(node)) {
            const from = specifierOf(node.arguments[0])
            const loads =
                node.expression.kind === ts.SyntaxKind.ImportKeyword ||
                (ts.isIdentifier(node.expression) && node.expression.text === 'require')
            if (loads && from !== undefined && (isKysely(from) || isJsonbModule(from))) at(node, `loads '${from}'`)
        }
        if (ts.isImportTypeNode(node)) {
            // `import('kysely').RawBuilder` names a type and loads nothing: allowed
        } else if (ts.isPropertyAccessExpression(node) && ROW_LOCKS.has(node.name.text)) {
            at(node, `takes a row lock (\`${node.name.text}\`)`)
        } else if (ts.isElementAccessExpression(node)) {
            const key = specifierOf(node.argumentExpression)
            if (key !== undefined && ROW_LOCKS.has(key)) at(node, `takes a row lock (\`${key}\`)`)
        } else if (ts.isBindingElement(node) && ROW_LOCKS.has((node.propertyName ?? node.name).getText(file))) {
            at(node, `destructures a row lock (\`${(node.propertyName ?? node.name).getText(file)}\`)`)
        } else if (
            ts.isStringLiteralLike(node) &&
            ROW_LOCKS.has(node.text) &&
            !ts.isElementAccessExpression(node.parent)
        ) {
            at(node, `names a row lock as a key ('${node.text}')`)
        }
        ts.forEachChild(node, visit)
    }
    visit(file)
    return findings
}

const SOURCE = /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/
const SHIPS_NOT = /\.(test|stories)\.[^/]+$|\.d\.[cm]?ts$/

function shippedModules(dir: string): string[] {
    return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
        const full = path.join(dir, entry.name)
        if (entry.isDirectory()) return shippedModules(full)
        return SOURCE.test(entry.name) && !SHIPS_NOT.test(entry.name) ? [full] : []
    })
}

const relative = (file: string) => path.relative(KIT_SRC, file).split(path.sep).join('/')

/**
 * What a module loads when it runs, or that a bundler follows into a build: its value imports and re-exports, and every
 * literal `import()` and `require()`. A type-only import or re-export, and `import('…')` in a type, load nothing.
 */
function loadedSpecifiers(fileName: string, source: string): string[] {
    const file = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true)
    const loaded: string[] = []
    const visit = (node: ts.Node): void => {
        if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
            const clause = node.importClause
            const bindings = clause?.namedBindings
            const typeOnly =
                clause !== undefined &&
                (clause.isTypeOnly ||
                    (clause.name === undefined &&
                        bindings !== undefined &&
                        ts.isNamedImports(bindings) &&
                        bindings.elements.length > 0 &&
                        bindings.elements.every((element) => element.isTypeOnly)))
            if (!typeOnly) loaded.push(node.moduleSpecifier.text)
        } else if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
            if (!node.isTypeOnly) loaded.push(node.moduleSpecifier.text)
        } else if (
            ts.isCallExpression(node) &&
            (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
                (ts.isIdentifier(node.expression) && node.expression.text === 'require')) &&
            node.arguments[0] !== undefined
        ) {
            // A specifier computed at run time is one this walk cannot follow, and a bundler builds a context module
            // from its static prefix, taking in every module that matches. So it is recorded as itself, and fails.
            const [specifier] = node.arguments
            loaded.push(ts.isStringLiteralLike(specifier) ? specifier.text : `<computed: ${specifier.getText(file)}>`)
        }
        ts.forEachChild(node, visit)
    }
    visit(file)
    return loaded
}

/** Every module `entry` loads, transitively: the kit's own by path relative to its `src`, a package by its name. */
function loadedFrom(entry: string): Set<string> {
    const reached = new Set<string>()
    const pending = [entry]
    while (pending.length > 0) {
        const file = pending.pop()!
        if (reached.has(relative(file))) continue
        reached.add(relative(file))
        for (const specifier of loadedSpecifiers(file, readFileSync(file, 'utf8'))) {
            if (!specifier.startsWith('.')) {
                reached.add(specifier)
                continue
            }
            const base = path.resolve(path.dirname(file), specifier)
            const found = [`${base}.ts`, `${base}.tsx`, path.join(base, 'index.ts')].find((candidate) =>
                existsSync(candidate),
            )
            if (found === undefined) throw new Error(`${relative(file)}: cannot resolve '${specifier}'`)
            pending.push(found)
        }
    }
    return reached
}

describe("the family's runtime half", () => {
    // The data modules and the transports import ./family.ts on the request path, and a bundler follows every literal
    // `import()` into the server build. So the runtime half loads nothing but Kysely and the two modules it reuses:
    // the migrations, the migrator and the proofs (the app's among them) are the suite half's (./family-suite.ts).
    it('loads nothing but kysely, the jsonb encoding and the tenant scope', () => {
        expect([...loadedFrom(path.join(KIT_SRC, 'db/family.ts'))].sort()).toEqual(
            ['db/family.ts', 'db/jsonb.ts', 'db/with-tenant.ts', 'kysely'].sort(),
        )
    })

    it('reads a loader, which would bring the suite half in', () => {
        const source = "import { sql } from 'kysely'\nexport const proofs = () => import('./rls-proof-runner')\n"
        expect(loadedSpecifiers('db/probe.ts', source)).toEqual(['kysely', './rls-proof-runner'])
        expect(loadedSpecifiers('db/probe.ts', "import type { DB } from './schema'\nexport type T = DB\n")).toEqual([])
        // a specifier computed at run time is not followed: it is reported, so the closure above cannot equal its list
        expect(loadedSpecifiers('db/probe.ts', 'export const load = (name) => import(`./${name}`)\n')).toEqual([
            '<computed: `./${name}`>',
        ])
    })

    it('is the only half the request path loads: just the suites import the suite half', () => {
        const importers = shippedModules(KIT_SRC)
            .filter((file) =>
                loadedSpecifiers(file, readFileSync(file, 'utf8')).some((specifier) =>
                    /(^|\/)family-suite(\.ts)?$/.test(specifier),
                ),
            )
            .map(relative)
            .sort()
        expect(importers).toEqual(['testing/conformance/db.ts', 'testing/contract.ts'])
    })
})

describe('the database family fence', () => {
    it("no framework module writes engine SQL unless it is one of the Postgres family's", () => {
        const offenders = shippedModules(KIT_SRC)
            .map((file) => ({ file: relative(file), findings: engineSqlIn(file, readFileSync(file, 'utf8')) }))
            .filter(({ file, findings }) => findings.length > 0 && !Object.hasOwn(POSTGRES_FAMILY, file))
            .map(({ file, findings }) => `packages/kit/src/${file}\n    ${findings.join('\n    ')}`)
        expect(
            offenders,
            "these modules write engine SQL: call the database family's helpers instead (packages/kit/src/db/family.ts), " +
                "or, for a module that IS the Postgres family's, name it with its reason in this file's POSTGRES_FAMILY",
        ).toEqual([])
    })

    it('every exemption names a module that exists and still writes engine SQL', () => {
        const stale = Object.keys(POSTGRES_FAMILY).filter((file) => {
            const full = path.join(KIT_SRC, file)
            return !existsSync(full) || engineSqlIn(full, readFileSync(full, 'utf8')).length === 0
        })
        expect(stale, 'stale exemptions: remove them from POSTGRES_FAMILY').toEqual([])
    })

    describe('reads every form', () => {
        const FORMS: [string, string][] = [
            ['a raw sql template', "import { sql } from 'kysely'\nexport const now = sql`now()`\n"],
            ['sql under another name', "import { sql as raw } from 'kysely'\nexport const now = raw`now()`\n"],
            ['sql beside types', "import { type Kysely, sql } from 'kysely'\nexport const x = sql`1`\n"],
            [
                'CompiledQuery.raw',
                "import { CompiledQuery } from 'kysely'\nexport const q = CompiledQuery.raw('begin')\n",
            ],
            ['a namespace import', "import * as k from 'kysely'\nexport const now = k.sql`now()`\n"],
            ['a re-export', "export { sql } from 'kysely'\n"],
            ['a star re-export', "export * from 'kysely'\n"],
            ['a dynamic import', "export const load = () => import('kysely')\n"],
            ['a require', "const { sql } = require('kysely')\nmodule.exports = sql\n"],
            ['forUpdate', 'export const lock = (q) => q.forUpdate()\n'],
            ['forShare', 'export const lock = (q) => q.forShare()\n'],
            ['forNoKeyUpdate', 'export const lock = (q) => q.forNoKeyUpdate()\n'],
            ['forKeyShare', 'export const lock = (q) => q.forKeyShare()\n'],
            ['a row lock as a computed key', "export const lock = (q) => q['forUpdate']()\n"],
            [
                'a destructured row lock',
                'export const lock = (q) => {\n    const { forUpdate } = q\n    return forUpdate.call(q)\n}\n',
            ],
            ['a row lock destructured from a parameter', 'export const lock = ({ forShare }) => forShare()\n'],
            [
                'a row lock as a key held in a variable',
                "const key = 'forUpdate'\nexport const lock = (q) => q[key]()\n",
            ],
            ['the jsonb module', "import { jsonb } from './jsonb'\nexport const v = jsonb([1])\n"],
            [
                'the published jsonb subpath',
                "import { jsonb } from '@sssb/kit/db/jsonb'\nexport const v = jsonb([1])\n",
            ],
        ]
        it.each(FORMS)('%s', (_name, source) => {
            expect(engineSqlIn('db/probe.ts', source)).not.toEqual([])
        })

        const ALLOWED: [string, string][] = [
            ['types from kysely', "import type { Kysely, Transaction } from 'kysely'\nexport type T = Kysely<never>\n"],
            ['a type-only sql name', "import { type sql } from 'kysely'\nexport type T = typeof sql\n"],
            ['an import type', "export type R = import('kysely').RawBuilder<string>\n"],
            ['the family', "import { family } from './family'\nexport const lock = (q) => q.$call(family.lockRow)\n"],
            ['a word in a comment', "// FOR UPDATE, jsonb and sql`now()` are the family's\nexport const x = 1\n"],
        ]
        it.each(ALLOWED)('allows %s', (_name, source) => {
            expect(engineSqlIn('db/probe.ts', source)).toEqual([])
        })
    })
})
