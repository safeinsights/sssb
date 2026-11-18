'use client'

import { Box, Group, NumberInput, Stack, Text, UnstyledButton } from '@mantine/core'
import { useLocale, useTranslations } from 'next-intl'
import { useState } from 'react'
import type { ScheduleSpec } from '../../core/schedules'
import { JobTimeline, type JobTimelineItem } from '../job-timeline'
import { chipStyle } from './people-app'
import { formatWhen } from './format-when'

/** Local prop shape (never import the adapter's WorldJob into components) — the world view of a job,
 *  joined to its tenant/org slugs, as the Jobs tab needs to render it. */
export interface WorldJobLike {
    id: string
    kind: string
    status: string
    tenantSlug: string
    orgSlug: string | null
    createdAt: string
    error?: string | null
    timeline: JobTimelineItem[]
}

/** A schedule as the Jobs tab renders it (local shape, decoupled from packages/kit/src/db's WorldSchedule). */
export interface ScheduleRowLike {
    id: string
    kind: string
    spec: ScheduleSpec
    nextRunAt: string
    enabled: boolean
    tenantSlug: string
    orgSlug: string
}

/** The simulated world-clock control surface, wired by the host (real glue / static twin). */
export interface WorldClockLike {
    /** Current offset ahead of real time, in ms (0 = real time). */
    offsetMs: number
    /** The world's current instant (real time + offset), ISO. */
    worldNow: string
    /** Advance the clock forward by the given ms, then drain due schedules. */
    onAdvance: (deltaMs: number) => void | Promise<void>
    /** Back to real time. */
    onReset: () => void | Promise<void>
    /** Drain due schedules at the current world clock without moving it. */
    onRunDue: () => void | Promise<void>
}

/**
 * The dev ticker, wired by the real glue only, and only when the dev server answers for it (a simulated `next dev`;
 * never a production build, the demo, e2e or the static twin, which has no server). `running`..`lastError` are the
 * ticker's own status (scripts/ticker.mjs); `elsewhere` is a ticker this panel did not start, live on the same world.
 */
export interface DevTickerLike {
    running: boolean
    /** The interval while running (and the last one used, after a stop). */
    seconds: number | null
    ticks: number
    lastTickAt: string | null
    lastError: string | null
    elsewhere: { pid: number; seconds: number } | null
    minSeconds: number
    maxSeconds: number
    defaultSeconds: number
    onStart: (seconds: number) => void | Promise<void>
    onStop: () => void | Promise<void>
}

const MS_PER_HOUR = 3_600_000
const MS_PER_DAY = 86_400_000
const MS_PER_WEEK = 7 * MS_PER_DAY

const runButtonStyle = {
    fontSize: 12,
    fontWeight: 600,
    color: '#f8f9fa',
    border: '1px solid #373a40',
    borderRadius: 6,
    padding: '4px 10px',
} as const

const sectionStyle = {
    border: '1px solid rgba(255,255,255,0.18)',
    borderRadius: 8,
    padding: 10,
} as const

/** Mantine text colour cue per status — presentational only, the chip label stays the raw enum. */
function statusColor(status: string): string {
    switch (status) {
        case 'completed':
            return 'teal.4'
        case 'running':
            return 'blue.4'
        case 'failed':
            return 'red.4'
        default:
            return 'gray.4'
    }
}

/** Localized one-line summary of a schedule's timing rule. UTC throughout (see packages/kit/src/core/schedules). */
function ScheduleSpecSummary({ spec }: { spec: ScheduleSpec }) {
    const t = useTranslations('simulator')
    if (spec.type === 'interval') return <>{t('scheduleInterval', { minutes: spec.everyMinutes })}</>
    const time = `${String(spec.atUtcHour).padStart(2, '0')}:${String(spec.atUtcMinute).padStart(2, '0')}`
    if (spec.type === 'daily') return <>{t('scheduleDaily', { time })}</>
    // Weekday names are seven literal keys so the lookup typechecks without a dynamic key.
    const weekday =
        [t('weekday0'), t('weekday1'), t('weekday2'), t('weekday3'), t('weekday4'), t('weekday5'), t('weekday6')][
            spec.utcDay
        ] ?? ''
    return <>{t('scheduleWeekly', { weekday, time })}</>
}

/**
 * The world-clock control block: shows how far ahead of real time the demo has advanced, and offers
 * "advance +1h / +1d / +1w" (each also drains due schedules), "run due now" (drain without moving),
 * and "reset clock". All buttons share one busy latch so a click can't race the refetch.
 */
