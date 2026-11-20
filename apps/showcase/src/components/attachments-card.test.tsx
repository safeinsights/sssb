import { MantineProvider } from '@mantine/core'
import { NextIntlClientProvider } from 'next-intl'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import en from '../../messages/en.json'
import { AttachmentsCard } from './attachments-card'

/**
 * A browser fires `change` on a file input only when its selection changes, so the card clears the input once it has
 * taken the file: after a failed upload, picking the same file again must reach `onUpload` again.
 */

const unmounts: Array<() => void> = []
afterEach(() => {
    for (const unmount of unmounts.splice(0)) act(unmount)
})

describe('AttachmentsCard', () => {
    it('hands the picked file to onUpload and clears the input, so the same file can be picked again', async () => {
        ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
        const onUpload = vi.fn(() => Promise.reject(new Error('upload failed')))
        const container = document.createElement('div')
        document.body.append(container)
        const root = createRoot(container)
        await act(async () => {
            root.render(
                <NextIntlClientProvider locale="en" messages={en}>
                    <MantineProvider>
                        <AttachmentsCard attachments={[]} canCreate onUpload={onUpload} />
                    </MantineProvider>
                </NextIntlClientProvider>,
            )
        })
        unmounts.push(() => root.unmount())

        const input = container.querySelector<HTMLInputElement>('[data-testid="attachment-drop"]')!
        const file = new File(['bundle'], 'bundle.zip')
        Object.defineProperty(input, 'files', { value: [file], configurable: true })
        const cleared = vi.fn()
        Object.defineProperty(input, 'value', {
            set: cleared,
            get: () => 'C:\\fakepath\\bundle.zip',
            configurable: true,
        })
        await act(async () => {
            input.dispatchEvent(new Event('change', { bubbles: true }))
        })

        expect(onUpload).toHaveBeenCalledWith(file, 'attachment')
        expect(cleared).toHaveBeenCalledWith('')
    })
})
