import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs'
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

    it('fail nested app prefixes, both of them, rather than let one silently drop the other gate', async () => {
        // `hooks/` is listed first, so a scan taking the first matching prefix would judge hooks/partner/ by the
        // looser `partner.ping` gate and never check `withPartnerSignature`.
        const exemptions =
            `export default { prefixes: { 'hooks/': ${PING_EXEMPTION}, 'hooks/partner/': { reason: 'signed by the ` +
            `partner', mustMatch: { kind: 'wrapped-by', callees: ['withPartnerSignature'] } } } }\n`
        const scan = await scanApp(
            app({ 'api/hooks/a/route.ts': PINGING_POST, 'api/hooks/partner/b/route.ts': PINGING_POST }, exemptions),
        )
        expect(scan.exemptionProblems).toEqual([
            expect.stringMatching(/prefixes `hooks\/` overlaps the app's own prefix `hooks\/partner\/`/),
            expect.stringMatching(/prefixes `hooks\/partner\/` overlaps the app's own prefix `hooks\/`/),
        ])
        // Neither applies, so neither route passes on a gate.
        expect(scan.failures).toHaveLength(2)
        expect(scan.failures.join('\n')).toMatch(/hooks\/partner\/b\/route\.ts POST exports a mutating handler/)
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

describe('what the scan reaches beyond src/app route files (baseline review of 0.4.0)', () => {
    /** A scratch app with files by path under the app's directory itself (not src/app). */
    function appWith(files: Record<string, string>): string {
        const dir = path.join(makeTestTmpDir('authz-app-'), 'acme')
        mkdirSync(path.join(dir, 'src/app/api/dockets'), { recursive: true })
        writeFileSync(path.join(dir, 'src/app/api/dockets/route.ts'), AUTHORIZED_POST)
        for (const [rel, src] of Object.entries(files)) {
            mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true })
            writeFileSync(path.join(dir, rel), src)
        }
        return dir
    }

    it.each(['src/pages/api/wipe.ts', 'pages/api/wipe.ts'])(
        'fails a Pages Router API directory (%s) outright',
        async (file) => {
            const scan = await scanApp(appWith({ [file]: 'export default function handler() {}\n' }))
            expect(scan.failures).toEqual([expect.stringMatching(/pages\/api is a Pages Router API directory/)])
        },
    )

    it("fails every export of a 'use server' file that does not reach authorize, and passes one that does", async () => {
        const scan = await scanApp(
            appWith({
                'src/actions/dockets.ts':
                    `'use server'\n${AUTHORIZE}` +
                    "export async function wipe() { return 'wiped' }\n" +
                    "export async function file() { authorize(user, 'depot', 'create', { type: 'Docket', orgId: 'depot' }) }\n",
            }),
        )
        expect(scan.actions.map((action) => action.name)).toEqual(['wipe', 'file'])
        expect(scan.failures).toEqual([
            expect.stringMatching(/^acme: actions\/dockets\.ts Server Action `wipe` does not reach authorize/),
        ])
    })

    it("fails an inline 'use server' function, anywhere under src", async () => {
        const scan = await scanApp(
            appWith({
                'src/components/wipe-form.tsx':
                    "export function WipeForm() {\n  async function wipe() {\n    'use server'\n    return 'wiped'\n  }\n  return wipe\n}\n",
            }),
        )
        expect(scan.failures).toEqual([
            expect.stringMatching(/components\/wipe-form\.tsx Server Action `wipe \(line 2\)` does not reach/),
        ])
    })

    it('fails a root-level app/ directory, which Next serves instead of src/app', async () => {
        const scan = await scanApp(appWith({ 'app/api/wipe/route.ts': OPEN_POST }))
        expect(scan.failures).toEqual([expect.stringMatching(/^acme: app\/ is a root-level App Router directory/)])
    })

    it('fails a file named route.<ext> the scan does not read, naming it, and leaves tests and stories alone', async () => {
        const scan = await scanApp(
            appWith({
                'src/app/api/x/route.mts': OPEN_POST,
                'src/app/api/y/route.api.ts': OPEN_POST,
                'src/app/api/dockets/route.test.ts': 'export {}\n',
                'src/app/api/dockets/route.stories.tsx': 'export {}\n',
            }),
        )
        expect(scan.failures).toEqual([
            expect.stringMatching(/^acme: src\/app\/api\/x\/route\.mts is named like a route/),
            expect.stringMatching(/^acme: src\/app\/api\/y\/route\.api\.ts is named like a route/),
        ])
    })

    it("does not take a 'use server' string that is not a directive for one", async () => {
        const scan = await scanApp(
            appWith({
                'src/lib/notes.ts':
                    "export const note = 'use server'\nexport function f() { const x = 'use server'; return x }\n",
            }),
        )
        expect(scan.actions).toEqual([])
        expect(scan.failures).toEqual([])
    })
})

describe("the fix review's verdict (X3, X9, X10, X11)", () => {
    function appWith(files: Record<string, string>, links: Record<string, string> = {}): string {
        const dir = path.join(makeTestTmpDir('authz-app-'), 'acme')
        mkdirSync(path.join(dir, 'src/app/api/dockets'), { recursive: true })
        writeFileSync(path.join(dir, 'src/app/api/dockets/route.ts'), AUTHORIZED_POST)
        for (const [rel, src] of Object.entries(files)) {
            mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true })
            writeFileSync(path.join(dir, rel), src)
        }
        for (const [rel, target] of Object.entries(links)) {
            mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true })
            symlinkSync(target.startsWith('/') ? target : path.join(dir, target), path.join(dir, rel))
        }
        return dir
    }
    const WIPE = "'use server'\nexport async function wipe() { return 'wiped' }\n"

    it('X3: a dangling link with a source extension under src is skipped, and the actions beside it still judged', async () => {
        const scan = await scanApp(
            appWith({ 'src/actions/dockets.ts': WIPE }, { 'src/actions/.#dockets.ts': '/nonexistent/user@host.1234' }),
        )
        expect(scan.failures).toEqual([
            expect.stringMatching(/actions\/dockets\.ts Server Action `wipe` does not reach/),
        ])
    })

    it("X9: a 'use server' file in the app but outside src fails; node_modules and dot-directories are not read", async () => {
        const scan = await scanApp(
            appWith({ 'lib/outside.ts': WIPE, 'node_modules/pkg/index.js': WIPE, '.next/server/app.js': WIPE }),
        )
        expect(scan.failures).toEqual([
            expect.stringMatching(/^acme: lib\/outside\.ts declares Server Actions outside src/),
        ])
    })

    it('X10: an action whose try swallows the denial is told to authorize before the try', async () => {
        const scan = await scanApp(
            appWith({
                'src/actions/save.ts':
                    "'use server'\n" +
                    AUTHORIZE +
                    "export async function save() { try { authorize(user, 'depot', 'create', { type: 'Docket', orgId: 'depot' }); return { ok: true } } catch (e) { return { error: String(e) } } }\n",
            }),
        )
        expect(scan.failures).toEqual([expect.stringMatching(/try whose catch does not rethrow.*before any try/)])
    })

    it('X11: two links per level to the same directory are walked once, so a deep tree stays quick', async () => {
        const links: Record<string, string> = {}
        const files: Record<string, string> = {}
        // 12 levels, each with two links to the next: exponential without a visited set.
        for (let level = 0; level < 12; level++) {
            files[`src/app/l${level}/page.txt`] = ''
            links[`src/app/l${level}/a`] = `src/app/l${level + 1}`
            links[`src/app/l${level}/b`] = `src/app/l${level + 1}`
        }
        files['src/app/l12/page.txt'] = ''
        const started = Date.now()
        const scan = await scanApp(appWith(files, links))
        expect(Date.now() - started).toBeLessThan(5000)
        expect(scan.failures).toEqual([])
    })
})