function WorldClock({ clock }: { clock: WorldClockLike }) {
    const t = useTranslations('simulator')
    const locale = useLocale()
    const [busy, setBusy] = useState(false)

    const run = (action: () => void | Promise<void>) => {
        setBusy(true)
        void Promise.resolve(action()).finally(() => setBusy(false))
    }

    const hoursAhead = Math.round(clock.offsetMs / MS_PER_HOUR)

    return (
        <Box style={sectionStyle} data-testid="simulator-clock">
            <Text size="xs" fw={700} c="gray.0" mb={6}>
                {t('clockTitle')}
            </Text>
            <Text size="xs" c="gray.4" data-testid="simulator-clock-now">
                {formatWhen(clock.worldNow, locale)}
            </Text>
            <Text size="xs" c={clock.offsetMs > 0 ? 'yellow.4' : 'gray.5'} mb={8} data-testid="simulator-clock-offset">
                {clock.offsetMs > 0 ? t('clockAhead', { hours: hoursAhead }) : t('clockRealTime')}
            </Text>
            <Group gap={6} wrap="wrap">
                <UnstyledButton
                    data-testid="simulator-clock-advance-hour"
                    disabled={busy}
                    onClick={() => run(() => clock.onAdvance(MS_PER_HOUR))}
                    style={{ ...runButtonStyle, opacity: busy ? 0.6 : 1 }}
                >
                    {t('clockAdvanceHour')}
                </UnstyledButton>
                <UnstyledButton
                    data-testid="simulator-clock-advance-day"
                    disabled={busy}
                    onClick={() => run(() => clock.onAdvance(MS_PER_DAY))}
                    style={{ ...runButtonStyle, opacity: busy ? 0.6 : 1 }}
                >
                    {t('clockAdvanceDay')}
                </UnstyledButton>
                <UnstyledButton
                    data-testid="simulator-clock-advance-week"
                    disabled={busy}
                    onClick={() => run(() => clock.onAdvance(MS_PER_WEEK))}
                    style={{ ...runButtonStyle, opacity: busy ? 0.6 : 1 }}
                >
                    {t('clockAdvanceWeek')}
                </UnstyledButton>
                <UnstyledButton
                    data-testid="simulator-clock-run-due"
                    disabled={busy}
                    onClick={() => run(clock.onRunDue)}
                    style={{ ...runButtonStyle, opacity: busy ? 0.6 : 1 }}
                >
                    {t('clockRunDue')}
                </UnstyledButton>
                {clock.offsetMs > 0 ? (
                    <UnstyledButton
                        data-testid="simulator-clock-reset"
                        disabled={busy}
                        onClick={() => run(clock.onReset)}
                        style={{ ...runButtonStyle, opacity: busy ? 0.6 : 1 }}
                    >
                        {t('clockReset')}
                    </UnstyledButton>
                ) : null}
            </Group>
        </Box>
    )
}

/**
 * The dev ticker block: ticks the scheduler on real time, as `pnpm tick` does, until stopped. Off until someone
 * starts it. One Start/Stop button whose label changes, never two buttons swapped, so keyboard focus stays on it; and
 * `aria-disabled` rather than `disabled` while busy, which would drop that focus to the page.
 */
