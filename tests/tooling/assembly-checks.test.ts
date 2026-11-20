import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
    dataApiShapeProblems,
    failClosedEnvironmentProblems,
    lambdaBundles,
    lambdaFunction,
    migratorBundleProblems,
    secretGrantProblems,
    type Resources,
} from '@sssb/tools/assembly-checks'
import { makeTestTmpDir } from '../support/tmp-dir'

const BASIC = 'arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole'
const ref = (id: string) => ({ Ref: id })

type Statement = Record<string, unknown>

/** A Data API template: cluster, its secret and attachment, a role with the given statements, a locked group. */
function template(
    statements: Statement[],
    extra: Resources = {},
    managed: unknown[] = [{ 'Fn::Join': ['', ['arn:', BASIC]] }],
): Resources {
    return {
        Cluster: { Type: 'AWS::RDS::DBCluster', Properties: { VpcSecurityGroupIds: [ref('DbSg')] } },
        DbSg: { Type: 'AWS::EC2::SecurityGroup', Properties: {} },
        Secret: { Type: 'AWS::SecretsManager::Secret' },
        Attach: {
            Type: 'AWS::SecretsManager::SecretTargetAttachment',
            Properties: { TargetId: ref('Cluster'), SecretId: ref('Secret') },
        },
        Role: { Type: 'AWS::IAM::Role', Properties: { ManagedPolicyArns: managed } },
        Policy: { Type: 'AWS::IAM::Policy', Properties: { PolicyDocument: { Statement: statements } } },
        ...extra,
    }
}

const goodStatements: Statement[] = [
    { Effect: 'Allow', Action: 'rds-data:ExecuteStatement', Resource: ref('Cluster') },
    { Effect: 'Allow', Action: 'secretsmanager:GetSecretValue', Resource: ref('Secret') },
]

describe('dataApiShapeProblems', () => {
    it('passes a well-formed Data API template', () => {
        expect(dataApiShapeProblems(template(goodStatements))).toEqual([])
    })

    it('throws when there is no cluster', () => {
        expect(() => dataApiShapeProblems({})).toThrow(/DBCluster/)
    })

    it.each([
        ['a wildcard resource', { Effect: 'Allow', Action: 'rds-data:*', Resource: '*' }],
        ['a wildcard action pattern', { Effect: 'Allow', Action: 'rds*:Execute*', Resource: '*' }],
        ['a NotAction grant', { Effect: 'Allow', NotAction: 'iam:*', Resource: '*' }],
        ['another resource', { Effect: 'Allow', Action: 'rds-data:ExecuteStatement', Resource: ref('Other') }],
    ])('fails %s', (_, statement) => {
        const problems = dataApiShapeProblems(template([...goodStatements, statement]))
        expect(problems).toContain('every rds-data grant is scoped to this cluster alone')
    })

    it('fails when no role is granted ExecuteStatement', () => {
        const problems = dataApiShapeProblems(template([goodStatements[1]!]))
        expect(problems).toContain('a role is granted rds-data:ExecuteStatement')
    })

    it('fails an ingress rule on the database group, as its own resource', () => {
        const t = template(goodStatements, {
            In: { Type: 'AWS::EC2::SecurityGroupIngress', Properties: { GroupId: ref('DbSg') } },
        })
        expect(dataApiShapeProblems(t)).toContain('the database security group admits no inbound traffic')
    })

    it('fails an ingress rule inline on the database group', () => {
        const t = template(goodStatements, {
            DbSg: { Type: 'AWS::EC2::SecurityGroup', Properties: { SecurityGroupIngress: [{ IpProtocol: 'tcp' }] } },
        })
        expect(dataApiShapeProblems(t)).toContain('the database security group admits no inbound traffic')
    })

    it('ignores ingress on some other group', () => {
        const t = template(goodStatements, {
            In: { Type: 'AWS::EC2::SecurityGroupIngress', Properties: { GroupId: ref('Elsewhere') } },
        })
        expect(dataApiShapeProblems(t)).toEqual([])
    })

    it('includes the Secrets Manager checks', () => {
        const t = template([
            goodStatements[0]!,
            { Effect: 'Allow', Action: 'secretsmanager:*', Resource: ref('Other') },
        ])
        expect(dataApiShapeProblems(t)).toContain('every Secrets Manager grant names the cluster’s own secret alone')
    })
})

