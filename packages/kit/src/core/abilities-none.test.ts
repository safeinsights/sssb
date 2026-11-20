import { describe, expect, test } from 'vitest'
import { type AbilityActor, defineAbilitiesFor } from './abilities'
import type { Role } from './roles'

/**
 * The `none` role: a signed-in person with no standing in the org they are placed in. Single-tenant auth gives it to
 * every user of the deployment's identity provider, which on a shared instance means another product's users too,
 * so it must grant nothing a role or a membership would: no org-scoped read or write, framework or app (the fixture's
 * `Docket`, whose rules lean on `sameOrg`), and never the staff org's manage-all.
 */

const ORG_A = 'org-a'
const ORG_B = 'org-b'
const ACTIONS = ['create', 'read', 'update', 'delete', 'manage'] as const

function actor(overrides: { role: Role; [field: string]: unknown }): AbilityActor {
    return {
        credential: { kind: 'session', id: null },
        userId: 'user-1',
        restricted: false,
        activeOrgId: ORG_A,
        manageAll: false,
        ...overrides,
    } as AbilityActor
}

const ORG_SCOPED = [
    { type: 'Job', orgId: ORG_A },
    { type: 'Membership', orgId: ORG_A },
    { type: 'Org', orgId: ORG_A },
    { type: 'WebhookEndpoint', orgId: ORG_A },
    { type: 'Docket', orgId: ORG_A },
] as const

describe('the none role grants nothing a membership would', () => {
    test('no action on any org-scoped subject in the org it is placed in, framework or app', () => {
        for (const restricted of [true, false]) {
            const ability = defineAbilitiesFor(actor({ role: 'none', restricted }))
            for (const subject of ORG_SCOPED) {
                for (const action of ACTIONS) {
                    expect(ability.can(action, subject), `${action} ${subject.type} (restricted ${restricted})`).toBe(
                        false,
                    )
                }
            }
        }
    })

    test('a manage-all it is handed is not wielded', () => {
        const ability = defineAbilitiesFor(actor({ role: 'none', manageAll: true }))
        expect(ability.can('manage', { type: 'Org', orgId: ORG_B })).toBe(false)
        expect(ability.can('read', { type: 'Job', orgId: ORG_A })).toBe(false)
    })

    test('what is its own stays its own: its profile and its notifications', () => {
        const ability = defineAbilitiesFor(actor({ role: 'none' }))
        expect(ability.can('update', { type: 'User', ownerId: 'user-1' })).toBe(true)
        expect(ability.can('read', { type: 'Notification', ownerId: 'user-1' })).toBe(true)
        expect(ability.can('update', { type: 'User', ownerId: 'user-2' })).toBe(false)
    })

    test('the lowest existing role, for contrast, does read in its org: which is why none is a role of its own', () => {
        const ability = defineAbilitiesFor(actor({ role: 'restricted', restricted: true }))
        expect(ability.can('read', { type: 'Job', orgId: ORG_A })).toBe(true)
    })
})
