import { chmodSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs'
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

    it("fail an entry that matches no route handler in the app's own tree", async () => {
        const exemptions =
            `export default { files: { 'partner/gone/route.ts': ${PING_EXEMPTION} }, ` +
            `prefixes: { 'hooks/': ${PING_EXEMPTION} } }\n`
        // A route file that exports no handler (only a segment config) does not keep the entry alive either.
        const scan = await scanApp(
            app(
                {
                    'api/dockets/route.ts': AUTHORIZED_POST,
                    'api/partner/gone/route.ts': "export const dynamic = 'force-dynamic'\n",
                },
                exemptions,
            ),
        )
        expect(scan.exemptionProblems).toEqual([
            "acme/authz-exemptions.mjs: files `partner/gone/route.ts` is stale — the app's src/app/api has no route handler there",
            "acme/authz-exemptions.mjs: prefixes `hooks/` is stale — it covers no route handler in the app's src/app/api",
        ])
    })

    it('fail an org-scoped GET that never authorizes, and pass the same GET once it does (safeinsights/sssb#103)', async () => {
        // What an app runs: the conformance check's scan, not only the analyser, judges reads.
        const read = (call: string) =>
            `${AUTHORIZE}import { listDockets } from '../../../../dockets'\n` +
            `export async function GET() { ${call}return Response.json(await listDockets()) }\n`
        const open = await scanApp(app({ 'api/dockets/route.ts': read('') }))
        expect(open.failures).toHaveLength(1)
        expect(open.failures[0]).toMatch(
            /^acme: dockets\/route\.ts GET exports a read handler that does not reach authorize/,
        )
        const closed = await scanApp(
            app({
                'api/dockets/route.ts': read("authorize(user, 'depot', 'read', { type: 'Docket', orgId: 'depot' }); "),
            }),
        )
        expect(closed.failures).toEqual([])
    })

    it('keep an entry alive with a read route: a GET is judged, so its exemption is in use', async () => {
        // safeinsights/sssb#103: reads are judged too, so an entry naming a GET-only route is not stale.
        const exemptions = `export default { files: { 'partner/ping/route.ts': ${PING_EXEMPTION} } }\n`
        const scan = await scanApp(
            app(
                {
                    'api/dockets/route.ts': AUTHORIZED_POST,
                    'api/partner/ping/route.ts':
                        "import { partner } from '../../partner'\nexport async function GET() { return Response.json(await partner.ping()) }\n",
                },
                exemptions,
            ),
        )
        expect(scan.exemptionProblems).toEqual([])
        expect(scan.failures).toEqual([])
    })

    it('fail an unknown key, a malformed path, and a default export that is not an object', async () => {
        expect(appExemptionsFrom({ file: {} }, 'x').problems).toEqual([
            'x: unknown key `file` (only `files`, `prefixes`, `outsideApi`)',
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

describe('reads-only entries: a way through for reads that touch no org data (safeinsights/sssb#220)', () => {
    const readsOnly = (names: string[], reason = 'a public read of the listed values only') =>
        `{ reason: '${reason}', mustMatch: { kind: 'reads-only', names: ${JSON.stringify(names)} } }`
    const FEED =
        "import { publicPosts } from '../../../posts'\nexport async function GET() { return new Response(await publicPosts()) }\n"
    const PREFLIGHT =
        "import { corsHeaders } from '../../../cors'\nexport function OPTIONS() { return new Response(null, { status: 204, headers: corsHeaders }) }\n"
    const HANDSHAKE =
        "import { params } from '../../../../config/params'\n" +
        'export function GET(request: Request) { const q = new URL(request.url).searchParams; ' +
        "return q.get('hub.verify_token') === params.verifyToken ? new Response(q.get('hub.challenge')) : new Response(null, { status: 403 }) }\n"

    it('pass a public read outside src/app/api under outsideApi, and only the read', async () => {
        const exemptions = `export default { outsideApi: { files: { 'feed.xml/route.ts': ${readsOnly(['publicPosts'])} } } }\n`
        const scan = await scanApp(
            app({ 'api/dockets/route.ts': AUTHORIZED_POST, 'feed.xml/route.ts': FEED }, exemptions),
        )
        expect(scan.exemptionProblems).toEqual([])
        expect(scan.failures).toEqual([])
        // A mutation beside it can match no exemption outside src/app/api, as before.
        const withPost = await scanApp(
            app({ 'api/dockets/route.ts': AUTHORIZED_POST, 'feed.xml/route.ts': FEED + OPEN_POST }, exemptions),
        )
        expect(withPost.failures).toHaveLength(1)
        expect(withPost.failures[0]).toMatch(/^acme: \.\.\/feed\.xml\/route\.ts POST exports a mutating handler/)
    })

    it('fail a read that names anything beyond the listed names, or a global off the inert list', async () => {
        const exemptions = `export default { files: { 'cors/route.ts': ${readsOnly(['corsHeaders'])} } }\n`
        const extra =
            "import { corsHeaders, load } from '../../../cors'\nexport async function OPTIONS() { return new Response(await load(), { headers: corsHeaders }) }\n"
        const fetching =
            "import { corsHeaders } from '../../../cors'\nexport async function OPTIONS() { return fetch('http://x', { headers: corsHeaders }) }\n"
        for (const src of [extra, fetching]) {
            const scan = await scanApp(app({ 'api/cors/route.ts': src }, exemptions))
            expect(scan.failures).toHaveLength(1)
            expect(scan.failures[0]).toMatch(/sits under an exemption that holds only when the handler is a read/)
        }
        const ok = await scanApp(app({ 'api/cors/route.ts': PREFLIGHT }, exemptions))
        expect(ok.failures).toEqual([])
    })

    it('pass a handshake GET under the framework webhooks/ prefix, while its POST keeps the framework gate', async () => {
        const exemptions = `export default { files: { 'webhooks/meta/route.ts': ${readsOnly(['params'])} } }\n`
        const wrapped =
            "import { withWebhookSecret } from '../../respond'\nexport const POST = withWebhookSecret(async () => Response.json({}))\n"
        const pass = await scanApp(app({ 'api/webhooks/meta/route.ts': HANDSHAKE + wrapped }, exemptions))
        expect(pass.exemptionProblems).toEqual([])
        expect(pass.failures).toEqual([])
        const open = await scanApp(app({ 'api/webhooks/meta/route.ts': HANDSHAKE + OPEN_POST }, exemptions))
        expect(open.failures).toHaveLength(1)
        expect(open.failures[0]).toMatch(
            /webhooks\/meta\/route\.ts POST sits under an exemption that holds only when the handler is itself a call to an imported withWebhookSecret/,
        )
    })

    it('refuse every widening beyond those: another gate outside api, a prefix or another gate under a framework prefix, a framework file, a required gate', async () => {
        const { problems, exemptions } = appExemptionsFrom(
            {
                outsideApi: {
                    files: { 'feed/route.ts': { reason: 'r', mustMatch: { kind: 'calls', callees: ['publicPosts'] } } },
                    prefixes: { 'api/': { reason: 'r', mustMatch: { kind: 'reads-only', names: ['x'] } } },
                },
                files: {
                    'webhooks/a/route.ts': { reason: 'r', mustMatch: { kind: 'calls', callees: ['x'] } },
                    'profile/route.ts': { reason: 'r', mustMatch: { kind: 'reads-only', names: ['x'] } },
                    'service/jobs/route.ts': { reason: 'r', mustMatch: { kind: 'reads-only', names: ['x'] } },
                },
                prefixes: { 'webhooks/meta/': { reason: 'r', mustMatch: { kind: 'reads-only', names: ['x'] } } },
            },
            'x',
        )
        expect(exemptions).toEqual({ files: {}, prefixes: {} })
        expect(problems).toEqual([
            'x: outsideApi.files `feed/route.ts` must have a reads-only gate: a route outside src/app/api may be exempted only as a read that names nothing but its request, inert values and the names the gate lists',
            'x: outsideApi.prefixes `api/` is under src/app/api: name it in `prefixes`, relative to src/app/api',
            expect.stringMatching(/^x: files `webhooks\/a\/route\.ts` overlaps the framework's own entry `webhooks\/`/),
            expect.stringMatching(
                /^x: files `profile\/route\.ts` overlaps the framework's own entry `profile\/route\.ts`/,
            ),
            expect.stringMatching(
                /^x: files `service\/jobs\/route\.ts` overlaps the framework's own entry `service\/`/,
            ),
            expect.stringMatching(/^x: prefixes `webhooks\/meta\/` overlaps the framework's own entry `webhooks\/`/),
        ])
    })

    it('refuse a reads-only entry under simulator/, whose guarantee is a 404 in real mode', () => {
        const { problems } = appExemptionsFrom(
            {
                files: {
                    'simulator/dump/route.ts': { reason: 'r', mustMatch: { kind: 'reads-only', names: ['world'] } },
                },
            },
            'x',
        )
        expect(problems).toEqual([
            expect.stringMatching(
                /overlaps the framework's own entry `simulator\/`.*only a reads-only entry for one file may sit under `webhooks\/`/,
            ),
        ])
    })

    it('match keys by URL: a route group is dropped, so a group cannot reach back into api/ or under service/', () => {
        const { problems, exemptions } = appExemptionsFrom(
            {
                outsideApi: {
                    files: {
                        '(g)/api/service/x/route.ts': { reason: 'r', mustMatch: { kind: 'reads-only', names: ['p'] } },
                    },
                },
                files: { '(g)/service/x/route.ts': { reason: 'r', mustMatch: { kind: 'reads-only', names: ['p'] } } },
            },
            'x',
        )
        expect(exemptions).toEqual({ files: {}, prefixes: {} })
        expect(problems).toEqual([
            expect.stringMatching(/outsideApi\.files `\(g\)\/api\/service\/x\/route\.ts` is under src\/app\/api/),
            expect.stringMatching(
                /files `\(g\)\/service\/x\/route\.ts` overlaps the framework's own entry `service\/`/,
            ),
        ])
    })

    it('take a dynamic segment literally in a key, so a public read under [locale] can be named', async () => {
        const exemptions = `export default { outsideApi: { files: { '(site)/[locale]/feed.xml/route.ts': ${readsOnly(['publicPosts'])} } } }\n`
        const scan = await scanApp(
            app({ 'api/dockets/route.ts': AUTHORIZED_POST, '(site)/[locale]/feed.xml/route.ts': FEED }, exemptions),
        )
        expect(scan.exemptionProblems).toEqual([])
        expect(scan.failures).toEqual([])
        expect(
            appExemptionsFrom(
                { files: { 'a/[*]/route.ts': { reason: 'r', mustMatch: { kind: 'calls', callees: ['x'] } } } },
                'x',
            ).problems,
        ).toEqual([expect.stringMatching(/must be a literal path/)])
    })

    it('match a slot like a group: an @slot key under simulator/ overlaps the framework entry', () => {
        const { problems } = appExemptionsFrom(
            { files: { '@s/simulator/x/route.ts': { reason: 'r', mustMatch: { kind: 'calls', callees: ['noop'] } } } },
            'x',
        )
        expect(problems).toEqual([expect.stringMatching(/overlaps the framework's own entry `simulator\/`/)])
    })

    it('refuse two keys that name one route once groups and slots are dropped, and apply neither', () => {
        const entry = { reason: 'r', mustMatch: { kind: 'reads-only', names: ['posts'] } }
        const { problems, exemptions } = appExemptionsFrom(
            { files: { 'feed/route.ts': entry, '(g)/feed/route.ts': entry, '@s/feed/route.ts': entry } },
            'x',
        )
        expect(exemptions.files).toEqual({})
        expect(problems).toEqual([
            'x: files `(g)/feed/route.ts` names the same route as another key once route groups and slots are dropped',
            'x: files `@s/feed/route.ts` names the same route as another key once route groups and slots are dropped',
        ])
    })

    it("count a prefix entry's names only from the reads it governs", async () => {
        const exemptions =
            `export default { prefixes: { 'cors/': ${readsOnly(['corsHeaders'])} }, ` +
            `files: { 'cors/own/route.ts': ${readsOnly(['corsHeaders'])} } }\n`
        const scan = await scanApp(
            app(
                {
                    'api/cors/own/route.ts': PREFLIGHT,
                    'api/cors/other/route.ts': `import { authorize } from '@sssb/kit/authz/authorize'\nimport { corsHeaders } from '../../../../cors'\nconst user = null as never\nexport function GET() { authorize(user, 'depot', 'read', { type: 'Docket', orgId: 'depot' }); return new Response(null, { headers: corsHeaders }) }\n`,
                },
                exemptions,
            ),
        )
        expect(scan.failures).toEqual([])
        expect(scan.exemptionProblems).toEqual([
            'acme/authz-exemptions.mjs: prefixes `cors/` lists `corsHeaders`, which no read handler it covers names; list only what the read uses',
        ])
    })

    it('call no name unused beside a read the gate refuses outright', async () => {
        const exemptions = `export default { files: { 'cors/route.ts': ${readsOnly(['corsHeaders'])} } }\n`
        const refused =
            "import { corsHeaders } from '../../../cors'\nexport function OPTIONS() { return fetch('http://x', { headers: corsHeaders }) }\n"
        const scan = await scanApp(app({ 'api/cors/route.ts': refused }, exemptions))
        expect(scan.failures).toHaveLength(1)
        expect(scan.failures[0]).toMatch(/It cannot pass one: `fetch` is a global off the inert list/)
        expect(scan.exemptionProblems).toEqual([])
    })

    it('call a listed name stale when no read handler it covers names it', async () => {
        const exemptions = `export default { files: { 'cors/route.ts': ${readsOnly(['corsHeaders', 'db'])} } }\n`
        const scan = await scanApp(app({ 'api/cors/route.ts': PREFLIGHT }, exemptions))
        expect(scan.failures).toEqual([])
        expect(scan.exemptionProblems).toEqual([
            'acme/authz-exemptions.mjs: files `cors/route.ts` lists `db`, which no read handler it covers names; list only what the read uses',
        ])
    })

    it('refuse a reads-only gate whose names are not names', () => {
        for (const names of [[], ['a.b'], [''], [3]]) {
            const { problems } = appExemptionsFrom(
                { files: { 'a/route.ts': { reason: 'r', mustMatch: { kind: 'reads-only', names } } } },
                'x',
            )
            expect(problems, JSON.stringify(names)).toEqual([expect.stringMatching(/has no checkable mustMatch gate/)])
        }
    })

    it('call a reads-only entry stale where no read handler is, and an outsideApi entry by its own key', async () => {
        const exemptions =
            `export default { files: { 'cors/route.ts': ${readsOnly(['corsHeaders'])} }, ` +
            `outsideApi: { files: { 'gone/route.ts': ${readsOnly(['publicPosts'])} } } }\n`
        const scan = await scanApp(app({ 'api/cors/route.ts': AUTHORIZED_POST }, exemptions))
        expect(scan.exemptionProblems).toEqual([
            "acme/authz-exemptions.mjs: files `cors/route.ts` is stale — the app's src/app/api has no read handler there",
            "acme/authz-exemptions.mjs: outsideApi.files `gone/route.ts` is stale — the app's src/app has no read handler there",
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

describe('the seam review (build output, unreadable directories)', () => {
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
    const WIPE = "'use server'\nexport async function wipe() { return 'wiped' }\n"

    it("a 'use server' function in build output is not the app's source; one in lib/ beside src still fails", async () => {
        const scan = await scanApp(
            appWith({
                'infra/cdk.out/asset.abc/index.mjs': WIPE,
                'dist-demo/assets/x.js': WIPE,
                'lib/outside.ts': WIPE,
            }),
        )
        expect(scan.failures).toEqual([
            expect.stringMatching(/^acme: lib\/outside\.ts declares Server Actions outside src/),
        ])
    })

    const root = typeof process.getuid === 'function' && process.getuid() === 0
    it.skipIf(root)(
        'a directory the scan cannot read is a failure naming it and the error code, never skipped',
        async () => {
            const dir = appWith({ 'src/app/api/secret/route.ts': OPEN_POST, 'lib/locked/x.ts': WIPE })
            const locked = [path.join(dir, 'src/app/api/secret'), path.join(dir, 'lib/locked')]
            for (const target of locked) chmodSync(target, 0o000)
            try {
                const scan = await scanApp(dir)
                expect(scan.failures).toEqual(
                    expect.arrayContaining([
                        expect.stringMatching(
                            /^acme: secret \* cannot be checked: the directory could not be read \(EACCES\)/,
                        ),
                        expect.stringMatching(
                            /^acme: app\/api\/secret Server Action `\*` cannot be checked: the directory could not be read \(EACCES\)/,
                        ),
                        expect.stringMatching(/^acme: lib\/locked could not be read \(EACCES\)/),
                    ]),
                )
            } finally {
                for (const target of locked) chmodSync(target, 0o755)
            }
        },
    )
})