// A grant can sit in any IAM resource that carries a policy, not only the AWS::IAM::Policy SSSB's construct emits: an
// adopter's CfnRolePolicy, or a user or a group beside the app's stack, is the wider grant the check exists to catch.
describe('a grant carried by another IAM resource type', () => {
    const doc = (statement: Statement) => ({ Statement: [statement] })
    const carriers = (statement: Statement): [string, Resources][] => [
        [
            'a RolePolicy',
            {
                Bad: {
                    Type: 'AWS::IAM::RolePolicy',
                    Properties: { RoleName: 'r', PolicyName: 'p', PolicyDocument: doc(statement) },
                },
            },
        ],
        [
            'a UserPolicy',
            {
                Bad: {
                    Type: 'AWS::IAM::UserPolicy',
                    Properties: { UserName: 'u', PolicyName: 'p', PolicyDocument: doc(statement) },
                },
            },
        ],
        [
            'a GroupPolicy',
            {
                Bad: {
                    Type: 'AWS::IAM::GroupPolicy',
                    Properties: { GroupName: 'g', PolicyName: 'p', PolicyDocument: doc(statement) },
                },
            },
        ],
        [
            'a User inline policy',
            {
                Bad: {
                    Type: 'AWS::IAM::User',
                    Properties: { Policies: [{ PolicyName: 'p', PolicyDocument: doc(statement) }] },
                },
            },
        ],
        [
            'a Group inline policy',
            {
                Bad: {
                    Type: 'AWS::IAM::Group',
                    Properties: { Policies: [{ PolicyName: 'p', PolicyDocument: doc(statement) }] },
                },
            },
        ],
    ]

    it.each(carriers({ Effect: 'Allow', Action: 'secretsmanager:*', Resource: '*' }))(
        'is read in %s, for Secrets Manager',
        (_, extra) => {
            expect(secretGrantProblems(template(goodStatements, extra))).toEqual([
                'every Secrets Manager grant names the cluster’s own secret alone',
            ])
        },
    )

    it.each(carriers({ Effect: 'Allow', Action: 'rds-data:*', Resource: '*' }))(
        'is read in %s, for the Data API',
        (_, extra) => {
            expect(dataApiShapeProblems(template(goodStatements, extra))).toEqual([
                'every rds-data grant is scoped to this cluster alone',
            ])
        },
    )

    it.each(['AWS::IAM::User', 'AWS::IAM::Group'])('a %s attaching an AWS-managed policy is unreadable', (type) => {
        const t = template(goodStatements, {
            Bad: { Type: type, Properties: { ManagedPolicyArns: ['arn:aws:iam::aws:policy/AdministratorAccess'] } },
        })
        expect(secretGrantProblems(t)).toEqual([
            'no role, user or group attaches an AWS-managed policy the check cannot read: Bad: "arn:aws:iam::aws:policy/AdministratorAccess"',
        ])
    })

    it('fails closed on an IAM type it does not read', () => {
        const t = template(goodStatements, { Odd: { Type: 'AWS::IAM::SomethingNew', Properties: {} } })
        expect(secretGrantProblems(t)).toEqual([
            'no IAM resource is of a type this check does not read: Odd (AWS::IAM::SomethingNew)',
        ])
    })

    it.each([
        'AWS::IAM::InstanceProfile',
        'AWS::IAM::OIDCProvider',
        'AWS::IAM::SAMLProvider',
        'AWS::IAM::ServiceLinkedRole',
        'AWS::IAM::ServerCertificate',
        'AWS::IAM::VirtualMFADevice',
        'AWS::IAM::AccessKey',
        'AWS::IAM::UserToGroupAddition',
    ])('lets %s through: it grants nothing', (type) => {
        expect(dataApiShapeProblems(template(goodStatements, { Quiet: { Type: type, Properties: {} } }))).toEqual([])
    })

    it('reads a ? in a granted resource as the wildcard IAM reads it', () => {
        // the secret's own ARN with a `?` after it matches a secret named one character longer
        const widened = { 'Fn::Join': ['', [ref('Secret'), '?']] }
        const statement = { Effect: 'Allow', Action: 'secretsmanager:GetSecretValue', Resource: widened }
        expect(secretGrantProblems(template([goodStatements[0]!, statement]))).toEqual([
            'every Secrets Manager grant names the cluster’s own secret alone',
        ])
    })
})

