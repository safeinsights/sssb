// @ts-check
// The logical ids of SssbApp's stateful resources, held to a committed snapshot (ADR-0014 part 10). CloudFormation
// knows a resource by its logical id: change one, and the next `cdk deploy` creates a new resource under the new id
// and deletes the old, which for the Aurora cluster is the database. So a change here is breaking, filed as a `minor`
// changeset, and `.github/scripts/require-changeset.sh` fails a PR that changes the snapshot without one.
//
// The snapshot is a plain JSON file compared with `toEqual`, never a Vitest snapshot: `vitest -u` rewrites those, and
// a local run writes a missing one, so a deleted or regenerated snapshot would pass. This file is changed by hand, in a
// diff a reviewer reads, with the changeset beside it.
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import * as cdk from 'aws-cdk-lib'
import { Template } from 'aws-cdk-lib/assertions'
import { beforeAll, describe, expect, it } from 'vitest'
import { makeTestTmpDir } from '../../../tests/support/tmp-dir'
import { SssbApp } from './index.js'

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const SNAPSHOT = path.join(REPO, 'packages/cdk/release-snapshots/stateful-logical-ids.json')
/**
 * The app the snapshot is synthesized from: the starter, the deployment an adopter's app starts as, but with
 * `params.ports` left out, so every optional port is at its default and storage (`s3`) has its bucket. The starter
 * itself declares `storage: 'none'`; `sssb-app.test.js` checks that shape against this snapshot, every id but the
 * bucket's.
 */
const APP_DIR = path.join(REPO, 'apps/starter')

/**
 * The resource types whose replacement loses data or identity. A resource of one of these types is in the snapshot
 * whatever its policies say.
 *
 * What SssbApp creates today:
 * - `AWS::RDS::DBCluster`: the database. Its storage is the cluster's, so a new cluster is an empty database.
 * - `AWS::RDS::DBInstance`: Aurora's writer. It holds no data of its own (the cluster volume does), but a new one is
 *   an outage while it is created (the server connects through the cluster's endpoint, which stays).
 * - `AWS::RDS::DBSubnetGroup`: a new one has a new name, and the cluster names it in `DBSubnetGroupName`, a property
 *   CloudFormation's `AWS::RDS::DBCluster` reference lists as "Update requires: Replacement". Replacing the subnet
 *   group would replace the cluster.
 * - `AWS::SecretsManager::Secret`: the cluster's master credentials. A new secret is a new password and a new ARN,
 *   which the deployment's environment and any grant an operator wrote name.
 * - `AWS::S3::Bucket`: the app's object storage (`StorageBucket`, unless `params.ports.storage` is `none`) and the
 *   CDN's assets (`AssetsBucket`). A new bucket
 *   is an empty one under another name.
 *
 * Not created today, listed so that one added later is snapshotted the day it lands:
 * - `AWS::KMS::Key`: a new key cannot decrypt what the old one encrypted.
 * - `AWS::DynamoDB::Table`, `AWS::EFS::FileSystem`: they hold data.
 * - `AWS::Cognito::UserPool`: it holds the users, and their ids.
 * - `AWS::Logs::LogGroup`: a new one starts empty, and its retention says the history mattered.
 *
 * The database's network: `AWS::EC2::VPC`, `AWS::EC2::Subnet` and `AWS::EC2::SecurityGroup`. They hold no data, but
 * the cluster lives in them: a new VPC or subnet means a new subnet group for the cluster, and its
 * `DBSubnetGroupName` requires replacement (above), so a changed network id replaces the database too.
 *
 * Left out: the rest of the network (route tables, NAT, endpoints), the Lambdas and their roles, CloudFront, the
 * alarms and the budget. Replacing them loses nothing and moves nothing stateful: the next deploy creates them again.
 *
 * Any other resource whose DeletionPolicy or UpdateReplacePolicy keeps it (`Retain`, `RetainExceptOnCreate`,
 * `Snapshot`) is in the snapshot too: whoever wrote the policy said it holds something worth keeping.
 */
