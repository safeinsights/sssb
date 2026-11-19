import { findOrg } from '@sssb/app-config/seed'
import { auth, db, isSimulated, jobs } from '../adapters/index'
import { readFlags } from '../adapters/fake/analytics'
import { devSignIn, findInvite, listAllPeople, readInvites } from '../adapters/fake/auth'
import { advanceClockMs, readClockOffsetMs, resetClock, worldNow } from '../adapters/fake/clock'
import { type CaughtEmail, clearCaughtEmails, listCaughtEmails } from '../adapters/fake/email'
import { JOBS_HELD_FLAG, listWorldJobs, runPendingJobs } from '../adapters/fake/jobs'
import {
    type PersonKey,
    readSimulatorState,
    readViewpointCookie,
    updatePersonState,
    writeViewpointCookie,
} from '../adapters/fake/simulator'
import type { WorldJobLike, ScheduleRowLike } from '../components/simulator/jobs-app'
import type { MailItem } from '../components/simulator/mail-app'
import type { Person } from '../components/simulator/people-app'
import { LOCALES } from '../core/locale'
import { listSchedulesForWorld, runDueSchedules } from '../db/schedules'
import { runDueDeliveries } from '../db/webhooks'
import { AuthRequiredError, ForbiddenError, NotFoundError } from '../ports/errors'
import { dispatchWebhook } from './webhook-dispatch'

/**
 * The Simulator panel's server side, as one handler an app mounts at `src/app/api/simulator/[...path]/route.ts`
 * (`@sssb/kit/components/simulator/simulator-host` is the client that calls it). It serves the tabs a new app uses
 * first: People (`summary`, `viewpoint`), Mail (`mail`, `mail/clear`, `mail/seen`) and Jobs with the world clock
 * (`jobs`, `jobs/run-pending`, `schedules`, `clock`, `schedules/run-due`). Any other path answers 404, so an app that
 * keeps route files of its own under `api/simulator/` still owns them: Next routes a static segment before a
 * catch-all.
 *
 * Simulated mode only. The app's route file opens each handler with `if (!isSimulated) return 404` and imports this
 * module only after it (the gate the authorization scan's `simulator/` exemption checks, `@sssb/kit/authz/route-policy`),
 * and this handler opens with the same check, so a real build neither evaluates the simulated world nor answers from
 * it. Inside a simulated world it is a mode gate, never a role gate: every path works signed out, so switching to a
 * low-privilege person can never strand the operator.
 *
 * Every POST must say `content-type: application/json`. These calls sign a browser in as anyone and empty the mail
 * catch-store, and a page on another origin can send a simple POST (text/plain, no preflight) to a developer's
 * localhost or to a hosted simulated demo; asking for JSON makes such a request preflight, and the preflight fails
 * because nothing here sends `Access-Control-Allow-Origin`. The host always sends JSON.
 */

/** Next's context for a `[...path]` route: the segments after `/api/simulator/`. */
export interface SimulatorRouteContext {
    params: Promise<{ path: string[] }>
}

/** GET `summary`: the People tab, and every inbox's unread count for the pill's badge. */
export interface SimulatorSummary {
    viewpoint: string | null
    signedIn: boolean
    people: Person[]
}

/** GET `mail`: one person's inbox (`?person=<key>`) or every caught email (`?all=1`). */
export interface SimulatorMail {
    emails: MailItem[]
    mailSeenAt: string | null
    /** Every inbox's total, so a person's empty inbox can hint at mail elsewhere. */
    allCount: number
}

/** GET `jobs`: every job in every tenant, and whether the `jobs-held` knob holds them queued. */
export interface SimulatorJobs {
    jobs: WorldJobLike[]
    held: boolean
}

/** GET `schedules`: every schedule in every tenant, and the world clock. */
export interface SimulatorSchedules {
    schedules: ScheduleRowLike[]
    clockOffsetMs: number
    worldNow: string
}

/** A clock move is capped at a year per call: a demo control, not a time machine. */
const MAX_ADVANCE_MS = 366 * 86_400_000
/** And the world at a century ahead in all, so repeated moves never leave the range a `Date` can hold. */
const MAX_OFFSET_MS = 100 * 366 * 86_400_000

/**
 * A path on this origin, or null: `lastPath` is recorded from a page-view beacon's body, so it is caller data, and
 * the client navigates to what `viewpoint` answers. A protocol-relative `//host` or `/\host` is another origin, and a
 * browser drops a tab or newline (`/\t/host` is `//host`), so no backslash, whitespace or control character anywhere.
 */
function sameOriginPath(value: unknown): string | null {
    return typeof value === 'string' && /^\/(?![/\\])[^\s\\\p{Cc}]*$/u.test(value) ? value : null
}

type Handler = (request: Request) => Promise<Response>

