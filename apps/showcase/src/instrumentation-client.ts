const dsn = process.env.NEXT_PUBLIC_SENTRY_DSN

if (dsn) {
    void import('@sssb/kit/adapters/sentry/client').then(({ initClientSentry }) => initClientSentry())
}

export function onRouterTransitionStart(href: string, navigationType: string): void {
    if (!dsn) return
    void import('@sssb/kit/adapters/sentry/client').then(({ forwardRouterTransition }) =>
        forwardRouterTransition(href, navigationType),
    )
}