// A resource policy on the secret grants with no IAM resource at all: `Principal: "*"` with GetSecretValue is the
// database's credentials for anyone. Only the roles the stack's own functions run as may be named there.
describe("a resource policy on the cluster's secret", () => {
    const PROBLEM =
        'no resource policy on the cluster’s secret lets in any principal but the stack’s own functions’ roles: Open'
    const fn: Resources = {
        Server: { Type: 'AWS::Lambda::Function', Properties: { Role: { 'Fn::GetAtt': ['Role', 'Arn'] } } },
        Stray: { Type: 'AWS::IAM::Role', Properties: {} },
        Other: { Type: 'AWS::SecretsManager::Secret' },
    }
    const open = (principal: Record<string, unknown>, secret: unknown = ref('Secret'), effect = 'Allow') =>
        template(goodStatements, {
            ...fn,
            Open: {
                Type: 'AWS::SecretsManager::ResourcePolicy',
                Properties: {
                    SecretId: secret,
                    ResourcePolicy: {
                        Statement: [
                            { Effect: effect, Action: 'secretsmanager:GetSecretValue', Resource: '*', ...principal },
                        ],
                    },
                },
            },
        })
    const own = { 'Fn::GetAtt': ['Role', 'Arn'] }

    it.each([
        ['anyone', { Principal: '*' }],
        ['any AWS principal', { Principal: { AWS: '*' } }],
        ['an account', { Principal: { AWS: 'arn:aws:iam::111122223333:root' } }],
        ['a service', { Principal: { Service: 'lambda.amazonaws.com' } }],
        ['everyone but a role', { NotPrincipal: { AWS: own } }],
        ['a role no function runs as', { Principal: { AWS: { 'Fn::GetAtt': ['Stray', 'Arn'] } } }],
        ['an own role beside anyone', { Principal: { AWS: [own, '*'] } }],
        ['an own role with a second intrinsic beside it', { Principal: { AWS: { ...own, 'Fn::Sub': '*' } } }],
    ])('fails one that lets in %s', (_, principal) => {
        expect(secretGrantProblems(open(principal))).toEqual([PROBLEM])
    })

    it('fails one on a secret it cannot tell is another, by ARN', () => {
        const arn = 'arn:aws:secretsmanager:us-east-1:111122223333:secret:db-AbCdEf'
        expect(secretGrantProblems(open({ Principal: '*' }, arn))).toEqual([PROBLEM])
    })

    it("passes one that names only a role the stack's own functions run as, and a Deny", () => {
        expect(secretGrantProblems(open({ Principal: { AWS: own } }))).toEqual([])
        expect(secretGrantProblems(open({ Principal: { AWS: [own] } }))).toEqual([])
        expect(secretGrantProblems(open({ Principal: '*' }, ref('Secret'), 'Deny'))).toEqual([])
    })

    it("leaves a resource policy on another secret of the stack to that secret's owner", () => {
        expect(secretGrantProblems(open({ Principal: '*' }, ref('Other')))).toEqual([])
    })
})

describe('secretGrantProblems', () => {
    it('passes grants naming the cluster’s own secret, or its attachment', () => {
        expect(secretGrantProblems(template(goodStatements))).toEqual([])
        const viaAttachment = [{ Effect: 'Allow', Action: 'secretsmanager:GetSecretValue', Resource: ref('Attach') }]
        expect(secretGrantProblems(template(viaAttachment))).toEqual([])
    })

    it.each([
        ['another secret', { Effect: 'Allow', Action: 'secretsmanager:GetSecretValue', Resource: ref('Other') }],
        ['a wildcard', { Effect: 'Allow', Action: 'secretsmanager:GetSecretValue', Resource: '*' }],
        ['a NotAction grant', { Effect: 'Allow', NotAction: 'iam:*', Resource: ref('Other') }],
    ])('fails %s', (_, statement) => {
        expect(secretGrantProblems(template([statement]))).toHaveLength(1)
    })

    it('fails when nothing grants the secret at all', () => {
        expect(secretGrantProblems(template([]))).toHaveLength(1)
    })

    it('does not count a Deny statement', () => {
        const t = template([...goodStatements, { Effect: 'Deny', Action: '*', Resource: '*' }])
        expect(secretGrantProblems(t)).toEqual([])
    })

    it('fails an AWS-managed policy the check cannot read', () => {
        const t = template(goodStatements, {}, ['arn:aws:iam::aws:policy/AdministratorAccess'])
        expect(secretGrantProblems(t)[0]).toContain(
            'no role, user or group attaches an AWS-managed policy the check cannot read',
        )
    })

    it('allows a managed policy defined in the stack, and reads its grants', () => {
        const t = template(goodStatements, {
            Managed: {
                Type: 'AWS::IAM::ManagedPolicy',
                Properties: { PolicyDocument: { Statement: [{ Effect: 'Allow', Action: '*', Resource: '*' }] } },
            },
            Role: { Type: 'AWS::IAM::Role', Properties: { ManagedPolicyArns: [ref('Managed')] } },
        })
        // Readable, so not "unreadable" — but its wildcard grant is read and fails the secret check.
        const problems = secretGrantProblems(t)
        expect(problems).toEqual(['every Secrets Manager grant names the cluster’s own secret alone'])
    })

    it('reads a role’s inline policies', () => {
        const t = template(goodStatements, {
            Role: {
                Type: 'AWS::IAM::Role',
                Properties: {
                    Policies: [{ PolicyDocument: { Statement: [{ Effect: 'Allow', Action: '*', Resource: '*' }] } }],
                },
            },
        })
        expect(secretGrantProblems(t)).toHaveLength(1)
    })
})

