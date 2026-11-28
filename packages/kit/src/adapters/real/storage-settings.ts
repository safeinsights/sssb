/**
 * The values of `STORAGE_PROVIDER=s3-compatible` that choose behaviour, checked in one place that loads no SDK: the
 * adapter (./storage.ts) checks them as it is built, and `assertRealEnv` (./index.ts) checks them too, so
 * `sssb check-real-env` refuses what the server would refuse at boot. Each failure names its variable and, so that a
 * secret pasted into the wrong one never reaches a log, never repeats a value that could hold one (the endpoint).
 */

/**
 * `STORAGE_UPLOAD_TARGET`: `post` if the store accepts a presigned POST, `put` if it takes a presigned PUT instead
 * (Cloudflare R2), `none` if the app takes no browser uploads.
 */
export function parseUploadTarget(value: string): 'post' | 'put' | 'none' {
    if (value === 'post' || value === 'put' || value === 'none') return value
    throw new Error(`STORAGE_UPLOAD_TARGET must be post, put or none (got "${value}")`)
}

/** `STORAGE_FORCE_PATH_STYLE`: `true`, `false`, or unset (an empty value counts as unset) for the SDK's own addressing. */
export function parseForcePathStyle(value: string | undefined): boolean | undefined {
    if (value === undefined || value === '') return undefined
    if (value === 'true') return true
    if (value === 'false') return false
    throw new Error(`STORAGE_FORCE_PATH_STYLE must be true or false when set (got "${value}")`)
}

/** `STORAGE_ENDPOINT`: an http(s) URL carrying no credentials (the key pair has settings of its own). */
export function assertEndpoint(endpoint: string): void {
    let url: URL
    try {
        url = new URL(endpoint)
    } catch {
        throw new Error('STORAGE_ENDPOINT must be an http(s) URL')
    }
    if (url.protocol !== 'https:' && url.protocol !== 'http:')
        throw new Error('STORAGE_ENDPOINT must be an http(s) URL')
    if (url.username !== '' || url.password !== '') {
        throw new Error(
            'STORAGE_ENDPOINT must not carry a user or password: the key pair is STORAGE_ACCESS_KEY_ID and STORAGE_SECRET_ACCESS_KEY',
        )
    }
}
