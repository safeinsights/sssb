import type { EmailMessage } from '../ports/email'

/**
 * Refuses a message the email port must never send, before any adapter hands it on: a `to` that is not exactly one
 * address, and a `subject` that could break a header. Mailgun's `to` takes a comma-separated list, so a `to` built from
 * user input (`a@x.test, b@evil.test`) would otherwise mail everyone in it. Both the real adapter and the fake call this,
 * so a test on the simulated world fails where a deployment would have sent to a list. Neither value is echoed in the
 * error: both may be personal data, and the error may reach a log.
 */
export function assertSendableMessage(message: EmailMessage): void {
    const { to, subject } = message
    if (typeof to !== 'string' || to.trim() === '' || /[,;\p{Cc}]/u.test(to) || (to.match(/@/g) ?? []).length !== 1) {
        throw new Error('email: `to` must be exactly one address')
    }
    if (/[\r\n]/.test(subject)) throw new Error('email: `subject` must not contain a line break')
}
