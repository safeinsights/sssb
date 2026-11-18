import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { makeTestTmpDir } from '../testing/tmp-dir'
import { APP_EXEMPTIONS_FILE, appExemptionsFrom, scanApp } from './app-exemptions'

/**
 * The per-app authorization scan the conformance suite's `authz-mutations` check runs, and the app-owned exemptions
 * it reads from `<app>/authz-exemptions.mjs` — on scratch apps, so every way an exemptions file can be wrong is seen
 * to fail. The framework's own policy and its staleness against the fixture are authorized-mutations.test.ts's.
 */

const AUTHORIZE = "import { authorize } from '@sssb/kit/authz/authorize'\ndeclare const user: never\n"
const AUTHORIZED_POST = `${AUTHORIZE}export async function POST() { authorize(user, 'depot', 'create', { type: 'Docket', orgId: 'depot' }); return Response.json({}) }\n`
const PINGING_POST =
    "import { partner } from '../../../../partner'\nexport async function POST() { await partner.ping(); return Response.json({}) }\n"
const OPEN_POST = 'export async function POST() { return Response.json({ open: true }) }\n'

/** A scratch app: route files by path under `src/app`, and an optional exemptions module source. */
function app(routes: Record<string, string>, exemptions?: string): string {
    const dir = path.join(makeTestTmpDir('authz-app-'), 'acme')
    for (const [rel, src] of Object.entries(routes)) {
        mkdirSync(path.dirname(path.join(dir, 'src/app', rel)), { recursive: true })
        writeFileSync(path.join(dir, 'src/app', rel), src)
    }
    if (exemptions !== undefined) writeFileSync(path.join(dir, APP_EXEMPTIONS_FILE), exemptions)
    return dir
}

const PING_EXEMPTION =
    "{ reason: 'a liveness ping to the partner, no product resource', mustMatch: { kind: 'calls', callees: ['partner.ping'] } }"

describe('scanApp', () => {
    it('walks the whole src/app, and passes an authorized handler with no exemptions file', async () => {
        const scan = await scanApp(app({ 'api/dockets/route.ts': AUTHORIZED_POST, 'page/route.ts': 'export {}' }))
        expect(scan.routes.map((route) => route.rel)).toEqual(['dockets/route.ts', '../page/route.ts'])
        expect(scan.failures).toEqual([])
        expect(scan.exemptionProblems).toEqual([])
    })

    it('fails every unauthorized handler, inside api/ and out, one line each', async () => {
        const scan = await scanApp(app({ 'api/open/route.ts': OPEN_POST, '[locale]/danger/route.ts': OPEN_POST }))
        expect(scan.failures).toHaveLength(2)
        expect(scan.failures[0]).toMatch(/^acme: \.\.\/\[locale\]\/danger\/route\.ts POST exports a mutating handler/)
        expect(scan.failures[1]).toMatch(/^acme: open\/route\.ts POST exports a mutating handler/)
    })

    it('finds nothing in an app without src/app (the check fails that by its walk guard)', async () => {
        const scan = await scanApp(path.join(makeTestTmpDir('authz-app-'), 'acme'))
        expect(scan.routes).toEqual([])
    })
})

