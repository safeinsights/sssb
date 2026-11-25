import { MantineProvider } from '@mantine/core'
import axe from 'axe-core'
import { NextIntlClientProvider } from 'next-intl'
import { act, StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import enFramework from '../../i18n/messages/en.json'
import esFramework from '../../i18n/messages/es.json'
import { RESEND_COOLDOWN_SECONDS, SecondFactorStep, type SecondFactor } from './second-factor-step'

/**
 * The code step on its own, with no identity provider: what it asks for, sends and verifies, what stays open after a
 * failure, and how it presents itself to autofill and assistive technology.
 */
const AUTHENTICATOR: SecondFactor = { kind: 'authenticator' }
const PHONE: SecondFactor = { kind: 'phone', destination: '+1*******99' }
const EMAIL: SecondFactor = { kind: 'email', destination: 'a***r@example.test' }
const BACKUP: SecondFactor = { kind: 'backup' }
const copy = enFramework.auth

const onSend = vi.fn<(kind: 'phone' | 'email') => Promise<boolean>>()
const onVerify = vi.fn<(kind: string, code: string) => Promise<boolean>>()
const onBack = vi.fn()

const unmounts: Array<() => void> = []
beforeEach(() => {
    ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
    onSend.mockReset().mockResolvedValue(true)
    onVerify.mockReset().mockResolvedValue(true)
    onBack.mockReset()
})
afterEach(() => {
    for (const unmount of unmounts.splice(0)) act(unmount)
    vi.useRealTimers()
})

async function render(
    factors: readonly [SecondFactor, ...SecondFactor[]],
    { newDevice = false, strict, locale = 'en' }: { newDevice?: boolean; strict?: boolean; locale?: 'en' | 'es' } = {},
): Promise<HTMLElement> {
    const container = document.createElement('div')
    document.body.append(container)
    const root = createRoot(container)
    const step = (
        <NextIntlClientProvider locale={locale} messages={locale === 'en' ? enFramework : esFramework}>
            <MantineProvider>
                <SecondFactorStep
                    factors={factors}
                    newDevice={newDevice}
                    onSend={onSend}
                    onVerify={onVerify}
                    onBack={onBack}
                />
            </MantineProvider>
        </NextIntlClientProvider>
    )
    await act(async () => root.render(strict ? <StrictMode>{step}</StrictMode> : step))
    unmounts.push(() => {
        root.unmount()
        container.remove()
    })
    return container
}

const field = (container: HTMLElement) => container.querySelector<HTMLInputElement>('input[name="code"]')!
const button = (container: HTMLElement, id: string) =>
    container.querySelector<HTMLButtonElement>(`[data-testid="second-factor-${id}"]`)!
const alertText = (container: HTMLElement) => container.querySelector('[role="alert"]')?.textContent
const statusText = (container: HTMLElement) => container.querySelector('[role="status"]')?.textContent
const click = (element: HTMLElement) => act(async () => element.click())
const choices = (container: HTMLElement) =>
    ['authenticator', 'phone', 'email', 'backup'].filter((kind) => button(container, `choose-${kind}`))

async function type(container: HTMLElement, code: string): Promise<void> {
    await act(async () => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(field(container), code)
        field(container).dispatchEvent(new Event('input', { bubbles: true }))
    })
}
const submit = (container: HTMLElement) =>
    act(async () => {
        container.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    })
async function enter(container: HTMLElement, code: string): Promise<void> {
    await type(container, code)
    await submit(container)
}
const networkDown = async () => {
    throw new Error('network down')
}

