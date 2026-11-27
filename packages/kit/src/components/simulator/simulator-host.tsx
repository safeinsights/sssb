'use client'

import { presets } from '@sssb/app-config/presets'
import { useTranslations } from 'next-intl'
import type { ReactNode } from 'react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type {
    SimulatorAgreements,
    SimulatorAudit,
    SimulatorEvents,
    SimulatorFlags,
    SimulatorHooks,
    SimulatorInbound,
    SimulatorJobs,
    SimulatorMail,
    SimulatorMessages,
    SimulatorSchedules,
    SimulatorSnapshots,
    SimulatorSummary,
} from '../../server-lib/simulator-api'
import { resolveWorldStart } from '../../core/presets'
import { sameOriginPath } from '../../core/same-origin-path'
import { useTours } from '../../demo-static/tour/use-tours'
import type { ScrubResult } from './errors-app'
import type { InboundComposeInput } from './inbound-app'
import { SimulatorPanel, type SimulatorNotice } from './simulator-panel'

const EMPTY_SUMMARY: SimulatorSummary = { viewpoint: null, signedIn: false, people: [] }
const EMPTY_MAIL: SimulatorMail = { emails: [], mailSeenAt: null, allCount: 0 }
const EMPTY_JOBS: SimulatorJobs = { jobs: [], held: false }
const EMPTY_SCHEDULES: SimulatorSchedules = { schedules: [], clockOffsetMs: 0, worldNow: new Date(0).toISOString() }
const EMPTY_SNAPSHOTS: SimulatorSnapshots = { snapshots: [] }
const EMPTY_FLAGS: SimulatorFlags = { flags: [] }
const EMPTY_AGREEMENTS: SimulatorAgreements = { agreements: [] }
const EMPTY_INBOUND: SimulatorInbound = { inbound: [], orgs: [], people: [], handlers: [], domain: '' }
const EMPTY_MESSAGES: SimulatorMessages = { messages: [] }
const EMPTY_EVENTS: SimulatorEvents = { events: [] }
const EMPTY_AUDIT: SimulatorAudit = { audit: [] }
const EMPTY_HOOKS: SimulatorHooks = { endpoints: [], deliveries: [], failingEndpointIds: [] }
const EXPANDED_POLL_MS = 4_000
const COLLAPSED_POLL_MS = 15_000
const NOTICE_MS = 6_000
const MAIL_SCOPE_KEY = 'app-simulator-mail-scope'
/**
 * Left right before a reset, a restore or a preset load reloads the page, so the next mount can say what happened:
 * the panel's own notice, surviving exactly one navigation.
 */
const POST_NOTICE_KEY = 'app-simulator-post-notice'
const API = '/api/simulator'