const ROUTES: Readonly<Record<string, Readonly<{ GET?: Handler; POST?: Handler }>>> = {
    summary: { GET: summary },
    viewpoint: { POST: viewpoint },
    mail: { GET: mail },
    'mail/clear': { POST: clearMail },
    'mail/seen': { POST: mailSeen },
    jobs: { GET: worldJobs },
    'jobs/run-pending': { POST: runPending },
    schedules: { GET: schedules },
    clock: { POST: clock },
    'schedules/run-due': { POST: runDue },
}

/** The one handler behind `src/app/api/simulator/[...path]/route.ts`: GET and POST both call it. */
export async function simulatorApi(request: Request, context: SimulatorRouteContext): Promise<Response> {
    if (!isSimulated) return new Response(null, { status: 404 })
    const { path } = await context.params
    const key = path.join('/')
    const route = Object.hasOwn(ROUTES, key) ? ROUTES[key] : undefined
    if (!route) return new Response(null, { status: 404 })
    const method = request.method === 'GET' || request.method === 'POST' ? request.method : undefined
    const handler = method ? route[method] : undefined
    if (!handler) {
        return new Response(null, { status: 405, headers: { allow: Object.keys(route).join(', ') } })
    }
    if (method === 'POST' && !isJson(request)) return Response.json({ error: 'json-only' }, { status: 415 })
    try {
        return await handler(request)
    } catch (error) {
        if (error instanceof AuthRequiredError) return Response.json({ error: 'unauthorized' }, { status: 401 })
        if (error instanceof ForbiddenError) return Response.json({ error: 'forbidden' }, { status: 403 })
        if (error instanceof NotFoundError) return Response.json({ error: 'not found' }, { status: 404 })
        throw error
    }
}

function isJson(request: Request): boolean {
    return request.headers.get('content-type')?.toLowerCase().startsWith('application/json') ?? false
}

/** The body as a plain object, or null when it is not one (absent, not JSON, an array, a scalar). */
async function jsonObject(request: Request): Promise<Record<string, unknown> | null> {
    const body: unknown = await request.json().catch(() => null)
    return typeof body === 'object' && body !== null && !Array.isArray(body) ? (body as Record<string, unknown>) : null
}

function badRequest(error: string): Response {
    return Response.json({ error }, { status: 400 })
}

async function summary(): Promise<Response> {
    const user = await auth.getCurrentUser()
    const viewpoint: PersonKey | null = user ? (`person:${user.id}` as PersonKey) : await readViewpointCookie()
    const state = readSimulatorState()
    const emails = listCaughtEmails()

    function unreadFor(key: PersonKey, email: string): number {
        const mailSeenAt = state.people[key]?.mailSeenAt
        return emails.filter((item) => item.to === email && (!mailSeenAt || item.at > mailSeenAt)).length
    }

    // Seeded people and those who accepted an invite are accounts; a pending invite is a People row too, with no
    // account yet, read live from the invite store.
    const accounts: Person[] = listAllPeople().map((person) => {
        const key: PersonKey = `person:${person.id}`
        return {
            key,
            name: person.name,
            email: person.email,
            role: person.memberships[0]?.role ?? '',
            orgs: person.memberships,
            tenantSlug: person.tenantSlug,
            status: 'active',
            hasAccount: true,
            unreadMail: unreadFor(key, person.email),
        }
    })
    const invited: Person[] = readInvites().map((invite) => {
        const key: PersonKey = `invited:${invite.id}`
        return {
            key,
            name: null,
            email: invite.email,
            role: invite.role,
            orgs: [{ orgSlug: invite.orgSlug, role: invite.role }],
            tenantSlug: findOrg(invite.orgSlug)?.tenantSlug ?? '',
            status: 'invited',
            hasAccount: false,
            unreadMail: unreadFor(key, invite.email),
        }
    })
    const body: SimulatorSummary = { viewpoint, signedIn: !!user, people: [...accounts, ...invited] }
    return Response.json(body)
}

/** POST `viewpoint` `{ person, locale }`: become that person, and answer where the page should land. */
async function viewpoint(request: Request): Promise<Response> {
    const body = await jsonObject(request)
    const person = body?.['person']
    const locale = body?.['locale']
    if (typeof locale !== 'string' || !(LOCALES as readonly string[]).includes(locale)) {
        return badRequest('unknown locale')
    }
    if (typeof person !== 'string') return badRequest('unsupported person key')

    if (person.startsWith('invited:')) {
        // An invited person has no account yet, so becoming them is a viewpoint change, not a sign-in: the page goes
        // signed out (the welcome page) while the panel follows their inbox.
        if (!findInvite(person.slice('invited:'.length))) return badRequest('unknown invite')
        await auth.signOut()
        await writeViewpointCookie(person as PersonKey)
        return Response.json({ redirectTo: `/${locale}` })
    }
    if (!person.startsWith('person:')) return badRequest('unsupported person key')

    const personId = person.slice('person:'.length)
    if (!listAllPeople().some((candidate) => candidate.id === personId)) return badRequest('unknown person')
    // devSignIn restores the person's remembered tenant and writes the viewpoint cookie.
    await devSignIn(personId)
    const lastPath = sameOriginPath(readSimulatorState().people[person as PersonKey]?.lastPath)
    return Response.json({ redirectTo: lastPath ?? `/${locale}/dashboard` })
}

