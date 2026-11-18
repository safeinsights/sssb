import { describe, expect, it } from 'vitest'
import registry from './checks.json'
import { contractDatabaseName, contractSuite } from './contract'

/**
 * The contract runner's refusals and names, without a server: what it does on real Postgres is `pnpm test:contract`'s
 * to prove, in every app's `tests/contract`. Every case here throws while the file is collected, before it would
 * register anything, which is why it can be called from inside a test.
 */
describe('contractSuite refuses, while the file is collected', () => {
    it('an opt-out naming a check it does not register', () => {
        expect(() => contractSuite({ optOut: { 'contract-rsl': 'typo' } })).toThrow(
            /contractSuite: optOut names "contract-rsl", which is not a check this suite registers/,
        )
        // A unit check is not the contract runner's to leave out.
        expect(() => contractSuite({ optOut: { 'rls-pglite': 'not here' } })).toThrow(/optOut names "rls-pglite"/)
    })

    it('an opt-out without a reason', () => {
        expect(() => contractSuite({ optOut: { 'contract-data-api': ' ' } })).toThrow(
            /optOut "contract-data-api" needs a reason/,
        )
    })

    it('a database name that is not an unquoted identifier', () => {
        expect(() => contractSuite({ database: 'Robert"; DROP' })).toThrow(/not an unquoted Postgres identifier/)
    })
})

describe('the contract checks', () => {
    it('are the contract runner of checks.json, in the order the runner depends on', () => {
        expect(registry.checks.filter((check) => check.runner === 'contract').map((check) => check.id)).toEqual([
            'contract-owner-pass',
            'contract-rls',
            'contract-data-api',
        ])
    })
})

describe('contractDatabaseName', () => {
    it.each([
        ['starter', 'starter_contract'],
        ['acme-corp', 'acme_corp_contract'],
        ['Acme.Corp 2', 'acme_corp_2_contract'],
        ['2fast', 'app_2fast_contract'],
    ])('folds %s to %s', (slug, database) => {
        expect(contractDatabaseName(slug)).toBe(database)
    })

    it('stays within the 63 characters of an identifier', () => {
        expect(contractDatabaseName('a'.repeat(200)).length).toBeLessThanOrEqual(63)
    })
})
