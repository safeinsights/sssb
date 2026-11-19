// The scheduled tick's Lambda (SssbApp's `scheduledTick`): on each run of its EventBridge schedule it reads the shared
// webhook secret and POSTs the app's cron route, `/api/webhooks/cron`, which runs SSSB's `runScheduledTick` behind
// `withWebhookSecret`, the route the dev ticker calls.
//
// It does not go through CloudFront or the Function URL. It invokes the server function directly, with the event a
// Function URL would send it (payload format 2.0, which the Lambda Web Adapter turns into the HTTP request the Next
// server sees). The direct invoke is authorized by IAM (the construct grants this function `lambda:InvokeFunction` on
// the server), and the route still demands the secret, as it does from any caller.
//
// The secret is read on every run, so rotating it needs no deploy here; it must be a plain string secret, the value
// the server's WEBHOOK_SECRET holds. The AWS SDK is the one the Node.js runtime includes, imported when the handler
// runs, so this module loads without it (packages/cdk/src/scheduled-tick.test.js drives `tick` with stand-ins).

import { Buffer } from 'node:buffer'
import console from 'node:console'
import { createRequire } from 'node:module'
import process from 'node:process'
import { TextDecoder } from 'node:util'

/** The app's cron route (the guide's dev loop; `@sssb/kit/server-lib/scheduled-tick`). */
export const CRON_PATH = '/api/webhooks/cron'
const USER_AGENT = 'sssb-scheduled-tick'

/** The function's environment, by the names the construct sets (`../../scheduled-tick.js` imports these). */
export const TICK_ENV = {
    serverFunctionName: 'SERVER_FUNCTION_NAME',
    serverHost: 'SERVER_HOST',
    webhookSecretArn: 'WEBHOOK_SECRET_ARN',
}

/**
 * The Function URL event for one POST of the cron route.
 * @param {{ secret: string, host: string, requestId: string, now: Date }} input
 */
export function cronEvent({ secret, host, requestId, now }) {
    return {
        version: '2.0',
        routeKey: '$default',
        rawPath: CRON_PATH,
        rawQueryString: '',
        headers: {
            // The secret's own header (`@sssb/kit/service-auth/webhook`'s WEBHOOK_SECRET_HEADER): the one a caller sends
            // through the public host too, where CloudFront replaces `Authorization` with its own signature.
            'x-sssb-webhook-secret': secret,
            'content-type': 'application/json',
            host,
            'user-agent': USER_AGENT,
        },
        requestContext: {
            accountId: 'anonymous',
            apiId: host.split('.')[0],
            domainName: host,
            domainPrefix: host.split('.')[0],
            http: {
                method: 'POST',
                path: CRON_PATH,
                protocol: 'HTTP/1.1',
                sourceIp: '127.0.0.1',
                userAgent: USER_AGENT,
            },
            requestId,
            routeKey: '$default',
            stage: '$default',
            time: now.toISOString(),
            timeEpoch: now.getTime(),
        },
        body: '{}',
        isBase64Encoded: false,
    }
}

/**
 * One tick: read the secret, invoke the server with the cron route's event, and throw unless the route answered 200,
 * so a refused or failed tick is a failed invocation (the Lambda's Errors metric, and its log) rather than a quiet one.
 * Returns the route's body, which holds counts and never the secret.
 * @param {{
 *   readSecret: () => Promise<string | undefined>,
 *   invoke: (payload: string) => Promise<{ FunctionError?: string, Payload?: Uint8Array }>,
 *   host: string,
 *   requestId: string,
 *   now: Date,
 * }} deps
 */
export async function tick({ readSecret, invoke, host, requestId, now }) {
    const secret = await readSecret()
    if (!secret) throw new Error('the webhook secret has no string value')
    const result = await invoke(JSON.stringify(cronEvent({ secret, host, requestId, now })))
    const text = result.Payload ? new TextDecoder().decode(result.Payload) : ''
    if (result.FunctionError) throw new Error(`the server failed the tick (${result.FunctionError}): ${text}`)
    /** @type {{ statusCode?: number, body?: string, isBase64Encoded?: boolean }} */
    const response = JSON.parse(text || '{}')
    if (response.statusCode !== 200) throw new Error(`the cron route answered ${String(response.statusCode)}`)
    return response.isBase64Encoded
        ? Buffer.from(response.body ?? '', 'base64').toString('utf8')
        : (response.body ?? '')
}

/**
 * The runtime's own AWS SDK, loaded when the handler runs (through `createRequire`), so this module loads, and its
 * test runs, where no SDK is installed. Neither this package (which ships the file and depends on no SDK) nor its type
 * check resolves it: only the Lambda runtime does.
 * @param {string} name
 * @returns {Promise<any>}
 */
const runtimeSdk = async (name) => createRequire(import.meta.url)(name)

/**
 * The Lambda entry. `sdk` and `env` are the runtime's unless a test passes stand-ins.
 * @param {unknown} _event
 * @param {{ awsRequestId: string }} context
 * @param {{ sdk?: (name: string) => Promise<any>, env?: Record<string, string | undefined> }} [overrides]
 */
export async function handler(_event, context, { sdk = runtimeSdk, env = process.env } = {}) {
    const { SecretsManagerClient, GetSecretValueCommand } = await sdk('@aws-sdk/client-secrets-manager')
    const { LambdaClient, InvokeCommand } = await sdk('@aws-sdk/client-lambda')
    const secrets = new SecretsManagerClient({})
    const lambda = new LambdaClient({})
    const body = await tick({
        readSecret: async () =>
            (await secrets.send(new GetSecretValueCommand({ SecretId: env[TICK_ENV.webhookSecretArn] }))).SecretString,
        invoke: (payload) =>
            lambda.send(new InvokeCommand({ FunctionName: env[TICK_ENV.serverFunctionName], Payload: payload })),
        host: env[TICK_ENV.serverHost] ?? '',
        requestId: context.awsRequestId,
        now: new Date(),
    })
    console.log(`scheduled tick: ${body}`)
}