describe("the fix review's second verdict (Y1, Y2, Y5)", () => {
    function appWith(files: Record<string, string>, links: Record<string, string> = {}): string {
        const dir = path.join(makeTestTmpDir('authz-app-'), 'acme')
        mkdirSync(path.join(dir, 'src/app/api/dockets'), { recursive: true })
        writeFileSync(path.join(dir, 'src/app/api/dockets/route.ts'), AUTHORIZED_POST)
        for (const [rel, src] of Object.entries(files)) {
            mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true })
            writeFileSync(path.join(dir, rel), src)
        }
        for (const [rel, target] of Object.entries(links)) {
            mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true })
            symlinkSync(path.join(dir, target), path.join(dir, rel))
        }
        return dir
    }

    it('Y1: colocated test artefacts named route.* are not routes; other extensions still fail', async () => {
        const scan = await scanApp(
            appWith({
                'src/app/api/x/__snapshots__/route.test.ts.snap': '',
                'src/app/api/x/route.integration.test.ts': 'export {}\n',
                'src/app/api/x/route.contract.test.ts': 'export {}\n',
                'src/app/api/x/route.test-d.ts': 'export {}\n',
                'src/app/api/x/route.bench.ts': 'export {}\n',
                'src/app/api/y/route.api.ts': OPEN_POST,
            }),
        )
        expect(scan.failures).toEqual([expect.stringMatching(/src\/app\/api\/y\/route\.api\.ts is named like a route/)])
    })

    // One real directory, outside src/app, holding a handler that passes only under the framework's `webhooks/`
    // exemption, linked twice under src/app/api. Next serves it at both paths; the verdict must not depend on which
    // link the walk meets first.
    const HOOK =
        "import { withWebhookSecret } from './respond'\nexport const POST = withWebhookSecret(async () => new Response('ok'))\n"
    it.each([
        ['webhooks/hook', 'zadmin/hook', 'zadmin/hook/route.ts'],
        ['admin/hook', 'webhooks/hook', 'admin/hook/route.ts'],
    ])('Y2: a directory linked at %s and %s is judged at both paths', async (first, second, failing) => {
        const scan = await scanApp(
            appWith(
                {
                    'shared/hook/route.ts': HOOK,
                    'shared/hook/respond.ts': 'export const withWebhookSecret = (f: unknown) => f\n',
                },
                { [`src/app/api/${first}`]: 'shared/hook', [`src/app/api/${second}`]: 'shared/hook' },
            ),
        )
        expect(scan.routes.map((route) => route.rel).sort()).toEqual(
            ['dockets/route.ts', `${first}/route.ts`, `${second}/route.ts`].sort(),
        )
        expect(scan.failures).toEqual([expect.stringContaining(failing)])
    })

    it('Y5: a root-level FILE named app is not a root App Router directory', async () => {
        const scan = await scanApp(appWith({ app: 'not a directory\n' }))
        expect(scan.failures).toEqual([])
    })
})