describe('the factors', () => {
    it('opens on the first, and offers the others', async () => {
        const container = await render([AUTHENTICATOR, PHONE, BACKUP])
        expect(container.querySelector('label')?.textContent).toContain(copy.codeLabelAuthenticator)
        expect(choices(container)).toEqual(['phone', 'backup'])
        expect(button(container, 'choose-phone').textContent).toContain('+1*******99')
        expect(onSend).not.toHaveBeenCalled()
    })

    it('offers no choice when there is one factor', async () => {
        expect(choices(await render([AUTHENTICATOR]))).toEqual([])
    })

    it('verifies with the factor chosen, starting from an empty field', async () => {
        const container = await render([AUTHENTICATOR, BACKUP])
        await type(container, '123')
        await click(button(container, 'choose-backup'))
        expect(field(container).value).toBe('')
        expect(choices(container)).toEqual(['authenticator'])
        await enter(container, ' ab cd ')
        // A backup code's own characters are the provider's to judge; only the ends are trimmed.
        expect(onVerify.mock.calls).toEqual([['backup', 'ab cd']])
    })
})

describe('the code', () => {
    it.each([AUTHENTICATOR, PHONE, EMAIL])('can be filled in by one-time-code autofill: $kind', async (factor) => {
        const container = await render([factor])
        expect(field(container).getAttribute('autocomplete')).toBe('one-time-code')
        expect(field(container).getAttribute('inputmode')).toBe('numeric')
    })

    it('is no one-time code when it is a backup code', async () => {
        const container = await render([BACKUP])
        expect(field(container).getAttribute('autocomplete')).toBe('off')
        expect(field(container).getAttribute('inputmode')).toBe('text')
    })

    it('is sent without the spaces it is printed with', async () => {
        const container = await render([AUTHENTICATOR])
        await enter(container, ' 123 456 ')
        expect(onVerify.mock.calls).toEqual([['authenticator', '123456']])
    })

    it('is not sent when it is blank', async () => {
        const container = await render([AUTHENTICATOR])
        await enter(container, '   ')
        expect(onVerify).not.toHaveBeenCalled()
    })

    it('is sent once, however often it is submitted while the provider answers', async () => {
        onVerify.mockReturnValue(new Promise(() => {}))
        const container = await render([AUTHENTICATOR, BACKUP])
        await enter(container, '123456')
        await submit(container)
        expect(onVerify).toHaveBeenCalledTimes(1)
        expect(button(container, 'back').disabled).toBe(true)
        expect(button(container, 'choose-backup').disabled).toBe(true)
    })

    it('keeps the spinner once it is taken, while the page navigates', async () => {
        const container = await render([AUTHENTICATOR])
        await enter(container, '123456')
        expect(container.querySelector<HTMLButtonElement>('[type="submit"]')!.disabled).toBe(true)
        expect(alertText(container)).toBeUndefined()
    })

    it.each([
        ['refused', async () => false],
        ['answered with a throw', networkDown],
    ])('when it is %s, says so and stays, every choice still open', async (_, answer) => {
        onVerify.mockImplementationOnce(answer)
        const container = await render([AUTHENTICATOR, BACKUP])
        await type(container, '123456')
        container.querySelector<HTMLButtonElement>('[type="submit"]')!.focus()
        await submit(container)
        expect(alertText(container)).toBe(copy.codeError)
        expect(field(container).getAttribute('aria-invalid')).toBe('true')
        expect(document.activeElement).toBe(field(container))
        for (const id of ['back', 'choose-backup']) expect(button(container, id).disabled).toBe(false)
        await enter(container, '654321')
        expect(onVerify).toHaveBeenLastCalledWith('authenticator', '654321')
        expect(alertText(container)).toBeUndefined()
    })

    it('is selected after an error, for the next one to replace', async () => {
        onVerify.mockResolvedValueOnce(false)
        const container = await render([AUTHENTICATOR])
        await enter(container, '123456')
        expect([field(container).selectionStart, field(container).selectionEnd]).toEqual([0, 6])
    })

    it('loses its error when another factor is chosen', async () => {
        onVerify.mockResolvedValueOnce(false)
        const container = await render([AUTHENTICATOR, BACKUP])
        await enter(container, '123456')
        await click(button(container, 'choose-backup'))
        expect(alertText(container)).toBeUndefined()
        expect(field(container).getAttribute('aria-invalid')).not.toBe('true')
    })
})

