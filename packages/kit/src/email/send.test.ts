// @vitest-environment node
import { createElement } from 'react'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { makeTestTmpDir } from '../testing/tmp-dir'

/**
 * A subject composed from data may hold a line break (an org named on two lines): sendTemplate turns each run of them
 * into one space and the message is sent, while the port itself still refuses such a subject from a direct caller.
 */
const tmp = makeTestTmpDir('app-email-send-')
beforeAll(() => {
    process.env['APP_DATA_DIR'] = tmp
})
afterAll(() => {
    delete process.env['APP_DATA_DIR']
})

describe('sendTemplate', () => {
    test('sends a subject with line breaks, each run of them made one space', async () => {
        const { sendTemplate } = await import('./send')
        const { fakeEmail, listCaughtEmails } = await import('../adapters/fake/email')
        await sendTemplate(fakeEmail, {
            to: 'invitee@example.test',
            subject: 'Join Harbor\r\n\r\nDepot\nnow',
            template: createElement('p', null, 'hello'),
        })
        expect(listCaughtEmails().map((m) => m.subject)).toEqual(['Join Harbor Depot now'])
    })

    test('the port still refuses that subject from a direct caller', async () => {
        const { fakeEmail } = await import('../adapters/fake/email')
        const message = { to: 'invitee@example.test', subject: 'Join Harbor\nDepot', html: '<p>h</p>', text: 'h' }
        await expect(fakeEmail.send(message)).rejects.toThrow('`subject` must not contain a line break')
    })
})
