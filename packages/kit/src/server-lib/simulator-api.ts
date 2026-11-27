import { findOrg } from '@sssb/app-config/seed'
import { publicOrigin } from '../adapters/edge-headers'
import { auth, db, isSimulated, jobs } from '../adapters/index'
import { bumpWorldAgreement, listWorldAgreements } from '../adapters/fake/agreements'
import { KNOWN_FLAGS, listCapturedEvents, readFlags, setFlag } from '../adapters/fake/analytics'
import { listWorldAuditEvents } from '../adapters/fake/audit'
import { devSignIn, findInvite, listAllPeople, readInvites } from '../adapters/fake/auth'
import { advanceClockMs, readClockOffsetMs, resetClock, worldNow } from '../adapters/fake/clock'
import { type CaughtEmail, clearCaughtEmails, listCaughtEmails } from '../adapters/fake/email'
import { JOBS_HELD_FLAG, listWorldJobs, runPendingJobs } from '../adapters/fake/jobs'
import { listCaughtSms } from '../adapters/fake/sms'
import {
    type PersonKey,
    readSimulatorState,
    readViewpointCookie,
    updatePersonState,
    writeViewpointCookie,
} from '../adapters/fake/simulator'
import {
    deleteSnapshot,
    listSnapshots,
    resetWorld,
    restoreSnapshot,
    saveSnapshot,
} from '../adapters/fake/simulator-admin'
import { listCaughtWebhooks, readFailingEndpoints, setEndpointFailing } from '../adapters/fake/webhooks'
import type { ScrubResult } from '../components/simulator/errors-app'
import type { AnalyticsEvent, AuditEntry } from '../components/simulator/events-app'
import type { HookDeliveryRow, HookEndpointRow } from '../components/simulator/hooks-app'
import type { InboundEmailRow } from '../components/simulator/inbound-app'
import type { WorldJobLike, ScheduleRowLike } from '../components/simulator/jobs-app'
import type { MailItem } from '../components/simulator/mail-app'
import type { SmsMessageRow } from '../components/simulator/messages-app'
import type { Person } from '../components/simulator/people-app'
import type { FeatureFlag, Snapshot, SnapshotAgreement } from '../components/simulator/snapshots-app'
import { DEMO_INBOUND_DOMAIN, formatInboundRecipient } from '../core/inbound-email'
import { LOCALES } from '../core/locale'
import { WORLD_START_NAME_PATTERN } from '../core/presets'
import { sameOriginPath } from '../core/same-origin-path'
import { WEBHOOK_SIGNATURE_HEADER } from '../core/webhook-signing'
import { listInboundForWorld } from '../db/inbound-email'
import { listOrgsForWorld } from '../db/org-lookup'
import { listSchedulesForWorld, runDueSchedules } from '../db/schedules'
import { listDeliveriesForWorld, listEndpointsForWorld, runDueDeliveries } from '../db/webhooks'
import { inboundHandlers } from '../inbound-email/handlers'
import { intakeInboundEmail } from '../inbound-email/intake'
import { scrubEvent } from '../observability/scrub'
import { AuthRequiredError, ForbiddenError, NotFoundError } from '../ports/errors'
import { applyDemoPreset } from './demo-presets'
import { dispatchWebhook } from './webhook-dispatch'

/**
 * The Simulator panel's server side, as one handler an app mounts at `src/app/api/simulator/[...path]/route.ts`
 * (`@sssb/kit/components/simulator/simulator-host` is the client that calls it). It serves the tabs a new app uses
 * first: People (`summary`, `viewpoint`), Mail (`mail`, `mail/clear`, `mail/seen`) and Jobs with the world clock
 * (`jobs`, `jobs/run-pending`, `schedules`, `clock`, `schedules/run-due`); and Snapshots, the world's knobs: a reset
 * (`reset`), named snapshots (`snapshots`, `snapshots/restore`, `snapshots/delete`), the feature flags (`flags`), the
 * access-gate agreements (`agreements`, `agreements/bump`) and the app's demo presets (`presets`), which with a reset
 * and a restore are also how a tour starts its world; and the subsystems' tabs, which watch what the world did:
 * Events (`events`, with `audit` beneath it), Messages (`messages`), inbound mail beside the Mail tab (`inbound`,
 * `inbound/compose`), Hooks (`webhooks`, `webhooks/fail`, `webhooks/run-due`) and Errors (`error-scenario`). Any other
 * path answers 404, so an app that
 * keeps route files of its own under `api/simulator/` still owns them: Next routes a static segment before a
 * catch-all.
 *
 * Simulated mode only. The app's route file should open each handler with `if (!isSimulated) return 404` (the gate the
 * authorization scan's `simulator/` exemption checks, `@sssb/kit/authz/route-policy`, so an app's route without it
 * fails the scan) and import this module only after it, as SSSB's starter does; and this handler opens with the same
 * check, so in a real build it answers 404 however it is reached. Inside a simulated world it is a mode gate, never a
 * role gate: every path works signed out, so switching to a low-privilege person can never strand the operator.
 *
 * Every POST must say `content-type: application/json`. These calls sign a browser in as anyone (as the app's own
 * dev sign-in route does) and empty the mail catch-store, and a page on another origin can send a simple POST
 * (text/plain, no preflight) to a developer's localhost or to a hosted simulated demo; asking for JSON makes such a
 * request preflight, and the preflight fails because nothing here sends `Access-Control-Allow-Origin`. The host always
 * sends JSON.
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

/** GET `snapshots`: every saved snapshot, newest first. */
export interface SimulatorSnapshots {
    snapshots: Snapshot[]
}

