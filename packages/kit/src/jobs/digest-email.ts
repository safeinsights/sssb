import { digestBodies } from '@sssb/app-config/digest'
import { getTranslations } from 'next-intl/server'
// The run mode without the registry (as the request proxy asks it): the registry loads the job handlers, this one
// included, so importing it here would close that loop.
import { isSimulated } from '../adapters/run-mode'
import type { Locale } from '../core/locale'
import { orgForId } from '../db/org-lookup'
import { sendTemplate } from '../email/send'
import { DigestEmail } from '../email/templates/digest-email'
import { routing } from '../i18n/routing'
import type { AuthPort } from '../ports/auth'
import type { DbPort } from '../ports/db'
import type { JobHandler } from '../ports/jobs'

/** How many recent rows the digest lists, and the snippet length used as each row's "title". */
const RECENT_LIMIT = 5
const SNIPPET_LENGTH = 60

/** What the seam is handed to find one team's digestible rows. */
export interface DigestScope {
    db: DbPort
    tenantId: string
    orgId: string
}

/**
 * The seam contract for "what this app's digest summarizes" (`@sssb/app-config/digest`). WHICH rows a
 * digest is about is app vocabulary — the framework only knows there is a scheduled email and how to
 * count and snip. Returns the bodies NEWEST FIRST; the app is responsible for scoping the read
 * (`db.withTenant`) exactly as its own routes do. An app with nothing to digest returns `[]` and
 * still gets a valid empty-state digest.
 *
 * This mirrors, one for one, the static twin's `DemoWorldOptions.digestBodies` (@sssb/kit/demo-static/
 * contracts.ts) — which had the seam from the day the world moved into the package, while the server
 * handler went on reading one app’s product table directly.
 */
export type DigestBodySource = (scope: DigestScope) => Promise<string[]>

function snippet(body: string): string {
    const oneLine = body.replace(/\s+/g, ' ').trim()
    return oneLine.length > SNIPPET_LENGTH ? `${oneLine.slice(0, SNIPPET_LENGTH - 1)}…` : oneLine
}

/**
 * Who a team's digest is addressed to, and in which locale: the team's first active admin, else its first active
 * member, as the auth port lists them (the identity provider in a deployment, the simulated world's people in a
 * demo). Never the seed: a deployment has none, and its people are the provider's.
 *
 * The locale is the person's own only in a simulated world, where the fake auth adapter knows it (loaded only
 * there, as `makeNotifyDeps` does); the auth port carries none, so a deployment writes in the app's default.
 *
 * A team with no active member: in a simulated world, a synthetic per-org address, still visible under Simulator
 * Mail's "all" scope, so the demo never shows an empty digest; in a deployment, nobody (null), and nothing is sent.
 */
async function digestRecipient(auth: AuthPort, orgSlug: string): Promise<{ to: string; locale: Locale } | null> {
    const members = (await auth.listMembers(orgSlug)).filter((m) => m.status === 'active' && m.email !== '')
    const chosen = members.find((m) => m.role === 'admin') ?? members[0]
    const resolveLocale = isSimulated ? (await import('../adapters/fake/auth')).personLocale : undefined
    if (chosen) return { to: chosen.email, locale: resolveLocale?.(chosen.id) ?? routing.defaultLocale }
    return isSimulated ? { to: `${orgSlug}@digest.example`, locale: routing.defaultLocale } : null
}

/**
 * digest-email handler: composes a simple org digest — a row count + recent row titles for
 * the schedule's team — and sends it via the email port with the DigestEmail react-email template.
 * The ROWS come from the seam (`@sssb/app-config/digest`), so the framework's scheduled-work example
 * carries no app table name; a team with nothing to report still gets a valid (empty-state) digest.
 *
 * A scheduled email has no request/user locale at fire time (unlike the invite, sent by an acting
 * user), so the recipient's locale drives the copy where it is known (`digestRecipient`), falling back to the app
 * default. Sends nothing to storage: the effect IS the email, so it returns no resultKey.
 */
export const digestEmailHandler: JobHandler = async (_payload, ctx) => {
    const { db, email, auth, tenantId, orgId } = ctx
    if (orgId === null) return {} // schedules are org-scoped (org_id NOT NULL), so this is unreachable; guard anyway

    const org = await orgForId(db, orgId)
    if (!org) return {} // the org is gone: nobody to address, and no team to digest
    const orgName = org.name
    const recipient = await digestRecipient(auth, org.slug)
    if (!recipient) return {} // a deployment's team with no active member: nobody to send it to
    const { to, locale } = recipient

    // The app supplies its own rows, newest first; counting and snipping stay here, so every app's
    // digest reads identically and the twin's numbers match the server's by construction.
    const bodies = await digestBodies({ db, tenantId, orgId })
    const count = bodies.length
    const recent = bodies.slice(0, RECENT_LIMIT).map(snippet)

    const t = await getTranslations({ locale, namespace: 'email' })
    await sendTemplate(email, {
        to,
        subject: t('digestSubject', { org: orgName }),
        template: DigestEmail({
            labels: {
                preview: t('digestPreview', { org: orgName }),
                heading: t('digestHeading', { org: orgName }),
                intro: t('digestIntro', { org: orgName }),
                countLine: t('digestCount', { count }),
                recentHeading: t('digestRecentHeading'),
                emptyLine: t('digestEmpty'),
                footer: t('digestFooter'),
            },
            recentTitles: recent,
        }),
    })
    return {}
}
