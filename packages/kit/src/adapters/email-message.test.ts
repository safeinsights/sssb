// @vitest-environment node
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest'
import { makeTestTmpDir } from '../testing/tmp-dir'

/**
 * The email port refuses a `to` that is not exactly one address and a subject with a line break, in the real adapter
 * (Mailgun replaced, never sent for real: cutover row `email-outbound`) and in the fake alike, before anything is sent
 * or stored.
 */
const tmp = makeTestTmpDir('app-email-message-')
beforeAll(() => {
    process.env['APP_DATA_DIR'] = tmp
})
afterAll(() => {
    delete process.env['APP_DATA_DIR']
})

const create = vi.fn(async () => ({}))
vi.mock('mailgun.js', () => ({
    default: class {
        client() {
            return { messages: { create } }
        }
    },
}))

const BODY = { html: '<p>h</p>', text: 't' }
const BAD_TO = [
    'invitee@example.test, attacker@evil.example',
    'invitee@example.test; attacker@evil.example',
    'invitee@example.test\r\nBcc: attacker@evil.example',
    'invitee@example.test attacker@evil.example',
    'no-at-sign.example',
    '',
]

async function adapters() {
    const { createRealEmail } = await import('./real/email')
    const { fakeEmail, listCaughtEmails } = await import('./fake/email')
    return { real: createRealEmail('mg.example', 'key', 'App <no-reply@mg.example>'), fakeEmail, listCaughtEmails }
}

describe('sending email', () => {
    test.each(BAD_TO)('both adapters refuse to send to %j, and nothing leaves', async (to) => {
        const { real, fakeEmail, listCaughtEmails } = await adapters()
        const message = { to, subject: 's', ...BODY }
        await expect(real.send(message)).rejects.toThrow('`to` must be exactly one address')
        await expect(fakeEmail.send(message)).rejects.toThrow('`to` must be exactly one address')
        expect(create).not.toHaveBeenCalled()
        expect(listCaughtEmails()).toEqual([])
    })

    test('both adapters refuse a subject with a line break', async () => {
        const { real, fakeEmail, listCaughtEmails } = await adapters()
        const message = { to: 'invitee@example.test', subject: 'hi\r\nBcc: attacker@evil.example', ...BODY }
        await expect(real.send(message)).rejects.toThrow('`subject` must not contain a line break')
        await expect(fakeEmail.send(message)).rejects.toThrow('`subject` must not contain a line break')
        expect(create).not.toHaveBeenCalled()
        expect(listCaughtEmails()).toEqual([])
    })

    test('one address, bare or with a display name, is sent', async () => {
        const { real, fakeEmail, listCaughtEmails } = await adapters()
        for (const to of ['invitee@example.test', 'Ada Lovelace <ada@example.test>']) {
            await real.send({ to, subject: 's', ...BODY })
            await fakeEmail.send({ to, subject: 's', ...BODY })
        }
        expect(create.mock.calls.map((call) => (call as unknown[])[1])).toMatchObject([
            { to: ['invitee@example.test'] },
            { to: ['Ada Lovelace <ada@example.test>'] },
        ])
        expect(
            listCaughtEmails()
                .map((m) => m.to)
                .sort(),
        ).toEqual(['Ada Lovelace <ada@example.test>', 'invitee@example.test'])
    })
})
