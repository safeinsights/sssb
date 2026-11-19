'use client'

import { useTranslations } from 'next-intl'
import type { ReactNode } from 'react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { SimulatorJobs, SimulatorMail, SimulatorSchedules, SimulatorSummary } from '../../server-lib/simulator-api'
import { sameOriginPath } from '../../core/same-origin-path'
import { SimulatorPanel, type SimulatorNotice } from './simulator-panel'

const EMPTY_SUMMARY: SimulatorSummary = { viewpoint: null, signedIn: false, people: [] }
const EMPTY_MAIL: SimulatorMail = { emails: [], mailSeenAt: null, allCount: 0 }
const EMPTY_JOBS: SimulatorJobs = { jobs: [], held: false }
const EMPTY_SCHEDULES: SimulatorSchedules = { schedules: [], clockOffsetMs: 0, worldNow: new Date(0).toISOString() }
const EXPANDED_POLL_MS = 4_000
const COLLAPSED_POLL_MS = 15_000
const NOTICE_MS = 6_000
const MAIL_SCOPE_KEY = 'app-simulator-mail-scope'
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
 * locale layout renders it around the page, in simulated mode only and through a dynamic import, so a real build
 * ships none of it.
 *
 * It wires the tabs that host serves: People (switch to anyone, signed in or not), Mail (each person's inbox, or all
 * of it) and Jobs with the world clock (run what is queued, move the clock, run what is due). The panel leaves out
 * every tab it is not given; the rest, the app's own tabs, presets and tours included, are later stages of the same
 * host. An app that needs one of them today keeps a glue of its own instead of this component.
 *
 * Polling, never a stream: the summary (the pill's unread badge) on a slow beat while the panel is collapsed, and
 * the open tab's data on a faster one while it is expanded. Every acknowledgement is a notice inside the panel,
 * never the app's own toast.
 */
export function SimulatorHost({ locale, children }: { locale: string; children: ReactNode }) {
    const t = useTranslations('simulator')
    const [summary, setSummary] = useState<SimulatorSummary>(EMPTY_SUMMARY)
    const [expanded, setExpanded] = useState(false)
    const [activeTab, setActiveTab] = useState('people')
    const [mailScope, setMailScope] = useState<'person' | 'all'>('person')
    const [mail, setMail] = useState<SimulatorMail>(EMPTY_MAIL)
    const [jobsData, setJobsData] = useState<SimulatorJobs>(EMPTY_JOBS)
    const [schedulesData, setSchedulesData] = useState<SimulatorSchedules>(EMPTY_SCHEDULES)
    const [notices, setNotices] = useState<SimulatorNotice[]>([])
    const noticeSeq = useRef(0)
    const prevUnread = useRef<Map<string, number> | null>(null)
    const summaryTickets = useTickets()
    const mailTickets = useTickets()
    const jobsTickets = useTickets()

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

    /** The open tab's own data, when the panel is expanded. */
    const refreshOpenTab = useCallback(() => {
        if (!expanded) return
        if (activeTab === 'mail') void refreshMail()
        if (activeTab === 'jobs') void refreshJobs()
    }, [expanded, activeTab, refreshMail, refreshJobs])

    useEffect(() => {
        // Fetch on mount, and restore the remembered mail scope: syncing with external systems (the server, the
        // browser's storage), which is what setting state from an effect is for.
        // eslint-disable-next-line react-hooks/set-state-in-effect
        void refresh()
        const storedScope = readStoredScope()
        if (storedScope) setMailScope(storedScope)
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
            />
        </div>
    )
}
