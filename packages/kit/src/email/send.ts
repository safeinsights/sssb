import { render } from '@react-email/render'
import type { ReactElement } from 'react'
import type { EmailPort } from '../ports/email'

/**
 * Renders a react-email template to html+text and hands it to whichever email adapter is wired. A subject is often
 * composed from data (an org's name), so each run of line breaks in it becomes one space here: the message is sent
 * rather than refused by the port, which refuses a subject with a line break from a direct caller.
 */
export async function sendTemplate(
    port: EmailPort,
    options: { to: string; subject: string; template: ReactElement },
): Promise<void> {
    const [html, text] = await Promise.all([render(options.template), render(options.template, { plainText: true })])
    await port.send({ to: options.to, subject: options.subject.replace(/[\r\n]+/g, ' '), html, text })
}
