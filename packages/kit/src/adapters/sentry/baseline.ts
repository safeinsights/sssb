import type * as Sentry from '@sentry/nextjs'

type InitOptions = NonNullable<Parameters<typeof Sentry.init>[0]>

/** The header and query-parameter names v10 scrubbed when `sendDefaultPii` was off (Sentry's v11 migration guide). */
const V10_DENIED_KEYS = ['forwarded', '-ip', 'remote-', 'via', '-user']

/**
 * What the SDK may collect, pinned to what v10 collected with `sendDefaultPii` unset (ADR-0010, addendum
 * 2026-11-17). v11 replaced `sendDefaultPii` with `dataCollection`, and an UNSET `dataCollection` now
 * collects user info, cookies, HTTP bodies, database query data, queue arguments and GenAI/MCP payloads. From
 * a multi-tenant framework that is tenant data, so every category is set here and none is left to a default.
 *
 * The block is the migration guide's "keep the v10 default behavior" block plus `mcp`: when `mcp` is left out,
 * 11.x resolves it to `{ inputs: true, outputs: true }` (`resolveDataCollectionOptions` in `@sentry/core`),
 * while v10 recorded MCP content only with `sendDefaultPii` on. `attachStacktrace: false` keeps v10's default:
 * v11 turned it on, which adds a synthetic stack trace (with source context) to `captureMessage` events.
 *
 * Widening any of this is a privacy decision, not a dependency chore: `baseline.test.ts` pins it.
 */
export const SENTRY_V10_BASELINE = {
    attachStacktrace: false,
    dataCollection: {
        userInfo: false,
        cookies: false,
        httpHeaders: { request: { deny: V10_DENIED_KEYS }, response: { deny: V10_DENIED_KEYS } },
        httpBodies: [],
        urlQueryParams: { deny: V10_DENIED_KEYS },
        genAI: { inputs: false, outputs: false },
        mcp: { inputs: false, outputs: false },
        databaseQueryData: false,
        queues: false,
        graphQL: { document: false, variables: false },
    },
} satisfies Pick<InitOptions, 'attachStacktrace' | 'dataCollection'>
