import { makeTestTmpDir } from '../testing/tmp-dir'
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { EXEMPT_FILES, EXEMPT_PREFIXES, FRAMEWORK_POLICY as POLICY, isGate, REQUIRED_ALONGSIDE } from './route-policy'
import { type ScanRoot, exemptionFor, isReadVerb, judge, scanRoutes } from './route-scan'

/**
 * Bypass-catcher for the authorization choke point. Subject orgIds are handler-derived, so
 * authorize(...) can't be a route wrapper — it's an explicit call inside each handler. This
 * build-time scan makes "every product route is authorized" a checked invariant rather than a discipline: it
 * judges EACH exported handler on its own, a read (GET/HEAD/OPTIONS) as well as a mutation (POST/PUT/PATCH/DELETE):
 * the handler must reach authorize(...) on its own path, or its route must sit in the justified exemption map AND
 * the handler must pass that exemption's gate. A read handler may instead read nothing, naming only inert globals and
 * its request (./route-scan.ts `readsNothing`, safeinsights/sssb#103). "Reach" is may-reach: the scan
 * does not prove that every path authorizes, or that it does so before mutating (./route-scan.ts, "What it does
 * not prove").
 *
 * The judging is ./route-scan.ts: it reads the files with the TypeScript compiler's parser and binder, so a
 * string, a comment, a call in another handler, a dead branch or an uncalled function proves nothing (the
 * scan used to match the file's TEXT, and each of those passed; ADR-0012 addendum, 2026-11-17). What it
 * follows and what it refuses is stated at the top of that file. The POLICY (the exemptions and the gates
 * they rest on) is ./route-policy.ts, in source, because the conformance suite applies it too.
 */

/**
 * WHICH TREES ARE SCANNED, AND WHERE.
 *
 * The scan's original subject is the HOST APPS' route trees (Next.js keeps route files in the app's
 * src/app forever — ADR-0012). Each app's tree is now scanned by the app ITSELF: the conformance suite's
 * `authz-mutations` check (`@sssb/kit/testing`, ./app-exemptions.ts `scanApp`), which every app's
 * `src/sssb.conformance.test.ts` runs over its own `src/app` with the framework's policy plus the app's own
 * `authz-exemptions.mjs`. So no app opts out by existing, and an adopter's app, whose tree this repo
 * never sees, is scanned the same way (ADR-0014 part 3).
 *
 * THIS file scans the framework's own reference tree, `packages/kit/test-fixture/api` (resolved
 * package-relative so it is found wherever the suite runs): one thin, never-served file per invariant the
 * scan asserts. "Is this exemption still real?" is a question about that tree, not about whichever apps
 * happen to be checked out: an adopter who ships no assistant route has not made the "stateless LLM call"
 * exemption a lie, they have merely stopped using it — and it is the only reading that survives
 * deleting the showcase. An app's OWN exemptions are measured against the app's tree instead
 * (./app-exemptions.ts).
 *
 * The "is really walked" case below is the walk guard: a wrong root finds nothing and fails loudly
 * instead of passing vacuously.
 */
// fileURLToPath on the URL STRING, then path.resolve — NOT `new URL('…', import.meta.url)`: this suite
// runs in the happy-dom environment, whose global URL does not resolve a relative reference against a
// `file:` base the way node's does, and `fileURLToPath` then rejects the result as non-file.
const FIXTURE_API_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../test-fixture/api')
const REPO_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..')

/**
 * `tsconfig` is the one whose module resolution a re-exported handler is followed with: for the fixture
 * the root one, which is what typechecks it.
 */
const ROOTS: ScanRoot[] = [
    {
        label: 'packages/kit/test-fixture',
        dir: FIXTURE_API_DIR,
        exemptDir: FIXTURE_API_DIR,
        tsconfig: path.join(REPO_DIR, 'tsconfig.json'),
    },
]

