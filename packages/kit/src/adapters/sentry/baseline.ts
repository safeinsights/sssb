import type * as Sentry from '@sentry/nextjs'

type InitOptions = NonNullable<Parameters<typeof Sentry.init>[0]>
type Integration = { name: string }

/** The header and query-parameter names v10 scrubbed when `sendDefaultPii` was off (Sentry's v11 migration guide). */
const V10_DENIED_KEYS = ['forwarded', '-ip', 'remote-', 'via', '-user']

/**
 * Default integrations that 11.x adds and 10.x did not have, which no `dataCollection` key gates:
 * - `Aws`: a span per AWS SDK command, with the service, command, region and request id, plus S3 bucket names
 *   and Secrets Manager secret ARNs.
 * - `AwsLambdaWeb`: Lambda runtime context on events and segment spans.
 * - `NextjsUseCache`: spans for `'use cache'` with the cache tags verbatim, which an app may build from tenant ids.
 * Names are each integration's `INTEGRATION_NAME` in the 11.12 source (`@sentry/server-utils`, `@sentry/node`,
 * `@sentry/nextjs`).
 */
const V11_ONLY_DEFAULT_INTEGRATIONS = ['Aws', 'AwsLambdaWeb', 'NextjsUseCache']

function withoutV11OnlyDefaults<T extends Integration>(defaults: T[]): T[] {
    return defaults.filter((integration) => !V11_ONLY_DEFAULT_INTEGRATIONS.includes(integration.name))
}

/**
 * What the SDK may collect, held at or below what v10 collected with `sendDefaultPii` unset (ADR-0010, addendum
 * 2026-11-17). v11 replaced `sendDefaultPii` with `dataCollection`, and an UNSET `dataCollection` now
 * collects user info, cookies, HTTP bodies, database query data, queue arguments and GenAI/MCP payloads. From
 * a multi-tenant framework that is tenant data, so every `dataCollection` key is set here and none is left to a
 * default.
 *
 * Starts from the migration guide's "keep the v10 default behavior" block, which is stricter than 10.78's own
 * unset mapping (`defaultPiiToCollectionOptions(false)` in `@sentry/core` 10.78) on `cookies` and `graphQL`,
 * and adds what that block leaves to a default:
 * - `mcp`: 11.x resolves an omitted `mcp` to `{ inputs: true, outputs: true }` (`resolveDataCollectionOptions`).
 * - `stackFrameVariables: false`: capture also needs `includeLocalVariables`, unset here, so this only pins it.
 * - `frameContextLines: 5`: the 11.x default, fewer than v10's 7.
 * - `attachStacktrace: false`: v10's default; v11 turned it on, which adds a synthetic stack trace with source
 *   context to `captureMessage` events.
 * - `integrations`: drops the v11-only default integrations listed above.
 *
 * Widening any of this is a privacy decision, not a dependency chore: `baseline.test.ts` pins it.
 */
export const SENTRY_V10_BASELINE = {
    attachStacktrace: false,
    integrations: withoutV11OnlyDefaults,
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
        stackFrameVariables: false,
        frameContextLines: 5,
    },
} satisfies Pick<InitOptions, 'attachStacktrace' | 'dataCollection' | 'integrations'>