describe('failClosedEnvironmentProblems', () => {
    it('passes APP_MODE real with no demo or e2e switch', () => {
        expect(failClosedEnvironmentProblems({ APP_MODE: 'real', PORT: '3000' })).toEqual([])
    })

    it.each([[{}], [{ APP_MODE: 'simulated' }], [{ APP_MODE: 'REAL' }]])('fails APP_MODE %j', (env) => {
        expect(failClosedEnvironmentProblems(env)).toHaveLength(1)
    })

    it.each([['DEMO_MODE'], ['E2E_BUILD']])('fails %s present, whatever its value', (name) => {
        for (const value of ['1', 'false', '', undefined]) {
            expect(failClosedEnvironmentProblems({ APP_MODE: 'real', [name]: value })).toEqual([
                `${name} is set in the final environment`,
            ])
        }
    })
})

describe('migratorBundleProblems', () => {
    const sources = ['packages/kit/src/db/migrations/index.ts', 'apps/x/src/app-config/db/migrations/index.ts']
    const migrations = ['1001_tickets']
    const good = `// ${sources[0]}\nfoo\n// ${sources[1]}\n"1001_tickets": up\n`

    it('passes a bundle with the sources and migrations', () => {
        expect(migratorBundleProblems({ code: good, sources, migrations })).toEqual([])
    })

    it('fails when there is no bundle', () => {
        expect(migratorBundleProblems({ code: undefined, sources, migrations })).toHaveLength(1)
    })

    it('fails a source comment that is missing (as a minified bundle would)', () => {
        const problems = migratorBundleProblems({ code: good.replace(`// ${sources[1]}\n`, ''), sources, migrations })
        expect(problems).toHaveLength(1)
        expect(problems[0]).toContain(sources[1])
    })

    it('fails a missing migration', () => {
        const problems = migratorBundleProblems({ code: good, sources, migrations: ['1001_tickets', '1002_other'] })
        expect(problems).toHaveLength(1)
        expect(problems[0]).toContain('1002_other')
    })

    it('fails code from test-fixture', () => {
        const problems = migratorBundleProblems({
            code: `${good}// packages/kit/test-fixture/x.ts\n`,
            sources,
            migrations,
        })
        expect(problems).toHaveLength(1)
        expect(problems[0]).toContain('test-fixture')
    })
})

describe('lambdaFunction', () => {
    const resources: Resources = {
        ServerFn: {
            Type: 'AWS::Lambda::Function',
            Properties: { Environment: { Variables: { A: '1' } }, VpcConfig: {} },
        },
        MigratorProviderFn: { Type: 'AWS::Lambda::Function' },
        MigratorFn: { Type: 'AWS::Lambda::Function' },
    }

    it('reads the id, VPC membership and environment', () => {
        expect(lambdaFunction(resources, 'Server')).toEqual({ id: 'ServerFn', inVpc: true, env: { A: '1' } })
    })

    it('skips provider functions and defaults an empty environment', () => {
        expect(lambdaFunction(resources, 'Migrator')).toEqual({ id: 'MigratorFn', inVpc: false, env: {} })
    })

    it('throws when the function is missing', () => {
        expect(() => lambdaFunction(resources, 'Nope')).toThrow(/no Nope function/)
    })
})

describe('lambdaBundles', () => {
    it('reads index.mjs and index.js from each staged asset, and skips the rest', () => {
        const dir = makeTestTmpDir('assembly-checks-')
        const stage = (name: string, file?: string) => {
            mkdirSync(path.join(dir, `asset.${name}`))
            if (file) writeFileSync(path.join(dir, `asset.${name}`, file), `code of ${name}`)
        }
        stage('aaa', 'index.mjs')
        stage('bbb', 'index.js')
        stage('ccc')
        const fn = (key?: string): Resources[string] => ({
            Type: 'AWS::Lambda::Function',
            Properties: key ? { Code: { S3Key: `${key}.zip` } } : {},
        })
        const resources: Resources = {
            A: fn('aaa'),
            B: fn('bbb'),
            C: fn('ccc'),
            D: fn('missing'),
            E: fn(),
            F: { Type: 'AWS::S3::Bucket' },
        }
        expect(Object.fromEntries(lambdaBundles(resources, dir))).toEqual({ A: 'code of aaa', B: 'code of bbb' })
    })
})