describe('every API route handler is authorized', () => {
    const routes = scanRoutes(ROOTS)
    const judged = routes.filter((route) => route.handlers.length > 0)
    /** Judged routes contributed by the FIXTURE root — what the exemption map is checked against. */
    const fixture = judged.filter((route) => route.root === 'packages/kit/test-fixture')
    const fixtureRels = new Set(fixture.map((route) => route.rel))

    it.each(ROOTS.map((root) => root.label))('%s is really walked (guards against a broken walk)', (label) => {
        // Per root: a mis-resolved root finds nothing, which is exactly the vacuous pass this case exists to
        // prevent. (Each app's own walk guard is the conformance suite's `authz-mutations` check.) The
        // fixture root is package-relative, so it is present in every checkout no matter which apps exist.
        expect(routes.filter((route) => route.root === label).length, label).toBeGreaterThan(0)
    })

    it('the fixture root contributes judged routes (nothing below is vacuous)', () => {
        expect(fixtureRels.size).toBeGreaterThan(0)
    })

    it('the fixture tree still carries a route for every invariant this scan asserts', () => {
        // Named explicitly so a rename inside the fixture cannot quietly retire an invariant: an
        // authorized product mutation and read, a read that reads nothing (the liveness probe), a file whose two verbs are judged separately (one through a same-file
        // helper), a framework membership mutation, a MACHINE mutation (a service caller, authorized with its
        // machine actor rather than exempted), and one route per gated prefix. The exemption-staleness cases
        // below cover the EXEMPT_FILES half.
        for (const rel of [
            'dockets/route.ts',
            'dockets/[id]/route.ts',
            'org/invite/route.ts',
            'service/jobs/route.ts',
            'webhooks/jobs/route.ts',
            'simulator/reset/route.ts',
            'simulator/world/route.ts',
            'health/route.ts',
        ]) {
            expect([...fixtureRels], rel).toContain(rel)
        }
        const verbsOf = (rel: string) =>
            fixture.find((route) => route.rel === rel)?.handlers.map((handler) => handler.verb)
        expect(verbsOf('dockets/[id]/route.ts')).toEqual(['PATCH', 'DELETE'])
        // Reads are judged too (safeinsights/sssb#103): an authorized org-scoped read, a machine's read under the
        // `service/` gate, and a read under the `simulator/` prefix exemption.
        expect(verbsOf('dockets/route.ts')).toEqual(['GET', 'POST'])
        expect(verbsOf('service/jobs/route.ts')).toEqual(['GET', 'POST'])
        expect(verbsOf('simulator/world/route.ts')).toEqual(['GET'])
    })

    it('each fixture read passes for the reason it stands for, not by reading nothing', () => {
        // A read that reads nothing passes without authorize(...), so a fixture read that did would prove nothing
        // about the rule or exemption it is there for. The one that DOES read nothing is the liveness probe.
        const readOf = (rel: string) =>
            fixture.find((route) => route.rel === rel)?.handlers.find((handler) => handler.verb === 'GET')?.facts
        for (const rel of [
            'dockets/route.ts',
            'service/jobs/route.ts',
            'simulator/world/route.ts',
            'storage/[...key]/route.ts',
        ]) {
            expect(readOf(rel)?.readsNothing, rel).toBe(false)
        }
        expect(readOf('dockets/route.ts')?.reachesAuthorize).toBe(true)
        expect(readOf('service/jobs/route.ts')?.reachesAuthorize).toBe(true)
        expect(readOf('health/route.ts')).toMatchObject({ reachesAuthorize: false, readsNothing: true })
    })

    it('at least one handler of each kind is NON-exempt and genuinely reaches authorize(...)', () => {
        // Without this the whole suite could pass vacuously: if every route were exempt, each per-handler case below
        // would take the exemption branch and never check anything. Per kind, a mutation and a read.
        for (const read of [false, true]) {
            const enforced = judged.filter(
                (route) =>
                    !exemptionFor(POLICY, route.rel) &&
                    route.handlers.some(
                        (handler) => isReadVerb(handler.verb) === read && handler.facts?.reachesAuthorize,
                    ),
            )
            expect(enforced.length, read ? 'a read' : 'a mutation').toBeGreaterThan(0)
        }
    })

    for (const route of judged) {
        for (const handler of route.handlers) {
            it(`${route.root}: ${route.rel} ${handler.verb} reaches authorize(...) or passes its exemption's gate`, () => {
                // Exempt: the gate the reason rests on must hold for THIS handler, in THIS root, so an app
                // route never inherits an exemption on the strength of its path alone, and one verb's gate
                // never covers another's.
                expect(judge(route, handler, POLICY)).toBeUndefined()
            })
        }
    }

    it('every exemption carries a checkable gate', () => {
        // The type already requires `mustMatch`, but a type is not present at run time and this map
        // is the one place where forgetting it costs an authorization bypass in someone ELSE's app:
        // an exemption is matched by relative path in every root, so a gateless entry would exempt
        // any adopter route that happened to sit at that path. Belt and braces, deliberately.
        for (const [rel, exemption] of [
            ...Object.entries(EXEMPT_FILES),
            ...Object.entries(EXEMPT_PREFIXES),
            ...Object.entries(REQUIRED_ALONGSIDE),
        ]) {
            expect(
                isGate(exemption.mustMatch),
                `exemption for ${rel} has no checkable mustMatch — a bare exemption exempts that path in EVERY root, ` +
                    `including an adopter's app. Name the gate the reason rests on, or drop the exemption.`,
            ).toBe(true)
            expect(exemption.reason.length, rel).toBeGreaterThan(0)
        }
    })

    it('has no stale exact exemptions (each is backed by a judged route in the fixture tree)', () => {
        // Checked against the FIXTURE, not an app: see the note above ROOTS. An entry with no
        // fixture file behind it is either dead or an exemption nobody is prepared to demonstrate.
        for (const rel of Object.keys(EXEMPT_FILES)) {
            expect(
                fixtureRels.has(rel),
                `exemption for ${rel} is stale — packages/kit/test-fixture/api has no route handler at that path`,
            ).toBe(true)
        }
    })

    it('has no stale required-alongside gates (each covers a judged route in the fixture tree)', () => {
        for (const prefix of Object.keys(REQUIRED_ALONGSIDE)) {
            expect(
                [...fixtureRels].some((rel) => rel.startsWith(prefix)),
                `required gate ${prefix} covers no route handler in packages/kit/test-fixture/api`,
            ).toBe(true)
        }
    })

    it('has no stale prefix exemptions (each covers a judged route in the fixture tree)', () => {
        for (const prefix of Object.keys(EXEMPT_PREFIXES)) {
            expect(
                [...fixtureRels].some((rel) => rel.startsWith(prefix)),
                `prefix exemption ${prefix} covers no route handler in packages/kit/test-fixture/api — ` +
                    `remove it or a rename left it dangling`,
            ).toBe(true)
        }
    })
})

