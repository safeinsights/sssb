import type * as Sentry from '@sentry/nextjs'

type InitOptions = NonNullable<Parameters<typeof Sentry.init>[0]>
type Integration = { name: string }

/** 10.78's `PII_HEADER_SNIPPETS` (`@sentry/core`), the denylist its `sendDefaultPii`-off mapping used. */
const V10_DENIED_KEYS = ['forwarded', '-ip', 'remote-', 'via', '-user']

/**
 * The default integrations 10.78 installed, by `name`, on the three runtimes `@sentry/nextjs` inits: Node
 * (`@sentry/node` `getDefaultIntegrations` with tracing on), edge (`@sentry/vercel-edge`) and the browser
 * (`@sentry/browser`), plus what nextjs's own inits pushed: `DistDirRewriteFrames` (server and edge), and
 * `BrowserTracing` and `NextjsClientStackFrameNormalization` (browser).
 */
const V10_DEFAULT_INTEGRATIONS = [
    // Node
    ...['Amqplib', 'Anthropic_AI', 'ChildProcess', 'Connect', 'Console', 'Context', 'ContextLines'],
    ...['ConversationId', 'Express', 'Fastify', 'Firebase', 'FunctionToString', 'GenericPool', 'Google_GenAI'],
    ...['Graphql', 'Hapi', 'Hono', 'Http', 'InboundFilters', 'Kafka', 'Koa', 'LangChain', 'LangGraph'],
    ...['LinkedErrors', 'LocalVariablesAsync', 'LruMemoizer', 'Modules', 'Mongo', 'Mongoose', 'Mysql', 'Mysql2'],
    ...['NodeFetch', 'NodeSystemError', 'OnUncaughtException', 'OnUnhandledRejection', 'OpenAI', 'Postgres'],
    ...['PostgresJs', 'Prisma', 'ProcessSession', 'Redis', 'RequestData', 'Tedious', 'VercelAI'],
    'DistDirRewriteFrames',
    // Edge, beyond the Node names
    ...['Dedupe', 'WinterCGFetch'],
    // Browser, beyond the names above
    ...['Breadcrumbs', 'BrowserApiErrors', 'BrowserSession', 'CultureContext', 'GlobalHandlers', 'HttpContext'],
    ...['BrowserTracing', 'NextjsClientStackFrameNormalization'],
]

/**
 * 11.x successors to a 10.78 default: `EventFilters` is `InboundFilters` renamed, and `WorkerThreads` is the
 * worker-thread half of v10's `ChildProcess`. (The browser's new `Console` is the console-breadcrumb half of
 * `Breadcrumbs` and keeps the name Node already had.)
 */
const V11_SUCCESSORS = ['EventFilters', 'WorkerThreads']

const ALLOWED_DEFAULT_INTEGRATIONS = new Set([...V10_DEFAULT_INTEGRATIONS, ...V11_SUCCESSORS])

/**
 * An ALLOWLIST, so a default integration that 11.x (or any later 11.x) adds is dropped until someone decides
 * otherwise. 11.12 adds, on Node: `Aws` (a span per AWS SDK command, with S3 bucket names and Secrets Manager
 * ARNs), `AwsLambdaWeb` (Lambda context), `Dataloader` (cache keys verbatim), `Knex`, `Neon`, `Nitro`,
 * `Mastra`, `PiDurable`, `McpServer` and four AI clients (`Groq`, `Mistral`, `TogetherAI`, `TypeSafe`); and on the
 * Next.js server, `NextjsUseCache` (`'use cache'` tags verbatim). Several of them attach metadata that no
 * `dataCollection` key gates; the rest are dropped too, because an allowlist does not judge.
 * `default-integrations.test.ts` lists what this drops from the installed SDK's real defaults.
 */
function withV10DefaultsOnly<T extends Integration>(defaults: T[]): T[] {
    return defaults.filter((integration) => ALLOWED_DEFAULT_INTEGRATIONS.has(integration.name))
}

/**
 * What the SDK may collect, held at or below what v10 collected with `sendDefaultPii` unset (ADR-0010, addendum
 * 2026-11-17). v11 replaced `sendDefaultPii` with `dataCollection`, and an UNSET `dataCollection` now
 * collects user info, cookies, HTTP bodies, database query data, queue arguments and GenAI/MCP payloads. From
 * a multi-tenant framework that is tenant data, so every `dataCollection` key is set here and none is left to a
 * default.
 *
 * Starts from the migration guide's "keep the v10 default behavior" block, which is stricter than 10.78's own
 * unset mapping (`defaultPiiToCollectionOptions(false)` in `@sentry/core` 10.78) on `cookies` and `graphQL`, and in
 * practice on `httpBodies` (10.78's Node HTTP integration attached incoming request bodies to error events
 * regardless), and adds what that block leaves to a default:
 * - `mcp`: 11.x resolves an omitted `mcp` to `{ inputs: true, outputs: true }` (`resolveDataCollectionOptions`).
 * - `stackFrameVariables: false`: capture also needs `includeLocalVariables`, unset here, so this only pins it.
 * - `frameContextLines: 5`: the 11.x default, fewer than v10's 7.
 * - `attachStacktrace: false`: v10's default; v11 turned it on, which adds a synthetic stack trace with source
 *   context to `captureMessage` events.
 * - `integrations`: keeps only the default integrations v10 had (or their renamed successors), above.
 *
 * Widening any of this is a privacy decision, not a dependency chore: `baseline.test.ts` pins it.
 */
export const SENTRY_V10_BASELINE = {
    attachStacktrace: false,
    integrations: withV10DefaultsOnly,
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
