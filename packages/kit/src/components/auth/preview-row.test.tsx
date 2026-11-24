import { MantineProvider } from '@mantine/core'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it } from 'vitest'
import { PreviewRow } from './preview-row'

const unmounts: Array<() => void> = []
afterEach(() => {
    for (const unmount of unmounts.splice(0)) act(unmount)
})

async function avatarText(props: Partial<Parameters<typeof PreviewRow>[0]>): Promise<string | null | undefined> {
    ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
    const container = document.createElement('div')
    document.body.append(container)
    const root = createRoot(container)
    await act(async () => {
        root.render(
            <MantineProvider>
                <PreviewRow name="Ana (Bea) Cruz" title="Ana (Bea) Cruz" {...props} />
            </MantineProvider>,
        )
    })
    unmounts.push(() => root.unmount())
    return container.querySelector('[aria-hidden="true"]')?.textContent
}

describe('PreviewRow avatar', () => {
    it('shows the first and last letter-words of the name', async () => {
        expect(await avatarText({})).toBe('AC')
    })

    it('falls back to the given fallback, then to the title, when the name has no letter-word', async () => {
        expect(await avatarText({ name: '(1)', title: 'Dana', fallback: 'eli@example.test' })).toBe('E')
        expect(await avatarText({ name: '(1)', title: 'Dana' })).toBe('D')
    })
})
