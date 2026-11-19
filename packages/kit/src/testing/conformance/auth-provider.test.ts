import { chmodSync, mkdirSync, writeFileSync } from 'node:fs'
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

    it("follows the app's own imports: a wrapper module, a re-exporting layout, a shared glue module", () => {
        const appDir = app({
            'layout.tsx': PLAIN_LAYOUT,
            '[locale]/layout.tsx': `export { default } from '@/components/locale-layout'\n`,
            '[locale]/signin/page.tsx': `import Glue from '../../_shared/sign-in-glue'\nexport default Glue\n`,
            '_shared/sign-in-glue.tsx': SIGN_IN_PAGE,
        })
        const components = path.join(appDir, 'src/components')
        mkdirSync(components, { recursive: true })
        writeFileSync(
            path.join(components, 'locale-layout.tsx'),
            `import { AuthProviders } from '@/adapters/real/auth-providers'\nexport default AuthProviders\n`,
        )
        mkdirSync(path.join(appDir, 'src/adapters/real'), { recursive: true })
        writeFileSync(path.join(appDir, 'src/adapters/real/auth-providers.tsx'), PROVIDER_LAYOUT)
        expect(realAuthProviderGaps(appDir)).toMatchObject({
            withForms: ['src/app/[locale]/signin/page.tsx'],
            gaps: [],
        })
    })

    it('does not count a type-only import, either way', () => {
        const appDir = app({
            'layout.tsx': `import type { RealAuthProviders } from '@sssb/kit/adapters/real/providers'\n${PLAIN_LAYOUT}`,
            'signin/page.tsx': SIGN_IN_PAGE,
            'about/page.tsx': `import type { RealSignInForm } from '@sssb/kit/adapters/real/sign-in-form'\nexport default () => null\n`,
        })
        expect(realAuthProviderGaps(appDir)).toMatchObject({
            withForms: ['src/app/signin/page.tsx'],
            gaps: ['src/app/signin/page.tsx'],
        })
    })

    // Root reads a file whatever its mode, so the case cannot be built there.
    it.skipIf(process.getuid?.() === 0)('reports a file it cannot read by its path, rather than throwing', () => {
        const appDir = app({
            'layout.tsx': PLAIN_LAYOUT,
            'page.tsx': `import Locked from './locked'\nexport default Locked\n`,
            'locked.tsx': 'export default () => null\n',
        })
        const locked = path.join(appDir, 'src/app/locked.tsx')
        chmodSync(locked, 0o000)
        try {
            expect(realAuthProviderGaps(appDir).unreadable).toEqual([
                expect.stringMatching(/^src\/app\/locked\.tsx: .*EACCES/),
            ])
            expect(() => walked({ appDir })).toThrow(/could not be read/)
        } finally {
            chmodSync(locked, 0o644)
        }
    })

    it('passes an app that loads no real auth form, and fails one with no src/app to walk', () => {
        expect(() => check({ appDir: app({ 'layout.tsx': PLAIN_LAYOUT, 'page.tsx': PLAIN_LAYOUT }) })).not.toThrow()
        expect(() => walked({ appDir: makeTestTmpDir('auth-provider-empty-') })).toThrow(/no page or layout found/)
    })
})
