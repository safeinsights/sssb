// @ts-check
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import * as cdk from 'aws-cdk-lib'

const { aws_events, aws_events_targets, aws_lambda } = cdk

const HERE = path.dirname(fileURLToPath(import.meta.url))

/** How often the tick runs when `scheduledTick.every` is left out. */
const DEFAULT_TICK = cdk.Duration.minutes(5)

/**
 * SssbApp's scheduled tick: an EventBridge rule that runs a small function on a fixed rate, which reads the webhook
 * secret and invokes the server with a POST of the app's cron route (`assets/scheduled-tick/index.mjs` says how). The
 * route drains the due job schedules and the due webhook deliveries (SSSB's `runScheduledTick`), so this is what runs
 * an app's scheduled work in a deployment, with any job runner: the in-process one needs nothing else.
 *
 * The function runs outside any VPC (it calls the Lambda and Secrets Manager APIs, nothing in the VPC) and may read
 * that one secret and invoke that one function. A failed tick is not retried: the next one runs on schedule,
 * and the route's work is idempotent across ticks (a schedule's spawn is claimed in its own transaction).
 *
 * @param {import('constructs').Construct} scope
 * @param {{
 *   server: cdk.aws_lambda.Function,
 *   functionUrl: cdk.aws_lambda.FunctionUrl,
 *   webhookSecret: cdk.aws_secretsmanager.ISecret,
 *   every?: cdk.Duration | undefined,
 * }} options
 */
export function addScheduledTick(scope, { server, functionUrl, webhookSecret, every = DEFAULT_TICK }) {
    // Whole minutes, at least one: EventBridge's rate. A fraction would otherwise surface only at deploy.
    const minutes = every.toMinutes({ integral: false })
    if (!Number.isInteger(minutes) || minutes < 1) {
        throw new Error(`SssbApp: scheduledTick.every must be a whole number of minutes, at least 1 (got ${every})`)
    }
    const ticker = new aws_lambda.Function(scope, 'ScheduledTick', {
        description: "Ticks the app's cron route (/api/webhooks/cron) with the shared webhook secret",
        runtime: aws_lambda.Runtime.NODEJS_22_X,
        architecture: aws_lambda.Architecture.ARM_64,
        code: aws_lambda.Code.fromAsset(path.join(HERE, 'assets/scheduled-tick')),
        handler: 'index.handler',
        memorySize: 256,
        // Longer than the server's 30 seconds, so a slow tick is cut short by the server's own timeout, never this one.
        timeout: cdk.Duration.minutes(1),
        environment: {
            SERVER_FUNCTION_NAME: server.functionName,
            // The Function URL's host (`https://<host>/`): the request's Host, as the server would see it at its URL.
            SERVER_HOST: cdk.Fn.select(2, cdk.Fn.split('/', functionUrl.url)),
            WEBHOOK_SECRET_ARN: webhookSecret.secretArn,
        },
    })
    webhookSecret.grantRead(ticker)
    server.grantInvoke(ticker)
    const rule = new aws_events.Rule(scope, 'ScheduledTickRule', {
        description: "Runs the app's scheduled work: SSSB's scheduled tick",
        schedule: aws_events.Schedule.rate(every),
        targets: [new aws_events_targets.LambdaFunction(ticker, { retryAttempts: 0 })],
    })
    return { ticker, rule }
}