/**
 * The route shapes that PASSED the text-matching scan this replaced (ADR-0012 addendum, 2026-11-17), judged
 * against the framework's policy (./route-policy.ts). Each was dropped into an app's api tree and run through the old scan, which
 * passed every row below that now fails, except the comment-only mention, which failed there too. The second and
 * third rows are the two that review found (`.claude/future-tasks/resolved/authz-scan-exemption-matches-text-not-verbs.md`).
 * The rest are the same flaw in the main rule, in the `service/` gate and in the `simulator/` gate, and the last
 * three are what this change's own review found: a local look-alike of a gate, and a 404 branch that does work.
 */
describe('the shapes the text-matching scan passed now fail', () => {
    const AUTHORIZE = "import { authorize } from '@sssb/kit/authz/authorize'\n"
    const CREATE = "authorize(user, 'depot', 'create', { type: 'Docket', orgId: 'depot' })"
    const cases: Array<{ name: string; rel: string; src: string; fails: string[] }> = [
        {
            name: 'a webhook route wrapped by its guard (the real shape) passes',
            rel: 'webhooks/repro/route.ts',
            src: "import { withWebhookSecret } from '../respond'\nexport const POST = withWebhookSecret(async () => Response.json({}))\n",
            fails: [],
        },
        {
            name: "the guard's name in a string, and an open POST",
            rel: 'webhooks/repro/route.ts',
            src: "const why = 'withWebhookSecret('\nexport const POST = async () => Response.json({ why })\n",
            fails: ['POST'],
        },
        {
            name: 'a guarded POST beside an unguarded DELETE',
            rel: 'webhooks/repro/route.ts',
            src:
                "import { withWebhookSecret } from '../respond'\nexport const POST = withWebhookSecret(async () => Response.json({}))\n" +
                'export async function DELETE() { return Response.json({ open: true }) }\n',
            fails: ['DELETE'],
        },
        {
            name: "the guard's name only in a comment (failed before too)",
            rel: 'webhooks/repro/route.ts',
            src: '// withWebhookSecret(\nexport const POST = async () => Response.json({})\n',
            fails: ['POST'],
        },
        {
            name: "'authorize(' in a string, and an open POST",
            rel: 'repro/route.ts',
            src: "const why = 'authorize('\nexport async function POST() { return Response.json({ why }) }\n",
            fails: ['POST'],
        },
        {
            name: 'an authorized POST beside an open DELETE',
            rel: 'repro/route.ts',
            src:
                `${AUTHORIZE}declare const user: never\nexport async function POST() { ${CREATE}; return Response.json({}) }\n` +
                'export async function DELETE() { return Response.json({ open: true }) }\n',
            fails: ['DELETE'],
        },
        {
            name: 'authorize(...) under `if (false)`',
            rel: 'repro/route.ts',
            src: `${AUTHORIZE}declare const user: never\nexport async function POST() { if (false) ${CREATE}; return Response.json({}) }\n`,
            fails: ['POST'],
        },
        {
            name: 'authorize(...) after the return',
            rel: 'repro/route.ts',
            src: `${AUTHORIZE}declare const user: never\nexport async function POST() { return Response.json({}); ${CREATE} }\n`,
            fails: ['POST'],
        },
        {
            name: 'authorize(...) in a function the handler never calls',
            rel: 'repro/route.ts',
            src:
                `${AUTHORIZE}declare const user: never\n` +
                `export async function POST() { const check = () => ${CREATE}; return Response.json({ check: typeof check }) }\n`,
            fails: ['POST'],
        },
        {
            name: 'authorize(...) only in the GET beside an open POST',
            rel: 'repro/route.ts',
            src:
                `${AUTHORIZE}declare const user: never\nexport async function GET() { ${CREATE}; return Response.json({}) }\n` +
                'export async function POST() { return Response.json({ open: true }) }\n',
            fails: ['POST'],
        },
        {
            name: 'authorize(...) only in an async helper the handler does not await',
            rel: 'repro/route.ts',
            src:
                `${AUTHORIZE}declare const user: never\nasync function check() { ${CREATE} }\n` +
                'export async function POST() { check(); return Response.json({ mutated: true }) }\n',
            fails: ['POST'],
        },
        {
            name: 'the same async helper, awaited, passes',
            rel: 'repro/route.ts',
            src:
                `${AUTHORIZE}declare const user: never\nasync function check() { ${CREATE} }\n` +
                'export async function POST() { await check(); return Response.json({}) }\n',
            fails: [],
        },
        {
            name: 'a service route naming withServiceCaller only in a string',
            rel: 'service/repro/route.ts',
            src: `${AUTHORIZE}declare const user: never\nconst note = 'withServiceCaller('\nexport async function POST() { ${CREATE}; return Response.json({ note }) }\n`,
            fails: ['POST'],
        },
        {
            name: 'a wrapped service POST beside an unwrapped PATCH',
            rel: 'service/repro/route.ts',
            src:
                `${AUTHORIZE}import { withServiceCaller } from '../../respond'\ndeclare const user: never\n` +
                `export const POST = withServiceCaller(async () => { ${CREATE}; return Response.json({}) })\n` +
                `export async function PATCH() { ${CREATE}; return Response.json({}) }\n`,
            fails: ['PATCH'],
        },
        {
            name: 'a simulator route whose 404 gate guards POST only, beside an open DELETE',
            rel: 'simulator/repro/route.ts',
            src:
                "import { isSimulated } from '@sssb/kit/adapters/index'\n" +
                'export async function POST() { if (!isSimulated) return new Response(null, { status: 404 }); return Response.json({}) }\n' +
                'export async function DELETE() { return Response.json({ open: true }) }\n',
            fails: ['DELETE'],
        },
        {
            name: 'a simulator route naming its gate only in a string',
            rel: 'simulator/repro/route.ts',
            src: "const note = 'if (!isSimulated)'\nexport async function POST() { return Response.json({ note }) }\n",
            fails: ['POST'],
        },
        {
            name: 'a webhook route wrapped by a local look-alike of its guard',
            rel: 'webhooks/repro/route.ts',
            src: 'const withWebhookSecret = (h: unknown) => h\nexport const POST = withWebhookSecret(async () => Response.json({ open: true }))\n',
            fails: ['POST'],
        },
        {
            name: 'a simulator route whose isSimulated is a local constant',
            rel: 'simulator/repro/route.ts',
            src:
                'const isSimulated = true\n' +
                'export async function POST() { if (!isSimulated) return new Response(null, { status: 404 }); return Response.json({}) }\n',
            fails: ['POST'],
        },
        {
            name: 'a simulator route whose real-mode branch mutates before the 404',
            rel: 'simulator/repro/route.ts',
            src:
                "import { isSimulated } from '@sssb/kit/adapters/index'\ndeclare const db: { wipe(): Promise<void> }\n" +
                'export async function POST() { if (!isSimulated) { await db.wipe(); return new Response(null, { status: 404 }) } return Response.json({}) }\n',
            fails: ['POST'],
        },
        // safeinsights/sssb#103: reads were never judged, so each of these passed every gate.
        {
            name: 'an org-scoped GET that never authorizes',
            rel: 'repro/route.ts',
            src:
                "import { auth, db } from '@sssb/kit/adapters/index'\nimport { listDockets } from '@/domain/dockets'\n" +
                'export async function GET() { const user = await auth.requireUser(); return Response.json(await listDockets(db, user.orgSlug)) }\n',
            fails: ['GET'],
        },
        {
            name: 'an authorized POST beside an open GET',
            rel: 'repro/route.ts',
            src:
                `${AUTHORIZE}import { listDockets } from '@/domain/dockets'\ndeclare const user: never\n` +
                'export async function GET() { return Response.json(await listDockets()) }\n' +
                `export async function POST() { ${CREATE}; return Response.json({}) }\n`,
            fails: ['GET'],
        },
        {
            name: "a GET whose org resolution and read sit in a helper of another module (the scan does not guess 'org-scoped')",
            rel: 'repro/route.ts',
            src: "import { myDockets } from '@/domain/dockets'\nexport async function GET() { return Response.json(await myDockets()) }\n",
            fails: ['GET'],
        },
        {
            name: 'an authorized GET, and a liveness probe that reads nothing, pass',
            rel: 'repro/route.ts',
            src:
                `${AUTHORIZE}import { listDockets } from '@/domain/dockets'\ndeclare const user: never\n` +
                `export async function GET() { authorize(user, 'depot', 'read', { type: 'Docket', orgId: 'depot' }); return Response.json(await listDockets()) }\n` +
                'export function HEAD() { return new Response(null, { headers: { date: new Date().toUTCString() } }) }\n',
            fails: [],
        },
        {
            name: 'a simulator GET that lost its 404 gate',
            rel: 'simulator/repro/route.ts',
            src: "import { readWorld } from '../world'\nexport async function GET() { return Response.json(await readWorld()) }\n",
            fails: ['GET'],
        },
    ]

    it.each(cases)('$name', ({ rel, src, fails }) => {
        const dir = makeTestTmpDir('authz-repro-')
        mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true })
        writeFileSync(path.join(dir, rel), src)
        const [route] = scanRoutes([{ label: 'repro', dir, exemptDir: dir }])
        expect(route?.rel).toBe(rel)
        const failing = route!.handlers.filter((handler) => judge(route!, handler, POLICY) !== undefined)
        expect(failing.map((handler) => handler.verb)).toEqual(fails)
        // The handlers that pass are checked too, so a case cannot pass by the scan finding no handler at all.
        expect(route!.handlers.length).toBeGreaterThan(0)
    })
})