describe('a code that is sent', () => {
    beforeEach(() => {
        vi.useFakeTimers()
    })
    const pass = (seconds: number) => act(async () => vi.advanceTimersByTimeAsync(seconds * 1000))

    it.each([
        ['phone', PHONE, '+1*******99'],
        ['email', EMAIL, 'a***r@example.test'],
    ] as const)('goes once when the step opens on it: %s', async (kind, factor, destination) => {
        const container = await render([factor], { strict: true })
        expect(onSend.mock.calls).toEqual([[kind]])
        expect(statusText(container)).toContain(destination)
    })

    it('goes again only after the cooldown, and starts it again', async () => {
        const container = await render([PHONE])
        expect(button(container, 'resend').disabled).toBe(true)
        expect(button(container, 'resend').textContent).toContain(`in ${RESEND_COOLDOWN_SECONDS} s`)
        await pass(RESEND_COOLDOWN_SECONDS - 1)
        expect(button(container, 'resend').textContent).toContain('in 1 s')
        await click(button(container, 'resend'))
        expect(onSend).toHaveBeenCalledTimes(1)
        await pass(1)
        expect(button(container, 'resend').textContent).toBe(copy.codeResend)
        button(container, 'resend').focus()
        await click(button(container, 'resend'))
        expect(onSend).toHaveBeenCalledTimes(2)
        expect(button(container, 'resend').disabled).toBe(true)
        // The button the person pressed is disabled now, so focus goes where the new code does.
        expect(document.activeElement).toBe(field(container))
    })

    it.each([
        ['refused', async () => false],
        ['answered with a throw', networkDown],
    ])('when the sending is %s, says so and can be tried again at once', async (_, answer) => {
        onSend.mockImplementationOnce(answer)
        const container = await render([PHONE, BACKUP])
        expect(alertText(container)).toBe(copy.codeSendError)
        expect(statusText(container)).toBe('')
        // The code is not what was wrong.
        expect(field(container).getAttribute('aria-invalid')).not.toBe('true')
        expect(button(container, 'resend').disabled).toBe(false)
        await click(button(container, 'resend'))
        expect(onSend).toHaveBeenCalledTimes(2)
        expect(alertText(container)).toBeUndefined()
        expect(statusText(container)).toContain('+1*******99')
        // A later one that fails does not leave the earlier one's success beside it.
        await pass(RESEND_COOLDOWN_SECONDS)
        onSend.mockImplementationOnce(answer)
        await click(button(container, 'resend'))
        expect(alertText(container)).toBe(copy.codeSendError)
        expect(statusText(container)).toBe('')
    })

    it('waits no longer when the clock is set back', async () => {
        const container = await render([PHONE])
        vi.setSystemTime(Date.now() - 3_600_000)
        await pass(RESEND_COOLDOWN_SECONDS)
        expect(button(container, 'resend').disabled).toBe(false)
    })

    it('leaves no timer running once the wait is over, or the step is gone', async () => {
        await render([PHONE])
        expect(vi.getTimerCount()).toBe(1)
        await pass(RESEND_COOLDOWN_SECONDS)
        expect(vi.getTimerCount()).toBe(0)
        await render([PHONE])
        expect(vi.getTimerCount()).toBe(1)
        for (const unmount of unmounts.splice(0)) act(unmount)
        expect(vi.getTimerCount()).toBe(0)
    })

    it('does not pull focus back from where the person went while it was being sent', async () => {
        let sent: (value: boolean) => void = () => {}
        onSend.mockReturnValue(new Promise((resolve) => (sent = resolve)))
        const container = await render([PHONE])
        button(container, 'back').focus()
        await act(async () => sent(true))
        expect(document.activeElement).toBe(button(container, 'back'))
    })

    it('cannot be asked for while a code is being verified', async () => {
        onVerify.mockReturnValue(new Promise(() => {}))
        const container = await render([PHONE])
        await pass(RESEND_COOLDOWN_SECONDS)
        await enter(container, '123456')
        expect(button(container, 'resend').disabled).toBe(true)
    })

    it('goes when its factor is chosen, and not again while it is fresh', async () => {
        const container = await render([AUTHENTICATOR, PHONE])
        await click(button(container, 'choose-phone'))
        expect(onSend.mock.calls).toEqual([['phone']])
        await pass(4)
        await click(button(container, 'choose-authenticator'))
        await pass(1)
        await click(button(container, 'choose-phone'))
        expect(onSend).toHaveBeenCalledTimes(1)
        expect(button(container, 'resend').textContent).toContain(`in ${RESEND_COOLDOWN_SECONDS - 5} s`)
        await pass(1)
        // The cooldown runs on while another factor is showing.
        await click(button(container, 'choose-authenticator'))
        await pass(RESEND_COOLDOWN_SECONDS)
        await click(button(container, 'choose-phone'))
        expect(onSend).toHaveBeenCalledTimes(2)
    })

    it('is not sent by the second click of a double click, on the button that took the first one its place', async () => {
        const container = await render([AUTHENTICATOR, PHONE, BACKUP])
        await pass(1)
        await click(button(container, 'choose-backup'))
        await click(button(container, 'choose-phone'))
        expect(onSend).not.toHaveBeenCalled()
        await pass(1)
        await click(button(container, 'choose-phone'))
        expect(onSend).toHaveBeenCalledTimes(1)
    })

    it('has a cooldown of its own for each factor', async () => {
        const container = await render([PHONE, EMAIL])
        await click(button(container, 'choose-email'))
        expect(onSend.mock.calls).toEqual([['phone'], ['email']])
    })

    it('never locks the way back, even while it is still being sent', async () => {
        onSend.mockReturnValue(new Promise(() => {}))
        const container = await render([PHONE, BACKUP])
        expect(statusText(container)).toBe(copy.codeSending)
        await enter(container, '123456')
        expect(onVerify).not.toHaveBeenCalled()
        await click(button(container, 'back'))
        expect(onBack).toHaveBeenCalledTimes(1)
    })
})