function toMailItems(emails: CaughtEmail[]): MailItem[] {
    return emails.map(({ id, to, subject, at, html }) => ({ id, to, subject, at, html }))
}

/** The address behind a People key, of either kind. */
function personEmail(key: string): string | null {
    if (key.startsWith('person:')) {
        return listAllPeople().find((person) => person.id === key.slice('person:'.length))?.email ?? null
    }
    if (key.startsWith('invited:')) return findInvite(key.slice('invited:'.length))?.email ?? null
    return null
}

async function mail(request: Request): Promise<Response> {
    const params = new URL(request.url).searchParams
    const person = params.get('person')
    const caught = listCaughtEmails()
    let body: SimulatorMail
    if (params.get('all') === '1' || !person) {
        body = { emails: toMailItems(caught), mailSeenAt: null, allCount: caught.length }
    } else {
        const email = personEmail(person)
        body = {
            emails: email ? toMailItems(caught.filter((item) => item.to === email)) : [],
            mailSeenAt: email ? (readSimulatorState().people[person as PersonKey]?.mailSeenAt ?? null) : null,
            allCount: caught.length,
        }
    }
    return Response.json(body)
}

/** POST `mail/clear`: empties the mail catch-store, so a long session stays legible without a world reset. */
async function clearMail(): Promise<Response> {
    clearCaughtEmails()
    return new Response(null, { status: 204 })
}

/** POST `mail/seen` `{ person }`: marks that person's inbox read, which clears their unread badge. */
async function mailSeen(request: Request): Promise<Response> {
    const person = (await jsonObject(request))?.['person']
    if (typeof person !== 'string' || !(person.startsWith('person:') || person.startsWith('invited:'))) {
        return badRequest('unsupported person key')
    }
    // Only someone in the world: the key is written to the state file every poll reads.
    if (!personEmail(person)) return badRequest('unknown person')
    updatePersonState(person as PersonKey, { mailSeenAt: new Date().toISOString() })
    return Response.json({ ok: true })
}

async function worldJobs(): Promise<Response> {
    const body: SimulatorJobs = { jobs: await listWorldJobs(), held: readFlags()[JOBS_HELD_FLAG] === true }
    return Response.json(body)
}

/** POST `jobs/run-pending`: runs every queued job in every tenant, held or not, and says how many ran. */
async function runPending(): Promise<Response> {
    return Response.json({ ran: await runPendingJobs() })
}

async function schedules(): Promise<Response> {
    const body: SimulatorSchedules = {
        schedules: await listSchedulesForWorld(db),
        clockOffsetMs: readClockOffsetMs(),
        worldNow: worldNow().toISOString(),
    }
    return Response.json(body)
}

/**
 * Due schedules and due webhook deliveries, run at the world's "now": what moving the clock past a schedule's next
 * run, or past a retry's backoff, makes happen at once.
 */
async function runDueAtWorldNow() {
    const now = worldNow()
    const { spawned, failed } = await runDueSchedules(db, jobs, now)
    const deliveries = await runDueDeliveries(db, now, dispatchWebhook)
    return { spawned, failed, deliveries }
}

/** POST `clock` `{ action: 'advance', deltaMs }` or `{ action: 'reset' }`, then runs what is due. */
async function clock(request: Request): Promise<Response> {
    const body = await jsonObject(request)
    if (!body) return badRequest('invalid-payload')
    if (body['action'] === 'reset') {
        resetClock()
    } else if (body['action'] === 'advance') {
        const deltaMs = body['deltaMs']
        if (typeof deltaMs !== 'number' || !Number.isFinite(deltaMs) || deltaMs <= 0 || deltaMs > MAX_ADVANCE_MS) {
            return badRequest('invalid-delta')
        }
        if (readClockOffsetMs() + deltaMs > MAX_OFFSET_MS) return badRequest('invalid-delta')
        advanceClockMs(deltaMs)
    } else {
        return badRequest('invalid-action')
    }
    return Response.json({ ok: true, clockOffsetMs: readClockOffsetMs(), ...(await runDueAtWorldNow()) })
}

/** POST `schedules/run-due`: runs what is due without moving the clock. */
async function runDue(): Promise<Response> {
    return Response.json({ ok: true, ...(await runDueAtWorldNow()) })
}