/** A POST to the server host. Always JSON, even with no body: the server refuses any other content type. */
function post(path: string, body: unknown = {}): Promise<Response> {
    return fetch(`${API}/${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
    })
}

async function getJson<T>(path: string): Promise<T | null> {
    const response = await fetch(`${API}/${path}`)
    return response.ok ? ((await response.json()) as T) : null
}

/**
 * Polls overlap, and their answers can arrive out of order: each fetch takes a ticket, and its answer is applied only
 * when no later ticket's answer has been. A slow answer is never shown over a newer one, and, unlike "only the latest
 * request's answer", answers slower than the poll still land.
 */
function useTickets() {
    const counts = useRef({ issued: 0, applied: 0 })
    return useMemo(
        () => ({
            take: () => (counts.current.issued += 1),
            fresh: (ticket: number) => {
                if (ticket <= counts.current.applied) return false
                counts.current.applied = ticket
                return true
            },
        }),
        [],
    )
}

/** What a world-start handler answers once it has started a full reload: nothing runs after it on that document. */
function untilReload(): Promise<never> {
    return new Promise<never>(() => {})
}

type PostNotice = { kind: 'reset' } | { kind: 'restore' | 'preset'; name: string }

function writePostNotice(notice: PostNotice) {
    try {
        window.sessionStorage.setItem(POST_NOTICE_KEY, JSON.stringify(notice))
    } catch {
        // No storage: the reload happens all the same, unannounced.
    }
}

/** The marker a reload left, read once and removed. */
function takePostNotice(): PostNotice | null {
    try {
        const stored = window.sessionStorage.getItem(POST_NOTICE_KEY)
        if (!stored) return null
        window.sessionStorage.removeItem(POST_NOTICE_KEY)
        const parsed = JSON.parse(stored) as { kind?: unknown; name?: unknown }
        if (parsed.kind === 'reset') return { kind: 'reset' }
        if ((parsed.kind === 'restore' || parsed.kind === 'preset') && typeof parsed.name === 'string') {
            return { kind: parsed.kind, name: parsed.name }
        }
        return null
    } catch {
        return null
    }
}

function readStoredScope(): 'person' | 'all' | null {
    try {
        const stored = window.localStorage.getItem(MAIL_SCOPE_KEY)
        return stored === 'person' || stored === 'all' ? stored : null
    } catch {
        return null
    }
}

/**
 * The Simulator on an app's own `pnpm dev`: the panel, fed by the kit's server host
 * (`@sssb/kit/server-lib/simulator-api`, which the app mounts at `src/app/api/simulator/[...path]/route.ts`). The app's
 * locale layout renders it around the page, in simulated mode only and through a dynamic import, so no page of a real
 * build loads it.
 *
 * It wires the tabs that host serves: People (switch to anyone, signed in or not), Mail (each person's inbox, or all
 * of it, with the inbound mail the world sent the app and a form to send more), Messages (every SMS), Events (analytics
 * events, with the audit trail beneath), Jobs with the world clock (run what is queued, move the clock, run what is
 * due), Hooks (every webhook endpoint and delivery, an endpoint made to fail, due deliveries run), Errors (an error's
 * event before and after scrubbing), Snapshots (reset the world, save, restore and delete snapshots, flip a feature
 * flag, bump an agreement, load a demo preset) and, when the app registers any, Tours. A reset, a restore and a preset load each reload the page, since every page shows the world
 * they replaced; a tour that starts from one of them resumes itself after the reload. The panel leaves out every tab it
 * is not given; the rest, the app's own tabs included, are later stages of the same host. An app that needs one of
 * them today keeps a glue of its own instead of this component.
 *
 * Polling, never a stream: the summary (the pill's unread badge) on a slow beat while the panel is collapsed, and
 * the open tab's data on a faster one while it is expanded. Every acknowledgement is a notice inside the panel,
 * never the app's own toast.
 */
export function SimulatorHost({ locale, children }: { locale: string; children: ReactNode }) {
    const t = useTranslations('simulator')
    // A demo preset's title is a key into the app's catalog, from its root.
    const tRoot = useTranslations()
    const [summary, setSummary] = useState<SimulatorSummary>(EMPTY_SUMMARY)
    const [expanded, setExpanded] = useState(false)
    const [activeTab, setActiveTab] = useState('people')
    const [mailScope, setMailScope] = useState<'person' | 'all'>('person')
    const [mail, setMail] = useState<SimulatorMail>(EMPTY_MAIL)
    const [jobsData, setJobsData] = useState<SimulatorJobs>(EMPTY_JOBS)
    const [schedulesData, setSchedulesData] = useState<SimulatorSchedules>(EMPTY_SCHEDULES)
    const [snapshotsData, setSnapshotsData] = useState<SimulatorSnapshots>(EMPTY_SNAPSHOTS)
    const [flagsData, setFlagsData] = useState<SimulatorFlags>(EMPTY_FLAGS)
    const [agreementsData, setAgreementsData] = useState<SimulatorAgreements>(EMPTY_AGREEMENTS)
    const [snapshotsBusy, setSnapshotsBusy] = useState(false)
    const [busySnapshot, setBusySnapshot] = useState<string | null>(null)
    const [busyPreset, setBusyPreset] = useState<string | null>(null)
    const [busyAgreement, setBusyAgreement] = useState<string | null>(null)
    const [inboundData, setInboundData] = useState<SimulatorInbound>(EMPTY_INBOUND)
    const [messagesData, setMessagesData] = useState<SimulatorMessages>(EMPTY_MESSAGES)
    const [eventsData, setEventsData] = useState<SimulatorEvents>(EMPTY_EVENTS)
    const [auditData, setAuditData] = useState<SimulatorAudit>(EMPTY_AUDIT)
    const [hooksData, setHooksData] = useState<SimulatorHooks>(EMPTY_HOOKS)
    const [notices, setNotices] = useState<SimulatorNotice[]>([])
    const noticeSeq = useRef(0)
    const prevUnread = useRef<Map<string, number> | null>(null)
    const summaryTickets = useTickets()
    const mailTickets = useTickets()
    const jobsTickets = useTickets()
    const inboundTickets = useTickets()
    const messagesTickets = useTickets()
    const eventsTickets = useTickets()
    const auditTickets = useTickets()
    const hooksTickets = useTickets()
    // The app's tours (`@sssb/app-config/tours`, read by the engine itself). A tour's starting world resolves the same
    // way on every host (`resolveWorldStart`): a reset, a registered demo preset, or here a saved snapshot. Each reloads
    // the page, and the engine's resume marker carries the tour across it.
    const tours = useTours({
        onSnapshot: (snapshot) => {
            const start = resolveWorldStart(snapshot, presets)
            if (start.kind === 'reset') return handleReset()
            if (start.kind === 'preset') return handleLoadPreset(start.preset.id)
            return handleRestoreSnapshot(start.name)
        },
    })

    const personEmail = summary.people.find((person) => person.key === summary.viewpoint)?.email ?? null
    // Signed out, or no viewpoint yet: there is no one's own inbox to show, so the scope is every inbox.
    const effectiveMailScope: 'person' | 'all' = personEmail ? mailScope : 'all'
    const mailQuery = effectiveMailScope === 'all' ? 'all=1' : `person=${encodeURIComponent(summary.viewpoint ?? '')}`
    // The scope this render shows. An answer for another scope is dropped even when it is the newest to arrive: the
    // summary's first answer turns "all" into one person's inbox, and an action's callback can hold an older render's
    // fetch.
    const shownMailQuery = useRef(mailQuery)
    useEffect(() => {
        shownMailQuery.current = mailQuery
    }, [mailQuery])

    const pushNotice = useCallback((text: string) => {
        const id = (noticeSeq.current += 1)
        setNotices((prev) => [...prev, { id, text }])
        setTimeout(() => setNotices((prev) => prev.filter((notice) => notice.id !== id)), NOTICE_MS)
    }, [])

    const refresh = useCallback(async () => {
        const ticket = summaryTickets.take()
        const next = await getJson<SimulatorSummary>('summary')
        if (!next || !summaryTickets.fresh(ticket)) return
        setSummary(next)
        // New mail since the last poll gets a notice; the first load has nothing "new".
        if (prevUnread.current) {
            for (const person of next.people) {
                const before = prevUnread.current.get(person.key) ?? 0
                if (person.unreadMail > before) pushNotice(t('noticeNewMail', { email: person.email }))
            }
        }
        prevUnread.current = new Map(next.people.map((person) => [person.key, person.unreadMail]))
    }, [pushNotice, t, summaryTickets])

    const refreshMail = useCallback(async () => {
        const ticket = mailTickets.take()
        const next = await getJson<SimulatorMail>(`mail?${mailQuery}`)
        if (next && mailQuery === shownMailQuery.current && mailTickets.fresh(ticket)) setMail(next)
    }, [mailQuery, mailTickets])

    const refreshJobs = useCallback(async () => {
        const ticket = jobsTickets.take()
        const [nextJobs, nextSchedules] = await Promise.all([
            getJson<SimulatorJobs>('jobs'),
            getJson<SimulatorSchedules>('schedules'),
        ])
        if (!nextJobs || !nextSchedules || !jobsTickets.fresh(ticket)) return
        setJobsData(nextJobs)
        setSchedulesData(nextSchedules)
    }, [jobsTickets])

    // The Snapshots tab is fetched when it opens and after each of its own actions, never polled: its own actions
    // refetch or reload, and a change made elsewhere (an agreement edited on an app page) shows when it next opens.
    const refreshSnapshots = useCallback(async () => {
        const next = await getJson<SimulatorSnapshots>('snapshots')
        if (next) setSnapshotsData(next)
    }, [])

    const refreshFlags = useCallback(async () => {
        const next = await getJson<SimulatorFlags>('flags')
        if (next) setFlagsData(next)
    }, [])

    const refreshAgreements = useCallback(async () => {
        const next = await getJson<SimulatorAgreements>('agreements')
        if (next) setAgreementsData(next)
    }, [])

    const refreshInbound = useCallback(async () => {
        const ticket = inboundTickets.take()
        const next = await getJson<SimulatorInbound>('inbound')
        if (next && inboundTickets.fresh(ticket)) setInboundData(next)
    }, [inboundTickets])

    const refreshMessages = useCallback(async () => {
        const ticket = messagesTickets.take()
        const next = await getJson<SimulatorMessages>('messages')
        if (next && messagesTickets.fresh(ticket)) setMessagesData(next)
    }, [messagesTickets])

    // The audit trail renders on the Events tab, beneath the events, so the two are fetched together; each lands on its
    // own, so one that fails never holds the other back.
    const refreshEvents = useCallback(async () => {
        const eventsTicket = eventsTickets.take()
        const auditTicket = auditTickets.take()
        await Promise.all([
            getJson<SimulatorEvents>('events').then((next) => {
                if (next && eventsTickets.fresh(eventsTicket)) setEventsData(next)
            }),
            getJson<SimulatorAudit>('audit').then((next) => {
                if (next && auditTickets.fresh(auditTicket)) setAuditData(next)
            }),
        ])
    }, [eventsTickets, auditTickets])

    const refreshHooks = useCallback(async () => {
        const ticket = hooksTickets.take()
        const next = await getJson<SimulatorHooks>('webhooks')
        if (next && hooksTickets.fresh(ticket)) setHooksData(next)
    }, [hooksTickets])

    /** The open tab's own data, when the panel is expanded. */
    const refreshOpenTab = useCallback(() => {
        if (!expanded) return
        if (activeTab === 'mail') {
            void refreshMail()
            // Inbound mail is on the Mail tab, beside the outbound catch-store.
            void refreshInbound()
        }
        if (activeTab === 'messages') void refreshMessages()
        if (activeTab === 'events') void refreshEvents()
        if (activeTab === 'jobs') void refreshJobs()
        if (activeTab === 'hooks') void refreshHooks()
    }, [expanded, activeTab, refreshMail, refreshInbound, refreshMessages, refreshEvents, refreshJobs, refreshHooks])

    useEffect(() => {
        // Fetch on mount, and restore the remembered mail scope: syncing with external systems (the server, the
        // browser's storage), which is what setting state from an effect is for.
        // eslint-disable-next-line react-hooks/set-state-in-effect
        void refresh()
        const storedScope = readStoredScope()
        if (storedScope) setMailScope(storedScope)
        // What the reload before this mount did, if a reset, a restore or a preset load started it.
        const posted = takePostNotice()
        if (posted?.kind === 'reset') pushNotice(t('noticeWorldReset'))
        if (posted?.kind === 'restore') pushNotice(t('noticeSnapshotRestored', { name: posted.name }))
        const preset = posted?.kind === 'preset' ? presets.find((candidate) => candidate.id === posted.name) : undefined
        if (preset) pushNotice(t('noticePresetLoaded', { name: tRoot(preset.titleKey) }))
        // Mount-only.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [])

    useEffect(() => {
        const id = setInterval(
            () => {
                void refresh()
                refreshOpenTab()
            },
            expanded ? EXPANDED_POLL_MS : COLLAPSED_POLL_MS,
        )
        return () => clearInterval(id)
    }, [expanded, refresh, refreshOpenTab])

    useEffect(() => {
        // A tab that opens (or a mail scope that changes) fetches at once rather than on the next poll: the state is
        // set when the server answers, the same external-system sync as the mount effect.
        // eslint-disable-next-line react-hooks/set-state-in-effect
        refreshOpenTab()
    }, [refreshOpenTab])

    useEffect(() => {
        if (!expanded || activeTab !== 'snapshots') return
        // Fetched when the tab opens: the same external-system sync as the mount effect.
        // eslint-disable-next-line react-hooks/set-state-in-effect
        void refreshSnapshots()
        void refreshFlags()
        void refreshAgreements()
    }, [expanded, activeTab, refreshSnapshots, refreshFlags, refreshAgreements])

    function handleSelect(person: string) {
        void post('viewpoint', { person, locale }).then(async (response) => {
            if (!response.ok) return
            const { redirectTo } = (await response.json()) as { redirectTo: unknown }
            // A full reload: the theme and the header are per-user server output. Only ever to a path on this origin:
            // the server answers no other, and this is the client's own check.
            const path = sameOriginPath(redirectTo)
            if (path) window.location.assign(path)
        })
    }

    function handleMailSeen() {
        if (!summary.viewpoint) return
        void post('mail/seen', { person: summary.viewpoint }).then((response) => {
            if (response.ok) void refresh()
        })
    }

    function handleScopeChange(scope: 'person' | 'all') {
        setMailScope(scope)
        try {
            window.localStorage.setItem(MAIL_SCOPE_KEY, scope)
        } catch {
            // No storage (a private window, say): the scope lasts for this page only.
        }
    }

    function handleOpenLink(href: string) {
        // Same origin only, and never silently. A path is followed; so is an absolute URL on this origin, since a real
        // email carries one. Both go through `sameOriginPath`, which refuses what a browser would read as another
        // origin (`/\host`, a tab inside). A protocol-relative `//host` link is resolved against this page, so it is
        // judged by its host like any absolute URL; one with no origin at all (`mailto:`) is unusable here.
        const path = sameOriginPath(href)
        if (path) {
            window.location.assign(path)
            return
        }
        try {
            const url = href.startsWith('//') ? new URL(href, window.location.href) : new URL(href)
            const local =
                url.origin === window.location.origin ? sameOriginPath(url.pathname + url.search + url.hash) : null
            if (local) {
                window.location.assign(local)
                return
            }
            if (url.origin === window.location.origin || url.origin === 'null') {
                pushNotice(t('noticeLinkUnusable', { href }))
            } else {
                pushNotice(t('noticeLinkOrigin', { origin: url.origin }))
            }
        } catch {
            pushNotice(t('noticeLinkUnusable', { href }))
        }
    }

    function handleCopyLink(href: string) {
        void navigator.clipboard
            .writeText(href)
            .then(() => pushNotice(t('noticeLinkCopied')))
            .catch(() => pushNotice(t('noticeLinkCopyFailed')))
    }

    function handleClearMail() {
        void post('mail/clear').then((response) => {
            if (!response.ok) return
            void refreshMail()
            void refresh()
            pushNotice(t('noticeMailCleared'))
        })
    }

    function handleComposeInbound(input: InboundComposeInput) {
        void post('inbound/compose', input)
            .then(async (response) => {
                if (!response.ok) return
                const { outcome } = (await response.json()) as { outcome: { status: string } }
                // The new row, and any mail a handler sent in reply (a person's unread badge too).
                await Promise.all([refreshInbound(), refreshMail(), refresh()])
                pushNotice(
                    t('noticeInboundSent', {
                        status: t(`inboundStatus_${outcome.status}` as 'inboundStatus_handled'),
                    }),
                )
            })
            .catch(() => undefined)
    }

    async function handleToggleFail(endpointId: string, failing: boolean) {
        const response = await post('webhooks/fail', { endpointId, failing })
        if (!response.ok) return
        await refreshHooks()
        pushNotice(failing ? t('noticeHookFailOn') : t('noticeHookFailOff'))
    }

    async function handleRunDueDeliveries() {
        const response = await post('webhooks/run-due')
        if (!response.ok) return
        const { deliveries } = (await response.json()) as { deliveries: { delivered: number } }
        await refreshHooks()
        pushNotice(t('noticeHooksDelivered', { count: deliveries.delivered }))
    }

    async function handleServerErrorScenario(): Promise<ScrubResult> {
        const response = await fetch(`${API}/error-scenario`)
        if (!response.ok) throw new Error(`error-scenario answered ${response.status}`)
        return (await response.json()) as ScrubResult
    }

    async function handleRunPending() {
        const response = await post('jobs/run-pending')
        if (!response.ok) return
        const { ran } = (await response.json()) as { ran: number }
        await refreshJobs()
        pushNotice(t('noticeJobsRan', { count: ran }))
    }

    /** After the clock moved or due work ran: the schedules, the jobs a schedule spawned, and any mail they sent. */
    async function afterSchedulesChanged(response: Response, moved: 'advanced' | 'reset' | null) {
        if (!response.ok) return
        const { spawned } = (await response.json()) as { spawned: number }
        await Promise.all([refreshJobs(), refresh()])
        if (spawned > 0) pushNotice(t('noticeScheduleFired', { count: spawned }))
        else if (moved === 'advanced') pushNotice(t('noticeClockAdvanced'))
        else if (moved === 'reset') pushNotice(t('noticeClockReset'))
        else pushNotice(t('noticeNoDue'))
    }

    async function handleAdvanceClock(deltaMs: number) {
        await afterSchedulesChanged(await post('clock', { action: 'advance', deltaMs }), 'advanced')
    }

    async function handleResetClock() {
        await afterSchedulesChanged(await post('clock', { action: 'reset' }), 'reset')
    }

    async function handleRunDue() {
        await afterSchedulesChanged(await post('schedules/run-due'), null)
    }

    // The three world-start handlers (reset, restore, preset) answer a promise a tour's start can await: false when the
    // server refused, and on success one that never settles, because the page is reloading. Awaiting it keeps a tour
    // from showing its first step on a document about to be replaced.
    function handleReset(): Promise<boolean> {
        setSnapshotsBusy(true)
        const failed = () => {
            setSnapshotsBusy(false)
            return false
        }
        return post('reset').then((response) => {
            if (!response.ok) return failed()
            writePostNotice({ kind: 'reset' })
            window.location.assign(`/${locale}`)
            return untilReload()
        }, failed)
    }

    function handleRestoreSnapshot(name: string): Promise<boolean> {
        setBusySnapshot(name)
        const failed = () => {
            setBusySnapshot(null)
            return false
        }
        return post('snapshots/restore', { name }).then((response) => {
            if (!response.ok) return failed()
            writePostNotice({ kind: 'restore', name })
            window.location.assign(`/${locale}`)
            return untilReload()
        }, failed)
    }

    /**
     * The server resets the world, replays the preset and signs this browser in as its viewpoint, then answers where
     * to land: a full reload, as after a restore. A refused or failed load is said, never only un-busied: the server
     * may have reset the world before the step that failed, so this page no longer shows what the world holds. No
     * reload then, so a tour that asked for the preset can still record the miss.
     */
    function handleLoadPreset(id: string): Promise<boolean> {
        setBusyPreset(id)
        const failed = (): false => {
            setBusyPreset(null)
            const preset = presets.find((candidate) => candidate.id === id)
            pushNotice(t('noticePresetFailedStale', { name: preset ? tRoot(preset.titleKey) : id }))
            return false
        }
        return (
            post('presets', { name: id, locale })
                .then(async (response) => {
                    // Only ever to a path on this origin: the server answers no other, and this is the client's own check.
                    const path = response.ok
                        ? sameOriginPath(((await response.json()) as { redirectTo?: unknown }).redirectTo)
                        : null
                    if (!path) return failed()
                    writePostNotice({ kind: 'preset', name: id })
                    window.location.assign(path)
                    return untilReload()
                })
                // A rejected fetch, or an answer that is not JSON (a proxy's error page), is a failed load too.
                .catch(failed)
        )
    }

    function handleSaveSnapshot(name: string) {
        setSnapshotsBusy(true)
        void post('snapshots', { name })
            .then((response) => {
                if (!response.ok) return
                pushNotice(t('noticeSnapshotSaved', { name }))
                void refreshSnapshots()
            })
            // A rejected fetch (the dev server stopped) must not leave the controls disabled until a reload.
            .catch(() => undefined)
            .finally(() => setSnapshotsBusy(false))
    }

    function handleDeleteSnapshot(name: string) {
        setBusySnapshot(name)
        void post('snapshots/delete', { name })
            .then((response) => {
                if (!response.ok) return
                pushNotice(t('noticeSnapshotDeleted', { name }))
                void refreshSnapshots()
            })
            .catch(() => undefined)
            .finally(() => setBusySnapshot(null))
    }

    function handleToggleFlag(flag: string, enabled: boolean) {
        // A full reload: what a flag changes (the demo banner, say) is server output, read again only on a new request.
        void post('flags', { flag, enabled })
            .then((response) => {
                if (response.ok) window.location.reload()
            })
            // The dev server stopped: the switch stays where the server has it.
            .catch(() => undefined)
    }

    function handleBumpAgreement(id: string) {
        setBusyAgreement(id)
        void post('agreements/bump', { agreementId: id })
            .then(async (response) => {
                if (!response.ok) return
                const { version } = (await response.json()) as { version: number }
                pushNotice(t('noticeAgreementBumped', { version }))
                void refreshAgreements()
            })
            .catch(() => undefined)
            .finally(() => setBusyAgreement(null))
    }

    function handleLocaleChange(next: string) {
        if (next === locale) return
        // Swap the leading /<locale> segment and reload the same page: the theme and the header are per-request
        // server output, so a client navigation would not re-render them.
        const { pathname, search, hash } = window.location
        const swapped = pathname.replace(new RegExp(`^/${locale}(?=/|$)`), `/${next}`) + search + hash
        window.location.assign(sameOriginPath(swapped) ?? `/${next}`)
    }

    return (
        <div style={{ display: 'flex', minHeight: '100vh', alignItems: 'stretch' }}>
            <div style={{ flex: 1, minWidth: 0 }}>{children}</div>
            <SimulatorPanel
                people={summary.people}
                viewpoint={summary.viewpoint}
                signedIn={summary.signedIn}
                onSelect={handleSelect}
                onRefresh={refresh}
                onExpandedChange={(value) => {
                    setExpanded(value)
                    if (value) void refresh()
                }}
                onTabChange={setActiveTab}
                onLocaleChange={handleLocaleChange}
                notices={notices}
                mail={{
                    emails: mail.emails,
                    scope: effectiveMailScope,
                    onScopeChange: handleScopeChange,
                    personEmail,
                    mailSeenAt: mail.mailSeenAt,
                    allCount: mail.allCount,
                    onOpenLink: handleOpenLink,
                    onSeen: handleMailSeen,
                    onClear: handleClearMail,
                    onCopyLink: handleCopyLink,
                }}
                // Inbound mail is an app that registers handlers (`@sssb/app-config/inbound-email`): with none, there is
                // nothing for mail to reach, and the Mail tab shows no compose form.
                inbound={
                    inboundData.handlers.length > 0
                        ? {
                              inbound: inboundData.inbound,
                              orgs: inboundData.orgs,
                              people: inboundData.people,
                              handlers: inboundData.handlers,
                              domain: inboundData.domain,
                              onCompose: handleComposeInbound,
                          }
                        : undefined
                }
                messages={messagesData.messages}
                events={eventsData.events}
                audit={auditData.audit}
                hooks={{
                    endpoints: hooksData.endpoints,
                    deliveries: hooksData.deliveries,
                    failingEndpointIds: hooksData.failingEndpointIds,
                    onToggleFail: handleToggleFail,
                    onRunDue: handleRunDueDeliveries,
                }}
                runServerErrorScenario={handleServerErrorScenario}
                jobs={{
                    jobs: jobsData.jobs,
                    held: jobsData.held,
                    onRunPending: handleRunPending,
                    schedules: schedulesData.schedules,
                    clock: {
                        offsetMs: schedulesData.clockOffsetMs,
                        worldNow: schedulesData.worldNow,
                        onAdvance: handleAdvanceClock,
                        onReset: handleResetClock,
                        onRunDue: handleRunDue,
                    },
                }}
                snapshots={{
                    snapshots: snapshotsData.snapshots,
                    onReset: () => void handleReset(),
                    onSave: handleSaveSnapshot,
                    onRestore: (name) => void handleRestoreSnapshot(name),
                    onDelete: handleDeleteSnapshot,
                    busy: snapshotsBusy,
                    busySnapshot,
                    flags: flagsData.flags,
                    onToggleFlag: handleToggleFlag,
                    agreements: agreementsData.agreements,
                    onBumpAgreement: handleBumpAgreement,
                    busyAgreement,
                    onLoadPreset: (id) => void handleLoadPreset(id),
                    busyPreset,
                }}
                tours={tours.tab}
            />
            {tours.overlay}
        </div>
    )
}