describe('the way it presents itself', () => {
    it('moves focus to the code field as it opens, inside a group its heading and lead name and describe', async () => {
        const container = await render([AUTHENTICATOR, BACKUP])
        expect(document.activeElement).toBe(field(container))
        const group = field(container).closest('[role="group"]')!
        const text = (attribute: string) => document.getElementById(group.getAttribute(attribute)!)?.textContent
        expect(text('aria-labelledby')).toBe(copy.secondFactorTitle)
        expect(text('aria-describedby')).toBe(copy.secondFactorLead)
        await click(button(container, 'choose-backup'))
        expect(document.activeElement).toBe(field(container))
    })

    it('says when it is the device that is new', async () => {
        const container = await render([EMAIL], { newDevice: true })
        expect(container.textContent).toContain(copy.secondFactorNewDevice)
    })

    it.each(['en', 'es'] as const)(
        'has no accessibility violations, with and without an error (%s)',
        async (locale) => {
            onVerify.mockResolvedValue(false)
            const container = await render([PHONE, AUTHENTICATOR, EMAIL, BACKUP], { locale })
            // Colour needs a layout engine, which a unit test does not have.
            const scan = () => axe.run(container, { rules: { 'color-contrast': { enabled: false } } })
            const opened = await scan()
            expect(opened.violations).toEqual([])
            // The scan really saw the step.
            expect(opened.passes.map(({ id }) => id)).toContain('label')
            await enter(container, '123456')
            expect(container.querySelector('[role="alert"]')).not.toBeNull()
            expect((await scan()).violations).toEqual([])
        },
    )
})