function DevTicker({ ticker }: { ticker: DevTickerLike }) {
    const t = useTranslations('simulator')
    const locale = useLocale()
    const [busy, setBusy] = useState(false)
    const [seconds, setSeconds] = useState<number | string>(ticker.seconds ?? ticker.defaultSeconds)
    // Another process's ticker is live on this world: starting a second is refused, so the button says so up front.
    const blocked = !ticker.running && ticker.elsewhere !== null
    const inert = busy || blocked

    function toggle() {
        if (inert) return
        setBusy(true)
        const action = ticker.running ? ticker.onStop() : ticker.onStart(Number(seconds))
        void Promise.resolve(action).finally(() => setBusy(false))
    }

    let status: string
    if (ticker.running && ticker.seconds !== null) status = t('tickerRunning', { seconds: ticker.seconds })
    else if (ticker.elsewhere) status = t('tickerElsewhere', ticker.elsewhere)
    else status = t('tickerStopped')

    return (
        <Box style={sectionStyle} data-testid="simulator-ticker">
            <Text size="xs" fw={700} c="gray.0" mb={4}>
                {t('tickerTitle')}
            </Text>
            <Text size="xs" c="gray.5" mb={6}>
                {t('tickerHint')}
            </Text>
            <Text
                size="xs"
                c={ticker.running ? 'teal.4' : ticker.elsewhere ? 'yellow.4' : 'gray.4'}
                data-testid="simulator-ticker-status"
            >
                {status}
            </Text>
            {ticker.running ? (
                <Text size="xs" c="gray.4" data-testid="simulator-ticker-ticks">
                    {ticker.lastTickAt
                        ? t('tickerTicks', { count: ticker.ticks, when: formatWhen(ticker.lastTickAt, locale) })
                        : t('tickerNoTickYet')}
                </Text>
            ) : null}
            {ticker.lastError ? (
                <Text size="xs" c="red.4" data-testid="simulator-ticker-error">
                    {t('tickerLastError', { error: ticker.lastError })}
                </Text>
            ) : null}
            <Group gap={6} wrap="nowrap" align="end" mt={8}>
                {/* While it runs, the status line names the interval; a disabled field would only be harder to read. */}
                {ticker.running ? null : (
                    <NumberInput
                        size="xs"
                        w={150}
                        data-testid="simulator-ticker-seconds"
                        label={t('tickerIntervalLabel')}
                        min={ticker.minSeconds}
                        max={ticker.maxSeconds}
                        allowDecimal={false}
                        allowNegative={false}
                        value={seconds}
                        onChange={setSeconds}
                    />
                )}
                <UnstyledButton
                    data-testid="simulator-ticker-toggle"
                    aria-disabled={inert || undefined}
                    onClick={toggle}
                    style={{ ...runButtonStyle, opacity: inert ? 0.6 : 1, cursor: inert ? 'not-allowed' : undefined }}
                >
                    {ticker.running ? t('tickerStop') : t('tickerStart')}
                </UnstyledButton>
            </Group>
        </Box>
    )
}

/** The schedule list: kind, its timing summary, next run, and enabled state, per tenant/org. */
function Schedules({ schedules }: { schedules: ScheduleRowLike[] }) {
    const t = useTranslations('simulator')
    const locale = useLocale()

    return (
        <Box style={sectionStyle} data-testid="simulator-schedules">
            <Text size="xs" fw={700} c="gray.0" mb={6}>
                {t('schedulesTitle')}
            </Text>
            {schedules.length === 0 ? (
                <Text size="xs" c="gray.5" data-testid="simulator-schedules-empty">
                    {t('schedulesEmpty')}
                </Text>
            ) : (
                <Stack gap={6}>
                    {schedules.map((schedule) => (
                        <Box
                            key={schedule.id}
                            data-testid={`simulator-schedule-${schedule.id}`}
                            style={{ border: '1px solid rgba(255,255,255,0.12)', borderRadius: 6, padding: '6px 8px' }}
                        >
                            <Group justify="space-between" wrap="nowrap" gap="xs" align="start">
                                <Stack gap={2} style={{ minWidth: 0 }}>
                                    <Text size="sm" fw={600} c="gray.0" truncate>
                                        {schedule.kind}
                                    </Text>
                                    <Text size="xs" c="gray.4">
                                        <ScheduleSpecSummary spec={schedule.spec} />
                                    </Text>
                                    <Group gap={4} wrap="nowrap">
                                        <Text size="xs" c="gray.3" style={chipStyle}>
                                            {schedule.tenantSlug}
                                        </Text>
                                        <Text size="xs" c="gray.3" style={chipStyle}>
                                            {schedule.orgSlug}
                                        </Text>
                                    </Group>
                                </Stack>
                                <Stack gap={2} align="end" style={{ flexShrink: 0 }}>
                                    <Text
                                        size="xs"
                                        fw={700}
                                        c={schedule.enabled ? 'teal.4' : 'gray.5'}
                                        style={chipStyle}
                                    >
                                        {schedule.enabled ? t('scheduleEnabled') : t('scheduleDisabled')}
                                    </Text>
                                    <Text size="xs" c="gray.5" style={{ whiteSpace: 'nowrap' }}>
                                        {t('scheduleNextRun', { when: formatWhen(schedule.nextRunAt, locale) })}
                                    </Text>
                                </Stack>
                            </Group>
                        </Box>
                    ))}
                </Stack>
            )}
        </Box>
    )
}

/**
 * Router-agnostic Simulator Jobs tab (ADR-0006 twin lives in @sssb/kit/demo-static): the simulated world's
 * cross-tenant job view, dark-skinned to match the other world tabs (People/Events). Above the job
 * list, it also carries the world-clock control and the schedule list, so the operator can
 * advance simulated time past a schedule's next_run_at and watch it fire. Each job row shows the kind,
 * its tenant/org slug chips, a coloured status chip and the time, and expands to the full status
 * timeline. A held badge flags the paused world; "Run pending jobs" (only when the host wires
 * onRunPending) steps every queued job forward.
 */
