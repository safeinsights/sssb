import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { makeTestTmpDir } from '../tmp-dir'
import { realAuthProvider, realAuthProviderGaps } from './auth-provider'

/** The `real-auth-provider` check on scratch apps: each case writes a small `src/app` tree. */

const SIGN_IN_PAGE = `
export default async function Page() {
    const { RealSignInForm } = await import('@sssb/kit/adapters/real/sign-in-form')
    return <RealSignInForm />
}
`
const PROVIDER_LAYOUT = `
async function AuthProviders({ children }) {
    const { RealAuthProviders } = await import('@sssb/kit/adapters/real/providers')
    return <RealAuthProviders>{children}</RealAuthProviders>
}
export default function Layout({ children }) { return <AuthProviders>{children}</AuthProviders> }
`
const PLAIN_LAYOUT = `export default function Layout({ children }) { return children }\n`

function app(files: Record<string, string>): string {
    const appDir = makeTestTmpDir('auth-provider-')
    for (const [rel, body] of Object.entries(files)) {
        const file = path.join(appDir, 'src/app', rel)
        mkdirSync(path.dirname(file), { recursive: true })
        writeFileSync(file, body)
    }
    return appDir
}

const check =
    realAuthProvider.tests[
        'every route module that loads a real auth form sits under a layout that loads RealAuthProviders'
    ]!
const walked = realAuthProvider.tests["the app's src/app is really walked"]!

describe('real-auth-provider', () => {
    it('passes a sign-in page under a layout that loads the provider', () => {
        const appDir = app({
            'layout.tsx': PLAIN_LAYOUT,
            '[locale]/layout.tsx': PROVIDER_LAYOUT,
            '[locale]/signin/page.tsx': SIGN_IN_PAGE,
        })
        expect(realAuthProviderGaps(appDir).withForms).toEqual(['src/app/[locale]/signin/page.tsx'])
        expect(() => check({ appDir })).not.toThrow()
        expect(() => walked({ appDir })).not.toThrow()
    })

    it('fails a sign-in page with no provider above it, naming the page', () => {
        const appDir = app({ 'layout.tsx': PLAIN_LAYOUT, '[locale]/signin/page.tsx': SIGN_IN_PAGE })
        expect(() => check({ appDir })).toThrow(/src\/app\/\[locale\]\/signin\/page\.tsx/)
    })

    it('does not count a comment or a string naming the provider', () => {
        const appDir = app({
            'layout.tsx': `// import('@sssb/kit/adapters/real/providers')\nconst s = '@sssb/kit/adapters/real/providers'\n${PLAIN_LAYOUT}`,
            'signin/page.tsx': SIGN_IN_PAGE,
        })
        expect(realAuthProviderGaps(appDir).gaps).toEqual(['src/app/signin/page.tsx'])
    })

    it("does not count a sibling directory's layout, only the page's own and those above it", () => {
        const appDir = app({
            'layout.tsx': PLAIN_LAYOUT,
            'other/layout.tsx': PROVIDER_LAYOUT,
            'signin/page.tsx': SIGN_IN_PAGE,
        })
        expect(realAuthProviderGaps(appDir).gaps).toEqual(['src/app/signin/page.tsx'])
    })

    it('sees the invite form and a static import too', () => {
        const appDir = app({
            'layout.tsx': PLAIN_LAYOUT,
            'invite/page.tsx': `import { RealAcceptInviteForm } from '@sssb/kit/adapters/real/accept-invite-form'\nexport default RealAcceptInviteForm\n`,
        })
        expect(realAuthProviderGaps(appDir).gaps).toEqual(['src/app/invite/page.tsx'])
    })

    it('passes an app that loads no real auth form, and fails one with no src/app to walk', () => {
        expect(() => check({ appDir: app({ 'layout.tsx': PLAIN_LAYOUT, 'page.tsx': PLAIN_LAYOUT }) })).not.toThrow()
        expect(() => walked({ appDir: makeTestTmpDir('auth-provider-empty-') })).toThrow(/no source module/)
    })
})
