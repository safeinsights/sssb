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
    if (typeof to !== 'string' || /[,;\p{Cc}]/u.test(to) || (to.match(/@/g) ?? []).length !== 1 || !isOneAddress(to)) {
        throw new Error('email: `to` must be exactly one address')
    }
    if (/[\r\n]/.test(subject)) throw new Error('email: `subject` must not contain a line break')
}

/** An addr-spec with nothing a mailer could read as a display name, a comment or a second address around it. */
const BARE_ADDRESS = /^[^\s<>"()@]+@[^\s<>"()@]+$/

/**
 * `to` is either a bare address (`ada@example.test`) or a display name and then one bracketed bare address at its very
 * end (`Ada Lovelace <ada@example.test>`). Anything else lets the address a vendor mails differ from the one the caller
 * recorded: in `a<b@c.d>` a mailer reads the display name `a` and mails `b@c.d`, and a trailing `(…)` is a comment.
 */
function isOneAddress(to: string): boolean {
    if (BARE_ADDRESS.test(to)) return true
    const named = /^([^<>"()]*[^\s<>"()])\s+<([^<>]*)>$/.exec(to)
    return named !== null && named[1]!.trim() !== '' && BARE_ADDRESS.test(named[2]!)
}
