// @vitest-environment node
import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'
import { SENTRY_V10_BASELINE } from './baseline'

/**
 * Runs the baseline's integration filter over the INSTALLED SDK's real default integrations, so a Sentry bump
 * that adds a default (dropped by the allowlist, and so listed here) or renames one v10 had (dropped too, losing
 * coverage) fails until someone decides. The runtime packages are `@sentry/nextjs`'s own dependencies, resolved
 * from where it is installed.
 */
interface Integration {
    name: string
}
interface RuntimeSdk {
    getDefaultIntegrations(options: Record<string, unknown>): Integration[]
}

const fromNextjs = createRequire(createRequire(import.meta.url).resolve('@sentry/nextjs'))
const sdk = (name: string) => fromNextjs(name) as RuntimeSdk

function dropped(defaults: Integration[]): string[] {
    const kept = new Set(SENTRY_V10_BASELINE.integrations(defaults))
    return defaults
        .filter((integration) => !kept.has(integration))
        .map((integration) => integration.name)
        .sort()
}

describe('the baseline keeps only the default integrations Sentry 10 installed', () => {
    it('drops exactly the defaults 11.x added on Node, which no dataCollection key gates', () => {
        const node = sdk('@sentry/node').getDefaultIntegrations({ tracesSampleRate: 0.1 })
        expect(dropped(node)).toStrictEqual([
            ...['Aws', 'AwsLambdaWeb', 'Dataloader', 'Groq', 'Knex', 'Mastra', 'McpServer', 'Mistral', 'Neon'],
            ...['Nitro', 'PiDurable', 'TogetherAI', 'TypeSafe'],
        ])
    })

    it('drops nothing on the edge runtime', () => {
        expect(dropped(sdk('@sentry/vercel-edge').getDefaultIntegrations({ tracesSampleRate: 0.1 }))).toStrictEqual([])
    })

    it('drops nothing in the browser', () => {
        expect(dropped(sdk('@sentry/react').getDefaultIntegrations({}))).toStrictEqual([])
    })

    it("drops the Next.js server's 'use cache' integration and keeps its frame rewriting", () => {
        expect(dropped([{ name: 'NextjsUseCache' }, { name: 'DistDirRewriteFrames' }])).toStrictEqual([
            'NextjsUseCache',
        ])
    })
})
