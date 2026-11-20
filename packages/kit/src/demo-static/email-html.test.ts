import { describe, expect, it } from 'vitest'
import { buildNotificationEmailHtml } from './email-html'

/** The static demo's notification email escapes its copy, as the server's react-email template does. */
describe('buildNotificationEmailHtml', () => {
    it('renders typed values as text, never as markup', () => {
        const html = buildNotificationEmailHtml({
            title: 'New invite',
            body: '<img src=x onerror=alert(1)>@example.test was invited',
            footer: 'Manage your notifications',
        })
        expect(html).not.toContain('<img')
        expect(html).toBe(
            '<h2>New invite</h2><p>&lt;img src=x onerror=alert(1)&gt;@example.test was invited</p>' +
                '<p>Manage your notifications</p>',
        )
    })
})