/** GET `flags`: every known feature flag, the framework's and the app's, and whether it is on. */
export interface SimulatorFlags {
    flags: FeatureFlag[]
}

/** GET `agreements`: every agreement in every tenant, with how many acceptances are at its current version. */
export interface SimulatorAgreements {
    agreements: SnapshotAgreement[]
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** The most `inbound/compose` takes, in characters: an address's limit, a long subject line, a long email's text. */
const COMPOSE_LIMITS = { address: 320, subject: 1_000, body: 100_000 }

/** GET `events`: every analytics event the world captured. The flags are on `flags`: the Snapshots tab owns them. */
export interface SimulatorEvents {
    events: AnalyticsEvent[]
}

/** GET `audit`: every tenant's audit trail, newest first, shown beneath the events. */
export interface SimulatorAudit {
    audit: AuditEntry[]
}

/** GET `messages`: every SMS the world caught. */
export interface SimulatorMessages {
    messages: SmsMessageRow[]
}

/** GET `inbound`: every inbound email, and what the compose form offers: orgs, people, the handlers and the domain. */
export interface SimulatorInbound {
    inbound: InboundEmailRow[]
    orgs: { slug: string; name: string; tenantSlug: string }[]
    people: { email: string; name: string }[]
    handlers: string[]
    domain: string
}

/** GET `webhooks`: every endpoint and delivery in the world, each delivery with what was signed and sent. */
export interface SimulatorHooks {
    endpoints: HookEndpointRow[]
    deliveries: HookDeliveryRow[]
    failingEndpointIds: string[]
}

/** A clock move is capped at a year per call: a demo control, not a time machine. */
const MAX_ADVANCE_MS = 366 * 86_400_000
/** And the world at a century ahead in all, so repeated moves never leave the range a `Date` can hold. */
const MAX_OFFSET_MS = 100 * 366 * 86_400_000

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
    reset: { POST: reset },
    snapshots: { GET: snapshots, POST: snapshotSave },
    'snapshots/restore': { POST: snapshotRestore },
    'snapshots/delete': { POST: snapshotDelete },
    flags: { GET: flags, POST: flagSet },
    agreements: { GET: agreements },
    'agreements/bump': { POST: agreementBump },
    presets: { POST: presetLoad },
    events: { GET: events },
    audit: { GET: audit },
    messages: { GET: messages },
    inbound: { GET: inbound },
    'inbound/compose': { POST: inboundCompose },
    webhooks: { GET: webhooks },
    'webhooks/fail': { POST: webhookFail },
    'webhooks/run-due': { POST: webhookRunDue },
    'error-scenario': { GET: errorScenario },
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
    // `lastPath` is recorded from a page-view beacon's body, so it is caller data, and the client navigates to it.
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

/** POST `reset`: wipes the world back to the seed. The host reloads the page after it: every page shows the old world. */
async function reset(): Promise<Response> {
    await resetWorld()
    return new Response(null, { status: 204 })
}

async function snapshots(): Promise<Response> {
    const body: SimulatorSnapshots = { snapshots: listSnapshots() }
    return Response.json(body)
}

/** The `name` of a snapshot call's body, or null when it has none. Its shape is the snapshot store's to judge. */
async function snapshotName(request: Request): Promise<string | null> {
    const name = (await jsonObject(request))?.['name']
    return typeof name === 'string' ? name : null
}

/**
 * POST `snapshots` `{ name }`: saves (or overwrites) a named snapshot of the world. A name the store refuses, one
 * outside the world-start pattern or one a reset or a registered preset already means, answers 403.
 */
async function snapshotSave(request: Request): Promise<Response> {
    const name = await snapshotName(request)
    if (name === null) return badRequest('name is required')
    await saveSnapshot(name)
    return new Response(null, { status: 204 })
}

/** POST `snapshots/restore` `{ name }`: puts the saved world back; 404 when there is no snapshot of that name. */
async function snapshotRestore(request: Request): Promise<Response> {
    const name = await snapshotName(request)
    if (name === null) return badRequest('name is required')
    await restoreSnapshot(name)
    return new Response(null, { status: 204 })
}

/** POST `snapshots/delete` `{ name }`: 404 when there is no snapshot of that name. */
async function snapshotDelete(request: Request): Promise<Response> {
    const name = await snapshotName(request)
    if (name === null) return badRequest('name is required')
    await deleteSnapshot(name)
    return new Response(null, { status: 204 })
}

async function flags(): Promise<Response> {
    const stored = readFlags()
    const body: SimulatorFlags = { flags: KNOWN_FLAGS.map((flag) => ({ flag, enabled: stored[flag] ?? false })) }
    return Response.json(body)
}

/** POST `flags` `{ flag, enabled }`: turns one known flag on or off. The host reloads after it: the flags reach pages. */
async function flagSet(request: Request): Promise<Response> {
    const body = await jsonObject(request)
    const flag = body?.['flag']
    const enabled = body?.['enabled']
    if (typeof flag !== 'string' || !KNOWN_FLAGS.includes(flag) || typeof enabled !== 'boolean') {
        return badRequest('invalid flag')
    }
    setFlag(flag, enabled)
    return Response.json({ ok: true })
}

async function agreements(): Promise<Response> {
    const body: SimulatorAgreements = { agreements: await listWorldAgreements() }
    return Response.json(body)
}

/**
 * POST `agreements/bump` `{ agreementId }`: a new version of one agreement, through the same tenant-scoped write a
 * real admin's would take, so everyone whose acceptance is now stale meets the gate on their next page.
 */
async function agreementBump(request: Request): Promise<Response> {
    const agreementId = (await jsonObject(request))?.['agreementId']
    // An agreement's id is a uuid: anything else could only fail the database's cast.
    if (typeof agreementId !== 'string' || !UUID_PATTERN.test(agreementId)) return badRequest('invalid-agreement')
    const result = await bumpWorldAgreement(agreementId)
    if (!result) return Response.json({ error: 'unknown agreement' }, { status: 404 })
    return Response.json({ version: result.version })
}

/**
 * POST `presets` `{ name, locale }`: resets the world, replays the app's demo preset of that id and signs this browser
 * in as its viewpoint (`@sssb/kit/server-lib/demo-presets`), then answers where the page should land: the dashboard
 * when the preset signs someone in, the welcome page when it does not. 404 for an id the app does not register.
 */
async function presetLoad(request: Request): Promise<Response> {
    const body = await jsonObject(request)
    const name = body?.['name']
    const locale = body?.['locale']
    // The shape a saved snapshot's name takes, checked before the registry is asked.
    if (typeof name !== 'string' || !WORLD_START_NAME_PATTERN.test(name)) return badRequest('invalid name')
    if (typeof locale !== 'string' || !(LOCALES as readonly string[]).includes(locale)) {
        return badRequest('unknown locale')
    }
    const { signedIn } = await applyDemoPreset(name, { baseUrl: publicOrigin(request) })
    return Response.json({ redirectTo: signedIn ? `/${locale}/dashboard` : `/${locale}` })
}

async function events(): Promise<Response> {
    const body: SimulatorEvents = { events: listCapturedEvents() }
    return Response.json(body)
}

async function audit(): Promise<Response> {
    const body: SimulatorAudit = { audit: await listWorldAuditEvents() }
    return Response.json(body)
}

async function messages(): Promise<Response> {
    const body: SimulatorMessages = { messages: listCaughtSms() }
    return Response.json(body)
}

async function inbound(): Promise<Response> {
    const body: SimulatorInbound = {
        inbound: await listInboundForWorld(db),
        orgs: await listOrgsForWorld(db),
        people: listAllPeople().map((person) => ({ email: person.email, name: person.name })),
        handlers: Object.keys(inboundHandlers),
        domain: DEMO_INBOUND_DOMAIN,
    }
    return Response.json(body)
}

/** The trimmed string at `key`, or '' when there is none. */
function trimmed(body: Record<string, unknown> | null, key: string): string {
    const value = body?.[key]
    return typeof value === 'string' ? value.trim() : ''
}

/**
 * POST `inbound/compose` `{ from, orgSlug, handler, subject, body }`: the world emails the app. It is addressed to the
 * org's handler on the demo domain and taken in by `intakeInboundEmail`, the same intake the real inbound webhook calls,
 * so it reaches the app's registered handlers through their registry and no other way. The outcome says what intake did
 * with it (`handled`, `unmatched` or `failed`); a reply the handler sends lands in the Mail tab.
 */
async function inboundCompose(request: Request): Promise<Response> {
    const body = await jsonObject(request)
    const from = trimmed(body, 'from')
    const orgSlug = trimmed(body, 'orgSlug')
    const handler = trimmed(body, 'handler')
    if (!from || !orgSlug || !handler) return badRequest('invalid-payload')
    const subject = body?.['subject']
    const text = body?.['body']
    // A demo's message, not a mailbox's: bounded, since each one is a row, a handler run and often a reply.
    const oversized =
        from.length > COMPOSE_LIMITS.address ||
        orgSlug.length + handler.length > COMPOSE_LIMITS.address ||
        (typeof subject === 'string' && subject.length > COMPOSE_LIMITS.subject) ||
        (typeof text === 'string' && text.length > COMPOSE_LIMITS.body)
    if (oversized) return badRequest('too-large')
    const outcome = await intakeInboundEmail(db, auth, {
        to: formatInboundRecipient(orgSlug, handler, DEMO_INBOUND_DOMAIN),
        from,
        subject: typeof subject === 'string' ? subject : '',
        bodyText: typeof text === 'string' ? text : '',
    })
    return Response.json({ ok: true, outcome })
}

async function webhooks(): Promise<Response> {
    const caught = new Map(listCaughtWebhooks().map((webhook) => [webhook.deliveryId, webhook]))
    const deliveries = (await listDeliveriesForWorld(db)).map((delivery) => {
        const sent = caught.get(delivery.id)
        return { ...delivery, signature: sent?.headers[WEBHOOK_SIGNATURE_HEADER] ?? null, body: sent?.body ?? null }
    })
    const body: SimulatorHooks = {
        endpoints: await listEndpointsForWorld(db),
        deliveries,
        failingEndpointIds: [...readFailingEndpoints()],
    }
    return Response.json(body)
}

/** POST `webhooks/fail` `{ endpointId, failing }`: makes one endpoint answer every delivery with a failure, or stop. */
async function webhookFail(request: Request): Promise<Response> {
    const body = await jsonObject(request)
    const endpointId = body?.['endpointId']
    const failing = body?.['failing']
    // An endpoint's id is a uuid: the fake store keeps whatever it is given, and every Hooks poll reads it back.
    if (typeof endpointId !== 'string' || !UUID_PATTERN.test(endpointId) || typeof failing !== 'boolean') {
        return badRequest('invalid-request')
    }
    setEndpointFailing(endpointId, failing)
    return Response.json({ ok: true, failing })
}

/** POST `webhooks/run-due`: delivers what is due at the world's "now", retries included, without moving the clock. */
async function webhookRunDue(): Promise<Response> {
    return Response.json({ ok: true, deliveries: await runDueDeliveries(db, worldNow(), dispatchWebhook) })
}

/**
 * GET `error-scenario`: a server error's event before and after `scrubEvent`, the scrubbing the error reporter applies,
 * so the Errors tab can show what never leaves the server without a reporter configured. The values are placeholders
 * shaped like what a request carries.
 */
async function errorScenario(): Promise<Response> {
    const event = {
        message: 'Test error (server) from Simulator',
        request: {
            headers: {
                cookie: 'session=SECRET_COOKIE_VALUE',
                authorization: 'Bearer SECRET_TOKEN',
                'x-api-key': 'SECRET_API_KEY',
                'user-agent': 'DevErrorsDemo/1.0',
            },
            cookies: { session: 'SECRET_COOKIE_VALUE' },
            query_string: 'token=SECRET_QUERY',
        },
        user: { id: 'user_123', email: 'user@example.com', ip_address: '203.0.113.7' },
    }
    const body: ScrubResult = { raw: structuredClone(event), scrubbed: scrubEvent(structuredClone(event)) }
    return Response.json(body)
}
