import type { MessageTree } from '@sssb/kit/i18n/messages'

/**
 * The APP's i18n registration (the seam side of @sssb/kit/i18n/namespaces.ts, ADR-0012). The catalogs are
 * physically split: the framework owns FRAMEWORK_NAMESPACES in `@sssb/kit/i18n/messages/*.json`;
 * this app owns APP_NAMESPACES in its own `messages/*.json`. Together they partition the merged catalog
 * (disjoint + exhaustive), enforced by the conformance suite's `i18n-partition` check (@sssb/kit/testing), which
 * this app runs against these registrations from src/sssb.conformance.test.ts.
 */
export const APP_NAMESPACES = ['welcome', 'dashboard', 'items'] as const

/**
 * The app's catalog for one locale. Framework code (the next-intl request config, the parity tests)
 * reaches the app's messages ONLY through this loader — the seam's one message door.
 */
export async function loadAppMessages(locale: string): Promise<MessageTree> {
    return (await import(`../../messages/${locale}.json`)).default as MessageTree
}
