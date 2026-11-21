import { beforeEach, describe, expect, test, vi } from 'vitest'
import SignInPage from './page'
import { PickerGlue } from './picker-glue'
import { RefusedGlue } from './refused-glue'

const h = vi.hoisted(() => ({ getCurrentUser: vi.fn(), refusal: vi.fn(), redirect: vi.fn() }))
vi.mock('@sssb/kit/adapters/index', () => ({
    auth: { getCurrentUser: h.getCurrentUser, refusal: h.refusal },
    isSimulated: true,
}))
vi.mock('next/navigation', () => ({
    redirect: (to: string) => {
        h.redirect(to)
        throw new Error('NEXT_REDIRECT')
    },
}))
vi.mock('next-intl/server', () => ({ setRequestLocale: () => {}, getTranslations: async () => (key: string) => key }))

beforeEach(() => {
    for (const fn of Object.values(h)) fn.mockReset()
    h.getCurrentUser.mockResolvedValue(null)
    h.refusal.mockResolvedValue(null)
})

async function body() {
    const page = await SignInPage({ params: Promise.resolve({ locale: 'en' }), searchParams: Promise.resolve({}) })
    return (page as { props: { body: { type: unknown } } }).props.body.type
}

describe('the sign-in page', () => {
    test('shows a person the auth port refuses why, and a way out, instead of the sign-in', async () => {
        h.refusal.mockResolvedValue({ reason: 'other-tenant' })
        expect(await body()).toBe(RefusedGlue)
    })

    test('shows the sign-in when nobody is refused', async () => {
        expect(await body()).toBe(PickerGlue)
    })

    test('sends a signed-in user on, before asking about refusal', async () => {
        h.getCurrentUser.mockResolvedValue({ id: 'user-one' })
        await expect(body()).rejects.toThrow('NEXT_REDIRECT')
        expect(h.refusal).not.toHaveBeenCalled()
    })
})