const STATEFUL_TYPES = [
    'AWS::RDS::DBCluster',
    'AWS::RDS::DBInstance',
    'AWS::RDS::DBSubnetGroup',
    'AWS::SecretsManager::Secret',
    'AWS::S3::Bucket',
    'AWS::KMS::Key',
    'AWS::DynamoDB::Table',
    'AWS::EFS::FileSystem',
    'AWS::Cognito::UserPool',
    'AWS::Logs::LogGroup',
    'AWS::EC2::VPC',
    'AWS::EC2::Subnet',
    'AWS::EC2::SecurityGroup',
]
const KEEPING_POLICIES = ['Retain', 'RetainExceptOnCreate', 'Snapshot']

/** The shapes an app can deploy: each transport, as a staging (`production: false`) and a production deployment. */
const SHAPES = /** @type {const} */ ([
    ['pg', false],
    ['pg', true],
    ['data-api', false],
    ['data-api', true],
])

/** What the snapshot file says it is, so that a reader of its diff needs nothing else. */
const COMMENT =
    "SssbApp's stateful resources (logical id: type), per deployment shape, from " +
    'packages/cdk/src/stateful-logical-ids.test.js. A changed logical id replaces the resource on the next cdk deploy: ' +
    "change this file only with a 'minor' changeset (ADR-0014 part 10; .github/scripts/require-changeset.sh)."

/**
 * The stateful resources of one shape, by logical id, as an adopter's stack holds them: SssbApp under the id
 * `Default`, which CDK leaves out of every logical id under it (the starter's `infra/app.ts`).
 * @param {'pg' | 'data-api'} transport
 * @param {boolean} production
 */
function statefulResources(transport, production) {
    const app = new cdk.App({ outdir: makeTestTmpDir('sssb-cdk-'), context: { 'aws:cdk:bundling-stacks': [] } })
    const stack = new cdk.Stack(app, 'Snapshot')
    new SssbApp(stack, 'Default', {
        appDir: APP_DIR,
        slug: /** @type {string} */ (
            /export const APP_SLUG = '([^']+)'/.exec(readFileSync(path.join(APP_DIR, 'config/app.ts'), 'utf8'))?.[1]
        ),
        params: { database: { transport } },
        environment: production ? 'Production' : 'Staging',
        production,
    })
    const resources =
        /** @type {Record<string, { Type: string, DeletionPolicy?: string, UpdateReplacePolicy?: string }>} */ (
            Template.fromStack(stack).toJSON()['Resources']
        )
    /** @type {Record<string, string>} */
    const stateful = {}
    for (const id of Object.keys(resources).sort()) {
        const r = /** @type {(typeof resources)[string]} */ (resources[id])
        const kept = [r.DeletionPolicy, r.UpdateReplacePolicy].some((p) => KEEPING_POLICIES.includes(p ?? ''))
        if (STATEFUL_TYPES.includes(r.Type) || kept) stateful[id] = r.Type
    }
    return stateful
}

describe("SssbApp's stateful logical ids", () => {
    /** Each shape's stateful resources, keyed as the snapshot keys them. */
    /** @type {Map<string, Record<string, string>>} */
    const synthesized = new Map()
    beforeAll(() => {
        for (const [transport, production] of SHAPES) {
            synthesized.set(`${transport}${production ? ', production' : ''}`, statefulResources(transport, production))
        }
    })

    it('are the committed snapshot: a change is a minor changeset', () => {
        const actual = { $comment: COMMENT, ...Object.fromEntries(synthesized) }
        const committed = JSON.parse(readFileSync(SNAPSHOT, 'utf8'))
        expect(
            actual,
            `${path.relative(REPO, SNAPSHOT)} differs from what SssbApp synthesizes. If the change is meant, it ` +
                "replaces those resources on every adopter's next deploy: write this into the file and add a 'minor' " +
                `changeset that says so (Kind operator, Action required):\n${JSON.stringify(actual, null, 4)}\n`,
        ).toEqual(committed)
    })

    it('include the database, its writer, its subnet group, its secret and both buckets on every shape', () => {
        // The snapshot is only as good as the classification: an empty or partial one would pass the comparison.
        for (const [shape, stateful] of synthesized) {
            expect(Object.values(stateful).sort(), shape).toEqual(
                expect.arrayContaining([
                    'AWS::RDS::DBCluster',
                    'AWS::RDS::DBInstance',
                    'AWS::RDS::DBSubnetGroup',
                    'AWS::S3::Bucket',
                    'AWS::S3::Bucket',
                    'AWS::SecretsManager::Secret',
                ]),
            )
        }
    })
})
