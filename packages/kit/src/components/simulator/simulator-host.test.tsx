import { loadAppMessages } from '@sssb/app-config/messages'
import { MantineProvider } from '@mantine/core'
import { NextIntlClientProvider } from 'next-intl'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import enFramework from '../../i18n/messages/en.json'
import { mergeMessages } from '../../i18n/messages'
import { SimulatorHost } from './simulator-host'

/**
 * The Snapshots and Tours wiring of the kit's Simulator host, against a stubbed server: each control posts to its path
 * with its body, a world start (reset, restore, preset) reloads only when the server agreed, and a refusal frees the
 * controls again. The fixture registers one preset family (`busy-harbor`); its tours are replaced here by three that
 * start from each kind of world start.
 */

vi.mock('@sssb/app-config/tours', () => ({
    tours: [
        { id: 'from-reset', titleKey: 'k', summaryKey: 'k', snapshot: 'reset', steps: [{ textKey: 'k' }] },
        { id: 'from-preset', titleKey: 'k', summaryKey: 'k', snapshot: 'busy-harbor', steps: [{ textKey: 'k' }] },
        { id: 'from-snapshot', titleKey: 'k', summaryKey: 'k', snapshot: 'harbor-noon', steps: [{ textKey: 'k' }] },
    ],
}))

const AGREEMENT = {
    id: '6f1c2a3e-0b4d-4e5f-8a9b-1c2d3e4f5a6b',
    tenantSlug: 'harbor',
    kind: 'tos',
    title: 'Harbor rules',
    version: 1,
    gating: 'block-all',
    currentAcceptances: 0,
    totalAcceptances: 0,
}

type Answer = { status?: number; body?: unknown; text?: string }
let answers: Record<string, Answer>
const posts: Array<{ path: string; body: unknown }> = []
const assign = vi.fn()
const reload = vi.fn()

function respond({ status = 200, body, text }: Answer): Response {
    if (text !== undefined) return new Response(text, { status, headers: { 'content-type': 'text/html' } })
    return body === undefined ? new Response(null, { status }) : Response.json(body, { status })
}

beforeEach(() => {
    posts.length = 0
    assign.mockReset()
    reload.mockReset()
    answers = {
        'GET summary': { body: { viewpoint: null, signedIn: false, people: [] } },
        'GET snapshots': { body: { snapshots: [{ name: 'harbor-noon', at: '2026-11-27T12:00:00.000Z' }] } },
        'GET flags': { body: { flags: [{ flag: 'jobs-held', enabled: false }] } },
        'GET agreements': { body: { agreements: [AGREEMENT] } },
    }
    vi.stubGlobal('fetch', async (input: string, init?: RequestInit) => {
        const path = input.replace('/api/simulator/', '')
        const method = init?.method ?? 'GET'
        if (method === 'POST') {
            expect(new Headers(init?.headers).get('content-type')).toBe('application/json')
            posts.push({ path, body: JSON.parse(String(init?.body)) })
        }
        return respond(answers[`${method} ${path}`] ?? { status: method === 'POST' ? 204 : 404 })
    })
    // Location's fields are getters on its prototype, so a spread copies none of them: the stub names each one.
    const url = new URL('http://localhost:3000/en/dashboard')
    const { href, origin, protocol, host, hostname, port, pathname, search, hash } = url
    vi.stubGlobal('location', { href, origin, protocol, host, hostname, port, pathname, search, hash, assign, reload })
    window.localStorage.setItem('app-simulator-collapsed', 'false')
    window.localStorage.setItem('app-simulator-tab', 'snapshots')
})

const unmounts: Array<() => void> = []
afterEach(() => {
    for (const unmount of unmounts.splice(0)) act(unmount)
    window.localStorage.clear()
    window.sessionStorage.clear()
    vi.unstubAllGlobals()
})

/** Lets every pending fetch and the renders it causes finish. */
async function settle() {
    for (let i = 0; i < 5; i++) await act(async () => await new Promise((resolve) => setTimeout(resolve, 0)))
}

async function renderHost(): Promise<HTMLElement> {
    const messages = mergeMessages(enFramework, await loadAppMessages('en'))
    ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
    const container = document.createElement('div')
    document.body.append(container)
    const root = createRoot(container)
    await act(async () => {
        root.render(
            <NextIntlClientProvider locale="en" messages={messages} onError={() => {}}>
                <MantineProvider>
                    <SimulatorHost locale="en">
                        <main />
                    </SimulatorHost>
                </MantineProvider>
            </NextIntlClientProvider>,
        )
    })
    unmounts.push(() => {
        root.unmount()
        container.remove()
    })
    await settle()
    return container
}

function byTestId(container: HTMLElement, id: string): HTMLElement {
    const element = container.querySelector<HTMLElement>(`[data-testid="${id}"]`)
    if (!element) throw new Error(`no [data-testid="${id}"]`)
    return element
}

async function click(container: HTMLElement, id: string) {
    await act(async () => byTestId(container, id).click())
    await settle()
}

const notices = (container: HTMLElement) =>
    [...container.querySelectorAll('[data-testid="simulator-notice"]')].map((notice) => notice.textContent)