describe("an app's own exemptions", () => {
    it('apply a valid entry: the gated handler passes, and the same path without the gate does not', async () => {
        const exemptions = `export default { files: { 'partner/ping/route.ts': ${PING_EXEMPTION} } }\n`
        const gated = await scanApp(app({ 'api/partner/ping/route.ts': PINGING_POST }, exemptions))
        expect(gated.failures).toEqual([])
        expect(gated.exemptionProblems).toEqual([])
        const open = await scanApp(app({ 'api/partner/ping/route.ts': OPEN_POST }, exemptions))
        expect(open.failures).toHaveLength(1)
        expect(open.failures[0]).toMatch(/sits under an exemption that holds only when/)
    })

    it('apply a valid prefix entry to every route under it', async () => {
        const exemptions = `export default { prefixes: { 'partner/': ${PING_EXEMPTION} } }\n`
        const scan = await scanApp(
            app({ 'api/partner/a/route.ts': PINGING_POST, 'api/partner/b/route.ts': PINGING_POST }, exemptions),
        )
        expect(scan.failures).toEqual([])
        expect(scan.exemptionProblems).toEqual([])
    })

    it('fail an entry without a gate, and do not apply it', async () => {
        const exemptions = "export default { files: { 'partner/ping/route.ts': { reason: 'trust me' } } }\n"
        const scan = await scanApp(app({ 'api/partner/ping/route.ts': OPEN_POST }, exemptions))
        expect(scan.exemptionProblems).toEqual([
            expect.stringMatching(
                /^acme\/authz-exemptions\.mjs: files `partner\/ping\/route\.ts` has no checkable mustMatch gate/,
            ),
        ])
        expect(scan.failures).toHaveLength(1)
    })

    it('fail an entry that collides with a framework entry, and do not apply it', async () => {
        // An app cannot replace the framework's `profile/route.ts` gate, slip a file under its `webhooks/` prefix,
        // or exempt a `service/` route from the withServiceCaller gate.
        const problems = appExemptionsFrom(
            {
                files: {
                    'profile/route.ts': { reason: 'mine', mustMatch: { kind: 'opens-with-simulated-404' } },
                    'webhooks/partner/route.ts': { reason: 'mine', mustMatch: { kind: 'opens-with-simulated-404' } },
                },
                prefixes: { 'service/': { reason: 'mine', mustMatch: { kind: 'opens-with-simulated-404' } } },
            },
            'acme/authz-exemptions.mjs',
        )
        expect(problems.exemptions).toEqual({ files: {}, prefixes: {} })
        expect(problems.problems).toEqual([
            expect.stringMatching(/files `profile\/route\.ts` overlaps the framework's own entry `profile\/route\.ts`/),
            expect.stringMatching(
                /files `webhooks\/partner\/route\.ts` overlaps the framework's own entry `webhooks\/`/,
            ),
            expect.stringMatching(/prefixes `service\/` overlaps the framework's own entry `service\/`/),
        ])
    })

    it("fail an entry that matches no mutating route in the app's own tree", async () => {
        const exemptions =
            `export default { files: { 'partner/gone/route.ts': ${PING_EXEMPTION} }, ` +
            `prefixes: { 'hooks/': ${PING_EXEMPTION} } }\n`
        // A GET-only route at the path does not keep the entry alive either.
        const scan = await scanApp(
            app(
                {
                    'api/dockets/route.ts': AUTHORIZED_POST,
                    'api/partner/gone/route.ts': 'export async function GET() { return Response.json({}) }\n',
                },
                exemptions,
            ),
        )
        expect(scan.exemptionProblems).toEqual([
            "acme/authz-exemptions.mjs: files `partner/gone/route.ts` is stale — the app's src/app/api has no mutating route there",
            "acme/authz-exemptions.mjs: prefixes `hooks/` is stale — it covers no mutating route in the app's src/app/api",
        ])
    })

    it('fail an unknown key, a malformed path, and a default export that is not an object', async () => {
        expect(appExemptionsFrom({ file: {} }, 'x').problems).toEqual([
            'x: unknown key `file` (only `files` and `prefixes`)',
        ])
        expect(
            appExemptionsFrom(
                {
                    files: { 'partner/*/route.ts': {}, '../outside/route.ts': {}, 'partner/ping': {} },
                    prefixes: { partner: {} },
                },
                'x',
            ).problems,
        ).toEqual([
            expect.stringMatching(/files `partner\/\*\/route\.ts` must be a literal path/),
            expect.stringMatching(/files `\.\.\/outside\/route\.ts` must be a literal path/),
            expect.stringMatching(/files `partner\/ping` must name one route file/),
            expect.stringMatching(/prefixes `partner` is a prefix, so it must end with \//),
        ])
        expect(appExemptionsFrom([], 'x').problems).toEqual([
            'x: its default export must be an object with `files` and/or `prefixes`',
        ])
        const scan = await scanApp(
            app({ 'api/dockets/route.ts': AUTHORIZED_POST }, 'export default { files: {} }\nthrow new Error("boom")\n'),
        )
        expect(scan.exemptionProblems).toEqual([
            expect.stringMatching(/^acme\/authz-exemptions\.mjs: does not load: .*boom/),
        ])
    })
})
