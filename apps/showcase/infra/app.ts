import path from 'node:path'
import { SssbApp } from '@sssb/cdk'
import * as cdk from 'aws-cdk-lib'
import { APP_SLUG } from '../config/app'
import { params } from '../config/params'
import { addTags, TAGS } from './lib/tags'

/**
 * This app's deployment (ADR-0014, D8): one stack holding SSSB's `SssbApp` construct, built from this app's
 * own directory and `config/params.ts`. Environment-agnostic until cutover (`cloud-accounts`) fills
 * config/params.ts — no account/region is bound, so `pnpm synth` runs offline with zero credentials.
 *
 * The stack is yours: add your own constructs beside `SssbApp`, or move it into a stack your organisation's
 * infrastructure already has.
 */
const ENVIRONMENTS = ['Staging', 'Production'] as const
type Environment = (typeof ENVIRONMENTS)[number]

const app = new cdk.App()

const environment = app.node.tryGetContext('environment') as Environment | undefined
if (!environment || !ENVIRONMENTS.includes(environment)) {
    throw new Error(`context "environment" must be one of ${ENVIRONMENTS.join(', ')}`)
}

// Stack id derives from the app slug (capitalized) so two apps in one AWS account never collide.
const stackId = `${APP_SLUG.charAt(0).toUpperCase()}${APP_SLUG.slice(1)}AppStack`

const stack = new cdk.Stack(app, stackId, {
    description: `${APP_SLUG} application stack (Next standalone on Lambda via Web Adapter, ADR-0001)`,
})
addTags(stack, { ...TAGS, Environment: environment })

// The id `Default` is left out of every logical id under it, so the resources keep the ids they had when
// they were this stack's own children (before ADR-0014's P9) and a deployed stack updates in place. A second
// SssbApp in the same stack needs an id of its own.
new SssbApp(stack, 'Default', {
    appDir: path.join(__dirname, '..'),
    slug: APP_SLUG,
    params,
    environment,
    production: environment === 'Production',
})

app.synth()