describe('SimulatorHost: Snapshots', () => {
    it('fetches the tab when it opens: snapshots, flags, agreements and the fixture presets', async () => {
        const container = await renderHost()
        expect(byTestId(container, 'snapshots-row-harbor-noon')).toBeTruthy()
        expect(byTestId(container, 'flag-toggle-jobs-held')).toBeTruthy()
        expect(byTestId(container, `simulator-agreement-${AGREEMENT.id}`)).toBeTruthy()
        expect(byTestId(container, 'preset-load-busy-harbor')).toBeTruthy()
    })

    it('a reset posts, leaves the marker and reloads onto the welcome page', async () => {
        const container = await renderHost()
        await click(container, 'snapshots-reset')
        await click(container, 'snapshots-reset-confirm')
        expect(posts).toEqual([{ path: 'reset', body: {} }])
        expect(assign).toHaveBeenCalledWith('/en')
        expect(JSON.parse(window.sessionStorage.getItem('app-simulator-post-notice')!)).toEqual({ kind: 'reset' })
    })

    it('a restore posts its name and reloads; a refused one reloads nothing and frees the controls', async () => {
        const container = await renderHost()
        await click(container, 'snapshots-restore-harbor-noon')
        expect(posts).toEqual([{ path: 'snapshots/restore', body: { name: 'harbor-noon' } }])
        expect(assign).toHaveBeenCalledWith('/en')

        assign.mockReset()
        window.sessionStorage.clear()
        answers['POST snapshots/restore'] = { status: 404, body: { error: 'not found' } }
        const again = await renderHost()
        await click(again, 'snapshots-restore-harbor-noon')
        expect(assign).not.toHaveBeenCalled()
        expect(window.sessionStorage.getItem('app-simulator-post-notice')).toBeNull()
        expect(byTestId(again, 'snapshots-reset').hasAttribute('disabled')).toBe(false)
    })

    it('a delete posts its name and says so', async () => {
        const container = await renderHost()
        await click(container, 'snapshots-delete-harbor-noon')
        expect(posts).toEqual([{ path: 'snapshots/delete', body: { name: 'harbor-noon' } }])
        expect(notices(container).join(' ')).toContain('harbor-noon')
        expect(assign).not.toHaveBeenCalled()
    })

    it('a save posts the typed name', async () => {
        const container = await renderHost()
        const input = byTestId(container, 'snapshot-name') as HTMLInputElement
        await act(async () => {
            Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'tide-out')
            input.dispatchEvent(new Event('input', { bubbles: true }))
        })
        await click(container, 'snapshots-save')
        expect(posts).toEqual([{ path: 'snapshots', body: { name: 'tide-out' } }])
        expect(notices(container).join(' ')).toContain('tide-out')
    })

    it('a flag posts and reloads the page', async () => {
        answers['POST flags'] = { body: { ok: true } }
        const container = await renderHost()
        await click(container, 'flag-toggle-jobs-held')
        expect(posts).toEqual([{ path: 'flags', body: { flag: 'jobs-held', enabled: true } }])
        expect(reload).toHaveBeenCalled()
    })

    it('an agreement bump posts its id and says the new version', async () => {
        answers['POST agreements/bump'] = { body: { version: 2 } }
        const container = await renderHost()
        await click(container, `agreement-bump-${AGREEMENT.id}`)
        expect(posts).toEqual([{ path: 'agreements/bump', body: { agreementId: AGREEMENT.id } }])
        expect(notices(container).join(' ')).toContain('v2')
    })

    it('a preset posts its id and locale, and lands where the server says', async () => {
        answers['POST presets'] = { body: { redirectTo: '/en/dashboard' } }
        const container = await renderHost()
        await click(container, 'preset-load-busy-harbor')
        expect(posts).toEqual([{ path: 'presets', body: { name: 'busy-harbor', locale: 'en' } }])
        expect(assign).toHaveBeenCalledWith('/en/dashboard')
        expect(JSON.parse(window.sessionStorage.getItem('app-simulator-post-notice')!)).toEqual({
            kind: 'preset',
            name: 'busy-harbor',
        })
    })

    it.each<[string, Answer]>([
        ['a refusal', { status: 404, body: { error: 'not found' } }],
        ['a redirect off this origin', { body: { redirectTo: 'https://elsewhere.example/' } }],
        ['a body that is not JSON', { text: '<html>' }],
    ])('a preset load is said to have failed on %s, reloads nothing and frees the controls', async (_, answer) => {
        answers['POST presets'] = answer
        const container = await renderHost()
        await click(container, 'preset-load-busy-harbor')
        expect(assign).not.toHaveBeenCalled()
        expect(notices(container)).toHaveLength(1)
        expect(byTestId(container, 'preset-load-busy-harbor').hasAttribute('disabled')).toBe(false)
    })

    it.each([
        [{ kind: 'reset' }, 'World reset'],
        [{ kind: 'restore', name: 'harbor-noon' }, 'harbor-noon'],
    ])('the marker %j a reload left becomes a notice, once', async (marker, text) => {
        window.sessionStorage.setItem('app-simulator-post-notice', JSON.stringify(marker))
        const container = await renderHost()
        expect(notices(container).join(' ')).toContain(text)
        expect(window.sessionStorage.getItem('app-simulator-post-notice')).toBeNull()
    })
})

describe('SimulatorHost: Tours', () => {
    it.each([
        ['from-reset', 'reset', {}],
        ['from-preset', 'presets', { name: 'busy-harbor', locale: 'en' }],
        ['from-snapshot', 'snapshots/restore', { name: 'harbor-noon' }],
    ])('%s starts its world through %s', async (tour, path, body) => {
        answers['POST presets'] = { body: { redirectTo: '/en/dashboard' } }
        window.localStorage.setItem('app-simulator-tab', 'tours')
        const container = await renderHost()
        await click(container, `tour-start-${tour}`)
        expect(posts).toEqual([{ path, body }])
        expect(assign).toHaveBeenCalled()
    })
})