export function JobsApp({
    jobs,
    held,
    onRunPending,
    schedules,
    clock,
    ticker,
}: {
    jobs: WorldJobLike[]
    held: boolean
    onRunPending?: () => void | Promise<void>
    /** Scheduled work — the world's schedules and clock. Optional so a host that doesn't wire them still works. */
    schedules?: ScheduleRowLike[]
    clock?: WorldClockLike
    /** The dev ticker control; absent unless the host's server offers one (see DevTickerLike). */
    ticker?: DevTickerLike | undefined
}) {
    const t = useTranslations('simulator')
    const locale = useLocale()
    const [openId, setOpenId] = useState<string | null>(null)
    const [busy, setBusy] = useState(false)

    return (
        <Stack gap="sm" data-testid="simulator-jobs">
            {clock ? <WorldClock clock={clock} /> : null}
            {ticker ? <DevTicker ticker={ticker} /> : null}
            {schedules ? <Schedules schedules={schedules} /> : null}

            {held || onRunPending ? (
                <Group justify="space-between" wrap="nowrap" gap="xs">
                    {held ? (
                        <Text
                            size="xs"
                            fw={700}
                            data-testid="simulator-jobs-held"
                            style={{ background: '#5c3d00', color: '#ffd43b', borderRadius: 999, padding: '2px 10px' }}
                        >
                            {t('jobsHeldBadge')}
                        </Text>
                    ) : (
                        <span />
                    )}
                    {onRunPending ? (
                        <UnstyledButton
                            data-testid="simulator-jobs-run"
                            disabled={busy}
                            onClick={() => {
                                setBusy(true)
                                void Promise.resolve(onRunPending()).finally(() => setBusy(false))
                            }}
                            style={{ ...runButtonStyle, opacity: busy ? 0.6 : 1 }}
                        >
                            {t('jobsRunPending')}
                        </UnstyledButton>
                    ) : null}
                </Group>
            ) : null}

            {jobs.length === 0 ? (
                <Text size="sm" c="gray.5" data-testid="simulator-jobs-empty">
                    {t('jobsEmpty')}
                </Text>
            ) : (
                <Stack gap={6} data-testid="simulator-jobs-list">
                    {jobs.map((job) => {
                        const open = job.id === openId
                        return (
                            <Box
                                key={job.id}
                                data-testid={`simulator-job-${job.id}`}
                                style={{ border: '1px solid rgba(255,255,255,0.18)', borderRadius: 8 }}
                            >
                                <UnstyledButton
                                    data-testid={`simulator-job-toggle-${job.id}`}
                                    aria-expanded={open}
                                    onClick={() => setOpenId(open ? null : job.id)}
                                    style={{ display: 'block', width: '100%', padding: '8px 10px' }}
                                >
                                    <Group justify="space-between" wrap="nowrap" gap="xs" align="start">
                                        <Stack gap={4} style={{ minWidth: 0 }}>
                                            <Text size="sm" fw={600} c="gray.0" truncate>
                                                {job.kind}
                                            </Text>
                                            <Group gap={4} wrap="nowrap">
                                                <Text size="xs" c="gray.3" style={chipStyle}>
                                                    {job.tenantSlug}
                                                </Text>
                                                {job.orgSlug ? (
                                                    <Text size="xs" c="gray.3" style={chipStyle}>
                                                        {job.orgSlug}
                                                    </Text>
                                                ) : null}
                                            </Group>
                                        </Stack>
                                        <Stack gap={4} align="end" style={{ flexShrink: 0 }}>
                                            <Text size="xs" fw={700} c={statusColor(job.status)} style={chipStyle}>
                                                {job.status}
                                            </Text>
                                            <Text size="xs" c="gray.5" style={{ whiteSpace: 'nowrap' }}>
                                                {formatWhen(job.createdAt, locale)}
                                            </Text>
                                        </Stack>
                                    </Group>
                                </UnstyledButton>
                                {open ? (
                                    <Box px={10} pb="xs" style={{ color: '#f8f9fa' }}>
                                        <JobTimeline timeline={job.timeline} />
                                        {job.error ? (
                                            <Text size="xs" c="red.4" mt={4}>
                                                {job.error}
                                            </Text>
                                        ) : null}
                                    </Box>
                                ) : null}
                            </Box>
                        )
                    })}
                </Stack>
            )}
        </Stack>
    )
}
